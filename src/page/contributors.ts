/**
 * Contributors and commit messages on the page (SPEC §11): the pins over changed Buildings, the legend, and the caption.
 * Everything here is pure, so it can be tested without a browser; the THREE layer and the DOM sit on top of it.
 */
import { type Chunk, EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_RELOCATE, EVENT_RENOVATE, type World } from "../shared/format.js";
import { easeOutCubic } from "./state.js";

/** The people who get a colour of their own, and the legend's list (SPEC §11). */
export const TOP_PEOPLE = 8;
/** Most pins over one commit's changed Buildings (SPEC §11). */
export const PINS_PER_COMMIT = 12;
/** Commits a pin lives for: it settles in, holds, and fades by this many commits (SPEC §11). */
export const PIN_LIFE = 6;
/** Hover or tap on a legend entry lights up that person's Buildings from this many recent commits (SPEC §11). */
export const HIGHLIGHT_COMMITS = 120;
/** Above this many commits in the window, the caption becomes a summary (SPEC §11: about 6 commits in 2 s). */
export const SUMMARY_COMMITS = 6;
export const SUMMARY_SECONDS = 2;

/**
 * The green band that paving never uses and that the countryside's greens sit in, in hue degrees (SPEC §8). This is
 * the assumption behind the colour choice: the band is 60 to 170.
 */
export const GREEN_BAND: readonly [number, number] = [60, 170];
/**
 * The smallest hue distance from any built-in Theme's paving hue that the top people's colours keep. Hue alone cannot
 * give more than this to eight people: a 10-degree floor fits six colours, so the colours rely on saturation too (pins
 * are fully saturated, paving is medium-low saturation).
 */
export const PAVING_CLEARANCE = 5;
/** The least hue distance between any two top people's colours, so the legend's swatches stay told apart. */
export const PERSON_SEPARATION = 25;
/**
 * The top people's colours, in rank order: HSL at saturation 0.78 and lightness 0.52, for the hues 0, 50, 175, 200, 227,
 * 252, 285 and 310. These are the largest set of eight that keeps PAVING_CLEARANCE from every paving hue, stays out of
 * GREEN_BAND and keeps PERSON_SEPARATION between themselves. The tests check each of these claims against the themes.
 */
export const PERSON_COLOURS: readonly number[] = [0xe42525, 0xe4c425, 0x25e4d4, 0x25a4e4, 0x254ee4, 0x4b25e4, 0xb425e4, 0xe425c4];
/** Everyone outside the top people. */
export const OTHER_COLOUR = 0x6b7785;
/** Automation has its own grey. */
export const AUTOMATION_COLOUR = 0xb4bcc6;

/** The world file's contributor columns, as the page reads them. */
/** The world file's contributor columns, as the page reads them. */
export type ContributorColumns = NonNullable<World["contributors"]>;

export interface People {
  /** Commits per Contributor, over the whole Timeline. */
  commits: number[];
  /** Automation's commits, all bots together. */
  automationCommits: number;
  /** Non-automation Contributors, busiest first: at most TOP_PEOPLE of them. */
  top: number[];
  /** Per Contributor: its index in `top`, or -1. */
  slotOf: number[];
  /** People outside the top list. */
  more: number;
  /** The colour a Contributor's pins and legend swatch use. */
  colourOf(contributor: number): number;
}

/** Ranks the Contributors by commits. Ties keep the order they first committed in. */
export function rankPeople(columns: ContributorColumns, stepCommits: Uint32Array): People {
  const count = columns.name.length;
  const commits = new Array<number>(count).fill(0);
  for (let step = 0; step < columns.ofStep.length; step++) {
    const who = columns.ofStep[step]!;
    if (who < count) commits[who]! += stepCommits[step] ?? 0;
  }
  let automationCommits = 0;
  const people: number[] = [];
  for (let c = 0; c < count; c++) {
    if (columns.automation[c]) automationCommits += commits[c]!;
    else people.push(c);
  }
  const ranked = [...people].sort((a, b) => commits[b]! - commits[a]! || a - b);
  const top = ranked.slice(0, TOP_PEOPLE);
  const slotOf = new Array<number>(count).fill(-1);
  top.forEach((c, slot) => (slotOf[c] = slot));
  return {
    commits,
    automationCommits,
    top,
    slotOf,
    more: ranked.length - top.length,
    colourOf(contributor: number) {
      const slot = slotOf[contributor] ?? -1;
      if (slot >= 0) return PERSON_COLOURS[slot]!;
      return columns.automation[contributor] ? AUTOMATION_COLOUR : OTHER_COLOUR;
    },
  };
}

