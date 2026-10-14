import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/cli/config.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function file(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "git-city-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe("parseConfig", () => {
  it("reads JSONC with a $schema pointer and the rules section", () => {
    const config = parseConfig(
      `{
        // which names to show
        "$schema": "https://example.com/git-city.config.schema.json",
        "rules": [
          { "path": "src/billing/**", "action": "pseudonym", "as": "Ledger", },
        ],
      }`,
      "git-city.config.jsonc",
    );

    expect(config.rules).toEqual([
      { target: { kind: "path", value: "src/billing/**" }, action: "pseudonym", as: "Ledger" },
    ]);
  });

  it("parses every rule target and action", () => {
    const config = parseConfig(
      JSON.stringify({
        rules: [
          { module: "payments", action: "reveal" },
          { concept: "Acme", action: "pseudonym", as: "Vendor" },
          { contributor: "jane", action: "allow" },
          { external: "left-pad", action: "reveal" },
          { path: "docs/**", action: "category", category: "docs" },
        ],
      }),
      "x.jsonc",
    );

    expect(config.rules.map((r) => [r.target.kind, r.action])).toEqual([
      ["module", "reveal"],
      ["concept", "pseudonym"],
      ["contributor", "allow"],
      ["external", "reveal"],
      ["path", "category"],
    ]);
  });

  it("names the file and the offending key when a rule is malformed", () => {
    const bad = (rule: unknown) => () => parseConfig(JSON.stringify({ rules: [rule] }), "git-city.config.jsonc");

    expect(bad({ action: "reveal" })).toThrow(/git-city\.config\.jsonc.*rules\[0\].*target/);
    expect(bad({ path: "a", module: "b", action: "reveal" })).toThrow(/exactly one target/);
    expect(bad({ path: "a", action: "hide" })).toThrow(/action must be one of/);
    expect(bad({ path: "a", action: "pseudonym" })).toThrow(/requires "as"/);
    expect(bad({ path: "a", action: "reveal", as: "x" })).toThrow(/"as" is only allowed/);
    expect(bad({ path: "a", action: "category" })).toThrow(/requires "category"/);
    expect(bad({ path: "", action: "reveal" })).toThrow(/non-empty/);
  });

  it("rejects an unknown top-level key, so a typo cannot be silently ignored", () => {
    expect(() => parseConfig(`{ "rulez": [] }`, "git-city.config.jsonc")).toThrow(/unknown key "rulez"/);
  });

  it("reads the naming seed", () => {
    expect(parseConfig(`{ "naming": { "seed": "abc" } }`, "x").naming).toEqual({ seed: "abc" });
    expect(parseConfig(`{}`, "x").naming).toEqual({});
  });
});

describe("exactTimes", () => {
  it("is read from the config, and the personal file's setting wins", () => {
    expect(parseConfig(`{ "exactTimes": true }`, "x").exactTimes).toBe(true);
    expect(parseConfig(`{}`, "x").exactTimes).toBeUndefined();

    const shared = file("git-city.config.jsonc", `{ "exactTimes": true }`);
    const personal = file("config.jsonc", `{ "exactTimes": false }`);
    expect(loadConfig([shared, personal]).exactTimes).toBe(false);
    expect(loadConfig([shared]).exactTimes).toBe(true);
  });
});

describe("loadConfig", () => {
  it("merges files in the order given, so later rules come last", () => {
    const shared = file("git-city.config.jsonc", `{ "rules": [{ "path": "a/**", "action": "reveal" }] }`);
    const personal = file("config.jsonc", `{ "rules": [{ "path": "a/**", "action": "pseudonym", "as": "X" }] }`);

    const config = loadConfig([shared, personal]);

    expect(config.rules.map((r) => r.action)).toEqual(["reveal", "pseudonym"]);
    expect(config.sources).toEqual([shared, personal]);
  });

  it("returns an empty config when no files are given", () => {
    expect(loadConfig([])).toEqual({ rules: [], naming: {}, exclude: [], scale: {}, exactTimes: false, sources: [] });
  });

  it("fails clearly on a file that cannot be read", () => {
    expect(() => loadConfig(["/nonexistent/git-city.config.jsonc"])).toThrow(ConfigError);
  });
});

describe("the externals section", () => {
  it("reads the threshold and the grouping overrides", () => {
    const config = parseConfig(JSON.stringify({ externals: { threshold: 4, groups: { "left-pad": "padding" } } }), "git-city.config.jsonc");
    expect(config.externals).toEqual({ threshold: 4, groups: { "left-pad": "padding" } });
  });

  it("refuses a threshold outside 3 to 5, and unknown keys", () => {
    expect(() => parseConfig(JSON.stringify({ externals: { threshold: 6 } }), "c.jsonc")).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ externals: { threshold: 2 } }), "c.jsonc")).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ externals: { colour: "red" } }), "c.jsonc")).toThrow(ConfigError);
  });

  it("merges the groups of later config files over earlier ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-city-externals-cfg-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const shared = join(dir, "shared.jsonc");
    const personal = join(dir, "personal.jsonc");
    writeFileSync(shared, JSON.stringify({ externals: { threshold: 4, groups: { a: "one" } } }));
    writeFileSync(personal, JSON.stringify({ externals: { groups: { a: "two", b: "three" } } }));
    expect(loadConfig([shared, personal]).externals).toEqual({ threshold: 4, groups: { a: "two", b: "three" } });
  });

  it("reads the contributors level and the commit messages switch", () => {
    const config = parseConfig('{ "contributors": "generated", "commitMessages": true }', "c.jsonc");
    expect(config.contributors).toBe("generated");
    expect(config.commitMessages).toBe(true);
    expect(parseConfig("{}", "c.jsonc").contributors).toBeUndefined();
    expect(parseConfig("{}", "c.jsonc").commitMessages).toBeUndefined();
  });

  it("refuses an unknown contributors level and a non-boolean commitMessages", () => {
    expect(() => parseConfig('{ "contributors": "everyone" }', "c.jsonc")).toThrow(/"contributors" must be one of off, anonymous, generated, real/);
    expect(() => parseConfig('{ "commitMessages": "yes" }', "c.jsonc")).toThrow(/"commitMessages" must be true or false/);
  });

  it("lets the personal config override the contributors level and the messages switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-city-config-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const shared = join(dir, "shared.jsonc");
    const personal = join(dir, "personal.jsonc");
    writeFileSync(shared, JSON.stringify({ contributors: "anonymous", commitMessages: true }));
    writeFileSync(personal, JSON.stringify({ contributors: "real" }));
    const merged = loadConfig([shared, personal]);
    expect(merged.contributors).toBe("real");
    expect(merged.commitMessages).toBe(true);
    expect(loadConfig([shared]).contributors).toBe("anonymous");
  });
});
