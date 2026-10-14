import { describe, expect, it } from "vitest";
import type { CommitRecord } from "../src/cli/history.js";
import { chooseStepLevel, groupTimeline, peakStanding, planSteps, RECENT_COMMITS } from "../src/cli/steps.js";
import { TimelineBuilder } from "../src/cli/timeline.js";
import { EVENT_ADD, EVENT_DELETE, EVENT_FLOORS } from "../src/shared/format.js";

/**
 * Seams under test: `planSteps` (which commits group into which Step), `groupTimeline` (the Timeline with its
 * commits renumbered as Steps), `chooseStepLevel` (the smallest Step that fits) and `peakStanding`.
 * Expected days come from ISO dates, not from the code under test.
 */

/** Days since 1970-01-01 UTC for an ISO date. */
function day(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

function commit(d: number, change: Partial<Omit<CommitRecord, "day">> = {}): CommitRecord {
  return { day: d, seconds: d * 86_400, added: [], deleted: [], modified: [], writes: [], ...change };
}

function run(commits: CommitRecord[]) {
  const builder = new TimelineBuilder();
  for (const c of commits) builder.add(c);
  return builder.result();
}

describe("planSteps", () => {
  it("keeps one Step per commit at the commit level", () => {
    const days = Int32Array.of(day("2024-01-01"), day("2024-01-01"), day("2024-01-01"));
    const plan = planSteps(days, "commit", 0);
    expect([...plan.stepOf]).toEqual([0, 1, 2]);
    expect([...plan.stepCommits]).toEqual([1, 1, 1]);
  });

  it("groups contiguous commits on the same day into one day Step", () => {
    const days = Int32Array.of(day("2024-01-01"), day("2024-01-01"), day("2024-01-02"), day("2024-01-02"), day("2024-01-02"));
    const plan = planSteps(days, "day", days.length);
    expect([...plan.stepOf]).toEqual([0, 0, 1, 1, 1]);
    expect([...plan.stepCommits]).toEqual([2, 3]);
    expect([...plan.firstCommit]).toEqual([0, 2]);
  });

  it("groups by Monday-start weeks", () => {
    // 2024-01-06 is a Saturday and 2024-01-07 a Sunday (same week); 2024-01-08 is the next Monday.
    const days = Int32Array.of(day("2024-01-06"), day("2024-01-07"), day("2024-01-08"));
    expect([...planSteps(days, "week", days.length).stepOf]).toEqual([0, 0, 1]);
  });

  it("groups by calendar month", () => {
    const days = Int32Array.of(day("2024-01-31"), day("2024-02-01"), day("2024-02-29"));
    expect([...planSteps(days, "month", days.length).stepOf]).toEqual([0, 1, 1]);
  });

  it("keeps commits from the recent cut-off onwards as one Step each", () => {
    const days = Int32Array.of(day("2024-01-01"), day("2024-01-01"), day("2024-01-01"), day("2024-01-01"));
    const plan = planSteps(days, "month", 2);
    expect([...plan.stepOf]).toEqual([0, 0, 1, 2]);
  });
});

describe("groupTimeline", () => {
  it("is the identity at the commit level", () => {
    const data = run([commit(day("2024-01-01"), { added: ["a.ts"], modified: [], lines: new Map([["a.ts", 9]]) })]);
    const grouped = groupTimeline(data, planSteps(data.commitDays, "commit", 0));
    expect([...grouped.commitDays]).toEqual([...data.commitDays]);
    expect([...grouped.eventCommit]).toEqual([...data.eventCommit]);
    expect([...grouped.eventKind]).toEqual([...data.eventKind]);
  });

  it("renumbers events to the Step of their commit and keeps each file's last Floors in a Step", () => {
    // Three commits on one day: a file grows to 3 Floors, then drops to 2 (lines 9 -> 50 -> 25).
    const data = run([
      commit(day("2024-01-01"), { added: ["a.ts"], lines: new Map([["a.ts", 9]]) }),
      commit(day("2024-01-01"), { modified: ["a.ts"], lines: new Map([["a.ts", 50]]) }),
      commit(day("2024-01-01"), { modified: ["a.ts"], lines: new Map([["a.ts", 25]]) }),
      commit(day("2024-01-02"), { added: ["b.ts"] }),
    ]);
    const grouped = groupTimeline(data, planSteps(data.commitDays, "day", data.commitDays.length));
    expect([...grouped.commitDays]).toEqual([day("2024-01-01"), day("2024-01-02")]);
    expect([...grouped.eventCommit]).toEqual([0, 0, 1]);
    const floors = [...grouped.eventKind].map((k, i) => [k, grouped.eventValue[i]]).filter(([k]) => k === EVENT_FLOORS);
    expect(floors).toEqual([[EVENT_FLOORS, 2]]);
    expect([...grouped.eventKind]).toEqual([EVENT_ADD, EVENT_FLOORS, EVENT_ADD]);
  });

  it("keeps add and delete events in full", () => {
    const data = run([
      commit(day("2024-01-01"), { added: ["a.ts"] }),
      commit(day("2024-01-01"), { deleted: ["a.ts"] }),
    ]);
    const grouped = groupTimeline(data, planSteps(data.commitDays, "month", data.commitDays.length));
    expect([...grouped.eventKind]).toEqual([EVENT_ADD, EVENT_DELETE]);
    expect([...grouped.commitDays]).toEqual([day("2024-01-01")]);
  });
});

describe("chooseStepLevel", () => {
  // The budget is measured in the caller; here `measure` answers for each level.
  const over = { firstPlayBytes: 2_000_000, totalBytes: 20_000_000 };
  const under = { firstPlayBytes: 500_000, totalBytes: 5_000_000 };

  it("picks the smallest Step that fits", () => {
    const sizes = { commit: over, day: over, week: under, month: under } as const;
    const choice = chooseStepLevel("auto", 10_000, (level) => sizes[level]);
    expect(choice.level).toBe("week");
    expect(choice.warnings).toEqual([]);
  });

  it("keeps the commit level when it fits and history is short", () => {
    expect(chooseStepLevel("auto", 500, () => under).level).toBe("commit");
  });

  it("groups by at least a day once history passes 50k commits, even when it fits", () => {
    expect(chooseStepLevel("auto", 60_000, () => under).level).toBe("day");
  });

  it("warns and uses the month Step when even that does not fit", () => {
    const choice = chooseStepLevel("auto", 10_000, () => over);
    expect(choice.level).toBe("month");
    expect(choice.warnings.length).toBeGreaterThan(0);
  });

  it("refuses grouping at the commit setting, and only warns", () => {
    const choice = chooseStepLevel("commit", 10_000, () => over);
    expect(choice.level).toBe("commit");
    expect(choice.warnings.length).toBeGreaterThan(0);
  });

  it("forces the named Step level", () => {
    expect(chooseStepLevel("week", 10, () => under)).toEqual({ level: "week", recentFrom: 10, warnings: [] });
  });

  it("keeps the newest commits per commit under auto, and groups the whole history when a level is forced", () => {
    expect(chooseStepLevel("auto", 10_000, () => under).recentFrom).toBe(10_000 - RECENT_COMMITS);
    expect(chooseStepLevel("week", 10_000, () => under).recentFrom).toBe(10_000);
  });
});

describe("peakStanding", () => {
  it("counts the most Buildings standing at once", () => {
    const data = run([
      commit(day("2024-01-01"), { added: ["a.ts", "b.ts", "c.ts"] }),
      commit(day("2024-01-02"), { deleted: ["a.ts"] }),
      commit(day("2024-01-03"), { added: ["d.ts"] }),
    ]);
    expect(peakStanding(data.eventKind)).toBe(3);
  });
});
