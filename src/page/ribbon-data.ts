import {
  type Chunk,
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_DISTRICT_MERGE,
  EVENT_DISTRICT_SPLIT,
  EVENT_FLOORS,
  EVENT_RELOCATE,
  EVENT_RENOVATE,
  SECONDS_PER_DAY,
} from "../shared/format.js";
import type { PlacesFile } from "../shared/places.js";

/** The world-file columns the ribbon reads. A World satisfies this without conversion. */
export interface RibbonSource {
  commitDays: ArrayLike<number>;
  stepCommits: ArrayLike<number>;
  stints: { lot: ArrayLike<number> };
  lots: { block: ArrayLike<number> };
  blocks: { district: ArrayLike<number>; claimed: ArrayLike<number>; village: ArrayLike<number> };
  districts: { index: ArrayLike<number> };
}

/** No District: a Block nobody owns carries this position. */
const NO_DISTRICT = 0xffffffff;

/** Events that change a Building's file (SPEC §11: "file changes"). Scaffolding and colour changes do not count. */
const FILE_CHANGES = new Set<number>([EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_RELOCATE, EVENT_RENOVATE]);

export interface StepActivity {
  commits: number;
  files: number;
  /** District position and its file changes at this Step, in position order. */
  districts: [number, number][];
}

/** One column of the ribbon: the Steps that fall in it, with their activity summed. */
export interface Bin {
  first: number;
  last: number;
  commits: number;
  files: number;
  districts: Map<number, number>;
}

export interface Tick {
  step: number;
  kind: "split" | "merge";
  /** District position. */
  district: number;
}

export interface Founding {
  step: number;
  name: string;
}

export interface YearTick {
  step: number;
  year: number;
}

/** An identity event: a village founded, a District split or merged, or a Relocation, as the tooltip words it. */
export interface Identity {
  step: number;
  text: string;
}

export interface TooltipDistrict {
  name: string;
  count: number;
  colour: string;
}

export interface Tooltip {
  dates: string;
  commits: string;
  files: string;
  districts: TooltipDistrict[];
  identity: string[];
}

const TOP_DISTRICTS = 3;

/**
 * What the ribbon shows, gathered as chunks load: per Step its commits and its file changes by District, the
 * District split and merge ticks, villages founded, year ticks and identity events. Names come from places.json.
 */
export class RibbonData {
  readonly steps: number;
  /** Each Step's day, for date text. */
  readonly commitDays: ArrayLike<number>;
  readonly ticks: Tick[] = [];
  readonly founded: Founding[] = [];
  readonly yearTicks: YearTick[];
  private readonly identity: Identity[] = [];
  private readonly files: Uint32Array;
  private readonly perStep = new Map<number, Map<number, number>>();
  private readonly positionOfBirth = new Map<number, number>();
  /** Commits before each Step: entry i is the commit count through Step i - 1. One extra entry at the end. */
  private readonly commitsBefore: Float64Array;

  constructor(
    private readonly source: RibbonSource,
    private readonly places: PlacesFile | undefined,
    private readonly colourOf: (district: number) => string,
  ) {
    this.steps = source.commitDays.length;
    this.commitDays = source.commitDays;
    this.files = new Uint32Array(this.steps);
    this.commitsBefore = new Float64Array(this.steps + 1);
    for (let step = 0; step < this.steps; step++) {
      this.commitsBefore[step + 1] = this.commitsBefore[step]! + (source.stepCommits[step] ?? 0);
    }
    for (let position = 0; position < source.districts.index.length; position++) {
      this.positionOfBirth.set(source.districts.index[position]!, position);
    }
    this.yearTicks = yearTicksOf(source.commitDays);
    this.foundVillages();
  }

  /** Adds one chunk's events. Chunks must come in order, so the identity list stays sorted by Step. */
  addChunk(chunk: Chunk): void {
    const { eventCommit, eventFile, eventKind, eventStint } = chunk;
    for (let i = 0; i < eventCommit.length; i++) {
      const step = eventCommit[i]!;
      const kind = eventKind[i]!;
      const file = eventFile[i]!;
      if (kind === EVENT_DISTRICT_SPLIT || kind === EVENT_DISTRICT_MERGE) {
        const position = this.positionOfBirth.get(file);
        if (position === undefined) continue;
        const merge = kind === EVENT_DISTRICT_MERGE;
        this.ticks.push({ step, kind: merge ? "merge" : "split", district: position });
        this.identity.push({ step, text: merge ? `${this.nameOf(position)} merged back` : `${this.nameOf(position)} split off` });
        continue;
      }
      if (kind === EVENT_RELOCATE) {
        this.identity.push({ step, text: "A Building relocated" });
      }
      if (!FILE_CHANGES.has(kind)) continue;
      this.files[step]! += 1;
      const position = this.districtOfStint(eventStint[i]!);
      if (position === undefined) continue;
      const counts = this.perStep.get(step) ?? new Map<number, number>();
      counts.set(position, (counts.get(position) ?? 0) + 1);
      this.perStep.set(step, counts);
    }
    this.identity.sort((a, b) => a.step - b.step);
  }

