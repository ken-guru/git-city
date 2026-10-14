import { describe, expect, it } from "vitest";
import {
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
  type Chunk,
} from "../src/shared/format.js";
import {
  type BuildingSegment,
  buildingPose,
  buildTimelines,
  displayedFloors,
  durationFor,
  gridColumns,
  gridSlot,
  KIND_BUILD,
  KIND_CHANGE,
  KIND_DEMOLISH,
  scaffoldPose,
  TRANSITION_COMMITS,
} from "../src/page/state.js";

/** A chunk holding the given events, with an empty snapshot. */
function chunkOf(events: [commit: number, file: number, kind: number, value: number][]): Chunk {
  return {
    formatVersion: 2,
    firstCommit: 0,
    snapshot: new Uint32Array(0),
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    eventKind: Uint8Array.from(events, (e) => e[2]),
    eventValue: Uint8Array.from(events, (e) => e[3]),
  };
}

describe("Building transitions", () => {
  it("builds the foundation first, then the Floors, with ease-out cubic over D commits", () => {
    // Built at commit 10 with six Floors. The foundation takes the first quarter of D.
    const build: BuildingSegment = { start: 10, kind: KIND_BUILD, from: 0, to: 6 };

    expect(displayedFloors(build, 10)).toBe(0);
    expect(displayedFloors(build, 11)).toBe(0); // foundation done, no Floor yet
    expect(displayedFloors(build, 12.5)).toBeCloseTo(6 * (1 - 0.5 ** 3)); // halfway through the Floors
    expect(displayedFloors(build, 14)).toBe(6);
    expect(displayedFloors(build, 100)).toBe(6);
  });

  it("grows and shrinks by eased Floors from the displayed value", () => {
    const change: BuildingSegment = { start: 10, kind: KIND_CHANGE, from: 2, to: 5 };

    expect(displayedFloors(change, 10)).toBe(2);
    expect(displayedFloors(change, 11)).toBeCloseTo(2 + 3 * (1 - 0.75 ** 3));
    expect(displayedFloors(change, 14)).toBe(5);
  });

  it("sinks a demolished Building away over D, then collapses it", () => {
    const demolish: BuildingSegment = { start: 10, kind: KIND_DEMOLISH, from: 4, to: 0 };

    expect(displayedFloors(demolish, 10)).toBe(4);
    expect(displayedFloors(demolish, 12)).toBeCloseTo(0.5); // ease-out cubic at half: 4 * 1/8
    expect(buildingPose([demolish], 13.9, TRANSITION_COMMITS).visible).toBe(true);
    expect(buildingPose([demolish], 14, TRANSITION_COMMITS).visible).toBe(false);
  });

  it("reads each file's segments from its chunk events, and remembers the displayed height when Floors change", () => {
    const { buildings } = buildTimelines(
      chunkOf([
        [2, 0, EVENT_ADD, 1],
        [5, 0, EVENT_FLOORS, 3],
        [9, 0, EVENT_DELETE, 0],
      ]),
      1,
    );

    const [build, change, demolish] = buildings[0]!;
    expect(build).toEqual({ start: 2, kind: KIND_BUILD, from: 0, to: 1 });
    expect(change!.kind).toBe(KIND_CHANGE);
    expect(change!.start).toBe(5);
    expect(change!.to).toBe(3);
    // The change starts from the Floors on screen at commit 5: the build is three quarters through its D,
    // so its Floor is at ease-out cubic of 2/3, not yet the full 1.
    expect(change!.from).toBeCloseTo(1 - (1 / 3) ** 3);
    expect(demolish!.kind).toBe(KIND_DEMOLISH);
    expect(demolish!.start).toBe(9);
    expect(demolish!.from).toBeCloseTo(displayedFloors(change!, 9));
  });
});

describe("Lots and poses", () => {
  it("collapses a Lot before its Building is built", () => {
    const pose = buildingPose([{ start: 4, kind: KIND_BUILD, from: 0, to: 2 }], 3, TRANSITION_COMMITS);

    expect(pose.visible).toBe(false);
  });

  it("collapses a Lot that was never built", () => {
    expect(buildingPose([], 50, TRANSITION_COMMITS).visible).toBe(false);
  });

  it("uses a longer duration when the viewer's speed would make D shorter than a quarter second", () => {
    expect(durationFor(2)).toBe(TRANSITION_COMMITS); // 0.25 s at 2 commits/s is 0.5 commits: D wins
    expect(durationFor(40)).toBe(10); // 0.25 s at 40 commits/s is 10 commits
  });
});

describe("scaffolding", () => {
  it("rises over D/2 and comes down over D/2, and only while the Building stands", () => {
    const { buildings, scaffolds } = buildTimelines(
      chunkOf([
        [0, 0, EVENT_ADD, 2],
        [3, 0, EVENT_SCAFFOLD_ON, 0],
        [10, 0, EVENT_SCAFFOLD_OFF, 0],
        [12, 0, EVENT_DELETE, 0],
      ]),
      1,
    );
    const at = (t: number) => scaffoldPose(scaffolds[0]!, buildingPose(buildings[0]!, t, TRANSITION_COMMITS), t, TRANSITION_COMMITS);

    expect(at(2).visible).toBe(false);
    expect(at(3).visible).toBe(true);
    expect(at(9).visible).toBe(true);
    expect(at(10 + TRANSITION_COMMITS / 2).visible).toBe(false);
    expect(at(10 + 0.5).visible).toBe(true);
    expect(at(10 + 0.5).height).toBe(2);
  });

  it("is gone once the Building is demolished, even if scaffolding was up", () => {
    const { buildings, scaffolds } = buildTimelines(
      chunkOf([
        [0, 0, EVENT_ADD, 2],
        [3, 0, EVENT_SCAFFOLD_ON, 0],
        [6, 0, EVENT_DELETE, 0],
      ]),
      1,
    );

    const pose = scaffoldPose(scaffolds[0]!, buildingPose(buildings[0]!, 7, TRANSITION_COMMITS), 7, TRANSITION_COMMITS);

    expect(pose.visible).toBe(false);
  });
});

describe("page grid", () => {
  it("gives every file its own spot on a square grid", () => {
    const columns = gridColumns(10);
    const slots = Array.from({ length: 10 }, (_, file) => gridSlot(file, columns));

    expect(columns).toBe(4);
    expect(slots[0]).toEqual({ column: 0, row: 0 });
    expect(slots[3]).toEqual({ column: 3, row: 0 });
    expect(slots[4]).toEqual({ column: 0, row: 1 });
    expect(new Set(slots.map((s) => `${s.column},${s.row}`)).size).toBe(10);
  });
});
