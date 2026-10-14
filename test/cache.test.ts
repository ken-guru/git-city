import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { cacheClear, cacheDirFor, cacheStatus, CacheSession, LAYER_STAMPS, LockError } from "../src/cli/cache.js";
import { resolveTimelineHead } from "../src/cli/history.js";
import { readTimeline, type TimelineRead } from "../src/cli/resume.js";
import { FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fixture(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  return repo;
}

/** Every file a build wrote, keyed by its path inside the site folder. */
function filesOf(root: string, dir = root, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) filesOf(root, full, out);
    else out.set(full.slice(root.length + 1), readFileSync(full).toString("base64"));
  }
  return out;
}

/** Builds the site for `repo` into a fresh folder and returns its files. */
async function siteOf(repo: FixtureRepo, options: { fresh?: boolean; wait?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "git-city-site-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = join(root, "site");
  await build({ repoDir: repo.dir, outDir, pageDir, ...options });
  return filesOf(outDir);
}

/** Reads the Timeline through the cache without advancing any checkpoint. */
async function readOnce(repoDir: string, fresh = false): Promise<TimelineRead> {
  const { head, branch } = await resolveTimelineHead(repoDir);
  const cache = await CacheSession.open(repoDir, { fresh });
  try {
    return await readTimeline(repoDir, head, branch, cache);
  } finally {
    await cache.close();
  }
}

/** A history with adds, a modify, a delete and a second file, for comparing outputs. */
function history(): FixtureRepo {
  const repo = fixture().write("a.txt", "one\n").write("src/b.ts", "export const b = 1;\n").commit("first", 0);
  repo.write("a.txt", "one\ntwo\nthree\n").commit("second");
  repo.git("rm", "-q", "src/b.ts");
  return repo.commit("third");
}

describe("incremental build", () => {
  it("a re-run reads only the new commits and matches a fresh run", async () => {
    const repo = history();
    const first = await siteOf(repo);

    repo.write("docs/notes.md", "notes\n").commit("fourth");
    repo.write("a.txt", "rewritten\n").commit("fifth");

    const resumed = await siteOf(repo);
    const fresh = await siteOf(repo, { fresh: true });

    expect(resumed).not.toEqual(first);
    expect(resumed).toEqual(fresh);
  });

  it("reads nothing when the head has not moved", async () => {
    const repo = history();
    await siteOf(repo);

    const again = await readOnce(repo.dir);

    expect(again.read).toBe(0);
    expect(again.replayed).toBe(0);
    expect(again.resumedFrom).toBeDefined();
  });

  it("reads only the commits after the checkpoint", async () => {
    const repo = history();
    await siteOf(repo);
    repo.write("c.txt", "c\n").commit("fourth");
    repo.write("c.txt", "c2\n").commit("fifth");

    const read = await readOnce(repo.dir);

    expect(read.read).toBe(2);
    expect(read.replayed).toBe(2);
  });

  it("--fresh reads the whole history again", async () => {
    const repo = history();
    await siteOf(repo);

    const read = await readOnce(repo.dir, true);

    expect(read.resumedFrom).toBeUndefined();
    expect(read.read).toBe(3);
  });
});

describe("history rewrites", () => {
  it("roll back to the newest checkpoint still on the first-parent chain", async () => {
    const repo = history();
    const third = repo.git("rev-parse", "HEAD").trim();
    await siteOf(repo); // checkpoint at the third commit
    repo.write("x.txt", "x\n").commit("fourth");
    await siteOf(repo); // checkpoint at the fourth commit
    const newest = repo.git("rev-parse", "HEAD").trim();

    // Rewrite: drop the fourth commit and add a different one in its place.
    repo.git("reset", "-q", "--hard", "HEAD~1");
    repo.write("y.txt", "y\n").commit("replacement");

    const read = await readOnce(repo.dir);
    expect(read.resumedFrom).toBe(third);
    expect(read.replayed).toBe(1);
    expect(read.read).toBe(1);
    expect(newest).not.toBe(third);

    const resumed = await siteOf(repo);
    const fresh = await siteOf(repo, { fresh: true });
    expect(resumed).toEqual(fresh);
  });

  it("starts from nothing when no checkpoint survives the rewrite", async () => {
    const repo = history();
    await siteOf(repo);

    repo.git("checkout", "-q", "--orphan", "rewritten");
    repo.git("rm", "-r", "-q", "--cached", ".");
    repo.write("only.txt", "only\n").commit("a brand new root");
    repo.git("branch", "-M", "main");

    const read = await readOnce(repo.dir);
    expect(read.resumedFrom).toBeUndefined();
    expect(read.read).toBe(1);
  });
});

describe("unreadable blobs", () => {
  it("a re-run counts a blob it cannot read as empty, warns, and still matches a fresh run", async () => {
    const repo = history();
    await siteOf(repo);
    repo.write("broken.txt", "this blob will go missing\n").commit("fourth");
    const blob = repo.git("rev-parse", "HEAD:broken.txt").trim();
    // Remove the loose object so git cannot read this file version on the re-run.
    rmSync(join(repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    const root = mkdtempSync(join(tmpdir(), "git-city-site-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pageDir = join(root, "page");
    mkdirSync(pageDir);
    writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
    const resumed = await build({ repoDir: repo.dir, outDir: join(root, "resumed"), pageDir });
    const fresh = await build({ repoDir: repo.dir, outDir: join(root, "fresh"), pageDir, fresh: true });

    expect(resumed.warnings.join("\n")).toContain("could not be read");
    expect(filesOf(join(root, "resumed"))).toEqual(filesOf(join(root, "fresh")));
    expect(fresh.warnings.join("\n")).toContain("could not be read");
  });
});

describe("lock", () => {
  it("refuses to run while another live process holds the lock", async () => {
    const repo = history();
    const lock = join(await cacheDirFor(repo.dir), "lock");
    mkdirSync(join(await cacheDirFor(repo.dir)), { recursive: true });
    writeFileSync(lock, String(process.pid)); // this test process is alive

    await expect(siteOf(repo)).rejects.toBeInstanceOf(LockError);
    rmSync(lock);
  });

  it("reclaims a lock left by a process that is gone", async () => {
    const repo = history();
    const child = spawn(process.execPath, ["-e", ""]);
    const deadPid = await new Promise<number>((done) => child.on("exit", () => done(child.pid!)));
    const lock = join(await cacheDirFor(repo.dir), "lock");
    mkdirSync(join(await cacheDirFor(repo.dir)), { recursive: true });
    writeFileSync(lock, String(deadPid));

    await siteOf(repo);

    expect(readdirSync(join(await cacheDirFor(repo.dir)))).not.toContain("lock");
  });

  it("waits for the holder with --wait", async () => {
    const repo = history();
    const lock = join(await cacheDirFor(repo.dir), "lock");
    mkdirSync(join(await cacheDirFor(repo.dir)), { recursive: true });
    writeFileSync(lock, String(process.pid));
    setTimeout(() => rmSync(lock), 400);

    const files = await siteOf(repo, { wait: true });

    expect(files.size).toBeGreaterThan(0);
  });
});

describe("version stamps", () => {
  it("derives each stamp from the code of its layer, as a layer name and a content hash", () => {
    for (const layer of ["facts", "commits", "run"] as const) {
      expect(LAYER_STAMPS[layer]).toMatch(new RegExp(`^${layer}-[0-9a-f]{12}$`));
    }
    expect(new Set(Object.values(LAYER_STAMPS)).size).toBe(3);
  });

  it("a changed commits stamp clears the commit and run layers and keeps the facts", async () => {
    const repo = history();
    await siteOf(repo);
    const dir = await cacheDirFor(repo.dir);
    const factsBefore = readdirSync(join(dir, "facts")).length;
    writeFileSync(join(dir, "stamps.json"), JSON.stringify({ ...LAYER_STAMPS, commits: "commits-0" }));

    const session = await CacheSession.open(repo.dir);
    const checkpoints = await session.checkpoints((await resolveTimelineHead(repo.dir)).branch);
    const facts = session.facts.size;
    await session.close();

    expect(checkpoints).toEqual([]);
    expect(facts).toBeGreaterThan(0);
    expect(readdirSync(join(dir, "facts")).length).toBe(factsBefore);
  });

  it("a changed facts stamp clears the facts, commit and run layers", async () => {
    const repo = history();
    await siteOf(repo);
    const dir = await cacheDirFor(repo.dir);
    writeFileSync(join(dir, "stamps.json"), JSON.stringify({ ...LAYER_STAMPS, facts: "facts-0" }));

    const session = await CacheSession.open(repo.dir);
    const checkpoints = await session.checkpoints((await resolveTimelineHead(repo.dir)).branch);
    await session.close();

    expect(checkpoints).toEqual([]);
    expect(existsSync(join(dir, "facts"))).toBe(false);
  });

  it("a changed run stamp clears only the run layer", async () => {
    const repo = history();
    await siteOf(repo);
    const dir = await cacheDirFor(repo.dir);
    const factsBefore = readdirSync(join(dir, "facts")).length;
    writeFileSync(join(dir, "stamps.json"), JSON.stringify({ ...LAYER_STAMPS, run: "run-0" }));

    const session = await CacheSession.open(repo.dir);
    const checkpoints = await session.checkpoints((await resolveTimelineHead(repo.dir)).branch);
    const facts = session.facts.size;
    await session.close();

    expect(checkpoints).toEqual([]);
    expect(facts).toBeGreaterThan(0);
    expect(readdirSync(join(dir, "facts")).length).toBe(factsBefore);
  });
});

describe("cache command", () => {
  it("status reports each layer and the checkpoints; clear removes them", async () => {
    const repo = history();
    await siteOf(repo);

    const before = (await cacheStatus(repo.dir)).join("\n");
    expect(before).toMatch(new RegExp(`facts: stamp ${LAYER_STAMPS.facts}`));
    expect(before).toMatch(/checkpoints for main: 1/);

    await cacheClear(repo.dir);

    expect((await cacheStatus(repo.dir)).join("\n")).not.toMatch(/checkpoints for/);
  });
});
