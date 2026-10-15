import { type InstancedMesh, Scene } from "three";
import { describe, expect, it } from "vitest";
import { CityBuildings, type CityData } from "../src/page/buildings.js";
import { MAX_LEVEL, settingsFor } from "../src/page/lod.js";
import { KIND_BUILD, KIND_CHANGE, type BuildingSegment, type ScaffoldSegment } from "../src/page/state.js";
import { BUILDING_TYPES } from "../src/shared/buildings.js";

/**
 * A deterministic synthetic City of `fileCount` Buildings: every file is a Building with a few Floors,
 * built at a spread of commits, with some changes and scaffolding. Used for headless smoke tests only.
 */
function syntheticCity(fileCount: number): CityData {
  const columns = Math.max(1, Math.ceil(Math.sqrt(fileCount)));
  const buildingType = new Uint8Array(fileCount);
  const language = new Uint8Array(fileCount);
  const seed = new Uint32Array(fileCount);
  const buildings: BuildingSegment[][] = [];
  const scaffolds: ScaffoldSegment[][] = [];
  for (let f = 0; f < fileCount; f++) {
    buildingType[f] = f % BUILDING_TYPES.length;
    seed[f] = Math.imul(f + 1, 2654435761) >>> 0;
    const start = f % 500;
    buildings.push([
      { start, kind: KIND_BUILD, from: 0, to: 2 + (f % 9) },
      { start: start + 600, kind: KIND_CHANGE, from: 2 + (f % 9), to: 1 + (f % 7) },
    ]);
    scaffolds.push([{ start: start + 600, up: true }, { start: start + 640, up: false }]);
  }
  return {
    stintCount: fileCount,
    buildingType,
    language,
    seed,
    buildings,
    scaffolds,
    languages: Array.from({ length: fileCount }, (_, f) => (f % 3 === 0 ? [{ start: 300, from: 0, to: 2 }] : [])),
    // A synthetic grid of spots: one per Stint.
    place: (stint) => ({ x: (stint % columns) * 1.5, z: Math.floor(stint / columns) * 1.5 }),
    blockCount: Math.ceil(fileCount / 4),
    block: (stint) => Math.floor(stint / 4),
    blockCentre: (block) => ({ x: block * 6, z: 0 }),
    surface: () => 0,
  };
}

describe("CityBuildings headless smoke test with 20k Buildings", () => {
  it("builds one instanced mesh per Building type and runs updates at every level of detail without error", () => {
    const fileCount = 20_000;
    const data = syntheticCity(fileCount);
    const scene = new Scene();

    const city = new CityBuildings(scene, data, "light");

    // Every file lands in exactly one type mesh, and scaffolding has one instance per file.
    const instances = city.objects.map((object) => (object as { count: number }).count);
    expect(instances.slice(0, BUILDING_TYPES.length).reduce((a, b) => a + b, 0)).toBe(fileCount);
    expect(instances[BUILDING_TYPES.length]).toBe(fileCount);
    expect(city.objects).toHaveLength(BUILDING_TYPES.length + 1);

    for (let level = 0; level <= MAX_LEVEL; level++) {
      city.setDetail(settingsFor(level));
      const started = performance.now();
      for (const t of [0, 100, 600, 650, 1000]) city.update(t, 2, { x: 0, z: 0 });
      const ms = performance.now() - started;
      console.info(`LOD level ${level}: five updates over ${fileCount} Buildings took ${ms.toFixed(1)} ms (CPU only, no GPU)`);
    }
  });
});

/** How many instances across the City's meshes are drawn (scale above zero). */
function drawn(city: CityBuildings): number {
  let count = 0;
  for (const object of city.objects) {
    const mesh = object as InstancedMesh;
    const m = mesh.instanceMatrix.array;
    for (let i = 0; i < mesh.count; i++) {
      if (Math.hypot(m[i * 16]!, m[i * 16 + 1]!, m[i * 16 + 2]!) > 0) count++;
    }
  }
  return count;
}

describe("Buildings beyond the mass distance", () => {
  it("draws no Building in a Block beyond the mass distance, and draws the nearer ones", () => {
    // Stints 0 to 3 stand in the Block at x = 0, and stints 4 to 7 in the Block at x = 6.
    const city = new CityBuildings(new Scene(), syntheticCity(8), "light");
    city.setDetail({ ...settingsFor(0), massFar: 27 });

    city.update(1000, 2, { x: 0, z: 0 });
    const near = drawn(city);
    city.update(1000, 2, { x: 30, z: 0 }); // the Block at x = 0 is 30 away, and the one at x = 6 is 24 away
    const mid = drawn(city);

    expect(near).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(near);
  });
});
