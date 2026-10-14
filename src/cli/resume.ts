import { type CacheSession, scopeOf, scopeOfCheckpoint } from "./cache.js";
import { git } from "./git.js";
import { type CommitRecord, COMMITS_PER_BATCH, HistoryError, type HistoryReport, readCommitBatch } from "./history.js";
import { Pipeline, type PipelineOptions } from "./pipeline.js";

/** The first-parent chain ending at `head`, oldest commit first. */
export async function firstParentChain(repoDir: string, head: string): Promise<string[]> {
  const out = await git(repoDir, ["rev-list", "--first-parent", "--reverse", head, "--"]);
  return out === "" ? [] : out.split("\n");
}

export interface PipelineRead {
  pipeline: Pipeline;
  /** The first-parent chain that was read, oldest first. */
  chain: string[];
  /** Blobs unreadable across the whole history, including those counted by earlier runs. */
  missingBlobs: number;
  /** Commits this run replayed into the pipeline (after any checkpoint it resumed from). */
  replayed: number;
  /** Commits this run read from git; the rest came from the cache. */
  read: number;
  /** The exclude scope this run used (see scopeOf). */
  scope: string;
  /** The checkpoint this run resumed from, if any. */
  resumedFrom?: string;
}

/**
 * Runs the pipeline over the history ending at `head`, reusing the cache. Resumes from the newest checkpoint still on
 * the first-parent chain (so a rewrite rolls back to it) that has both its run state and its layout, takes cached
 * commit records where it has them, and reads the rest from git in batches.
 */
export async function readPipeline(
  repoDir: string,
  head: string,
  branch: string,
  cache: CacheSession,
  options: PipelineOptions,
): Promise<PipelineRead> {
  const chain = await firstParentChain(repoDir, head);
  const position = new Map(chain.map((hash, i) => [hash, i]));

  let pipeline = Pipeline.fresh(options);
  let missingBlobs = 0;
  let start = 0;
  let resumedFrom: string | undefined;
  const scope = scopeOf(options.exclude, options.externals);
  const checkpoints = await cache.checkpoints(branch);
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const checkpoint = checkpoints[i]!;
    const at = position.get(checkpoint.commit);
    if (at === undefined || scopeOfCheckpoint(checkpoint) !== scope) continue; // another scope (exclude rules) is never resumed
    const state = await cache.loadState(branch, checkpoint);
    const layout = await cache.loadLayout(branch, checkpoint);
    if (state === undefined || layout === undefined) continue; // a missing layer: fall back to an older checkpoint
    const restored = Pipeline.restore(options, state, layout);
    if (restored === undefined) continue;
    pipeline = restored;
    missingBlobs = checkpoint.missingBlobs;
    start = at + 1;
    resumedFrom = checkpoint.commit;
    break;
  }

  const report: HistoryReport = { missingBlobs: 0 };
  let read = 0;
  for (let i = start; i < chain.length; i += COMMITS_PER_BATCH) {
    const hashes = chain.slice(i, i + COMMITS_PER_BATCH);
    const { records, fresh } = await batchRecords(repoDir, hashes, cache, report);
    for (const record of records) await pipeline.add(record);
    await cache.saveBatch(fresh);
    read += fresh.length;
  }

  return {
    pipeline,
    chain,
    missingBlobs: missingBlobs + report.missingBlobs,
    replayed: chain.length - start,
    read,
    resumedFrom,
    scope,
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
