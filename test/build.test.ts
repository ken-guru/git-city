import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { seedNumber } from "../src/cli/namer.js";
import { type Chunk, decodeChunk, decodeWorld, EVENT_ADD, EVENT_DELETE, FORMAT_VERSION } from "../src/shared/format.js";
import { dayOf, FixtureRepo } from "./fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function fixture(): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  return repo;
}

/** Adds `count` one-file commits to main, numbered from `from`, with `git fast-import` (fast enough for 2,000+ commits). */
function addCommits(repo: FixtureRepo, from: number, count: number): void {
  const stream: string[] = [];
  for (let i = from; i < from + count; i++) {
    const message = `commit ${i}`;
    stream.push(
      "commit refs/heads/main",
      `mark :${i + 1}`,
      `committer Test <test@example.com> ${1704067200 + i * 3600} +0000`,
      `data ${message.length}`,
      message,
    );
    if (i === from && from > 0) stream.push("from refs/heads/main^0");
    const content = `${i}\n`;
    stream.push(`M 100644 inline f${i}.txt`, `data ${content.length}`, content);
  }
  execFileSync("git", ["-C", repo.dir, "fast-import", "--quiet"], { input: `${stream.join("\n")}\n` });
}

async function buildSite(repo: FixtureRepo, options: { branch?: string; configPath?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "git-city-out-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = join(root, "git-city-site");
  await build({ repoDir: repo.dir, outDir, pageDir, ...options });
  const world = decodeWorld(readFileSync(join(outDir, "world.bin")));
  const chunks = world.chunks.map((c) => decodeChunk(readFileSync(join(outDir, "chunks", c.name))));
  return { outDir, world, chunks };
}

/** The Building events of a chunk (add and delete), as [commit, kind]. Block and Road events are left out. */
function eventsOf(chunk: Chunk): [number, string][] {
  return [...chunk.eventCommit]
    .map((commit, i) => [commit, chunk.eventKind[i]] as const)
    .filter(([, kind]) => kind === EVENT_ADD || kind === EVENT_DELETE)
    .map(([commit, kind]) => [commit, kind === EVENT_ADD ? "add" : "delete"]);
}

describe("git-city build", () => {
  it("keeps each Step's time of day only with exactTimes, and dates to the day otherwise", async () => {
    // The fixture clock starts at 2024-01-01 00:00 UTC; the second commit comes twelve hours later.
    const repo = fixture().write("a.txt").commit("first", 0).write("b.txt").commit("second", 0.5);
    const configDir = mkdtempSync(join(tmpdir(), "git-city-config-"));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
    const configPath = join(configDir, "config.jsonc");
    writeFileSync(configPath, `{ "exactTimes": true }`);
    const midnight = Date.UTC(2024, 0, 1) / 1000;

    const plain = await buildSite(repo);
    expect(plain.world.commitSeconds).toBeUndefined();

    const timed = await buildSite(repo, { configPath });
    expect([...timed.world.commitSeconds!]).toEqual([midnight, midnight + 43_200]);
    expect([...timed.world.commitDays]).toEqual([dayOf(2024, 1, 1), dayOf(2024, 1, 1)]);
  });

  it("records a single commit's added files and its day", async () => {
    const repo = fixture().write("a.txt").write("src/b.ts").commit("first", 0);

    const { world, chunks } = await buildSite(repo);

    expect(world.formatVersion).toBe(FORMAT_VERSION);
    expect([...world.commitDays]).toEqual([dayOf(2024, 1, 1)]);
    expect(chunks).toHaveLength(1);
    expect(eventsOf(chunks[0]!)).toEqual([
      [0, "add"],
      [0, "add"],
    ]);
  });

  it("walks the first-parent history: deletes, renames and a merge's net change", async () => {
    const repo = fixture().write("a.txt").write("b.txt", "one\ntwo\nthree\n").commit("first");
    repo.git("mv", "b.txt", "c.txt");
    repo.git("rm", "-q", "a.txt");
    repo.commit("second");
    repo.git("checkout", "-q", "-b", "side");
    repo.write("d.txt").commit("on the side");
    repo.write("e.txt").commit("more on the side");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "side", "-m", "merge side");

    const { world, chunks } = await buildSite(repo);

    // The two side commits (4 and 5 January) are not on the Timeline; the merge is one commit.
    expect([...world.commitDays]).toEqual([dayOf(2024, 1, 2), dayOf(2024, 1, 3), dayOf(2024, 1, 5)]);
    // b.txt is renamed to c.txt in its own directory: same Building, same file id.
    expect(world.fileCount).toBe(4);
    expect(lifetimes(chunks[0]!)).toEqual([
      [0, 1], // a.txt, deleted
      [0, null], // b.txt, renamed to c.txt
      [2, null], // d.txt, via the merge
      [2, null], // e.txt, via the merge
    ]);
  });

  it("is not thrown off by the user's git config", async () => {
    const repo = fixture();
    repo.git("config", "log.showRoot", "false");
    repo.git("config", "diff.renames", "false");
    repo.git("config", "core.quotePath", "true");
    repo.write("café/ünïcode name.txt").write("plain.txt").commit("first");
    repo.git("mv", "plain.txt", "moved.txt");
    repo.commit("rename");

    const { chunks } = await buildSite(repo);

    expect(lifetimes(chunks[0]!)).toEqual([
      [0, null], // the unicode path, from the root commit
      [0, null], // plain.txt, renamed to moved.txt in its own directory: same file
    ]);
  });

  it("reads the branch it is given, and refuses one that does not exist", async () => {
    const repo = fixture().write("a.txt").commit("first");
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("b.txt").commit("feature work");
    repo.git("checkout", "-q", "main");

    const onMain = await buildSite(repo);
    expect(onMain.world.commitDays).toHaveLength(1);

    const onFeature = await buildSite(repo, { branch: "feature" });
    expect(onFeature.world.commitDays).toHaveLength(2);

    await expect(buildSite(repo, { branch: "nope" })).rejects.toThrow("no such branch: nope");
  });

  it("reports the world file and first chunk's sizes against the budget", async () => {
    const repo = fixture().write("a.txt").commit("first");
    const root = mkdtempSync(join(tmpdir(), "git-city-out-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pageDir = join(root, "page");
    mkdirSync(pageDir);
    writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");

    const summary = await build({ repoDir: repo.dir, outDir: join(root, "site"), pageDir });

    expect(summary.sizes.chunks).toBe(1);
    expect(summary.sizes.firstPlayBytes).toBeGreaterThan(0);
    expect(summary.sizes.firstPlayBytes).toBeLessThan(1024 * 1024);
    expect(summary.sizes.totalBytes).toBeGreaterThanOrEqual(summary.sizes.firstPlayBytes);
  });

  it("writes strings.json and copies the page next to the data", async () => {
    const { outDir } = await buildSite(fixture().write("a.txt").commit("first"));

    expect(JSON.parse(readFileSync(join(outDir, "strings.json"), "utf8"))).toEqual(["Other file 1"]);
    expect(readFileSync(join(outDir, "index.html"), "utf8")).toContain("stub page");
  });

  it("replaces an earlier site but never a folder that is not one", async () => {
    const repo = fixture().write("a.txt").commit("first");
    const { outDir } = await buildSite(repo);
    writeFileSync(join(outDir, "leftover.txt"), "from an earlier run");

    await build({ repoDir: repo.dir, outDir, pageDir: join(outDir, "..", "page") });
    expect(existsSync(join(outDir, "leftover.txt"))).toBe(false);

    const precious = join(outDir, "..", "precious");
    mkdirSync(precious);
    writeFileSync(join(precious, "notes.txt"), "keep me");
    await expect(build({ repoDir: repo.dir, outDir: precious, pageDir: join(outDir, "..", "page") })).rejects.toThrow(
      "not a git-city site",
    );
    expect(readFileSync(join(precious, "notes.txt"), "utf8")).toBe("keep me");
  });
});

describe("re-runs over several chunks", () => {
  it("a re-run into the same folder matches a fresh build, chunk for chunk", async () => {
    const repo = fixture();
    addCommits(repo, 0, 2100);
    const root = mkdtempSync(join(tmpdir(), "git-city-rerun-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const pageDir = join(root, "page");
    mkdirSync(pageDir);
    writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
    const outDir = join(root, "site");
    const freshDir = join(root, "fresh");

    await build({ repoDir: repo.dir, outDir, pageDir });
    // The first chunk holds commits 0 to 1999 and is unchanged by these 30 new commits, so the re-run reuses it.
    addCommits(repo, 2100, 30);
    await build({ repoDir: repo.dir, outDir, pageDir });
    await build({ repoDir: repo.dir, outDir: freshDir, pageDir });

    const chunkNames = (dir: string) => readdirSync(join(dir, "chunks")).sort();
    expect(chunkNames(freshDir)).toHaveLength(2);
    expect(chunkNames(outDir)).toEqual(chunkNames(freshDir));
    for (const name of chunkNames(freshDir)) {
      expect(readFileSync(join(outDir, "chunks", name)), name).toEqual(readFileSync(join(freshDir, "chunks", name)));
    }
    expect(readFileSync(join(outDir, "world.bin"))).toEqual(readFileSync(join(freshDir, "world.bin")));
  }, 60_000);
});

/** [commit added, commit deleted or null] for every file, sorted. */
function lifetimes(chunk: Chunk): [number, number | null][] {
  const born = new Map<number, number>();
  const died = new Map<number, number>();
  chunk.eventFile.forEach((file, i) => {
    const kind = chunk.eventKind[i];
    if (kind === EVENT_ADD) born.set(file, chunk.eventCommit[i]!);
    else if (kind === EVENT_DELETE) died.set(file, chunk.eventCommit[i]!);
  });
  return [...born]
    .map(([file, commit]): [number, number | null] => [commit, died.get(file) ?? null])
    .sort((x, y) => x[0] - y[0] || (x[1] ?? Infinity) - (y[1] ?? Infinity));
}

describe("layout and import graph in the build", () => {
  it("gives a file its Floors from its real line count", async () => {
    const repo = fixture().write("big.ts", "x\n".repeat(900)).commit("first");

    const { chunks } = await buildSite(repo);

    // ceil(sqrt(900) / 3) = 10 Floors.
    const add = chunks[0]!.eventKind.indexOf(EVENT_ADD);
    expect(chunks[0]!.eventValue[add]).toBe(10);
  });

  it("writes the City seed, the village, the Blocks and the Lots into the world file", async () => {
    const repo = fixture().write("a.txt").write("src/b.ts").commit("first");
    const root = repo.git("rev-list", "--max-parents=0", "HEAD").trim();

    const { world } = await buildSite(repo);

    // The root's files and src/ are two Districts, so two villages, each with its first Block claimed in commit 0.
    expect(world.citySeed).toBe(seedNumber(root));
    expect(world.villages.x).toHaveLength(2);
    expect([...world.blocks.village]).toEqual([0, 1]);
    expect([...world.blocks.claimed]).toEqual([0, 0]);
    expect([...world.lots.file]).toEqual([0, 1]);
    expect([...world.lots.block]).toEqual([0, 1]);
    expect([...world.lots.slot]).toEqual([0, 0]);
    expect([...world.lots.slots]).toEqual([2, 2]);
  });

  it("widens a Building whose fan-in reaches a step, and sizes its Lot for it", async () => {
    const repo = fixture()
      .write("src/shared.ts", "export const s = 1;\n")
      .write("src/a.ts", "import './shared';\n")
      .write("src/b.ts", "import './shared';\n")
      .write("src/c.ts", "import './shared';\n")
      .commit("first");

    const { world } = await buildSite(repo);

    // Three importers make fan-in 3, the first width step. The Lot for it is one step of headroom wider.
    const wide = world.widthStep.indexOf(1);
    expect(wide).toBeGreaterThanOrEqual(0);
    expect(world.lots.slots[world.lots.file.indexOf(wide)]).toBe(3);
  });

  it("resumes import edges across a checkpoint and matches a fresh run", async () => {
    const repo = fixture()
      .write("src/shared.ts", "export const s = 1;\n")
      .write("src/a.ts", "import './shared';\n")
      .commit("first");
    await buildBytes(repo);

    repo.write("src/b.ts", "import './shared';\n").write("src/c.ts", "import './shared';\n").write("src/d.ts", "import './shared';\n").commit("second");

    const resumed = await buildBytes(repo);
    const fresh = await buildBytes(repo, { fresh: true });

    expect(resumed.world).toEqual(fresh.world);
    expect(resumed.world.byteLength).toBeGreaterThan(0);
  });
});

/** Builds `repo` and returns the world file's bytes, for comparing a resumed run with a fresh one. */
async function buildBytes(repo: FixtureRepo, options: { fresh?: boolean } = {}): Promise<{ world: Uint8Array }> {
  const root = mkdtempSync(join(tmpdir(), "git-city-bytes-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = join(root, "git-city-site");
  await build({ repoDir: repo.dir, outDir, pageDir, ...options });
  return { world: readFileSync(join(outDir, "world.bin")) };
}
