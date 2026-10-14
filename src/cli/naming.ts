import {
  NAME_SOURCES,
  PLACES_FORMAT_VERSION,
  type DistrictPlace,
  type NeighbourhoodPlace,
  type PavingColour,
  type PlacesFile,
} from "../shared/places.js";
import { NO_CONTENT } from "../shared/format.js";
import type { Config, ContributorLevel } from "./config.js";
import type { ContributorInput } from "./contributors.js";
import type { Role } from "./layout.js";
import { ThemeNamer } from "./namer.js";
import { conceptWords, resolveConcept, resolveItem, type ItemPolicy } from "./rules.js";
import type { Theme } from "./theme.js";

/**
 * The naming step: the only producer of `strings.json`. Every human-readable
 * string in the output comes from here, so the privacy checks see all of them.
 */
const SEALED = Symbol("produced by the naming step");

export interface StringTable {
  /** Index is the file id (birth order); the text is what the City shows for that file. */
  readonly strings: readonly string[];
  readonly [SEALED]: true;
}

export interface Revealed {
  id: number;
  text: string;
}

export interface NearMiss {
  id: number;
  /** The revealed text that comes close to a hidden term. */
  text: string;
  /** The hidden Real name or Concept it resembles. */
  term: string;
}

export interface NamingResult {
  table: StringTable;
  /** Names shown as their Real name. */
  revealed: Revealed[];
  nearMisses: NearMiss[];
  /**
   * Text the final scan must never find in the output: hidden Concepts, and hidden
   * paths and folder or file names. Lowercase-insensitive substring matching.
   */
  hidden: string[];
}

export interface NameOptions {
  /** `--private`: every reveal is ignored. */
  private?: boolean;
}

export interface DisplayParts {
  pseudonym?: string;
  /** Only passed in when the item is revealed. */
  real?: string;
  generated?: string;
  label: string;
}

/** Pseudonym, then revealed Real name, then Generated name, then Label. */
export function displayName(parts: DisplayParts): { text: string; source: "pseudonym" | "real" | "generated" | "label" } {
  if (parts.pseudonym !== undefined) return { text: parts.pseudonym, source: "pseudonym" };
  if (parts.real !== undefined) return { text: parts.real, source: "real" };
  if (parts.generated !== undefined) return { text: parts.generated, source: "generated" };
  return { text: parts.label, source: "label" };
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  md: "Markdown",
  json: "JSON",
  jsonc: "JSON",
  css: "CSS",
  html: "HTML",
  yml: "YAML",
  yaml: "YAML",
};

/** The Label: the file's type plus its birth order, for example "TypeScript file 412". It never holds a path. */
export function labelFor(path: string, id: number): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const ext = dot > slash ? path.slice(dot + 1).toLowerCase() : "";
  const type = TYPE_BY_EXTENSION[ext] ?? "Other";
  return `${type} file ${id + 1}`;
}

/** Words the Labels themselves are built from; a hidden name equal to one of these is not scanned for. */
const LABEL_WORDS = new Set([...Object.values(TYPE_BY_EXTENSION), "Other", "file"].map((w) => w.toLowerCase()));

/** The Concept policies of a config: pseudonym replacements, hidden words, and every Concept not revealed. */
function conceptPolicies(rules: Config["rules"], ignoreReveal: boolean) {
  const concepts = conceptWords(rules).map((word) => ({ word, policy: resolveConcept(rules, word, { ignoreReveal }) }));
  const pseudonymConcepts = concepts
    .flatMap((c) => (c.policy.name.mode === "pseudonym" ? [{ word: c.word, as: c.policy.name.as }] : []))
    .sort((a, b) => b.word.length - a.word.length);
  const hiddenConcepts = concepts.filter((c) => c.policy.name.mode === "hidden").map((c) => c.word);
  const unrevealedConcepts = concepts.filter((c) => c.policy.name.mode !== "reveal");
  return { concepts, pseudonymConcepts, hiddenConcepts, unrevealedConcepts };
}

