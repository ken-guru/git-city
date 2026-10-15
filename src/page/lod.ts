/**
 * Level of detail for the page. The level is chosen from the measured frame rate and nothing else:
 * it changes how the City is drawn (distances, windows, props, scenery, labels, render resolution),
 * never the data, layout or names.
 */

/** The most detailed level is 0; each step down draws less. */
export const MAX_LEVEL = 2;

/** Frame rate is averaged over this many milliseconds before the level may change. */
const WINDOW_MS = 1000;
/** A gap longer than this (a hidden tab, a stalled device) restarts the measurement. */
const GAP_MS = 500;
/** Below DOWN_FPS the level drops; above UP_FPS it rises again. The gap between them stops flicker. */
const DOWN_FPS = 45;
const UP_FPS = 58;

/** What each level draws. Distances are in world units from the camera. */
export interface LodSettings {
  /** Windows fade from full at `windowNear` to none at `windowFar`. */
  windowNear: number;
  windowFar: number;
  /** Roof props are hidden beyond this distance. */
  propFar: number;
  /** Scenery thins linearly to `sceneryFloor` of its items at `sceneryFar`. */
  sceneryFar: number;
  sceneryFloor: number;
  /** Blocks beyond this distance draw as simple masses. */
  massFar: number;
  /** Labels are hidden beyond this distance. */
  labelFar: number;
  /** Highest device pixel ratio the renderer uses. */
  pixelRatioCap: number;
}

const SETTINGS: readonly LodSettings[] = [
  { windowNear: 14, windowFar: 40, propFar: Number.POSITIVE_INFINITY, sceneryFar: 150, sceneryFloor: 1, massFar: 240, labelFar: Number.POSITIVE_INFINITY, pixelRatioCap: 2 },
  { windowNear: 10, windowFar: 24, propFar: 40, sceneryFar: 80, sceneryFloor: 0.5, massFar: 160, labelFar: 80, pixelRatioCap: 1.5 },
  { windowNear: 6, windowFar: 16, propFar: 24, sceneryFar: 50, sceneryFloor: 0.2, massFar: 100, labelFar: 50, pixelRatioCap: 1 },
];

export function settingsFor(level: number): LodSettings {
  return SETTINGS[Math.min(MAX_LEVEL, Math.max(0, Math.round(level)))]!;
}

/**
 * The scale the distances of a level are multiplied by, so that the City's detail is in proportion to the distance it
 * opens from. The settings were tuned for the level-0 mass distance: a City framed from farther away scales them up,
 * so its centre Blocks open as Buildings rather than masses. Never below one.
 */
export function detailScaleFor(startDistance: number): number {
  return Math.max(1, startDistance / settingsFor(0).massFar);
}

/** A level with its distances scaled (see `detailScaleFor`). The floors and the render resolution are unchanged. */
export function scaledSettings(settings: LodSettings, scale: number): LodSettings {
  return {
    ...settings,
    windowNear: settings.windowNear * scale,
    windowFar: settings.windowFar * scale,
    propFar: settings.propFar * scale,
    sceneryFar: settings.sceneryFar * scale,
    massFar: settings.massFar * scale,
    labelFar: settings.labelFar * scale,
  };
}

/**
 * Whether one scenery item is drawn. `roll` is a fixed value in [0, 1) per item, so the same items
 * stay (or go) as the camera moves, and only the share of items kept changes with distance.
 */
export function sceneryKept(distance: number, settings: LodSettings, roll: number): boolean {
  const thinning = Math.min(1, Math.max(0, distance / settings.sceneryFar));
  const fraction = 1 - (1 - settings.sceneryFloor) * thinning;
  return roll < fraction;
}

export function labelVisible(distance: number, settings: LodSettings): boolean {
  return distance <= settings.labelFar;
}

export class LodController {
  /** Current level, 0 (full detail) to MAX_LEVEL. */
  level = 0;
  /** Frame rate measured over the last full window, or NaN before the first one. */
  fps = Number.NaN;

  private windowStart = Number.NaN;
  private last = Number.NaN;
  private frames = 0;

  /**
   * Call once per animation frame with the frame's timestamp in milliseconds.
   * Returns true when the level changed on this frame.
   */
  frame(now: number): boolean {
    if (Number.isNaN(this.last) || now - this.last > GAP_MS) {
      this.restart(now);
      return false;
    }
    this.last = now;
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return false;

    this.fps = (this.frames * 1000) / elapsed;
    this.restart(now);

    const previous = this.level;
    if (this.fps < DOWN_FPS) this.level = Math.min(MAX_LEVEL, previous + 1);
    else if (this.fps > UP_FPS) this.level = Math.max(0, previous - 1);
    return this.level !== previous;
  }

  private restart(now: number) {
    this.windowStart = now;
    this.last = now;
    this.frames = 0;
  }
}
