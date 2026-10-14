/**
 * Building types and language colours, shared by the CLI (which decides them) and the page (which draws them).
 * A Building type's id is its index in BUILDING_TYPES and is stored in the world file.
 */
export const BUILDING_TYPES = [
  "office",
  "laboratory",
  "library",
  "utility",
  "factory",
  "storage",
  "warehouse",
  "rail-yard",
  "house",
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

/** A language's roof and trim colour. Index 0 is the fallback for unknown extensions. */
export const LANGUAGES: readonly { name: string; extensions: readonly string[]; colour: number }[] = [
  { name: "other", extensions: [], colour: 0x8a949e },
  { name: "TypeScript", extensions: ["ts", "tsx", "mts", "cts"], colour: 0x3178c6 },
  { name: "JavaScript", extensions: ["js", "jsx", "mjs", "cjs"], colour: 0xf0c419 },
  { name: "Python", extensions: ["py", "pyi"], colour: 0x3c7dab },
  { name: "Go", extensions: ["go"], colour: 0x00add8 },
  { name: "Rust", extensions: ["rs"], colour: 0xdea584 },
  { name: "Ruby", extensions: ["rb"], colour: 0xcc342d },
  { name: "Java", extensions: ["java", "kt"], colour: 0xb07219 },
  { name: "C family", extensions: ["c", "h", "cc", "cpp", "hpp"], colour: 0x555555 },
  { name: "Shell", extensions: ["sh", "bash", "zsh"], colour: 0x89e051 },
  { name: "Web", extensions: ["html", "css", "scss", "vue", "svelte"], colour: 0xe34c26 },
];

/** The language index of an extension (lower case, no dot). 0 when no language claims it. */
export function languageIndex(extension: string): number {
  const found = LANGUAGES.findIndex((language) => language.extensions.includes(extension));
  return found === -1 ? 0 : found;
}
