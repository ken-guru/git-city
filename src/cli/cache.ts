import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type FileFacts, MISSING_FACTS } from "./facts.js";
import { git } from "./git.js";
import type { CommitRecord } from "./history.js";
import type { TimelineBuilder, TimelineSnapshot } from "./timeline.js";

/** Folder under the git common directory that holds the cache, shared by all worktrees. */
export const CACHE_FOLDER = "git-city";

/**
 * One version stamp per layer. Bump a layer's stamp when its contents would mean something different.
 * Layer 1 feeds layer 2, and layer 2 feeds layer 3, so a changed stamp also clears the layers after it.
 */
export const LAYER_STAMPS = {
  facts: "facts-1",
  commits: "commits-2",
  run: "run-2",
} as const;
export type Layer = keyof typeof LAYER_STAMPS;
const LAYERS = Object.keys(LAYER_STAMPS) as Layer[];

/** The folders each layer owns, relative to the cache folder. */
const LAYER_DIRS: Record<Layer, string[]> = {
  facts: ["facts"],
  commits: ["commits"],
  run: ["runs", "states"],
};

/** Checkpoints kept per branch. Older ones roll back less after a rewrite, but cost disk. */
export const MAX_CHECKPOINTS = 3;

const LOCK_FILE = "lock";
const LOCK_POLL_MS = 200;

export class CacheError extends Error {}

/** Another run holds the lock, and this run did not ask to wait. */
export class LockError extends Error {}

/** A saved point in a branch's history: the state after processing `commit`. */
export interface Checkpoint {
  commit: string;
  /** Blobs unreadable up to this checkpoint, carried forward so the build summary stays right. */
  missingBlobs: number;
}

interface SerializedCommit extends Omit<CommitRecord, "lines"> {
  lines?: [string, number][];
}

/** A commit record as the cache writes it. */
interface CommitChunk {
  records: { hash: string; commit: SerializedCommit }[];
}

export interface OpenOptions {
  /** Clear every layer before the run. */
  fresh?: boolean;
  /** Wait for a running build to finish instead of failing. */
  wait?: boolean;
}

/** The cache folder for a repository, shared by its worktrees. */
export async function cacheDirFor(repoDir: string): Promise<string> {
  const common = await git(repoDir, ["rev-parse", "--git-common-dir"]).catch(() => "");
  if (common === "") throw new CacheError(`not a git repository: ${repoDir}`);
  return join(resolve(repoDir, common), CACHE_FOLDER);
}

/**
 * A locked view of the cache for one build run. Holds the facts layer in memory,
 * appends new chunks as batches finish, and advances the run checkpoint last.
 */
export class CacheSession {
  /** Facts by blob ID: loaded from disk, then extended by this run. */
  readonly facts: Map<string, FileFacts>;
  private readonly onDisk: ReadonlySet<string>;
  /** Blobs whose facts this run has already written to layer 1. */
  private readonly writtenThisRun = new Set<string>();
  private readonly commitIndex: Map<string, string>;
  private chunk: { name: string; records: Map<string, SerializedCommit> } | undefined;

  private constructor(
    readonly dir: string,
    private readonly unlock: () => Promise<void>,
    facts: Map<string, FileFacts>,
    commitIndex: Map<string, string>,
  ) {
    this.facts = facts;
    this.onDisk = new Set(facts.keys());
    this.commitIndex = commitIndex;
  }

