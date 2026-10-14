import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { decodeWorld, NO_CONTENT, type World } from "../src/shared/format.js";
import { FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

const DAY = 86_400;
const START = 1704067200;

interface Commit {
  author: string;
  email: string;
  message: string;
  file: string;
}

/** Writes commits with git fast-import, each one day after the last, on main. */
function fastImport(repo: FixtureRepo, commits: Commit[], extra: { path: string; content: string }[] = []): void {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const stream: string[] = [];
  commits.forEach((commit, i) => {
    const when = START + i * DAY;
    stream.push(
      "commit refs/heads/main",
      `mark :${i + 1}`,
      `author ${commit.author} <${commit.email}> ${when} +0000`,
      `committer ${commit.author} <${commit.email}> ${when} +0000`,
      `data ${bytes(commit.message)}`,
      commit.message,
    );
    if (i > 0) stream.push(`from :${i}`);
    if (i === 0) for (const file of extra) stream.push(`M 100644 inline ${file.path}`, `data ${bytes(file.content)}`, file.content);
    const content = `${i}\n`;
    stream.push(`M 100644 inline ${commit.file}`, `data ${bytes(content)}`, content);
  });
  execFileSync("git", ["-C", repo.dir, "fast-import", "--quiet"], { input: `${stream.join("\n")}\n` });
}

function history(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  // The mailmap is written to the work tree too, which git reads for `--use-mailmap`.
  const mailmap = "Alice Canonical <alice@example.com> <alice.old@example.com>\n";
  repo.write(".mailmap", mailmap);
  fastImport(
    repo,
    [
      { author: "Alice Old", email: "alice.old@example.com", message: "first, see the notes", file: "src/a.ts" },
      { author: "Bob Ito", email: "bob@example.com", message: "second, reach bob@example.com", file: "src/b.ts" },
      { author: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com", message: "bump lib", file: "package.json" },
      { author: "Alice Old", email: "alice.old@example.com", message: "third", file: "src/a.ts" },
    ],
    [{ path: ".mailmap", content: mailmap }],
  );
  return repo;
}

async function buildWith(repo: FixtureRepo, config?: Record<string, unknown>, options: { private?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "git-city-contributors-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const configPath = join(root, "git-city.config.jsonc");
  writeFileSync(configPath, JSON.stringify(config ?? {}));
  const outDir = join(root, "git-city-site");
  const summary = await build({ repoDir: repo.dir, outDir, pageDir, configPath, branch: "main", ...options });
  const world: World = decodeWorld(readFileSync(join(outDir, "world.bin")));
  const strings: string[] = JSON.parse(readFileSync(join(outDir, "strings.json"), "utf8"));
  // Every byte the output holds, as text, for the checks that no email or hidden name is written anywhere.
  const everything = listFiles(outDir)
    .map((path) => readFileSync(path).toString("latin1"))
    .join("\n");
  return { world, strings, everything, revealedContributors: summary.revealedContributors };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

describe("contributors and commit messages in the build", () => {
  it("writes nothing about contributors or messages when both are off", async () => {
    const { world, strings, everything } = await buildWith(history());
    expect(world.contributors).toBeUndefined();
    expect(world.messages).toBeUndefined();
    expect(strings.some((s) => /^Contributor \d+$|^Automation$/.test(s))).toBe(false);
    expect(everything).not.toContain("alice.old@example.com");
    expect(everything).not.toContain("bob@example.com");
  });

  it("names anonymous Contributors and groups bots as Automation, with commit messages as strings", async () => {
    const { world, strings, everything } = await buildWith(history(), { contributors: "anonymous", commitMessages: true });
    expect(world.contributors).toBeDefined();
    const names = Array.from(world.contributors!.name, (id) => strings[id]);
    expect(names).toEqual(["Contributor 1", "Contributor 2", "Automation"]);
    expect([...world.contributors!.automation]).toEqual([0, 0, 1]);
    // Steps: Alice, Bob, the bot, Alice again. Each Step's author index is one of the three Contributors.
    expect([...world.contributors!.ofStep]).toEqual([0, 1, 2, 0]);
    const messages = Array.from(world.messages!, (id) => (id === NO_CONTENT ? undefined : strings[id]));
    // The address is removed whole, so its local part does not survive either.
    expect(messages).toEqual(["first, see the notes", "second, reach", "bump lib", "third"]);
    expect(everything).not.toContain("@example.com");
    expect(everything).not.toContain("alice.old");
  });

  it("uses mailmapped names at the real level, and a Generated name under --private", async () => {
    const real = await buildWith(history(), { contributors: "real" });
    expect(Array.from(real.world.contributors!.name, (id) => real.strings[id])).toContain("Alice Canonical");
    expect(real.strings).not.toContain("Alice Old");
    expect(real.world.messages).toBeUndefined();
    expect(real.revealedContributors).toBe(2);

    // --private ignores the reveal: the Real names are gone, and Generated names stand in.
    const priv = await buildWith(history(), { contributors: "real" }, { private: true });
    expect(priv.strings).not.toContain("Alice Canonical");
    expect(priv.strings).not.toContain("Bob Ito");
    expect(priv.revealedContributors).toBe(0);
    expect(priv.strings).toContain("Automation");
  });

  it("keeps commit messages without contributors, and no Contributor data then", async () => {
    const { world, strings } = await buildWith(history(), { commitMessages: true });
    expect(world.contributors).toBeUndefined();
    expect(world.messages).toBeDefined();
    expect(strings).toContain("third");
    expect(strings.some((s) => s === "Automation")).toBe(false);
  });
});
