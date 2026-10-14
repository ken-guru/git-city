import { describe, expect, it } from "vitest";
import { COMMIT_SPEEDS, keyAction, Player, QUIET_CAP_DAYS, REAL_SPEEDS, SAME_DAY_SPACING, Timescale } from "../src/page/timescale.js";

// Days 0, 0, 1, 10, 30: one same-day pair, a one-day gap, a nine-day quiet stretch, and a twenty-day quiet stretch.
const days = [0, 0, 1, 10, 30];
const ones = [1, 1, 1, 1, 1];

describe("Timescale: Real time", () => {
  const scale = new Timescale(days, ones);

  it("spaces same-day commits by 0.15 day and caps quiet stretches at one week", () => {
    expect(SAME_DAY_SPACING).toBeCloseTo(0.15);
    expect(QUIET_CAP_DAYS).toBe(7);
    expect(scale.clock("real", 0)).toBeCloseTo(0);
    expect(scale.clock("real", 1)).toBeCloseTo(0.15);
    expect(scale.clock("real", 2)).toBeCloseTo(1.15);
    expect(scale.clock("real", 3)).toBeCloseTo(8.15);
    expect(scale.clock("real", 4)).toBeCloseTo(15.15);
  });

  it("interpolates inside a Step and inverts the mapping", () => {
    expect(scale.clock("real", 0.5)).toBeCloseTo(0.075);
    for (const t of [0, 0.3, 1.7, 3.2, 4]) {
      expect(scale.unclock("real", scale.clock("real", t))).toBeCloseTo(t);
    }
  });

  it("offers the four Real time speeds in days per second", () => {
    expect(REAL_SPEEDS.map((s) => s.daysPerSecond)).toEqual([7, 365.25 / 12, 365.25 / 4, 365.25]);
  });
});

describe("Timescale: Per commit", () => {
  // A grouped Step of 12 commits is a stretch: it takes twelve commits of playback.
  const scale = new Timescale([0, 1, 2, 3], [1, 12, 3, 1]);

  it("maps each Step to its real commits, so a grouped Step is one stretch", () => {
    expect(scale.clock("commit", 1)).toBeCloseTo(1);
    expect(scale.clock("commit", 2)).toBeCloseTo(13);
    expect(scale.clock("commit", 1.5)).toBeCloseTo(7);
    expect(scale.clock("commit", 3)).toBeCloseTo(16);
  });

  it("offers the four Per commit speeds", () => {
    expect(COMMIT_SPEEDS).toEqual([5, 15, 40, 120]);
  });
});

describe("Player", () => {
  it("keeps the current commit when the mode changes", () => {
    const player = new Player(new Timescale(days, ones));
    player.seek(2.5);
    player.setMode("commit");
    expect(player.t).toBeCloseTo(2.5);
    player.setMode("real");
    expect(player.t).toBeCloseTo(2.5);
  });

  it("plays at the Real time speed, measured in steps per second at the current place", () => {
    const player = new Player(new Timescale(days, ones));
    player.setSpeed(1); // one month per second
    player.seek(0);
    // Between Steps 0 and 1 a day is 0.15 units of clock, so the playhead moves at 30.4375 / 0.15 Steps per second.
    expect(player.stepsPerSecond()).toBeCloseTo(365.25 / 12 / 0.15);
    player.play();
    player.advance(0.01, 100);
    expect(player.t).toBeCloseTo((0.01 * (365.25 / 12)) / 0.15, 6);
  });

  it("plays at the Per commit speed", () => {
    const player = new Player(new Timescale([0, 1, 2], [1, 12, 1]));
    player.setMode("commit");
    player.setSpeed(0); // 5 commits per second
    player.seek(1);
    expect(player.stepsPerSecond()).toBeCloseTo(5 / 12);
  });

  it("holds at the last loaded commit and reports waiting when scrubbing past it", () => {
    const player = new Player(new Timescale(Array.from({ length: 100 }, (_, i) => i), new Array(100).fill(1)));
    player.setMode("commit");
    player.setSpeed(0);
    player.seek(4.9);
    player.play();
    player.advance(10, 5);
    expect(player.playing).toBe(true);
    expect(player.t).toBeCloseTo(5);
    expect(player.buffer(5)).toEqual({ waiting: false, displayed: 5, target: 5 });
    player.seek(20);
    expect(player.buffer(5)).toEqual({ waiting: true, displayed: 5, target: 20 });
  });

  it("plays backwards to the first commit and stops there", () => {
    const player = new Player(new Timescale(days, ones));
    player.setMode("commit");
    player.setSpeed(3);
    player.seek(1);
    player.play(true);
    player.advance(10, 4);
    expect(player.t).toBe(0);
    expect(player.playing).toBe(false);
  });

  it("stops at the latest commit and restarts from the beginning when played again", () => {
    const player = new Player(new Timescale(days, ones));
    player.seek(3.9);
    player.play();
    player.advance(100, 4);
    expect(player.t).toBe(4);
    expect(player.playing).toBe(false);
    player.play();
    expect(player.t).toBe(0);
    expect(player.playing).toBe(true);
  });

  it("clamps seeks to the timeline", () => {
    const player = new Player(new Timescale(days, ones));
    player.seek(-3);
    expect(player.t).toBe(0);
    player.seek(99);
    expect(player.t).toBe(4);
  });
});

describe("keyAction", () => {
  it("maps the keyboard controls of the ribbon", () => {
    expect(keyAction(" ", false)).toEqual({ type: "toggle" });
    expect(keyAction("ArrowRight", false)).toEqual({ type: "step", by: 1 });
    expect(keyAction("ArrowLeft", false)).toEqual({ type: "step", by: -1 });
    expect(keyAction("ArrowRight", true)).toEqual({ type: "step", by: 10 });
    expect(keyAction("ArrowLeft", true)).toEqual({ type: "step", by: -10 });
    expect(keyAction("Home", false)).toEqual({ type: "start" });
    expect(keyAction("End", false)).toEqual({ type: "latest" });
    expect(keyAction("r", false)).toEqual({ type: "reverse" });
    expect(keyAction("R", true)).toEqual({ type: "reverse" });
    expect(keyAction("x", false)).toBeUndefined();
  });
});
