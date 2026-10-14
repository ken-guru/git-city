import { type Chunk, EVENT_ADD } from "../shared/format.js";

/**
 * Time is measured in commits: commit i's changes begin at t = i.
 * Every visual property is a pure function of t, so play, pause and scrub need no extra logic.
 */

/** Tuning value: how many commits a box takes to grow in or shrink out. */
export const TRANSITION_COMMITS = 1;

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;

function progress(start: number, t: number): number {
  return Math.min(1, Math.max(0, (t - start) / TRANSITION_COMMITS));
}

/** Height scale of a box, from 0 (absent) to 1 (standing), at time `t`. */
export function scaleAt(birth: number, death: number, t: number): number {
  return easeOutCubic(progress(birth, t)) * (1 - easeOutCubic(progress(death, t)));
}

/** Commit of each file's add and delete; -Infinity for files already standing, Infinity for files never deleted. */
export function lifetimes(chunk: Chunk, fileCount: number): { birth: Float64Array; death: Float64Array } {
  const birth = new Float64Array(fileCount).fill(Infinity);
  const death = new Float64Array(fileCount).fill(Infinity);
  for (const file of chunk.snapshot) birth[file] = -Infinity;
  chunk.eventFile.forEach((file, i) => {
    (chunk.eventKind[i] === EVENT_ADD ? birth : death)[file] = chunk.eventCommit[i]!;
  });
  return { birth, death };
}

/** Columns of a square grid big enough for every file the Timeline ever holds. */
export function gridColumns(fileCount: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(fileCount)));
}

/** A file's fixed spot on the grid. Stand-in for Lots until the layout ticket places them in the CLI. */
export function gridSlot(file: number, columns: number): { column: number; row: number } {
  return { column: file % columns, row: Math.floor(file / columns) };
}
