import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { gitMaybe } from "./git.js";
import { readHistory, resolveTimelineHead } from "./history.js";
import { nameFiles, type NearMiss, type Revealed } from "./naming.js";
import { PrivacyError, scanOutput } from "./privacy.js";
import { TimelineBuilder } from "./timeline.js";
import { writeSite } from "./write.js";

/** The pre-built page, shipped at `dist/page/` next to the CLI. */
export const DEFAULT_PAGE_DIR = fileURLToPath(new URL("../page/", import.meta.url));

/** The shared config, at the repo root and committed. */
export const SHARED_CONFIG = "git-city.config.jsonc";
/** The personal config, under the git directory: never committed. */
const PERSONAL_CONFIG = "git-city/config.jsonc";

export interface BuildOptions {
  repoDir: string;
  outDir: string;
  branch?: string;
  pageDir?: string;
  /** `--config`: read this file instead of the shared and personal configs. */
  configPath?: string;
  /** `--strict`: any near-miss fails the build. */
  strict?: boolean;
  /** `--private`: every reveal is ignored. */
  private?: boolean;
}

export interface BuildSummary {
  branch: string;
  commits: number;
  files: number;
  outDir: string;
  /** Config files that were read, in merge order. */
  configSources: string[];
  /** Names shown as their Real name. */
  revealed: Revealed[];
  /** Revealed names that come close to a hidden name or Concept. Hidden terms are never printed. */
  nearMisses: NearMiss[];
}

export async function build(options: BuildOptions): Promise<BuildSummary> {
  const outDir = resolve(options.outDir);
  const { head, branch } = await resolveTimelineHead(options.repoDir, options.branch);
  const builder = new TimelineBuilder();
  for await (const commit of readHistory(options.repoDir, head)) builder.add(commit);
  const data = builder.result();

  const config = loadConfig(await configFiles(options.repoDir, options.configPath));
  const names = nameFiles(data.filePaths, config, { private: options.private });
  if (options.strict && names.nearMisses.length > 0) {
    throw new PrivacyError(
      `${names.nearMisses.length} near-miss${names.nearMisses.length === 1 ? "" : "es"} found; --strict fails the build`,
    );
  }

  await writeSite(outDir, options.pageDir ?? DEFAULT_PAGE_DIR, data, names.table, (staging) =>
    scanOutput(staging, names.hidden),
  );
  return {
    branch,
    commits: data.commitDays.length,
    files: data.fileCount,
    outDir,
    configSources: config.sources,
    revealed: names.revealed,
    nearMisses: names.nearMisses,
  };
}

/** The config files to read: `--config` alone, or the shared file then the personal one. */
async function configFiles(repoDir: string, configPath: string | undefined): Promise<string[]> {
  if (configPath !== undefined) return [resolve(configPath)];
  const files: string[] = [];
  const shared = join(repoDir, SHARED_CONFIG);
  if (existsSync(shared)) files.push(shared);
  const personalRelative = await gitMaybe(repoDir, ["rev-parse", "--git-path", PERSONAL_CONFIG]);
  if (personalRelative) {
    const personal = resolve(repoDir, personalRelative);
    if (existsSync(personal)) files.push(personal);
  }
  return files;
}
