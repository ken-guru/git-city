import { EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_LANGUAGE, EVENT_SCAFFOLD_OFF, EVENT_SCAFFOLD_ON } from "../shared/format.js";
import type { TimelineSetting } from "./config.js";
import { FIRST_PLAY_BUDGET_BYTES, TOTAL_BUDGET_BYTES } from "./chunks.js";
import type { TimelineData } from "./timeline.js";

/**
 * Steps (SPEC §9): older commits group into a day, week or month, so the Timeline plays them as one stretch.
 * Grouping renumbers the output's commits to Steps and collapses the events a Step makes redundant. It never
 * touches the layout: Lots and positions are decided per commit, before this module runs.
 */

export const STEP_LEVELS = ["commit", "day", "week", "month"] as const;
export type StepLevel = (typeof STEP_LEVELS)[number];

/** The newest commits that always stay one Step each. */
export const RECENT_COMMITS = 2000;
/** History this long is grouped even when it fits the budget (SPEC §9). */
export const LARGE_HISTORY_COMMITS = 50_000;
/** Buildings standing at once above this draws a scale warning (SPEC §10). */
export const PEAK_BUILDINGS_WARNING = 20_000;

/** Which Step each commit belongs to, and each Step's first commit and commit count. */
export interface StepPlan {
  level: StepLevel;
  /** Per commit: its Step's sequence number. */
  stepOf: Uint32Array;
  /** Per Step: the sequence number of its first commit. */
  firstCommit: Uint32Array;
  /** Per Step: how many commits it holds. */
  stepCommits: Uint32Array;
}

/** A run of Steps at one level, for the build summary. */
export interface StepEra {
  level: StepLevel;
  /** First commit of the era and the commit after its last (exclusive). */
  fromCommit: number;
  toCommit: number;
  steps: number;
}

/**
 * Groups contiguous commits that fall in the same day, week or month. Commits from `recentFrom` on stay one Step
 * each, and so does every commit at the commit level.
 */
export function planSteps(days: Int32Array, level: StepLevel, recentFrom: number): StepPlan {
  const n = days.length;
  const stepOf = new Uint32Array(n);
  const firstCommit: number[] = [];
  const stepCommits: number[] = [];
  let openKey: number | undefined;
  for (let c = 0; c < n; c++) {
    const key = level === "commit" || c >= recentFrom ? undefined : bucketOf(days[c]!, level);
    const last = firstCommit.length - 1;
    if (key !== undefined && key === openKey) {
      stepOf[c] = last;
      stepCommits[last]!++;
    } else {
      firstCommit.push(c);
      stepCommits.push(1);
      stepOf[c] = firstCommit.length - 1;
    }
    openKey = key;
  }
  return {
    level,
    stepOf,
    firstCommit: Uint32Array.from(firstCommit),
    stepCommits: Uint32Array.from(stepCommits),
  };
}

/** The first commit index that stays per commit, for a history of `commits` commits. */
export function recentFromFor(commits: number): number {
  return Math.max(0, commits - RECENT_COMMITS);
}

/** The eras of a plan: the older grouped stretch, then the recent per-commit one (see planSteps for `recentFrom`). */
export function stepEras(plan: StepPlan, commits: number, recentFrom: number): StepEra[] {
  if (commits === 0) return [];
  if (plan.level === "commit") return [{ level: "commit", fromCommit: 0, toCommit: commits, steps: plan.stepOf.length }];
  const split = Math.min(recentFrom, commits);
  const eras: StepEra[] = [];
  if (split > 0) eras.push({ level: plan.level, fromCommit: 0, toCommit: split, steps: plan.stepOf[split - 1]! + 1 });
  if (split < commits) eras.push({ level: "commit", fromCommit: split, toCommit: commits, steps: commits - split });
  return eras;
}

/** The steps' one-line descriptions for the build summary, one per era. */
export function describeSteps(eras: readonly StepEra[]): string[] {
  // Only history that is actually grouped is reported; a history kept per commit prints nothing.
  if (eras.every((era) => era.level === "commit")) return [];
  return eras.map((era) => {
    const range = `commits ${era.fromCommit + 1} to ${era.toCommit}`;
    return era.level === "commit"
      ? `Steps: ${range} one commit per Step`
      : `Steps: ${range} in ${era.steps} ${era.level} Step${era.steps === 1 ? "" : "s"}`;
  });
}

/**
 * The Timeline with its commits renumbered as Steps: `commitDays` takes each Step's first day, `stepCommits` its
 * count, and events move to their commit's Step. Within a Step, a file keeps only its last Floors and Language, and
 * only the scaffolding change that leaves it different; add and delete events are always kept.
 */
