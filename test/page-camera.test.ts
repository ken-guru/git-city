import { describe, expect, it } from "vitest";
import {
  buildingFacts,
  CameraDirector,
  chooseFocus,
  type ClusterSummary,
  countChanges,
  easeToward,
  frameFor,
  SHOT_SECONDS,
  showcasePlan,
  type StintInput,
  shotAt,
  shotPose,
  summarise,
} from "../src/page/camera.js";
import { KIND_BUILD, KIND_CHANGE, KIND_DEMOLISH, type BuildingSegment } from "../src/page/state.js";

const summary = (cluster: number, changes: number, standing = 4, extra: Partial<ClusterSummary> = {}): ClusterSummary => ({
  cluster,
  changes,
  standing,
  x: 0,
  z: 0,
  aimY: 2,
  radius: 10,
  ...extra,
});

describe("chooseFocus", () => {
  it("starts on the busiest cluster", () => {
    expect(chooseFocus([summary(1, 3), summary(2, 5)], undefined)).toBe(2);
  });

  it("keeps the current cluster unless another has 1.5 times its changes", () => {
    expect(chooseFocus([summary(1, 10), summary(2, 14)], 1)).toBe(1);
    expect(chooseFocus([summary(1, 10), summary(2, 15)], 1)).toBe(2);
  });

  it("switches off a cluster with no changes to any busier one", () => {
    expect(chooseFocus([summary(1, 0), summary(2, 1)], 1)).toBe(2);
  });

  it("keeps the current focus when nothing has changed", () => {
    expect(chooseFocus([summary(1, 0), summary(2, 0)], 1)).toBe(1);
    expect(chooseFocus([], 1)).toBe(1);
  });
});

describe("countChanges", () => {
  const segments: BuildingSegment[] = [
    { start: 0, kind: KIND_CHANGE, from: 3, to: 3 }, // the chunk's snapshot, not a change
    { start: 2, kind: KIND_BUILD, from: 0, to: 3 },
    { start: 9, kind: KIND_CHANGE, from: 3, to: 4 },
    { start: 14, kind: KIND_CHANGE, from: 4, to: 5 },
    { start: 20, kind: KIND_DEMOLISH, from: 5, to: 0 },
  ];

  it("counts changes that start in the last window commits, up to t", () => {
    expect(countChanges(segments, 14, 15)).toBe(3);
    expect(countChanges(segments, 14, 5)).toBe(1);
    expect(countChanges(segments, 19, 15)).toBe(2);
  });
});

describe("buildingFacts and summarise", () => {
  const spot = (x: number, z: number) => ({ x, z });
  const built = (floors: number): BuildingSegment[] => [{ start: 0, kind: KIND_BUILD, from: 0, to: floors }];

  it("groups Buildings by the District that owns their Block, and finds the centre of the standing ones", () => {
    const stints: StintInput[] = [
      { segments: built(2), spot: spot(0, 0), block: 0 },
      { segments: built(2), spot: spot(4, 0), block: 0 },
      { segments: built(2), spot: spot(0, 4), block: 1 },
      { segments: [{ start: 0, kind: KIND_DEMOLISH, from: 2, to: 0 }], spot: spot(50, 50), block: 1 },
    ];
    const owners = new Map<number, number>([
      [0, 7],
      [1, 7],
    ]);
    const sums = summarise(buildingFacts(stints, (block) => owners.get(block), 5, 4, 15));
    const district = sums.get(7)!;
    expect(district.standing).toBe(3);
    expect(district.x).toBeCloseTo(4 / 3);
    expect(district.z).toBeCloseTo(4 / 3);
    // Mean roof height of 2 floors plus a 0.2 foundation.
    expect(district.aimY).toBeCloseTo(2.2);
  });

  it("drops Buildings whose Block has no owner", () => {
    const facts = buildingFacts([{ segments: built(1), spot: spot(0, 0), block: 3 }], () => undefined, 5, 4, 15);
    expect(facts).toHaveLength(0);
  });
});

