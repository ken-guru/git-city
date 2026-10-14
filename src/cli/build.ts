import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CacheSession } from "./cache.js";
import { loadConfig } from "./config.js";
import { gitMaybe, git } from "./git.js";
import { isShallowRepository, resolveTimelineHead } from "./history.js";
import { categoryOf } from "./model.js";
import { NO_DISTRICT, type LayoutResult, type LotRecord } from "./layout.js";
import { type NearMiss, nameFiles, namePlaces, type PlaceInput, type Revealed } from "./naming.js";
import { seedNumber } from "./namer.js";
import { type PipelineOptions } from "./pipeline.js";
import { PrivacyError, scanOutput } from "./privacy.js";
import { readPipeline, type PipelineRead } from "./resume.js";
import type { SizeReport } from "./chunks.js";
import { type RoadNetwork, buildRoadNetwork } from "./imports/roads.js";
import { DEFAULT_THEME, hueFor, loadTheme, type Theme } from "./theme.js";
import type { StintTable, WorldLayout } from "../shared/format.js";
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
  /** Compressed sizes of the site's data, against the budget. */
  sizes: SizeReport;
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
  // The City seed: it drives Generated names, the layout and the Countryside.
  const seedText = options.seed ?? config.naming.seed ?? (await rootCommit(options.repoDir, head));
  const seed = seedNumber(seedText);

  const cache = await CacheSession.open(options.repoDir, { fresh: options.fresh, wait: options.wait });
  let read: PipelineRead;
  try {
    read = await readPipeline(options.repoDir, head, branch, cache, pipelineOptions(options.repoDir, seed, theme));
    await cache.checkpoint(branch, head, read.pipeline.runState(), read.pipeline.layout.snapshot(), new Set(read.chain), read.missingBlobs);
  } finally {
    await cache.close();
  }
  if (read.missingBlobs > 0) {
    warnings.push(`${read.missingBlobs} file versions could not be read and were counted as empty (missing objects; is this a partial clone?)`);
  }
  const { pipeline } = read;
  const data = pipeline.timeline.result();
  const names = nameFiles(data.filePaths, config, { private: options.private });
  if (options.strict && names.nearMisses.length > 0) {
    throw new PrivacyError(
      `${names.nearMisses.length} near-miss${names.nearMisses.length === 1 ? "" : "es"} found; --strict fails the build`,
    );
  }

  const layout = pipeline.layout.result();
  const roads = roadsOf(layout, pipeline.graph.districtLinks((path) => pipeline.layout.districtForPath(path)));
  const widthStep = Uint8Array.from({ length: data.fileCount }, (_, file) => pipeline.layout.stepOf(file));
  const places = namePlaces(placeInputs(layout), config, {
    theme,
    seed: seedText,
    hidden: names.hidden,
    private: options.private,
  });

  const sizes = await writeSite(outDir, options.pageDir ?? DEFAULT_PAGE_DIR, data, worldLayout(layout, roads, seed, widthStep, data.stints), names.table, places, (staging) =>
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
    sizes,
  };
}

/** The pipeline's options for one run: the City seed, blob text for config files, and the Category and Theme hues. */
function pipelineOptions(repoDir: string, seed: number, theme: Theme): PipelineOptions {
  return {
    seed,
    readText: readBlobText(repoDir),
    categoryOf: (path) => categoryOf(path),
    hueOf: (role) => hueFor(theme, role),
  };
}

/** Reads a blob's text from the object database, for the import graph's config files. */
export function readBlobText(repoDir: string): (blob: string) => Promise<string> {
  return (blob) => git(repoDir, ["cat-file", "blob", blob]);
}

/** The first root commit of the Timeline. It seeds the City (Generated names, the layout and the Countryside) and is never written to the output. */
export async function rootCommit(repoDir: string, head: string): Promise<string> {
  const roots = (await gitMaybe(repoDir, ["rev-list", "--max-parents=0", head]))?.split("\n").filter((l) => l !== "").sort();
  return roots?.[0] ?? head;
}

