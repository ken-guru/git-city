import { type Material, type Mesh, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { BlockLayer } from "../src/page/blocks.js";
import { CityBuildings, type CityData } from "../src/page/buildings.js";
import { addCountryside } from "../src/page/countryside.js";
import { settingsFor } from "../src/page/lod.js";
import { RoadLayer } from "../src/page/roads.js";
import { KIND_BUILD } from "../src/page/state.js";
import { countryside } from "../src/shared/countryside.js";

/**
 * Headless checks for the rendering faults reported on main. Each names what the page would be given, and each fails
 * on the code it was written against. No browser runs here, so these prove data and geometry, not pixels.
 */

describe("1. Countryside meshes that read vertex colours have them (else the shader reads black)", () => {
  it("gives every mesh with vertexColors a colour attribute", () => {
    const scene = new Scene();
    addCountryside(scene, { seed: 3, theme: "light", keepOut: 0 });
    const missing: string[] = [];
    scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as Material & { vertexColors?: boolean };
      if (material.vertexColors && mesh.geometry.getAttribute("color") === undefined) missing.push(mesh.type);
    });
    expect(missing).toEqual([]);
  });
});

describe("2. A far Block shows the height of its Buildings, not a fixed flat slab", () => {
  it("stretches the far mass of a Block with a 7-Floor Building to that Building's top", () => {
    const data: CityData = {
      stintCount: 1,
      buildingType: Uint8Array.of(0),
      language: Uint8Array.of(0),
      seed: Uint32Array.of(1),
      buildings: [[{ start: 0, kind: KIND_BUILD, from: 0, to: 7 }]],
      scaffolds: [[]],
      languages: [[]],
      place: () => ({ x: 0, z: 0 }),
      block: () => ({ x: 0, z: 0 }),
    };
    const city = new CityBuildings(new Scene(), data, "light");
    city.setDetail(settingsFor(0));
    city.update(100, 2, { x: 500, z: 0 });
    const layer = new BlockLayer(new Scene(), [{ x: 0, z: 0, claimed: 0 }], countryside(3), new Map(), () => undefined);
    layer.update(100, 4, new Vector3(500, 0, 0), 50);
    // The mass as drawn: its geometry's height times its instance's scale. The Building's top is its foundation plus
    // its 7 Floors (0.2 + 7), and the mass should rise to it.
    const geometry = layer.masses.geometry;
    geometry.computeBoundingBox();
    const drawnHeight = (geometry.boundingBox!.max.y - geometry.boundingBox!.min.y) * layer.masses.instanceMatrix.array[5]!;
    expect(drawnHeight).toBeCloseTo(0.2 + 7);
  });
});

describe("2b. A City opens with its centre Block inside its own level-of-detail mass distance", () => {
  it("places the starting camera within massFar of the centre of a City of three villages", () => {
    // The starting camera of main.ts: its offset is a multiple of the City's extent, from the centre.
    const extent = 252;
    const camera = { x: 0.9 * extent + 4, y: 0.8 * extent + 4, z: 1.1 * extent + 6 };
    const distance = Math.hypot(camera.x, camera.y, camera.z);
    expect(distance).toBeLessThan(settingsFor(0).massFar);
  });
});

describe("3. Roads sit on the ground the page draws", () => {
  it("places every road vertex on the ground mesh under it, lifted only slightly", () => {
    const land = countryside(7);
    const scene = new Scene();
    addCountryside(scene, { seed: 7, theme: "light", keepOut: 0 });
    // The ground is the first mesh the countryside adds: a grid of corners, CELL apart, joined by triangles.
    const ground = scene.children[0] as Mesh;
    const groundAt = groundHeightFromMesh(ground);

    const roadScene = new Scene();
    const villages = [
      { x: 0, z: 0 },
      { x: 14, z: 6 },
    ];
    const blocks = [
      { village: 0, x: 0, z: 0, claimed: 0 },
      { village: 1, x: 14, z: 6, claimed: 0 },
    ];
    const segments = new Map([[0, { built: 0, lanes: [{ start: 0, fromForward: 0, fromBackward: 0, forward: 2, backward: 1 }] }]]);
    const layer = new RoadLayer(roadScene, [{ a: 0, b: 1 }], villages, blocks, land, 7, "light", segments);
    layer.update(100, 4);

    let checked = 0;
    for (const object of roadScene.children) {
      const position = (object as Mesh).geometry.getAttribute("position");
      for (let v = 0; v < position.count; v++) {
        const x = position.getX(v);
        const y = position.getY(v);
        const z = position.getZ(v);
        if (Math.abs(y - 0.45) < 1e-6) continue; // a bridge deck
        const ground = groundAt(x, z);
        expect(y, `road vertex at ${x.toFixed(2)}, ${z.toFixed(2)}`).toBeGreaterThanOrEqual(ground - 1e-6);
        expect(y - ground).toBeLessThan(0.1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/**
 * The height of a ground mesh made by the countryside: the triangle under (x, z), interpolated, with the same
 * triangles the mesh uses (split along the cell's lower-left to upper-right diagonal of each pair of corners).
 */
function groundHeightFromMesh(mesh: Mesh): (x: number, z: number) => number {
  const position = mesh.geometry.getAttribute("position");
  const side = Math.round(Math.sqrt(position.count));
  const cell = 6;
  const half = (side - 1) / 2;
  const y = (i: number, j: number) => position.getY(j * side + i);
  return (x, z) => {
    const c = x / cell + half;
    const r = z / cell + half;
    const i = Math.floor(c);
    const j = Math.floor(r);
    const u = c - i;
    const v = r - j;
    const a = y(i, j);
    const b = y(i + 1, j);
    const cc = y(i, j + 1);
    const d = y(i + 1, j + 1);
    if (u + v <= 1) return a + u * (b - a) + v * (cc - a);
    return cc + b - d + (d - cc) * u + (d - b) * v;
  };
}
