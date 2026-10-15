import { BufferGeometry, Color, Float32BufferAttribute, Mesh, MeshLambertMaterial, type Scene } from "three";
import { type Countryside, unit } from "../shared/countryside.js";
import { groundHeightAt } from "./countryside.js";
import { BLOCK_WORLD, blockSpot, type Spot } from "./lots.js";
import { easeOutCubic, latestAt, type RoadSegments } from "./state.js";

/**
 * Village Roads (SPEC §7): gently curved ribbons between village centres that follow the terrain, with asymmetric
 * halves, a double centre line, dashed lane dividers, and bridges where they cross a river. A Road is built at the
 * commit its first connection appears, grows outward from the older village over 2D, and its Lanes ease over D. A
 * Road with no Lanes is an unpaved track. The Roads' ends are trimmed where the villages' edges are, which move as
 * the villages grow. Roads over time as a whole (each Road's growth through history) is out of scope for v1.
 */

/** Width of one Lane, in world units. */
export const LANE_WIDTH = 0.42;
/** Sample spacing along a Road, in world units. */
export const ROAD_STEP = 0.6;
/** How far a Road bows to either side of the straight line, as a share of its length. */
const BOW_SHARE = 0.14;
/** Amplitude of the noise wobble along a Road, in world units. */
const WOBBLE = 0.35;
/** Heights: a Road sits just above the fields, and a bridge clears the water. */
/** How far above the drawn ground the road surface and its markings sit, and the height of a bridge deck. */
export const ROAD_LIFT = 0.07;
export const MARKING_LIFT = 0.02;
export const BRIDGE_HEIGHT = 0.45;
/** Half-width of the double centre line, and its line width, in world units. */
const CENTRE_GAP = 0.03;
const LINE_WIDTH = 0.04;
const TRACK_HALF = 0.25;
/** Salt for the seeded values of the Roads. */
const SALT = 40;
/** A Road is a track while both its halves have less than this many Lanes. */
const TRACK_LANES = 0.5;

/** A Road as the page needs it: the two village ids, a < b (so `a` is the older village). */
export interface RoadInput {
  a: number;
  b: number;
}

/** A village centre, in Block widths. */
export interface VillageSite {
  x: number;
  z: number;
}

/** A Block's owner village and position, in Block widths, and the commit that claimed it. */
export interface BlockSite {
  village: number;
  x: number;
  z: number;
  claimed: number;
}

/**
 * How far from its centre a village reaches at a commit, in world units: the furthest of its claimed Blocks plus
 * half a Block. Before any Block is claimed, the village reaches half a Block.
 */
export class RadiusHistory {
  private readonly times: number[][] = [];
  private readonly reach: number[][] = [];

  constructor(villages: readonly VillageSite[], blocks: readonly BlockSite[]) {
    const claims: [number, number][][] = villages.map(() => []);
    for (const block of blocks) {
      const village = villages[block.village];
      if (!village) continue;
      const distance = Math.hypot((block.x - village.x) * BLOCK_WORLD, (block.z - village.z) * BLOCK_WORLD);
      claims[block.village]!.push([block.claimed, distance + BLOCK_WORLD / 2]);
    }
    claims.forEach((list, village) => {
      list.sort((p, q) => p[0] - q[0]);
      let furthest = BLOCK_WORLD / 2;
      this.times[village] = list.map(([t]) => t);
      this.reach[village] = list.map(([, r]) => (furthest = Math.max(furthest, r)));
    });
  }

  /** The village's radius at commit `t`. */
  radiusAt(village: number, t: number): number {
    const times = this.times[village];
    if (!times || times.length === 0) return BLOCK_WORLD / 2;
    let lo = 0;
    let hi = times.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? BLOCK_WORLD / 2 : this.reach[village]![found]!;
  }
}

/**
 * How far from its centre a village reaches, in world units, once every Block is claimed: the furthest of its Blocks
 * plus half a Block.
 */
export function villageRadii(villages: readonly VillageSite[], blocks: readonly BlockSite[]): number[] {
  const history = new RadiusHistory(villages, blocks);
  const end = Number.POSITIVE_INFINITY;
  return villages.map((_, village) => history.radiusAt(village, end));
}

