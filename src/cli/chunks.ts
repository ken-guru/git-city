import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  type ChunkSnapshot,
  CHUNK_HASH_BYTES,
  chunkName,
  encodeChunk,
  EVENT_BLOCK_OWNER,
  EVENT_ROAD_BUILT,
  EVENT_ROAD_LANES,
} from "../shared/format.js";
import { applyEvent, birthStates, type FileStates } from "../shared/replay.js";
import type { TimelineData } from "./timeline.js";

/** A new chunk starts after this many commits (SPEC §9). */
const CHUNK_COMMITS = 2000;
/** ...or once a chunk compresses to about this many bytes (SPEC §9). */
const CHUNK_BYTES = 256 * 1024;
/** The compressed size is checked at this many commits apart; the cut is then found exactly by bisection. */
const CHECK_EVERY = 100;
/** The world file plus the first chunk, compressed, must fit this (SPEC §9 budget). */
export const FIRST_PLAY_BUDGET_BYTES = 1024 * 1024;
/** Everything except the bundle, compressed (SPEC §9 budget). */
export const TOTAL_BUDGET_BYTES = 15 * 1024 * 1024;

export type ChunkInput = Pick<
  TimelineData,
  "commitDays" | "fileCount" | "buildingType" | "language" | "eventCommit" | "eventFile" | "eventStint" | "eventKind" | "eventValue"
>;

export interface ChunkLimits {
  chunkCommits?: number;
  chunkBytes?: number;
  checkEvery?: number;
}

export interface PlannedChunk {
  firstCommit: number;
  /** The encoded chunk, exactly as written to `chunks/`. */
  bytes: Uint8Array;
  /** Content hash: the first CHUNK_HASH_BYTES of SHA-256 over `bytes`. */
  hash: Uint8Array;
  compressedBytes: number;
}

/**
 * Cuts the Timeline into chunks, in commit order. Each chunk holds a snapshot of the standing files at its first
 * commit and the events inside it. The cut depends only on the commits before it, so appending history never
 * changes an earlier chunk.
 */
export function planChunks(timeline: ChunkInput, limits: ChunkLimits = {}): PlannedChunk[] {
  const chunkCommits = limits.chunkCommits ?? CHUNK_COMMITS;
  const chunkBytes = limits.chunkBytes ?? CHUNK_BYTES;
  const checkEvery = limits.checkEvery ?? CHECK_EVERY;
  const commits = timeline.commitDays.length;
  const firstEvent = firstEventIndex(timeline.eventCommit, commits);
  const state = birthStates(timeline.buildingType, timeline.language);
  const carried: Carried = { owners: new Map(), roads: new Map() };

  const plans: PlannedChunk[] = [];
  let start = 0;
  do {
    const snapshot = snapshotOf(state, carried);
    const chunk = chunkFrom(timeline, snapshot, start, { commits, chunkCommits, chunkBytes, checkEvery }, firstEvent);
    plans.push({
      firstCommit: start,
      bytes: chunk.bytes,
      hash: createHash("sha256").update(chunk.bytes).digest().subarray(0, CHUNK_HASH_BYTES),
      compressedBytes: chunk.compressedBytes,
    });
    applyEvents(state, carried, timeline, firstEvent[start]!, firstEvent[chunk.end]!);
    start = chunk.end;
  } while (start < commits);
  return plans;
}

interface EncodedChunk {
  end: number;
  bytes: Uint8Array;
  compressedBytes: number;
}

/**
 * The chunk that starts at `start`, running as far as the commit limit and the byte limit allow. The size is checked
 * every `checkEvery` commits, and the last step is bisected, so the chunk stays under `chunkBytes` unless it holds a
 * single commit. The cut depends only on the commits from `start` on.
 */
function chunkFrom(
  timeline: ChunkInput,
  snapshot: ChunkSnapshot,
  start: number,
  limits: { commits: number; chunkCommits: number; chunkBytes: number; checkEvery: number },
  firstEvent: Uint32Array,
): EncodedChunk {
  const encode = (end: number): EncodedChunk => {
    const bytes = encodeRange(timeline, snapshot, start, end, firstEvent);
    return { end, bytes, compressedBytes: deflateSync(bytes).length };
  };
  const limit = Math.min(limits.commits, start + limits.chunkCommits);
  // A chunk always holds at least one commit, even one that is on its own over the byte limit.
  let fit = encode(start + 1);
  while (fit.end < limit) {
    const next = Math.min(limit, fit.end + limits.checkEvery);
    const over = encode(next);
    if (over.compressedBytes < limits.chunkBytes) {
      fit = over;
      continue;
    }
    let low = fit;
    let high = next;
    while (high - low.end > 1) {
      const mid = Math.floor((low.end + high) / 2);
      const candidate = encode(mid);
      if (candidate.compressedBytes < limits.chunkBytes) low = candidate;
      else high = mid;
    }
    return low;
  }
  return fit;
}

/**
 * Writes planned chunks into `dir` under their index and content hash. A chunk an earlier output already holds
 * under the same name is copied rather than regenerated, so a re-run rewrites only the chunks that changed.
 */
