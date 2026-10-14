import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type FileFacts, MISSING_FACTS } from "./facts.js";
import { git } from "./git.js";
import type { CommitRecord } from "./history.js";
import type { LayoutSnapshot } from "./layout.js";
import type { PlanOptions } from "./imports/externals.js";
import type { RunState } from "./pipeline.js";

/** Folder under the git common directory that holds the cache, shared by all worktrees. */
export const CACHE_FOLDER = "git-city";

/**
 * The one place that says what each layer is made of. Each layer names the modules (relative to this folder,
 * without extension) whose code decides its contents, the packages whose declared versions do too, the folders it
 * owns, and the layers built from it. Layer 1 feeds layer 2, layer 2 feeds layer 3, and so on.
 */
const LAYER_DEFINITIONS = {
  // The facts depend on the parser runtime and the grammars, so their declared versions are part of the stamp.
  facts: {
    sources: ["facts", "imports/extract"],
    packages: ["web-tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python"],
    dirs: ["facts"],
    dependents: ["commits"],
  },
  commits: { sources: ["history", "git"], packages: [], dirs: ["commits"], dependents: ["run"] },
  // The run state is the Timeline and the import graph, so changing their code clears it.
  run: {
    sources: ["pipeline", "timeline", "model", "imports/graph", "imports/resolve", "imports/python", "imports/externals", "../shared/buildings", "../shared/format"],
    packages: [],
    dirs: ["runs", "states"],
    dependents: ["layout"],
  },
  // The layout is laid out from the Timeline's changes and the Categories it reads, so changing those clears it.
  layout: { sources: ["layout", "model"], packages: [], dirs: ["layouts"], dependents: [] },
} as const satisfies Record<
  string,
  { sources: readonly string[]; packages: readonly string[]; dirs: readonly string[]; dependents: readonly string[] }
>;
export type Layer = keyof typeof LAYER_DEFINITIONS;
const LAYERS = Object.keys(LAYER_DEFINITIONS) as Layer[];

/** The folders each layer owns, relative to the cache folder. */
const LAYER_DIRS: Record<Layer, readonly string[]> = {
  facts: LAYER_DEFINITIONS.facts.dirs,
  commits: LAYER_DEFINITIONS.commits.dirs,
  run: LAYER_DEFINITIONS.run.dirs,
  layout: LAYER_DEFINITIONS.layout.dirs,
};

/** The code of a module beside this one, in the form this file is running from (.ts under tests, .js when built). */
function sourceText(name: string): Buffer {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return readFileSync(new URL(`./${name}${ext}`, import.meta.url));
}

/** The package manifest that ships with the CLI (the repository root, or the installed package root). */
const MANIFEST = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The version range a package is declared with. A bump in the manifest changes the stamp. */
function declaredVersion(name: string): string {
  return MANIFEST.dependencies?.[name] ?? MANIFEST.devDependencies?.[name] ?? "undeclared";
}

/**
 * A layer's version stamp, derived from the code it is built from: a hash of its modules' source, this file's, and
 * the declared versions of the packages it depends on. Changing any of them changes the stamp, so no stamp is set by hand.
 */
function stampOf(layer: Layer): string {
  const hash = createHash("sha256");
  for (const name of ["cache", ...LAYER_DEFINITIONS[layer].sources]) hash.update(name).update("\0").update(sourceText(name));
  for (const name of LAYER_DEFINITIONS[layer].packages) hash.update(name).update("\0").update(declaredVersion(name)).update("\0");
  return `${layer}-${hash.digest("hex").slice(0, 12)}`;
}

/** The current stamp of every layer. Derived from code, never hand-set. */
export const LAYER_STAMPS: Readonly<Record<Layer, string>> = Object.fromEntries(LAYERS.map((l) => [l, stampOf(l)])) as Record<Layer, string>;

/** Every layer built, directly or through others, from `layer`: clearing it clears these too. */
function dependentsOf(layer: Layer): Layer[] {
  const out = new Set<Layer>();
  const pending: Layer[] = [...LAYER_DEFINITIONS[layer].dependents] as Layer[];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    pending.push(...(LAYER_DEFINITIONS[next].dependents as readonly Layer[]));
  }
  return [...out];
}

