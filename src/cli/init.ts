import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SHARED_CONFIG } from "./build.js";
import { git, gitMaybe } from "./git.js";
import { BUILT_IN_THEMES } from "./theme.js";

/** The personal config, relative to the git directory (the same path build reads). */
const PERSONAL_CONFIG = "git-city/config.jsonc";

export class InitError extends Error {}

export interface InitOptions {
  /** `--shared`: write the committed config at the repo root instead of the personal one. */
  shared: boolean;
}

/**
 * Writes a commented starter config and returns its path. The file lists what was detected at HEAD: the directories
 * with a package manifest as Modules, the packages those manifests declare as External Dependencies, and the built-in
 * Themes. It never overwrites an existing config.
 */
export async function initConfig(repoDir: string, options: InitOptions): Promise<string> {
  const top = await gitMaybe(repoDir, ["rev-parse", "--show-toplevel"]);
  if (top === undefined || top === "") throw new InitError(`not a git repository: ${repoDir}`);
  const path = options.shared ? join(top, SHARED_CONFIG) : await personalConfigPath(top);
  const manifests = await readManifests(top);
  const text = starterText(detectModules(manifests), detectExternals(manifests));
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

async function personalConfigPath(top: string): Promise<string> {
  const relative = await gitMaybe(top, ["rev-parse", "--git-path", PERSONAL_CONFIG]);
  return resolve(top, relative ?? join(".git", PERSONAL_CONFIG));
}

/** A package manifest at HEAD: its folder relative to the root ("" for the root) and its parsed fields. */
export interface Manifest {
  dir: string;
  dependencies: string[];
  devDependencies: string[];
}

/** Every package.json at HEAD, read from the object database. Unreadable manifests are skipped. */
export async function readManifests(top: string): Promise<Manifest[]> {
  const listed = (await gitMaybe(top, ["ls-tree", "-r", "--name-only", "HEAD"])) ?? "";
  const paths = listed.split("\n").filter((p) => p === "package.json" || p.endsWith("/package.json"));
  const manifests: Manifest[] = [];
  for (const path of paths) {
    let json: unknown;
    try {
      json = JSON.parse(await git(top, ["show", `HEAD:${path}`]));
    } catch {
      continue;
    }
    if (typeof json !== "object" || json === null) continue;
    const fields = json as Record<string, unknown>;
    manifests.push({
      dir: path === "package.json" ? "" : dirname(path),
      dependencies: Object.keys(objectOf(fields.dependencies)),
      devDependencies: Object.keys(objectOf(fields.devDependencies)),
    });
  }
  return manifests;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Modules: the folders below the root that have a package manifest (SPEC §5, GLOSSARY "Module"), sorted. */
export function detectModules(manifests: readonly Manifest[]): string[] {
  return manifests
    .map((m) => m.dir)
    .filter((dir) => dir !== "")
    .sort();
}

/**
 * External Dependencies: the packages that a manifest declares, development ones included (GLOSSARY). Imports that no
 * manifest declares are not listed. Sorted, without duplicates.
 */
export function detectExternals(manifests: readonly Manifest[]): string[] {
  const names = new Set<string>();
  for (const m of manifests) for (const name of [...m.dependencies, ...m.devDependencies]) names.add(name);
  return [...names].sort();
}

/** The starter text. Every setting is commented out, so the file changes nothing until someone edits it. */
export function starterText(modules: readonly string[], externals: readonly string[]): string {
  const list = (items: readonly string[]) => (items.length === 0 ? "none" : items.join(", "));
  const themes = [...BUILT_IN_THEMES].sort();
  return `// git-city configuration (JSONC), written by \`git-city init\`.
// Everything below is optional; every line is commented out, so nothing changes until you edit it.
// Flags beat this file, and a Rule can only reveal names that the defaults hide if you write it.
//
// Detected Modules (folders with a package manifest): ${list(modules)}
// Detected External Dependencies (declared in a manifest): ${list(externals)}
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