/** Names every file (by id, in birth order). The only way to produce a StringTable. */
export function nameFiles(paths: readonly string[], config: Config, options: NameOptions = {}): NamingResult {
  const ignoreReveal = options.private === true;
  const rules = config.rules;

  const { pseudonymConcepts, hiddenConcepts, unrevealedConcepts } = conceptPolicies(rules, ignoreReveal);

  const items = paths.map((path, id) => {
    const policy: ItemPolicy = resolveItem(rules, { path }, { ignoreReveal });
    const pseudonym = policy.name.mode === "pseudonym" ? replaceConcepts(policy.name.as, pseudonymConcepts) : undefined;
    let real: string | undefined;
    if (policy.name.mode === "reveal") {
      const candidate = replaceConcepts(path, pseudonymConcepts);
      // A hidden Concept may never appear, so such a name is not shown and the Label is used instead.
      if (!containsAny(candidate, hiddenConcepts)) real = candidate;
    }
    const shown = displayName({ pseudonym, real, label: labelFor(path, id) });
    return { id, path, policy, shown };
  });

  const revealedSegments = new Set<string>();
  for (const item of items) if (item.shown.source === "real") for (const s of segmentsOf(item.path)) revealedSegments.add(s);

  const hiddenFolderAndFileNames = new Set<string>();
  const hiddenPaths: string[] = [];
  for (const item of items) {
    if (item.shown.source === "real") continue;
    hiddenPaths.push(item.path);
    for (const s of segmentsOf(item.path)) if (!revealedSegments.has(s)) hiddenFolderAndFileNames.add(s);
  }

  const nearTerms = [
    ...unrevealedConcepts.filter((c) => !c.policy.allow).map((c) => c.word),
    ...[...hiddenFolderAndFileNames].filter((s) => s.length >= 4),
  ];
  const nearMisses: NearMiss[] = [];
  const revealed: Revealed[] = [];
  for (const item of items) {
    if (item.shown.source !== "real") continue;
    revealed.push({ id: item.id, text: item.shown.text });
    if (item.policy.allow) continue;
    for (const term of findNearMisses(item.shown.text, nearTerms)) nearMisses.push({ id: item.id, text: item.shown.text, term });
  }

  const hidden = new Set<string>();
  for (const c of unrevealedConcepts) hidden.add(c.word);
  for (const p of hiddenPaths) if (p.length >= 3) hidden.add(p);
  for (const s of hiddenFolderAndFileNames) if (s.length >= 4 && !LABEL_WORDS.has(s)) hidden.add(s);

  const table = { strings: items.map((item) => item.shown.text), [SEALED]: true } as StringTable;
  return { table, revealed, nearMisses, hidden: [...hidden] };
}

/** The strings.json text. Only the naming step's table can be passed in. */
export function encodeStrings(table: StringTable): string {
  return `${JSON.stringify(table.strings)}\n`;
}

/** One District as the layout knows it: structure only, with its Real names still unshown. */
export interface PlaceInput {
  /** The Module's directory, "." for files directly in the root. */
  key: string;
  role: Role | null;
  /** Neighbourhood directories, in the order the layout met them. */
  neighbourhoods: string[];
  /** Village anchor, in Block-grid cells. */
  anchor: { col: number; row: number };
  colour: PavingColour;
}

export interface PlaceOptions extends NameOptions {
  theme: Theme;
  /** The seed text for Generated names. Never written to the output. */
  seed: string;
  /** The hidden terms from `nameFiles`: every Generated name must avoid them. */
  hidden: readonly string[];
}

/** Neighbourhood slots reserved per District when deriving a Neighbourhood's birth order. */
const NEIGHBOURHOOD_SLOTS = 65_536;

/** The places.json content. Only the naming step's table can be passed in. */
export interface PlaceTable {
  readonly file: PlacesFile;
  readonly [SEALED]: true;
}

