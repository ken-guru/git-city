import {
  type Chunk,
  EVENT_ADD,
  EVENT_BLOCK_OWNER,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_LANGUAGE,
  EVENT_RELOCATE,
  EVENT_RENOVATE,
  EVENT_ROAD_BUILT,
  EVENT_ROAD_LANES,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
} from "../shared/format.js";

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

export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
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
export function latestAt<T extends { start: number }>(list: readonly T[], t: number): T | undefined {
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
/**
 * A Block's owner from `start` on: the District (birth index) that owns it, and the one it had before (-1 when it
 * had none, as at its claim). Its paving eases from one colour to the other over D.
 */
export interface OwnerSegment {
  start: number;
  owner: number;
  from: number;
}

/** A Road's Lanes from `start` on, easing from the previous Lanes (`from*`) to the new ones (`to*`) over D. */
export interface LaneSegment {
  start: number;
  fromForward: number;
  fromBackward: number;
  forward: number;
  backward: number;
}

/** A Road's segments: the commit it was built at, and its Lanes over time. */
export interface RoadSegments {
  built: number;
  lanes: LaneSegment[];
}

export interface Timelines {
  buildings: BuildingSegment[][];
  scaffolds: ScaffoldSegment[][];
  languages: LanguageSegment[][];
  /** Per Block id: its owner over time. A Block has one from the commit it is claimed. */
  owners: Map<number, OwnerSegment[]>;
  /** Per Road id: when it was built, and its Lanes over time. */
  roads: Map<number, RoadSegments>;
}

/**
 * Adds a chunk's segments after the ones already held. Chunks must come in commit order, so each Stint's
 * segments stay sorted for `latestAt`.
 */
export function appendTimelines(target: Timelines, chunk: Chunk, birthLanguage?: Uint8Array): void {
  const part = buildTimelines(chunk, target.buildings.length, birthLanguage);
  part.buildings.forEach((segments, stint) => {
    for (const segment of segments) target.buildings[stint]!.push(segment);
  });
  part.scaffolds.forEach((segments, stint) => {
    for (const segment of segments) target.scaffolds[stint]!.push(segment);
  });
  part.languages.forEach((segments, stint) => {
    for (const segment of segments) target.languages[stint]!.push(segment);
  });
  for (const [block, segments] of part.owners) {
    const held = target.owners.get(block) ?? [];
    for (const segment of segments) held.push(segment);
    target.owners.set(block, held);
  }
  for (const [road, segments] of part.roads) {
    const held = target.roads.get(road);
    if (!held) {
      target.roads.set(road, segments);
      continue;
    }
    for (const lane of segments.lanes) held.lanes.push(lane);
  }
}

/**
 * Builds every Stint's segments from one chunk. A Stint is one occupancy of a Lot (see the Stint table in
 * format.ts). A Relocation takes the old Stint down on its old Lot as the new one is built on the new Lot, both
 * starting together. A Renovation takes the old Stint down first, and builds the new type one base duration later.
 * `birthLanguage` gives each file's language when it was born: an ADD starts the file's language from it.
 */
export function buildTimelines(chunk: Chunk, stintCount: number, birthLanguage?: Uint8Array): Timelines {
  const buildings: BuildingSegment[][] = Array.from({ length: stintCount }, () => []);
  const scaffolds: ScaffoldSegment[][] = Array.from({ length: stintCount }, () => []);
  const languages: LanguageSegment[][] = Array.from({ length: stintCount }, () => []);
  const owners = new Map<number, OwnerSegment[]>();
  const roads = new Map<number, RoadSegments>();
  // What the chunk knows of each file: its Floors, language and current Stint.
  const floorsNow = new Map<number, number>();
  const languageNow = new Map<number, number>();
  const stintNow = new Map<number, number>();

  // Files standing at the chunk's start hold their snapshot Floors, scaffolding and language from its first commit.
  // A chunk loads on its own, so these segments start where the chunk does and sort ahead of its events.
  const { snapshot } = chunk;
  snapshot.file.forEach((file, i) => {
    const stint = snapshot.stint[i]!;
    const floors = snapshot.floors[i]!;
    const language = snapshot.language[i]!;
    buildings[stint]!.push({ start: chunk.firstCommit, kind: KIND_CHANGE, from: floors, to: floors });
    if (snapshot.scaffolded[i]) scaffolds[stint]!.push({ start: chunk.firstCommit, up: true });
    languages[stint]!.push({ start: chunk.firstCommit, from: language, to: language });
    floorsNow.set(file, floors);
    languageNow.set(file, language);
    stintNow.set(file, stint);
  });
  snapshot.blockIds.forEach((block, i) => {
    const owner = snapshot.blockDistricts[i]!;
    owners.set(block, [{ start: chunk.firstCommit, owner, from: owner }]);
  });
  snapshot.roadIds.forEach((road, i) => {
    const forward = snapshot.roadForward[i]!;
    const backward = snapshot.roadBackward[i]!;
    const lane = { start: chunk.firstCommit, fromForward: forward, fromBackward: backward, forward, backward };
    roads.set(road, { built: snapshot.roadBuilt[i]!, lanes: [lane] });
  });

  chunk.eventFile.forEach((file, i) => {
    const start = chunk.eventCommit[i]!;
    const value = chunk.eventValue[i]!;
    const stint = chunk.eventStint[i]!;
    const kind = chunk.eventKind[i];
    // The layout's and the Road history's events name Blocks and Roads, not files: they carry no Building state.
    if (kind === EVENT_BLOCK_OWNER) {
      const held = owners.get(file) ?? [];
      const previous = held[held.length - 1]?.owner ?? -1;
      held.push({ start, owner: stint, from: previous });
      owners.set(file, held);
      return;
    }
    if (kind === EVENT_ROAD_BUILT) {
      if (!roads.has(file)) roads.set(file, { built: start, lanes: [] });
      return;
    }
    if (kind === EVENT_ROAD_LANES) {
      const road = roads.get(file) ?? { built: start, lanes: [] };
      roads.set(file, road);
      const last = road.lanes[road.lanes.length - 1];
      const fromForward = last?.forward ?? 0;
      const fromBackward = last?.backward ?? 0;
      road.lanes.push({ start, fromForward, fromBackward, forward: value, backward: stint });
      return;
    }
    const list = buildings[stint]!;
    switch (kind) {
      case EVENT_ADD: {
        list.push({ start, kind: KIND_BUILD, from: 0, to: value });
        floorsNow.set(file, value);
        stintNow.set(file, stint);
        const birth = birthLanguage?.[file];
        if (birth !== undefined) {
          languageNow.set(file, birth);
          languages[stint]!.push({ start, from: birth, to: birth });
        }
        break;
      }
      case EVENT_RELOCATE:
      case EVENT_RENOVATE: {
        const old = stintNow.get(file);
        if (old !== undefined) {
          const from = displayedFloors(latestAt(buildings[old]!, start)!, start);
          buildings[old]!.push({ start, kind: KIND_DEMOLISH, from, to: 0 });
        }
        // A Renovation comes down first, so the new type starts one base duration later.
        const built = start + (kind === EVENT_RENOVATE ? TRANSITION_COMMITS : 0);
        buildings[stint]!.push({ start: built, kind: KIND_BUILD, from: 0, to: floorsNow.get(file) ?? 0 });
        const language = languageNow.get(file);
        if (language !== undefined) languages[stint]!.push({ start: built, from: language, to: language });
        stintNow.set(file, stint);
        break;
      }
      case EVENT_FLOORS: {
        const from = displayedFloors(latestAt(list, start)!, start);
        list.push({ start, kind: KIND_CHANGE, from, to: value });
        floorsNow.set(file, value);
        break;
      }
      case EVENT_DELETE: {
        const from = displayedFloors(latestAt(list, start)!, start);
        list.push({ start, kind: KIND_DEMOLISH, from, to: 0 });
        break;
      }
      case EVENT_SCAFFOLD_ON:
        scaffolds[stint]!.push({ start, up: true });
        break;
      case EVENT_SCAFFOLD_OFF:
        scaffolds[stint]!.push({ start, up: false });
        break;
      case EVENT_LANGUAGE: {
        // A file's language is known from its snapshot or birth; without either, the colour changes at once.
        const from = languageNow.get(file) ?? birthLanguage?.[file] ?? value;
        languages[stint]!.push({ start, from, to: value });
        languageNow.set(file, value);
        break;
      }
    }
  });
  return { buildings, scaffolds, languages, owners, roads };
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
