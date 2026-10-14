import { BoxGeometry, Mesh, MeshLambertMaterial, RingGeometry, type Scene } from "three";
import { cityVisibility, highwayVisibility } from "../shared/externals.js";
import { type CityGeometry, type ExternalsGeometry, type HighwayGeometry, type Point } from "./externals-geometry.js";

/**
 * The horizon ring, the orbital motorway's access Highways, the spurs and the External Cities, drawn in three.js (SPEC §7).
 * Each piece's visibility and growth come from the CLI's Steps through the shared timing: a Highway is built outward from
 * its village, a City fades in, and departure runs the same in reverse.
 */

const ASPHALT = { light: 0x3d434b, dark: 0x2a2f36 } as const;
const HAZE = { light: 0xa9b7c4, dark: 0x5d6b78 } as const;
const RING_WIDTH = 3;
const SPUR_WIDTH = 1.4;
const ROAD_BASE_WIDTH = 2.2;
const LANE_WIDTH = 0.7;
/** Height of the road surface above the ground, in world units. */
const LIFT = 0.25;

/** The ground height at a world position, from the Countryside's terrain. */
export type GroundAt = (x: number, z: number) => number;

interface Strip {
  mesh: Mesh;
  start: Point;
  direction: Point;
  length: number;
  y: number;
}

/** A road-like strip from `start` to `end`, built to full length by scaling the unit box along its own axis. */
function strip(scene: Scene, start: Point, end: Point, width: number, material: MeshLambertMaterial, ground: GroundAt): Strip {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz) || 1;
  const mesh = new Mesh(new BoxGeometry(1, 0.2, width), material);
  mesh.rotation.y = -Math.atan2(dz, dx);
  mesh.visible = false;
  scene.add(mesh);
  const y = ground(start.x, start.z) + LIFT;
  return { mesh, start, direction: { x: dx / length, z: dz / length }, length, y };
}

/** Grows a strip to `fraction` of its length, from its start outward. */
function grow(s: Strip, fraction: number): void {
  s.mesh.visible = fraction > 0;
  s.mesh.scale.x = Math.max(fraction * s.length, 0.001);
  const along = (fraction * s.length) / 2;
  s.mesh.position.set(s.start.x + s.direction.x * along, s.y, s.start.z + s.direction.z * along);
}

export class ExternalLayer {
  private readonly highways: { strip: Strip; geometry: HighwayGeometry }[] = [];
  private readonly cities: { spur: Strip; body: Mesh; material: MeshLambertMaterial; geometry: CityGeometry }[] = [];

  constructor(scene: Scene, geometry: ExternalsGeometry, theme: "light" | "dark", ground: GroundAt) {
    const asphalt = new MeshLambertMaterial({ color: ASPHALT[theme] });
    if (geometry.cities.length > 0) {
      const ring = new Mesh(new RingGeometry(geometry.ring - RING_WIDTH / 2, geometry.ring + RING_WIDTH / 2, 192), asphalt);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = LIFT;
      scene.add(ring);
    }
    for (const h of geometry.highways) {
      const width = ROAD_BASE_WIDTH + LANE_WIDTH * h.lanes;
      this.highways.push({ strip: strip(scene, h.start, h.end, width, asphalt, ground), geometry: h });
    }
    for (const c of geometry.cities) {
      const material = new MeshLambertMaterial({ color: HAZE[theme], transparent: true, opacity: 0 });
      const footprint = c.outskirts ? 14 : 6;
      const body = new Mesh(new BoxGeometry(footprint, c.height, footprint), material);
      body.position.set(c.position.x, ground(c.position.x, c.position.z) + c.height / 2, c.position.z);
      body.visible = false;
      scene.add(body);
      this.cities.push({ spur: strip(scene, c.spurStart, c.spurEnd, SPUR_WIDTH, asphalt, ground), body, material, geometry: c });
    }
  }

  /** The Highway meshes, in the order of the geometry's Highways. */
  get highwayMeshes(): readonly Mesh[] {
    return this.highways.map((h) => h.strip.mesh);
  }

  /** The City bodies, in the order of the geometry's Cities. */
  get cityBodies(): readonly Mesh[] {
    return this.cities.map((c) => c.body);
  }

  /** Draws every piece at time `t` (in Steps). Pure in `t`: scrubbing and reversing need nothing extra. */
  update(t: number): void {
    for (const { strip: s, geometry } of this.highways) grow(s, highwayVisibility(t, geometry.from, geometry.to));
    for (const { spur, body, material, geometry } of this.cities) {
      const visible = cityVisibility(t, geometry.from, geometry.to);
      grow(spur, visible);
      body.visible = visible > 0;
      material.opacity = visible;
    }
  }
}