/**
 * The naming step for Districts, Neighbourhoods and the City. Display names follow the same precedence as
 * files; Generated names come from the Namer and must be unique in the City and free of hidden terms.
 */
export function namePlaces(districts: readonly PlaceInput[], config: Config, options: PlaceOptions): PlaceTable {
  const ignoreReveal = options.private === true;
  const rules = config.rules;
  const { pseudonymConcepts, hiddenConcepts } = conceptPolicies(rules, ignoreReveal);
  const hidden = [...options.hidden];

  // Names already taken in the City, lower-cased. Revealed and pseudonymous names are taken before any Generated name.
  const taken = new Set<string>();
  const leaks = (text: string) => containsAny(text, hidden) || findNearMisses(text, hidden).length > 0;
  const accept = (candidate: string) => !taken.has(candidate.toLowerCase()) && !leaks(candidate);
  const namer = new ThemeNamer({ theme: options.theme, seed: options.seed, accept, leaks });

  /** The fixed part of a display name: the Pseudonym, else the Real name when revealed. */
  const fixedParts = (policy: ItemPolicy, realText: string | undefined) => {
    const pseudonym = policy.name.mode === "pseudonym" ? replaceConcepts(policy.name.as, pseudonymConcepts) : undefined;
    let real: string | undefined;
    if (policy.name.mode === "reveal" && realText !== undefined) {
      const candidate = replaceConcepts(realText, pseudonymConcepts);
      if (!containsAny(candidate, hiddenConcepts)) real = candidate;
    }
    return { pseudonym, real };
  };

  const districtFixed = districts.map((d) => {
    const policy = resolveItem(rules, { module: d.key }, { ignoreReveal });
    return fixedParts(policy, d.key === "." ? undefined : d.key);
  });
  const neighbourhoodFixed = districts.map((d) =>
    d.neighbourhoods.map((dir) => fixedParts(resolveItem(rules, { path: dir }, { ignoreReveal }), dir === "." ? undefined : dir)),
  );
  for (const fixed of [...districtFixed, ...neighbourhoodFixed.flat()]) {
    for (const text of [fixed.pseudonym, fixed.real]) if (text !== undefined) taken.add(text.toLowerCase());
  }

  const cityName = namer.name({ kind: "city", birthOrder: 0, role: null });
  taken.add(cityName.toLowerCase());

  const places: DistrictPlace[] = districts.map((d, id) => {
    const generated = namer.name({ kind: "district", birthOrder: id, role: d.role });
    taken.add(generated.toLowerCase());
    const shown = displayName({ ...districtFixed[id]!, generated, label: `District ${id + 1}` });
    const neighbourhoods: NeighbourhoodPlace[] = d.neighbourhoods.map((_, i) => {
      const fixed = neighbourhoodFixed[id]![i]!;
      // A Neighbourhood's birth order is its District's id and its own index, so adding a Neighbourhood
      // elsewhere never changes this one's street name.
      const street = namer.name({ kind: "neighbourhood", birthOrder: id * NEIGHBOURHOOD_SLOTS + i, role: null });
      taken.add(street.toLowerCase());
      const text = displayName({ ...fixed, generated: street, label: street });
      return { id: i, name: text.text, source: sourceIndex(text.source) };
    });
    return {
      id,
      name: shown.text,
      source: sourceIndex(shown.source),
      generated,
      colour: d.colour,
      anchor: d.anchor,
      neighbourhoods,
    };
  });

  const file: PlacesFile = {
    formatVersion: PLACES_FORMAT_VERSION,
    city: { name: cityName, source: sourceIndex("generated") },
    districts: places,
  };
  return { file, [SEALED]: true } as PlaceTable;
}

