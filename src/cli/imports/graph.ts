import { parseJsonc } from "../jsonc.js";
import type { RawImport } from "./extract.js";
import { extendsTarget, ImportResolver, MAX_EXTENDS_DEPTH, type Resolution, type Snapshot } from "./resolve.js";

/**
 * The import graph (SPEC §4), fed one commit at a time in history order. It keeps, for the commit it is at:
 * every file's resolved internal targets, its bare package imports, and the fan-in of every file.
 *
 * Incremental: a commit re-resolves only the importers that probed a path the commit added or deleted,
 * the files it wrote, and, when a config file changed, every importer. Specifiers come from the facts layer,
 * so the graph never parses a file itself.
 */

/** Fan-in thresholds for Building width steps (SPEC §5): fan-in 3, 10 and 30 each add one step. */
export const WIDTH_STEP_FAN_IN = [3, 10, 30] as const;

/** Width step (0 narrowest, 3 widest) for a file with `fanIn` distinct internal importers. */
export function widthStepFor(fanIn: number): number {
  return WIDTH_STEP_FAN_IN.filter((threshold) => fanIn >= threshold).length;
}

/**
 * The writes and deletions one commit makes against its first parent. `blob` is the new content.
 * `specifiers` is set for a file an import extractor reads (its raw imports, from the facts layer), and absent otherwise.
 */
export interface GraphCommit {
  writes: { path: string; blob: string; specifiers?: RawImport[] }[];
  deleted: string[];
}

export interface ImportGraphOptions {
  /** Reads a blob's text. Called only for config files (package.json, tsconfig, jsconfig and pyproject.toml). */
  readText: (blob: string) => Promise<string>;
}

