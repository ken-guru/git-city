import { describe, expect, it } from "vitest";
import type { CommitRecord } from "../src/cli/history.js";
import { Pipeline, type PipelineOptions } from "../src/cli/pipeline.js";
import { EVENT_ADD, EVENT_DELETE } from "../src/shared/format.js";

/**
 * Seam under test: `Pipeline` with `exclude` globs. Excluded paths never reach the Timeline; a rename across the
 * boundary is an add (into the City) or a delete (out of it). Observed through the Timeline's result.
 */

function write(path: string): CommitRecord["writes"][number] {
  return {
    path,
    blob: path,
    facts: { kind: "text", size: 10, lines: 1, lineEquivalent: 1, imports: [] },
  };
}

function commit(day: number, change: Partial<Omit<CommitRecord, "day">> & { paths?: string[] } = {}): CommitRecord {
  const { paths = [], ...rest } = change;
  return {
    day,
    added: paths,
    deleted: [],
    modified: [],
    writes: paths.map(write),
    lines: new Map(paths.map((p) => [p, 1])),
    ...rest,
  };
}

async function run(exclude: string[], commits: CommitRecord[]) {
  const options: PipelineOptions = { seed: 7, readText: async () => "", exclude };
  const pipeline = Pipeline.fresh(options);
  for (const c of commits) await pipeline.add(c);
  return pipeline.timeline.result();
}

describe("Pipeline with exclude globs", () => {
  it("leaves excluded files out of the Timeline", async () => {
    const result = await run(["vendor/**"], [commit(1, { paths: ["src/a.ts", "vendor/lib.js"] })]);
    expect(result.filePaths).toEqual(["src/a.ts"]);
    expect(result.fileCount).toBe(1);
  });

  it("treats a rename into an excluded folder as a delete", async () => {
    const result = await run(
      ["vendor/**"],
      [
        commit(1, { paths: ["src/a.ts"] }),
        {
          day: 2,
          added: ["vendor/a.ts"],
          deleted: ["src/a.ts"],
          modified: [],
          renamed: [{ from: "src/a.ts", to: "vendor/a.ts" }],
          writes: [write("vendor/a.ts")],
        },
      ],
    );
    expect([...result.eventKind]).toEqual([EVENT_ADD, EVENT_DELETE]);
  });

  it("treats a rename out of an excluded folder as an add", async () => {
    const result = await run(
      ["vendor/**"],
      [
        commit(1, { paths: ["vendor/a.ts"] }),
        {
          day: 2,
          added: ["src/a.ts"],
          deleted: ["vendor/a.ts"],
          modified: [],
          renamed: [{ from: "vendor/a.ts", to: "src/a.ts" }],
          writes: [write("src/a.ts")],
        },
      ],
    );
    expect(result.filePaths).toEqual(["src/a.ts"]);
    expect([...result.eventKind]).toEqual([EVENT_ADD]);
  });

  it("keeps everything when no globs are given", async () => {
    const result = await run([], [commit(1, { paths: ["vendor/lib.js", "src/a.ts"] })]);
    expect(result.fileCount).toBe(2);
  });
});
