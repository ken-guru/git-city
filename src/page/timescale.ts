/**
 * The story ribbon's clock: how the playhead moves through the Timeline (SPEC §11, Player).
 *
 * The playhead `t` is a position in Steps: Step i is at t = i, and between Steps the position is linear.
 * A speed mode maps Steps onto a clock: Real time puts Steps on a day clock (a quiet stretch is capped at a week,
 * same-day commits are spread by 0.15 day), Per commit puts them on a commit clock (a Step takes as many commits
 * as it holds). Speeds are clock units per second, so the playhead's pace is `speed / slope` Steps per second.
 */

export type Mode = "real" | "commit";

/** A quiet stretch between Steps never takes longer than this on the Real time clock. */
export const QUIET_CAP_DAYS = 7;
/** Same-day commits are spread this far apart on the Real time clock. */
export const SAME_DAY_SPACING = 0.15;

const DAYS_PER_YEAR = 365.25;
export const REAL_SPEEDS = [
  { label: "1 week/s", daysPerSecond: 7 },
  { label: "1 month/s", daysPerSecond: DAYS_PER_YEAR / 12 },
  { label: "3 months/s", daysPerSecond: DAYS_PER_YEAR / 4 },
  { label: "1 year/s", daysPerSecond: DAYS_PER_YEAR },
] as const;
export const COMMIT_SPEEDS = [5, 15, 40, 120] as const;
const DEFAULT_SPEED: Record<Mode, number> = { real: 1, commit: 1 };

/** Maps Step positions onto the two clocks. The knots are the clock value at each Step's start. */
export class Timescale {
  readonly steps: number;
  private readonly knots: Record<Mode, Float64Array>;
  private readonly ends: Record<Mode, number>;

  constructor(commitDays: ArrayLike<number>, stepCommits: ArrayLike<number>) {
    const n = commitDays.length;
    this.steps = n;
    const real = new Float64Array(n);
    const commit = new Float64Array(n);
    for (let i = 0; i + 1 < n; i++) {
      const gap = commitDays[i + 1]! - commitDays[i]!;
      real[i + 1] = real[i]! + (gap <= 0 ? SAME_DAY_SPACING : Math.min(QUIET_CAP_DAYS, gap));
      commit[i + 1] = commit[i]! + stepCommits[i]!;
    }
    this.knots = { real, commit };
    // The clock runs to the end of the last Step, so the ribbon's last bar has a width.
    this.ends = {
      real: n === 0 ? 0 : real[n - 1]! + SAME_DAY_SPACING,
      commit: n === 0 ? 0 : commit[n - 1]! + stepCommits[n - 1]!,
    };
  }

  /** The clock value at Step position `t`. */
  clock(mode: Mode, t: number): number {
    const k = this.knots[mode];
    const n = this.steps;
    if (n === 0 || t <= 0) return 0;
    if (t >= n - 1) return k[n - 1]!;
    const i = Math.floor(t);
    return k[i]! + (t - i) * (k[i + 1]! - k[i]!);
  }

  /** The Step position at clock value `c`: the inverse of `clock`. */
  unclock(mode: Mode, c: number): number {
    const k = this.knots[mode];
    const n = this.steps;
    if (n < 2 || c <= 0) return 0;
    if (c >= k[n - 1]!) return n - 1;
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (k[mid]! <= c) lo = mid;
      else hi = mid - 1;
    }
    return lo + (c - k[lo]!) / (k[lo + 1]! - k[lo]!);
  }

  /** Clock units per Step at position `t`: how much clock one Step takes at that place. */
  slope(mode: Mode, t: number): number {
    const k = this.knots[mode];
    const n = this.steps;
    if (n < 2) return 1;
    const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
    return k[i + 1]! - k[i]!;
  }

  /** The clock's total length: where the last Step ends. */
  end(mode: Mode): number {
    return this.ends[mode];
  }
}

export type Action =
  | { type: "toggle" }
  | { type: "step"; by: number }
  | { type: "start" }
  | { type: "latest" }
  | { type: "reverse" };

/** The keyboard controls of the ribbon (SPEC §11, Player). Undefined for keys the ribbon does not use. */
export function keyAction(key: string, shift: boolean): Action | undefined {
  switch (key) {
    case " ":
      return { type: "toggle" };
    case "ArrowRight":
      return { type: "step", by: shift ? 10 : 1 };
    case "ArrowLeft":
      return { type: "step", by: shift ? -10 : -1 };
    case "Home":
      return { type: "start" };
    case "End":
      return { type: "latest" };
    case "r":
    case "R":
      return { type: "reverse" };
    default:
      return undefined;
  }
}

/** The playhead and its transport: play, play backwards, pause, seek, speed and mode. Headless, so tests drive it directly. */
export class Player {
  /** The playhead, in Steps. */
  t = 0;
  playing = false;
  reverse = false;
  mode: Mode = "real";
  private speedIndex = DEFAULT_SPEED.real;

  constructor(readonly scale: Timescale) {}

  /** The last Step position: where playback stops. */
  get endTime(): number {
    return Math.max(0, this.scale.steps - 1);
  }

  /** The speeds the current mode offers, in clock units per second. */
  speeds(): readonly number[] {
    return this.mode === "real" ? REAL_SPEEDS.map((s) => s.daysPerSecond) : COMMIT_SPEEDS;
  }

  speedIndexValue(): number {
    return this.speedIndex;
  }

  setSpeed(index: number): void {
    this.speedIndex = Math.min(this.speeds().length - 1, Math.max(0, index));
  }

  /** Switches the clock. The playhead keeps its Step. */
  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.speedIndex = DEFAULT_SPEED[mode];
  }

  /** Steps per second at the playhead's place on the current clock. */
  stepsPerSecond(): number {
    return this.speeds()[this.speedIndex]! / this.scale.slope(this.mode, this.t);
  }

  play(reverse = false): void {
    this.reverse = reverse;
    if (reverse && this.t <= 0) this.t = this.endTime;
    if (!reverse && this.t >= this.endTime) this.t = 0;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play(this.reverse);
  }

  seek(t: number): void {
    this.t = Math.min(this.endTime, Math.max(0, t));
  }

  /**
   * Moves the playhead by `seconds` of viewing time. Forward playback holds at the last loaded Step (`loaded`, -1 when
   * none) until the next chunk arrives; a finished or fully rewound playhead stops.
   */
  advance(seconds: number, loaded: number): void {
    if (!this.playing) return;
    const rate = this.stepsPerSecond();
    if (this.reverse) {
      this.t = Math.max(0, this.t - seconds * rate);
      if (this.t <= 0) this.playing = false;
      return;
    }
    const limit = loaded >= this.endTime ? this.endTime : Math.max(-1, loaded);
    if (this.t >= limit) return;
    this.t = Math.min(limit, this.t + seconds * rate);
    if (this.t >= this.endTime) this.playing = false;
  }

  /**
   * What the City can show: the playhead is `waiting` when it is past the loaded history, the City draws
   * `displayed` (the last loaded Step at most), and the ribbon marks `target`.
   */
  buffer(loaded: number): { waiting: boolean; displayed: number; target: number } {
    return { waiting: this.t > loaded, displayed: Math.min(this.t, Math.max(0, loaded)), target: this.t };
  }
}
