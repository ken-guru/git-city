import { readFileSync } from "node:fs";
import { ROLES, type Role } from "./layout.js";

/** Keys every Theme must supply: each Role, plus a fallback for Roles nobody has detected. */
export const THEME_KEYS = [...ROLES, "fallback"] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

/**
 * A Theme pack: data only, validated against schema/theme.schema.json. The loader below is the
 * same one a user file path will use later.
 */
export interface Theme {
  name: string;
  display: { title: string; description: string };
  wordPieces: { prefixes: string[]; suffixes: string[] };
  streetSuffixes: string[];
  roleNouns: Record<ThemeKey, string>;
  palette: Record<ThemeKey, { hue: number }>;
}

export class ThemeError extends Error {}

/** The Themes that ship with GitCity, in `themes/` at the package root. */
export const BUILT_IN_THEMES = ["modern", "medieval"] as const;
export const DEFAULT_THEME = "modern";

/** Loads a built-in Theme by name. Unknown names are refused. */
export function loadTheme(name: string): Theme {
  if (!(BUILT_IN_THEMES as readonly string[]).includes(name)) {
    throw new ThemeError(`unknown theme "${name}"; the built-in themes are ${BUILT_IN_THEMES.join(", ")}`);
  }
  const url = new URL(`../../themes/${name}.json`, import.meta.url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(url, "utf8"));
  } catch (e) {
    throw new ThemeError(`cannot read theme "${name}": ${(e as Error).message}`);
  }
  return validateTheme(parsed);
}

/** Checks a parsed pack against the schema's rules and returns it typed. Throws ThemeError naming the first problem. */
export function validateTheme(value: unknown): Theme {
  const where = "theme";
  if (!isObject(value)) throw new ThemeError(`${where} must be an object`);
  const allowed = ["$schema", "name", "display", "wordPieces", "streetSuffixes", "roleNouns", "palette"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ThemeError(`${where}: unknown key "${key}"`);
  }

  const name = value.name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) throw new ThemeError(`${where}: "name" must be a lower-case word`);

  const display = object(value.display, "display");
  const wordPieces = object(value.wordPieces, "wordPieces");
  const roleNouns = object(value.roleNouns, "roleNouns");
  const palette = object(value.palette, "palette");

  for (const key of THEME_KEYS) {
    const noun = roleNouns[key];
    if (noun === undefined) throw new ThemeError(`${where}: roleNouns is missing "${key}"`);
    if (typeof noun !== "string" || !/^[A-Za-z]+( [A-Za-z]+)*$/.test(noun) || noun.length > 24) {
      throw new ThemeError(`${where}: roleNouns.${key} must be a short noun`);
    }
    const swatch = palette[key];
    if (swatch === undefined) throw new ThemeError(`${where}: palette is missing "${key}"`);
    const hue = object(swatch, `palette.${key}`).hue;
    if (typeof hue !== "number" || hue < 0 || hue > 360) throw new ThemeError(`${where}: palette.${key}.hue must be 0 to 360`);
  }
  for (const key of Object.keys(roleNouns)) {
    if (!(THEME_KEYS as readonly string[]).includes(key)) throw new ThemeError(`${where}: roleNouns has unknown key "${key}"`);
  }
  for (const key of Object.keys(palette)) {
    if (!(THEME_KEYS as readonly string[]).includes(key)) throw new ThemeError(`${where}: palette has unknown key "${key}"`);
  }

  return {
    name,
    display: { title: text(display.title, "display.title"), description: text(display.description, "display.description") },
    wordPieces: {
      prefixes: strings(wordPieces.prefixes, "wordPieces.prefixes", /^[A-Za-z]+$/),
      suffixes: strings(wordPieces.suffixes, "wordPieces.suffixes", /^[a-z]+$/),
    },
    streetSuffixes: strings(value.streetSuffixes, "streetSuffixes", /^[A-Za-z ]+$/),
    roleNouns: roleNouns as Record<ThemeKey, string>,
    palette: Object.fromEntries(THEME_KEYS.map((key) => [key, { hue: (palette[key] as { hue: number }).hue }])) as Record<ThemeKey, { hue: number }>,
  };
}

/** The palette hue of a Role, falling back to the fallback swatch for no Role. */
export function hueFor(theme: Theme, role: Role | null): number {
  return theme.palette[role ?? "fallback"].hue;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) throw new ThemeError(`theme: "${where}" must be an object`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ThemeError(`theme: "${where}" must be a non-empty string`);
  return value;
}

function strings(value: unknown, where: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ThemeError(`theme: "${where}" must be a non-empty list`);
  return value.map((item, i) => {
    if (typeof item !== "string" || !pattern.test(item)) throw new ThemeError(`theme: ${where}[${i}] is not a valid word`);
    return item;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
