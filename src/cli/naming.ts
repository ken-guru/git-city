import type { Config } from "./config.js";
import { conceptWords, resolveConcept, resolveItem, type ItemPolicy } from "./rules.js";

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

/** Names every file (by id, in birth order). The only way to produce a StringTable. */
export function nameFiles(paths: readonly string[], config: Config, options: NameOptions = {}): NamingResult {
  const ignoreReveal = options.private === true;
  const rules = config.rules;

  const concepts = conceptWords(rules).map((word) => ({ word, policy: resolveConcept(rules, word, { ignoreReveal }) }));
  const pseudonymConcepts = concepts
    .flatMap((c) => (c.policy.name.mode === "pseudonym" ? [{ word: c.word, as: c.policy.name.as }] : []))
    .sort((a, b) => b.word.length - a.word.length);
  const hiddenConcepts = concepts.filter((c) => c.policy.name.mode === "hidden").map((c) => c.word);
  const unrevealedConcepts = concepts.filter((c) => c.policy.name.mode !== "reveal");

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
