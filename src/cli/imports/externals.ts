import { MAX_LANES } from "./roads.js";
import { normalisePythonName } from "./python.js";

/**
 * External Dependencies (SPEC §4 and §7). A declared dependency comes from a manifest a Module owns: package.json
 * (dependencies, devDependencies, peerDependencies), pyproject.toml and requirements*.txt. Lockfiles are never read.
 * An import is matched to a declaration by normalised name: npm exact (with `@types/x` folded into `x`), Python PEP 503.
 * Declarations group into External Cities by npm scope or by a shared first name token; the largest groups of at least
 * `threshold` distinct members get their own City, at most MAX_CITIES, and everything else falls to the Outskirts.
 */

export type Ecosystem = "npm" | "python";

/** One declared dependency: its name as written in the manifest, and the folder of that manifest ("" for the root). */
export interface Declaration {
  ecosystem: Ecosystem;
  name: string;
  manifest: string;
}

export const DEFAULT_THRESHOLD = 3;
export const MIN_THRESHOLD = 3;
export const MAX_THRESHOLD = 5;
export const MAX_CITIES = 16;

/** Tokens that never form a group on their own: too generic to name a family of packages. */
const STOPLIST = new Set(["js", "ts", "node", "lib", "util", "utils", "types", "plugin", "config", "dev", "api", "core", "x"]);

/** The declared names of one manifest file, or none when the path is not a manifest this reads. */
export function declarationsOf(path: string, text: string): Declaration[] {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const manifest = slash < 0 ? "" : path.slice(0, slash);
  const make = (ecosystem: Ecosystem, names: string[]): Declaration[] => names.map((n) => ({ ecosystem, name: n, manifest }));
  if (name === "package.json") return make("npm", npmDeclared(text));
  if (name === "pyproject.toml") return make("python", pyprojectDeclared(text));
  if (/^requirements.*\.txt$/.test(name)) return make("python", requirementsDeclared(text));
  return [];
}

/** Whether a path is a manifest this module reads: package.json, pyproject.toml or requirements*.txt, outside node_modules. */
export function isManifestPath(path: string): boolean {
  if (path.split("/").includes("node_modules")) return false;
  return /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt)$/.test(path);
}

/** The npm package an import specifier names: "@scope/name" or "name", without any subpath. */
export function npmPackageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The identity a name is matched and counted by: normalised for Python (PEP 503), and for npm the name with `@types/` removed. */
export function identityOf(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "python" ? normalisePythonName(name) : stripTypes(name);
}

/** Identity key of a name within an ecosystem, as the maps in this module use it. */
export function importerKey(ecosystem: Ecosystem, name: string): string {
  return `${ecosystem}\u0000${identityOf(ecosystem, name)}`;
}

/**
 * The declaration an import matches, or undefined when nothing declared matches it (such an import is dropped).
 * `importName` is the npm package name, or the Python top-level module name, as the importer wrote it.
 */
export function classifyImport(ecosystem: Ecosystem, importName: string, declared: readonly Declaration[]): Declaration | undefined {
  return declarationIndex(declared)(ecosystem, importName);
}

/**
 * A matcher over one declaration list, built once. Names match on identity: a Python name by `normalisePythonName`
 * (the same rule as `pythonNameMatches`), an npm name exactly, with `@types/x` answering for `x`.
 * The first declaration with a given identity wins.
 */
export function declarationIndex(declared: readonly Declaration[]): (ecosystem: Ecosystem, importName: string) => Declaration | undefined {
  const index = new Map<string, Declaration>();
  for (const d of declared) {
    const id = importerKey(d.ecosystem, d.name);
    if (!index.has(id)) index.set(id, d);
  }
  return (ecosystem, importName) => index.get(importerKey(ecosystem, importName));
}

/**
 * The group a declared name belongs to, given every declaration in the same ecosystem. A scoped npm name groups by its
 * scope (`@babel/core` is "babel"), and `@types/x` takes the group of `x`. An unscoped name joins the group of its first
 * token only when another declaration shares that token (a scope counts) or the token is itself a declared package, and
 * the token is not on the stoplist. Otherwise the name stands alone and its own key is returned.
 */
export function groupKeyOf(ecosystem: Ecosystem, name: string, declared: readonly Declaration[]): string {
  const bare = identityOf(ecosystem, name);
  if (ecosystem === "npm" && bare.startsWith("@")) return bare.slice(1).split("/")[0]!;
  const token = firstToken(bare);
  if (STOPLIST.has(token)) return bare;
  const sharing = new Set<string>();
  let isPackage = false;
  for (const d of declared) {
    if (d.ecosystem !== ecosystem) continue;
    const other = identityOf(ecosystem, d.name);
    if (other === token) isPackage = true;
    if (other.startsWith("@") ? other.slice(1).split("/")[0] === token : firstToken(other) === token) sharing.add(other);
  }
  return sharing.size >= 2 || isPackage ? token : bare;
}

