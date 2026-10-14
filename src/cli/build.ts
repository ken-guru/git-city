import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type HistoryReport, isShallowRepository, readHistory, resolveTimelineHead } from "./history.js";
import { TimelineBuilder } from "./timeline.js";
import { writeSite } from "./write.js";

/** The pre-built page, shipped at `dist/page/` next to the CLI. */
export const DEFAULT_PAGE_DIR = fileURLToPath(new URL("../page/", import.meta.url));

export interface BuildOptions {
  repoDir: string;
  outDir: string;
  branch?: string;
  pageDir?: string;
}

export interface BuildSummary {
  branch: string;
  commits: number;
  files: number;
  outDir: string;
  /** Non-fatal problems to show the user, such as a shallow clone. */
  warnings: string[];
}

export async function build(options: BuildOptions): Promise<BuildSummary> {
  const outDir = resolve(options.outDir);
  const { head, branch } = await resolveTimelineHead(options.repoDir, options.branch);
  const warnings: string[] = [];
  if (await isShallowRepository(options.repoDir)) {
    warnings.push("this is a shallow clone, so the City shows only the history it holds; run git fetch --unshallow for all of it");
  }
  const builder = new TimelineBuilder();
  const report: HistoryReport = { missingBlobs: 0 };
  for await (const commit of readHistory(options.repoDir, head, report)) builder.add(commit);
  if (report.missingBlobs > 0) {
    warnings.push(`${report.missingBlobs} file versions could not be read and were counted as empty (missing objects; is this a partial clone?)`);
  }
  const data = builder.result();
  await writeSite(outDir, options.pageDir ?? DEFAULT_PAGE_DIR, data);
  return { branch, commits: data.commitDays.length, files: data.fileCount, outDir, warnings };
}
