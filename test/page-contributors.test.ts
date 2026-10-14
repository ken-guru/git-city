import { describe, expect, it } from "vitest";
import {
  AUTOMATION_COLOUR,
  captionLine,
  changesIndex,
  OTHER_COLOUR,
  PERSON_COLOURS,
  PIN_LIFE,
  PINS_PER_COMMIT,
  pinScale,
  rankPeople,
  summaryLine,
  TOP_PEOPLE,
  windowOf,
} from "../src/page/contributors.js";
import { EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_LANGUAGE, EVENT_SCAFFOLD_ON, type Chunk } from "../src/shared/format.js";

describe("rankPeople", () => {
  // Contributors 0 and 1 are people, 2 is Automation. Commit counts come from the Steps' commit counts.
  const contributors = {
    name: Uint32Array.from([10, 11, 12]),
    automation: Uint8Array.from([0, 0, 1]),
    ofStep: Uint32Array.from([0, 0, 1, 2, 0, 1]),
  };
  const stepCommits = Uint32Array.from([3, 1, 2, 4, 1, 5]);

  it("ranks people by commits, gives the top ones colours, and counts the rest", () => {
    const people = rankPeople(contributors, stepCommits);
    // Person 0: steps 0, 1, 4 = 3 + 1 + 1 = 5. Person 1: steps 2, 5 = 2 + 5 = 7. Automation: step 3 = 4.
    expect(people.top).toEqual([1, 0]);
    expect(people.commits[0]).toBe(5);
    expect(people.commits[1]).toBe(7);
    expect(people.automationCommits).toBe(4);
    expect(people.more).toBe(0);
    expect(people.slotOf[1]).toBe(0);
    expect(people.slotOf[2]).toBe(-1);
  });

  it("counts people beyond the top eight as more, and keeps the top eight", () => {
    const n = TOP_PEOPLE + 3;
    const many = {
      name: Uint32Array.from({ length: n }, (_, i) => i),
      automation: Uint8Array.from({ length: n }, () => 0),
      ofStep: Uint32Array.from({ length: n }, (_, i) => i),
    };
    // Person i has i + 1 commits, so the busiest is the last.
    const people = rankPeople(many, Uint32Array.from({ length: n }, (_, i) => i + 1));
    expect(people.top).toHaveLength(TOP_PEOPLE);
    expect(people.top[0]).toBe(n - 1);
    expect(people.more).toBe(3);
    expect(people.slotOf[0]).toBe(-1);
  });

  it("gives the top people distinct colours clear of the paving green band, and others grey", () => {
    expect(PERSON_COLOURS).toHaveLength(TOP_PEOPLE);
    expect(new Set(PERSON_COLOURS).size).toBe(TOP_PEOPLE);
    const people = rankPeople(contributors, stepCommits);
    expect(people.colourOf(1)).toBe(PERSON_COLOURS[0]);
    expect(people.colourOf(0)).toBe(PERSON_COLOURS[1]);
    expect(people.colourOf(2)).toBe(AUTOMATION_COLOUR);
    expect(AUTOMATION_COLOUR).not.toBe(OTHER_COLOUR);
    const many = rankPeople(
      { name: Uint32Array.from({ length: 12 }, (_, i) => i), automation: new Uint8Array(12), ofStep: Uint32Array.from({ length: 12 }, (_, i) => i) },
      Uint32Array.from({ length: 12 }, () => 1),
    );
    expect(many.colourOf(11)).toBe(OTHER_COLOUR);
  });
});

describe("pinScale", () => {
  it("is absent before its commit and after its life", () => {
    expect(pinScale(-0.5)).toBe(0);
    expect(pinScale(PIN_LIFE)).toBe(0);
    expect(PIN_LIFE).toBe(6);
  });

  it("settles in over about one commit, holds, then fades by six commits", () => {
    expect(pinScale(0)).toBe(0);
    expect(pinScale(1)).toBe(1);
    expect(pinScale(2)).toBe(1);
    expect(pinScale(4)).toBe(1);
    expect(pinScale(5)).toBeCloseTo(0.5, 6);
    expect(pinScale(5.5)).toBeCloseTo(0.25, 6);
  });
});

describe("changesIndex", () => {
  const chunk = (eventCommit: number[], eventStint: number[], eventKind: number[]): Chunk =>
    ({
      eventCommit: Uint32Array.from(eventCommit),
      eventStint: Uint32Array.from(eventStint),
      eventKind: Uint8Array.from(eventKind),
    }) as unknown as Chunk;

  it("lists the Buildings a commit changes, once each, and leaves out other events", () => {
    const index = changesIndex();
    index.add(
      chunk(
        [3, 3, 3, 3, 3, 4],
        [7, 7, 8, 9, 5, 1],
        [EVENT_ADD, EVENT_FLOORS, EVENT_DELETE, EVENT_LANGUAGE, EVENT_SCAFFOLD_ON, EVENT_ADD],
      ),
    );
    expect(index.stintsAt(3)).toEqual([7, 8]);
    expect(index.stintsAt(4)).toEqual([1]);
    expect(index.stintsAt(5)).toEqual([]);
  });

  it("caps the pins of one commit", () => {
    const index = changesIndex();
    const stints = Array.from({ length: PINS_PER_COMMIT + 5 }, (_, i) => i);
    index.add(chunk(stints.map(() => 0), stints, stints.map(() => EVENT_ADD)));
    expect(index.stintsAt(0)).toHaveLength(PINS_PER_COMMIT);
  });
});

describe("windowOf", () => {
  it("counts the commits and people in a range of Steps", () => {
    const ofStep = Uint32Array.from([0, 1, 1, 2, 0]);
    const stepCommits = Uint32Array.from([1, 2, 3, 4, 1]);
    expect(windowOf(ofStep, stepCommits, 1, 3)).toEqual({ commits: 9, people: 2 });
    expect(windowOf(ofStep, stepCommits, 0, 4)).toEqual({ commits: 11, people: 3 });
  });
});

describe("captions", () => {
  it("joins the date, Contributor and message, leaving out what is absent", () => {
    expect(captionLine({ date: "2024-01-02", contributor: "Ada", message: "fix it" })).toBe("2024-01-02 · Ada · fix it");
    expect(captionLine({ date: "2024-01-02", message: "fix it" })).toBe("2024-01-02 · fix it");
    expect(captionLine({ date: "2024-01-02", contributor: "Ada" })).toBe("2024-01-02 · Ada");
  });

  it("summarises a busy stretch of commits", () => {
    expect(summaryLine(23, 4, "fix it")).toBe("23 commits by 4 people · latest: fix it");
    expect(summaryLine(23, 4)).toBe("23 commits by 4 people");
  });
});