export interface ExternalCity {
  key: string;
  ecosystem: Ecosystem;
  /** Distinct declared names in the group, sorted. */
  members: string[];
  /** Declaration entries in the group across all manifests, the tie-break after member count. */
  declarations: number;
}

export interface ExternalPlan {
  cities: ExternalCity[];
  /** Every member of a group that did not get a City, sorted. */
  outskirts: string[];
  /** The `importerKey` of each Outskirts member, sorted: the identity a declaration is matched and counted by. */
  outskirtKeys: string[];
}

export interface PlanOptions {
  /** Distinct members a group needs to get its own City, from MIN_THRESHOLD to MAX_THRESHOLD. */
  threshold?: number;
  /**
   * `externals.groups` from the config: a dependency (by declared name or identity) mapped to the group key it joins,
   * in place of the grouping rules above.
   */
  groups?: Readonly<Record<string, string>>;
}

/**
 * Plans the External Cities for a set of declarations. A group of at least `threshold` distinct members qualifies; the
 * largest MAX_CITIES win (by members, then declarations, then key). Everything else is in the Outskirts.
 */
export function planExternals(declarations: readonly Declaration[], options: PlanOptions = {}): ExternalPlan {
  const threshold = checkedThreshold(options.threshold);
  const groups = groupsOf(declarations, options);
  const qualifying = groups.filter((g) => g.members.length >= threshold).sort(byRank);
  const cities = qualifying.slice(0, MAX_CITIES);
  const cityIds = new Set(cities.map(groupId));
  const small = groups.filter((g) => !cityIds.has(groupId(g)));
  const outskirts = small.flatMap((g) => g.members).sort();
  const outskirtKeys = small.flatMap((g) => g.members.map((m) => importerKey(g.ecosystem, m))).sort();
  return { cities, outskirts, outskirtKeys };
}

/** A span in which a manifest declares a dependency: from the commit it was added to the commit it was removed (undefined while open). */
export interface Span {
  ecosystem: Ecosystem;
  name: string;
  manifest: string;
  from: number;
  to?: number;
}

/**
 * A stretch of history in which an External City is present: its distinct declared members reached the threshold
 * (promotion) and at least one is still declared. `to` is set when the last one is removed.
 */
export interface Presence {
  ecosystem: Ecosystem;
  key: string;
  from: number;
  to?: number;
}

export interface RegistrySnapshot {
  seen: [string, Declaration][];
  spans: Span[];
  presence: Presence[];
}

/**
 * Every declared dependency seen across history, fed one commit at a time in history order. Members are kept once seen,
 * so a group's count never shrinks when a manifest drops a dependency. A group's promotion is the commit at which its
 * distinct members first reach the threshold; its presence then follows whether any member is still declared.
 */
export class ExternalRegistry {
  private readonly seen = new Map<string, Declaration>();
  private readonly spans: Span[] = [];
  private readonly open = new Map<string, Span>();
  private readonly presence: Presence[] = [];
  private readonly options: PlanOptions;

  constructor(options: PlanOptions = {}) {
    checkedThreshold(options.threshold);
    this.options = options;
  }

  /** A manifest at `commit` declares `d`. */
  declare(commit: number, d: Declaration): void {
    if (this.open.has(spanKey(d))) return;
    const id = importerKey(d.ecosystem, d.name);
    const have = this.seen.get(id);
    if (have === undefined || (isTypesOnly(have) && !isTypesOnly(d))) this.seen.set(id, d);
    const span: Span = { ecosystem: d.ecosystem, name: d.name, manifest: d.manifest, from: commit };
    this.spans.push(span);
    this.open.set(spanKey(d), span);
    this.settle(commit);
  }

  /** A manifest at `commit` stops declaring `d`. Its group keeps the member. */
  undeclare(commit: number, d: Declaration): void {
    const span = this.open.get(spanKey(d));
    if (span === undefined) return;
    span.to = commit;
    this.open.delete(spanKey(d));
    this.settle(commit);
  }

  /** Declarations currently in some manifest. */
  currentlyDeclared(): Declaration[] {
    return [...this.open.values()].map((s) => ({ ecosystem: s.ecosystem, name: s.name, manifest: s.manifest }));
  }

  /** Every distinct declaration seen, with the spelling kept for display. */
  everDeclared(): Declaration[] {
    return [...this.seen.values()];
  }

  /** The plan over everything ever seen. */
  plan(): ExternalPlan {
    return planExternals(this.everDeclared(), this.options);
  }

