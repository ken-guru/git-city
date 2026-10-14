import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { FixtureRepo } from "./fixture.js";

// The shipped CLI: test/global-setup.ts builds it before any test file runs.
const CLI = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url));
const MAN_PAGE = fileURLToPath(new URL("../man/git-city.1", import.meta.url));

let repo: FixtureRepo;
const cleanups: (() => void)[] = [];

beforeAll(() => {
  repo = new FixtureRepo().write("src/index.ts").write("README.md").commit("first");
}, 120_000);

afterAll(() => {
  repo.remove();
  cleanups.splice(0).forEach((f) => f());
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CI: "1" } });
}

describe("git-city init", () => {
  it("writes the personal config under the git directory, then refuses to overwrite it", () => {
    const fixture = new FixtureRepo().write("src/a.ts", 'import x from "left-pad";\n').commit("first");
    cleanups.push(() => fixture.remove());

    const first = run("init", "-C", fixture.dir);
    expect(first.status).toBe(0);
    const personal = join(fixture.dir, ".git", "git-city", "config.jsonc");
    expect(first.stdout).toContain(personal);
    expect(readFileSync(personal, "utf8")).toContain("left-pad");

    const again = run("init", "-C", fixture.dir);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("writes the shared config at the root with --shared", () => {
    const fixture = new FixtureRepo().write("a.txt").commit("first");
    cleanups.push(() => fixture.remove());

    expect(run("init", "--shared", "-C", fixture.dir).status).toBe(0);
    expect(existsSync(join(fixture.dir, "git-city.config.jsonc"))).toBe(true);
  });

  it("exits 1 outside a git repository", () => {
    const empty = mkdtempSync(join(tmpdir(), "git-city-init-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const result = run("init", "--shared", "-C", empty);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a git repository");
  });
});

describe("git-city build output modes", () => {
  it("prints one line in CI and nothing with --quiet", () => {
    const out = join(repo.dir, "site-line");
    const line = run("build", "-C", repo.dir, "--out", out);
    expect(line.status).toBe(0);
    expect(line.stderr).toBe("");
    expect(line.stdout.trim().split("\n")).toHaveLength(1);
    expect(line.stdout).toContain("Built 1 commits");

    const quiet = run("build", "-C", repo.dir, "--out", out, "--quiet");
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");
  });

  it("prints the build result as JSON with --json", () => {
    const out = join(repo.dir, "site-json");
    const result = run("build", "-C", repo.dir, "--out", out, "--json");
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { commits: number; branch: string; sizes: { totalBytes: number } };
    expect(json).toMatchObject({ commits: 1, branch: "main" });
    expect(json.sizes.totalBytes).toBeGreaterThan(0);
  });

  it("rejects a non-numeric --port with exit 1", () => {
    const result = run("serve", "-C", repo.dir, "--port", "nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid port");
  });
});

describe("the gitignore hint", () => {
  it("reports whether the output folder is ignored, and stops once it is", async () => {
    const fixture = new FixtureRepo().write("a.txt").commit("first");
    cleanups.push(() => fixture.remove());
    const pageDir = join(fixture.dir, "page");
    mkdirSync(pageDir);
    writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub");
    const outDir = join(fixture.dir, "git-city-site");

    const before = await build({ repoDir: fixture.dir, outDir, pageDir });
    expect(before.outputIgnored).toBe(false);
    expect(before.outputIgnoreEntry).toBe("git-city-site/");

    writeFileSync(join(fixture.dir, ".gitignore"), "git-city-site/\n");
    const after = await build({ repoDir: fixture.dir, outDir, pageDir });
    expect(after.outputIgnored).toBe(true);
  });
});

describe("help and the man page", () => {
  it("documents init, the output modes and --open in -h", () => {
    const help = run("-h");
    expect(help.status).toBe(0);
    for (const word of ["init", "--json", "--quiet", "--shared", "--open", "git-city(1)"]) {
      expect(help.stdout).toContain(word);
    }
  });

  it("ships a man page in the package", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as { files: string[] };
    expect(pkg.files).toContain("man");
    expect(readFileSync(MAN_PAGE, "utf8")).toMatch(/^\.TH GIT-CITY 1/m);
  });
});
