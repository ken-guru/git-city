import type { Role } from "./layout.js";
import type { Theme, ThemeKey } from "./theme.js";

/**
 * The Namer interface. It takes structural metadata only: never a path, a Real name or a Contributor.
 * Every candidate passes through `accept`, which the naming step supplies (uniqueness and leak checks).
 */
export interface NamingMetadata {
  /** A person is a Contributor's Generated name (SPEC §8): a given name and a family name from the Theme. */
  kind: "city" | "district" | "neighbourhood" | "person";
  /** Birth order within its kind: the index in creation order. */
  birthOrder: number;
  /** A District's Role, or null when none was detected. Ignored for other kinds. */
  role: Role | null;
}

export interface Namer {
  name(metadata: NamingMetadata): string;
}

export interface ThemeNamerOptions {
  theme: Theme;
  /** The seed text: the root commit hash, or the `naming.seed` override. Never written to the output. */
  seed: string;
  /** True when a candidate is unique in the City and passes the leak checks. */
  accept: (candidate: string) => boolean;
  /**
   * True when a text would reveal a hidden term. A Role noun is only a suffix, so it is refused for leaking alone, never
   * for being taken. Defaults to never leaking.
   */
  leaks?: (text: string) => boolean;
}

/** Candidates tried before a name is given up on. */
const ATTEMPTS = 256;

export class NamerError extends Error {}

/** The Theme namer: proper names from the Theme's word pieces, plus a Role noun or a street suffix. */
export class ThemeNamer implements Namer {
  constructor(private readonly options: ThemeNamerOptions) {}

  name(metadata: NamingMetadata): string {
    const { theme } = this.options;
    // A District with no usable noun is named by its proper name alone: still leak-checked, never an error.
    const noun = metadata.kind === "district" ? this.nounFor(metadata.role) : undefined;
    const suffixes = metadata.kind === "neighbourhood" ? theme.streetSuffixes : undefined;
    const tailFor = (attempt: number) => noun ?? suffixes?.[draw(this.key(metadata, attempt, "tail"), suffixes.length)];
    const join = (proper: string, tail: string | undefined) => (tail === undefined ? proper : `${proper} ${tail}`);
    // A person's name is two words from the Theme's person pieces; a place's is one word from its word pieces.
    const pieces =
      metadata.kind === "person"
        ? { prefixes: theme.personNames.given, suffixes: theme.personNames.family }
        : theme.wordPieces;
    const joinPieces = (a: string, b: string) => (metadata.kind === "person" ? `${a} ${b}` : `${a}${b}`);
    const { prefixes, suffixes: suffixPieces } = pieces;
    const properAt = (attempt: number) => {
      const prefix = prefixes[draw(this.key(metadata, attempt, "prefix"), prefixes.length)]!;
      const suffix = suffixPieces[draw(this.key(metadata, attempt, "suffix"), suffixPieces.length)]!;
      return joinPieces(prefix, suffix);
    };

    // Seeded draws first, so a City's names are stable and varied.
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const candidate = join(properAt(attempt), tailFor(attempt));
      if (this.options.accept(candidate)) return candidate;
    }
    // The pool of word pieces is finite, so try every combination in order before giving up.
    const tail = tailFor(0);
    for (const prefix of prefixes) {
      for (const suffix of suffixPieces) {
        const candidate = join(joinPieces(prefix, suffix), tail);
        if (this.options.accept(candidate)) return candidate;
      }
    }
    // Then a numeral on the first candidate, which keeps the name unique and leak-checked.
    const base = join(joinPieces(prefixes[0]!, suffixPieces[0]!), tail);
    for (let n = 2; n < ATTEMPTS + 2; n++) {
      const candidate = `${base} ${n}`;
      if (this.options.accept(candidate)) return candidate;
    }
    throw new NamerError(`no free ${metadata.kind} name in this City`);
  }

  /**
   * The Role noun, or the fallback noun when the Role's own noun would leak, or undefined when neither can be used.
   * Checked once per District, so the noun is fixed for the whole output.
   */
  private nounFor(role: Role | null): string | undefined {
    const { roleNouns } = this.options.theme;
    const leaks = this.options.leaks ?? (() => false);
    const own: ThemeKey = role ?? "fallback";
    if (!leaks(roleNouns[own])) return roleNouns[own];
    if (!leaks(roleNouns.fallback)) return roleNouns.fallback;
    return undefined;
  }

  private key(metadata: NamingMetadata, attempt: number, part: string): string {
    return [this.options.seed, this.options.theme.name, metadata.kind, metadata.birthOrder, attempt, part].join("\u0000");
  }
}

/** A value in [0, n) from a string key. The same key always gives the same value. */
export function draw(key: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) % n;
}

/** A 32-bit number from a string seed, for layout and colour. */
export function seedNumber(text: string): number {
  return draw(text, 0x100000000);
}
