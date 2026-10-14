import { Scene } from "three";
import { describe, expect, it } from "vitest";
import { CityBuildings, type CityData } from "../src/page/buildings.js";
import { MAX_LEVEL, settingsFor } from "../src/page/lod.js";
import { gridColumns, gridSlot, KIND_BUILD, KIND_CHANGE, type BuildingSegment, type ScaffoldSegment } from "../src/page/state.js";
import { BUILDING_TYPES } from "../src/shared/buildings.js";

/**
 * A deterministic synthetic City of `fileCount` Buildings: every file is a Building with a few Floors,
 * built at a spread of commits, with some changes and scaffolding. Used for headless smoke tests only.
 */
function syntheticCity(fileCount: number): CityData {
  const columns = gridColumns(fileCount);
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
    fileCount,
    buildingType,
    language,
    seed,
    buildings,
    scaffolds,
    languages: Array.from({ length: fileCount }, (_, f) => (f % 3 === 0 ? [{ start: 300, from: 0, to: 2 }] : [])),
    place: (file) => {
      const { column, row } = gridSlot(file, columns);
      return { x: column * 1.5, z: row * 1.5 };
    },
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
      for (const t of [0, 100, 600, 650, 1000]) city.update(t, 2);
      const ms = performance.now() - started;
      console.info(`LOD level ${level}: five updates over ${fileCount} Buildings took ${ms.toFixed(1)} ms (CPU only, no GPU)`);
    }
  });
});
