import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSite } from "../src/cli/audit.js";
import { build, type BuildOptions } from "../src/cli/build.js";
import { PrivacyError, scanOutput } from "../src/cli/privacy.js";
import { FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fixture(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  return repo;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-city-privacy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Git lists paths in sorted order, so the file ids are:
 * 0 docs/guide.md, 1 src/billing/acme_invoice.ts, 2 src/billing/ledger.ts.
 */
function sampleRepo(): FixtureRepo {
  return fixture().write("src/billing/acme_invoice.ts").write("src/billing/ledger.ts").write("docs/guide.md").commit("first");
}

function writeConfig(repo: FixtureRepo, text: string): void {
  writeFileSync(join(repo.dir, "git-city.config.jsonc"), text);
}

async function run(repo: FixtureRepo, overrides: Partial<BuildOptions> = {}) {
  const root = scratch();
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = overrides.outDir ?? join(root, "git-city-site");
  const summary = await build({ repoDir: repo.dir, pageDir, ...overrides, outDir });
  return { summary, outDir };
}

function stringsOf(outDir: string): string[] {
  return JSON.parse(readFileSync(join(outDir, "strings.json"), "utf8")) as string[];
}

describe("names in the output", () => {
  it("hides every path by default and shows Labels instead", async () => {
    const { outDir } = await run(sampleRepo());

    expect(stringsOf(outDir)).toEqual(["Markdown file 1", "TypeScript file 2", "TypeScript file 3"]);
    const everything = ["strings.json", "world.bin"].map((f) => readFileSync(join(outDir, f), "latin1")).join("\n").toLowerCase();
    for (const name of ["billing", "ledger", "guide", "acme"]) expect(everything).not.toContain(name);
  });

  it("merges the shared config and the personal one, with personal rules last", async () => {
    const repo = sampleRepo();
    writeConfig(repo, `{ "rules": [{ "path": "src/**", "action": "reveal" }] }`);
    mkdirSync(join(repo.dir, ".git", "git-city"), { recursive: true });
    writeFileSync(
      join(repo.dir, ".git", "git-city", "config.jsonc"),
      `{ "rules": [{ "path": "src/billing/ledger.ts", "action": "pseudonym", "as": "Books" }] }`,
    );

    const { outDir, summary } = await run(repo);

    expect(stringsOf(outDir)).toEqual(["Markdown file 1", "src/billing/acme_invoice.ts", "Books"]);
    expect(summary.configSources).toEqual([join(repo.dir, "git-city.config.jsonc"), join(repo.dir, ".git", "git-city", "config.jsonc")]);
  });

  it("with --config, reads only that file and ignores the shared and personal configs", async () => {
    const repo = sampleRepo();
    writeConfig(repo, `{ "rules": [{ "path": "docs/**", "action": "reveal" }] }`);
    const only = join(scratch(), "only.jsonc");
    writeFileSync(only, `{ "rules": [{ "path": "src/**", "action": "reveal" }] }`);

    const { outDir, summary } = await run(repo, { configPath: only });

    expect(stringsOf(outDir)).toEqual(["Markdown file 1", "src/billing/acme_invoice.ts", "src/billing/ledger.ts"]);
    expect(summary.configSources).toEqual([only]);
  });

  it("with --private, ignores every reveal", async () => {
    const repo = sampleRepo();
    writeConfig(repo, `{ "rules": [{ "path": "**", "action": "reveal" }] }`);

    const { outDir, summary } = await run(repo, { private: true });

    expect(stringsOf(outDir)).toEqual(["Markdown file 1", "TypeScript file 2", "TypeScript file 3"]);
    expect(summary.revealed).toEqual([]);
  });

  it("reports what was revealed in the build summary", async () => {
    const repo = sampleRepo();
    writeConfig(repo, `{ "rules": [{ "path": "docs/**", "action": "reveal" }] }`);

    const { summary } = await run(repo);

    expect(summary.revealed).toEqual([{ id: 0, text: "docs/guide.md" }]);
  });

  it("replaces a Concept with its Pseudonym inside a revealed name, keeping case", async () => {
    const repo = sampleRepo();
    writeConfig(
      repo,
      `{ "rules": [
        { "path": "src/**", "action": "reveal" },
        { "concept": "Acme", "action": "pseudonym", "as": "Vendor" }
      ] }`,
    );

    const { outDir } = await run(repo);

    expect(stringsOf(outDir)).toEqual(["Markdown file 1", "src/billing/vendor_invoice.ts", "src/billing/ledger.ts"]);
  });

  it("lets audit list every string in the output", async () => {
    const { outDir } = await run(sampleRepo());

    const lines = await auditSite(outDir);
    expect(lines.slice(0, 3)).toEqual(["0\tMarkdown file 1", "1\tTypeScript file 2", "2\tTypeScript file 3"]);
    // Then the City and District names from places.json, one line each.
    expect(lines.slice(3).every((line) => /^(city|district \d+|neighbourhood \d+\.\d+)\t/.test(line))).toBe(true);
    expect(lines[3]!.startsWith("city\t")).toBe(true);
  });
});

describe("the final scan", () => {
  it("fails with a privacy error that names the file and not the needle", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "strings.json"), `["secretproject"]`);

    const error = await scanOutput(dir, ["SecretProject"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PrivacyError);
    expect((error as Error).message).toContain("strings.json");
    expect((error as Error).message.toLowerCase()).not.toContain("secretproject");
  });

  it("does not fail on a hidden name that is only part of a longer word", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "index.html"), "<title>GitCity</title>");
    writeFileSync(join(dir, "strings.json"), `["Gitterwick lane"]`);

    await expect(scanOutput(dir, ["git"])).resolves.toBeUndefined();
  });

  it("still fails on a hidden name that appears as a whole word", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "notes.txt"), "Git City");

    await expect(scanOutput(dir, ["git"])).rejects.toBeInstanceOf(PrivacyError);
  });

  it("builds when a repo file is named like a common word, such as git", async () => {
    const repo = fixture().write("src/git.ts").commit("first");

    const { outDir } = await run(repo);

    expect(existsSync(join(outDir, "world.bin"))).toBe(true);
  });

  it("does not scan the page shell, a fixed template whose words are HTML and our own names", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "index.html"), `<!doctype html><div id="labels"></div>`);

    await expect(scanOutput(dir, ["labels"])).resolves.toBeUndefined();
  });

  it("does not scan the page bundle, which holds our code and no user data", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "page.js"), "secretproject");

    await expect(scanOutput(dir, ["secretproject"])).resolves.toBeUndefined();
  });

  it("stops the build and leaves no site behind when a hidden Concept reaches the output", async () => {
    const repo = sampleRepo();
    writeConfig(repo, `{ "rules": [{ "concept": "Acme", "action": "allow" }] }`);
    const root = scratch();
    const pageDir = join(root, "page");
    mkdirSync(pageDir);
    // Stands in for a leak: a page file that is not the fixed shell carries the hidden Concept.
    writeFileSync(join(pageDir, "notes.txt"), "Acme");
    const outDir = join(root, "git-city-site");

    await expect(build({ repoDir: repo.dir, outDir, pageDir })).rejects.toThrow(PrivacyError);
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(`${outDir}.staging`)).toBe(false);
  });
});

