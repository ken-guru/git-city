import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/cli/config.js";
import { pathExcluder } from "../src/cli/rules.js";

/**
 * Seams under test: the config's `exclude` and `scale.timeline` sections (parsed and merged by `parseConfig` and
 * `loadConfig`), and the path matcher the pipeline uses to leave files out (`pathExcluder`).
 */

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function file(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "git-city-exclude-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe("exclude and scale.timeline in the config", () => {
  it("reads exclude path globs", () => {
    expect(parseConfig(`{ "exclude": ["vendor/**", "*.lock"] }`, "c").exclude).toEqual(["vendor/**", "*.lock"]);
  });

  it("defaults to no exclusions and no pinned timeline", () => {
    const config = parseConfig(`{}`, "c");
    expect(config.exclude).toEqual([]);
    expect(config.scale.timeline).toBeUndefined();
  });

  it("reads scale.timeline as one of the Step settings", () => {
    expect(parseConfig(`{ "scale": { "timeline": "week" } }`, "c").scale.timeline).toBe("week");
    expect(parseConfig(`{ "scale": { "timeline": "commit" } }`, "c").scale.timeline).toBe("commit");
  });

  it("rejects an unknown scale.timeline value and unknown scale keys", () => {
    expect(() => parseConfig(`{ "scale": { "timeline": "hour" } }`, "c")).toThrow(ConfigError);
    expect(() => parseConfig(`{ "scale": { "density": 2 } }`, "c")).toThrow(ConfigError);
  });

  it("rejects exclude entries that are not strings", () => {
    expect(() => parseConfig(`{ "exclude": [3] }`, "c")).toThrow(ConfigError);
  });

  it("merges exclude lists from both files, and the later file's scale.timeline wins", () => {
    const shared = file("git-city.config.jsonc", `{ "exclude": ["a/**"], "scale": { "timeline": "month" } }`);
    const personal = file("personal.jsonc", `{ "exclude": ["b/**"], "scale": { "timeline": "day" } }`);
    const config = loadConfig([shared, personal]);
    expect(config.exclude).toEqual(["a/**", "b/**"]);
    expect(config.scale.timeline).toBe("day");
  });
});

describe("pathExcluder", () => {
  it("matches paths by glob, with ** crossing folders", () => {
    const excluded = pathExcluder(["vendor/**", "*.lock", "src/**/*.generated.ts"]);
    expect(excluded("vendor/lib/x.js")).toBe(true);
    expect(excluded("yarn.lock")).toBe(true);
    expect(excluded("src/a/b/schema.generated.ts")).toBe(true);
    expect(excluded("src/app.ts")).toBe(false);
    expect(excluded("docs/vendor/x.md")).toBe(false);
  });

  it("excludes nothing with no globs", () => {
    expect(pathExcluder([])("anything.ts")).toBe(false);
  });
});
