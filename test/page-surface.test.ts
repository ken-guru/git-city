import { type InstancedMesh, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { BlockLayer, type BlockInput } from "../src/page/blocks.js";
import { buildingKit, CityBuildings, FLOOR_HEIGHT, FOUNDATION_HEIGHT, type CityData } from "../src/page/buildings.js";
import { groundHeightAt, groundY } from "../src/page/countryside.js";
import { blockSpot } from "../src/page/lots.js";
import { settingsFor } from "../src/page/lod.js";
import { BRIDGE_HEIGHT, MARKING_LIFT, type Quads, ROAD_LIFT, roadCurve, roadParts } from "../src/page/roads.js";
import { KIND_BUILD } from "../src/page/state.js";
import { BUILDING_TYPES, type BuildingType } from "../src/shared/buildings.js";
import { countryside } from "../src/shared/countryside.js";

/**
 * What the page draws is a shader, and no browser runs here. So these tests prove what the shader is given and what
 * it stands on: the data each instance holds, the geometry it stretches, the mass that stands in for it, and the
 * ground under every road vertex. The shader's formulas are mirrored here; the mirrors sit beside the GLSL they copy.
 */

const PALETTE = { asphalt: 0x59616b, marking: 0xf4f4f0, bridge: 0xb9bec4, track: 0xb49a72 };
const OFFICE: BuildingType = "office";

/**
 * The bottom and the top of a kit's body stretched to `floors`, as BUILDING_VERTEX stretches it once a build has
 * completed. The body is the walls (vertices that are not on the roof); roof props stand above the body's top.
 */
function stretchedKit(type: BuildingType, floors: number): { bottom: number; top: number } {
  const kit = buildingKit(type);
  const position = kit.getAttribute("position");
  const roof = kit.getAttribute("aRoof");
  const height = FOUNDATION_HEIGHT + floors * FLOOR_HEIGHT;
  let bottom = Infinity;
  let top = -Infinity;
  for (let i = 0; i < position.count; i++) {
    if (roof.getX(i) > 0.5) continue;
    const y = position.getY(i) * height;
    bottom = Math.min(bottom, y);
    top = Math.max(top, y);
  }
  return { bottom, top };
}

/** The half-width of a kit from its Lot's centre, the larger of its two horizontal extents. */
function kitHalf(type: BuildingType): number {
  const kit = buildingKit(type);
  kit.computeBoundingBox();
  const box = kit.boundingBox!;
  return Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
}

/** One Block (index 0) holding one Stint per spot, all of the office type, each built to its Floors. */
function block(spots: { x: number; z: number; floors: number }[], surface: (x: number, z: number) => number = () => 0): CityData {
  return {
    stintCount: spots.length,
    blockCount: 1,
    buildingType: new Uint8Array(spots.length),
    language: new Uint8Array(spots.length),
    seed: Uint32Array.from(spots, (_, i) => i + 1),
    buildings: spots.map((s) => [{ start: 0, kind: KIND_BUILD, from: 0, to: s.floors }]),
    scaffolds: spots.map(() => []),
    languages: spots.map(() => []),
    place: (stint) => ({ x: spots[stint]!.x, z: spots[stint]!.z }),
    block: () => 0,
    blockCentre: () => blockSpot(0.125, 0),
    surface,
  };
}

/** The type meshes a City holds, as the page's internals keep them: each with the Stints of its instances, in order. */
function typeMeshes(built: CityBuildings): { stints: number[]; mesh: InstancedMesh; to: { array: ArrayLike<number> } }[] {
  return (built as unknown as { types: { stints: number[]; mesh: InstancedMesh; to: { array: ArrayLike<number> } }[] }).types;
}

/** The instance of one Stint: its Floors (the `to` attribute), and its matrix (position and scale). */
function instanceOf(built: CityBuildings, stint: number) {
  for (const type of typeMeshes(built)) {
    const i = type.stints.indexOf(stint);
    if (i < 0) continue;
    const m = type.mesh.instanceMatrix.array;
    return {
      floors: type.to.array[i]!,
      x: m[i * 16 + 12]!,
      y: m[i * 16 + 13]!,
      z: m[i * 16 + 14]!,
      sy: m[i * 16 + 5]!,
    };
  }
  throw new Error(`no instance for Stint ${stint}`);
}

describe("a Building's height follows its Floors", () => {
  it("stretches every kit from the ground up to exactly its Floors", () => {
    for (const type of BUILDING_TYPES) {
      for (const floors of [1, 2, 5, 10]) {
        const { bottom, top } = stretchedKit(type, floors);
        expect(bottom).toBeCloseTo(0);
        expect(top).toBeCloseTo(FOUNDATION_HEIGHT + floors * FLOOR_HEIGHT);
      }
    }
  });

  it("makes a Building with N Floors N Floors taller than one with a single Floor", () => {
    for (const type of BUILDING_TYPES) {
      const single = stretchedKit(type, 1).top;
      for (const floors of [2, 5, 10]) {
        expect(stretchedKit(type, floors).top - single).toBeCloseTo((floors - 1) * FLOOR_HEIGHT);
      }
    }
  });

  it("hands each instance the Floors the timeline gave it", () => {
    const built = new CityBuildings(new Scene(), block([{ x: 0, z: 0, floors: 4 }, { x: 3, z: 0, floors: 10 }]), "light");
    built.setDetail({ ...settingsFor(0), massFar: 1e9 });
    built.update(100, 2, { x: 0, z: 0 });
    expect(instanceOf(built, 0).floors).toBe(4);
    expect(instanceOf(built, 1).floors).toBe(10);
  });
});

describe("a Building stands on the ground at its Lot", () => {
  it("places each instance on the surface under its Lot, not at zero", () => {
    const surface = (x: number) => 0.4 + 0.1 * x;
    const built = new CityBuildings(new Scene(), block([{ x: 0, z: 0, floors: 2 }, { x: 3, z: 0, floors: 2 }], surface), "light");
    built.setDetail({ ...settingsFor(0), massFar: 1e9 });
    built.update(100, 2, { x: 0, z: 0 });
    expect(instanceOf(built, 0).y).toBeCloseTo(surface(0));
    expect(instanceOf(built, 1).y).toBeCloseTo(surface(3));
  });
});

describe("a far Block's mass matches the Buildings it stands in for", () => {
  /** A Block with the given Buildings, drawn by a City and a Block layer that share its mass boxes. */
  function drawing(spots: { x: number; z: number; floors: number }[]) {
    const built = new CityBuildings(new Scene(), block(spots, () => 0.3), "light");
    built.setDetail({ ...settingsFor(0), massFar: 50 });
    const blocks: BlockInput[] = [{ x: 0.125, z: 0, claimed: 0 }];
    const layer = new BlockLayer(new Scene(), blocks, () => 0.3, new Map(), () => undefined);
    return { built, layer };
  }

  it("draws the Buildings near and only their mass far, and the mass covers their footprint and tallest top", () => {
    const { built, layer } = drawing([
      { x: 0, z: 0, floors: 4 },
      { x: 1.5, z: 0, floors: 2 },
    ]);
    built.update(100, 2, { x: 0, z: 0 });
    layer.update(100, 4, new Vector3(0, 0, 0), 50, built.massBoxes());
    expect(instanceOf(built, 0).sy).toBeGreaterThan(0);
    expect(instanceOf(built, 1).sy).toBeGreaterThan(0);
    expect(layer.masses.instanceMatrix.array[0]!).toBe(0);

    built.update(100, 2, { x: 500, z: 0 });
    layer.update(100, 4, new Vector3(500, 0, 0), 50, built.massBoxes());
    expect(instanceOf(built, 0).sy).toBe(0);
    expect(instanceOf(built, 1).sy).toBe(0);

    const half = kitHalf(OFFICE);
    const m = layer.masses.instanceMatrix.array;
    expect(m[0]!).toBeCloseTo(1.5 + 2 * half); // width across both kits
    expect(m[10]!).toBeCloseTo(2 * half); // depth of one kit
    expect(m[12]!).toBeCloseTo((-half + 1.5 + half) / 2); // centred on both kits
    expect(m[13]!).toBeCloseTo(0.3); // on the ground under them
    expect(m[5]!).toBeCloseTo(0.3 + FOUNDATION_HEIGHT + 4 * FLOOR_HEIGHT - 0.3); // up to the tallest one's top
  });

  it("gives a Block with one Building a mass of exactly that Building's footprint and real height", () => {
    const { built, layer } = drawing([{ x: 0, z: 0, floors: 7 }]);
    built.update(100, 2, { x: 500, z: 0 });
    layer.update(100, 4, new Vector3(500, 0, 0), 50, built.massBoxes());
    const half = kitHalf(OFFICE);
    const m = layer.masses.instanceMatrix.array;
    expect(m[0]!).toBeCloseTo(2 * half);
    expect(m[10]!).toBeCloseTo(2 * half);
    expect(m[5]!).toBeCloseTo(FOUNDATION_HEIGHT + 7 * FLOOR_HEIGHT);
  });

  it("agrees with the Buildings at the boundary: the mass top is the tallest Building's top then", () => {
    const { built, layer } = drawing([
      { x: 0, z: 0, floors: 3 },
      { x: 1.5, z: 0, floors: 9 },
    ]);
    // Just beyond the mass distance: the Buildings are drawn up to the moment the mass takes over.
    built.update(100, 2, { x: 0, z: 0 });
    layer.update(100, 4, new Vector3(0, 0, 0), 50, built.massBoxes());
    expect(instanceOf(built, 1).sy).toBeGreaterThan(0); // drawn: its height comes from its kit, stretched in the shader
    expect(layer.masses.instanceMatrix.array[0]!).toBe(0);
    const drawnTop = 0.3 + stretchedKit(OFFICE, 9).top;

    built.update(100, 2, { x: 500, z: 0 });
    layer.update(100, 4, new Vector3(500, 0, 0), 50, built.massBoxes());
    const box = built.massBoxes()[0]!;
    expect(box.topY).toBeCloseTo(0.3 + FOUNDATION_HEIGHT + 9 * FLOOR_HEIGHT);
    expect(box.baseY).toBeCloseTo(0.3);
    // The mass top is the tallest Building's top: the same height the Buildings had when they were drawn.
    expect(layer.masses.instanceMatrix.array[5]!).toBeCloseTo(box.topY - box.baseY);
    expect(box.topY).toBeCloseTo(drawnTop);
  });
});

describe("roads follow the drawn terrain", () => {
  /** A road across a seed whose hills vary by more than a Floor along it, so the test is about hills. */
  function hillyRoad() {
    for (let seed = 1; seed < 200; seed++) {
      const land = countryside(seed);
      const path = roadCurve(blockSpot(-8, -6), blockSpot(10, 9), seed, 0, 1);
      const heights = path.map((p) => groundHeightAt(land, p.x, p.z));
      if (Math.max(...heights) - Math.min(...heights) > 1) return { land, path };
    }
    throw new Error("no hilly seed");
  }

  /** The vertices of one kind of road geometry, as [x, y, z] triples; bridge decks are checked by their own rule. */
  function groundVertices(quads: Quads): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let v = 0; v < quads.positions.length; v += 3) {
      const y = quads.positions[v + 1]!;
      if (Math.abs(y - BRIDGE_HEIGHT) < 1e-9) continue;
      out.push([quads.positions[v]!, y, quads.positions[v + 2]!]);
    }
    return out;
  }

  it("places every road vertex on the drawn ground, lifted just clear of it", () => {
    const { land, path } = hillyRoad();
    const parts = roadParts(path, { forward: 2, backward: 1 }, land, PALETTE);
    for (const [quads, lift] of [
      [parts.asphalt, ROAD_LIFT],
      [parts.marking, MARKING_LIFT],
    ] as [Quads, number][]) {
      for (const [x, y, z] of groundVertices(quads)) {
        const ground = groundHeightAt(land, x, z);
        expect(y).toBeGreaterThanOrEqual(ground - 1e-9);
        expect(y - ground).toBeCloseTo(lift, 6);
      }
    }
  });

  it("keeps a track on the ground too", () => {
    const { land, path } = hillyRoad();
    const parts = roadParts(path, { forward: 0, backward: 0 }, land, PALETTE);
    for (const [x, y, z] of groundVertices(parts.track)) {
      expect(y - groundHeightAt(land, x, z)).toBeCloseTo(ROAD_LIFT, 6);
    }
  });
});

