import { type BuildingType, languageIndex } from "../shared/buildings.js";

export { BUILDING_TYPES, type BuildingType } from "../shared/buildings.js";

/**
 * Tuning values (SPEC §5). They are starting points; the config's `tuning` section will override them.
 * Floors = ceil(sqrt(lines) / FLOOR_K), at least 1, capped at FLOOR_CAP.
 */
export const TUNING = {
  floorK: 3,
  floorCap: 32,
  /** Scaffolding and a crane go up while a file has at least this many changes... */
  scaffoldChanges: 4,
  /** ...within this many days of Timeline time. */
  scaffoldWindowDays: 14,
} as const;

export const CATEGORIES = ["source", "tests", "docs", "config", "build", "data", "assets", "generated", "unknown"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * The `category` rule: the first matching pattern wins. The config ticket (#47) will make this user-editable;
 * until then it is this typed default.
 */
export const CATEGORY_RULES: readonly { pattern: RegExp; category: Category }[] = [
  { pattern: /(^|\/)(dist|build|out|coverage|vendor|node_modules)\/|(^|\/)package-lock\.json$|\.lock$|\.min\.(js|css)$/, category: "generated" },
  { pattern: /(^|\/)\.github\/|(^|\/)(Dockerfile|Makefile|Jenkinsfile)$|(^|\/)scripts\/|\.(sh|bash|ps1)$/, category: "build" },
  { pattern: /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$/, category: "tests" },
  { pattern: /(^|\/)docs?\/|\.(md|mdx|rst|adoc|txt)$/i, category: "docs" },
  { pattern: /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp3|mp4|wav|glb|gltf)$/i, category: "assets" },
  { pattern: /(^|\/)data\/|\.(csv|tsv|parquet|sqlite|db)$/i, category: "data" },
  { pattern: /(^|\/)\.[^/]+$|\.(json|jsonc|ya?ml|toml|ini|cfg|conf|env|xml)$|(^|\/)(package\.json|tsconfig[^/]*|\.editorconfig)$/, category: "config" },
  { pattern: /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|c|h|cc|cpp|hpp|cs|swift|php|vue|svelte|html|css|scss)$/i, category: "source" },
];

export function categoryOf(path: string, rules: readonly { pattern: RegExp; category: Category }[] = CATEGORY_RULES): Category {
  return rules.find((rule) => rule.pattern.test(path))?.category ?? "unknown";
}

const BUILDING_TYPE_OF_CATEGORY: Record<Category, BuildingType> = {
  source: "office",
  tests: "laboratory",
  docs: "library",
  config: "utility",
  build: "factory",
  data: "storage",
  assets: "warehouse",
  generated: "rail-yard",
  unknown: "house",
};

export function buildingTypeOf(category: Category): BuildingType {
  return BUILDING_TYPE_OF_CATEGORY[category];
}

/** Floors for a file of `lines` lines: ceil(sqrt(lines) / k), at least 1, capped. */
export function floorsFor(lines: number, k: number = TUNING.floorK, cap: number = TUNING.floorCap): number {
  return Math.min(cap, Math.max(1, Math.ceil(Math.sqrt(Math.max(0, lines)) / k)));
}

/** The language index (see LANGUAGES) of a path's extension. */
export function languageOf(path: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? 0 : languageIndex(name.slice(dot + 1).toLowerCase());
}

/** A Building's seed: the City seed combined with its birth-order number. Same inputs, same seed. */
export function seedFor(birthOrder: number, citySeed = 0): number {
  let x = (Math.imul(citySeed, 0x9e3779b1) + birthOrder) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
