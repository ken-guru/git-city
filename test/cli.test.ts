import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeWorld } from "../src/shared/format.js";
import { FixtureRepo } from "./fixture.js";

const CLI = new URL("../dist/cli/main.js", import.meta.url).pathname;
let repo: FixtureRepo;

beforeAll(() => {
  // Exercise the CLI as shipped: compiled, with the pre-built page next to it.
  execSync("npm run build --silent", { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
  repo = new FixtureRepo().write("README.md").write("src/index.ts").commit("first");
  repo.git("rm", "-q", "README.md");
  repo.commit("second");
}, 120_000);

afterAll(() => repo.remove());

function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

describe("the git-city binary", () => {
  it("builds a site holding the page, the world file, one chunk and strings.json", () => {
    const result = run("build", "-C", repo.dir);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Built 2 commits and 2 files from main");
    const site = join(repo.dir, "git-city-site");
    expect(readFileSync(join(site, "index.html"), "utf8")).toMatch(/<script type="module" src="assets\/page\.\w+\.js">/);
    expect(readdirSync(join(site, "assets"))).toEqual([expect.stringMatching(/^page\.\w+\.js$/)]);
    expect(readdirSync(join(site, "chunks"))).toEqual([expect.stringMatching(/^0000\.[0-9a-f]{16}\.bin$/)]);
    expect(decodeWorld(readFileSync(join(site, "world.bin"))).commitDays).toHaveLength(2);
    expect(readFileSync(join(site, "strings.json"), "utf8").trim()).toBe("[]");
  });

  it("serves the built site on localhost", async () => {
    if (!existsSync(join(repo.dir, "git-city-site"))) run("build", "-C", repo.dir);
    const child = spawn(process.execPath, [CLI, "serve", "-C", repo.dir, "--port", "0"]);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        child.stdout.setEncoding("utf8").on("data", (line: string) => {
          const match = /Serving at (\S+)/.exec(line);
          if (match) resolve(match[1]!);
        });
        child.on("exit", (code) => reject(new Error(`serve exited with ${code}`)));
      });
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const script = /src="([^"]+)"/.exec(await page.text())![1]!;
      const bundle = await fetch(new URL(script, url));
      expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    } finally {
      child.kill();
    }
  });

  it("fails with exit code 1 and a message outside a git repository", () => {
    const empty = mkdtempSync(join(tmpdir(), "git-city-empty-"));
    const result = run("build", "-C", empty);
    rmSync(empty, { recursive: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`git-city: not a git repository: ${empty}\n`);
  });

  it("explains unknown commands", () => {
    const result = run("demolish");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command: demolish");
  });
});

afterAll(() => rmSync(join(repo.dir, "git-city-site"), { recursive: true, force: true }));
