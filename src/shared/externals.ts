/**
 * Geometry and timing of the horizon, the orbital motorway and the External Cities (SPEC §7). Pure functions, shared
 * by the CLI (which decides the horizon and the angles) and the page (which only animates them).
 */

export const EXTERNAL_CITIES_FORMAT_VERSION = 2;

/** Segments the horizon ring is divided into, each carrying its own Lanes. */
export const RING_SEGMENTS = 64;

/** A Highway's travel along the ring: from its village's angle to its City's angle, with the Lanes it carries. */
export interface RingArc {
  from: number;
  to: number;
  lanes: number;
}

/**
 * The Lanes on each ring segment: the sum of the Lanes of every arc whose shorter way round passes over the segment.
 * A segment that no arc crosses still keeps 1 Lane each way (SPEC §7).
 */
export function ringLanesOf(arcs: readonly RingArc[], segments: number = RING_SEGMENTS): number[] {
  const tau = 2 * Math.PI;
  const step = tau / segments;
  const lanes = new Array<number>(segments).fill(0);
  for (const arc of arcs) {
    // The signed shorter way from `from` to `to`, in (-π, π].
    let travel = ((arc.to - arc.from) % tau + tau) % tau;
    if (travel > Math.PI) travel -= tau;
    for (let i = 0; i < segments; i++) {
      // Offset of the segment's middle from the arc's start, wrapped into (-π, π].
      let offset = ((i + 0.5) * step - arc.from) % tau;
      offset = ((offset % tau) + tau) % tau;
      if (offset > Math.PI) offset -= tau;
      const covered = travel >= 0 ? offset >= 0 && offset <= travel : offset <= 0 && offset >= travel;
      if (covered) lanes[i]! += arc.lanes;
    }
  }
  return lanes.map((n) => Math.max(1, n));
}

/** One External City (or the Outskirts) as the output lists it. */
export interface CityEntry {
  name: string;
  /** Index in NAME_SOURCES (generated, real, pseudonym). */
  source: number;
  /** Spur angle from the City centre, in radians. */
  angle: number;
  /** Step the City arrives (promotion). */
  from: number;
  /** Step the City departs, or null while it stands. */
  to: number | null;
  members: number;
  /** True for the Outskirts, the single low sprawl that holds every small group. */
  outskirts: boolean;
}

/** One Highway: from its declaring District (or the City centre) to its City, built and dismantled over Steps. */
export interface HighwayEntry {
  /** Index into `cities`. */
  city: number;
  /** Index of the declaring District's village in the layout, or -1 for the root manifest's road from the City centre. */
  district: number;
  from: number;
  to: number | null;
  lanes: number;
}

/** The externals.json file: the horizon, the Cities, and the Highways. */
export interface ExternalCitiesFile {
  formatVersion: number;
  /** Distance of the horizon ring from the centre, in Block units. */
  horizon: number;
  cities: CityEntry[];
  highways: HighwayEntry[];
  /** Lanes on each of the ring's RING_SEGMENTS segments, in order from the +x axis. */
  ring: number[];
}

/**
 * Reads externals.json, refusing a file from another format version or one with the wrong shape. Throws when it cannot
 * be used, so the page can say so instead of drawing a broken City.
 */
export function parseExternalCities(text: string): ExternalCitiesFile {
  const file = JSON.parse(text) as Partial<ExternalCitiesFile>;
  if (file.formatVersion !== EXTERNAL_CITIES_FORMAT_VERSION) throw new Error(`externals.json is format ${file.formatVersion}, expected ${EXTERNAL_CITIES_FORMAT_VERSION}`);
  if (typeof file.horizon !== "number" || !Array.isArray(file.cities) || !Array.isArray(file.highways) || !Array.isArray(file.ring)) {
    throw new Error("externals.json does not have the expected shape");
  }
  return file as ExternalCitiesFile;
}

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
