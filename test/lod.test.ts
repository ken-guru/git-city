import { describe, expect, it } from "vitest";
import { labelVisible, LodController, MAX_LEVEL, sceneryKept, settingsFor } from "../src/page/lod.js";

/** Feeds frames at `fps` for `seconds`, starting at `start` ms. Returns the time after the last frame. */
function run(lod: LodController, fps: number, seconds: number, start: number): number {
  const step = 1000 / fps;
  let now = start;
  for (let i = 0; i < seconds * fps; i++) {
    lod.frame(now);
    now += step;
  }
  return now;
}

describe("LodController", () => {
  it("starts at full detail and drops one level after a slow second", () => {
    const lod = new LodController();
    expect(lod.level).toBe(0);
    run(lod, 20, 1.5, 0);
    expect(lod.level).toBe(1);
  });

  it("never goes below the least detailed level", () => {
    const lod = new LodController();
    run(lod, 10, 10, 0);
    expect(lod.level).toBe(MAX_LEVEL);
  });

  it("returns to full detail when the frame rate recovers", () => {
    const lod = new LodController();
    const afterSlow = run(lod, 10, 5, 0);
    expect(lod.level).toBe(MAX_LEVEL);
    run(lod, 60, 4, afterSlow);
    expect(lod.level).toBe(0);
  });

  it("holds its level while the frame rate sits between the two thresholds", () => {
    const lod = new LodController();
    run(lod, 20, 1.5, 0);
    expect(lod.level).toBe(1);
    run(lod, 50, 5, 2000);
    expect(lod.level).toBe(1);
  });

  it("ignores a gap such as a hidden tab rather than counting it as slow frames", () => {
    const lod = new LodController();
    const afterGap = run(lod, 60, 1, 0) + 10_000;
    run(lod, 60, 3, afterGap);
    expect(lod.level).toBe(0);
  });
});

describe("scenery and labels", () => {
  it("keeps all scenery at full detail, however far away", () => {
    expect(sceneryKept(10_000, settingsFor(0), 0.999)).toBe(true);
  });

  it("thins scenery with distance at the least detailed level", () => {
    const low = settingsFor(MAX_LEVEL);
    // Nearby scenery is all kept; past sceneryFar only sceneryFloor (0.2) of it is.
    expect(sceneryKept(0, low, 0.99)).toBe(true);
    expect(sceneryKept(500, low, 0.1)).toBe(true);
    expect(sceneryKept(500, low, 0.5)).toBe(false);
  });

  it("hides labels beyond the level's label distance", () => {
    const mid = settingsFor(1);
    expect(labelVisible(80, mid)).toBe(true);
    expect(labelVisible(81, mid)).toBe(false);
    expect(labelVisible(1e9, settingsFor(0))).toBe(true);
  });
});

describe("settingsFor", () => {
  it("keeps today's full-detail values at level 0", () => {
    // The window fade range and the pixel-ratio cap the page already used before level of detail.
    const full = settingsFor(0);
    expect(full.windowNear).toBe(14);
    expect(full.windowFar).toBe(40);
    expect(full.propFar).toBe(Number.POSITIVE_INFINITY);
    expect(full.pixelRatioCap).toBe(2);
    expect(full.sceneryFloor).toBe(1);
    expect(full.labelFar).toBe(Number.POSITIVE_INFINITY);
  });

  it("draws less at every step down, and keeps every window fade range valid", () => {
    for (let level = 0; level < MAX_LEVEL; level++) {
      const near = settingsFor(level);
      const far = settingsFor(level + 1);
      expect(far.windowFar).toBeLessThanOrEqual(near.windowFar);
      expect(far.propFar).toBeLessThanOrEqual(near.propFar);
      expect(far.labelFar).toBeLessThanOrEqual(near.labelFar);
      expect(far.massFar).toBeLessThanOrEqual(near.massFar);
      expect(far.sceneryFar).toBeLessThanOrEqual(near.sceneryFar);
      expect(far.sceneryFloor).toBeLessThanOrEqual(near.sceneryFloor);
      expect(far.pixelRatioCap).toBeLessThanOrEqual(near.pixelRatioCap);
    }
    for (let level = 0; level <= MAX_LEVEL; level++) {
      const s = settingsFor(level);
      expect(s.windowNear).toBeLessThan(s.windowFar);
    }
  });
});