  /** The commit a group was first present as a City, or undefined while it is below the threshold. */
  promotedAt(key: string, ecosystem: Ecosystem = "npm"): number | undefined {
    return this.presence.find((p) => p.ecosystem === ecosystem && p.key === key)?.from;
  }

  /** Every span, open or closed, in the order they began. */
  spansOf(): readonly Span[] {
    return this.spans;
  }

  /** Every presence interval, in the order they began. */
  presenceOf(): readonly Presence[] {
    return this.presence;
  }

  snapshot(): RegistrySnapshot {
    return { seen: [...this.seen], spans: this.spans.map((s) => ({ ...s })), presence: this.presence.map((p) => ({ ...p })) };
  }

  static restore(options: PlanOptions, s: RegistrySnapshot): ExternalRegistry {
    const registry = new ExternalRegistry(options);
    for (const [id, d] of s.seen) registry.seen.set(id, d);
    for (const span of s.spans) {
      const copy = { ...span };
      registry.spans.push(copy);
      if (copy.to === undefined) registry.open.set(spanKey(copy), copy);
    }
    for (const p of s.presence) registry.presence.push({ ...p });
    return registry;
  }

  /** Opens or closes each City's presence to match whether one of its members is declared now. */
  private settle(commit: number): void {
    const threshold = checkedThreshold(this.options.threshold);
    const ever = assignGroups([...this.seen.values()], this.options);
    const present = new Set<string>();
    for (const d of this.open.values()) {
      const group = ever.groupOf.get(importerKey(d.ecosystem, d.name));
      if (group !== undefined) present.add(groupIdOf(group.ecosystem, group.key));
    }
    for (const group of ever.groups) {
      if (group.members.length < threshold) continue;
      const id = groupIdOf(group.ecosystem, group.key);
      const live = this.presence.find((p) => p.to === undefined && groupIdOf(p.ecosystem, p.key) === id);
      if (present.has(id) && live === undefined) this.presence.push({ ecosystem: group.ecosystem, key: group.key, from: commit });
      else if (!present.has(id) && live !== undefined) live.to = commit;
    }
  }
}

/** Groups declarations by ecosystem and group key, counting distinct members and declaration entries. */
function groupsOf(declarations: readonly Declaration[], options: PlanOptions): ExternalCity[] {
  return assignGroups(declarations, options).groups;
}

/**
 * The grouping of a declaration list: every group, and for each distinct identity the group it joined. A declared
 * `@types/x` and `x` are one identity, so they are one member; the spelling kept is the one not under `@types/`.
 */
function assignGroups(
  declarations: readonly Declaration[],
  options: PlanOptions,
): { groups: ExternalCity[]; groupOf: Map<string, { ecosystem: Ecosystem; key: string }> } {
  const distinct = new Map<string, Declaration>();
  for (const d of declarations) {
    const id = importerKey(d.ecosystem, d.name);
    const have = distinct.get(id);
    if (have === undefined || (isTypesOnly(have) && !isTypesOnly(d))) distinct.set(id, d);
  }
  const list = [...distinct.values()];
  const groupOf = new Map<string, { ecosystem: Ecosystem; key: string }>();
  for (const d of list) {
    const override = options.groups?.[d.name] ?? options.groups?.[identityOf(d.ecosystem, d.name)];
    groupOf.set(importerKey(d.ecosystem, d.name), { ecosystem: d.ecosystem, key: override ?? groupKeyOf(d.ecosystem, d.name, list) });
  }
  const groups = new Map<string, ExternalCity>();
  for (const d of list) {
    const group = groupOf.get(importerKey(d.ecosystem, d.name))!;
    const id = groupIdOf(group.ecosystem, group.key);
    const city = groups.get(id) ?? { key: group.key, ecosystem: group.ecosystem, members: [], declarations: 0 };
    city.members.push(d.name);
    groups.set(id, city);
  }
  for (const d of declarations) {
    const group = groupOf.get(importerKey(d.ecosystem, d.name))!;
    groups.get(groupIdOf(group.ecosystem, group.key))!.declarations++;
  }
  for (const g of groups.values()) g.members.sort();
  return { groups: [...groups.values()], groupOf };
}

function byRank(a: ExternalCity, b: ExternalCity): number {
  return b.members.length - a.members.length || b.declarations - a.declarations || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function groupId(g: Pick<ExternalCity, "key" | "ecosystem">): string {
  return groupIdOf(g.ecosystem, g.key);
}

function groupIdOf(ecosystem: Ecosystem, key: string): string {
  return `${ecosystem}\u0000${key}`;
}

function spanKey(d: Declaration): string {
  return `${d.ecosystem}\u0000${d.name}\u0000${d.manifest}`;
}

function isTypesOnly(d: Declaration): boolean {
  return d.ecosystem === "npm" && d.name.startsWith("@types/");
}

function checkedThreshold(threshold: number | undefined): number {
  const value = threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(value) || value < MIN_THRESHOLD || value > MAX_THRESHOLD) {
    throw new Error(`the External City threshold must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}, not ${threshold}`);
  }
  return value;
}