export function groupTimeline(data: TimelineData, plan: StepPlan): TimelineData {
  const eventCount = data.eventCommit.length;
  const stepOfEvent = (i: number) => plan.stepOf[data.eventCommit[i]!]!;

  // The last event of each (Step, file, group) decides that group: Floors, Language, or scaffolding.
  const groupOf = (kind: number): number => {
    if (kind === EVENT_FLOORS) return 0;
    if (kind === EVENT_LANGUAGE) return 1;
    if (kind === EVENT_SCAFFOLD_ON || kind === EVENT_SCAFFOLD_OFF) return 2;
    return -1;
  };
  const fileSpan = data.fileCount + 1;
  const lastOf = new Map<number, number>();
  for (let i = 0; i < eventCount; i++) {
    const group = groupOf(data.eventKind[i]!);
    if (group < 0) continue;
    lastOf.set((stepOfEvent(i) * fileSpan + data.eventFile[i]!) * 3 + group, i);
  }

  const scaffolded = new Set<number>();
  const keep: number[] = [];
  for (let i = 0; i < eventCount; i++) {
    const kind = data.eventKind[i]!;
    const file = data.eventFile[i]!;
    if (kind === EVENT_ADD) {
      keep.push(i);
    } else if (kind === EVENT_DELETE) {
      scaffolded.delete(file);
      keep.push(i);
    } else if (kind === EVENT_SCAFFOLD_ON || kind === EVENT_SCAFFOLD_OFF) {
      if (lastOf.get((stepOfEvent(i) * fileSpan + file) * 3 + 2) !== i) continue;
      const up = kind === EVENT_SCAFFOLD_ON;
      if (up !== scaffolded.has(file)) keep.push(i);
      if (up) scaffolded.add(file);
      else scaffolded.delete(file);
    } else if (groupOf(kind) < 0) {
      keep.push(i);
    } else if (lastOf.get((stepOfEvent(i) * fileSpan + file) * 3 + groupOf(kind)) === i) {
      keep.push(i);
    }
  }

  return {
    ...data,
    commitDays: Int32Array.from(plan.firstCommit, (c) => data.commitDays[c]!),
    stepCommits: Uint32Array.from(plan.stepCommits),
    eventCommit: Uint32Array.from(keep, (i) => stepOfEvent(i)),
    eventFile: Uint32Array.from(keep, (i) => data.eventFile[i]!),
    eventKind: Uint8Array.from(keep, (i) => data.eventKind[i]!),
    eventValue: Uint8Array.from(keep, (i) => data.eventValue[i]!),
  };
}

/** The most Buildings standing at once, from the add and delete events. */
export function peakStanding(eventKind: Uint8Array): number {
  let standing = 0;
  let peak = 0;
  for (const kind of eventKind) {
    if (kind === EVENT_ADD) standing++;
    else if (kind === EVENT_DELETE) standing--;
    if (standing > peak) peak = standing;
  }
  return peak;
}

/** The sizes a level produces, against the SPEC §9 budget. */
export interface MeasuredSize {
  firstPlayBytes: number;
  totalBytes: number;
}

export interface StepChoice {
  level: StepLevel;
  /** The first commit that stays per commit: the newest RECENT_COMMITS under auto, and none (commits) when a level is forced. */
  recentFrom: number;
  warnings: string[];
}

/**
 * Chooses the Step level for a run. A pinned setting is used as given, and a forced day, week or month groups the
 * whole history; `commit` only warns when the output is over budget. `auto` keeps per-commit Steps for the newest
 * commits, and when the history is short and the output fits it stays per commit; otherwise it tries day, week and
 * month, taking the first that fits. Above LARGE_HISTORY_COMMITS, auto always groups.
 */
export function chooseStepLevel(setting: TimelineSetting, commits: number, measure: (level: StepLevel) => MeasuredSize): StepChoice {
  if (setting === "commit") {
    const warnings: string[] = [];
    if (!fits(measure("commit"))) {
      warnings.push("the output is over the size budget at one commit per Step; scale.timeline is \"commit\", so grouping is off");
    }
    return { level: "commit", recentFrom: commits, warnings };
  }
  if (setting !== "auto") return { level: setting, recentFrom: commits, warnings: [] };

  const recentFrom = recentFromFor(commits);
  if (commits <= LARGE_HISTORY_COMMITS && fits(measure("commit"))) return { level: "commit", recentFrom, warnings: [] };
  for (const level of ["day", "week", "month"] as const) {
    if (fits(measure(level))) return { level, recentFrom, warnings: [] };
  }
  return {
    level: "month",
    recentFrom,
    warnings: ["the output is still over the size budget at month Steps; it is written anyway"],
  };
}

function fits(size: MeasuredSize): boolean {
  return size.firstPlayBytes <= FIRST_PLAY_BUDGET_BYTES && size.totalBytes <= TOTAL_BUDGET_BYTES;
}

/** A day number, a Monday-start week number, or a month number, for grouping. */
function bucketOf(day: number, level: Exclude<StepLevel, "commit">): number {
  if (level === "day") return day;
  if (level === "week") return Math.floor((day + 3) / 7);
  const date = new Date(day * 86_400_000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

