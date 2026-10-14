import { describe, expect, it } from "vitest";
import type { CommitRecord } from "../src/cli/history.js";
import { TimelineBuilder } from "../src/cli/timeline.js";
import { EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_LANGUAGE, EVENT_RELOCATE, EVENT_RENOVATE, EVENT_SCAFFOLD_OFF, EVENT_SCAFFOLD_ON } from "../src/shared/format.js";

function commit(day: number, change: Partial<Omit<CommitRecord, "day">> = {}): CommitRecord {
  return { day, added: [], deleted: [], modified: [], writes: [], ...change };
}

function run(commits: CommitRecord[]) {
  const builder = new TimelineBuilder();
  for (const c of commits) builder.add(c);
  return builder.result();
}

/** Events as [commit, file, kind, value] tuples, in the order they were recorded. */
function eventsOf(result: ReturnType<typeof run>) {
  return [...result.eventCommit].map((commit, i) => [commit, result.eventFile[i], result.eventKind[i], result.eventValue[i]]);
}

describe("timeline builder: Building attributes", () => {
  it("gives each file its Building type, language and seed, and starts it at one Floor without lines", () => {
    const result = run([commit(1, { added: ["src/app.ts", "docs/guide.md"] })]);

    expect([...result.buildingType]).toEqual([0, 2]); // office, library
    expect([...result.language]).toEqual([1, 0]); // TypeScript, other
    expect(result.seed[0]).not.toBe(result.seed[1]);
    expect(eventsOf(result)).toEqual([
      [0, 0, EVENT_ADD, 1],
      [0, 1, EVENT_ADD, 1],
    ]);
  });

  it("starts a file at the Floors its lines give", () => {
    const lines = new Map([["src/big.ts", 900]]);
    const result = run([commit(1, { added: ["src/big.ts"], lines })]);

    expect(eventsOf(result)).toEqual([[0, 0, EVENT_ADD, 10]]);
  });

  it("adds Floors when a standing file's lines change, and only when the Floors change", () => {
    const at = (lines: number) => new Map([["src/app.ts", lines]]);
    const result = run([
      commit(1, { added: ["src/app.ts"], lines: at(9) }), // 1 Floor
      commit(2, { modified: ["src/app.ts"], lines: at(50) }), // ceil(sqrt 50 / 3) = 3
      commit(3, { modified: ["src/app.ts"], lines: at(52) }), // still 3: no event
    ]);

    expect(eventsOf(result)).toEqual([
      [0, 0, EVENT_ADD, 1],
      [1, 0, EVENT_FLOORS, 3],
    ]);
  });
});

describe("timeline builder: scaffolding", () => {
  it("goes up at the fourth change within 14 days, and comes down once the changes age out", () => {
    const result = run([
      commit(0, { added: ["a.ts"] }),
      commit(2, { modified: ["a.ts"] }),
      commit(4, { modified: ["a.ts"] }),
      commit(6, { modified: ["a.ts"] }), // fourth change: on
      commit(20, { added: ["b.ts"] }), // a.ts's changes (days 0-6) are over 14 days old by day 20: off
    ]);

    const scaffold = eventsOf(result).filter(([, , kind]) => kind === EVENT_SCAFFOLD_ON || kind === EVENT_SCAFFOLD_OFF);
    expect(scaffold).toEqual([
      [3, 0, EVENT_SCAFFOLD_ON, 0],
      [4, 0, EVENT_SCAFFOLD_OFF, 0],
    ]);
  });

  it("does not turn scaffolding on for three changes", () => {
    const result = run([
      commit(0, { added: ["a.ts"] }),
      commit(1, { modified: ["a.ts"] }),
      commit(2, { modified: ["a.ts"] }),
    ]);

    expect(eventsOf(result).some(([, , kind]) => kind === EVENT_SCAFFOLD_ON)).toBe(false);
  });
});

describe("timeline builder: deletes", () => {
  it("records a delete for a standing path and never reuses its file id", () => {
    const result = run([commit(1, { added: ["a.ts"] }), commit(2, { deleted: ["a.ts"] }), commit(3, { added: ["a.ts"] })]);

    expect(result.fileCount).toBe(2);
    expect(eventsOf(result)).toEqual([
      [0, 0, EVENT_ADD, 1],
      [1, 0, EVENT_DELETE, 0],
      [2, 1, EVENT_ADD, 1],
    ]);
  });
});

