import { describe, expect, it } from "vitest";
import { Mesh, MeshLambertMaterial, RingGeometry, Scene } from "three";
import { type ExternalCitiesFile, MAX_HIGHWAY_WIDTH, parseExternalCities } from "../src/shared/externals.js";
import { ExternalLayer } from "../src/page/externals.js";
import {
  BRIDGE_SAMPLES,
  bridgeRuns,
  CITY_BEYOND_RING_BLOCKS,
  externalsGeometry,
  highwayWidth,
  LANE_WIDTH,
  laneBands,
  MARKING_WIDTH,
  needsBridge,
} from "../src/page/externals-geometry.js";

/**
 * Seam under test: the page's geometry for the horizon, spurs and Highways (SPEC §7), from the CLI's externals.json.
 * Expected values are worked out by hand: the ring is horizon × Block width, a City stands beyond the ring at its angle,
 * and a Highway runs from its District's village (or the centre) to the ring at its City's angle.
 */

const BLOCK = 6;
const file: ExternalCitiesFile = {
  formatVersion: 2,
  horizon: 20,
  cities: [
    { name: "Thornwick", source: 0, angle: 0, from: 3, to: null, members: 9, outskirts: false },
    { name: "Outskirts", source: 0, angle: Math.PI / 2, from: 5, to: 9, members: 4, outskirts: true },
  ],
  highways: [
    { city: 0, district: 1, from: 3, to: null, lanes: 2 },
    { city: 1, district: -1, from: 5, to: 9, lanes: 1 },
  ],
  ring: [2, 2, 1, 1, 1, 1, 1, 1],
};
const villages = [
  { x: 0, z: 0 },
  { x: 4, z: 0 },
];

describe("the external geometry in the page's world", () => {
  const geometry = externalsGeometry(file, villages, BLOCK);

  it("puts the horizon ring at its Block radius, in world units", () => {
    expect(geometry.ring).toBe(20 * BLOCK);
  });

  it("stands a City beyond the ring at its angle, with a spur from the ring", () => {
    const [thornwick] = geometry.cities;
    const beyond = geometry.ring + CITY_BEYOND_RING_BLOCKS * BLOCK;
    expect(thornwick!.position.x).toBeCloseTo(beyond, 6);
    expect(thornwick!.position.z).toBeCloseTo(0, 6);
    expect(thornwick!.spurStart.x).toBeCloseTo(geometry.ring, 6);
    expect(thornwick!.spurEnd).toEqual(thornwick!.position);
  });

  it("makes the Outskirts a low sprawl and a City's height grow with its members", () => {
    expect(geometry.cities[1]!.height).toBe(2);
    expect(geometry.cities[0]!.height).toBeCloseTo(4 + 2 * Math.sqrt(9), 6);
  });

  it("runs a Highway from its District's village to the ring at its City's angle", () => {
    const [access] = geometry.highways;
    expect(access!.start).toEqual({ x: 4 * BLOCK, z: 0 });
    expect(access!.end.x).toBeCloseTo(geometry.ring, 6);
    expect(access!.end.z).toBeCloseTo(0, 6);
    expect(access!.lanes).toBe(2);
  });

  it("starts the root manifest's Highway at the City centre", () => {
    const root = geometry.highways[1]!;
    expect(root.start).toEqual({ x: 0, z: 0 });
    expect(root.end.x).toBeCloseTo(0, 6);
    expect(root.end.z).toBeCloseTo(geometry.ring, 6);
  });
});

describe("parsing externals.json", () => {
  it("reads a file of the current format", () => {
    expect(parseExternalCities(JSON.stringify(file)).horizon).toBe(20);
  });

  it("refuses another format version, or a file without its lists", () => {
    expect(() => parseExternalCities(JSON.stringify({ ...file, formatVersion: 1 }))).toThrow(/format 1/);
    expect(() => parseExternalCities(JSON.stringify({ formatVersion: 2, horizon: 3 }))).toThrow(/shape/);
  });
});

