import { describe, expect, it } from "vitest";
import { Mesh, MeshLambertMaterial, Scene } from "three";
import { type ExternalCitiesFile, parseExternalCities } from "../src/shared/externals.js";
import { ExternalLayer } from "../src/page/externals.js";
import { CITY_BEYOND_RING_BLOCKS, externalsGeometry } from "../src/page/externals-geometry.js";

/**
 * Seam under test: the page's geometry for the horizon, spurs and Highways (SPEC §7), from the CLI's externals.json.
 * Expected values are worked out by hand: the ring is horizon × Block width, a City stands beyond the ring at its angle,
 * and a Highway runs from its District's village (or the centre) to the ring at its City's angle.
 */

const BLOCK = 6;
const file: ExternalCitiesFile = {
  formatVersion: 1,
  horizon: 20,
  cities: [
    { name: "Thornwick", source: 0, angle: 0, from: 3, to: null, members: 9, outskirts: false },
    { name: "Outskirts", source: 0, angle: Math.PI / 2, from: 5, to: 9, members: 4, outskirts: true },
  ],
  highways: [
    { city: 0, district: 1, from: 3, to: null, lanes: 2 },
    { city: 1, district: -1, from: 5, to: 9, lanes: 1 },
  ],
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
    expect(() => parseExternalCities(JSON.stringify({ ...file, formatVersion: 2 }))).toThrow(/format 2/);
    expect(() => parseExternalCities(JSON.stringify({ formatVersion: 1, horizon: 3 }))).toThrow(/shape/);
  });
});

describe("the External Cities drawn in three.js", () => {
  const scene = new Scene();
  const layer = new ExternalLayer(scene, externalsGeometry(file, villages, BLOCK), "light", () => 0);
  const [thornwickBody, outskirtsBody] = layer.cityBodies;
  const [accessHighway, rootHighway] = layer.highwayMeshes;
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