/**
 * The centre line of a Road from `from` to `to`: a cubic Bézier that bows to one side by a seeded amount,
 * plus a seeded wobble along its length. Deterministic for a seed and a pair of village ids.
 */
export function roadCurve(from: Spot, to: Spot, seed: number, a: number, b: number): Spot[] {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return [{ ...from }];
  // Unit normal to the chord, and the bow in each direction.
  const nx = -dz / length;
  const nz = dx / length;
  const bow = length * BOW_SHARE * (2 * unit(seed, SALT, a, b) - 1);
  const wobblePhase = 2 * Math.PI * unit(seed, SALT + 1, a, b);
  const c1 = { x: from.x + dx / 3 + nx * bow, z: from.z + dz / 3 + nz * bow };
  const c2 = { x: from.x + (2 * dx) / 3 + nx * bow, z: from.z + (2 * dz) / 3 + nz * bow };
  const count = Math.max(2, Math.ceil(length / ROAD_STEP) + 1);
  const points: Spot[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const u = 1 - t;
    const wobble = WOBBLE * Math.sin(Math.PI * 3 * t + wobblePhase) * Math.sin(Math.PI * t);
    const x = u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x;
    const z = u * u * u * from.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * to.z;
    points.push({ x: x + nx * wobble, z: z + nz * wobble });
  }
  return points;
}

/**
 * The part of a curve between the two village edges: it starts where it leaves village `a`'s radius and
 * ends where it enters village `b`'s. Empty when the villages overlap, so there is no road to draw.
 */
export function trimToEdges(points: readonly Spot[], a: Spot, aRadius: number, b: Spot, bRadius: number): Spot[] {
  const from = points.findIndex((p) => Math.hypot(p.x - a.x, p.z - a.z) >= aRadius);
  if (from < 0) return [];
  let to = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (Math.hypot(points[i]!.x - b.x, points[i]!.z - b.z) >= bRadius) {
      to = i;
      break;
    }
  }
  return to > from ? points.slice(from, to + 1) : [];
}

/**
 * Whether each sample (in world units) lies over a river, where the Road needs a bridge. `isRiver` takes
 * the Countryside cell, which is one Block width.
 */
export function bridgeSamples(points: readonly Spot[], isRiver: (col: number, row: number) => boolean): boolean[] {
  return points.map((p) => isRiver(Math.round(p.x / BLOCK_WORLD), Math.round(p.z / BLOCK_WORLD)));
}

/** A unit normal at each sample, from the direction of the line through its neighbours. */
export function normals(points: readonly Spot[]): Spot[] {
  return points.map((p, i) => {
    const before = points[Math.max(0, i - 1)]!;
    const after = points[Math.min(points.length - 1, i + 1)]!;
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: -dz / length, z: dx / length };
  });
}

/**
 * The Lanes of a Road at commit `t`: each half eases from its previous Lanes to its new ones over `duration`
 * commits. A Road with no segments yet has no Lanes.
 */
export function lanesAt(road: RoadSegments | undefined, t: number, duration: number): { forward: number; backward: number } {
  const lane = road ? latestAt(road.lanes, t) : undefined;
  if (!lane) return { forward: 0, backward: 0 };
  const share = easeOutCubic(Math.min(1, Math.max(0, (t - lane.start) / duration)));
  return {
    forward: lane.fromForward + (lane.forward - lane.fromForward) * share,
    backward: lane.fromBackward + (lane.backward - lane.fromBackward) * share,
  };
}

export interface Palette {
  asphalt: number;
  marking: number;
  bridge: number;
  track: number;
}

const PALETTE: Record<"light" | "dark", Palette> = {
  light: { asphalt: 0x59616b, marking: 0xf4f4f0, bridge: 0xb9bec4, track: 0xb49a72 },
  dark: { asphalt: 0x2e343b, marking: 0xd8d8d0, bridge: 0x6a727b, track: 0x6b5b44 },
};

