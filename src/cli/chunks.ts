import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { type ChunkSnapshot, CHUNK_HASH_BYTES, chunkName, encodeChunk } from "../shared/format.js";
import { applyEvent, birthStates, type FileStates } from "../shared/replay.js";
import type { TimelineData } from "./timeline.js";

/** A new chunk starts after this many commits (SPEC §9). */
export const CHUNK_COMMITS = 2000;
/** ...or once a chunk compresses to about this many bytes (SPEC §9). */
export const CHUNK_BYTES = 256 * 1024;
/** The compressed size is checked at this many commits apart, so a chunk can run this far past CHUNK_BYTES. */
export const CHECK_EVERY = 100;
/** The world file plus the first chunk, compressed, must fit this (SPEC §9 budget). */
export const FIRST_PLAY_BUDGET_BYTES = 1024 * 1024;
/** Everything except the bundle, compressed (SPEC §9 budget). */
export const TOTAL_BUDGET_BYTES = 15 * 1024 * 1024;

export type ChunkInput = Pick<
  TimelineData,
  "commitDays" | "fileCount" | "buildingType" | "language" | "eventCommit" | "eventFile" | "eventKind" | "eventValue"
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

  const plans: PlannedChunk[] = [];
  let start = 0;
  do {
    const snapshot = snapshotOf(state);
    let end = start;
    let bytes: Uint8Array;
    for (;;) {
      end = Math.min(commits, end + checkEvery, start + chunkCommits);
      bytes = encodeRange(timeline, snapshot, start, end, firstEvent);
      if (end === commits || end - start === chunkCommits) break;
      if (deflateSync(bytes).length >= chunkBytes) break;
    }
    plans.push({
      firstCommit: start,
      bytes,
      hash: createHash("sha256").update(bytes).digest().subarray(0, CHUNK_HASH_BYTES),
      compressedBytes: deflateSync(bytes).length,
    });
    applyEvents(state, timeline, firstEvent[start]!, firstEvent[end]!);
    start = end;
  } while (start < commits);
  return plans;
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

function snapshotOf(state: FileStates): ChunkSnapshot {
  const standing: number[] = [];
  for (let file = 0; file < state.standing.length; file++) if (state.standing[file]) standing.push(file);
  return {
    file: Uint32Array.from(standing),
    floors: Uint8Array.from(standing, (f) => state.floors[f]!),
    scaffolded: Uint8Array.from(standing, (f) => state.scaffolded[f]!),
    buildingType: Uint8Array.from(standing, (f) => state.buildingType[f]!),
    language: Uint8Array.from(standing, (f) => state.language[f]!),
  };
}

/** Advances the state through the events from index `from` up to `to`. */
function applyEvents(state: FileStates, timeline: ChunkInput, from: number, to: number): void {
  for (let i = from; i < to; i++) applyEvent(state, timeline.eventKind[i]!, timeline.eventFile[i]!, timeline.eventValue[i]!);
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
    eventKind: timeline.eventKind.slice(from, to),
    eventValue: timeline.eventValue.slice(from, to),
  });
}
