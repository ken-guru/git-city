import { describe, expect, it } from "vitest";
import {
  type Chunk,
  EVENT_ADD,
  EVENT_BLOCK_OWNER,
  EVENT_DISTRICT_MERGE,
  EVENT_DISTRICT_SPLIT,
  EVENT_FLOORS,
  EVENT_RELOCATE,
} from "../src/shared/format.js";
import type { PlacesFile } from "../src/shared/places.js";
import { binSteps, type RibbonSource, RibbonData, tooltipFor } from "../src/page/ribbon-data.js";

const places: PlacesFile = {
  formatVersion: 2,
  city: { name: "Testville", source: 0 },
  districts: [
    {
      id: 0,
      name: "Ashford Keep",
      generated: "Ashford Keep",
      source: 0,
      colour: { hue: 200, saturation: 0.5, lightness: { light: 0.5, dark: 0.4 } },
      anchor: { col: 0, row: 0 },
      neighbourhoods: [],
    },
    {
      id: 1,
      name: "Mill Vale",
      generated: "Mill Vale",
      source: 0,
      colour: { hue: 40, saturation: 0.5, lightness: { light: 0.5, dark: 0.4 } },
      anchor: { col: 4, row: 0 },
      neighbourhoods: [],
    },
  ],
};

// Steps 0..4 on days 0, 0, 1, 1, 9. Step 1 is a grouped Step of 12 commits.
// Blocks 0, 1 and 2 belong to Districts at positions 0, 1 and 1; Blocks 1 and 2 form village 1.
const source: RibbonSource = {
  commitDays: [0, 0, 1, 1, 9],
  stepCommits: [1, 12, 1, 1, 1],
  stints: { lot: [0, 1, 2] },
  lots: { block: [0, 1, 2] },
  blocks: { district: [0, 1, 1], claimed: [0, 2, 3], village: [0, 1, 1] },
  districts: { index: [0, 1] },
};

function chunkOf(events: [commit: number, file: number, kind: number, value: number, stint: number][]): Chunk {
  const empty = new Uint32Array(0);
  return {
    formatVersion: 8,
    firstCommit: 0,
    snapshot: {
      file: empty,
      stint: empty,
      blockIds: empty,
      blockDistricts: empty,
      roadIds: empty,
      roadBuilt: empty,
      roadForward: new Uint8Array(0),
      roadBackward: new Uint8Array(0),
      floors: new Uint8Array(0),
      scaffolded: new Uint8Array(0),
      buildingType: new Uint8Array(0),
      language: new Uint8Array(0),
    },
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    eventStint: Uint32Array.from(events, (e) => e[4]),
    eventKind: Uint8Array.from(events, (e) => e[2]),
    eventValue: Uint8Array.from(events, (e) => e[3]),
  };
}

const colour = () => "#000";

describe("RibbonData: activity", () => {
  it("counts file changes per Step and attributes them to Districts through Stint, Lot and Block", () => {
    const data = new RibbonData(source, places, colour);
    data.addChunk(
      chunkOf([
        [0, 0, EVENT_ADD, 2, 0],
        [2, 1, EVENT_ADD, 1, 1],
        [2, 2, EVENT_FLOORS, 3, 2],
        [4, 0, EVENT_FLOORS, 4, 0],
      ]),
    );
    expect(data.activityAt(0)).toMatchObject({ files: 1, commits: 1 });
    expect(data.activityAt(0)!.districts).toEqual([[0, 1]]);
    expect(data.activityAt(2)).toMatchObject({ files: 2, commits: 1 });
    expect(data.activityAt(2)!.districts).toEqual([[1, 2]]);
    expect(data.activityAt(4)!.districts).toEqual([[0, 1]]);
  });

  it("reports commits from the world file even before a chunk has loaded", () => {
    const data = new RibbonData(source, places, colour);
    expect(data.activityAt(1)).toMatchObject({ files: 0, commits: 12 });
  });
});

describe("RibbonData: District owners over time", () => {
  // Blocks 0..2 with lots 0..2 and stints 0..2. The world file's final owners are deliberately not used here.
  const timed: RibbonSource = {
    commitDays: [0, 1, 2, 3, 4, 5],
    stepCommits: [1, 1, 1, 1, 1, 1],
    stints: { lot: [0, 1, 2] },
    lots: { block: [0, 1, 2] },
    blocks: { district: [1, 1, 1], claimed: [0, 1, 2], village: [0, 0, 0] },
    districts: { index: [0, 1] },
  };

  it("attributes activity to the owner at that commit: the parent before a split, the child after, the parent again after a merge", () => {
    const data = new RibbonData(timed, places, colour);
    data.addChunk(
      chunkOf([
        [1, 1, EVENT_BLOCK_OWNER, 0, 0], // Block 1 is claimed by District 0
        [2, 1, EVENT_ADD, 1, 1], // a file on Block 1 before the split
        [3, 1, EVENT_DISTRICT_SPLIT, 1, 0], // District 1 splits off from District 0
        [3, 1, EVENT_BLOCK_OWNER, 1, 1], // Block 1 moves to the child
        [4, 1, EVENT_FLOORS, 2, 1], // a file on Block 1 after the split
        [5, 1, EVENT_DISTRICT_MERGE, 1, 0], // the child merges back
        [5, 1, EVENT_BLOCK_OWNER, 0, 0], // Block 1 moves back to the parent
        [5, 1, EVENT_FLOORS, 3, 1], // a file on Block 1 after the merge
      ]),
    );
    expect(data.activityAt(2).districts).toEqual([[0, 1]]);
    expect(data.activityAt(4).districts).toEqual([[1, 1]]);
    expect(data.activityAt(5).districts).toEqual([[0, 1]]);
    expect(data.nameOf(1)).toBe("Mill Vale");
  });
});