/** Files whose text is kept for config: JSON (manifests, tsconfigs) and pyproject.toml (Python source roots). */
const CONFIG_TEXT_FILE = /\.jsonc?$|(^|\/)pyproject\.toml$/;
/** The `extends` value of a tsconfig text, or undefined when it has none or does not parse. */
function extendsValue(text: string): string | undefined {
  try {
    const value = (parseJsonc(text) as { extends?: unknown } | null)?.extends;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Config files whose content changes how any import resolves. */
function isConfig(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "package.json" || name === "pyproject.toml" || /^(tsconfig|jsconfig)(\..+)?\.json$/.test(name);
}

interface FileRecord {
  blob: string;
  specifiers: RawImport[];
}

/** A JSON-safe copy of an ImportGraph, written into a cache checkpoint so a run can resume from it. */
export interface GraphSnapshot {
  paths: string[];
  configText: [string, string][];
  jsonBlobs: [string, string][];
  extendedPaths: string[];
  files: [string, FileRecord][];
  targets: [string, string[]][];
  importers: [string, string[]][];
  packages: [string, string[]][];
  probesOf: [string, string[]][];
  importersOfProbe: [string, string[]][];
}

export class ImportGraph {
  private readonly paths = new Set<string>();
  private readonly configText = new Map<string, string>();
  /** Blob of every JSON and pyproject.toml file in the commit's tree, so a config can be read when it is needed. */
  private readonly jsonBlobs = new Map<string, string>();
  /** Paths some tsconfig extends: their text is kept, the rest of the JSON is not. */
  private readonly extendedPaths = new Set<string>();
  private readonly files = new Map<string, FileRecord>();
  /** Resolved internal targets per importer. */
  private readonly targets = new Map<string, Set<string>>();
  /** Importers per resolved target: the fan-in set. */
  private readonly importers = new Map<string, Set<string>>();
  /** Bare package names per importer, for matching against manifests later. */
  private readonly packages = new Map<string, Set<string>>();
  /** Every path each importer's resolution probed, and the reverse index from probe to importer. */
  private readonly probesOf = new Map<string, Set<string>>();
  private readonly importersOfProbe = new Map<string, Set<string>>();
  /** Targets whose importer set changed during the current `apply`. */
  private touched = new Set<string>();
  private readonly resolverView: Snapshot = {
    paths: this.paths,
    read: (path) => this.configText.get(path),
  };

  /** One resolver for the whole run, so manifests and the workspace map are not rebuilt per specifier. */
  private readonly resolver: ImportResolver;

  constructor(private readonly options: ImportGraphOptions) {
    this.resolver = new ImportResolver(this.resolverView);
  }

  /** Feeds one commit. Returns the targets whose fan-in this commit changed, so the layout can re-width them. */
  async apply(commit: GraphCommit): Promise<Set<string>> {
    this.touched = new Set();
    const changed = new Set<string>();
    let configChanged = false;
    for (const path of commit.deleted) {
      this.paths.delete(path);
      this.clear(path);
      this.files.delete(path);
      this.configText.delete(path);
      this.jsonBlobs.delete(path);
      changed.add(path);
      configChanged ||= isConfig(path);
    }

    const extracted: string[] = [];
    const jsonWritten: string[] = [];
    for (const { path, blob, specifiers } of commit.writes) {
      this.paths.add(path);
      changed.add(path);
      if (CONFIG_TEXT_FILE.test(path)) {
        // Only the manifests and tsconfigs (and the files they extend) keep their text; other JSON is never read.
        this.jsonBlobs.set(path, blob);
        jsonWritten.push(path);
        configChanged ||= isConfig(path);
      }
      if (specifiers !== undefined) {
        this.files.set(path, { blob, specifiers });
        extracted.push(path);
      }
    }
    for (const path of jsonWritten) {
      if (isConfig(path) || this.extendedPaths.has(path)) await this.loadConfigText(path, 0);
    }

    const affected = new Set<string>(extracted);
    if (configChanged) {
      for (const importer of this.files.keys()) affected.add(importer);
    }
    for (const path of changed) {
      for (const importer of this.importersOfProbe.get(path) ?? []) {
        if (this.files.has(importer)) affected.add(importer);
      }
    }
    // Manifests and tsconfigs are read once and the workspace map built once; a config change rebuilds both.
    if (configChanged) this.resolver.reset();
    for (const importer of affected) this.resolveFile(importer);
    return this.touched;
  }

  /** Fan-in: the number of distinct internal files that import `path`. */
  fanIn(path: string): number {
    return this.importers.get(path)?.size ?? 0;
  }

  /** The internal files `path` imports, sorted. */
  targetsOf(path: string): string[] {
    return [...(this.targets.get(path) ?? [])].sort();
  }

  /** Bare package names `path` imports, sorted. Whether they are declared is decided by the manifests. */
  packagesOf(path: string): string[] {
    return [...(this.packages.get(path) ?? [])].sort();
  }

  /**
   * File-to-file edges summed per District pair. `districtOf` maps a path to its District key.
   * A link with equal keys is internal to one District and runs along its Block streets.
   */
  districtLinks(districtOf: (path: string) => string): { from: string; to: string; strength: number }[] {
    const sums = new Map<string, { from: string; to: string; strength: number }>();
    for (const [importer, targets] of this.targets) {
      const from = districtOf(importer);
      for (const target of targets) {
        const to = districtOf(target);
        const key = `${from}\u0000${to}`;
        const link = sums.get(key) ?? { from, to, strength: 0 };
        link.strength++;
        sums.set(key, link);
      }
    }
    return [...sums.values()];
  }

  /** Everything the graph holds, as JSON-safe values. `restore` rebuilds an equal graph from it. */
  snapshot(): GraphSnapshot {
    return {
      paths: [...this.paths],
      configText: [...this.configText],
      jsonBlobs: [...this.jsonBlobs],
      extendedPaths: [...this.extendedPaths],
      files: [...this.files],
      targets: setEntries(this.targets),
      importers: setEntries(this.importers),
      packages: setEntries(this.packages),
      probesOf: setEntries(this.probesOf),
      importersOfProbe: setEntries(this.importersOfProbe),
    };
  }

  static restore(options: ImportGraphOptions, s: GraphSnapshot): ImportGraph {
    const graph = new ImportGraph(options);
    for (const path of s.paths) graph.paths.add(path);
    for (const [path, text] of s.configText) graph.configText.set(path, text);
    for (const [path, blob] of s.jsonBlobs) graph.jsonBlobs.set(path, blob);
    for (const path of s.extendedPaths) graph.extendedPaths.add(path);
    for (const [path, record] of s.files) graph.files.set(path, record);
    fillSetMap(graph.targets, s.targets);
    fillSetMap(graph.importers, s.importers);
    fillSetMap(graph.packages, s.packages);
    fillSetMap(graph.probesOf, s.probesOf);
    fillSetMap(graph.importersOfProbe, s.importersOfProbe);
    return graph;
  }

  private resolveFile(importer: string): void {
    this.clear(importer);
    const record = this.files.get(importer);
    if (!record) return;
    const probes = new Set<string>();
    for (const { specifier, member } of record.specifiers) {
      const resolved = this.resolver.resolve(importer, specifier, member);
      for (const probe of resolved.probes) probes.add(probe);
      this.record(importer, resolved.target);
    }
    this.probesOf.set(importer, probes);
    for (const probe of probes) {
      add(this.importersOfProbe, probe, importer);
    }
  }

  private record(importer: string, target: Resolution | undefined): void {
    if (target === undefined) return;
    if (target.kind === "package") {
      add(this.packages, importer, target.name);
      return;
    }
    add(this.targets, importer, target.path);
    add(this.importers, target.path, importer);
    this.touched.add(target.path);
  }

  /** Keeps the text of a config file, and of each file a tsconfig extends, following the chain up to a fixed depth. */
  private async loadConfigText(path: string, depth: number): Promise<void> {
    const blob = this.jsonBlobs.get(path);
    if (blob === undefined || depth > MAX_EXTENDS_DEPTH) return;
    const text = await this.options.readText(blob);
    this.configText.set(path, text);
    const value = extendsValue(text);
    if (value === undefined) return;
    const target = extendsTarget(path, value);
    this.extendedPaths.add(target);
    await this.loadConfigText(target, depth + 1);
  }

  /** Removes everything `importer` contributed: its edges, packages and probes. */
  private clear(importer: string): void {
    for (const target of this.targets.get(importer) ?? []) {
      remove(this.importers, target, importer);
      this.touched.add(target);
    }
    this.targets.delete(importer);
    this.packages.delete(importer);
    for (const probe of this.probesOf.get(importer) ?? []) remove(this.importersOfProbe, probe, importer);
    this.probesOf.delete(importer);
  }
}

function setEntries<K, V>(map: Map<K, Set<V>>): [K, V[]][] {
  return [...map].map(([key, set]) => [key, [...set]]);
}

function fillSetMap<K, V>(map: Map<K, Set<V>>, entries: [K, V[]][]): void {
  for (const [key, values] of entries) map.set(key, new Set(values));
}

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function remove<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}