describe("the ground height is the surface the ground mesh draws", () => {
  const land = countryside(5);
  const CELL = 6;

  it("matches the ground mesh at its corners", () => {
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        expect(groundHeightAt(land, i * CELL, j * CELL)).toBeCloseTo(groundY(land, i, j), 12);
      }
    }
  });

  it("interpolates linearly along a cell edge", () => {
    const a = groundY(land, 2, 3);
    const b = groundY(land, 3, 3);
    expect(groundHeightAt(land, 2.5 * CELL, 3 * CELL)).toBeCloseTo((a + b) / 2, 12);
  });

  it("is continuous across the diagonal that splits each cell", () => {
    const below = groundHeightAt(land, 1.5 * CELL, (4.5 - 1e-9) * CELL);
    const above = groundHeightAt(land, 1.5 * CELL, (4.5 + 1e-9) * CELL);
    expect(above).toBeCloseTo(below, 6);
  });

  it("stays within the corner heights of its cell", () => {
    const corners = [groundY(land, 0, 0), groundY(land, 1, 0), groundY(land, 0, 1), groundY(land, 1, 1)];
    const inside = [
      { u: 0.1, v: 0.9 },
      { u: 0.6, v: 0.3 },
      { u: 0.5, v: 0.5 },
    ];
    for (const { u, v } of inside) {
      const h = groundHeightAt(land, u * CELL, v * CELL);
      expect(h).toBeGreaterThanOrEqual(Math.min(...corners) - 1e-9);
      expect(h).toBeLessThanOrEqual(Math.max(...corners) + 1e-9);
    }
  });
});
