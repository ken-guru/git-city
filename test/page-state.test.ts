import { describe, expect, it } from "vitest";
import {
  EVENT_ADD,
  EVENT_BLOCK_OWNER,
  EVENT_ROAD_BUILT,
  EVENT_ROAD_LANES,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_LANGUAGE,
  EVENT_RELOCATE,
  EVENT_RENOVATE,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
  type Chunk,
  type ChunkSnapshot,
} from "../src/shared/format.js";
import {
  type BuildingSegment,
  buildingPose,
  buildTimelines,
  displayedFloors,
  durationFor,
  KIND_BUILD,
  KIND_CHANGE,
  KIND_DEMOLISH,
  languageAt,
  scaffoldPose,
  TRANSITION_COMMITS,
} from "../src/page/state.js";

const EMPTY_SNAPSHOT: ChunkSnapshot = {
  file: new Uint32Array(0),
  stint: new Uint32Array(0),
  blockIds: new Uint32Array(0),
  blockDistricts: new Uint32Array(0),
  roadIds: new Uint32Array(0),
  roadBuilt: new Uint32Array(0),
  roadForward: new Uint8Array(0),
  roadBackward: new Uint8Array(0),
  floors: new Uint8Array(0),
  scaffolded: new Uint8Array(0),
  buildingType: new Uint8Array(0),
  language: new Uint8Array(0),
};

/** A chunk holding the given events, starting at `firstCommit` with the given snapshot. */
function chunkOf(
  events: [commit: number, file: number, kind: number, value: number][],
  firstCommit = 0,
  snapshot: ChunkSnapshot = EMPTY_SNAPSHOT,
): Chunk {
  return {
    formatVersion: 3,
    firstCommit,
    snapshot,
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    // Each file is its own Stint here, unless the test says otherwise.
    eventStint: Uint32Array.from(events, (e) => e[1]),
    eventKind: Uint8Array.from(events, (e) => e[2]),
    eventValue: Uint8Array.from(events, (e) => e[3]),
  };
}

