import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { SHARED_CONFIG } from "./build.js";
import { gitMaybe } from "./git.js";
import { BUILT_IN_THEMES } from "./theme.js";

/** The personal config, relative to the git directory (the same path build reads). */
const PERSONAL_CONFIG = "git-city/config.jsonc";
/** How many External Dependencies the starter lists, most used first. */
const LISTED_EXTERNALS = 25;
/** Source files whose imports `init` scans, the same languages the import graph reads. */
const SOURCE_PATHSPECS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

export class InitError extends Error {}

export interface InitOptions {
  /** `--shared`: write the committed config at the repo root instead of the personal one. */
  shared: boolean;
}

/**
 * Writes a commented starter config and returns its path. The file lists what was detected at HEAD: top-level
 * folders as Modules, bare package names imported by the source as External Dependencies, and the built-in Themes.
 * It never overwrites an existing config.
 */
export async function initConfig(repoDir: string, options: InitOptions): Promise<string> {
  if ((await gitMaybe(repoDir, ["rev-parse", "--git-dir"])) === undefined) throw new InitError(`not a git repository: ${repoDir}`);
  const path = options.shared ? join(repoDir, SHARED_CONFIG) : await personalConfigPath(repoDir);
  const text = starterText(await detectModules(repoDir), await detectExternals(repoDir));
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") {
      throw new InitError(`${path} already exists; edit it, or remove it to start again`);
    }
    throw e;
  }
  return path;
}

async function personalConfigPath(repoDir: string): Promise<string> {
  const relative = await gitMaybe(repoDir, ["rev-parse", "--git-path", PERSONAL_CONFIG]);
  return resolve(repoDir, relative ?? join(".git", PERSONAL_CONFIG));
}

/** Top-level folders at HEAD, sorted. */
export async function detectModules(repoDir: string): Promise<string[]> {
  const out = (await gitMaybe(repoDir, ["ls-tree", "-d", "--name-only", "HEAD"])) ?? "";
  return out === "" ? [] : out.split("\n").sort();
}

/** Bare package names imported at HEAD, most used first (ties by name). Relative imports and Node built-ins are left out. */
export async function detectExternals(repoDir: string): Promise<string[]> {
  const out = await gitMaybe(repoDir, [
    "grep",
    "-o",
    "-h",
    "-E",
    `(from|import|require\\()[[:space:]]*['"][^'"]+['"]`,
    "HEAD",
    "--",
    ...SOURCE_PATHSPECS,
  ]);
  if (out === undefined || out === "") return [];
  const builtins = new Set(builtinModules);
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const match = /['"]([^'"]+)['"]$/.exec(line.trim());
    const specifier = match?.[1];
    if (specifier === undefined || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
    const name = packageName(specifier);
    if (builtins.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LISTED_EXTERNALS)
    .map(([name]) => name);
}

/** `@scope/name/sub` → `@scope/name`; `pkg/sub` → `pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The starter text. Every setting is commented out, so the file changes nothing until someone edits it. */
export function starterText(modules: readonly string[], externals: readonly string[]): string {
  const list = (items: readonly string[]) => (items.length === 0 ? "none" : items.join(", "));
  const themes = [...BUILT_IN_THEMES].sort();
  return `// git-city configuration (JSONC), written by \`git-city init\`.
// Everything below is optional; every line is commented out, so nothing changes until you edit it.
// Flags beat this file, and a Rule can only reveal names that the defaults hide if you write it.
//
// Detected Modules (top-level folders): ${list(modules)}
// Detected External Dependencies: ${list(externals)}
// Themes: ${list(themes)}
{
  // "theme": "modern",
  // "naming": { "seed": "change-me" },
  // "exclude": ["vendor/**"],
  // "rules": [
  //   { "path": "src/billing/**", "action": "pseudonym", "as": "Ledger" },
  //   { "path": "src/public/**", "action": "reveal" },
  // ],
}
`;
}
