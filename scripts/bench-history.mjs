#!/usr/bin/env node
// Times history extraction (commit walk, renames, file facts) against a repository.
//
// Usage: npm run build:cli && node scripts/bench-history.mjs <repo-dir> [--branch <name>]
//
// Point it at a repository with about 25k first-parent commits to reproduce the ticket benchmark.
// It prints one line of timing and memory figures; it never writes to the repository.
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { readHistory, resolveTimelineHead } from "../dist/cli/history.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { branch: { type: "string" } },
});
const repoDir = positionals[0];
if (!repoDir) {
  process.stderr.write("usage: node scripts/bench-history.mjs <repo-dir> [--branch <name>]\n");
  process.exit(2);
}

const { head, branch } = await resolveTimelineHead(repoDir, values.branch);
const report = { missingBlobs: 0 };
let peakRss = process.memoryUsage().rss;
let commits = 0;
let writes = 0;
let bytesScanned = 0;

const started = performance.now();
for await (const commit of readHistory(repoDir, head, report)) {
  commits++;
  writes += commit.writes.length;
  for (const write of commit.writes) bytesScanned += write.facts.size;
  if (commits % 1000 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
}
const elapsed = (performance.now() - started) / 1000;
peakRss = Math.max(peakRss, process.memoryUsage().rss);

process.stdout.write(
  [
    `branch=${branch}`,
    `commits=${commits}`,
    `file_versions=${writes}`,
    `missing_blobs=${report.missingBlobs}`,
    `blob_bytes=${bytesScanned}`,
    `seconds=${elapsed.toFixed(2)}`,
    `commits_per_second=${(commits / elapsed).toFixed(0)}`,
    `peak_rss_mb=${(peakRss / 2 ** 20).toFixed(0)}`,
  ].join(" ") + "\n",
);
