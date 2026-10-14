import { describe, expect, it } from "vitest";
import { cityVisibility, CITY_FADE_STEPS, HIGHWAY_BUILD_STEPS, horizonRadius, highwayVisibility, MIN_SPUR_GAP, placeAngles } from "../src/shared/externals.js";

/**
 * Seam under test: the horizon, spur placement and the arrival and departure timing (SPEC §7). Expected values are
 * literals worked out from the rules in the spec: the horizon only moves outward as the City grows, spurs keep at least a
 * gap apart, a City fades in and out, and a Highway is built then dismantled.
 */

describe("the horizon", () => {
  it("moves outward, and never inward, as the City's extent grows", () => {
    const radii = [0, 5, 10, 20, 40, 80].map(horizonRadius);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(horizonRadius(20)).toBeGreaterThan(horizonRadius(10));
  });
});

describe("spur angles", () => {
  it("keeps an angle that already has room", () => {
    expect(placeAngles([0.5, 2.5])).toEqual([0.5, 2.5]);
  });

  it("pushes apart two cities that want the same angle, by the gap", () => {
    const [a, b] = placeAngles([1, 1]);
    expect(a).toBe(1);
    expect(b! - a!).toBeCloseTo(MIN_SPUR_GAP, 10);
  });

  it("returns angles in the order given, not the sorted order", () => {
    expect(placeAngles([3, 1])).toEqual([3, 1]);
  });
});

describe("arrival and departure", () => {
  it("fades a City in over its fade steps and holds it at full visibility", () => {
    expect(cityVisibility(4, 4, null)).toBe(0);
    expect(cityVisibility(4 + CITY_FADE_STEPS, 4, null)).toBe(1);
    expect(cityVisibility(10, 4, null)).toBe(1);
  });

  it("builds a Highway over its build steps", () => {
    expect(highwayVisibility(2, 2, null)).toBe(0);
    expect(highwayVisibility(2 + HIGHWAY_BUILD_STEPS, 2, null)).toBe(1);
  });

  it("dismantles the Highway from its removal, and fades the City out after the last Highway is gone", () => {
    expect(highwayVisibility(7 + HIGHWAY_BUILD_STEPS, 2, 7)).toBe(0);
    expect(cityVisibility(7 + HIGHWAY_BUILD_STEPS, 2, 7)).toBe(1);
    expect(cityVisibility(7 + HIGHWAY_BUILD_STEPS + CITY_FADE_STEPS, 2, 7)).toBe(0);
  });
});
