import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory, resolveTimelineHead } from "./history.js";
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
}

export async function build(options: BuildOptions): Promise<BuildSummary> {
  const outDir = resolve(options.outDir);
  const { head, branch } = await resolveTimelineHead(options.repoDir, options.branch);
  const builder = new TimelineBuilder();
  for await (const commit of readHistory(options.repoDir, head)) builder.add(commit);
  const data = builder.result();
  await writeSite(outDir, options.pageDir ?? DEFAULT_PAGE_DIR, data);
  return { branch, commits: data.commitDays.length, files: data.fileCount, outDir };
}
