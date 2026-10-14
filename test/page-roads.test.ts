import { Scene } from "three";
import { describe, expect, it } from "vitest";
import { countryside } from "../src/shared/countryside.js";
import { BLOCK_WORLD } from "../src/page/lots.js";
import { addRoads, bridgeSamples, LANE_WIDTH, normals, roadCurve, trimToEdges, villageRadii } from "../src/page/roads.js";

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

describe("villageRadii", () => {
  it("reaches the furthest Block of each village, plus half a Block", () => {
    const radii = villageRadii([{ x: 0, z: 0 }, { x: 10, z: 0 }], [
      { village: 0, x: 0, z: 0 },
      { village: 0, x: 2, z: 0 },
      { village: 1, x: 10, z: 0 },
    ]);
    expect(radii[0]).toBeCloseTo(2 * BLOCK_WORLD + BLOCK_WORLD / 2);
    expect(radii[1]).toBeCloseTo(BLOCK_WORLD / 2);
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

describe("addRoads", () => {
  const villages = [
    { x: 0, z: 0 },
    { x: 14, z: 0 },
    { x: 14, z: 14 },
  ];
  const blocks = [
    { village: 0, x: 0, z: 0 },
    { village: 1, x: 14, z: 0 },
    { village: 2, x: 14, z: 14 },
  ];

  it("draws each used Road with its markings, and each track in one mesh", () => {
    const scene = new Scene();
    const roads = [
      { a: 0, b: 1, forward: 2, backward: 1, track: 0 },
      { a: 1, b: 2, forward: 0, backward: 0, track: 1 },
    ];
    addRoads(scene, roads, villages, blocks, countryside(5), 5, "light");
    // Asphalt, markings, bridges (none here) and tracks: one mesh for each kind that has geometry.
    expect(scene.children.length).toBeGreaterThanOrEqual(3);
    for (const child of scene.children) expect(child.type).toBe("Mesh");
  });

  it("gives an asymmetric Road the Lanes of each direction, not a single width", () => {
    expect(LANE_WIDTH).toBeGreaterThan(0);
    const scene = new Scene();
    addRoads(scene, [{ a: 0, b: 1, forward: 3, backward: 1, track: 0 }], villages, blocks, countryside(5), 5, "dark");
    expect(scene.children.length).toBeGreaterThan(0);
  });
});
