import { SECONDS_PER_DAY } from "../shared/format.js";
import { type FileFacts, resolveBlobFacts, SUBMODULE_FACTS } from "./facts.js";
import { gitMaybe, gitStream } from "./git.js";

/** Commits parsed before their blobs are read. Bounds memory; the whole history is never held. */
export const COMMITS_PER_BATCH = 1000;

/** One file version a commit adds or rewrites, with the blob that holds its new content. */
export interface FileWrite {
  path: string;
  blob: string;
  facts: FileFacts;
}

/** One commit on the Timeline, with its net change against its first parent. */
export interface CommitRecord {
  /** Days since 1970-01-01 UTC, from the committer date. */
  day: number;
  /** Paths that appear in this commit. A rename appears here under its new path. */
  added: string[];
  /** Paths that disappear in this commit. A rename disappears here under its old path. */
  deleted: string[];
  /** Standing paths whose content changed in this commit (status M or T). */
  modified: string[];
  /**
   * Renames in this commit, also listed in `deleted` (old path) and `added` (new path): the same file moved.
   * A copy is not a rename and is not listed here.
   */
  renamed?: { from: string; to: string }[];
  /**
   * Line counts after this commit, for the paths whose lines are known (added or modified files).
   * Filled by the history extraction's file facts; absent paths count as one Floor.
   */
  lines?: Map<string, number>;
  /** Every file version this commit adds or rewrites, under its path after the commit. */
  writes: FileWrite[];
}

export class HistoryError extends Error {}

/** A file version as git reports it, before its blob has been read. */
interface RawWrite {
  path: string;
  blob: string;
  mode: string;
}

interface RawCommit {
  day: number;
  added: string[];
  deleted: string[];
  modified: string[];
  renamed: { from: string; to: string }[];
  writes: RawWrite[];
}

export interface TimelineHead {
  /** The full hash of the Timeline's newest commit. */
  head: string;
  /** The branch name the Timeline was read from, for messages. */
  branch: string;
}

/**
 * Picks the Timeline: `branch` if given, otherwise the default branch
 * (the one `origin/HEAD` names, else the checked-out branch).
 */
