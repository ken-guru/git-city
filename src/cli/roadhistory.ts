import { EVENT_ROAD_BUILT, EVENT_ROAD_LANES } from "../shared/format.js";
import type { RoadNetwork } from "./imports/roads.js";

/**
 * Roads over history (SPEC §7). The network is sampled as the history runs, and each sample is compared with the
 * one before it: a Road seen for the first time is built, and a Road whose Lanes changed has its Lanes eased. A Road
 * gets an id the first time it is seen, and keeps it, so the page can follow it through history.
 */

/** A Road's identity: its two village ids, a < b. Ids are assigned in the order Roads first appear. */
export interface RoadPair {
  a: number;
  b: number;
}

export type RoadEvent = { kind: typeof EVENT_ROAD_BUILT; road: number } | { kind: typeof EVENT_ROAD_LANES; road: number; forward: number; backward: number };

export interface RoadHistorySnapshot {
  pairs: [number, number][];
  lanes: [number, number][];
  sampled: number;
}

/** The Roads ever seen, in id order, with the Lanes they have now. A Road with no Lanes is a track. */
export interface RoadTable {
  a: number[];
  b: number[];
  forward: number[];
  backward: number[];
}

export class RoadHistory {
  private readonly ids = new Map<string, number>();
  private readonly pairs: [number, number][] = [];
  /** Per road id: the Lanes it has now, forward and backward. */
  private readonly lanes: [number, number][] = [];
  /** The commit count at the last sample, or -1 before the first. */
  private sampled = -1;

  static restore(s: RoadHistorySnapshot): RoadHistory {
    const history = new RoadHistory();
    s.pairs.forEach(([a, b], id) => {
      history.ids.set(`${a},${b}`, id);
      history.pairs.push([a, b]);
    });
    for (const lanes of s.lanes) history.lanes.push([...lanes]);
    history.sampled = s.sampled;
    return history;
  }

  snapshot(): RoadHistorySnapshot {
    return { pairs: this.pairs.map((p) => [...p]), lanes: this.lanes.map((l) => [...l]), sampled: this.sampled };
  }

  /** The commit count the network was last sampled at, or -1. */
  get lastSample(): number {
    return this.sampled;
  }

  /** Compares a sample of the network, taken at `commits` commits, with the previous one, and returns what changed. */
  sample(network: RoadNetwork, commits: number): RoadEvent[] {
    const events: RoadEvent[] = [];
    const seen = new Set<number>();
    for (const road of network.roads) {
      const key = `${road.a},${road.b}`;
      let id = this.ids.get(key);
      if (id === undefined) {
        id = this.pairs.length;
        this.ids.set(key, id);
        this.pairs.push([road.a, road.b]);
        this.lanes.push([0, 0]);
        events.push({ kind: EVENT_ROAD_BUILT, road: id });
      }
      seen.add(id);
      const next: [number, number] = road.track ? [0, 0] : [road.lanes.forward, road.lanes.backward];
      if (!sameLanes(this.lanes[id]!, next)) {
        this.lanes[id] = next;
        events.push({ kind: EVENT_ROAD_LANES, road: id, forward: next[0], backward: next[1] });
      }
    }
    // A Road no longer in the network has no Lanes any more: it is a track.
    this.lanes.forEach((lanes, id) => {
      if (seen.has(id) || sameLanes(lanes, [0, 0])) return;
      this.lanes[id] = [0, 0];
      events.push({ kind: EVENT_ROAD_LANES, road: id, forward: 0, backward: 0 });
    });
    this.sampled = commits;
    return events;
  }

  /** Every Road ever seen, by id, with the Lanes it has now. */
  table(): RoadTable {
    return {
      a: this.pairs.map((p) => p[0]),
      b: this.pairs.map((p) => p[1]),
      forward: this.lanes.map((l) => l[0]),
      backward: this.lanes.map((l) => l[1]),
    };
  }
}

function sameLanes(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