describe("bridges", () => {
  const start = { x: 24, z: 0 };
  const end = { x: 120, z: 0 };

  it("places a bridge run where a straight Highway crosses a river, and no run where it does not", () => {
    // Samples every 2 world units from x = 24 to x = 120; the river is x in [60, 80], so samples 18 to 28 are over it.
    const river = (x: number) => x >= 60 && x <= 80;
    const runs = bridgeRuns(start, end, (x) => river(x));
    expect(runs).toEqual([{ from: 18 / BRIDGE_SAMPLES, to: 29 / BRIDGE_SAMPLES }]);
    expect(bridgeRuns(start, end, () => false)).toEqual([]);
    expect(bridgeRuns(start, end, () => true)).toEqual([{ from: 0, to: 1 }]);
  });

  it("finds two runs where a Highway crosses two rivers", () => {
    const runs = bridgeRuns(start, end, (x) => (x >= 30 && x <= 34) || (x >= 100 && x <= 110));
    expect(runs).toHaveLength(2);
    expect(runs[0]!.to).toBeLessThan(runs[1]!.from);
  });

  it("needs a bridge over a river cell, and beside a cell that stands steeply above or below it", () => {
    // Column 5 is a river. Cell (8, 0) stands beside (9, 0), which rises 2 above it: steeper than STEEP_STEP.
    const terrain = {
      levelAt: (col: number) => (col === 5 ? ("river" as const) : ("flat" as const)),
      heightAt: (col: number, row: number) => (col === 9 && row === 0 ? 2 : 0),
    };
    expect(needsBridge(terrain, 5, 0)).toBe(true);
    expect(needsBridge(terrain, 8, 0)).toBe(true);
    expect(needsBridge(terrain, 3, 0)).toBe(false);
  });

  it("does not need a bridge on flat, level ground", () => {
    const flat = { levelAt: () => "flat" as const, heightAt: () => 0.3 };
    expect(needsBridge(flat, 0, 0)).toBe(false);
  });

  it("gives each Highway the bridge runs of the ground it crosses, and none on flat ground", () => {
    const crosses = (x: number) => x >= 60 && x <= 80;
    const geometry = externalsGeometry(file, villages, BLOCK, (x) => crosses(x));
    expect(geometry.highways[0]!.bridges).toEqual([{ from: 18 / BRIDGE_SAMPLES, to: 29 / BRIDGE_SAMPLES }]);
    expect(geometry.highways[1]!.bridges).toEqual([]);
  });
});

describe("Lanes beyond road width", () => {
  it("packs each Lane edge to edge on either side of the centre line, so no two Lanes overlap", () => {
    for (const lanes of [1, 2, 3, 6]) {
      const bands = laneBands(lanes);
      // At most four Lanes each way are drawn (see the maximum width test below).
      expect(bands).toHaveLength(2 * Math.min(lanes, 4));
      // Sorted by where each band starts, no band reaches into the next.
      const spans = bands.map((b) => [b.offset - b.width / 2, b.offset + b.width / 2] as const).sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] - 1e-9);
      // The marking sits between the two directions, and each direction keeps its own side.
      expect(bands.filter((b) => b.direction === 1).every((b) => b.offset > 0)).toBe(true);
      expect(bands.filter((b) => b.direction === -1).every((b) => b.offset < 0)).toBe(true);
    }
  });

  it("draws a Highway with 6 Lanes each way at the widest the Lanes fit under MAX_HIGHWAY_WIDTH, and no wider", () => {
    // Four Lanes each way fit under the maximum (0.15 + 8 × 0.7 = 5.75); a fifth would take the road past it.
    const widest = MARKING_WIDTH + 2 * LANE_WIDTH * 4;
    expect(highwayWidth(6)).toBeCloseTo(widest, 10);
    expect(highwayWidth(50)).toBeCloseTo(widest, 10);
    expect(widest).toBeLessThanOrEqual(MAX_HIGHWAY_WIDTH);
    expect(laneBands(6)).toHaveLength(8);
    expect(laneBands(50)).toHaveLength(8);
  });

  it("makes a road wider with more Lanes, and keeps at least one Lane each way", () => {
    expect(highwayWidth(0)).toBe(highwayWidth(1));
    expect(highwayWidth(3)).toBeGreaterThan(highwayWidth(2));
    expect(highwayWidth(2)).toBeCloseTo(MARKING_WIDTH + 4 * LANE_WIDTH, 10);
  });
});

