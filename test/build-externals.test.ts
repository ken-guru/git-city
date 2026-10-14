import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../src/cli/build.js";
import { FixtureRepo } from "./fixture.js";

/**
 * Seam under test: `build`'s External Dependency report (SPEC §4, §7), read from the build summary. Declarations come
 * from the manifests at HEAD; imports come from the import graph. Expected values are counted by hand from the fixture.
 */

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function summaryOf(repo: FixtureRepo) {
  const root = mkdtempSync(join(tmpdir(), "git-city-externals-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  return build({ repoDir: repo.dir, outDir: join(root, "git-city-site"), pageDir });
}

async function citiesFileOf(repo: FixtureRepo) {
  const summary = await summaryOf(repo);
  return JSON.parse(readFileSync(join(summary.outDir, "externals.json"), "utf8")) as {
    horizon: number;
    cities: { name: string; source: number; from: number; to: number | null; members: number; outskirts: boolean }[];
    highways: { city: number; district: number; from: number; to: number | null; lanes: number }[];
    ring: number[];
  };
}

describe("External Cities in the output", () => {
  it("dates a City to the commit its third member is declared, and hides its Real name by default", async () => {
    const repo = new FixtureRepo();
    cleanups.push(() => repo.remove());
    repo.write("package.json", JSON.stringify({ dependencies: { "@babel/core": "1" } })).commit("one");
    repo.write("package.json", JSON.stringify({ dependencies: { "@babel/core": "1", "@babel/cli": "1" } })).commit("two");
    repo.write("package.json", JSON.stringify({ dependencies: { "@babel/core": "1", "@babel/cli": "1", "babel-loader": "1" } })).commit("three");

    const file = await citiesFileOf(repo);

    const babel = file.cities.find((c) => !c.outskirts)!;
    expect(babel.name).not.toContain("babel");
    expect(babel.source).toBe(0);
    expect(babel.from).toBe(2);
    expect(babel.to).toBeNull();
    expect(babel.members).toBe(3);
    // The ring has one Lane count per segment, each at least 1 (SPEC §7).
    expect(file.ring).toHaveLength(64);
    expect(file.ring.every((n) => n >= 1)).toBe(true);
    expect(file.highways.filter((h) => h.city === 0).map((h) => [h.district, h.from, h.lanes])).toEqual([
      [-1, 0, 1],
      [-1, 1, 1],
      [-1, 2, 1],
    ]);
  });

  it("shows the Real name of a City whose rule reveals it", async () => {
    const repo = new FixtureRepo();
    cleanups.push(() => repo.remove());
    repo
      .write("git-city.config.jsonc", '{ "rules": [{ "external": "babel", "action": "reveal" }] }')
      .write("package.json", JSON.stringify({ dependencies: { "@babel/core": "1", "@babel/cli": "1", "babel-loader": "1" } }))
      .commit("one");

    const file = await citiesFileOf(repo);

    expect(file.cities.find((c) => !c.outskirts)).toMatchObject({ name: "babel", source: 1 });
  });
});

describe("External Dependencies in the build summary", () => {
  it("matches a declared Python name to a differently spelled import, groups npm scopes, and drops undeclared imports", async () => {
    const repo = new FixtureRepo();
    cleanups.push(() => repo.remove());
    repo
      .write("package.json", JSON.stringify({ dependencies: { "@babel/core": "1", "@babel/cli": "1", "babel-loader": "1" } }))
      .write("web/index.ts", "import '@babel/core';\nimport x from 'lodash';\n")
      .write("app/pyproject.toml", '[project]\nname = "app"\ndependencies = ["Foo_Bar>=1", "requests", "unused-thing"]\n')
      .write("app/main.py", "import os\nimport foo_bar\nimport requests\n")
      .write("app/views.py", "import foo_bar\n")
      .commit("first");

    const { externals } = await summaryOf(repo);

    expect(externals.cities).toEqual([{ key: "babel", ecosystem: "npm", members: 3 }]);
    expect(externals.dependencies.map((d) => [d.name, d.city, d.importers, d.lanes])).toEqual([
      ["@babel/cli", "babel", 0, 1],
      ["@babel/core", "babel", 1, 1],
      ["babel-loader", "babel", 0, 1],
      ["Foo_Bar", undefined, 2, 2],
      ["requests", undefined, 1, 1],
      ["unused-thing", undefined, 0, 1],
    ]);
  });
});
