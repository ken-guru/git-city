import { Scene } from "three";
import { describe, expect, it } from "vitest";
import { countryside } from "../src/shared/countryside.js";
import { BLOCK_WORLD } from "../src/page/lots.js";
import { RoadLayer, RadiusHistory, LANE_WIDTH, bridgeSamples, lanesAt, normals, roadCurve, trimToEdges, villageRadii } from "../src/page/roads.js";
import { type LaneSegment, type RoadSegments } from "../src/page/state.js";

const origin = { x: 0, z: 0 };
const far = { x: 60, z: 0 };

describe("roadCurve", () => {
  it("starts and ends at the two village centres", () => {
    const curve = roadCurve(origin, far, 42, 0, 1);
    expect(curve[0]!.x).toBeCloseTo(0);
    expect(curve[0]!.z).toBeCloseTo(0);
    expect(curve.at(-1)!.x).toBeCloseTo(60);
    expect(curve.at(-1)!.z).toBeCloseTo(0);
  });

  it("is curved, but never strays far from the straight line", () => {
    const curve = roadCurve(origin, far, 42, 0, 1);
    const sideways = Math.max(...curve.map((p) => Math.abs(p.z)));
    expect(sideways).toBeGreaterThan(0.5);
    expect(sideways).toBeLessThan(60 * 0.14 + 0.5);
  });

  it("is the same for the same seed and pair of villages, and differs for another seed", () => {
    expect(roadCurve(origin, far, 42, 0, 1)).toEqual(roadCurve(origin, far, 42, 0, 1));
    expect(roadCurve(origin, far, 42, 0, 1)).not.toEqual(roadCurve(origin, far, 43, 0, 1));
  });

  it("samples at most about one step apart", () => {
    const curve = roadCurve(origin, far, 7, 0, 2);
    for (let i = 1; i < curve.length; i++) {
      expect(Math.hypot(curve[i]!.x - curve[i - 1]!.x, curve[i]!.z - curve[i - 1]!.z)).toBeLessThan(1.2);
    }
  });
});

describe("trimToEdges", () => {
  it("keeps only the part of the curve outside both villages' radii", () => {
    const curve = roadCurve(origin, far, 42, 0, 1);
    const kept = trimToEdges(curve, origin, 10, far, 12);
    expect(Math.hypot(kept[0]!.x, kept[0]!.z)).toBeGreaterThanOrEqual(10);
    expect(Math.hypot(kept.at(-1)!.x - far.x, kept.at(-1)!.z - far.z)).toBeGreaterThanOrEqual(12);
    expect(kept.length).toBeLessThan(curve.length);
  });

  it("draws nothing when the two villages overlap", () => {
    expect(trimToEdges(roadCurve(origin, far, 42, 0, 1), origin, 40, far, 40)).toEqual([]);
  });
});

describe("villageRadii and RadiusHistory", () => {
  const villages = [
    { x: 0, z: 0 },
    { x: 10, z: 0 },
  ];
  const blocks = [
    { village: 0, x: 0, z: 0, claimed: 0 },
    { village: 0, x: 2, z: 0, claimed: 30 },
    { village: 1, x: 10, z: 0, claimed: 0 },
  ];

  it("reaches the furthest Block of each village, plus half a Block", () => {
    const radii = villageRadii(villages, blocks);
    expect(radii[0]).toBeCloseTo(2 * BLOCK_WORLD + BLOCK_WORLD / 2);
    expect(radii[1]).toBeCloseTo(BLOCK_WORLD / 2);
  });

  it("grows as Blocks are claimed, so a village's edge moves outward with it", () => {
    const history = new RadiusHistory(villages, blocks);
    expect(history.radiusAt(0, 0)).toBeCloseTo(BLOCK_WORLD / 2);
    expect(history.radiusAt(0, 29)).toBeCloseTo(BLOCK_WORLD / 2);
    expect(history.radiusAt(0, 30)).toBeCloseTo(2 * BLOCK_WORLD + BLOCK_WORLD / 2);
  });
});

describe("bridgeSamples", () => {
  it("marks the samples over a river, in Countryside cells", () => {
    const points = [
      { x: 0, z: 0 },
      { x: BLOCK_WORLD * 3, z: 0 },
      { x: BLOCK_WORLD * 6, z: 0 },
    ];
    const over = bridgeSamples(points, (col) => col === 3);
    expect(over).toEqual([false, true, false]);
  });
});