  /** Locks the cache, clears any layer whose stamp changed (or all of them with `fresh`), and loads what is left. */
  static async open(repoDir: string, options: OpenOptions = {}): Promise<CacheSession> {
    const dir = await cacheDirFor(repoDir);
    await mkdir(dir, { recursive: true });
    const unlock = await acquireLock(dir, options.wait === true);
    try {
      await reconcileStamps(dir, options.fresh === true);
      const facts = await loadFacts(dir);
      const index = (await readJson<Record<string, string>>(join(dir, "commits", "index.json"))) ?? {};
      return new CacheSession(dir, unlock, facts, new Map(Object.entries(index)));
    } catch (e) {
      await unlock();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.unlock();
  }

  hasCommit(hash: string): boolean {
    return this.commitIndex.has(hash);
  }

  /** A commit record from layer 2. */
  async commitRecord(hash: string): Promise<CommitRecord | undefined> {
    const name = this.commitIndex.get(hash);
    if (name === undefined) return undefined;
    if (this.chunk?.name !== name) {
      const file = await readJson<CommitChunk>(join(this.dir, "commits", name));
      if (!file) return undefined; // a bad chunk is a miss: the caller reads the commit from git
      this.chunk = { name, records: new Map(file.records.map((r) => [r.hash, r.commit])) };
    }
    const raw = this.chunk.records.get(hash);
    return raw === undefined ? undefined : decodeCommit(raw);
  }

  /**
   * Writes a finished batch of commits: its newly learned facts (layer 1) and its records (layer 2).
   * The chunks land on disk before the checkpoint advances; the commit index is written at checkpoint time.
   */
  async saveBatch(fresh: readonly { hash: string; commit: CommitRecord }[]): Promise<void> {
    // A commit with an unreadable blob is not cached: the blob may be readable on a later run.
    const cacheable = fresh.filter(({ commit }) => !commit.writes.some((w) => w.facts === MISSING_FACTS));
    const learned: [string, FileFacts][] = [];
    for (const { commit } of cacheable) {
      for (const write of commit.writes) {
        if (write.facts.kind === "submodule" || this.onDisk.has(write.blob) || this.writtenThisRun.has(write.blob)) continue;
        this.writtenThisRun.add(write.blob);
        learned.push([write.blob, write.facts]);
      }
    }
    if (learned.length > 0) await writeChunk(join(this.dir, "facts"), learned);
    if (cacheable.length === 0) return;

    const records = cacheable.map(({ hash, commit }) => ({ hash, commit: encodeCommit(commit) }));
    const name = await writeChunk(join(this.dir, "commits"), { records } satisfies CommitChunk);
    for (const { hash } of cacheable) this.commitIndex.set(hash, name);
  }

  /** Checkpoints for a branch, oldest first. */
  async checkpoints(branch: string): Promise<Checkpoint[]> {
    return (await readJson<{ checkpoints: Checkpoint[] }>(runPath(this.dir, branch)))?.checkpoints ?? [];
  }

  /** The run state saved at a checkpoint, or undefined if it is missing. */
  async loadState(branch: string, checkpoint: Checkpoint): Promise<TimelineSnapshot | undefined> {
    return readJson<TimelineSnapshot>(stateFile(this.dir, branch, checkpoint.commit));
  }

  /**
   * Saves the run state at `head` (layer 3), then advances the branch's checkpoints.
   * Checkpoints whose commit is no longer on the first-parent chain are dropped.
   */
  async checkpoint(
    branch: string,
    head: string,
    builder: TimelineBuilder,
    chain: ReadonlySet<string>,
    missingBlobs: number,
  ): Promise<void> {
    const existing = await this.checkpoints(branch);
    if (existing.at(-1)?.commit === head && existsSync(stateFile(this.dir, branch, head))) return;
    const live = existing.filter((c) => chain.has(c.commit) && c.commit !== head);
    const all = [...live, { commit: head, missingBlobs }];
    const keep = all.slice(-MAX_CHECKPOINTS);

    await writeAtomic(stateFile(this.dir, branch, head), JSON.stringify(builder.snapshot()));
    await writeAtomic(join(this.dir, "commits", "index.json"), JSON.stringify(Object.fromEntries(this.commitIndex)));
    await writeAtomic(runPath(this.dir, branch), JSON.stringify({ checkpoints: keep } satisfies { checkpoints: Checkpoint[] }));
    for (const dropped of existing.filter((c) => !keep.some((k) => k.commit === c.commit))) {
      await rm(stateFile(this.dir, branch, dropped.commit), { force: true });
    }
  }
}

/** Lists the branches with a checkpoint, and what each holds, for `cache status`. */
export async function cacheStatus(repoDir: string): Promise<string[]> {
  const dir = await cacheDirFor(repoDir);
  if (!existsSync(dir)) return [`No cache at ${dir}`];
  const stored = (await readJson<Partial<Record<Layer, string>>>(join(dir, "stamps.json"))) ?? {};
  const lines = [`Cache: ${dir}`];
  for (const layer of LAYERS) {
    let bytes = 0;
    let files = 0;
    for (const d of LAYER_DIRS[layer]) {
      const usage = await usageOf(join(dir, d));
      bytes += usage.bytes;
      files += usage.files;
    }
    const stamp = stored[layer] ?? "none";
    const note = stamp === LAYER_STAMPS[layer] ? "" : ` (current stamp ${LAYER_STAMPS[layer]}; rebuilt on next run)`;
    lines.push(`  ${layer}: stamp ${stamp}${note}, ${files} files, ${bytes} bytes`);
  }
  for (const name of await listFiles(join(dir, "runs"))) {
    const branch = decodeURIComponent(name.replace(/\.json$/, ""));
    const cps = (await readJson<{ checkpoints: Checkpoint[] }>(join(dir, "runs", name)))?.checkpoints ?? [];
    const newest = cps.at(-1)?.commit.slice(0, 12) ?? "none";
    lines.push(`  checkpoints for ${branch}: ${cps.length}, newest ${newest}`);
  }
  if (existsSync(join(dir, LOCK_FILE))) lines.push("  a build is running (lock held)");
  return lines;
}

/** Removes every layer, keeping the lock while it runs. */
export async function cacheClear(repoDir: string, wait = false): Promise<string> {
  const session = await CacheSession.open(repoDir, { fresh: true, wait });
  await session.close();
  return session.dir;
}

async function acquireLock(dir: string, wait: boolean): Promise<() => Promise<void>> {
  const path = join(dir, LOCK_FILE);
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        if ((await readFile(path, "utf8").catch(() => "")) === String(process.pid)) await rm(path, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    const holder = await readFile(path, "utf8").catch(() => undefined);
    if (holder === undefined) continue; // released while we looked
    const pid = Number(holder);
    if (holder.trim() !== "" && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) {
      await rm(path, { force: true }); // left behind by a run that died
      continue;
    }
    if (!wait) {
      const who = holder.trim() === "" ? "" : ` (pid ${holder.trim()})`;
      throw new LockError(`another git-city run holds the cache lock${who}; use --wait to wait for it`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Clears the layers whose stamp changed (or all, with `fresh`), then records the current stamps. */
async function reconcileStamps(dir: string, fresh: boolean): Promise<void> {
  const stored = (await readJson<Partial<Record<Layer, string>>>(join(dir, "stamps.json"))) ?? {};
  const clear = new Set<Layer>(fresh ? LAYERS : []);
  for (const layer of LAYERS) if (stored[layer] !== LAYER_STAMPS[layer]) clear.add(layer);
  if (clear.has("facts")) clear.add("commits");
  if (clear.has("commits")) clear.add("run");
  for (const layer of clear) {
    for (const d of LAYER_DIRS[layer]) await rm(join(dir, d), { recursive: true, force: true });
  }
  await writeAtomic(join(dir, "stamps.json"), JSON.stringify(LAYER_STAMPS));
}

async function loadFacts(dir: string): Promise<Map<string, FileFacts>> {
  const facts = new Map<string, FileFacts>();
  for (const name of await listFiles(join(dir, "facts"))) {
    for (const [blob, value] of (await readJson<[string, FileFacts][]>(join(dir, "facts", name))) ?? []) {
      facts.set(blob, value);
    }
  }
  return facts;
}

function encodeCommit(commit: CommitRecord): SerializedCommit {
  return { ...commit, lines: commit.lines ? [...commit.lines] : undefined };
}

function decodeCommit(raw: SerializedCommit): CommitRecord {
  const { lines, ...rest } = raw;
  return lines === undefined ? rest : { ...rest, lines: new Map(lines) };
}

function runPath(dir: string, branch: string): string {
  return join(dir, "runs", `${encodeURIComponent(branch)}.json`);
}

function stateFile(dir: string, branch: string, commit: string): string {
  return join(dir, "states", encodeURIComponent(branch), `${commit}.json`);
}

async function writeChunk(folder: string, value: unknown): Promise<string> {
  const name = `${randomUUID()}.json`;
  await writeAtomic(join(folder, name), JSON.stringify(value));
  return name;
}

/** Writes to a temporary file beside `path`, then renames it into place, so readers never see a partial file. */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

/** Parsed JSON, or undefined if the file is missing or unreadable. A cache is disposable, so a bad file is a miss. */
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Plain file names in a folder, skipping temporary files; empty if the folder is missing. */
async function listFiles(folder: string): Promise<string[]> {
  const names = await readdir(folder).catch(() => [] as string[]);
  return names.filter((n) => !n.endsWith(".tmp")).sort();
}

async function usageOf(path: string): Promise<{ files: number; bytes: number }> {
  const usage = { files: 0, bytes: 0 };
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      const inner = await usageOf(full);
      usage.files += inner.files;
      usage.bytes += inner.bytes;
    } else {
      usage.files++;
      usage.bytes += (await stat(full)).size;
    }
  }
  return usage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