describe("a bridged Highway drawn in three.js", () => {
  it("draws the Lanes and the marking of a Highway, and builds its decks as it is built", () => {
    const scene = new Scene();
    const geometry = externalsGeometry(file, villages, BLOCK, (x) => x >= 60 && x <= 80);
    const layer = new ExternalLayer(scene, geometry, "dark", () => 0);
    // Two Lanes each way and the centre marking: 4 + 1 meshes for the access Highway.
    expect(layer.highwayMeshes[0]).toHaveLength(5);
    layer.update(3 + 2);
    expect(layer.highwayMeshes[0]!.every((m) => m.visible)).toBe(true);
  });
});

describe("the ring drawn in three.js", () => {
  it("draws one arc per segment, wider where more Lanes run", () => {
    const layer = new ExternalLayer(new Scene(), externalsGeometry(file, villages, BLOCK), "light", () => 0);
    expect(layer.ringMeshes).toHaveLength(file.ring.length);
    const widthOf = (m: Mesh) => {
      const p = (m.geometry as RingGeometry).parameters;
      return p.outerRadius - p.innerRadius;
    };
    expect(widthOf(layer.ringMeshes[0]!)).toBeGreaterThan(widthOf(layer.ringMeshes[2]!));
    expect(widthOf(layer.ringMeshes[0]!)).toBeCloseTo(highwayWidth(2) * 0.7, 6);
  });
});

describe("the External Cities drawn in three.js", () => {
  const scene = new Scene();
  const layer = new ExternalLayer(scene, externalsGeometry(file, villages, BLOCK), "light", () => 0);
  const [thornwickBody, outskirtsBody] = layer.cityBodies;
  // Each Highway's first mesh is its first Lane; every Lane of a Highway grows together.
  const [accessHighway, rootHighway] = layer.highwayMeshes.map((lanes) => lanes[0]!);
  const opacity = (m: Mesh) => (m.material as MeshLambertMaterial).opacity;

  it("draws nothing before the first Step", () => {
    layer.update(0);
    expect([thornwickBody, accessHighway, rootHighway].every((m) => m!.visible === false)).toBe(true);
  });

  it("builds the access Highway outward from its village over its build steps", () => {
    // Thornwick's Highway starts at Step 3 and is built over HIGHWAY_BUILD_STEPS (2): half built at Step 4.
    layer.update(4);
    expect(accessHighway!.visible).toBe(true);
    // From village 1 (x = 24) to the ring (x = 120) is 96 world units; half built is 48.
    expect(accessHighway!.scale.x).toBeCloseTo(48, 4);
  });

  it("fades a City in at its arrival, and out after its last Highway is dismantled", () => {
    layer.update(3);
    expect(opacity(thornwickBody!)).toBe(0);
    layer.update(4);
    expect(opacity(thornwickBody!)).toBe(1);
    // Thornwick never departs: it stays at full opacity.
    layer.update(40);
    expect(opacity(thornwickBody!)).toBe(1);
    // The Outskirts depart at Step 9; by Step 9 + 2 + 1 they have faded out.
    layer.update(9 + 3);
    expect(opacity(outskirtsBody!)).toBe(0);
    expect(outskirtsBody!.visible).toBe(false);
  });
});
