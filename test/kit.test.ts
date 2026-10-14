import { describe, expect, it } from "vitest";
import { BUILDING_TYPES } from "../src/shared/buildings.js";
import { buildingKit, scaffoldKit } from "../src/page/buildings.js";

/** Vertices of a kit, split by the flags the shader reads. */
function vertices(geometry: ReturnType<typeof buildingKit>) {
  const position = geometry.getAttribute("position");
  const roof = geometry.getAttribute("aRoof");
  const trim = geometry.getAttribute("aTrim");
  return Array.from({ length: position.count }, (_, i) => ({
    y: position.getY(i),
    roof: roof.getX(i) > 0.5,
    trim: trim.getX(i),
  }));
}

describe("building kits", () => {
  it("has one kit per Building type, each a unit-height body with props on top", () => {
    for (const type of BUILDING_TYPES) {
      const v = vertices(buildingKit(type));
      const body = v.filter((p) => !p.roof);
      const props = v.filter((p) => p.roof);

      // The body is stretched by the shader from 0..1 (its Floors); nothing below the ground or above one unit.
      expect(Math.min(...body.map((p) => p.y))).toBeCloseTo(0, 6);
      expect(Math.max(...body.map((p) => p.y))).toBeLessThanOrEqual(1 + 1e-6);
      // Props sit on the roof: their own y starts at the roof line (1) and rises above it.
      expect(Math.min(...props.map((p) => p.y))).toBeGreaterThanOrEqual(1 - 1e-6);
    }
  });

  it("marks trim (language colour) apart from walls, and the walls as plain", () => {
    for (const type of BUILDING_TYPES) {
      const trims = new Set(vertices(buildingKit(type)).map((p) => p.trim));
      expect(trims.has(0)).toBe(true); // walls
      expect(trims.has(1)).toBe(true); // roof props and trim in the language colour
    }
  });

  it("gives the scaffolding and crane their own kit, with the crane in its fixed colour", () => {
    const trims = new Set(vertices(scaffoldKit()).map((p) => p.trim));
    expect(trims).toEqual(new Set([0, 2]));
  });
});