/** Checkpoints kept per branch. Older ones roll back less after a rewrite, but cost disk. */
export const MAX_CHECKPOINTS = 3;

/**
 * The scope a run's run state and layout belong to: a hash of the `exclude` globs, or "" when there are none.
 * A checkpoint is only resumed from in the same scope, so changing `exclude` rebuilds the City from the start.
 */
export function scopeOf(exclude: readonly string[] | undefined, externals?: PlanOptions): string {
  const hasExternals = externals !== undefined && (externals.threshold !== undefined || Object.keys(externals.groups ?? {}).length > 0);
  if (!hasExternals) {
    if (exclude === undefined || exclude.length === 0) return "";
    return createHash("sha256").update(JSON.stringify([...exclude].sort())).digest("hex").slice(0, 16);
  }
  // The External City grouping is part of the scope too: a different threshold or grouping rebuilds the Cities from the start.
  const grouping = { threshold: externals.threshold ?? null, groups: externals.groups ?? {} };
  return createHash("sha256").update(JSON.stringify([[...(exclude ?? [])].sort(), grouping])).digest("hex").slice(0, 16);
}

/** The scope a checkpoint was saved in. Checkpoints from before scopes existed have the empty scope. */
export function scopeOfCheckpoint(checkpoint: Checkpoint | undefined): string {
  return checkpoint?.scope ?? "";
}

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
  /** The exclude scope the run used (see scopeOf). Older checkpoints have none, which is the empty scope. */
  scope?: string;
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

  /** The run state saved at a checkpoint (layer 3), or undefined if it is missing. */
  async loadState(branch: string, checkpoint: Checkpoint): Promise<RunState | undefined> {
    return readJson<RunState>(stateFile(this.dir, branch, checkpoint.commit));
  }

  /** The layout saved at a checkpoint (layer 4), or undefined if it is missing. */
  async loadLayout(branch: string, checkpoint: Checkpoint): Promise<LayoutSnapshot | undefined> {
    return readJson<LayoutSnapshot>(layoutFile(this.dir, branch, checkpoint.commit));
  }

  /**
   * Saves the run state and the layout at `head`, then advances the branch's checkpoints.
   * Checkpoints whose commit is no longer on the first-parent chain are dropped.
   */
  async checkpoint(
    branch: string,
    head: string,
    state: RunState,
    layout: LayoutSnapshot,
    chain: ReadonlySet<string>,
    missingBlobs: number,
    scope: string,
  ): Promise<void> {
    const existing = await this.checkpoints(branch);
    if (existing.at(-1)?.commit === head && scopeOfCheckpoint(existing.at(-1)) === scope && existsSync(stateFile(this.dir, branch, head)) && existsSync(layoutFile(this.dir, branch, head))) {
      return;
    }
    const live = existing.filter((c) => chain.has(c.commit) && c.commit !== head);
    const all: Checkpoint[] = [...live, { commit: head, missingBlobs, scope }];
    const keep = all.slice(-MAX_CHECKPOINTS);

    await writeAtomic(stateFile(this.dir, branch, head), JSON.stringify(state));
    await writeAtomic(layoutFile(this.dir, branch, head), JSON.stringify(layout));
    await writeAtomic(join(this.dir, "commits", "index.json"), JSON.stringify(Object.fromEntries(this.commitIndex)));
    await writeAtomic(runPath(this.dir, branch), JSON.stringify({ checkpoints: keep } satisfies { checkpoints: Checkpoint[] }));
    for (const dropped of existing.filter((c) => !keep.some((k) => k.commit === c.commit))) {
      await rm(stateFile(this.dir, branch, dropped.commit), { force: true });
      await rm(layoutFile(this.dir, branch, dropped.commit), { force: true });
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
  for (const layer of [...clear]) for (const dependent of dependentsOf(layer)) clear.add(dependent);
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

function layoutFile(dir: string, branch: string, commit: string): string {
  return join(dir, "layouts", encodeURIComponent(branch), `${commit}.json`);
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