describe("near-misses", () => {
  // Sorted ids: 0 secret/platform.ts (hidden), 1 src/initec/a.ts (revealed).
  function nearMissRepo(config: string): FixtureRepo {
    const repo = fixture().write("src/initec/a.ts").write("secret/platform.ts").commit("first");
    writeConfig(repo, config);
    return repo;
  }
  const pseudonymised = `{ "rules": [
    { "path": "src/**", "action": "reveal" },
    { "concept": "Initech", "action": "pseudonym", "as": "Co" }
  ] }`;

  it("reports the near-miss in the summary without failing by default", async () => {
    const { summary } = await run(nearMissRepo(pseudonymised));

    expect(summary.nearMisses).toEqual([{ id: 1, text: "src/initec/a.ts", term: "Initech" }]);
  });

  it("fails the build with --strict, leaving no site behind", async () => {
    const repo = nearMissRepo(pseudonymised);
    const outDir = join(scratch(), "git-city-site");

    await expect(run(repo, { strict: true, outDir })).rejects.toThrow(PrivacyError);
    expect(existsSync(outDir)).toBe(false);
  });

  it("does not report a near-miss that an allow rule accepts", async () => {
    const { summary } = await run(
      nearMissRepo(`{ "rules": [
        { "path": "src/**", "action": "reveal" },
        { "concept": "Initech", "action": "allow" },
        { "concept": "Initech", "action": "pseudonym", "as": "Co" }
      ] }`),
      { strict: true },
    );

    expect(summary.nearMisses).toEqual([]);
  });
});

describe("config errors", () => {
  it("reports a malformed rule as a config error, not a privacy failure", async () => {
    const repo = sampleRepo();
    writeConfig(repo, `{ "rules": [{ "path": "a", "action": "hide" }] }`);

    const error = await run(repo).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(PrivacyError);
    expect((error as Error).message).toMatch(/action must be one of/);
  });
});