export async function resolveTimelineHead(repoDir: string, branch?: string): Promise<TimelineHead> {
  if (!(await gitMaybe(repoDir, ["rev-parse", "--git-dir"]))) throw new HistoryError(`not a git repository: ${repoDir}`);

  let name = branch;
  if (name === undefined) {
    const remoteDefault = await gitMaybe(repoDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const local = remoteDefault?.replace(/^origin\//, "");
    if (local && (await gitMaybe(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`]))) name = local;
    else name = remoteDefault ?? (await gitMaybe(repoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? "HEAD";
  }

  const head = await gitMaybe(repoDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`]);
  if (!head) {
    throw new HistoryError(branch === undefined ? `branch ${name} has no commits yet` : `no such branch: ${branch}`);
  }
  return { head, branch: name };
}

/** Mode git gives a submodule entry, whose "blob" is a commit. */
const SUBMODULE_MODE = "160000";

/** Counts gathered while reading history, for the build summary. */
export interface HistoryReport {
  /** Blobs git could not read, recorded with zero size and lines. */
  missingBlobs: number;
}

/**
 * Streams the first-parent history ending at `head`, oldest commit first.
 * Commits are read in batches of COMMITS_PER_BATCH: each batch's blobs are sized and
 * counted before its commits are yielded, so memory stays bounded by one batch.
 */
export async function* readHistory(repoDir: string, head: string, report: HistoryReport = { missingBlobs: 0 }): AsyncGenerator<CommitRecord> {
  const args = [
    "log", "--first-parent", "--reverse", "--diff-merges=first-parent",
    "-M", "--raw", "-z", "--no-abbrev", "--no-textconv", "--no-ext-diff", "--no-relative", "--no-color",
    "--format=%x01%ct", head, "--",
  ];
  const parser = new RawLogParser();
  const known = new Map<string, FileFacts>();
  let batch: RawCommit[] = [];
  for await (const part of gitStream(repoDir, args)) {
    for (const commit of parser.push(part)) {
      batch.push(commit);
      if (batch.length === COMMITS_PER_BATCH) {
        yield* await completeBatch(repoDir, batch, known, report);
        batch = [];
      }
    }
  }
  for (const commit of parser.end()) batch.push(commit);
  if (batch.length > 0) yield* await completeBatch(repoDir, batch, known, report);
}

/** Reads the blobs a batch of commits needs (once per blob ID per run) and attaches their facts. */
async function completeBatch(
  repoDir: string,
  batch: RawCommit[],
  known: Map<string, FileFacts>,
  report: HistoryReport,
): Promise<CommitRecord[]> {
  const unknown = new Set<string>();
  for (const commit of batch) {
    for (const write of commit.writes) {
      if (write.mode !== SUBMODULE_MODE && !known.has(write.blob)) unknown.add(write.blob);
    }
  }
  if (unknown.size > 0) {
    const resolved = await resolveBlobFacts(repoDir, [...unknown]);
    for (const [blob, facts] of resolved.facts) known.set(blob, facts);
    report.missingBlobs += resolved.missing;
  }
  return batch.map((commit) => ({
    day: commit.day,
    added: commit.added,
    deleted: commit.deleted,
    modified: commit.modified,
    renamed: commit.renamed,
    writes: commit.writes.map((write) => ({
      path: write.path,
      blob: write.blob,
      facts: write.mode === SUBMODULE_MODE ? SUBMODULE_FACTS : known.get(write.blob)!,
    })),
  }));
}

/** Whether the repository is a shallow clone, whose history stops at its cut-off commits. */
export async function isShallowRepository(repoDir: string): Promise<boolean> {
  return (await gitMaybe(repoDir, ["rev-parse", "--is-shallow-repository"])) === "true";
}

/** Incrementally parses `git log --raw -z --format=%x01%ct` output into commits. */
class RawLogParser {
  private rest: Buffer = Buffer.alloc(0);
  private commit: RawCommit | undefined;
  private status = "";
  private mode = "";
  private blob = "";
  private paths: string[] = [];
  private pathsWanted = 0;

  *push(data: Buffer): Generator<RawCommit> {
    const buf = this.rest.length ? Buffer.concat([this.rest, data]) : data;
    let start = 0;
    for (let nul = buf.indexOf(0, start); nul !== -1; nul = buf.indexOf(0, start)) {
      yield* this.token(buf.toString("utf8", start, nul));
      start = nul + 1;
    }
    this.rest = buf.subarray(start);
  }

  *end(): Generator<RawCommit> {
    if (this.rest.length) yield* this.token(this.rest.toString("utf8"));
    this.rest = Buffer.alloc(0);
    if (this.commit) yield this.commit;
    this.commit = undefined;
  }

  private *token(token: string): Generator<RawCommit> {
    if (this.pathsWanted > 0) {
      this.paths.push(token);
      if (--this.pathsWanted === 0) this.applyChange();
      return;
    }
    if (token.startsWith("\x01")) {
      if (this.commit) yield this.commit;
      const seconds = Number(token.slice(1));
      if (!Number.isFinite(seconds)) throw new HistoryError(`unexpected commit header from git log: ${JSON.stringify(token)}`);
      this.commit = { day: Math.floor(seconds / SECONDS_PER_DAY), added: [], deleted: [], modified: [], renamed: [], writes: [] };
      return;
    }
    const header = token.replace(/^\n/, "");
    if (!header.startsWith(":") || !this.commit) throw new HistoryError(`unexpected output from git log: ${JSON.stringify(token)}`);
    // ":<old mode> <new mode> <old blob> <new blob> <status>"
    const fields = header.split(" ");
    this.mode = fields[1] ?? "";
    this.blob = fields[3] ?? "";
    this.status = fields[4] ?? "";
    this.paths = [];
    this.pathsWanted = this.status.startsWith("R") || this.status.startsWith("C") ? 2 : 1;
  }

  private applyChange() {
    const commit = this.commit!;
    const [from, to] = this.paths as [string, string | undefined];
    const write = (path: string) => commit.writes.push({ path, blob: this.blob, mode: this.mode });
    switch (this.status[0]) {
      case "A":
        commit.added.push(from);
        write(from);
        break;
      case "D":
        commit.deleted.push(from);
        break;
      case "R":
        commit.deleted.push(from);
        commit.added.push(to!);
        commit.renamed.push({ from, to: to! });
        write(to!);
        break;
      case "C":
        commit.added.push(to!);
        write(to!);
        break;
      case "M":
      case "T":
        // A rewritten file keeps its place on the Timeline, but its facts change.
        commit.modified.push(from);
        write(from);
        break;
    }
  }
}
