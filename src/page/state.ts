import { type Chunk, EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_LANGUAGE, EVENT_SCAFFOLD_OFF, EVENT_SCAFFOLD_ON } from "../shared/format.js";

/**
 * Time is measured in commits: commit i's changes begin at t = i.
 * Every visual property is a pure function of t, so play, pause, reverse and scrub need no extra logic.
 * The shader evaluates the same eased curves from one `uTime` uniform; the functions here decide which
 * segment each Building is in, and mirror the shader so tests can check the curves.
 */

/** Base transition length D, in commits (SPEC §11, shared animation timing). */
export const TRANSITION_COMMITS = 4;
/** A transition never lasts less than this much viewing time, at the current speed. */
export const MIN_TRANSITION_SECONDS = 0.25;
/** The share of a build's D spent on the foundation before the first Floor rises. */
export const FOUNDATION_SHARE = 0.25;

export const KIND_NONE = 0;
export const KIND_BUILD = 1;
export const KIND_CHANGE = 2;
export const KIND_DEMOLISH = 3;
export type Kind = typeof KIND_NONE | typeof KIND_BUILD | typeof KIND_CHANGE | typeof KIND_DEMOLISH;

/** A Building's transition that starts at commit `start`. Floors go from `from` to `to`. */
export interface BuildingSegment {
  start: number;
  kind: Kind;
  from: number;
  to: number;
}

/** Scaffolding turning on (`up`) or off at commit `start`. */
export interface ScaffoldSegment {
  start: number;
  up: boolean;
}

/** A language change that starts at commit `start`: the roof and trim colour eases from `from` to `to`. */
export interface LanguageSegment {
  start: number;
  from: number;
  to: number;
}

export interface BuildingPose {
  kind: Kind;
  start: number;
  from: number;
  to: number;
  /** False when the Lot is empty: the instance collapses entirely. */
  visible: boolean;
}

export interface ScaffoldPose {
  start: number;
  /** 0 when the scaffolding is down, 1 when it is up; the shader eases between them. */
  from: number;
  to: number;
  height: number;
  visible: boolean;
}

const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The speed-dependent transition length: D, or 0.25 s of viewing time at this speed if that is longer. */
export function durationFor(commitsPerSecond: number): number {
  return Math.max(TRANSITION_COMMITS, MIN_TRANSITION_SECONDS * commitsPerSecond);
}

/** Floors on screen at time `t` for one segment (mirrors the shader). */
export function displayedFloors(segment: BuildingSegment, t: number, duration: number = TRANSITION_COMMITS): number {
  const p = clamp01((t - segment.start) / duration);
  switch (segment.kind) {
    case KIND_BUILD:
      return segment.to * easeOutCubic(clamp01((p - FOUNDATION_SHARE) / (1 - FOUNDATION_SHARE)));
    case KIND_CHANGE:
      return segment.from + (segment.to - segment.from) * easeOutCubic(p);
    case KIND_DEMOLISH:
      return segment.from * (1 - easeOutCubic(p));
    default:
      return 0;
  }
}

/** The last item whose start is at or before `t`. The lists are in commit order. */
function latestAt<T extends { start: number }>(list: readonly T[], t: number): T | undefined {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? undefined : list[found];
}

/**
 * Builds the segments of every file from one chunk: a build on add, a change on each Floors event,
 * a demolition on delete, and scaffolding up and down. Each change starts from the Floors on screen at that commit.
 */
export interface Timelines {
  buildings: BuildingSegment[][];
  scaffolds: ScaffoldSegment[][];
  languages: LanguageSegment[][];
}

/**
 * Adds a chunk's segments after the ones already held. Chunks must come in commit order, so each file's
 * segments stay sorted for `latestAt`.
 */
export function appendTimelines(target: Timelines, chunk: Chunk, birthLanguage?: Uint8Array): void {
  const part = buildTimelines(chunk, target.buildings.length, birthLanguage);
  part.buildings.forEach((segments, file) => {
    for (const segment of segments) target.buildings[file]!.push(segment);
  });
  part.scaffolds.forEach((segments, file) => {
    for (const segment of segments) target.scaffolds[file]!.push(segment);
  });
  part.languages.forEach((segments, file) => {
    for (const segment of segments) target.languages[file]!.push(segment);
  });
}

/**
 * Builds every file's segments from one chunk. `birthLanguage` gives each file's language when it was born
 * (the world file's language column): an ADD starts the file's language from it, so its first change eases from there.
 */