/** `@types/x` names the package `x` it describes. */
function stripTypes(name: string): string {
  return name.startsWith("@types/") ? name.slice("@types/".length) : name;
}

function firstToken(bare: string): string {
  return bare.split(/[-_.]/)[0]!;
}

function npmDeclared(text: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof json !== "object" || json === null) return [];
  const fields = json as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const value = fields[field];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) for (const n of Object.keys(value)) names.add(n);
  }
  return [...names];
}

const PEP508_NAME = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

/** Requirement names from a PEP 621 `[project]` dependencies list, its optional groups, and Poetry dependency tables. */
function pyprojectDeclared(text: string): string[] {
  const names = new Set<string>();
  const lines = text.split(/\r?\n/).map(stripTomlComment);
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.replace(/\s+/g, "");
      continue;
    }
    const assign = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!assign) continue;
    const key = assign[1]!.replace(/^["']|["']$/g, "");
    const isPep621 = (table === "project" && key === "dependencies") || table === "project.optional-dependencies";
    const isPoetry = /^tool\.poetry\.(dev-dependencies|dependencies|group\.[^.]+\.dependencies)$/.test(table);
    if (isPoetry && key !== "python") names.add(key);
    if (!isPep621) continue;
    // A list may span lines: read on until its closing bracket.
    let value = assign[2]!;
    for (let j = i + 1; !value.trimEnd().endsWith("]") && j < lines.length; j++) value += ` ${lines[j]}`;
    if (!value.trimStart().startsWith("[")) continue;
    for (const literal of value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
      const requirement = PEP508_NAME.exec(literal[1] ?? literal[2] ?? "");
      if (requirement) names.add(requirement[1]!);
    }
  }
  return [...names];
}

/** Removes a TOML comment: a `#` outside a string. */
function stripTomlComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Requirement names, one per line, skipping comments, options, direct URLs and paths. */
function requirementsDeclared(text: string): string[] {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "" || line.startsWith("-") || /^(https?|git\+[a-z]+|file):/.test(line)) continue;
    const match = PEP508_NAME.exec(line);
    if (match) names.add(match[1]!);
  }
  return [...names];
}

/**
 * Highway Lanes for one External Dependency: one per importing file, at least 1 each way and at most MAX_LANES each way,
 * the same cap as a Road's Lanes (SPEC §7). The cap bounds the Lanes counted, not the connections behind them.
 */
export function highwayLanes(importingFiles: number): number {
  return Math.min(MAX_LANES, Math.max(1, importingFiles));
}

/** One declared dependency as the build summary lists it. `city` is the External City key, or undefined for the Outskirts. */
export interface DependencyReport {
  name: string;
  ecosystem: Ecosystem;
  city?: string;
  importers: number;
  lanes: number;
}

export interface ExternalReport {
  cities: { key: string; ecosystem: Ecosystem; members: number }[];
  dependencies: DependencyReport[];
}

/**
 * The report: each dependency declared now (`current`) with its City (or the Outskirts) and its Highway Lanes, and the
 * Cities of the whole history (`ever`). `importers` maps `importerKey` to the number of files whose import matched it.
 */
export function externalReport(
  current: readonly Declaration[],
  ever: readonly Declaration[],
  importers: ReadonlyMap<string, number>,
  options: PlanOptions = {},
): ExternalReport {
  const plan = planExternals(ever, options);
  const cityIds = new Set(plan.cities.map(groupId));
  const { groupOf } = assignGroups(ever, options);
  const distinct = new Map<string, Declaration>();
  for (const d of current) if (!distinct.has(importerKey(d.ecosystem, d.name))) distinct.set(importerKey(d.ecosystem, d.name), d);
  const dependencies = [...distinct.values()]
    .map((d): DependencyReport => {
      const group = groupOf.get(importerKey(d.ecosystem, d.name));
      const count = importers.get(importerKey(d.ecosystem, d.name)) ?? 0;
      return {
        name: d.name,
        ecosystem: d.ecosystem,
        city: group !== undefined && cityIds.has(groupIdOf(group.ecosystem, group.key)) ? group.key : undefined,
        importers: count,
        lanes: highwayLanes(count),
      };
    })
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  return {
    cities: plan.cities.map((c) => ({ key: c.key, ecosystem: c.ecosystem, members: c.members.length })),
    dependencies,
  };
}
