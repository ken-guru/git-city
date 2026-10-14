/**
 * The Countryside: seeded, fixed scenery between Villages. Hills, mountains, rivers, fields and forests
 * are functions of the City seed and a position on the Block grid, so the CLI (which keeps Villages off
 * rivers and hills) and the page (which draws them) agree without any data in the world file.
 * Nothing here stands for anything in the repo. Style only paints; relief and density are settings.
 */

/** Gentle hills: the highest point of the relief, in world units. */
export const RELIEF_MAX = 2.6;
/** Mountains: the tallest peak, in world units. Snowless. */
export const MOUNTAIN_MAX = 15;
export const RIVER_COUNT_RANGE = { min: 1, max: 3 } as const;

/** Tuning values for the scenery. Starting points, named so they can be configured. */
export const TERRAIN = {
  /** Cells per noise lattice step for hills. */
  hillScale: 7,
  /** A cell is a hill when its height exceeds this share of the relief. */
  hillShare: 0.7,
  /** Mountains rise only beyond this distance from the centre, in Block cells. */
  mountainStart: 40,
  /** Distance over which mountains reach full height. */
  mountainRamp: 30,
  mountainScale: 20,
  /** Half-width of a river, in cells, measured from its centre line. */
  riverHalfWidth: 0.75,
  /** No hills within this many cells of the centre, where the first Village always sits. */
  centreClear: 3,
  /** Scenery fades out within this many cells of a claimed Block. */
  fadeRadius: 6,
  riverAmplitude: 2.5,
  riverWander: 1.2,
} as const;

export const DEFAULT_SETTINGS = { relief: RELIEF_MAX, density: 0.5, rivers: 2 } as const;

export interface CountrysideSettings {
  /** Hill height in world units, at most RELIEF_MAX. Defaults to RELIEF_MAX. */
  relief?: number;
  /** 0 sparse to 1 dense: how much of the open land is fields and forest. */
  density?: number;
  /** Rivers, clamped to RIVER_COUNT_RANGE. */
  rivers?: number;
}

export type Level = "flat" | "hill" | "river";

export interface Point {
  col: number;
  row: number;
}

export interface River {
  index: number;
  /** Centre line row at a column, in Block cells (may be fractional). */
  rowAt(col: number): number;
  /** Samples the centre line from `from` to `to` (inclusive) every `step` columns. */
  polyline(from: number, to: number, step: number): Point[];
}

export interface Countryside {
  seed: number;
  settings: Required<CountrysideSettings>;
  rivers: River[];
  /** Hill height at a cell, from 0 to the relief. */
  heightAt(col: number, row: number): number;
  /** Mountain height at a cell, from 0 to MOUNTAIN_MAX. */
  mountainAt(col: number, row: number): number;
  /** The terrain a Village may not sit on, at a cell. Rivers win over hills. */
  levelAt(col: number, row: number): Level;
  /** Field, forest or open land for a flat cell. */
  coverAt(col: number, row: number): "field" | "forest" | "open";
}

/** Style A: muted naturalistic. Fields and forests sit in the green to yellow-green band paving never uses. */
export interface Swatch {
  hue: number;
  saturation: number;
  lightness: number;
}
export interface StyleColours {
  field: Swatch;
  forest: Swatch;
  hill: Swatch;
  mountain: Swatch;
  sand: Swatch;
  water: Swatch;
}
export const STYLE_A: Record<"light" | "dark", StyleColours> = {
  light: {
    field: { hue: 84, saturation: 0.26, lightness: 0.5 },
    forest: { hue: 125, saturation: 0.24, lightness: 0.36 },
    hill: { hue: 88, saturation: 0.2, lightness: 0.6 },
    mountain: { hue: 100, saturation: 0.12, lightness: 0.5 },
    sand: { hue: 45, saturation: 0.4, lightness: 0.74 },
    water: { hue: 200, saturation: 0.25, lightness: 0.5 },
  },
  dark: {
    field: { hue: 84, saturation: 0.22, lightness: 0.28 },
    forest: { hue: 125, saturation: 0.2, lightness: 0.2 },
    hill: { hue: 88, saturation: 0.16, lightness: 0.34 },
    mountain: { hue: 100, saturation: 0.1, lightness: 0.3 },
    sand: { hue: 45, saturation: 0.3, lightness: 0.42 },
    water: { hue: 200, saturation: 0.25, lightness: 0.28 },
  },
};

