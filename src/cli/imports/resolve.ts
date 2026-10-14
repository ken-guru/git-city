import { builtinModules } from "node:module";
import { parseJsonc } from "../jsonc.js";

/**
 * Import resolution (SPEC §4, Resolve), for TS/JS. A specifier is resolved against one commit's path set
 * and the text of its config files. No filesystem and no `node_modules`.
 *
 * Every probe is recorded. A reverse index from probed path to importer lets the graph re-resolve only the
 * imports a path addition or deletion can change, or everything when a config file changes.
 */

/** One commit's view of the repo: its file paths, and the text of any file that is read for config. */
export interface Snapshot {
  readonly paths: ReadonlySet<string>;
  read(path: string): string | undefined;
}

/** A commit's files: each path maps to its text (use "" for a source file whose text is not needed). */
export function createSnapshot(files: Record<string, string>): Snapshot {
  const paths = new Set(Object.keys(files));
  return { paths, read: (path) => (paths.has(path) ? files[path] : undefined) };
}

/** Where an import points. A file in the repo, or a package outside it (classified later by manifest). */
export type Resolution = { kind: "file"; path: string } | { kind: "package"; name: string };

export interface Resolved {
  /** undefined when the import points at nothing GitCity keeps: a missing file, or a builtin. */
  target: Resolution | undefined;
  /** Every path checked on the way, whether or not it existed. Changing one can change the result. */
  probes: string[];
}

/** Extensions tried after a bare relative stem, in TypeScript's priority order. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** A JS-family extension in a specifier maps to the TypeScript source that builds it. */
const JS_EXTENSION = /\.(js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.ts$/;
const TS_FOR_JS = [".ts", ".tsx", ".d.ts", ".mts", ".cts"];
/** Output folders that map back to source (`dist/x.js` → `src/x.ts`). */
const BUILD_DIRS = new Set(["dist", "build", "lib", "out"]);
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => m.replace(/^node:/, ""))]);

/** Resolves `specifier` as imported from the file at `fromPath`. */
export function resolveImport(snapshot: Snapshot, fromPath: string, specifier: string): Resolved {
  const r = new Resolver(snapshot);
  const target = r.resolve(fromPath, specifier);
  return { target, probes: r.probes };
}

/** The effective `paths` and `baseUrl` of a tsconfig, with each one's own base directory (inherited through extends). */
interface TsconfigView {
  baseUrl: string | undefined;
  /** Directory that `baseUrl` is relative to. */
  baseDir: string;
  /** Directory that `paths` targets are relative to when there is no baseUrl. */
  pathsDir: string;
  paths: Record<string, string[]>;
}

class Resolver {
  readonly probes: string[] = [];
  private readonly tsconfigCache = new Map<string, TsconfigView | null>();
  private readonly workspaceCache = new Map<string, Map<string, string> | undefined>();

  constructor(private readonly snap: Snapshot) {}

  resolve(fromPath: string, specifier: string): Resolution | undefined {
    if (specifier === "" || specifier.startsWith("/")) return undefined;
    if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) {
      return this.file(this.stemOf(fromPath, specifier));
    }
    if (specifier.startsWith("#")) return this.packageImports(fromPath, specifier);
    if (BUILTINS.has(specifier) || specifier.startsWith("node:")) return undefined;

    const { name, sub } = splitPackage(specifier);
    // Path aliases first, then baseUrl (TypeScript's lookup order).
    const aliased = this.paths(fromPath, specifier);
    if (aliased) return aliased;

    const self = this.nearestPackage(fromPath);
    if (self && self.name === name) return this.packageEntry(self.dir, sub);

