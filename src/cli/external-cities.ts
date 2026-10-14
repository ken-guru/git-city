import { NAME_SOURCES } from "../shared/places.js";
import { horizonRadius, placeAngles } from "../shared/externals.js";
import type { Config } from "./config.js";
import { type DependencyReport, type ExternalPlan, type ExternalRegistry, highwayLanes, importerKey } from "./imports/externals.js";
import { type ExternalNameOptions, nameExternals } from "./naming.js";

/**
 * The External Cities as the page draws them (SPEC §7): the horizon, each City's spur and presence, the Outskirts, and
 * each Highway from its declaring District (or the City centre) to its City. The CLI decides every value; the page only
 * animates them. Times are Steps, so they agree with the rest of the output.
 */

export const EXTERNAL_CITIES_FORMAT_VERSION = 1;

/** The Outskirts' display name: a fixed term, not a dependency's name. */
const OUTSKIRTS_NAME = "Outskirts";

export interface CityEntry {
  name: string;
  /** Index in NAME_SOURCES (generated, real, pseudonym). */
  source: number;
  /** Spur angle from the City centre, in radians. */
  angle: number;
  /** Step the City arrives (promotion). */
  from: number;
  /** Step the City departs, or null while it stands. */
  to: number | null;
  members: number;
  /** True for the Outskirts, the single low sprawl that holds every small group. */
  outskirts: boolean;
}

export interface HighwayEntry {
  /** Index into `cities`. */
  city: number;
  /** Index of the declaring District's village in the layout, or -1 for the root manifest's road from the City centre. */
  district: number;
  from: number;
  to: number | null;
  lanes: number;
}

export interface ExternalCitiesFile {
  formatVersion: number;
  /** Distance of the horizon ring from the centre, in Block units. */
  horizon: number;
  cities: CityEntry[];
  highways: HighwayEntry[];
}

export interface CitiesInput {
  registry: ExternalRegistry;
  plan: ExternalPlan;
  /** The dependencies declared now, with their Highway Lanes (`importers`). */
  dependencies: readonly DependencyReport[];
  villages: readonly { col: number; row: number }[];
  districts: readonly { key: string; village: number }[];
  stepOf: (commit: number) => number;
  naming: ExternalNameOptions & { config: Config };
}

export interface CitiesResult {
  file: ExternalCitiesFile;
  /** Real names of External Cities that are not revealed: the output must contain none of them. */
  hiddenKeys: string[];
}

/** The External Cities file: names, presence, Highways and the horizon. */
export function externalCities(input: CitiesInput): CitiesResult {
  const { registry, plan } = input;
  const hasOutskirts = plan.outskirtKeys.length > 0;
  const outskirtsIndex = plan.cities.length;
  const count = plan.cities.length + (hasOutskirts ? 1 : 0);

  // Each identity's City index: a City's members, then the Outskirts' members.
  const cityOf = new Map<string, number>();
  plan.cities.forEach((city, index) => {
    for (const member of city.members) cityOf.set(importerKey(city.ecosystem, member), index);
  });
  for (const id of plan.outskirtKeys) cityOf.set(id, outskirtsIndex);

  const keys = plan.cities.map((c) => c.key);
  const names = nameExternals([...keys, ...(hasOutskirts ? [OUTSKIRTS_NAME] : [])], input.naming.config, input.naming);

  const spans = registry.spansOf();
  const presence = registry.presenceOf();
  const arrived = new Array<number>(count).fill(Infinity);
  const departed = new Array<number | null>(count).fill(null);
  const members = plan.cities.map((c) => c.members.length);
  if (hasOutskirts) members.push(plan.outskirts.length);

  // A City is present over its presence intervals: it arrives at the first and departs when the last one closes.
  plan.cities.forEach((city, index) => {
    const intervals = presence.filter((p) => p.ecosystem === city.ecosystem && p.key === city.key);
    if (intervals.length === 0) return;
    arrived[index] = Math.min(...intervals.map((p) => p.from));
    departed[index] = intervals[intervals.length - 1]!.to ?? null;
  });
  // The Outskirts are present while any of their declarations is.
  if (hasOutskirts) {
    const outer = spans.filter((s) => cityOf.get(importerKey(s.ecosystem, s.name)) === outskirtsIndex);
    if (outer.length > 0) {
      arrived[outskirtsIndex] = Math.min(...outer.map((s) => s.from));
      departed[outskirtsIndex] = outer.some((s) => s.to === undefined) ? null : Math.max(...outer.map((s) => s.to!));
    }
  }

  // Highways: one per declaration span, built when it was added and dismantled when it was removed.
  const importersOf = new Map(input.dependencies.map((d) => [importerKey(d.ecosystem, d.name), d.importers] as const));
  const villageOf = new Map(input.districts.map((d) => [d.key, d.village] as const));
  const highways: HighwayEntry[] = [];
  const firstDeclaring: ({ from: number; village: number } | undefined)[] = new Array(count).fill(undefined);
  for (const span of spans) {
    const id = importerKey(span.ecosystem, span.name);
    const city = cityOf.get(id);
    if (city === undefined) continue;
    const village = span.manifest === "" ? undefined : villageOf.get(span.manifest);
    highways.push({
      city,
      district: village ?? -1,
      from: input.stepOf(span.from),
      to: span.to === undefined ? null : input.stepOf(span.to),
      lanes: highwayLanes(importersOf.get(id) ?? 0),
    });
    if (village !== undefined && (firstDeclaring[city] === undefined || span.from < firstDeclaring[city]!.from)) {
      firstDeclaring[city] = { from: span.from, village };
    }
  }

  // A spur sits at the angle of the village that first declared its City; a root-only City sits at angle 0.
  const desired = firstDeclaring.map((at) => {
    if (at === undefined) return 0;
    const v = input.villages[at.village]!;
    return Math.atan2(v.row, v.col);
  });
  const angles = placeAngles(desired);

  const cities: CityEntry[] = names.map((name, i) => ({
    name: name.name,
    source: name.source,
    angle: angles[i]!,
    from: Number.isFinite(arrived[i]!) ? input.stepOf(arrived[i]!) : 0,
    to: departed[i] === null || departed[i] === undefined ? null : input.stepOf(departed[i]!),
    members: members[i]!,
    outskirts: i === outskirtsIndex,
  }));

  const extent = input.villages.reduce((max, v) => Math.max(max, Math.hypot(v.col, v.row)), 0);
  const hiddenKeys = keys.filter((_, i) => names[i]!.source !== NAME_SOURCES.indexOf("real"));
  return {
    file: { formatVersion: EXTERNAL_CITIES_FORMAT_VERSION, horizon: horizonRadius(extent), cities, highways },
    hiddenKeys,
  };
}
