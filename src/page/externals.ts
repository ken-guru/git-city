import { BoxGeometry, Mesh, MeshLambertMaterial, RingGeometry, type Scene } from "three";
import { cityVisibility, highwayVisibility } from "../shared/externals.js";
import {
  BRIDGE_HEIGHT,
  type CityGeometry,
  type ExternalsGeometry,
  type HighwayGeometry,
  highwayWidth,
  laneBands,
  MARKING_WIDTH,
  type Point,
} from "./externals-geometry.js";

/**
 * The horizon ring, the orbital motorway's access Highways, the spurs and the External Cities, drawn in three.js (SPEC §7).
 * Each piece's visibility and growth come from the CLI's Steps through the shared timing: a Highway is built outward from
 * its village, a City fades in, and departure runs the same in reverse. A Highway is one strip per Lane, so more Lanes make
 * a wider road; the ring is one arc per segment, as wide as the Lanes the CLI counted on it.
 */

const ASPHALT = { light: 0x3d434b, dark: 0x2a2f36 } as const;
const MARKING = 0xf4f4f0;
const HAZE = { light: 0xa9b7c4, dark: 0x5d6b78 } as const;
const SPUR_WIDTH = 1.4;
/** Height of the road surface above the ground, in world units. */
const LIFT = 0.25;
/** Width of a ring segment per Lane, in world units. */
const RING_LANE_WIDTH = 0.7;

/** The ground height at a world position, from the Countryside's terrain. */
export type GroundAt = (x: number, z: number) => number;

/** One mesh of a road, at a lateral offset from its centre line. */
interface Lane {
  mesh: Mesh;
  offset: number;
}

/** A road from `start` along `direction`, built to `length` by scaling its unit boxes along their own axis. */
interface Road {
  lanes: Lane[];
  start: Point;
  direction: Point;
  length: number;
  y: number;
}

/** One strip of a road: its lateral offset from the centre line, its width, and its material. */
interface Band {
  offset: number;
  width: number;
  material: MeshLambertMaterial;
}

/** Makes one box per band of a road (or a single box for a spur), all sharing the road's start and direction. */
function road(scene: Scene, start: Point, end: Point, bands: readonly Band[], ground: GroundAt, height?: number): Road {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz) || 1;
  const lanes = bands.map(({ offset, width, material }) => {
    const mesh = new Mesh(new BoxGeometry(1, 0.2, width), material);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, offset };
  });
  // A bridge deck is carried at its own height; everything else lies on the ground.
  const y = height ?? ground(start.x, start.z) + LIFT;
  return { lanes, start, direction: { x: dx / length, z: dz / length }, length, y };
}

/** A point at fraction `t` along a straight line. */
function pointAlong(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** Grows a road to `fraction` of its length, from its start outward. Each lane keeps its lateral offset. */
function grow(r: Road, fraction: number): void {
  // The lateral direction is the road's direction turned a quarter turn.
  const normal = { x: -r.direction.z, z: r.direction.x };
  const along = (fraction * r.length) / 2;
  for (const { mesh, offset } of r.lanes) {
    mesh.visible = fraction > 0;
    mesh.scale.x = Math.max(fraction * r.length, 0.001);
    mesh.position.set(r.start.x + r.direction.x * along + normal.x * offset, r.y, r.start.z + r.direction.z * along + normal.z * offset);
  }
}

interface HighwayPiece {
  road: Road;
  /** One deck per bridge run, raised over water or a steep hill, built as the Highway is. */
  decks: { road: Road; from: number; to: number }[];
  geometry: HighwayGeometry;
}

interface CityPiece {
  spur: Road;
  body: Mesh;
  material: MeshLambertMaterial;
  geometry: CityGeometry;
}

export class ExternalLayer {
  private readonly highways: HighwayPiece[] = [];
  private readonly cities: CityPiece[] = [];
  private readonly ring: Mesh[] = [];

  constructor(scene: Scene, geometry: ExternalsGeometry, theme: "light" | "dark", ground: GroundAt) {
    const asphalt = new MeshLambertMaterial({ color: ASPHALT[theme] });
    const marking = new MeshLambertMaterial({ color: MARKING });
    const segments = geometry.ringLanes.length;
    const step = (2 * Math.PI) / Math.max(1, segments);
    geometry.ringLanes.forEach((lanes, i) => {
      // RingGeometry sweeps in the XY plane; the ring lies flat with its angle reversed, so segment i spans -(i+1)·step.
      const width = highwayWidth(lanes) * RING_LANE_WIDTH;
      const arc = new Mesh(
        new RingGeometry(geometry.ring - width / 2, geometry.ring + width / 2, 4, 1, -(i + 1) * step, step),
        asphalt,
      );
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = LIFT;
      scene.add(arc);
      this.ring.push(arc);
    });
    for (const h of geometry.highways) {
      const bands: Band[] = laneBands(h.lanes).map((b) => ({ offset: b.offset, width: b.width, material: asphalt }));
      // The centre marking is one more strip, in white, over the middle of the road.
      bands.push({ offset: 0, width: MARKING_WIDTH, material: marking });
      const decks = h.bridges.map((run) => ({
        road: road(scene, pointAlong(h.start, h.end, run.from), pointAlong(h.start, h.end, run.to), bands, ground, BRIDGE_HEIGHT),
        from: run.from,
        to: run.to,
      }));
      this.highways.push({ road: road(scene, h.start, h.end, bands, ground), decks, geometry: h });
    }
    for (const c of geometry.cities) {
      const material = new MeshLambertMaterial({ color: HAZE[theme], transparent: true, opacity: 0 });
      const footprint = c.outskirts ? 14 : 6;
      const body = new Mesh(new BoxGeometry(footprint, c.height, footprint), material);
      body.position.set(c.position.x, ground(c.position.x, c.position.z) + c.height / 2, c.position.z);
      body.visible = false;
      scene.add(body);
      const spur = road(scene, c.spurStart, c.spurEnd, [{ offset: 0, width: SPUR_WIDTH, material: asphalt }], ground);
      this.cities.push({ spur, body, material, geometry: c });
    }
  }

  /** The meshes of each Highway, in the order of the geometry's Highways: one per Lane, then the centre marking. */
  get highwayMeshes(): readonly (readonly Mesh[])[] {
    return this.highways.map((h) => h.road.lanes.map((l) => l.mesh));
  }

  /** The City bodies, in the order of the geometry's Cities. */
  get cityBodies(): readonly Mesh[] {
    return this.cities.map((c) => c.body);
  }

  /** The ring's arc meshes, one per segment, in order. */
  get ringMeshes(): readonly Mesh[] {
    return this.ring;
  }

  /** Draws every piece at time `t` (in Steps). Pure in `t`: scrubbing and reversing need nothing extra. */
  update(t: number): void {
    for (const { road: r, decks, geometry } of this.highways) {
      const built = highwayVisibility(t, geometry.from, geometry.to);
      grow(r, built);
      // A deck is built as the Highway reaches it: a stretch that is not yet reached stays unbuilt.
      for (const deck of decks) {
        const span = deck.to - deck.from;
        const fraction = span <= 0 ? (built >= deck.from ? 1 : 0) : Math.min(1, Math.max(0, (built - deck.from) / span));
        grow(deck.road, fraction);
      }
    }
    for (const { spur, body, material, geometry } of this.cities) {
      const visible = cityVisibility(t, geometry.from, geometry.to);
      grow(spur, visible);
      body.visible = visible > 0;
      material.opacity = visible;
    }
  }
}
