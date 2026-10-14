/**
 * Geometry and timing of the horizon, the orbital motorway and the External Cities (SPEC §7). Pure functions, shared
 * by the CLI (which decides the horizon and the angles) and the page (which only animates them).
 */

/** Steps an External City takes to fade in or out. */
export const CITY_FADE_STEPS = 1;
/** Steps a Highway takes to be built, or dismantled. */
export const HIGHWAY_BUILD_STEPS = 2;
/** The smallest angle between two External Cities' spurs, in radians. */
export const MIN_SPUR_GAP = 0.18;

/**
 * The horizon ring's radius, in Block units, from the City's extent (the distance of its furthest village from the
 * centre). Monotone in the extent: villages never move, so the ring only ever moves outward as the City grows.
 */
export function horizonRadius(extent: number): number {
  return Math.ceil(1.25 * Math.max(0, extent) + 12);
}

/**
 * Spur angles for External Cities that want the given angles. Each keeps its own angle unless it would sit closer than
 * the gap to the one before it, in which case it is pushed forward. Returns the angles in the order given.
 */
export function placeAngles(desired: readonly number[]): number[] {
  const tau = 2 * Math.PI;
  const n = desired.length;
  if (n === 0) return [];
  const gap = Math.min(MIN_SPUR_GAP, tau / n);
  const order = desired.map((angle, index) => ({ index, angle: ((angle % tau) + tau) % tau })).sort((a, b) => a.angle - b.angle);
  const placed = new Array<number>(n);
  let previous = -Infinity;
  for (const { index, angle } of order) {
    const at = Math.max(angle, previous + gap);
    placed[index] = at;
    previous = at;
  }
  return placed;
}

/** Eases a 0-to-1 value in and out. */
export function ease(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** Progress from `start` to `end` at time `t`, eased, and clamped to 0..1. A zero-length span is a step at `start`. */
export function progressBetween(t: number, start: number, end: number): number {
  if (end <= start) return t >= start ? 1 : 0;
  return ease((t - start) / (end - start));
}

/**
 * How far a Highway is built at time `t`: built outward from `from` over HIGHWAY_BUILD_STEPS, and dismantled over the
 * same time from `to` when it has one. 0 before it exists, 1 while it stands.
 */
export function highwayVisibility(t: number, from: number, to: number | null): number {
  const built = progressBetween(t, from, from + HIGHWAY_BUILD_STEPS);
  const dismantled = to === null ? 0 : progressBetween(t, to, to + HIGHWAY_BUILD_STEPS);
  return Math.max(0, built - dismantled);
}

/**
 * How visible an External City is at time `t`. It fades in from `from`; once its last Highway is dismantled, which is
 * HIGHWAY_BUILD_STEPS after its departure `to`, it fades out over CITY_FADE_STEPS.
 */
export function cityVisibility(t: number, from: number, to: number | null): number {
  const arrived = progressBetween(t, from, from + CITY_FADE_STEPS);
  const departed = to === null ? 0 : progressBetween(t, to + HIGHWAY_BUILD_STEPS, to + HIGHWAY_BUILD_STEPS + CITY_FADE_STEPS);
  return Math.max(0, arrived - departed);
}
