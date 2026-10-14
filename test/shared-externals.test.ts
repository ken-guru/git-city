import { describe, expect, it } from "vitest";
import { cityVisibility, CITY_FADE_STEPS, HIGHWAY_BUILD_STEPS, horizonRadius, highwayVisibility, MIN_SPUR_GAP, placeAngles, ringLanesOf } from "../src/shared/externals.js";

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

describe("Lanes on the ring", () => {
  // Eight segments of π/4 each: segment i's middle is at (i + ½)·π/4, so segments 0 to 3 cover the first half turn.
  const quarter = Math.PI / 4;

  it("adds the Lanes of two overlapping arcs on the segments where they overlap", () => {
    // Arc A goes the short way from 0 to π/2 with 2 Lanes; arc B from π/4 to π with 3 Lanes.
    const lanes = ringLanesOf(
      [
        { from: 0, to: Math.PI / 2, lanes: 2 },
        { from: quarter, to: Math.PI, lanes: 3 },
      ],
      8,
    );
    expect(lanes).toEqual([
      2, // only A
      5, // A and B overlap
      3, // only B
      3, // only B
      1, // nothing: the minimum of 1 each way
      1,
      1,
      1,
    ]);
  });

  it("takes the shorter way round, so an arc from π/4 to 7π/4 goes backwards through 0", () => {
    // Back from π/4 through 0 to −π/4: the segments either side of 0 carry the 4 Lanes, the rest keep the minimum.
    const lanes = ringLanesOf([{ from: quarter, to: (7 * Math.PI) / 4, lanes: 4 }], 8);
    expect(lanes).toEqual([4, 1, 1, 1, 1, 1, 1, 4]);
  });

  it("keeps at least 1 Lane on every segment", () => {
    expect(ringLanesOf([], 4)).toEqual([1, 1, 1, 1]);
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