describe("normals", () => {
  it("are unit vectors across the direction of travel", () => {
    const line = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 1 },
    ];
    for (const n of normals(line)) expect(Math.hypot(n.x, n.z)).toBeCloseTo(1);
    expect(normals(line)[0]!.x).toBeCloseTo(0);
    expect(normals(line)[0]!.z).toBeCloseTo(1);
  });
});

describe("lanesAt", () => {
  const lane = (start: number, from: number, to: number): LaneSegment => ({ start, fromForward: from, fromBackward: 1, forward: to, backward: 1 });

  it("has no Lanes before the Road has any, and eases to a change of Lanes over D commits", () => {
    const road: RoadSegments = { built: 0, lanes: [lane(10, 1, 3)] };
    expect(lanesAt(undefined, 10, 4)).toEqual({ forward: 0, backward: 0 });
    expect(lanesAt(road, 10, 4).forward).toBeCloseTo(1);
    expect(lanesAt(road, 12, 4).forward).toBeGreaterThan(1);
    expect(lanesAt(road, 12, 4).forward).toBeLessThan(3);
    expect(lanesAt(road, 14, 4).forward).toBeCloseTo(3);
  });
});

describe("RoadLayer", () => {
  const villages = [
    { x: 0, z: 0 },
    { x: 14, z: 0 },
    { x: 14, z: 14 },
  ];
  const blocks = [
    { village: 0, x: 0, z: 0, claimed: 0 },
    { village: 1, x: 14, z: 0, claimed: 0 },
    { village: 2, x: 14, z: 14, claimed: 0 },
  ];
  const roads = [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
  ];

  /** The triangles of a Road's asphalt, or none while it is not built. */
  function asphaltTriangles(scene: Scene, road: number): number {
    // A Road's meshes are added when it is first built: asphalt, markings, bridges, tracks, in that order.
    const mesh = scene.children.filter((c) => c.type === "Mesh")[road * 4] as import("three").Mesh | undefined;
    return mesh?.geometry.getIndex()?.count ?? 0;
  }

  it("draws no Road before it is built, and draws it from its build commit on", () => {
    const scene = new Scene();
    const segments = new Map<number, RoadSegments>([[0, { built: 100, lanes: [{ start: 100, fromForward: 0, fromBackward: 0, forward: 2, backward: 1 }] }]]);
    const layer = new RoadLayer(scene, roads, villages, blocks, countryside(5), 5, "light", segments);
    layer.update(50, 4);
    expect(asphaltTriangles(scene, 0)).toBe(0);
    layer.update(140, 4);
    expect(asphaltTriangles(scene, 0)).toBeGreaterThan(0);
  });

  it("grows a Road outward from its older village: more of it is drawn as its growth completes", () => {
    const scene = new Scene();
    const segments = new Map<number, RoadSegments>([[0, { built: 100, lanes: [{ start: 100, fromForward: 2, fromBackward: 1, forward: 2, backward: 1 }] }]]);
    const layer = new RoadLayer(scene, roads, villages, blocks, countryside(5), 5, "light", segments);
    layer.update(101, 4);
    const early = asphaltTriangles(scene, 0);
    layer.update(160, 4);
    const grown = asphaltTriangles(scene, 0);
    expect(early).toBeGreaterThan(0);
    expect(grown).toBeGreaterThan(early);
  });

  it("widens a Road's asphalt as its Lanes ease up", () => {
    const scene = new Scene();
    const segments = new Map<number, RoadSegments>([
      [0, { built: 0, lanes: [{ start: 0, fromForward: 1, fromBackward: 1, forward: 1, backward: 1 }, { start: 200, fromForward: 1, fromBackward: 1, forward: 3, backward: 1 }] }],
    ]);
    const layer = new RoadLayer(scene, roads, villages, blocks, countryside(5), 5, "dark", segments);
    layer.update(199, 4);
    const before = (scene.children.filter((c) => c.type === "Mesh")[0] as import("three").Mesh).geometry.getAttribute("position");
    const widthBefore = Math.max(...Array.from({ length: before.count }, (_, i) => Math.abs(before.getZ(i))));
    layer.update(210, 4);
    const after = (scene.children.filter((c) => c.type === "Mesh")[0] as import("three").Mesh).geometry.getAttribute("position");
    const widthAfter = Math.max(...Array.from({ length: after.count }, (_, i) => Math.abs(after.getZ(i))));
    expect(widthAfter).toBeGreaterThan(widthBefore);
    expect(LANE_WIDTH).toBeGreaterThan(0);
  });
});