/** A chunk whose events name their Stints. */
function staged(events: [commit: number, file: number, kind: number, value: number, stint: number][], firstCommit = 0): Chunk {
  return {
    formatVersion: 6,
    firstCommit,
    snapshot: EMPTY_SNAPSHOT,
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    eventStint: Uint32Array.from(events, (e) => e[4]),
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

describe("snapshots", () => {
  const snapshot: ChunkSnapshot = {
    file: Uint32Array.of(0, 1),
    stint: Uint32Array.of(0, 1),
    blockIds: new Uint32Array(0),
    blockDistricts: new Uint32Array(0),
    roadIds: new Uint32Array(0),
    roadBuilt: new Uint32Array(0),
    roadForward: new Uint8Array(0),
    roadBackward: new Uint8Array(0),
    floors: Uint8Array.of(4, 2),
    scaffolded: Uint8Array.of(1, 0),
    buildingType: Uint8Array.of(0, 0),
    language: Uint8Array.of(0, 0),
  };

  it("starts each standing file at its snapshot Floors, from the chunk's first commit", () => {
    const { buildings } = buildTimelines(chunkOf([[2005, 1, EVENT_FLOORS, 5]], 2000, snapshot), 2);

    expect(buildings[0]![0]).toEqual({ start: 2000, kind: KIND_CHANGE, from: 4, to: 4 });
    expect(buildingPose(buildings[1]!, 2000, TRANSITION_COMMITS)).toMatchObject({ visible: true, to: 2 });
    expect(displayedFloors(buildings[1]![1]!, 2005)).toBe(2); // the change eases from the snapshot's two Floors
    expect(displayedFloors(buildings[1]![1]!, 2005 + TRANSITION_COMMITS)).toBe(5);
  });

  it("starts scaffolding that is up at the snapshot, and not scaffolding that is down", () => {
    const { scaffolds } = buildTimelines(chunkOf([], 2000, snapshot), 2);

    expect(scaffolds[0]).toEqual([{ start: 2000, up: true }]);
    expect(scaffolds[1]).toEqual([]);
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

describe("language changes", () => {
  it("eases the colour from the birth language to the new one, from the commit of the change", () => {
    const { languages } = buildTimelines(chunkOf([[5, 0, EVENT_LANGUAGE, 3]]), 1, Uint8Array.of(1));
    const segments = languages[0]!;
    expect(languageAt(segments, 1, 4)).toEqual({ from: 1, to: 1, share: 1 }); // before the change: birth language, no easing
    expect(languageAt(segments, 1, 5)).toEqual({ from: 1, to: 3, share: 0 });
    expect(languageAt(segments, 1, 6.5).share).toBeCloseTo(1 - (1 - 1.5 / 4) ** 3);
    expect(languageAt(segments, 1, 9)).toEqual({ from: 1, to: 3, share: 1 });
  });

  it("starts a file's language from its birth language when it is added in the chunk", () => {
    const add: [number, number, number, number] = [2, 0, EVENT_ADD, 1];
    const { languages } = buildTimelines(chunkOf([add, [4, 0, EVENT_LANGUAGE, 2], [8, 0, EVENT_LANGUAGE, 5]]), 1, Uint8Array.of(7));
    // The birth language holds from the ADD, then each change eases from the one before it.
    expect(languages[0]!.map((s) => [s.from, s.to])).toEqual([
      [7, 7],
      [7, 2],
      [2, 5],
    ]);
  });

  it("uses the snapshot language as the starting point of a chunk, so the chunk stands alone", () => {
    const snapshot: ChunkSnapshot = { ...EMPTY_SNAPSHOT, file: Uint32Array.of(0), stint: Uint32Array.of(0), floors: Uint8Array.of(2), scaffolded: Uint8Array.of(0), buildingType: Uint8Array.of(0), language: Uint8Array.of(4) };
    const { languages } = buildTimelines(chunkOf([[12, 0, EVENT_LANGUAGE, 6]], 10, snapshot), 1, Uint8Array.of(0));
    expect(languageAt(languages[0]!, 0, 10)).toMatchObject({ from: 4, to: 4 });
    expect(languageAt(languages[0]!, 0, 12)).toEqual({ from: 4, to: 6, share: 0 });
  });

  it("changes the colour at once when the language before the change is not known", () => {
    const { languages } = buildTimelines(chunkOf([[3, 0, EVENT_LANGUAGE, 2]]), 1);
    expect(languages[0]!.map((s) => [s.from, s.to])).toEqual([[2, 2]]);
  });

  it("eases from the birth language when the file was born before the chunk without a snapshot entry", () => {
    const { languages } = buildTimelines(chunkOf([[3, 0, EVENT_LANGUAGE, 2]]), 1, Uint8Array.of(5));
    expect(languages[0]!.map((s) => [s.from, s.to])).toEqual([[5, 2]]);
  });
});

describe("Relocation and Renovation", () => {
  // File 0 is built at commit 2 with three Floors as Stint 0. It moves at commit 10 as Stint 1.
  const moved = (kind: number, value: number) =>
    buildTimelines(
      staged([
        [2, 0, EVENT_ADD, 3, 0],
        [10, 0, kind, value, 1],
      ]),
      2,
    );

  it("takes the old Stint down on its old Lot as the new one is built, starting together", () => {
    const { buildings } = moved(EVENT_RELOCATE, 4);
    const old = buildingPose(buildings[0]!, 10);
    expect(old.kind).toBe(KIND_DEMOLISH);
    expect(buildingPose(buildings[1]!, 10)).toMatchObject({ kind: KIND_BUILD, to: 3, visible: true });
    // Once the demolition has finished, the old Stint's Lot is empty for good.
    expect(buildingPose(buildings[0]!, 10 + TRANSITION_COMMITS).visible).toBe(false);
  });

  it("builds a Renovation as the new type only after the old one is down", () => {
    const { buildings } = moved(EVENT_RENOVATE, 4);
    expect(buildingPose(buildings[0]!, 10).kind).toBe(KIND_DEMOLISH);
    expect(buildingPose(buildings[1]!, 10 + TRANSITION_COMMITS - 1).visible).toBe(false);
    expect(buildingPose(buildings[1]!, 10 + TRANSITION_COMMITS)).toMatchObject({ kind: KIND_BUILD, to: 3, visible: true });
  });

  it("applies later events to the file's current Stint", () => {
    const chunk = staged([
      [2, 0, EVENT_ADD, 3, 0],
      [10, 0, EVENT_RELOCATE, 4, 1],
      [12, 0, EVENT_FLOORS, 5, 1],
      [20, 0, EVENT_DELETE, 0, 1],
    ]);
    const { buildings } = buildTimelines(chunk, 2);
    expect(buildingPose(buildings[1]!, 13)).toMatchObject({ kind: KIND_CHANGE, to: 5, visible: true });
    expect(buildingPose(buildings[1]!, 30).visible).toBe(false);
  });

  it("carries a file's language across a Relocation without a colour change", () => {
    const chunk = staged([
      [2, 0, EVENT_ADD, 3, 0],
      [5, 0, EVENT_LANGUAGE, 2, 0],
      [10, 0, EVENT_RELOCATE, 4, 1],
    ]);
    const { languages } = buildTimelines(chunk, 2, Uint8Array.of(1));
    expect(languageAt(languages[1]!, 1, 10)).toMatchObject({ from: 2, to: 2 });
  });
});

describe("Block owners and Roads over time", () => {
  /** A chunk with the given layout events; each event's stint carries the owner (Blocks) or the parent (Districts). */
  const layoutChunk = (events: [commit: number, id: number, kind: number, value: number, stint: number][], snapshot = EMPTY_SNAPSHOT): Chunk => ({
    formatVersion: 7,
    firstCommit: 0,
    snapshot,
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    eventStint: Uint32Array.from(events, (e) => e[4]),
    eventKind: Uint8Array.from(events, (e) => e[2]),
    eventValue: Uint8Array.from(events, (e) => e[3]),
  });

  it("gives each Block its owner from the claim, and each owner change after it", () => {
    const { owners } = buildTimelines(
      layoutChunk([
        [3, 7, EVENT_BLOCK_OWNER, 0, 0],
        [9, 7, EVENT_BLOCK_OWNER, 1, 1],
      ]),
      0,
    );
    expect(owners.get(7)).toEqual([
      { start: 3, owner: 0, from: -1 },
      { start: 9, owner: 1, from: 0 },
    ]);
  });

  it("carries the owners and Roads of a chunk's snapshot as its first segments", () => {
    const snapshot: ChunkSnapshot = {
      ...EMPTY_SNAPSHOT,
      blockIds: Uint32Array.of(4),
      blockDistricts: Uint32Array.of(2),
      roadIds: Uint32Array.of(1),
      roadBuilt: Uint32Array.of(50),
      roadForward: Uint8Array.of(2),
      roadBackward: Uint8Array.of(1),
    };
    const { owners, roads } = buildTimelines(layoutChunk([], snapshot), 0);
    expect(owners.get(4)).toEqual([{ start: 0, owner: 2, from: 2 }]);
    expect(roads.get(1)).toEqual({ built: 50, lanes: [{ start: 0, fromForward: 2, fromBackward: 1, forward: 2, backward: 1 }] });
  });

  it("builds a Road at its first event and eases its Lanes from the ones before", () => {
    const { roads } = buildTimelines(
      layoutChunk([
        [5, 0, EVENT_ROAD_BUILT, 0, 0],
        [5, 0, EVENT_ROAD_LANES, 2, 1],
        [9, 0, EVENT_ROAD_LANES, 3, 1],
      ]),
      0,
    );
    const road = roads.get(0)!;
    expect(road.built).toBe(5);
    expect(road.lanes.map((l) => [l.fromForward, l.forward, l.backward])).toEqual([
      [0, 2, 1],
      [2, 3, 1],
    ]);
  });
});
