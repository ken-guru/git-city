import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_KEYS } from "../src/cli/theme.js";
import { loadSchema, schemaErrors } from "./schema-check.js";

/**
 * The docs under docs/ and README.md must match the published schemas. The config reference lists its keys between
 * two markers; this test reads them back and compares them with the paths the schema defines, both ways, so the
 * reference cannot drift from schema/git-city.config.schema.json.
 */

const configSchema = loadSchema(new URL("../schema/git-city.config.schema.json", import.meta.url));
const themeSchema = loadSchema(new URL("../schema/theme.schema.json", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

type Schema = Record<string, any>;

/** Every key path the config schema defines. Arrays show as `[]`; `$ref`s are followed; object sections with no
 * declared properties (`externals`, `tuning`) are leaves. */
function schemaPaths(node: Schema, root: Schema, prefix = "", out = new Set<string>()): Set<string> {
  const resolved = node.$ref ? resolveRef(root, node.$ref) : node;
  for (const [key, child] of Object.entries((resolved.properties ?? {}) as Record<string, Schema>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.add(path);
    schemaPaths(child, root, path, out);
  }
  // A list's items describe keys one level down: `rules` holds `rules[].path`, `rules[].action`, and so on.
  if (resolved.items) schemaPaths(resolved.items as Schema, root, `${prefix}[]`, out);
  for (const branch of [...((resolved.oneOf ?? []) as Schema[]), ...((resolved.allOf ?? []) as Schema[])]) {
    schemaPaths(branch, root, prefix, out);
  }
  return out;
}

function resolveRef(root: Schema, ref: string): Schema {
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown>)[part];
  return node as Schema;
}

/** The backticked keys in the first column of the config reference's table, between the markers. */
function documentedKeys(markdown: string): Set<string> {
  const match = /<!-- schema-keys:start -->([\s\S]*?)<!-- schema-keys:end -->/.exec(markdown);
  if (!match) throw new Error("docs/config.md has no schema-keys markers");
  const keys = new Set<string>();
  for (const row of match[1]!.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) keys.add(row[1]!);
  return keys;
}

const DOC_FILES = ["README.md", "docs/config.md", "docs/themes.md", "docs/privacy.md", "man/git-city.1"];

describe("documentation rules", () => {
  it("never documents the git city form, which collides with git's own subcommands", () => {
    for (const file of DOC_FILES) expect(read(file), file).not.toMatch(/git city\b/);
  });

  it("every relative link in the docs points at a file that exists", () => {
    for (const file of ["README.md", "docs/config.md", "docs/themes.md", "docs/privacy.md"]) {
      const dir = new URL(`../${file}`, import.meta.url);
      for (const [, target] of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(target!)) continue;
        expect(existsSync(new URL(target!, dir)), `${file} -> ${target}`).toBe(true);
      }
    }
  });

  it("the theme guide covers every Role and the fallback", () => {
    const guide = read("docs/themes.md");
    for (const key of THEME_KEYS) expect(guide, key).toContain(`\`${key}\``);
  });

  it("the example Theme in the guide validates against theme.schema.json", () => {
    const block = /```json\n([\s\S]*?)```/.exec(read("docs/themes.md"));
    expect(block).not.toBeNull();
    const example = JSON.parse(block![1]!) as unknown;
    expect(schemaErrors(themeSchema, example)).toEqual([]);
  });

  it("the privacy page names the audit command and the residual risks", () => {
    const privacy = read("docs/privacy.md");
    expect(privacy).toContain("git-city audit");
    expect(privacy).toMatch(/structural fingerprinting/i);
    expect(privacy).toMatch(/regenerat\w* seeded names/i);
    expect(privacy).toContain("naming.seed");
  });
});

describe("docs/config.md and git-city.config.schema.json", () => {
  const schema = schemaPaths(configSchema, configSchema);
  const documented = documentedKeys(read("docs/config.md"));

  it("reads nested keys out of the schema, so the check has teeth", () => {
    expect([...schema]).toEqual(expect.arrayContaining(["naming.seed", "scale.timeline", "rules[].path", "rules[].as"]));
  });

  it("documents every key the schema defines", () => {
    const missing = [...schema].filter((key) => !documented.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("lists only keys the schema defines", () => {
    const unknown = [...documented].filter((key) => !schema.has(key)).sort();
    expect(unknown).toEqual([]);
  });
});