/** The Road network between the villages, from the file-to-file links between their Districts. */
export function roadsOf(layout: LayoutResult, links: { from: string; to: string; strength: number }[]): RoadNetwork {
  const villageOf = new Map(layout.districts.map((d) => [d.key, d.village] as const));
  return buildRoadNetwork(
    layout.villages.map((v) => ({ id: v.id, col: v.col, row: v.row })),
    links,
    (district) => villageOf.get(district),
  );
}

/** The layout as the world file holds it: villages, Blocks, Lots, Roads and per-file width steps. */
export function worldLayout(
  layout: LayoutResult,
  roads: RoadNetwork,
  citySeed: number,
  widthStep: Uint8Array,
  stints: StintSource,
): WorldLayout {
  const positionOf = new Map(layout.districts.map((d, position) => [d.index, position] as const));
  return {
    stints: stintTable(layout.lots, stints),
    citySeed,
    widthStep,
    villages: {
      x: Float32Array.from(layout.villages, (v) => v.col),
      z: Float32Array.from(layout.villages, (v) => v.row),
      angle: Float32Array.from(layout.villages, (v) => v.angle),
    },
    blocks: {
      village: Uint32Array.from(layout.blocks, (b) => b.village),
      x: Float32Array.from(layout.blocks, (b) => b.x),
      z: Float32Array.from(layout.blocks, (b) => b.z),
      claimed: Uint32Array.from(layout.blocks, (b) => b.claimedAt),
      brick: Uint8Array.from(layout.blocks, (b) => (b.brickOffset > 0 ? 1 : 0)),
      // The places file numbers Districts by their position in the layout's list, so Blocks name that position.
      district: Uint32Array.from(layout.blocks, (b) => positionOf.get(b.district) ?? NO_DISTRICT),
    },
    lots: {
      file: Uint32Array.from(layout.lots, (l) => l.file),
      block: Uint32Array.from(layout.lots, (l) => l.block),
      slot: Uint8Array.from(layout.lots, (l) => l.slot),
      slots: Uint8Array.from(layout.lots, (l) => l.slots),
    },
    roads: {
      a: Uint32Array.from(roads.roads, (r) => r.a),
      b: Uint32Array.from(roads.roads, (r) => r.b),
      forward: Uint8Array.from(roads.roads, (r) => r.lanes.forward),
      backward: Uint8Array.from(roads.roads, (r) => r.lanes.backward),
      track: Uint8Array.from(roads.roads, (r) => (r.track ? 1 : 0)),
    },
  };
}

/** The Timeline's Stints, as the page needs them: each one's file, Building type at creation, and the Stint it replaces. */
export interface StintSource {
  file: Uint32Array;
  buildingType: Uint8Array;
  from: Int32Array;
}

/**
 * Gives every Stint the Lot it stands on. A Stint born with its file (ADD) or a Relocation takes the next Lot the
 * layout handed that file, in order; a Renovation stands on the Lot of the Stint it replaces. Throws when the two
 * disagree, since the page would otherwise draw a Building on the wrong Lot.
 */
export function stintTable(lots: readonly LotRecord[], stints: StintSource): StintTable {
  const queues = new Map<number, number[]>();
  lots.forEach((lot, index) => {
    const queue = queues.get(lot.file) ?? [];
    queue.push(index);
    queues.set(lot.file, queue);
  });
  const lotOf = new Uint32Array(stints.file.length);
  for (let s = 0; s < stints.file.length; s++) {
    const from = stints.from[s]!;
    if (from >= 0) {
      lotOf[s] = lotOf[from]!;
      continue;
    }
    const lot = queues.get(stints.file[s]!)?.shift();
    if (lot === undefined) throw new Error(`the layout gives file ${stints.file[s]} no Lot for Stint ${s}`);
    lotOf[s] = lot;
  }
  for (const [file, queue] of queues) {
    if (queue.length > 0) throw new Error(`the layout gives file ${file} Lots that no Stint stands on`);
  }
  return { file: stints.file, lot: lotOf, buildingType: stints.buildingType };
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