/** Deterministic unit value in [0, 1) from the seed, a salt, and coordinates. */
export function unit(seed: number, salt: number, a: number, b = 0): number {
  return mix(mix(mix(seed ^ mix(salt)) ^ mix(a | 0)) + (b | 0)) / 2 ** 32;
}

/** The hash every seeded value is built from. Shared with the layout so both sides agree. */
export function mix(value: number): number {
  let x = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Smooth value noise in [0, 1) over a lattice of spacing `scale` cells. */
function noise(seed: number, salt: number, col: number, row: number, scale: number): number {
  const x = col / scale;
  const y = row / scale;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const top = lerp(unit(seed, salt, x0, y0), unit(seed, salt, x0 + 1, y0), tx);
  const bottom = lerp(unit(seed, salt, x0, y0 + 1), unit(seed, salt, x0 + 1, y0 + 1), tx);
  return lerp(top, bottom, ty);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The Countryside for a City seed. Pure: the same seed and settings always give the same land. */
export function countryside(seed: number, settings: CountrysideSettings = {}): Countryside {
  const resolved: Required<CountrysideSettings> = {
    relief: settings.relief ?? DEFAULT_SETTINGS.relief,
    density: settings.density ?? DEFAULT_SETTINGS.density,
    rivers: clamp(settings.rivers ?? DEFAULT_SETTINGS.rivers, RIVER_COUNT_RANGE.min, RIVER_COUNT_RANGE.max),
  };
  const relief = Math.min(resolved.relief, RELIEF_MAX);

  const rivers: River[] = Array.from({ length: resolved.rivers }, (_, index) => makeRiver(seed, index));

  const heightAt = (col: number, row: number) => relief * noise(seed, 1, col, row, TERRAIN.hillScale);
  const mountainAt = (col: number, row: number) => {
    const d = Math.hypot(col, row);
    if (d < TERRAIN.mountainStart) return 0;
    const ramp = Math.min(1, (d - TERRAIN.mountainStart) / TERRAIN.mountainRamp);
    return MOUNTAIN_MAX * ramp * noise(seed, 3, col, row, TERRAIN.mountainScale);
  };
  const levelAt = (col: number, row: number): Level => {
    if (rivers.some((river) => Math.abs(row - river.rowAt(col)) < TERRAIN.riverHalfWidth)) return "river";
    const clear = Math.hypot(col, row) <= TERRAIN.centreClear;
    if (!clear && heightAt(col, row) > relief * TERRAIN.hillShare) return "hill";
    return "flat";
  };
  const coverAt = (col: number, row: number) => {
    if (levelAt(col, row) !== "flat") return "open";
    const n = noise(seed, 4, col, row, 5);
    const forestCut = 0.7 - 0.3 * resolved.density;
    const fieldCut = forestCut - 0.25;
    if (n > forestCut) return "forest";
    if (n > fieldCut) return "field";
    return "open";
  };

  return { seed, settings: resolved, rivers, heightAt, mountainAt, levelAt, coverAt };
}

function makeRiver(seed: number, index: number): River {
  // Rivers run across the land, alternating sides of the centre, further out with each pair.
  const tier = Math.floor(index / 2);
  const side = index % 2 === 0 ? 1 : -1;
  const base = side * (14 + 12 * tier + 8 * unit(seed, 5, index));
  const phase = unit(seed, 6, index) * Math.PI * 2;
  const wander = unit(seed, 7, index) * Math.PI * 2;
  const rowAt = (col: number) =>
    base +
    TERRAIN.riverAmplitude * Math.sin((col * Math.PI * 2) / 37 + phase) +
    TERRAIN.riverWander * Math.sin((col * Math.PI * 2) / 11 + wander);
  return {
    index,
    rowAt,
    polyline(from, to, step) {
      const points: Point[] = [];
      for (let i = 0; from + i * step <= to + 1e-9; i++) {
        const col = from + i * step;
        points.push({ col, row: rowAt(col) });
      }
      return points;
    },
  };
}

/**
 * How much scenery is shown at a cell `distance` cells from the nearest claimed Block:
 * 0 (gone) next to a claimed Block, 1 (full) beyond the fade radius.
 */
export function sceneryFade(distance: number): number {
  return clamp((distance - 1) / (TERRAIN.fadeRadius - 1), 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
