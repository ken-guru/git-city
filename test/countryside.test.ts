import { describe, expect, it } from "vitest";
import {
  countryside,
  DEFAULT_SETTINGS,
  MOUNTAIN_MAX,
  RELIEF_MAX,
  RIVER_COUNT_RANGE,
  sceneryFade,
  STYLE_A,
  TERRAIN,
} from "../src/shared/countryside.js";

describe("Terrain", () => {
  it("keeps hills within the gentle relief limit of 2.6", () => {
    const land = countryside(5);
    let max = 0;
    for (let col = -60; col <= 60; col++) for (let row = -60; row <= 60; row++) {
      max = Math.max(max, land.heightAt(col, row));
    }
    expect(RELIEF_MAX).toBe(2.6);
    expect(max).toBeLessThanOrEqual(RELIEF_MAX);
  });

  it("has mountains only far from the centre, never higher than 15", () => {
    const land = countryside(5);
    let max = 0;
    for (let col = -120; col <= 120; col++) for (let row = -120; row <= 120; row++) {
      const h = land.mountainAt(col, row);
      max = Math.max(max, h);
      if (Math.hypot(col, row) < TERRAIN.mountainStart) expect(h).toBe(0);
    }
    expect(MOUNTAIN_MAX).toBe(15);
    expect(max).toBeLessThanOrEqual(MOUNTAIN_MAX);
    expect(max).toBeGreaterThan(0);
  });

  it("is a pure function of the seed", () => {
    const a = countryside(9);
    const b = countryside(9);
    for (let col = -20; col <= 20; col += 3) for (let row = -20; row <= 20; row += 3) {
      expect(a.levelAt(col, row)).toBe(b.levelAt(col, row));
      expect(a.heightAt(col, row)).toBe(b.heightAt(col, row));
    }
  });
});

describe("Rivers", () => {
  it("has 2 rivers by default and clamps the count to 1 to 3", () => {
    expect(DEFAULT_SETTINGS.rivers).toBe(2);
    expect(RIVER_COUNT_RANGE).toEqual({ min: 1, max: 3 });
    expect(countryside(1).rivers).toHaveLength(2);
    expect(countryside(1, { rivers: 9 }).rivers).toHaveLength(3);
    expect(countryside(1, { rivers: 0 }).rivers).toHaveLength(1);
  });

  it("marks cells on a river as river, and leaves the centre dry", () => {
    const land = countryside(3);
    const river = land.rivers[0]!;
    const col = 10;
    const row = Math.round(river.rowAt(col));
    expect(land.levelAt(col, row)).toBe("river");
    expect(land.levelAt(0, 0)).not.toBe("river");
  });

  it("gives each river a polyline with sampled points", () => {
    const [river] = countryside(4).rivers;
    const points = river!.polyline(-40, 40, 1);
    expect(points).toHaveLength(81);
    expect(points[0]!.col).toBe(-40);
  });
});

describe("Style", () => {
  it("paints fields and forests in style A's green to yellow-green band, dimmer than paving", () => {
    for (const variant of ["light", "dark"] as const) {
      const colour = STYLE_A[variant];
      for (const hue of [colour.field.hue, colour.forest.hue]) {
        expect(hue).toBeGreaterThanOrEqual(70);
        expect(hue).toBeLessThanOrEqual(160);
      }
      expect(colour.field.saturation).toBeLessThan(0.42);
    }
    expect(STYLE_A.light.field.lightness).toBeLessThan(0.55);
    expect(STYLE_A.dark.field.lightness).toBeLessThan(STYLE_A.light.field.lightness);
  });
});

describe("Fade where a Block is claimed", () => {
  it("is zero next to a claimed Block, one when far away, and rises in between", () => {
    expect(sceneryFade(0)).toBe(0);
    expect(sceneryFade(1)).toBe(0);
    expect(sceneryFade(TERRAIN.fadeRadius + 10)).toBe(1);
    const mid = sceneryFade(2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(sceneryFade(3)).toBeGreaterThan(mid);
  });
});
