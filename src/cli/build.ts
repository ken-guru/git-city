import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CacheSession } from "./cache.js";
import { loadConfig } from "./config.js";
import { gitMaybe } from "./git.js";
import { type HistoryReport, isShallowRepository, readHistory, resolveTimelineHead } from "./history.js";
import { type LayoutChange, LayoutBuilder, type LayoutResult, type Role } from "./layout.js";
import { categoryOf } from "./model.js";
import { type NearMiss, nameFiles, namePlaces, type PlaceInput, type Revealed } from "./naming.js";
import { seedNumber } from "./namer.js";
import { PrivacyError, scanOutput } from "./privacy.js";
import { readTimeline, type TimelineRead } from "./resume.js";
import { DEFAULT_THEME, hueFor, loadTheme } from "./theme.js";
import { TimelineBuilder, type TimelineData } from "./timeline.js";
import { EVENT_ADD, EVENT_DELETE } from "../shared/format.js";
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
  /** `--theme`: the Theme to name and colour the City with. Wins over the config. */
  theme?: string;
  /** `--seed`: the seed for Generated names. Wins over `naming.seed`. */
  seed?: string;
  /** `--fresh`: rebuild the cache from scratch. */
  fresh?: boolean;
  /** `--wait`: wait for another run to finish instead of failing. */
  wait?: boolean;
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
  /** Non-fatal problems to show the user, such as a shallow clone. */
  warnings: string[];
  /** The Theme the names and colours came from. */
  theme: string;
}

export async function build(options: BuildOptions): Promise<BuildSummary> {
  const outDir = resolve(options.outDir);
  const { head, branch } = await resolveTimelineHead(options.repoDir, options.branch);
  const warnings: string[] = [];
  if (await isShallowRepository(options.repoDir)) {
    warnings.push("this is a shallow clone, so the City shows only the history it holds; run git fetch --unshallow for all of it");
  }
  const config = loadConfig(await configFiles(options.repoDir, options.configPath));
  const theme = loadTheme(options.theme ?? config.theme ?? DEFAULT_THEME);
  const seedText = options.seed ?? config.naming.seed ?? (await rootCommit(options.repoDir, head));
  const layoutOptions = {
    seed: seedNumber(seedText),
    categoryOf: (path: string) => categoryOf(path),
    hueOf: (role: Role) => hueFor(theme, role),
  };

  const cache = await CacheSession.open(options.repoDir, { fresh: options.fresh, wait: options.wait });
  let timeline: TimelineRead;
  let data: TimelineData;
  let layout: LayoutResult;
  try {
    timeline = await readTimeline(options.repoDir, head, branch, cache);
    data = timeline.builder.result();
    // The layout resumes from the checkpoint's saved state, so Role hysteresis and every Lot carry over. It only
    // replays the commits after the checkpoint; without a usable saved state (or under another seed) it replays all.
    const resumed = timeline.layout ? LayoutBuilder.restore(layoutOptions, timeline.layout) : undefined;
    const layoutBuilder = resumed ?? new LayoutBuilder(layoutOptions);
    const firstNew = resumed ? timeline.chain.length - timeline.replayed : 0;
    for (const change of changesFromTimeline(data).slice(firstNew)) layoutBuilder.apply(change);
    await cache.checkpoint(branch, head, timeline.builder, new Set(timeline.chain), timeline.missingBlobs, layoutBuilder.snapshot());
    layout = layoutBuilder.result();
  } finally {
    await cache.close();
  }
  if (timeline.missingBlobs > 0) {
    warnings.push(`${timeline.missingBlobs} file versions could not be read and were counted as empty (missing objects; is this a partial clone?)`);
  }

  const names = nameFiles(data.filePaths, config, { private: options.private });
  if (options.strict && names.nearMisses.length > 0) {
    throw new PrivacyError(
      `${names.nearMisses.length} near-miss${names.nearMisses.length === 1 ? "" : "es"} found; --strict fails the build`,
    );
  }
  const places = namePlaces(placeInputs(layout), config, {
    theme,
    seed: seedText,
    hidden: names.hidden,
    private: options.private,
  });

  await writeSite(outDir, options.pageDir ?? DEFAULT_PAGE_DIR, data, names.table, places, (staging) =>
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
    warnings,
    theme: theme.name,
  };
}

/** The first root commit of the Timeline. It seeds Generated names and is never written to the output. */
async function rootCommit(repoDir: string, head: string): Promise<string> {
  const roots = (await gitMaybe(repoDir, ["rev-list", "--max-parents=0", head]))?.split("\n").filter((l) => l !== "").sort();
  return roots?.[0] ?? head;
}

/** The layout's changes, one per commit, from the Timeline's add and delete events. */
export function changesFromTimeline(data: TimelineData): LayoutChange[] {
  const changes: LayoutChange[] = Array.from({ length: data.commitDays.length }, () => ({ added: [], deleted: [] }));
  for (let i = 0; i < data.eventCommit.length; i++) {
    const file = data.eventFile[i]!;
    const path = data.filePaths[file]!;
    const change = changes[data.eventCommit[i]!]!;
    if (data.eventKind[i] === EVENT_ADD) change.added.push({ file, path });
    else if (data.eventKind[i] === EVENT_DELETE) change.deleted.push({ file, path });
  }
  return changes;
}

/** What the naming step needs about each District: structure only. */
function placeInputs(layout: LayoutResult): PlaceInput[] {
  return layout.districts.map((d) => {
    const village = layout.villages[d.village]!;
    return {
      key: d.key,
      role: d.role,
      neighbourhoods: d.neighbourhoods,
      anchor: { col: village.col, row: village.row },
      colour: d.paving,
    };
  });
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