describe("showcasePlan", () => {
  it("skips clusters with fewer than 4 standing Buildings or no name, and keeps the 6 busiest", () => {
    const list = [
      summary(1, 50, 3),
      summary(2, 40, 4),
      summary(3, 30, 9),
      summary(4, 30, 4),
      summary(5, 20, 5),
      summary(6, 10, 5),
      summary(7, 9, 5),
      summary(8, 8, 5),
      summary(9, 7, 5),
    ];
    const names = new Map([
      [1, "A"],
      [2, "B"],
      [3, "C"],
      [4, "D"],
      [5, "E"],
      [6, "F"],
      [7, "G"],
      [8, "H"],
      [9, "I"],
    ]);
    const plan = showcasePlan(list, (c) => names.get(c));
    expect(plan.map((p) => p.cluster)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(plan[0]!.name).toBe("B");
  });

  it("breaks ties on changes by standing Buildings", () => {
    const plan = showcasePlan([summary(1, 5, 4), summary(2, 5, 8)], () => "X");
    expect(plan.map((p) => p.cluster)).toEqual([2, 1]);
  });

  it("returns nothing when no cluster qualifies", () => {
    expect(showcasePlan([summary(1, 5, 3)], () => "X")).toEqual([]);
  });
});

describe("frameFor", () => {
  it("aims at the centre at Building height, at height 1.5 + 0.15 R, set back 1.6 R + 5 towards the land's centre", () => {
    const s = summary(1, 5, 4, { x: 30, z: 0, aimY: 4, radius: 10 });
    const frame = frameFor(s, { x: 0, z: 0 });
    expect(frame.aim).toEqual({ x: 30, y: 4, z: 0 });
    expect(frame.position.y).toBeCloseTo(1.5 + 0.15 * 10);
    // Towards the land's centre (negative x) by 1.6 * 10 + 5 = 21.
    expect(frame.position.x).toBeCloseTo(30 - 21);
    expect(frame.position.z).toBeCloseTo(0);
  });

  it("falls back to a fixed side when the cluster sits on the land's centre", () => {
    const frame = frameFor(summary(1, 5, 4, { x: 0, z: 0, radius: 10 }), { x: 0, z: 0 });
    expect(Math.hypot(frame.position.x, frame.position.z)).toBeCloseTo(21);
  });
});

describe("shotAt and shotPose", () => {
  it("cycles through the establishing shot and each postcard, with progress through each", () => {
    expect(shotAt(0, 3, false)).toEqual({ shot: 0, progress: 0 });
    expect(shotAt(SHOT_SECONDS + 1, 3, false).shot).toBe(1);
    expect(shotAt(3 * SHOT_SECONDS + 0.5, 3, false).shot).toBe(0);
    expect(shotAt(SHOT_SECONDS / 2, 3, false).progress).toBeCloseTo(0.5);
  });

  it("cuts only under reduced motion: no progress through a shot", () => {
    expect(shotAt(SHOT_SECONDS / 2, 3, true)).toEqual({ shot: 0, progress: 0 });
  });

  it("pushes the camera in slowly towards its aim over the shot, and not at all under reduced motion", () => {
    const frame = frameFor(summary(1, 5, 4, { x: 30, z: 0, aimY: 4, radius: 10 }), { x: 0, z: 0 });
    const start = shotPose(frame, 0, false);
    const end = shotPose(frame, 1, false);
    expect(start.x).toBeCloseTo(9);
    expect(end.x).toBeGreaterThan(start.x);
    expect(30 - end.x).toBeLessThan(21);
    expect(shotPose(frame, 1, true)).toEqual(start);
  });
});

describe("easeToward", () => {
  it("moves part of the way each frame, and jumps when reduced motion is on", () => {
    expect(easeToward(0, 10, 1 / 60, false)).toBeGreaterThan(0);
    expect(easeToward(0, 10, 1 / 60, false)).toBeLessThan(10);
    expect(easeToward(0, 10, 1 / 60, true)).toBe(10);
  });
});

describe("CameraDirector", () => {
  const playing = { playing: true, atLatest: false, loaded: true };
  const latest = { playing: false, atLatest: true, loaded: true };

  it("follows the changes during playback, and gives the camera to the viewer on input until 12 s idle", () => {
    const d = new CameraDirector(true);
    expect(d.mode(0, playing)).toBe("follow");
    d.noteInput(1);
    expect(d.mode(2, playing)).toBe("free");
    expect(d.mode(13, playing)).toBe("follow");
  });

  it("does not follow when the viewer has turned following off", () => {
    const d = new CameraDirector(false);
    expect(d.mode(0, playing)).toBe("free");
  });

  it("starts the showcase after 12 s idle at the latest commit, once history is loaded", () => {
    const d = new CameraDirector(true);
    expect(d.mode(0, latest)).toBe("free");
    expect(d.mode(11.9, latest)).toBe("free");
    expect(d.mode(12, latest)).toBe("showcase");
    expect(d.showcaseTime(12)).toBe(0);
    expect(d.showcaseTime(15)).toBeCloseTo(3);
  });

  it("does not start the showcase before history is up to date, or away from the latest commit", () => {
    const d = new CameraDirector(true);
    expect(d.mode(20, { playing: false, atLatest: true, loaded: false })).toBe("free");
    expect(d.mode(20, { playing: false, atLatest: false, loaded: true })).toBe("free");
  });

  it("hands over to the viewer on input and restarts the 12 s wait", () => {
    const d = new CameraDirector(true);
    expect(d.mode(12, latest)).toBe("showcase");
    d.noteInput(13);
    expect(d.mode(13.5, latest)).toBe("free");
    expect(d.mode(24.9, latest)).toBe("free");
    expect(d.mode(25, latest)).toBe("showcase");
  });

  it("turns the showcase off when playing or scrubbing starts", () => {
    const d = new CameraDirector(true);
    expect(d.mode(12, latest)).toBe("showcase");
    expect(d.mode(13, playing)).toBe("follow");
    expect(d.mode(14, latest)).toBe("free");
  });
});