    const workspace = this.workspaces().get(name);
    if (workspace !== undefined) {
      const hit = this.packageEntry(workspace, sub);
      if (hit) return hit;
    }
    return { kind: "package", name };
  }

  /** The path a relative specifier names, with the directory of `fromPath` as its base. */
  private stemOf(fromPath: string, specifier: string): string {
    const dir = dirname(fromPath);
    return normalize(dir === "" ? specifier : `${dir}/${specifier}`);
  }

  /** A file, or a directory's index file, with TypeScript's extension rules. Records each probe. */
  private file(stem: string): Resolution | undefined {
    const hit = this.fileOrIndex(stem) ?? this.mapBuilt(stem);
    return hit === undefined ? undefined : { kind: "file", path: hit };
  }

  private fileOrIndex(stem: string): string | undefined {
    const candidates: string[] = [];
    if (DECLARATION.test(stem)) {
      // A declaration file names the source it describes.
      const bare = stem.replace(DECLARATION, "");
      candidates.push(bare + ".ts", bare + ".tsx");
    }
    if (JS_EXTENSION.test(stem)) {
      const bare = stem.replace(JS_EXTENSION, "");
      for (const ext of TS_FOR_JS) candidates.push(bare + ext);
    }
    candidates.push(stem);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(stem + ext);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${stem}/index${ext}`);
    for (const candidate of candidates) {
      if (this.exists(candidate)) return candidate;
    }
    return undefined;
  }

  /** A built path under an output folder (dist, build, lib, out) is remapped to the same path under src. */
  private mapBuilt(stem: string): string | undefined {
    const parts = stem.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (!BUILD_DIRS.has(parts[i]!)) continue;
      const mapped = [...parts.slice(0, i), "src", ...parts.slice(i + 1)].join("/");
      const hit = this.fileOrIndex(mapped);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private exists(path: string): boolean {
    this.probes.push(path);
    return this.snap.paths.has(path);
  }

  /** `#name` through the nearest package.json's `imports` map. */
  private packageImports(fromPath: string, specifier: string): Resolution | undefined {
    const pkg = this.nearestPackage(fromPath);
    if (!pkg) return undefined;
    const target = matchPattern(pkg.json.imports, specifier);
    if (target === undefined) return undefined;
    return this.file(normalize(`${pkg.dir}/${target.replace(/^\.\//, "")}`));
  }

  /** Resolves a `paths` alias from the nearest tsconfig, with baseUrl as the fallback. */
  private paths(fromPath: string, specifier: string): Resolution | undefined {
    const view = this.tsconfigFor(fromPath);
    if (!view) return undefined;
    const base = view.baseUrl !== undefined ? normalize(join(view.baseDir, view.baseUrl)) : view.pathsDir;
    for (const [pattern, targets] of Object.entries(view.paths)) {
      const star = matchStar(pattern, specifier);
      if (star === undefined) continue;
      for (const target of targets) {
        const hit = this.file(normalize(join(base, target.replace("*", star))));
        if (hit) return hit;
      }
    }
    if (view.baseUrl !== undefined) {
      const hit = this.file(normalize(join(normalize(join(view.baseDir, view.baseUrl)), specifier)));
      if (hit) return hit;
    }
    return undefined;
  }

  /** Entry of a package at `dir` for subpath "." or "./sub", through exports, then main and types. */
  private packageEntry(dir: string, sub: string): Resolution | undefined {
    const json = this.readJson(join(dir, "package.json"));
    const exported = exportTarget(json?.exports, sub);
    if (sub !== ".") {
      return this.file(normalize(join(dir, exported ?? sub)));
    }
    // Source-first: a built entry maps back to source, and an entry that fails falls through to the next.
    const entries = [exported, json?.main, json?.module, json?.types].filter((e): e is string => typeof e === "string");
    for (const entry of entries) {
      const hit = this.file(normalize(join(dir, entry)));
      if (hit) return hit;
    }
    return this.file(normalize(join(dir, "index")));
  }

  private nearestPackage(fromPath: string): { dir: string; name?: string; json: Record<string, any> } | undefined {
    for (let dir = dirname(fromPath); ; dir = dirname(dir)) {
      const pkgPath = dir === "" ? "package.json" : `${dir}/package.json`;
      this.probes.push(pkgPath);
      const json = this.readJson(pkgPath);
      if (json) return { dir, name: typeof json.name === "string" ? json.name : undefined, json };
      if (dir === "") return undefined;
    }
  }

  /** Workspace package names to their directories, from the root package.json's `workspaces` globs. */
  private workspaces(): Map<string, string> {
    const key = "";
    if (this.workspaceCache.has(key)) return this.workspaceCache.get(key) ?? new Map();
    const names = new Map<string, string>();
    const root = this.readJson("package.json");
    const globs = Array.isArray(root?.workspaces) ? (root!.workspaces as unknown[]).filter((g): g is string => typeof g === "string") : [];
    for (const path of this.snap.paths) {
      if (!path.endsWith("/package.json")) continue;
      const dir = path.slice(0, -"/package.json".length);
      if (!globs.some((glob) => globMatches(glob, dir))) continue;
      const json = this.readJson(path);
      if (typeof json?.name === "string") names.set(json.name, dir);
    }
    this.workspaceCache.set(key, names);
    return names;
  }

  /** The nearest tsconfig.json above the file. Its view may be undefined: then it sets no aliases. */
  private tsconfigFor(fromPath: string): TsconfigView | undefined {
    for (let dir = dirname(fromPath); ; dir = dirname(dir)) {
      const path = dir === "" ? "tsconfig.json" : `${dir}/tsconfig.json`;
      this.probe(path);
      if (this.snap.paths.has(path)) return this.loadTsconfig(path, 0);
      if (dir === "") return undefined;
    }
  }

  private loadTsconfig(path: string, depth: number): TsconfigView | undefined {
    this.probe(path);
    if (!this.snap.paths.has(path) || depth > 8) return undefined;
    if (this.tsconfigCache.has(path)) return this.tsconfigCache.get(path) ?? undefined;
    const json = this.readJson(path);
    const dir = dirname(path);
    let view: TsconfigView | undefined;
    if (json) {
      const extendsPath = typeof json.extends === "string" ? normalize(join(dir, json.extends)) : undefined;
      const inherited = extendsPath !== undefined ? this.loadTsconfig(extendsPath, depth + 1) : undefined;
      const options = (json.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
      if (options.paths !== undefined || options.baseUrl !== undefined || inherited) {
        view = {
          baseUrl: options.baseUrl ?? inherited?.baseUrl,
          baseDir: options.baseUrl !== undefined ? dir : (inherited?.baseDir ?? dir),
          pathsDir: options.paths !== undefined ? dir : (inherited?.pathsDir ?? dir),
          paths: options.paths ?? inherited?.paths ?? {},
        };
      }
    }
    this.tsconfigCache.set(path, view ?? null);
    return view;
  }

  private probe(path: string): void {
    this.probes.push(path);
  }

  private readJson(path: string): Record<string, any> | undefined {
    const text = this.snap.paths.has(path) ? this.snap.read(path) : undefined;
    if (!text) return undefined;
    try {
      const parsed = parseJsonc(text);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, any>) : undefined;
    } catch {
      return undefined;
    }
  }
}

