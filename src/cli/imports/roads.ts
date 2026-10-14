/**
 * Roads between villages (SPEC §7). The villages are joined by one shared network: the relative-neighbourhood
 * graph over their centres. Each District-to-District connection takes the shortest path through it, and a Road
 * carries the sum of every connection that passes over it, per direction.
 */

/** Tuning values. Starting points, named so they can be configured. */
export const MAX_LANES = 6;
/** Street width grows by log₂(strength) / this, capped at STREET_WIDTH_CAP times the base width. */
export const STREET_STRENGTH_SCALE = 8;
export const STREET_WIDTH_CAP = 2;

/** A village centre on the Block grid. */
export interface VillageSite {
  id: number;
  col: number;
  row: number;
}

/** Summed file-to-file edges from one District to another. Equal keys are internal to one District. */
export interface DistrictLink {
  from: string;
  to: string;
  strength: number;
}

/**
 * A Road between villages `a` and `b` (a < b). `forward` is the direction a → b, `backward` b → a.
 * An unused Road is a track: no Lanes, and `track` is true.
 */
export interface Road {
  a: number;
  b: number;
  strength: { forward: number; backward: number };
  lanes: { forward: number; backward: number };
  track: boolean;
}

export interface RoadNetwork {
  roads: Road[];
  /** Width factor (1 to STREET_WIDTH_CAP) of the Block streets inside each District that has internal links. */
  streets: Map<string, number>;
}

/**
 * Lanes for one direction of a used Road: 1 + ½·log₂(strength), rounded down, capped at MAX_LANES,
 * and never fewer than 1.
 */
export function laneCount(strength: number): number {
  if (strength <= 0) return 1;
  return Math.min(MAX_LANES, Math.max(1, Math.floor(1 + 0.5 * Math.log2(strength))));
}

/** Width factor of a street with `strength`: 1 at the base width, growing to STREET_WIDTH_CAP. */
export function streetWidth(strength: number): number {
  if (strength <= 1) return 1;
  return Math.min(STREET_WIDTH_CAP, 1 + Math.log2(strength) / STREET_STRENGTH_SCALE);
}

/**
 * Builds the Road network. `villageOf` maps a District key to its village id, or undefined when the District
 * has no village (its links are then ignored).
 */
export function buildRoadNetwork(
  sites: readonly VillageSite[],
  links: readonly DistrictLink[],
  villageOf: (district: string) => number | undefined,
): RoadNetwork {
  const index = new Map(sites.map((site, i) => [site.id, i] as const));
  const graph = relativeNeighbourhoodGraph(sites);
  const roadKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const roads = new Map<string, Road>();
  for (const [u, v] of graph) {
    const a = Math.min(sites[u]!.id, sites[v]!.id);
    const b = Math.max(sites[u]!.id, sites[v]!.id);
    roads.set(roadKey(a, b), { a, b, strength: { forward: 0, backward: 0 }, lanes: { forward: 0, backward: 0 }, track: true });
  }

  // Each ordered village pair's connections, summed, then routed along the shortest path.
  const pairs = new Map<string, { from: number; to: number; strength: number }>();
  const internal = new Map<string, number>();
  for (const link of links) {
    const from = villageOf(link.from);
    const to = villageOf(link.to);
    if (from === undefined || to === undefined) continue;
    if (link.from === link.to) {
      internal.set(link.from, (internal.get(link.from) ?? 0) + link.strength);
      continue;
    }
    if (from === to) continue;
    const key = `${from}>${to}`;
    const pair = pairs.get(key) ?? { from, to, strength: 0 };
    pair.strength += link.strength;
    pairs.set(key, pair);
  }

  const routes = new Map<number, Map<number, number[]>>();
  for (const pair of pairs.values()) {
    const fromIndex = index.get(pair.from);
    const toIndex = index.get(pair.to);
    if (fromIndex === undefined || toIndex === undefined) continue;
    let table = routes.get(fromIndex);
    if (!table) routes.set(fromIndex, (table = shortestPaths(sites, graph, fromIndex)));
    const path = table.get(toIndex);
    if (!path) continue;
    for (let i = 0; i + 1 < path.length; i++) {
      const u = sites[path[i]!]!.id;
      const v = sites[path[i + 1]!]!.id;
      const road = roads.get(roadKey(u, v))!;
      if (u < v) road.strength.forward += pair.strength;
      else road.strength.backward += pair.strength;
    }
  }

  for (const road of roads.values()) {
    if (road.strength.forward === 0 && road.strength.backward === 0) continue;
    road.track = false;
    road.lanes = { forward: laneCount(road.strength.forward), backward: laneCount(road.strength.backward) };
  }
  const streets = new Map([...internal].map(([district, strength]) => [district, streetWidth(strength)] as const));
  return {
    roads: [...roads.values()].sort((x, y) => x.a - y.a || x.b - y.b),
    streets,
  };
}

/**
 * The relative-neighbourhood graph: an edge joins two sites when no third site is closer to both than they
 * are to each other. Returns index pairs.
 */
function relativeNeighbourhoodGraph(sites: readonly VillageSite[]): [number, number][] {
  const edges: [number, number][] = [];
  const d = (i: number, j: number) => Math.hypot(sites[i]!.col - sites[j]!.col, sites[i]!.row - sites[j]!.row);
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const dij = d(i, j);
      let blocked = false;
      for (let k = 0; k < sites.length && !blocked; k++) {
        if (k === i || k === j) continue;
        blocked = Math.max(d(i, k), d(j, k)) < dij;
      }
      if (!blocked) edges.push([i, j]);
    }
  }
  return edges;
}

/** Shortest paths from one site over the graph (Dijkstra with Euclidean weights), as site-index sequences. */
function shortestPaths(sites: readonly VillageSite[], edges: [number, number][], source: number): Map<number, number[]> {
  const n = sites.length;
  const adjacent: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    const w = Math.hypot(sites[u]!.col - sites[v]!.col, sites[u]!.row - sites[v]!.row);
    adjacent[u]!.push([v, w]);
    adjacent[v]!.push([u, w]);
  }
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[source] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u === -1 || dist[i]! < dist[u]!)) u = i;
    if (u === -1) break;
    done[u] = true;
    for (const [v, w] of adjacent[u]!) {
      if (dist[u]! + w < dist[v]!) {
        dist[v] = dist[u]! + w;
        prev[v] = u;
      }
    }
  }
  const paths = new Map<number, number[]>();
  for (let target = 0; target < n; target++) {
    if (dist[target] === Infinity) continue;
    const path: number[] = [];
    for (let at = target; at !== -1; at = prev[at]!) path.unshift(at);
    paths.set(target, path);
  }
  return paths;
}
