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

describe("loadConfig", () => {
  it("merges files in the order given, so later rules come last", () => {
    const shared = file("git-city.config.jsonc", `{ "rules": [{ "path": "a/**", "action": "reveal" }] }`);
    const personal = file("config.jsonc", `{ "rules": [{ "path": "a/**", "action": "pseudonym", "as": "X" }] }`);

    const config = loadConfig([shared, personal]);

    expect(config.rules.map((r) => r.action)).toEqual(["reveal", "pseudonym"]);
    expect(config.sources).toEqual([shared, personal]);
  });

  it("returns an empty config when no files are given", () => {
    expect(loadConfig([])).toEqual({ rules: [], naming: {}, sources: [] });
  });

  it("fails clearly on a file that cannot be read", () => {
    expect(() => loadConfig(["/nonexistent/git-city.config.jsonc"])).toThrow(ConfigError);
  });
});