function splitPackage(specifier: string): { name: string; sub: string } {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, count).join("/");
  const rest = parts.slice(count).join("/");
  return { name, sub: rest === "" ? "." : `./${rest}` };
}

/** The target of a conditional `exports`/`imports` value: a string, or the first usable condition. */
function conditionalTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(conditionalTarget).find((t) => t !== undefined);
  if (typeof value === "object" && value !== null) {
    for (const condition of ["types", "import", "default", "require"]) {
      const hit = conditionalTarget((value as Record<string, unknown>)[condition]);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * The `exports` target for a subpath ("." or "./sub"). A map keyed by subpaths is looked up by key;
 * anything else is a bare conditions object that applies to the "." entry only.
 */
function exportTarget(exports: unknown, sub: string): string | undefined {
  if (typeof exports !== "object" || exports === null) return typeof exports === "string" && sub === "." ? exports : undefined;
  const keys = Object.keys(exports);
  if (keys.length > 0 && keys.every((k) => k.startsWith("."))) return matchPattern(exports as Record<string, unknown>, sub);
  return sub === "." ? conditionalTarget(exports) : undefined;
}

/** The target for `key` in a map that may hold exact keys and one "*" pattern. */
function matchPattern(map: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!map || typeof map !== "object") return undefined;
  if (key in map) return conditionalTarget(map[key]);
  for (const [pattern, value] of Object.entries(map)) {
    const star = matchStar(pattern, key);
    if (star === undefined) continue;
    const target = conditionalTarget(value);
    if (target !== undefined) return target.replace("*", star);
  }
  return undefined;
}

/** The text a "*" in `pattern` matched in `key`, or undefined when they do not match. */
function matchStar(pattern: string, key: string): string | undefined {
  const at = pattern.indexOf("*");
  if (at === -1) return pattern === key ? "" : undefined;
  const prefix = pattern.slice(0, at);
  const suffix = pattern.slice(at + 1);
  if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
  return key.slice(prefix.length, key.length - suffix.length);
}

/** Whether a workspace glob ("packages/*" or an exact directory) names `dir`. */
function globMatches(glob: string, dir: string): boolean {
  const clean = glob.replace(/\/$/, "");
  if (clean.endsWith("/**")) return dir.startsWith(`${clean.slice(0, -3)}/`);
  if (clean.endsWith("/*")) {
    const parent = clean.slice(0, -2);
    return dir.startsWith(`${parent}/`) && !dir.slice(parent.length + 1).includes("/");
  }
  return clean === dir;
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

function join(dir: string, rel: string): string {
  return dir === "" ? rel : `${dir}/${rel}`;
}

/** Collapses "." and ".." segments. The root is "". */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
