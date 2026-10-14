import { BufferGeometry, Color, Float32BufferAttribute, Mesh, MeshLambertMaterial, type Scene } from "three";
import { type Countryside, unit } from "../shared/countryside.js";
import { BLOCK_WORLD, blockSpot, type Spot } from "./lots.js";

/**
 * Village Roads (SPEC §7): gently curved ribbons between village centres that follow the terrain, with
 * asymmetric halves, a double centre line, dashed lane dividers, bridges where they cross a river, and
 * unpaved tracks where no connection uses them. Roads are built once, when the page loads; they do not
 * grow over time (that is out of scope for v1).
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
const ROAD_LIFT = 0.07;
const MARKING_LIFT = 0.02;
const BRIDGE_HEIGHT = 0.45;
/** Half-width of the double centre line, and its line width, in world units. */
const CENTRE_GAP = 0.03;
const LINE_WIDTH = 0.04;
const TRACK_HALF = 0.25;
/** Salt for the seeded values of the Roads. */
const SALT = 40;

/** A Road as the page needs it: the two village ids, its Lanes per direction, and whether it is an unpaved track. */
export interface RoadInput {
  a: number;
  b: number;
  forward: number;
  backward: number;
  track: number;
}

/** A village centre, in Block widths. */
export interface VillageSite {
  x: number;
  z: number;
}

/** A Block's owner village and position, in Block widths. */
export interface BlockSite {
  village: number;
  x: number;
  z: number;
}

/**
 * How far from its centre a village reaches, in world units: the furthest of its Blocks plus half a Block.
 * A Road is trimmed where it leaves this radius.
 */
export function villageRadii(villages: readonly VillageSite[], blocks: readonly BlockSite[]): number[] {
  const radii = villages.map(() => BLOCK_WORLD / 2);
  for (const block of blocks) {
    const village = villages[block.village];
    if (!village) continue;
    const reach = Math.hypot((block.x - village.x) * BLOCK_WORLD, (block.z - village.z) * BLOCK_WORLD) + BLOCK_WORLD / 2;
    radii[block.village] = Math.max(radii[block.village]!, reach);
  }
  return radii;
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

interface Palette {
  asphalt: number;
  marking: number;
  bridge: number;
  track: number;
}

const PALETTE: Record<"light" | "dark", Palette> = {
  light: { asphalt: 0x59616b, marking: 0xf4f4f0, bridge: 0xb9bec4, track: 0xb49a72 },
  dark: { asphalt: 0x2e343b, marking: 0xd8d8d0, bridge: 0x6a727b, track: 0x6b5b44 },
};

/** Accumulates quads, with their colours, into one merged mesh. */
class Quads {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /** A strip between offsets `from` and `to` along each sample's normal, at each sample's height, for the segments `draw` accepts. */
  strip(points: readonly Spot[], normal: readonly Spot[], heights: readonly number[], from: number, to: number, colour: Color, draw: (segment: number) => boolean = () => true) {
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
        this.positions.push(p.x + n.x * offset, heights[k]!, p.z + n.z * offset);
        this.colors.push(colour.r, colour.g, colour.b);
      }
      this.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }

  mesh(): Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    mesh.frustumCulled = false;
    return mesh;
  }
}

/**
 * Builds every Road as a few merged meshes: asphalt, markings, bridge decks and tracks. The Roads and the
 * curves are a pure function of the seed and the layout, so they are drawn once.
 */
export function addRoads(
  scene: Scene,
  roads: readonly RoadInput[],
  villages: readonly VillageSite[],
  blocks: readonly BlockSite[],
  land: Countryside,
  seed: number,
  theme: "light" | "dark",
): void {
  const colours = PALETTE[theme];
  const radii = villageRadii(villages, blocks);
  const asphalt = new Quads();
  const marking = new Quads();
  const bridge = new Quads();
  const track = new Quads();
  const colour = (hex: number) => new Color(hex);
  for (const road of roads) {
    const va = villages[road.a];
    const vb = villages[road.b];
    if (!va || !vb) continue;
    const from = blockSpot(va.x, va.z);
    const to = blockSpot(vb.x, vb.z);
    const curve = roadCurve(from, to, seed, road.a, road.b);
    const points = trimToEdges(curve, from, radii[road.a]!, to, radii[road.b]!);
    if (points.length < 2) continue;
    const bridges = bridgeSamples(points, (c, r) => land.levelAt(c, r) === "river");
    const normal = normals(points);
    const heights = points.map((p, i) => (bridges[i] ? BRIDGE_HEIGHT : land.heightAt(p.x / BLOCK_WORLD, p.z / BLOCK_WORLD) + ROAD_LIFT));
    const onBridge = (segment: number) => bridges[segment]! && bridges[segment + 1]!;
    if (road.track) {
      track.strip(points, normal, heights, -TRACK_HALF, TRACK_HALF, colour(colours.track), (s) => !onBridge(s));
      continue;
    }
    // Asymmetric halves: the forward half runs on the normal's side, the backward half on the other.
    const forward = Math.max(1, road.forward) * LANE_WIDTH;
    const backward = Math.max(1, road.backward) * LANE_WIDTH;
    asphalt.strip(points, normal, heights, -backward, forward, colour(colours.asphalt), (s) => !onBridge(s));
    bridge.strip(points, normal, heights, -backward, forward, colour(colours.bridge), onBridge);
    const markingHeights = heights.map((h, i) => (bridges[i] ? h : h - ROAD_LIFT + MARKING_LIFT));
    const lineColour = colour(colours.marking);
    // Double centre line.
    marking.strip(points, normal, markingHeights, CENTRE_GAP, CENTRE_GAP + LINE_WIDTH, lineColour);
    marking.strip(points, normal, markingHeights, -CENTRE_GAP - LINE_WIDTH, -CENTRE_GAP, lineColour);
    // Dashed lane dividers, one line per lane boundary in each half.
    for (let k = 1; k < Math.max(1, road.forward); k++) {
      const at = k * LANE_WIDTH;
      marking.strip(points, normal, markingHeights, at, at + LINE_WIDTH, lineColour, dashed);
    }
    for (let k = 1; k < Math.max(1, road.backward); k++) {
      const at = -k * LANE_WIDTH;
      marking.strip(points, normal, markingHeights, at - LINE_WIDTH, at, lineColour, dashed);
    }
  }
  for (const quads of [asphalt, bridge, track, marking]) {
    if (quads.indices.length > 0) scene.add(quads.mesh());
  }
}

/** Dashes: two segments drawn, two left out, along a Road. */
function dashed(segment: number): boolean {
  return Math.floor(segment / 2) % 2 === 0;
}
