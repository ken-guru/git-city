/**
 * The camera's decisions, as plain functions of the City's state: which cluster playback follows, which
 * Districts the showcase shows and where each postcard stands, and who holds the camera at any moment.
 * Main draws what these return; nothing here touches three.js, so the rules can be tested headlessly.
 *
 * A "cluster" is a District: the standing Buildings whose Block that District owns (SPEC §11, Camera).
 */
import { type Spot } from "./lots.js";
import { buildingPose, type BuildingSegment, KIND_CHANGE, KIND_DEMOLISH } from "./state.js";
import { FLOOR_HEIGHT, FOUNDATION_HEIGHT } from "./buildings.js";

/** Playback follows the cluster with the most changes in this many commits. */
export const FOLLOW_WINDOW = 15;
/** The camera switches to another cluster only when it is this many times busier. */
export const FOLLOW_RATIO = 1.5;
/** The showcase ranks Districts by changes in this many commits. */
export const SHOWCASE_WINDOW = 120;
/** A postcard shows only a cluster with at least this many standing Buildings. */
export const SHOWCASE_MIN_BUILDINGS = 4;
/** The showcase shows this many postcards after the establishing shot. */
export const SHOWCASE_CLUSTERS = 6;
/** Idle time before the viewer's hand-over ends, and before the showcase starts. */
export const IDLE_SECONDS = 12;
/** How long each shot is held. */
export const SHOT_SECONDS = 7;
/** The camera's distance from its aim at the end of a postcard, as a share of the start (a slow push-in). */
export const PUSH_IN = 0.92;

/** What one Stint of a Building needs from the timelines and the layout. */
export interface StintInput {
  segments: readonly BuildingSegment[];
  /** Where the Stint stands, or undefined when it has no Lot. */
  spot: Spot | undefined;
  /** The Block its Lot is in. */
  block: number;
}

/** One drawn Building at a commit: its cluster, place, height, whether it stands, and its recent changes. */
export interface BuildingFact {
  cluster: number;
  x: number;
  z: number;
  height: number;
  standing: boolean;
  changes: number;
}

export interface ClusterSummary {
  cluster: number;
  /** Changes in the window, over every Building the cluster owns. */
  changes: number;
  /** Standing Buildings. */
  standing: number;
  /** The centre of the standing Buildings, on the ground. */
  x: number;
  z: number;
  /** About Building height: the mean roof height of the standing Buildings. */
  aimY: number;
  /** The distance from the centre to the furthest standing Building's middle. */
  radius: number;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Frame {
  aim: Vector3;
  position: Vector3;
}

export interface Postcard {
  cluster: number;
  name: string;
  summary: ClusterSummary;
}

export type CameraMode = "free" | "follow" | "showcase";

export interface PlaybackState {
  playing: boolean;
  /** At the latest commit. */
  atLatest: boolean;
  /** Every chunk of history has loaded. */
  loaded: boolean;
}

/** A change is a Building event that moved it: a build, a relocation, a Floors change, a demolition. A snapshot's own state is not one. */
function isChange(segment: BuildingSegment): boolean {
  return !(segment.kind === KIND_CHANGE && segment.from === segment.to);
}

/** Changes that start in the `window` commits up to and including `t`. Segments are in commit order, so the scan starts at the latest. */
export function countChanges(segments: readonly BuildingSegment[], t: number, window: number): number {
  let count = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (segment.start > t) continue;
    if (segment.start <= t - window) break;
    if (isChange(segment)) count++;
  }
  return count;
}

/** Each Stint with a Lot, at commit `t`, with the cluster that owns its Block (undefined when none does). */
export function buildingFacts(
  stints: readonly StintInput[],
  ownerOf: (block: number, t: number) => number | undefined,
  t: number,
  duration: number,
  window: number,
): BuildingFact[] {
  const facts: BuildingFact[] = [];
  for (const stint of stints) {
    if (!stint.spot) continue;
    const cluster = ownerOf(stint.block, t);
    if (cluster === undefined || cluster < 0) continue;
    const pose = buildingPose(stint.segments, t, duration);
    facts.push({
      cluster,
      x: stint.spot.x,
      z: stint.spot.z,
      height: FOUNDATION_HEIGHT + pose.to * FLOOR_HEIGHT,
      standing: pose.visible && pose.kind !== KIND_DEMOLISH,
      changes: countChanges(stint.segments, t, window),
    });
  }
  return facts;
}

/** The clusters' changes, standing Buildings and where they stand. A cluster with none standing is placed over all its Buildings. */
export function summarise(facts: readonly BuildingFact[]): Map<number, ClusterSummary> {
  const byCluster = new Map<number, BuildingFact[]>();
  for (const fact of facts) {
    const list = byCluster.get(fact.cluster) ?? [];
    list.push(fact);
    byCluster.set(fact.cluster, list);
  }
  const summaries = new Map<number, ClusterSummary>();
  for (const [cluster, list] of byCluster) {
    const standing = list.filter((f) => f.standing);
    const pool = standing.length > 0 ? standing : list;
    const x = pool.reduce((sum, f) => sum + f.x, 0) / pool.length;
    const z = pool.reduce((sum, f) => sum + f.z, 0) / pool.length;
    const aimY = standing.length > 0 ? standing.reduce((sum, f) => sum + f.height, 0) / standing.length : 0;
    let radius = 0;
    for (const f of pool) radius = Math.max(radius, Math.hypot(f.x - x, f.height / 2 - aimY, f.z - z));
    summaries.set(cluster, {
      cluster,
      changes: list.reduce((sum, f) => sum + f.changes, 0),
      standing: standing.length,
      x,
      z,
      aimY,
      radius,
    });
  }
  return summaries;
}