/** Accumulates quads, with their colours, into one geometry. */
export class Quads {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /**
   * A strip between offsets `from` and `to` along each sample's normal, for the segments `draw` accepts. Every vertex
   * sits on the drawn ground at its own position, lifted by `lift`; a bridge sample sits at the bridge height instead.
   */
  strip(
    points: readonly Spot[],
    normal: readonly Spot[],
    bridges: readonly boolean[],
    surface: (x: number, z: number) => number,
    lift: number,
    from: number,
    to: number,
    colour: Color,
    draw: (segment: number) => boolean = () => true,
  ) {
    for (let i = 0; i < points.length - 1; i++) {
      if (!draw(i)) continue;
      const base = this.positions.length / 3;
      for (const [k, offset] of [
        [i, from],
        [i, to],
        [i + 1, from],
        [i + 1, to],
      ] as const) {
        const p = points[k]!;
        const n = normal[k]!;
        const x = p.x + n.x * offset;
        const z = p.z + n.z * offset;
        const y = bridges[k] ? BRIDGE_HEIGHT : surface(x, z) + lift;
        this.positions.push(x, y, z);
        this.colors.push(colour.r, colour.g, colour.b);
      }
      this.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}

/** Dashes: two segments drawn, two left out, along a Road. */
function dashed(segment: number): boolean {
  return Math.floor(segment / 2) % 2 === 0;
}

/** The quads of one Road at its current Lanes, by kind: asphalt, markings, bridge decks and tracks. */
export interface RoadParts {
  asphalt: Quads;
  marking: Quads;
  bridge: Quads;
  track: Quads;
}

/**
 * The geometry of one Road: its centre line `points` (in world units), its Lanes each way, and the terrain it lies
 * on. Each vertex is placed on the drawn ground at its own position (see `groundHeightAt`), lifted just clear of it;
 * a bridge sample is at the bridge height. A Road with less than a Lane each way is a track.
 */
export function roadParts(points: readonly Spot[], lanes: { forward: number; backward: number }, land: Countryside, palette: Palette): RoadParts {
  const bridges = bridgeSamples(points, (c, r) => land.levelAt(c, r) === "river");
  const normal = normals(points);
  const surface = (x: number, z: number) => groundHeightAt(land, x, z);
  const onBridge = (segment: number) => bridges[segment]! && bridges[segment + 1]!;
  const parts: RoadParts = { asphalt: new Quads(), marking: new Quads(), bridge: new Quads(), track: new Quads() };
  const colour = (key: keyof Palette) => new Color(palette[key]);

  if (lanes.forward < TRACK_LANES && lanes.backward < TRACK_LANES) {
    parts.track.strip(points, normal, bridges, surface, ROAD_LIFT, -TRACK_HALF, TRACK_HALF, colour("track"), (s) => !onBridge(s));
    return parts;
  }
  // Asymmetric halves: the forward half runs on the normal's side, the backward half on the other.
  const forward = lanes.forward * LANE_WIDTH;
  const backward = lanes.backward * LANE_WIDTH;
  parts.asphalt.strip(points, normal, bridges, surface, ROAD_LIFT, -backward, forward, colour("asphalt"), (s) => !onBridge(s));
  parts.bridge.strip(points, normal, bridges, surface, ROAD_LIFT, -backward, forward, colour("bridge"), onBridge);
  const line = colour("marking");
  const lift = MARKING_LIFT;
  parts.marking.strip(points, normal, bridges, surface, lift, CENTRE_GAP, CENTRE_GAP + LINE_WIDTH, line);
  parts.marking.strip(points, normal, bridges, surface, lift, -CENTRE_GAP - LINE_WIDTH, -CENTRE_GAP, line);
  for (let k = 1; k < Math.floor(lanes.forward); k++) {
    const at = k * LANE_WIDTH;
    parts.marking.strip(points, normal, bridges, surface, lift, at, at + LINE_WIDTH, line, dashed);
  }
  for (let k = 1; k < Math.floor(lanes.backward); k++) {
    const at = -k * LANE_WIDTH;
    parts.marking.strip(points, normal, bridges, surface, lift, at - LINE_WIDTH, at, line, dashed);
  }
  return parts;
}

interface RoadMeshes {
  asphalt: Mesh;
  marking: Mesh;
  bridge: Mesh;
  track: Mesh;
}

/**
 * The Roads on the page. Each Road gets its own meshes once it is built; its geometry is rebuilt only when its growth,
 * its Lanes or its trimmed ends change, so a steady City costs nothing per frame.
 */
export class RoadLayer {
  private readonly curves: Spot[][];
  private readonly radii: RadiusHistory;
  private readonly meshes: (RoadMeshes | undefined)[] = [];
  private readonly signatures: string[] = [];
  private readonly materials: Record<keyof RoadMeshes, MeshLambertMaterial>;
  private readonly palette: Palette;

  constructor(
    private readonly scene: Scene,
    private readonly roads: readonly RoadInput[],
    private readonly villages: readonly VillageSite[],
    blocks: readonly BlockSite[],
    private readonly land: Countryside,
    seed: number,
    theme: "light" | "dark",
    private readonly segments: ReadonlyMap<number, RoadSegments>,
  ) {
    this.palette = PALETTE[theme];
    this.radii = new RadiusHistory(villages, blocks);
    this.curves = roads.map((road) => {
      const va = villages[road.a];
      const vb = villages[road.b];
      if (!va || !vb) return [];
      return roadCurve(blockSpot(va.x, va.z), blockSpot(vb.x, vb.z), seed, road.a, road.b);
    });
    // The colour is in the vertices, so the materials stay white and do not tint them twice.
    const plain = () => new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.materials = { asphalt: plain(), marking: plain(), bridge: plain(), track: plain() };
  }

  /** Brings every built Road to commit `t`: grown, laned and trimmed as the timeline says. */
  update(t: number, duration: number): void {
    for (const [id, road] of this.segments) {
      const pair = this.roads[id];
      if (!pair || t < road.built || this.curves[id]!.length < 2) continue;
      // Growth runs over 2D from the older village, which is `a`: the curve starts there.
      const growth = easeOutCubic(Math.min(1, Math.max(0, (t - road.built) / (2 * duration))));
      const lanes = lanesAt(road, t, duration);
      const radiusA = this.radii.radiusAt(pair.a, t);
      const radiusB = this.radii.radiusAt(pair.b, t);
      const signature = [Math.round(growth * 64), Math.round(lanes.forward * 20), Math.round(lanes.backward * 20), Math.round(radiusA * 4), Math.round(radiusB * 4)].join(",");
      if (signature === this.signatures[id]) continue;
      this.signatures[id] = signature;
      this.rebuild(id, pair, growth, lanes, radiusA, radiusB);
    }
  }

  private rebuild(id: number, pair: RoadInput, growth: number, lanes: { forward: number; backward: number }, radiusA: number, radiusB: number): void {
    const va = this.roadCentre(pair.a);
    const vb = this.roadCentre(pair.b);
    let points = trimToEdges(this.curves[id]!, va, radiusA, vb, radiusB);
    if (points.length >= 2 && growth < 1) points = points.slice(0, Math.max(2, Math.round(growth * points.length)));
    const meshes = this.meshesFor(id);
    if (points.length < 2) {
      for (const mesh of Object.values(meshes)) mesh.geometry = new BufferGeometry();
      return;
    }
    const parts = roadParts(points, lanes, this.land, this.palette);
    meshes.asphalt.geometry.dispose();
    meshes.asphalt.geometry = parts.asphalt.geometry();
    meshes.marking.geometry.dispose();
    meshes.marking.geometry = parts.marking.geometry();
    meshes.bridge.geometry.dispose();
    meshes.bridge.geometry = parts.bridge.geometry();
    meshes.track.geometry.dispose();
    meshes.track.geometry = parts.track.geometry();
  }

  private roadCentre(village: number): Spot {
    const site = this.villages[village];
    return blockSpot(site?.x ?? 0, site?.z ?? 0);
  }

  private meshesFor(id: number): RoadMeshes {
    const existing = this.meshes[id];
    if (existing) return existing;
    const make = (key: keyof RoadMeshes) => {
      const mesh = new Mesh(new BufferGeometry(), this.materials[key]);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    };
    const created = { asphalt: make("asphalt"), marking: make("marking"), bridge: make("bridge"), track: make("track") };
    this.meshes[id] = created;
    return created;
  }
}
