import { describe, expect, it } from "vitest";
import type { CommitRecord } from "../src/cli/history.js";
import { LayoutBuilder } from "../src/cli/layout.js";
import { stintTable } from "../src/cli/build.js";
import { TimelineBuilder } from "../src/cli/timeline.js";
import { EVENT_ADD, EVENT_RELOCATE, EVENT_RENOVATE } from "../src/shared/format.js";

function commit(day: number, change: Partial<Omit<CommitRecord, "day">> = {}): CommitRecord {
  return { day, added: [], deleted: [], modified: [], writes: [], ...change };
}

/** Runs the Timeline and the layout over the same commits, the way the pipeline does. */
function runBoth(commits: CommitRecord[]) {
  const timeline = new TimelineBuilder();
  const layout = new LayoutBuilder({ seed: 11 });
  for (const c of commits) layout.apply({ ...timeline.add(c), widths: [] });
  return { data: timeline.result(), layout: layout.result() };
}

/** Three commits: a Renovation of src/app.ts, then a Relocation of a/x.ts out of a directory that keeps a/y.ts. */
const history = [
  commit(1, { added: ["src/app.ts", "a/x.ts", "a/y.ts"] }),
  commit(2, { renamed: [{ from: "src/app.ts", to: "src/app.md" }] }),
  commit(3, { renamed: [{ from: "a/x.ts", to: "b/x.ts" }] }),
];

describe("Stints", () => {
  it("gives every file a Stint at birth, and a new one for each Renovation and Relocation", () => {
    const { data } = runBoth(history);

    // Births: files 0, 1, 2 as stints 0, 1, 2. Then file 0's Renovation (stint 3) and file 1's Relocation (stint 4).
    expect([...data.stints.file]).toEqual([0, 1, 2, 0, 1]);
    expect([...data.stints.buildingType]).toEqual([0, 0, 0, 2, 0]);
    expect([...data.stints.from]).toEqual([-1, -1, -1, 0, -1]);
    expect(data.eventKind[data.eventKind.indexOf(EVENT_RENOVATE)]).toBe(EVENT_RENOVATE);
    expect(data.eventStint[data.eventKind.indexOf(EVENT_RENOVATE)]).toBe(3);
    expect(data.eventStint[data.eventKind.indexOf(EVENT_RELOCATE)]).toBe(4);
    expect(data.eventStint[data.eventKind.indexOf(EVENT_ADD)]).toBe(0);
  });

  it("gives the Lots of the layout to Stints, a Renovation standing on its predecessor's Lot", () => {
    const { data, layout } = runBoth(history);

    const table = stintTable(layout.lots, data.stints);
    // Lots in birth order: files 0, 1 and 2 at birth, then file 1's Relocation.
    expect(layout.lots.map((l) => l.file)).toEqual([0, 1, 2, 1]);
    expect([...table.lot]).toEqual([0, 1, 2, 0, 3]);
  });
});

describe("stintTable", () => {
  const lots = [
    { file: 0, block: 0, slot: 0, slots: 1 },
    { file: 1, block: 0, slot: 1, slots: 1 },
    { file: 0, block: 0, slot: 2, slots: 1 },
  ];

  it("gives a Renovation the Lot of the Stint it replaces", () => {
    const table = stintTable(lots.slice(0, 2), { file: Uint32Array.of(0, 1, 1), buildingType: Uint8Array.of(0, 0, 0), from: Int32Array.of(-1, -1, 1) });
    expect([...table.lot]).toEqual([0, 1, 1]);
  });

  it("refuses a Stint the layout gave no Lot", () => {
    expect(() => stintTable(lots.slice(0, 1), { file: Uint32Array.of(0, 1), buildingType: Uint8Array.of(0, 0), from: Int32Array.of(-1, -1) })).toThrow(
      /no Lot/,
    );
  });

  it("refuses Lots that no Stint stands on", () => {
    expect(() => stintTable(lots, { file: Uint32Array.of(0), buildingType: Uint8Array.of(0), from: Int32Array.of(-1) })).toThrow(/no Stint/);
  });
});