export async function writeChunks(dir: string, plans: PlannedChunk[], earlierDir?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [index, plan] of plans.entries()) {
    const name = chunkName(index, plan.hash);
    const earlier = earlierDir === undefined ? undefined : join(earlierDir, name);
    if (earlier !== undefined && existsSync(earlier)) await copyFile(earlier, join(dir, name));
    else await writeFile(join(dir, name), plan.bytes);
  }
}

/** Compressed sizes of the site's data, against the SPEC §9 budget. */
export interface SizeReport {
  chunks: number;
  worldBytes: number;
  firstPlayBytes: number;
  totalBytes: number;
}

export function sizeReport(worldBytes: Uint8Array, plans: PlannedChunk[]): SizeReport {
  const world = deflateSync(worldBytes).length;
  const chunks = plans.reduce((sum, p) => sum + p.compressedBytes, 0);
  return {
    chunks: plans.length,
    worldBytes: world,
    firstPlayBytes: world + (plans[0]?.compressedBytes ?? 0),
    totalBytes: world + chunks,
  };
}

/** One line per size against its budget, for the build summary. */
export function describeSizes(report: SizeReport): string[] {
  return [
    `Size: world file and first chunk ${kib(report.firstPlayBytes)} of ${kib(FIRST_PLAY_BUDGET_BYTES)} to first play`,
    `Size: ${report.chunks} chunk${report.chunks === 1 ? "" : "s"}, ${kib(report.totalBytes)} of ${kib(TOTAL_BUDGET_BYTES)} in total (compressed)`,
  ];
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/** Per commit, the index of its first event; entry `commits` is the total. */
function firstEventIndex(eventCommit: Uint32Array, commits: number): Uint32Array {
  const out = new Uint32Array(commits + 1);
  let at = 0;
  for (let c = 0; c <= commits; c++) {
    while (at < eventCommit.length && eventCommit[at]! < c) at++;
    out[c] = at;
  }
  return out;
}

/** What the chunks carry beyond the files: each claimed Block's owning District, and each built Road's state. */
interface Carried {
  owners: Map<number, number>;
  roads: Map<number, { built: number; forward: number; backward: number }>;
}

function snapshotOf(state: FileStates, carried: Carried): ChunkSnapshot {
  const standing: number[] = [];
  for (let file = 0; file < state.standing.length; file++) if (state.standing[file]) standing.push(file);
  const blocks = [...carried.owners].sort((a, b) => a[0] - b[0]);
  const roads = [...carried.roads].sort((a, b) => a[0] - b[0]);
  return {
    file: Uint32Array.from(standing),
    stint: Uint32Array.from(standing, (f) => state.stint[f]!),
    floors: Uint8Array.from(standing, (f) => state.floors[f]!),
    scaffolded: Uint8Array.from(standing, (f) => state.scaffolded[f]!),
    buildingType: Uint8Array.from(standing, (f) => state.buildingType[f]!),
    language: Uint8Array.from(standing, (f) => state.language[f]!),
    blockIds: Uint32Array.from(blocks, (b) => b[0]),
    blockDistricts: Uint32Array.from(blocks, (b) => b[1]),
    roadIds: Uint32Array.from(roads, (r) => r[0]),
    roadBuilt: Uint32Array.from(roads, (r) => r[1].built),
    roadForward: Uint8Array.from(roads, (r) => r[1].forward),
    roadBackward: Uint8Array.from(roads, (r) => r[1].backward),
  };
}

/** Advances the state through the events from index `from` up to `to`. */
function applyEvents(state: FileStates, carried: Carried, timeline: ChunkInput, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const kind = timeline.eventKind[i]!;
    const id = timeline.eventFile[i]!;
    const value = timeline.eventValue[i]!;
    const stint = timeline.eventStint[i]!;
    if (kind === EVENT_BLOCK_OWNER) {
      carried.owners.set(id, stint);
    } else if (kind === EVENT_ROAD_BUILT) {
      if (!carried.roads.has(id)) carried.roads.set(id, { built: timeline.eventCommit[i]!, forward: 0, backward: 0 });
    } else if (kind === EVENT_ROAD_LANES) {
      const road = carried.roads.get(id);
      if (road) Object.assign(road, { forward: value, backward: stint });
    } else {
      applyEvent(state, kind, id, value, stint);
    }
  }
}

function encodeRange(
  timeline: ChunkInput,
  snapshot: ChunkSnapshot,
  start: number,
  end: number,
  firstEvent: Uint32Array,
): Uint8Array {
  const from = firstEvent[start]!;
  const to = firstEvent[end]!;
  return encodeChunk({
    firstCommit: start,
    snapshot,
    eventCommit: timeline.eventCommit.slice(from, to),
    eventFile: timeline.eventFile.slice(from, to),
    eventStint: timeline.eventStint.slice(from, to),
    eventKind: timeline.eventKind.slice(from, to),
    eventValue: timeline.eventValue.slice(from, to),
  });
}