describe("timeline builder: identity across history", () => {
  const rename = (from: string, to: string) => ({ deleted: [from], added: [to], renamed: [{ from, to }] });

  it("keeps a renamed file's id, seed and events when the rename stays in its directory", () => {
    const result = run([commit(1, { added: ["a.ts"] }), commit(2, rename("a.ts", "b.ts"))]);

    expect(result.fileCount).toBe(1);
    expect(result.filePaths).toEqual(["b.ts"]);
    expect(eventsOf(result)).toEqual([[0, 0, EVENT_ADD, 1]]);
  });

  it("records a Renovation on the same file when a rename changes its Building type", () => {
    const result = run([commit(1, { added: ["app.ts"] }), commit(2, rename("app.ts", "app.md"))]);

    expect(result.fileCount).toBe(1);
    // office to library; the language also changes from TypeScript to none.
    expect(eventsOf(result).slice(1)).toEqual([
      [1, 0, EVENT_RENOVATE, 2],
      [1, 0, EVENT_LANGUAGE, 0],
    ]);
  });

  it("records a language change on the same file when a rename changes only its language", () => {
    const result = run([commit(1, { added: ["app.ts"] }), commit(2, rename("app.ts", "app.js"))]);

    expect(eventsOf(result).slice(1)).toEqual([[1, 0, EVENT_LANGUAGE, 2]]); // JavaScript
  });

  it("relocates a file moved to another directory, keeping its name and id", () => {
    const result = run([
      commit(1, { added: ["a/x.ts", "a/y.ts", "a/z.ts"] }),
      commit(2, rename("a/x.ts", "b/x.ts")),
    ]);

    expect(result.fileCount).toBe(3);
    expect(result.filePaths[0]).toBe("a/x.ts");
    expect(eventsOf(result).slice(3)).toEqual([[1, 0, EVENT_RELOCATE, 0]]);
  });

  it("moves a whole directory with no Relocation or delete events", () => {
    const result = run([
      commit(1, { added: ["src/auth/a.ts", "src/auth/b.ts"] }),
      commit(2, {
        deleted: ["src/auth/a.ts", "src/auth/b.ts"],
        added: ["src/identity/a.ts", "src/identity/b.ts"],
        renamed: [
          { from: "src/auth/a.ts", to: "src/identity/a.ts" },
          { from: "src/auth/b.ts", to: "src/identity/b.ts" },
        ],
      }),
    ]);

    expect(result.fileCount).toBe(2);
    expect(eventsOf(result).filter(([, , kind]) => kind === EVENT_RELOCATE || kind === EVENT_DELETE)).toEqual([]);
  });

  it("renovates each Building when a whole-directory move changes its Building type, without relocating it", () => {
    // Category depends on the directory: src/ is source code (office), docs/ is documentation (library).
    const result = run([
      commit(1, { added: ["src/auth/a.ts", "src/auth/b.ts"] }),
      commit(2, {
        deleted: ["src/auth/a.ts", "src/auth/b.ts"],
        added: ["docs/auth/a.ts", "docs/auth/b.ts"],
        renamed: [
          { from: "src/auth/a.ts", to: "docs/auth/a.ts" },
          { from: "src/auth/b.ts", to: "docs/auth/b.ts" },
        ],
      }),
    ]);

    expect(eventsOf(result).slice(2)).toEqual([
      [1, 0, EVENT_RENOVATE, 2],
      [1, 1, EVENT_RENOVATE, 2],
    ]);
  });
});

describe("timeline builder: layout changes", () => {
  const rename = (from: string, to: string) => ({ deleted: [from], added: [to], renamed: [{ from, to }] });

  it("returns each commit's additions, deletions and renames with their file ids, one change per commit", () => {
    const builder = new TimelineBuilder();

    const first = builder.add(commit(1, { added: ["a.ts", "b.ts"] }));
    const second = builder.add(commit(2, rename("a.ts", "c.ts")));
    const third = builder.add(commit(3, { deleted: ["b.ts"] }));

    expect(first).toEqual({ added: [{ file: 0, path: "a.ts" }, { file: 1, path: "b.ts" }], deleted: [], moved: [] });
    expect(second).toEqual({ added: [], deleted: [], moved: [{ file: 0, from: "a.ts", to: "c.ts" }] });
    expect(third).toEqual({ added: [], deleted: [{ file: 1, path: "b.ts" }], moved: [] });
  });

  it("finds the file standing at a path, and none once it is gone", () => {
    const builder = new TimelineBuilder();
    builder.add(commit(1, { added: ["a.ts"] }));
    builder.add(commit(2, rename("a.ts", "c.ts")));

    expect(builder.fileAt("c.ts")).toBe(0);
    expect(builder.fileAt("a.ts")).toBeUndefined();
  });
});
