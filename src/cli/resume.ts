import type { CacheSession } from "./cache.js";
import { git } from "./git.js";
import { type CommitRecord, COMMITS_PER_BATCH, HistoryError, type HistoryReport, readCommitBatch } from "./history.js";
import type { LayoutSnapshot } from "./layout.js";
import { TimelineBuilder } from "./timeline.js";

/** The first-parent chain ending at `head`, oldest commit first. */
export async function firstParentChain(repoDir: string, head: string): Promise<string[]> {
  const out = await git(repoDir, ["rev-list", "--first-parent", "--reverse", head, "--"]);
  return out === "" ? [] : out.split("\n");
}

export interface TimelineRead {
  builder: TimelineBuilder;
  /** The first-parent chain that was read, oldest first. */
  chain: string[];
  /** Blobs unreadable across the whole history, including those counted by earlier runs. */
  missingBlobs: number;
  /** Commits this run replayed into the Timeline (after any checkpoint it resumed from). */
  replayed: number;
  /** Commits this run read from git; the rest came from the cache. */
  read: number;
  /** The checkpoint this run resumed from, if any. */
  resumedFrom?: string;
  /** The layout saved with that checkpoint, if it has one. Its commits are the ones before `chain.length - replayed`. */
  layout?: LayoutSnapshot;
}

/**
 * Builds the Timeline for `head`, reusing the cache. Resumes from the newest checkpoint still on the
 * first-parent chain (so a rewrite rolls back to it), takes cached commit records where it has them,
 * and reads the rest from git in batches.
 */
export async function readTimeline(repoDir: string, head: string, branch: string, cache: CacheSession): Promise<TimelineRead> {
  const chain = await firstParentChain(repoDir, head);
  const position = new Map(chain.map((hash, i) => [hash, i]));

  let builder = new TimelineBuilder();
  let missingBlobs = 0;
  let start = 0;
  let resumedFrom: string | undefined;
  let layout: LayoutSnapshot | undefined;
  const checkpoints = await cache.checkpoints(branch);
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const checkpoint = checkpoints[i]!;
    const at = position.get(checkpoint.commit);
    if (at === undefined) continue;
    const state = await cache.loadState(branch, checkpoint);
    if (state === undefined) continue; // the checkpoint's state is gone: fall back to an older one
    builder = TimelineBuilder.restore(state);
    missingBlobs = checkpoint.missingBlobs;
    start = at + 1;
    resumedFrom = checkpoint.commit;
    layout = await cache.loadLayout(branch, checkpoint);
    break;
  }

  const report: HistoryReport = { missingBlobs: 0 };
  let read = 0;
  for (let i = start; i < chain.length; i += COMMITS_PER_BATCH) {
    const hashes = chain.slice(i, i + COMMITS_PER_BATCH);
    const { records, fresh } = await batchRecords(repoDir, hashes, cache, report);
    for (const record of records) builder.add(record);
    await cache.saveBatch(fresh);
    read += fresh.length;
  }

  return {
    builder,
    chain,
    missingBlobs: missingBlobs + report.missingBlobs,
    replayed: chain.length - start,
    read,
    resumedFrom,
    layout,
  };
}

/** The records for `hashes`, in order: cached ones from layer 2, the rest read from git. */
async function batchRecords(
  repoDir: string,
  hashes: readonly string[],
  cache: CacheSession,
  report: HistoryReport,
): Promise<{ records: CommitRecord[]; fresh: { hash: string; commit: CommitRecord }[] }> {
  const cached = new Map<string, CommitRecord>();
  const unread: string[] = [];
  for (const hash of hashes) {
    const record = cache.hasCommit(hash) ? await cache.commitRecord(hash) : undefined;
    if (record) cached.set(hash, record);
    else unread.push(hash);
  }
  const fresh = await readCommitBatch(repoDir, unread, cache.facts, report);
  const byHash = new Map(fresh.map((entry) => [entry.hash, entry.commit]));
  const records = hashes.map((hash) => {
    const record = cached.get(hash) ?? byHash.get(hash);
    if (!record) throw new HistoryError(`git log did not return commit ${hash}`);
    return record;
  });
  return { records, fresh };
}
