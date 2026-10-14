import { describe, expect, it } from "vitest";
import { NamerError, ThemeNamer } from "../src/cli/namer.js";
import { loadTheme } from "../src/cli/theme.js";

const modern = loadTheme("modern");
const medieval = loadTheme("medieval");
const anything = () => true;

function namer(overrides: Partial<ConstructorParameters<typeof ThemeNamer>[0]> = {}) {
  return new ThemeNamer({ theme: modern, seed: "abc123", accept: anything, ...overrides });
}

describe("ThemeNamer", () => {
  it("gives a District a proper name plus its Role's noun", () => {
    const name = namer().name({ kind: "district", birthOrder: 0, role: "docs" });
    expect(name).toMatch(/^[A-Z][a-z]+ Library$/);
  });

  it("keeps a District's proper name when its Role changes, so only the noun moves", () => {
    const n = namer();
    const first = n.name({ kind: "district", birthOrder: 4, role: "auth" }).split(" ")[0];
    const second = n.name({ kind: "district", birthOrder: 4, role: "docs" }).split(" ")[0];
    expect(second).toBe(first);
  });

  it("is the same for the same seed, Theme and birth order, and differs for another seed", () => {
    const orders = [0, 1, 2, 3, 4, 5, 6, 7];
    const a = orders.map((birthOrder) => namer().name({ kind: "district", birthOrder, role: "api" }));
    const b = orders.map((birthOrder) => namer().name({ kind: "district", birthOrder, role: "api" }));
    const other = orders.map((birthOrder) => namer({ seed: "zzz999" }).name({ kind: "district", birthOrder, role: "api" }));
    expect(b).toEqual(a);
    expect(other).not.toEqual(a);
  });

  it("draws word pieces from the Theme", () => {
    const name = new ThemeNamer({ theme: medieval, seed: "s", accept: anything }).name({ kind: "city", birthOrder: 0, role: null });
    const { prefixes, suffixes } = medieval.wordPieces;
    expect(prefixes.some((p) => name.startsWith(p)) && suffixes.some((s) => name.endsWith(s))).toBe(true);
  });

  it("gives the City a proper name only", () => {
    const name = namer().name({ kind: "city", birthOrder: 0, role: null });
    expect(name).not.toContain(" ");
  });

  it("gives a Neighbourhood a proper name plus a street suffix", () => {
    const name = namer().name({ kind: "neighbourhood", birthOrder: 2, role: null });
    expect(modern.streetSuffixes.some((s) => name.endsWith(` ${s}`))).toBe(true);
  });

  it("rejects candidates that fail the accept check and tries another", () => {
    const name = namer({ accept: (c) => !/gate/i.test(c) }).name({ kind: "city", birthOrder: 0, role: null });
    expect(name).not.toMatch(/gate/i);
  });

  it("falls back to the fallback noun when a Role's own noun is refused", () => {
    const name = namer({ accept: (c) => !c.includes("Checkpoint") }).name({ kind: "district", birthOrder: 1, role: "auth" });
    expect(name.endsWith(` ${modern.roleNouns.fallback}`)).toBe(true);
  });

  it("finds the one free word-piece pair in a small pool, rather than giving up", () => {
    const { prefixes, suffixes } = modern.wordPieces;
    const only = `${prefixes[prefixes.length - 1]}${suffixes[suffixes.length - 1]}`;
    const name = namer({ accept: (c) => c === only }).name({ kind: "city", birthOrder: 0, role: null });
    expect(name).toBe(only);
  });

  it("gives up with an error when no candidate is ever accepted", () => {
    expect(() => namer({ accept: () => false }).name({ kind: "city", birthOrder: 0, role: null })).toThrow(NamerError);
  });
});
