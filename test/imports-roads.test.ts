import { describe, expect, it } from "vitest";
import { buildRoadNetwork, laneCount, streetWidth, type DistrictLink, type VillageSite } from "../src/cli/imports/roads.js";

/**
 * Seam under test: `buildRoadNetwork`, from village sites and District links to Roads, Lanes and street widths.
 * Lane and width values are literals written from the spec (SPEC §7): Lanes = 1 + ½·log₂(strength), rounded
 * down, capped at 6, at least 1 each way; street widths grow with strength up to 2×.
 */

const sites: VillageSite[] = [
  { id: 0, col: 0, row: 0 },
  { id: 1, col: 10, row: 0 },
  { id: 2, col: 20, row: 0 },
  { id: 3, col: 30, row: 0 },
];
/** One District per village, named after it. */
const villageOf = (district: string) => ({ a: 0, b: 1, c: 2, d: 3 })[district as "a" | "b" | "c" | "d"];

const road = (network: ReturnType<typeof buildRoadNetwork>, a: number, b: number) =>
  network.roads.find((r) => r.a === a && r.b === b)!;

describe("Lanes", () => {
  it("follows 1 + ½·log₂(strength), rounded down, capped at 6 and at least 1", () => {
    expect([1, 2, 3, 4, 8, 16, 4096].map(laneCount)).toEqual([1, 1, 1, 2, 2, 3, 6]);
    expect(laneCount(0)).toBe(1);
  });
});

describe("street width", () => {
  it("widens with strength and never beyond 2× the base width", () => {
    expect(streetWidth(1)).toBe(1);
    expect(streetWidth(4)).toBe(1.25);
    expect(streetWidth(1_000_000)).toBe(2);
  });
});

describe("Roads between villages", () => {
  it("routes a connection along the shortest path of the relative-neighbourhood graph", () => {
    // Villages 0-1-2 sit in a line; 0-2 is not an edge of the graph, because village 1 is closer to both.
    const links: DistrictLink[] = [
      { from: "a", to: "c", strength: 16 },
      { from: "c", to: "a", strength: 1 },
    ];

    const network = buildRoadNetwork(sites.slice(0, 3), links, villageOf);

    expect(network.roads.map((r) => [r.a, r.b])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    // Road 0-1 carries the 16 from 0 to 1 and the 1 back; Lanes follow each direction's sum.
    expect(road(network, 0, 1)).toMatchObject({
      strength: { forward: 16, backward: 1 },
      lanes: { forward: 3, backward: 1 },
      track: false,
    });
    expect(road(network, 1, 2)).toMatchObject({
      strength: { forward: 16, backward: 1 },
      lanes: { forward: 3, backward: 1 },
    });
  });

  it("leaves a Road no connection uses as an unpaved track with no Lanes", () => {
    const links: DistrictLink[] = [{ from: "a", to: "c", strength: 2 }];

    const network = buildRoadNetwork(sites.slice(0, 4), links, villageOf);

    expect(road(network, 2, 3)).toMatchObject({ track: true, lanes: { forward: 0, backward: 0 } });
    expect(road(network, 0, 1)).toMatchObject({ track: false, lanes: { forward: 1, backward: 1 } });
  });

  it("widens Block streets inside one District by its internal strength", () => {
    const links: DistrictLink[] = [
      { from: "a", to: "a", strength: 4 },
      { from: "a", to: "b", strength: 1 },
    ];

    const network = buildRoadNetwork(sites.slice(0, 2), links, villageOf);

    expect(network.streets.get("a")).toBe(1.25);
    expect(network.streets.has("b")).toBe(false);
  });
});
