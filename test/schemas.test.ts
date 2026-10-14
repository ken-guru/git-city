import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/cli/config.js";
import { loadTheme, validateTheme } from "../src/cli/theme.js";
import { loadSchema, schemaErrors } from "./schema-check.js";

/**
 * The validators (src/cli/theme.ts, src/cli/config.ts) and the published schemas (schema/*.json) must agree.
 * Each case is run through both: the schema's verdict and the validator's must be the same, for valid input and for
 * every kind of invalid input. Expected verdicts are written here, from the spec, not read back from either side.
 */

const themeSchema = loadSchema(new URL("../schema/theme.schema.json", import.meta.url));
const configSchema = loadSchema(new URL("../schema/git-city.config.schema.json", import.meta.url));
const themeFile = (name: string) => JSON.parse(readFileSync(new URL(`../themes/${name}.json`, import.meta.url), "utf8")) as Record<string, any>;

/** A theme pack that both validators accept, to be broken one way at a time. */
function baseTheme(): Record<string, any> {
  return structuredClone(themeFile("modern"));
}

function themeVerdicts(pack: unknown): { schema: boolean; validator: boolean } {
  const schema = schemaErrors(themeSchema, pack).length === 0;
  let validator = true;
  try {
    validateTheme(pack);
  } catch {
    validator = false;
  }
  return { schema, validator };
}

const THEME_CASES: [string, (pack: Record<string, any>) => void, boolean][] = [
  ["the modern pack as shipped", () => {}, true],
  ["the medieval pack as shipped", () => {}, true],
  ["a missing Role noun", (p) => delete p.roleNouns.fallback, false],
  ["a missing palette swatch", (p) => delete p.palette.ui, false],
  ["no palette at all, which falls back to the built-in one", (p) => delete p.palette, true],
  ["an unknown top-level key", (p) => (p.extra = 1), false],
  ["a Role noun with a hyphen", (p) => (p.roleNouns.docs = "Bad-Noun"), false],
  ["a Role noun longer than 24 characters", (p) => (p.roleNouns.docs = "A".repeat(25)), false],
  ["a hue above 360", (p) => (p.palette.ui.hue = 400), false],
  ["a hue below 0", (p) => (p.palette.ui.hue = -1), false],
  ["a name with a space", (p) => (p.name = "bad name"), false],
  ["an empty prefix list", (p) => (p.wordPieces.prefixes = []), false],
  ["a capitalised suffix piece", (p) => (p.wordPieces.suffixes = ["Ford"]), false],
  ["a street suffix with a digit", (p) => (p.streetSuffixes = ["Lane 1"]), false],
  ["an empty display title", (p) => (p.display.title = ""), false],
  ["a whitespace-only display title", (p) => (p.display.title = "   "), false],
  ["an extra palette key", (p) => (p.palette.zzz = { hue: 1 }), false],
];

describe("theme validator and theme.schema.json", () => {
  for (const [label, change, expected] of THEME_CASES) {
    it(`agree on ${label}`, () => {
      const pack = baseTheme();
      change(pack);
      const verdicts = themeVerdicts(pack);
      expect(verdicts).toEqual({ schema: expected, validator: expected });
    });
  }

  it("agree that the built-in themes load through loadTheme", () => {
    for (const name of ["modern", "medieval"]) {
      expect(themeVerdicts(themeFile(name))).toEqual({ schema: true, validator: true });
      expect(loadTheme(name).name).toBe(name);
    }
  });
});

/** Config cases: the schema's verdict and the parser's must match for each one. */
const CONFIG_CASES: [string, unknown, boolean][] = [
  ["an empty config", {}, true],
  ["a reveal rule on a path", { rules: [{ path: "src/**", action: "reveal" }] }, true],
  ["a pseudonym rule with its replacement", { rules: [{ concept: "Acme", action: "pseudonym", as: "Acorn" }] }, true],
  ["a category rule", { rules: [{ path: "vendor/**", action: "category", category: "generated" }] }, true],
  ["a naming seed", { naming: { seed: "abc" } }, true],
  ["a theme name", { theme: "medieval" }, true],
  ["contributors set to a level", { contributors: "generated" }, true],
  ["commit messages switched on", { commitMessages: true }, true],
  ["a list of excluded paths", { exclude: ["dist/**"] }, true],
  ["an unknown top-level key", { rulez: [] }, false],
  ["a rule with no target", { rules: [{ action: "reveal" }] }, false],
  ["a rule with two targets", { rules: [{ path: "a", module: "b", action: "reveal" }] }, false],
  ["a rule with an empty target", { rules: [{ path: "", action: "reveal" }] }, false],
  ["a rule whose target is only spaces", { rules: [{ path: "   ", action: "reveal" }] }, false],
  ["a pseudonym rule without a replacement", { rules: [{ path: "a", action: "pseudonym" }] }, false],
  ["a reveal rule with a replacement", { rules: [{ path: "a", action: "reveal", as: "x" }] }, false],
  ["a category rule without a category", { rules: [{ path: "a", action: "category" }] }, false],
  ["an action that does not exist", { rules: [{ path: "a", action: "hide" }] }, false],
  ["a naming section with an unknown key", { naming: { other: "x" } }, false],
  ["a numeric naming seed", { naming: { seed: 5 } }, false],
  ["a numeric theme", { theme: 3 }, false],
  ["a contributors level that does not exist", { contributors: "bogus" }, false],
  ["commit messages set to text", { commitMessages: "yes" }, false],
  ["exclude given as one string", { exclude: "dist/**" }, false],
  ["scale given as a number", { scale: 3 }, false],
];

describe("config parser and git-city.config.schema.json", () => {
  for (const [label, config, expected] of CONFIG_CASES) {
    it(`agree on ${label}`, () => {
      const schema = schemaErrors(configSchema, config).length === 0;
      let validator = true;
      try {
        parseConfig(JSON.stringify(config), "test.jsonc");
      } catch {
        validator = false;
      }
      expect({ schema, validator }).toEqual({ schema: expected, validator: expected });
    });
  }
});
