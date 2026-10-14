import { describe, expect, it } from "vitest";
import type { CommitRecord } from "../src/cli/history.js";
import { Pipeline, type PipelineOptions, type RunState } from "../src/cli/pipeline.js";
import type { LayoutSnapshot } from "../src/cli/layout.js";

/**
 * Seam under test: `Pipeline` fed one commit at a time (the timeline, the import graph and the layout together),
 * observed through its results and its snapshot. Commits are literal records with the facts the history step would give.
 */

const options: PipelineOptions = { seed: 7, readText: async () => "" };

/** A text file written in a commit, with the raw import specifiers the facts layer would hold for it. */
function write(path: string, imports: string[] = []): CommitRecord["writes"][number] {
  return {
    path,
    blob: path,
    facts: {
      kind: "text",
      size: 10,
      lines: 1,
      lineEquivalent: 1,
      imports: imports.map((specifier) => ({ specifier, kind: "static" as const })),
    },
  };
}

function commitOf(day: number, writes: CommitRecord["writes"], deleted: string[] = []): CommitRecord {
  return {
    day,
    seconds: day * 86_400,
    added: writes.map((w) => w.path),
    deleted,
    modified: [],
    writes,
    lines: new Map(writes.map((w) => [w.path, w.facts.lineEquivalent])),
  };
}

/** A shared file imported by three files (fan-in 3, width step 1), then by seven more (fan-in 10, step 2). */
const history: CommitRecord[] = [
  commitOf(0, [
    write("src/shared.ts"),
    write("src/a.ts", ["./shared"]),
    write("src/b.ts", ["./shared"]),
    write("src/c.ts", ["./shared"]),
  ]),
  commitOf(
    1,
    Array.from({ length: 7 }, (_, i) => write(`src/d${i}.ts`, ["./shared"])),
  ),
];

function lotOf(lots: { file: number; slots: number; slot: number }[], file: number) {
  return lots.find((l) => l.file === file);
}

describe("pipeline", () => {
  it("widens a Building's Lot when its fan-in reaches a wider step, and the Lot keeps its place", async () => {
    const pipeline = Pipeline.fresh(options);
    await pipeline.add(history[0]!);
    expect(lotOf(pipeline.layout.result().lots, 0)).toEqual({ file: 0, block: 0, slot: 0, slots: 3 });

    await pipeline.add(history[1]!);

    expect(lotOf(pipeline.layout.result().lots, 0)).toEqual({ file: 0, block: 0, slot: 0, slots: 4 });
  });

  it("resumes from a JSON snapshot exactly as a run that never stopped", async () => {
    const whole = Pipeline.fresh(options);
    for (const record of history) await whole.add(record);

    const first = Pipeline.fresh(options);
    await first.add(history[0]!);
    const run: RunState = JSON.parse(JSON.stringify(first.runState())) as RunState;
    const layout: LayoutSnapshot = JSON.parse(JSON.stringify(first.layout.snapshot())) as LayoutSnapshot;
    const resumed = Pipeline.restore(options, run, layout)!;
    await resumed.add(history[1]!);

    expect(resumed.layout.result()).toEqual(whole.layout.result());
    expect(resumed.timeline.result()).toEqual(whole.timeline.result());
  });

  it("refuses a layout snapshot from another City seed", () => {
    const pipeline = Pipeline.fresh(options);
    expect(Pipeline.restore({ ...options, seed: 8 }, pipeline.runState(), pipeline.layout.snapshot())).toBeUndefined();
  });
});