describe("RibbonData: ticks, founding and identity events", () => {
  it("reads District splits and merges, and marks each village at its first claimed Block", () => {
    const data = new RibbonData(source, places, colour);
    data.addChunk(
      chunkOf([
        [3, 1, EVENT_DISTRICT_SPLIT, 0, 0],
        [4, 1, EVENT_DISTRICT_MERGE, 0, 0],
        [4, 0, EVENT_RELOCATE, 0, 0],
      ]),
    );
    expect(data.ticks).toEqual([
      { step: 3, kind: "split", district: 1 },
      { step: 4, kind: "merge", district: 1 },
    ]);
    expect(data.founded).toEqual([
      { step: 0, name: "Ashford Keep" },
      { step: 2, name: "Mill Vale" },
    ]);
  });

  it("captions the latest identity event at or before a Step, by display name", () => {
    const data = new RibbonData(source, places, colour);
    data.addChunk(chunkOf([[3, 1, EVENT_DISTRICT_SPLIT, 0, 0]]));
    expect(data.latestIdentity(1)).toEqual({ step: 0, text: "Ashford Keep founded" });
    expect(data.latestIdentity(3)).toMatchObject({ step: 3, text: "Mill Vale split off" });
    expect(data.latestIdentity(5)?.step).toBe(3);
  });
});

describe("RibbonData: commit counts", () => {
  it("counts real commits, so a grouped Step ends on its last commit", () => {
    const data = new RibbonData(source, places, colour);
    expect(data.totalCommits).toBe(16);
    expect(data.commitsThrough(0)).toBe(1);
    expect(data.commitsThrough(1)).toBe(13);
    expect(data.commitsThrough(4)).toBe(16);
  });
});

describe("RibbonData: years", () => {
  it("places a tick at the first Step of each new year", () => {
    const data = new RibbonData(
      { ...source, commitDays: [364, 366, 367], stepCommits: [1, 1, 1] },
      places,
      colour,
    );
    expect(data.yearTicks).toEqual([{ step: 1, year: 1971 }]);
  });
});

describe("binSteps", () => {
  it("groups Steps into columns and sums their activity", () => {
    const keys = Float64Array.from([0, 0.5, 1, 9]);
    const data = new RibbonData(source, places, colour);
    data.addChunk(
      chunkOf([
        [0, 0, EVENT_ADD, 1, 0],
        [1, 1, EVENT_ADD, 1, 1],
      ]),
    );
    const bins = binSteps(keys, 10, 10, (step) => data.activityAt(step)!);
    expect(bins[0]).toMatchObject({ first: 0, last: 1, commits: 13, files: 2 });
    expect(bins[0]!.districts.get(0)).toBe(1);
    expect(bins.at(-1)).toMatchObject({ first: 3, last: 3 });
  });
});

describe("binSteps with an empty clock", () => {
  it("puts every Step in one column instead of producing NaN columns", () => {
    const data = new RibbonData(source, places, colour);
    const bins = binSteps(Float64Array.from([0, 0, 0, 0, 0]), 0, 10, (step) => data.activityAt(step));
    expect(bins).toHaveLength(1);
    expect(bins[0]).toMatchObject({ first: 0, last: 4 });
  });
});

describe("tooltipFor", () => {
  it("gives the date, commits, file changes, busiest Districts and identity events by display name", () => {
    const data = new RibbonData(source, places, () => "#abc");
    data.addChunk(chunkOf([[1, 0, EVENT_ADD, 1, 0], [1, 1, EVENT_ADD, 1, 1], [1, 2, EVENT_ADD, 1, 2], [1, 2, EVENT_FLOORS, 2, 2]]));
    const text = tooltipFor(data, { first: 1, last: 1, commits: 12, files: 4, districts: new Map([[0, 1], [1, 3]]) });
    expect(text.dates).toBe("1970-01-01");
    expect(text.commits).toBe("12 commits");
    expect(text.files).toBe("4 file changes");
    expect(text.districts).toEqual([
      { name: "Mill Vale", count: 3, colour: "#abc" },
      { name: "Ashford Keep", count: 1, colour: "#abc" },
    ]);
    expect(text.identity).toEqual([]);
  });

  it("gives a date range across several days and one commit wording for a single commit", () => {
    const data = new RibbonData(source, places, colour);
    const range = tooltipFor(data, { first: 2, last: 4, commits: 3, files: 0, districts: new Map() });
    expect(range.dates).toBe("1970-01-02 to 1970-01-10");
    expect(range.commits).toBe("3 commits");
    expect(tooltipFor(data, { first: 0, last: 0, commits: 1, files: 0, districts: new Map() }).commits).toBe("1 commit");
  });
});