/** The busiest first: most changes, then most standing Buildings, then the lower cluster id. */
function busiestFirst(a: ClusterSummary, b: ClusterSummary): number {
  return b.changes - a.changes || b.standing - a.standing || a.cluster - b.cluster;
}

/**
 * The cluster playback follows. It keeps `current` unless the busiest cluster has at least FOLLOW_RATIO times its changes;
 * with no focus yet it takes the busiest one, and with no changes at all it keeps what it has.
 */
export function chooseFocus(summaries: readonly ClusterSummary[], current: number | undefined): number | undefined {
  const best = [...summaries].sort(busiestFirst)[0];
  if (!best || best.changes === 0) return current;
  if (current === undefined) return best.cluster;
  if (best.cluster === current) return current;
  const held = summaries.find((s) => s.cluster === current)?.changes ?? 0;
  return best.changes >= FOLLOW_RATIO * held ? best.cluster : current;
}

/** The Districts for the showcase: at least SHOWCASE_MIN_BUILDINGS standing and a display name, busiest first, up to SHOWCASE_CLUSTERS. */
export function showcasePlan(summaries: readonly ClusterSummary[], nameOf: (cluster: number) => string | undefined): Postcard[] {
  const plan: Postcard[] = [];
  for (const summary of [...summaries].sort(busiestFirst)) {
    if (plan.length >= SHOWCASE_CLUSTERS) break;
    const name = nameOf(summary.cluster);
    if (summary.standing < SHOWCASE_MIN_BUILDINGS || name === undefined) continue;
    plan.push({ cluster: summary.cluster, name, summary });
  }
  return plan;
}

/**
 * The postcard framing of a cluster: aim at its centre at Building height, from height 1.5 + 0.15 R,
 * set back 1.6 R + 5 on the side facing the land's centre.
 */
export function frameFor(summary: ClusterSummary, land: { x: number; z: number }): Frame {
  const r = summary.radius;
  let dx = land.x - summary.x;
  let dz = land.z - summary.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) {
    dx = 0;
    dz = 1;
  } else {
    dx /= length;
    dz /= length;
  }
  const setback = 1.6 * r + 5;
  return {
    aim: { x: summary.x, y: summary.aimY, z: summary.z },
    position: { x: summary.x + dx * setback, y: 1.5 + 0.15 * r, z: summary.z + dz * setback },
  };
}

/** The camera's place within a postcard at `progress` (0 to 1): a slow push-in towards the aim. Reduced motion holds the start. */
export function shotPose(frame: Frame, progress: number, reducedMotion: boolean): Vector3 {
  const share = reducedMotion ? 0 : Math.min(1, Math.max(0, progress));
  const scale = 1 + (PUSH_IN - 1) * share;
  return {
    x: frame.aim.x + (frame.position.x - frame.aim.x) * scale,
    y: frame.position.y,
    z: frame.aim.z + (frame.position.z - frame.aim.z) * scale,
  };
}

/** Which shot of the showcase is on screen, after `elapsed` seconds: 0 is the establishing shot, then each postcard in turn. */
export function shotAt(elapsed: number, shotCount: number, reducedMotion: boolean): { shot: number; progress: number } {
  const count = Math.max(1, shotCount);
  const shot = Math.floor(elapsed / SHOT_SECONDS) % count;
  const progress = reducedMotion ? 0 : (elapsed % SHOT_SECONDS) / SHOT_SECONDS;
  return { shot, progress };
}

/** Eases a value towards its goal each frame; reduced motion jumps. */
export function easeToward(value: number, goal: number, dt: number, reducedMotion: boolean): number {
  if (reducedMotion) return goal;
  return value + (goal - value) * (1 - Math.exp(-4 * dt));
}

/**
 * Who holds the camera. Any input hands it to the viewer: following waits IDLE_SECONDS after the last input, and the
 * showcase starts IDLE_SECONDS after the viewer was last quiet at the latest commit, with history loaded and playback stopped.
 * Times are in seconds.
 */
export class CameraDirector {
  followOn: boolean;
  private lastInput = Number.NEGATIVE_INFINITY;
  private quietSince = 0;

  constructor(followOn: boolean) {
    this.followOn = followOn;
  }

  noteInput(now: number): void {
    this.lastInput = now;
    this.quietSince = now;
  }

  mode(now: number, state: PlaybackState): CameraMode {
    const showcaseReady = state.atLatest && state.loaded && !state.playing;
    if (!showcaseReady) this.quietSince = now;
    if (state.playing) return this.followOn && now - this.lastInput >= IDLE_SECONDS ? "follow" : "free";
    return showcaseReady && now >= this.quietSince + IDLE_SECONDS ? "showcase" : "free";
  }

  /** Seconds into the showcase, once it has started. */
  showcaseTime(now: number): number {
    return Math.max(0, now - (this.quietSince + IDLE_SECONDS));
  }
}
