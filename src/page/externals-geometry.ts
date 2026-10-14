import { type ExternalCitiesFile } from "../shared/externals.js";

/**
 * Where the horizon, the orbital motorway's access Highways, the spurs and the External Cities stand in the page's world
 * (SPEC §7). Pure: no three.js here, so the layout can be tested without a browser. The CLI decides every value; this
 * only turns Block units into world units and works out the ends of each piece.
 */

export interface Point {
  x: number;
  z: number;
}

export interface HighwayGeometry {
  /** The District's village, or the City centre for the root manifest's road. */
  start: Point;
  /** Where the Highway meets the horizon ring, at its City's angle. */
  end: Point;
  city: number;
  from: number;
  to: number | null;
  lanes: number;
  /** The stretches of the Highway that cross water or a steep hill, as fractions of its length. */
  bridges: BridgeRun[];
}

/** A stretch of a Highway that is carried on a bridge: from and to are fractions of its length, 0 to 1. */
export interface BridgeRun {
  from: number;
  to: number;
}

/** Height of a bridge deck above the ground, in world units (the same deck height as the Village Roads). */
export const BRIDGE_HEIGHT = 0.45;
/** Points sampled along a Highway to find where it crosses water or steep ground. */
export const BRIDGE_SAMPLES = 48;
/** A height change over one Block between neighbouring cells that counts as steep ground. A tuning value. */
export const STEEP_STEP = 0.5;

/** The terrain the bridge rule reads, in Block cells: the Countryside's level and height. */
export interface Terrain {
  levelAt(col: number, row: number): "river" | "hill" | "flat";
  heightAt(col: number, row: number): number;
}

/** Whether the ground at a Block cell needs a bridge: a river, or ground that falls away steeply to a neighbour. */
export function needsBridge(terrain: Terrain, col: number, row: number): boolean {
  if (terrain.levelAt(col, row) === "river") return true;
  const height = terrain.heightAt(col, row);
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dc, dr]) => Math.abs(terrain.heightAt(col + dc!, row + dr!) - height) > STEEP_STEP);
}

/**
 * The stretches of the straight Highway from `start` to `end` where `crosses` (given a world position) is true, sampled
 * at `samples` steps. A run is the span from its first crossed sample to just past its last one, capped at the end.
 */
export function bridgeRuns(start: Point, end: Point, crosses: (x: number, z: number) => boolean, samples: number = BRIDGE_SAMPLES): BridgeRun[] {
  const flags = Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    return crosses(start.x + (end.x - start.x) * t, start.z + (end.z - start.z) * t);
  });
  const runs: BridgeRun[] = [];
  let open: number | undefined;
  for (let i = 0; i <= samples; i++) {
    if (flags[i] && open === undefined) open = i;
    if (!flags[i] && open !== undefined) {
      runs.push({ from: open / samples, to: Math.min(1, i / samples) });
      open = undefined;
    }
  }
  if (open !== undefined) runs.push({ from: open / samples, to: 1 });
  return runs;
}

export interface CityGeometry {
  name: string;
  outskirts: boolean;
  /** The spur from the ring to the City. */
  spurStart: Point;
  spurEnd: Point;
  position: Point;
  height: number;
  from: number;
  to: number | null;
}

export interface ExternalsGeometry {
  /** Radius of the horizon ring, in world units. */
  ring: number;
  /** Lanes on each ring segment, from the CLI. */
  ringLanes: number[];
  cities: CityGeometry[];
  highways: HighwayGeometry[];
}

/** How far beyond the ring an External City stands, in Block widths. */
export const CITY_BEYOND_RING_BLOCKS = 3;

/**
 * The geometry of the horizon, the City spurs and the Highways. `villages` are the village centres in Block widths, and
 * `blockWorld` converts Block widths to world units.
 */
export function externalsGeometry(
  file: ExternalCitiesFile,
  villages: readonly Point[],
  blockWorld: number,
  crosses: (x: number, z: number) => boolean = () => false,
): ExternalsGeometry {
  const ring = file.horizon * blockWorld;
  const onRing = (angle: number, radius: number): Point => ({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
  const cities: CityGeometry[] = file.cities.map((city) => {
    const position = onRing(city.angle, ring + CITY_BEYOND_RING_BLOCKS * blockWorld);
    return {
      name: city.name,
      outskirts: city.outskirts,
      spurStart: onRing(city.angle, ring),
      spurEnd: position,
      position,
      height: city.outskirts ? 2 : 4 + 2 * Math.sqrt(city.members),
      from: city.from,
      to: city.to,
    };
  });
  const highways: HighwayGeometry[] = file.highways.map((h) => {
    const village = h.district >= 0 ? villages[h.district] : undefined;
    // A District's access Highway meets the ring at its village's angle, and the ring carries it on to its City.
    // The root manifest's road leaves from the centre and meets the ring at its City's angle.
    const start = village === undefined ? { x: 0, z: 0 } : { x: village.x * blockWorld, z: village.z * blockWorld };
    const meets = village === undefined ? file.cities[h.city]!.angle : Math.atan2(village.z, village.x);
    const end = onRing(meets, ring);
    return {
      start,
      end,
      city: h.city,
      from: h.from,
      to: h.to,
      lanes: h.lanes,
      bridges: bridgeRuns(start, end, crosses),
    };
  });
  return { ring, ringLanes: file.ring, cities, highways };
}

/** Width of one Lane in world units. */
export const LANE_WIDTH = 0.7;
/** Width of the centre marking, in world units. */
export const MARKING_WIDTH = 0.15;

/** One Lane's band across a road: its lateral offset from the centre line, its width, and its direction of travel. */
export interface LaneBand {
  offset: number;
  width: number;
  direction: 1 | -1;
}

/**
 * The Lanes of a Highway with `lanes` Lanes each way: `lanes` bands on each side of the centre line, packed edge to edge
 * so no Lane overlaps another. More Lanes make a wider road.
 */
export function laneBands(lanes: number): LaneBand[] {
  const count = Math.max(1, Math.floor(lanes));
  const bands: LaneBand[] = [];
  for (const direction of [1, -1] as const) {
    for (let i = 0; i < count; i++) {
      bands.push({ offset: direction * (MARKING_WIDTH / 2 + LANE_WIDTH * (i + 0.5)), width: LANE_WIDTH, direction });
    }
  }
  return bands;
}

/** The total width of a Highway with `lanes` Lanes each way, including the centre marking. */
export function highwayWidth(lanes: number): number {
  return MARKING_WIDTH + 2 * LANE_WIDTH * Math.max(1, Math.floor(lanes));
}