/** The Buildings each commit changes, from the chunks' events. Built as chunks arrive; the first event kinds only. */
export interface ChangeIndex {
  add(chunk: Pick<Chunk, "eventCommit" | "eventStint" | "eventKind">): void;
  /** The stints a pin shows for a commit: at most PINS_PER_COMMIT, in event order, each once. */
  stintsAt(commit: number): number[];
  /** Every stint a commit changed, uncapped: a highlight lights up all of a person's Buildings. */
  allStintsAt(commit: number): number[];
}

/** The events that change a Building: it is added, deleted, re-floored, relocated or renovated. */
const CHANGING = new Set<number>([EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_RELOCATE, EVENT_RENOVATE]);

export function changesIndex(): ChangeIndex {
  const byCommit = new Map<number, number[]>();
  return {
    add(chunk) {
      for (let i = 0; i < chunk.eventCommit.length; i++) {
        if (!CHANGING.has(chunk.eventKind[i]!)) continue;
        const commit = chunk.eventCommit[i]!;
        const stint = chunk.eventStint[i]!;
        const list = byCommit.get(commit) ?? [];
        if (!list.includes(stint)) list.push(stint);
        byCommit.set(commit, list);
      }
    },
    stintsAt(commit) {
      return (byCommit.get(commit) ?? []).slice(0, PINS_PER_COMMIT);
    },
    allStintsAt(commit) {
      return byCommit.get(commit) ?? [];
    },
  };
}

/**
 * How visible a pin is, `age` commits after its commit (SPEC §11): it settles in over about one commit, holds, and
 * fades out by PIN_LIFE. Zero before its commit and after its life.
 */
export function pinScale(age: number): number {
  if (!(age >= 0) || age >= PIN_LIFE) return 0;
  const grow = easeOutCubic(Math.min(1, age));
  const fade = Math.min(1, (PIN_LIFE - age) / 2);
  return grow * fade;
}

/**
 * Real commits and distinct people in the Steps from `first` to `last`, inclusive. `perCommit` is true when every Step
 * in the window is a single commit: a grouped Step (SPEC §9) passes many commits at once and is not summarised.
 */
export function windowOf(
  ofStep: Uint32Array,
  stepCommits: Uint32Array,
  first: number,
  last: number,
): { commits: number; people: number; perCommit: boolean } {
  let commits = 0;
  let perCommit = true;
  const who = new Set<number>();
  for (let step = Math.max(0, first); step <= Math.min(last, ofStep.length - 1); step++) {
    const count = stepCommits[step] ?? 0;
    commits += count;
    if (count !== 1) perCommit = false;
    who.add(ofStep[step]!);
  }
  return { commits, people: who.size, perCommit };
}

/**
 * Whether the caption is a summary (SPEC §11): more than SUMMARY_COMMITS real commits in the window, on per-commit
 * Steps. A grouped history keeps its per-Step caption at normal speed.
 */
export function isSummary(window: { commits: number; perCommit: boolean }): boolean {
  return window.perCommit && window.commits > SUMMARY_COMMITS;
}

/** The caption under the ribbon: the date, the Contributor and the message, leaving out what is absent. */
export function captionLine(parts: { date: string; contributor?: string; message?: string }): string {
  return [parts.date, parts.contributor, parts.message].filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

/** The caption for a busy stretch of commits (SPEC §11). */
export function summaryLine(commits: number, people: number, latest?: string): string {
  const line = `${commits} commits by ${people} ${people === 1 ? "person" : "people"}`;
  return latest === undefined ? line : `${line} · latest: ${latest}`;
}
