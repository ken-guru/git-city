import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeWorld } from "../src/shared/format.js";
import { FixtureRepo } from "./fixture.js";

const CLI = new URL("../dist/cli/main.js", import.meta.url).pathname;
let repo: FixtureRepo;
const cleanupRepos: FixtureRepo[] = [];

beforeAll(() => {
  // Exercise the CLI as shipped: compiled, with the pre-built page next to it.
  execSync("npm run build --silent", { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
  repo = new FixtureRepo().write("README.md").write("src/index.ts").commit("first");
  repo.git("rm", "-q", "README.md");
  repo.commit("second");
}, 120_000);

afterAll(() => {
  repo.remove();
  cleanupRepos.splice(0).forEach((r) => r.remove());
});

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
    expect(JSON.parse(readFileSync(join(site, "strings.json"), "utf8"))).toEqual(["Markdown file 1", "TypeScript file 2"]);
  });

  it("audit lists every string, and a --strict near-miss exits with the privacy code 2", () => {
    const site = join(repo.dir, "git-city-site");
    const audited = run("audit", site);
    expect(audited.status).toBe(0);
    expect(audited.stdout).toBe("0\tMarkdown file 1\n1\tTypeScript file 2\n");

    const near = new FixtureRepo().write("src/initec/a.ts").write("secret/platform.ts").commit("first");
    cleanupRepos.push(near);
    writeFileSync(
      join(near.dir, "git-city.config.jsonc"),
      `{ "rules": [{ "path": "src/**", "action": "reveal" }, { "concept": "Initech", "action": "pseudonym", "as": "Co" }] }`,
    );
    const failed = spawnSync(process.execPath, [CLI, "build", "-C", near.dir, "--strict"], { encoding: "utf8" });
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain("--strict fails the build");
    expect(failed.stderr).not.toContain("Initech");
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

  it("says in one line when the port it was given is taken", async () => {
    const blocker = createNetServer();
    await new Promise<void>((done) => blocker.listen(0, "127.0.0.1", done));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, "serve", "-C", repo.dir, "--port", String(port)]);
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
        child.on("exit", (status) => resolve({ status, stderr }));
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`git-city: port ${port} is in use; free it or choose another with --port\n`);
    } finally {
      await new Promise((done) => blocker.close(done));
    }
  });

  it("explains unknown commands", () => {
    const result = run("demolish");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command: demolish");
  });
});

afterAll(() => rmSync(join(repo.dir, "git-city-site"), { recursive: true, force: true }));