/** The naming step's options for External Cities (SPEC §8): the same Theme and seed as the places, and the same leak checks. */
export interface ExternalNameOptions extends NameOptions {
  theme: Theme;
  /** The seed text for Generated names. Never written to the output. */
  seed: string;
  /** The hidden terms: every Generated name must avoid them, and so must the Real names of Cities that are not revealed. */
  hidden: readonly string[];
  /** Names already in the City (Districts, the City itself): a Generated name must differ from them. */
  taken: readonly string[];
}

export interface ExternalName {
  name: string;
  /** Index in NAME_SOURCES. */
  source: number;
}

/**
 * The display names of External Cities, one per key in order. An External City gets a proper name only (SPEC §8): its
 * Pseudonym, or its Real name when revealed, or else a Generated name from the Namer. Only the Real name of a revealed
 * City ever reaches the output.
 */
export function nameExternals(keys: readonly string[], config: Config, options: ExternalNameOptions): ExternalName[] {
  const ignoreReveal = options.private === true;
  const { pseudonymConcepts, hiddenConcepts } = conceptPolicies(config.rules, ignoreReveal);
  const hidden = [...options.hidden];
  const taken = new Set(options.taken.map((name) => name.toLowerCase()));
  const leaks = (text: string) => containsAny(text, hidden) || findNearMisses(text, hidden).length > 0;
  const accept = (candidate: string) => !taken.has(candidate.toLowerCase()) && !leaks(candidate);
  const namer = new ThemeNamer({ theme: options.theme, seed: options.seed, accept, leaks });
  return keys.map((key, i) => {
    const policy = resolveItem(config.rules, { external: key }, { ignoreReveal });
    const pseudonym = policy.name.mode === "pseudonym" ? replaceConcepts(policy.name.as, pseudonymConcepts) : undefined;
    let real: string | undefined;
    if (policy.name.mode === "reveal") {
      const candidate = replaceConcepts(key, pseudonymConcepts);
      if (!containsAny(candidate, hiddenConcepts)) real = candidate;
    }
    // Birth order 0 is the City itself, so External Cities count from 1.
    const generated = pseudonym === undefined && real === undefined ? namer.name({ kind: "city", birthOrder: i + 1, role: null }) : undefined;
    const shown = displayName({ pseudonym, real, generated, label: `External City ${i + 1}` });
    taken.add(shown.text.toLowerCase());
    return { name: shown.text, source: sourceIndex(shown.source) };
  });
}

/** Index of a name's source in NAME_SOURCES. A label is never a place's name, so it counts as generated. */
function sourceIndex(source: "pseudonym" | "real" | "generated" | "label"): number {
  return NAME_SOURCES.indexOf(source === "label" ? "generated" : source);
}

/** The places.json text. Only the naming step's table can be passed in. */
export function encodePlaces(table: PlaceTable): string {
  return `${JSON.stringify(table.file)}\n`;
}

/** The id that marks an absent Contributor or commit message in the world file (the format's NO_CONTENT). */
export const NO_STRING = NO_CONTENT;

/** The name Automation shows under, for every bot together (SPEC §8). */
export const AUTOMATION_NAME = "Automation";

/** Commit messages longer than this are cut short, with an ellipsis. */
const MESSAGE_LIMIT = 160;

