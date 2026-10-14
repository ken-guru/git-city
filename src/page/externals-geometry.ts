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
  cities: CityGeometry[];
  highways: HighwayGeometry[];
}

/** How far beyond the ring an External City stands, in Block widths. */
export const CITY_BEYOND_RING_BLOCKS = 3;

/**
 * The geometry of the horizon, the City spurs and the Highways. `villages` are the village centres in Block widths, and
 * `blockWorld` converts Block widths to world units.
 */
export function externalsGeometry(file: ExternalCitiesFile, villages: readonly Point[], blockWorld: number): ExternalsGeometry {
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
    const start = village === undefined ? { x: 0, z: 0 } : { x: village.x * blockWorld, z: village.z * blockWorld };
    return {
      start,
      end: onRing(file.cities[h.city]!.angle, ring),
      city: h.city,
      from: h.from,
      to: h.to,
      lanes: h.lanes,
    };
  });
  return { ring, cities, highways };
}