export function buildTimelines(chunk: Chunk, fileCount: number, birthLanguage?: Uint8Array): Timelines {
  const buildings: BuildingSegment[][] = Array.from({ length: fileCount }, () => []);
  const scaffolds: ScaffoldSegment[][] = Array.from({ length: fileCount }, () => []);
  const languages: LanguageSegment[][] = Array.from({ length: fileCount }, () => []);
  // The language each file has now, or undefined when the chunk has not said yet.
  const language: (number | undefined)[] = new Array(fileCount).fill(undefined);
  // Files standing at the chunk's start hold their snapshot Floors and scaffolding from its first commit.
  // A chunk loads on its own, so these segments start where the chunk does and sort ahead of its events.
  const { snapshot } = chunk;
  snapshot.file.forEach((file, i) => {
    const floors = snapshot.floors[i]!;
    buildings[file]!.push({ start: chunk.firstCommit, kind: KIND_CHANGE, from: floors, to: floors });
    if (snapshot.scaffolded[i]) scaffolds[file]!.push({ start: chunk.firstCommit, up: true });
    languages[file]!.push({ start: chunk.firstCommit, from: snapshot.language[i]!, to: snapshot.language[i]! });
    language[file] = snapshot.language[i];
  });

  chunk.eventFile.forEach((file, i) => {
    const start = chunk.eventCommit[i]!;
    const value = chunk.eventValue[i]!;
    const list = buildings[file]!;
    switch (chunk.eventKind[i]) {
      case EVENT_ADD:
        list.push({ start, kind: KIND_BUILD, from: 0, to: value });
        language[file] = birthLanguage?.[file];
        break;
      case EVENT_FLOORS: {
        const from = displayedFloors(latestAt(list, start)!, start);
        list.push({ start, kind: KIND_CHANGE, from, to: value });
        break;
      }
      case EVENT_DELETE: {
        const from = displayedFloors(latestAt(list, start)!, start);
        list.push({ start, kind: KIND_DEMOLISH, from, to: 0 });
        break;
      }
      case EVENT_SCAFFOLD_ON:
        scaffolds[file]!.push({ start, up: true });
        break;
      case EVENT_SCAFFOLD_OFF:
        scaffolds[file]!.push({ start, up: false });
        break;
      case EVENT_LANGUAGE: {
        // A file's language is known from its snapshot or birth; without either, the colour changes at once.
        const from = language[file] ?? birthLanguage?.[file] ?? value;
        languages[file]!.push({ start, from, to: value });
        language[file] = value;
        break;
      }
    }
  });
  return { buildings, scaffolds, languages };
}

/**
 * The language colour of a file at time `t`: the segment in force eases from its `from` to its `to` over
 * `duration` commits. `birth` is the language before any segment. Returns the two languages and the eased share.
 */
export function languageAt(
  segments: readonly LanguageSegment[],
  birth: number,
  t: number,
  duration: number = TRANSITION_COMMITS,
): { from: number; to: number; share: number } {
  const segment = latestAt(segments, t);
  if (!segment) return { from: birth, to: birth, share: 1 };
  return { from: segment.from, to: segment.to, share: easeOutCubic(clamp01((t - segment.start) / duration)) };
}

/** Where a Building is at time `t`. A Building whose demolition has finished collapses its Lot. */
export function buildingPose(segments: readonly BuildingSegment[], t: number, duration: number = TRANSITION_COMMITS): BuildingPose {
  const segment = latestAt(segments, t);
  if (!segment || (segment.kind === KIND_DEMOLISH && t >= segment.start + duration)) {
    return { kind: KIND_NONE, start: 0, from: 0, to: 0, visible: false };
  }
  return { kind: segment.kind, start: segment.start, from: segment.from, to: segment.to, visible: true };
}

/** Scaffolding and crane at time `t`: they rise over D/2 and come down over D/2, and only stand on a Building that is there. */
export function scaffoldPose(
  scaffolds: readonly ScaffoldSegment[],
  building: BuildingPose,
  t: number,
  duration: number = TRANSITION_COMMITS,
): ScaffoldPose {
  const segment = latestAt(scaffolds, t);
  const standing = building.visible && building.kind !== KIND_DEMOLISH;
  const up = segment?.up ?? false;
  const visible = standing && segment !== undefined && (segment.up || t < segment.start + duration / 2);
  return {
    start: segment?.start ?? 0,
    from: up ? 0 : 1,
    to: up ? 1 : 0,
    height: building.to,
    visible,
  };
}

/** Columns of a square grid big enough for every file the Timeline ever holds. */
export function gridColumns(fileCount: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(fileCount)));
}

/** A file's fixed spot on the grid. Stand-in for Lots until the layout ticket places them in the CLI. */
export function gridSlot(file: number, columns: number): { column: number; row: number } {
  return { column: file % columns, row: Math.floor(file / columns) };
}
