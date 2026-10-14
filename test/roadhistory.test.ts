import { describe, expect, it } from "vitest";
import type { RoadNetwork } from "../src/cli/imports/roads.js";
import { RoadHistory } from "../src/cli/roadhistory.js";
import { EVENT_ROAD_BUILT, EVENT_ROAD_LANES } from "../src/shared/format.js";

/** A network with the given roads, as [a, b, forward, backward] Lanes; zero Lanes make a track. */
function network(...roads: [number, number, number, number][]): RoadNetwork {
  return {
    roads: roads.map(([a, b, forward, backward]) => ({
      a,
      b,
      strength: { forward: 0, backward: 0 },
      lanes: { forward, backward },
      track: forward === 0 && backward === 0,
    })),
    streets: new Map(),
  };
}

describe("RoadHistory", () => {
  it("builds a Road the first time it appears, and sets its Lanes", () => {
    const history = new RoadHistory();
    expect(history.sample(network([0, 1, 2, 1]), 10)).toEqual([
      { kind: EVENT_ROAD_BUILT, road: 0 },
      { kind: EVENT_ROAD_LANES, road: 0, forward: 2, backward: 1 },
    ]);
  });

  it("records nothing when a later sample is the same", () => {
    const history = new RoadHistory();
    history.sample(network([0, 1, 2, 1]), 10);
    expect(history.sample(network([0, 1, 2, 1]), 20)).toEqual([]);
    expect(history.lastSample).toBe(20);
  });

  it("eases a change of Lanes, and gives a new Road the next id", () => {
    const history = new RoadHistory();
    history.sample(network([0, 1, 2, 1]), 10);
    expect(history.sample(network([0, 1, 3, 1], [0, 2, 1, 1]), 20)).toEqual([
      { kind: EVENT_ROAD_LANES, road: 0, forward: 3, backward: 1 },
      { kind: EVENT_ROAD_BUILT, road: 1 },
      { kind: EVENT_ROAD_LANES, road: 1, forward: 1, backward: 1 },
    ]);
    expect(history.table()).toEqual({ a: [0, 0], b: [1, 2], forward: [3, 1], backward: [1, 1] });
  });

  it("takes a Road that leaves the network to a track, and keeps its id", () => {
    const history = new RoadHistory();
    history.sample(network([0, 1, 2, 1]), 10);
    // The new Road comes from the network; the Road that left it is taken down after.
    expect(history.sample(network([0, 2, 1, 1]), 20)).toEqual([
      { kind: EVENT_ROAD_BUILT, road: 1 },
      { kind: EVENT_ROAD_LANES, road: 1, forward: 1, backward: 1 },
      { kind: EVENT_ROAD_LANES, road: 0, forward: 0, backward: 0 },
    ]);
    expect(history.table().a).toEqual([0, 0]);
  });

  it("restores exactly what it had, so a resumed run records the same changes", () => {
    const history = new RoadHistory();
    history.sample(network([0, 1, 2, 1]), 10);
    const restored = RoadHistory.restore(JSON.parse(JSON.stringify(history.snapshot())));
    const next = network([0, 1, 4, 1]);
    expect(restored.sample(next, 20)).toEqual(history.sample(next, 20));
    expect(restored.table()).toEqual(history.table());
  });
});