/** Anything shaped like an email address: never written to the output, even inside a commit message. */
const EMAIL_LIKE = /[^\s<>()"',;]+@[^\s<>()"',;]+/g;

export interface ContributionOptions extends NameOptions {
  /**
   * The contributor level the City is named at. A person's Real name is shown only at `real`, and under `--private`
   * a Generated name stands in for it. Off means `contributors` is empty (the caller passes none).
   */
  level: ContributorLevel;
  theme: Theme;
  /** The seed text for Generated names. Never written to the output. */
  seed: string;
  /** The hidden terms from `nameFiles`: no contributor or message may contain one. */
  hidden: readonly string[];
  /** Names already in the City (Districts, External Cities, the City): a Generated name must differ from them. */
  taken: readonly string[];
  /** The subject line of each Step's newest commit, when commit messages are on. */
  subjects?: readonly string[];
}

/**
 * The naming step's output for Contributors and commit messages. Their strings are appended to the file names in the
 * same table, so `strings.json` stays the only text in the output and the final scan covers them.
 */
export interface ContributionNaming {
  table: StringTable;
  /** Per Contributor, in the order given: the string id of its name. */
  contributorName: Uint32Array;
  /** Per Step: the string id of its commit message, or NO_STRING. Present only when messages are on. */
  message?: Uint32Array;
  /** How many Contributors' Real names are shown (SPEC §8). */
  revealed: number;
}

/**
 * Names Contributors (SPEC §8) and commit messages (SPEC §11). A pseudonym rule for a contributor wins; a
 * Concept Pseudonym applies to every name and message; a message with a hidden term, or with nothing left once
 * email addresses are removed, is shown without its text.
 */
export function nameContributions(
  table: StringTable,
  contributors: readonly ContributorInput[],
  config: Config,
  options: ContributionOptions,
): ContributionNaming {
  const ignoreReveal = options.private === true;
  const rules = config.rules;
  const { pseudonymConcepts, hiddenConcepts } = conceptPolicies(rules, ignoreReveal);
  const hidden = [...options.hidden];
  const taken = new Set(options.taken.map((name) => name.toLowerCase()));
  const leaks = (text: string) => containsAny(text, hidden) || findNearMisses(text, hidden).length > 0;
  const accept = (candidate: string) => !taken.has(candidate.toLowerCase()) && !leaks(candidate);
  const namer = new ThemeNamer({ theme: options.theme, seed: options.seed, accept, leaks });

  const strings = [...table.strings];
  let revealed = 0;
  let person = 0;
  // Fixed names first, so a Generated name never takes one (as for Districts). Anonymous numbers count every person
  // in first-commit order, pseudonymous ones included, so a Contributor keeps its number when a rule changes.
  const fixed: (string | undefined)[] = contributors.map((c) => {
    if (c.automation) return AUTOMATION_NAME;
    const ordinal = ++person;
    const policy = contributorPolicy(rules, c, ignoreReveal);
    if (policy.name.mode === "pseudonym") return replaceConcepts(policy.name.as, pseudonymConcepts);
    if (options.level === "anonymous") return `Contributor ${ordinal}`;
    if (options.level === "real" && !ignoreReveal) {
      const candidate = replaceConcepts(c.name, pseudonymConcepts);
      if (candidate !== "" && !containsAny(candidate, hiddenConcepts) && !containsAny(candidate, hidden)) {
        revealed++;
        return candidate;
      }
    }
    return undefined;
  });
  for (const text of fixed) if (text !== undefined) taken.add(text.toLowerCase());

  // A Generated name's birth order is the Contributor's index, so it never changes as later Contributors appear.
  const contributorName = Uint32Array.from(contributors, (_, i) => {
    const text = fixed[i] ?? namer.name({ kind: "person", birthOrder: i, role: null });
    taken.add(text.toLowerCase());
    strings.push(text);
    return strings.length - 1;
  });

  let message: Uint32Array | undefined;
  if (options.subjects !== undefined) {
    const ids = new Map<string, number>();
    message = Uint32Array.from(options.subjects, (subject) => {
      const text = messageText(subject, pseudonymConcepts, hidden);
      if (text === undefined) return NO_STRING;
      const known = ids.get(text);
      if (known !== undefined) return known;
      strings.push(text);
      ids.set(text, strings.length - 1);
      return strings.length - 1;
    });
  }

  return { table: { strings, [SEALED]: true } as StringTable, contributorName, message, revealed };
}

/** The policy a contributor's rules give. A rule can name a contributor by its mailmapped name or its email. */
function contributorPolicy(rules: Config["rules"], c: ContributorInput, ignoreReveal: boolean): ItemPolicy {
  const byKey = resolveItem(rules, { contributor: c.key }, { ignoreReveal });
  if (byKey.name.mode === "pseudonym") return byKey;
  return resolveItem(rules, { contributor: c.name }, { ignoreReveal });
}

/**
 * A commit message's shown text: the subject without email addresses, Concept Pseudonyms applied, and cut short.
 * Undefined when nothing is left, or when the text holds a hidden term (the message is then not shown).
 */
export function messageText(subject: string, pseudonymConcepts: readonly { word: string; as: string }[], hidden: readonly string[]): string | undefined {
  const withoutEmails = subject.replace(EMAIL_LIKE, "").replace(/\s+/g, " ").trim();
  if (withoutEmails === "") return undefined;
  const text = replaceConcepts(withoutEmails, pseudonymConcepts);
  if (containsAny(text, hidden)) return undefined;
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1).trimEnd()}…` : text;
}

/**
 * Hidden terms that a revealed name comes close to: same letters after dropping case
 * and separators (so camelCase and path splits count), within an edit distance that
 * scales with length. Terms shorter than four letters are ignored.
 */
export function findNearMisses(text: string, terms: readonly string[]): string[] {
  const shown = normalize(text);
  const matched: string[] = [];
  for (const term of terms) {
    const target = normalize(term);
    if (target.length < 4) continue;
    const allowed = target.length >= 8 ? 2 : 1;
    // Pigeonhole prefilter: a window within `allowed` edits of the term keeps at least one of
    // the term's allowed+1 pieces intact, so only terms sharing such a piece need the full check.
    if (!piecesOf(target, allowed + 1).some((piece) => shown.includes(piece))) continue;
    if (withinWindow(shown, target, allowed)) matched.push(term);
  }
  return matched;
}

/** Splits `text` into `count` contiguous pieces of near-equal length. */
function piecesOf(text: string, count: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < count; i++) {
    pieces.push(text.slice(Math.floor((i * text.length) / count), Math.floor(((i + 1) * text.length) / count)));
  }
  return pieces;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * True when some substring of `haystack` is within `allowed` edits of `needle`.
 * Sellers' algorithm: one dynamic-programming pass, where the first row is free,
 * so a match may start anywhere in the haystack.
 */
function withinWindow(haystack: string, needle: string, allowed: number): boolean {
  const m = needle.length;
  let previous = Array.from({ length: m + 1 }, (_, i) => i);
  if (previous[m]! <= allowed) return true;
  for (let j = 1; j <= haystack.length; j++) {
    const current = [0];
    for (let i = 1; i <= m; i++) {
      const cost = needle[i - 1] === haystack[j - 1] ? 0 : 1;
      current.push(Math.min(previous[i]! + 1, current[i - 1]! + 1, previous[i - 1]! + cost));
    }
    if (current[m]! <= allowed) return true;
    previous = current;
  }
  return false;
}

/** Folder and file names of a path, with the extension dropped from the file name. */
function segmentsOf(path: string): string[] {
  return path
    .split("/")
    .map((segment, i, all) => (i === all.length - 1 ? segment.replace(/\.[^.]*$/, "") : segment))
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

function containsAny(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/** Replaces each Concept word with its Pseudonym, matching the word's case. */
function replaceConcepts(text: string, pairs: readonly { word: string; as: string }[]): string {
  let out = text;
  for (const { word, as } of pairs) {
    out = out.replace(new RegExp(escapeRegExp(word), "gi"), (match) => matchCase(match, as));
  }
  return out;
}

function matchCase(match: string, as: string): string {
  if (match === match.toUpperCase()) return as.toUpperCase();
  if (match === match.toLowerCase()) return as.toLowerCase();
  if (match[0] === match[0]!.toUpperCase() && match.slice(1) === match.slice(1).toLowerCase()) {
    return as.charAt(0).toUpperCase() + as.slice(1);
  }
  return as;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