  /** Every real commit in the history. */
  get totalCommits(): number {
    return this.commitsBefore[this.steps]!;
  }

  /** The number of the last real commit in `step`, counting from 1. */
  commitsThrough(step: number): number {
    return this.commitsBefore[Math.min(this.steps, step + 1)]!;
  }

  activityAt(step: number): StepActivity {
    const counts = this.perStep.get(step);
    const districts = counts ? [...counts].sort((a, b) => a[0] - b[0]) : [];
    return { commits: this.source.stepCommits[step] ?? 0, files: this.files[step] ?? 0, districts };
  }

  /** The latest identity event at or before `step`, if there is one. */
  latestIdentity(step: number): Identity | undefined {
    let lo = 0;
    let hi = this.identity.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.identity[mid]!.step <= step) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found < 0 ? undefined : this.identity[found];
  }

  identityBetween(first: number, last: number): Identity[] {
    return this.identity.filter((event) => event.step >= first && event.step <= last);
  }

  colour(position: number): string {
    return this.colourOf(position);
  }

  nameOf(position: number): string {
    const birth = this.source.districts.index[position];
    const place = birth === undefined ? undefined : this.places?.districts.find((d) => d.id === birth);
    return place?.name ?? `District ${(birth ?? position) + 1}`;
  }

  private districtOfStint(stint: number): number | undefined {
    const lot = this.source.stints.lot[stint];
    if (lot === undefined) return undefined;
    const block = this.source.lots.block[lot];
    if (block === undefined) return undefined;
    const position = this.source.blocks.district[block];
    return position === undefined || position === NO_DISTRICT ? undefined : position;
  }

  /** A village is founded when its first Block is claimed; it takes the name of the District that owns that Block. */
  private foundVillages(): void {
    const { village, claimed, district } = this.source.blocks;
    const first = new Map<number, { step: number; block: number }>();
    for (let block = 0; block < village.length; block++) {
      const v = village[block]!;
      const held = first.get(v);
      if (!held || claimed[block]! < held.step) first.set(v, { step: claimed[block]!, block });
    }
    for (const { step, block } of first.values()) {
      const position = district[block]!;
      const name = position === NO_DISTRICT ? "A new village" : this.nameOf(position);
      this.founded.push({ step, name });
      this.identity.push({ step, text: `${name} founded` });
    }
    this.founded.sort((a, b) => a.step - b.step);
    this.identity.sort((a, b) => a.step - b.step);
  }
}

function yearOf(day: number): number {
  return new Date(day * SECONDS_PER_DAY * 1000).getUTCFullYear();
}

function yearTicksOf(commitDays: ArrayLike<number>): YearTick[] {
  const ticks: YearTick[] = [];
  let year = commitDays.length > 0 ? yearOf(commitDays[0]!) : 0;
  for (let step = 1; step < commitDays.length; step++) {
    const next = yearOf(commitDays[step]!);
    if (next !== year) ticks.push({ step, year: next });
    year = next;
  }
  return ticks;
}

/**
 * Groups Steps into columns. `keys[i]` is where Step i starts on the clock, `total` the clock's length, and `width`
 * the number of columns. Only columns with Steps are returned, in order.
 */
export function binSteps(keys: ArrayLike<number>, total: number, width: number, activity: (step: number) => StepActivity): Bin[] {
  const columns = new Map<number, Bin>();
  for (let step = 0; step < keys.length; step++) {
    const col = columnOf(keys[step]!, total, width);
    let bin = columns.get(col);
    if (!bin) {
      bin = { first: step, last: step, commits: 0, files: 0, districts: new Map() };
      columns.set(col, bin);
    }
    const a = activity(step);
    bin.last = step;
    bin.commits += a.commits;
    bin.files += a.files;
    for (const [district, count] of a.districts) bin.districts.set(district, (bin.districts.get(district) ?? 0) + count);
  }
  return [...columns.values()];
}

/** The column a clock value falls in, of `width` equal columns over `total`. Empty clocks all fall in column 0. */
export function columnOf(key: number, total: number, width: number): number {
  if (!(total > 0)) return 0;
  return Math.min(width - 1, Math.max(0, Math.floor((key / total) * width)));
}

export function dayText(day: number): string {
  return new Date(day * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The tooltip of one ribbon column: its date range, commits, file changes, busiest Districts and identity events. */
export function tooltipFor(data: RibbonData, bin: Bin): Tooltip {
  const first = dayText(data.commitDays[bin.first]!);
  const last = dayText(data.commitDays[bin.last]!);
  const districts = [...bin.districts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, TOP_DISTRICTS)
    .map(([position, count]) => ({ name: data.nameOf(position), count, colour: data.colour(position) }));
  return {
    dates: first === last ? first : `${first} to ${last}`,
    commits: plural(bin.commits, "commit"),
    files: plural(bin.files, "file change"),
    districts,
    identity: data.identityBetween(bin.first, bin.last).map((event) => event.text),
  };
}
