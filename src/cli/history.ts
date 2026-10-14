import { SECONDS_PER_DAY } from "../shared/format.js";
import { gitMaybe, gitStream } from "./git.js";


/** One commit on the Timeline, with its net change against its first parent. */
export interface CommitRecord {
  /** Days since 1970-01-01 UTC, from the committer date. */
  day: number;
  /** Paths that appear in this commit. A rename appears here under its new path. */
  added: string[];
  /** Paths that disappear in this commit. A rename disappears here under its old path. */
  deleted: string[];
}

export class HistoryError extends Error {}

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

/** Streams the first-parent history ending at `head`, oldest commit first. */
export async function* readHistory(repoDir: string, head: string): AsyncGenerator<CommitRecord> {
  const args = [
    "log", "--first-parent", "--reverse", "--diff-merges=first-parent",
    "-M", "--raw", "-z", "--no-abbrev", "--no-textconv", "--no-ext-diff", "--no-relative", "--no-color",
    "--format=%x01%ct", head, "--",
  ];
  const parser = new RawLogParser();
  for await (const part of gitStream(repoDir, args)) yield* parser.push(part);
  yield* parser.end();
}

/** Incrementally parses `git log --raw -z --format=%x01%ct` output into commits. */
class RawLogParser {
  private rest: Buffer = Buffer.alloc(0);
  private commit: CommitRecord | undefined;
  private status = "";
  private paths: string[] = [];
  private pathsWanted = 0;

  *push(data: Buffer): Generator<CommitRecord> {
    const buf = this.rest.length ? Buffer.concat([this.rest, data]) : data;
    let start = 0;
    for (let nul = buf.indexOf(0, start); nul !== -1; nul = buf.indexOf(0, start)) {
      yield* this.token(buf.toString("utf8", start, nul));
      start = nul + 1;
    }
    this.rest = buf.subarray(start);
  }

  *end(): Generator<CommitRecord> {
    if (this.rest.length) yield* this.token(this.rest.toString("utf8"));
    this.rest = Buffer.alloc(0);
    if (this.commit) yield this.commit;
    this.commit = undefined;
  }

  private *token(token: string): Generator<CommitRecord> {
    if (this.pathsWanted > 0) {
      this.paths.push(token);
      if (--this.pathsWanted === 0) this.applyChange();
      return;
    }
    if (token.startsWith("\x01")) {
      if (this.commit) yield this.commit;
      const seconds = Number(token.slice(1));
      if (!Number.isFinite(seconds)) throw new HistoryError(`unexpected commit header from git log: ${JSON.stringify(token)}`);
      this.commit = { day: Math.floor(seconds / SECONDS_PER_DAY), added: [], deleted: [] };
      return;
    }
    const header = token.replace(/^\n/, "");
    if (!header.startsWith(":") || !this.commit) throw new HistoryError(`unexpected output from git log: ${JSON.stringify(token)}`);
    this.status = header.slice(header.lastIndexOf(" ") + 1);
    this.paths = [];
    this.pathsWanted = this.status.startsWith("R") || this.status.startsWith("C") ? 2 : 1;
  }

  private applyChange() {
    const commit = this.commit!;
    const [from, to] = this.paths as [string, string | undefined];
    switch (this.status[0]) {
      case "A":
        commit.added.push(from);
        break;
      case "D":
        commit.deleted.push(from);
        break;
      case "R":
        commit.deleted.push(from);
        commit.added.push(to!);
        break;
      case "C":
        commit.added.push(to!);
        break;
      // M (modified) and T (type change) leave the set of standing files unchanged.
    }
  }
}
