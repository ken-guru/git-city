import { describe, expect, it } from "vitest";
import type { CommitRecord } from "../src/cli/history.js";
import { TimelineBuilder } from "../src/cli/timeline.js";
import { EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_SCAFFOLD_OFF, EVENT_SCAFFOLD_ON } from "../src/shared/format.js";

function commit(day: number, change: Partial<Omit<CommitRecord, "day">> = {}): CommitRecord {
  return { day, added: [], deleted: [], modified: [], ...change };
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
