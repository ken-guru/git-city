import { describe, expect, it } from "vitest";
import {
  classifyImport,
  declarationsOf,
  externalReport,
  ExternalRegistry,
  groupKeyOf,
  highwayLanes,
  importerKey,
  planExternals,
  type Declaration,
} from "../src/cli/imports/externals.js";

/**
 * Seams under test (SPEC §4 External Dependencies, §7 External Cities):
 * - `declarationsOf`: direct dependencies read from package.json, pyproject.toml and requirements*.txt; lockfiles are ignored.
 * - `classifyImport`: an import matched to a declaration by npm exact name or by Python normalised name.
 * - `groupKeyOf` and `planExternals`: grouping by scope or shared first token, the threshold, the cap, and the Outskirts.
 * - `ExternalRegistry`: the same grouping fed one commit at a time, recording the commit a group is promoted at.
 */

const decl = (ecosystem: "npm" | "python", name: string, manifest = ""): Declaration => ({ ecosystem, name, manifest });

describe("declarations from manifests", () => {
  it("reads dependencies, devDependencies and peerDependencies from package.json", () => {
    const text = JSON.stringify({
      dependencies: { react: "^18" },
      devDependencies: { vitest: "^1" },
      peerDependencies: { "@babel/core": "*" },
    });
    expect(declarationsOf("web/package.json", text).map((d) => [d.ecosystem, d.name, d.manifest]).sort()).toEqual([
      ["npm", "@babel/core", "web"],
      ["npm", "react", "web"],
      ["npm", "vitest", "web"],
    ]);
  });

  it("reads PEP 621 dependencies from pyproject.toml, with extras and markers stripped", () => {
    const text = [
      "[project]",
      'name = "app"',
      "dependencies = [",
      '  "Foo_Bar>=1.2",',
      '  "requests[socks] ; python_version > \\"3.8\\"",',
      "]",
      "[project.optional-dependencies]",
      'test = ["pytest==8.0"]',
      "[tool.other]",
      'ignored = ["nope"]',
    ].join("\n");
    expect(declarationsOf("pyproject.toml", text).map((d) => d.name).sort()).toEqual(["Foo_Bar", "pytest", "requests"]);
  });

  it("reads requirements files, skipping comments, options, URLs and blank lines", () => {
    const text = [
      "# pinned",
      "-r base.txt",
      "",
      "numpy==1.26  # comment",
      "git+https://example.com/x.git#egg=thing",
      "https://example.com/y.whl",
      "Django[bcrypt]>=4",
    ].join("\n");
    expect(declarationsOf("requirements-dev.txt", text).map((d) => d.name).sort()).toEqual(["Django", "numpy"]);
  });

  it("ignores lockfiles and unrelated files", () => {
    expect(declarationsOf("package-lock.json", '{"packages":{"x":{}}}')).toEqual([]);
    expect(declarationsOf("poetry.lock", 'name = "x"')).toEqual([]);
  });
});

describe("classifying an import against declarations", () => {
  it("matches an npm import to a declared name exactly", () => {
    const declared = [decl("npm", "@babel/core"), decl("npm", "lodash")];
    expect(classifyImport("npm", "@babel/core", declared)?.name).toBe("@babel/core");
    expect(classifyImport("npm", "lodash.debounce", declared)).toBeUndefined();
  });

  it("matches a Python import to a declared name by normalised name, in both directions", () => {
    expect(classifyImport("python", "foo-bar", [decl("python", "Foo_Bar")])?.name).toBe("Foo_Bar");
    expect(classifyImport("python", "Foo_Bar", [decl("python", "foo-bar")])?.name).toBe("foo-bar");
  });

  it("never matches across ecosystems, and drops undeclared imports", () => {
    expect(classifyImport("python", "react", [decl("npm", "react")])).toBeUndefined();
    expect(classifyImport("npm", "express", [decl("npm", "react")])).toBeUndefined();
  });
});

describe("grouping", () => {
  it("groups by npm scope, and folds @types into the package it describes", () => {
    const declared = [decl("npm", "@babel/core"), decl("npm", "babel-loader"), decl("npm", "@types/react"), decl("npm", "react")];
    expect(groupKeyOf("npm", "@babel/core", declared)).toBe("babel");
    expect(groupKeyOf("npm", "babel-loader", declared)).toBe("babel");
    expect(groupKeyOf("npm", "@types/react", declared)).toBe("react");
  });

  it("groups Python names by normalised first token", () => {
    const declared = [decl("python", "Azure_Storage-Blob"), decl("python", "azure-core")];
    expect(groupKeyOf("python", "Azure_Storage-Blob", declared)).toBe("azure");
  });

  it("forms a token group only when two declarations share it, or the token is itself a declared package", () => {
    const declared = [decl("npm", "lodash.debounce"), decl("npm", "lodash.clonedeep"), decl("npm", "left-pad")];
    expect(groupKeyOf("npm", "lodash.debounce", declared)).toBe("lodash");
    expect(groupKeyOf("npm", "left-pad", declared)).toBe("left-pad");
  });
});

describe("planning External Cities", () => {
  const babel = ["@babel/core", "@babel/cli", "babel-loader"].map((n) => decl("npm", n));

  it("gives a group of at least 3 distinct members its own External City and sends the rest to the Outskirts", () => {
    const plan = planExternals([...babel, decl("npm", "left-pad")]);
    expect(plan.cities.map((c) => [c.key, c.members.length])).toEqual([["babel", 3]]);
    expect(plan.outskirts).toEqual(["left-pad"]);
  });

  it("keeps at most 16 External Cities, the largest winning", () => {
    const declarations: Declaration[] = [];
    for (let g = 0; g < 20; g++) {
      for (let m = 0; m < 3 + (g % 5); m++) declarations.push(decl("npm", `grp${g}-part${m}`));
    }
    const plan = planExternals(declarations);
    expect(plan.cities).toHaveLength(16);
    expect(plan.cities.every((c) => c.members.length >= 3)).toBe(true);
    expect(plan.cities[0]!.members.length).toBe(7);
  });

  it("applies a configured threshold between 3 and 5 only", () => {
    expect(planExternals(babel, { threshold: 4 }).cities).toEqual([]);
    expect(() => planExternals(babel, { threshold: 2 })).toThrow();
    expect(() => planExternals(babel, { threshold: 6 })).toThrow();
  });
});

describe("the registry", () => {
  it("records the commit a group is promoted at, once its distinct members reach the threshold", () => {
    const registry = new ExternalRegistry();
    registry.declare(1, decl("npm", "@babel/core"));
    registry.declare(2, decl("npm", "@babel/cli"));
    expect(registry.promotedAt("babel")).toBeUndefined();
    registry.declare(5, decl("npm", "babel-loader"));
    expect(registry.promotedAt("babel")).toBe(5);
    expect(registry.plan().cities.map((c) => c.key)).toEqual(["babel"]);
  });

  it("keeps a group's distinct members once seen, even after the manifest drops them", () => {
    const registry = new ExternalRegistry();
    for (const name of ["@babel/core", "@babel/cli", "babel-loader"]) registry.declare(1, decl("npm", name));
    registry.undeclare(2, decl("npm", "babel-loader"));
    expect(registry.plan().cities[0]!.members).toHaveLength(3);
  });
});

describe("the dependency report for the build summary", () => {
  it("lists every declared dependency with its City or the Outskirts, and Highway Lanes at least 1 each way", () => {
    const declared = [decl("npm", "@babel/core"), decl("npm", "@babel/cli"), decl("npm", "babel-loader"), decl("npm", "left-pad"), decl("python", "Foo_Bar")];
    const importers = new Map([[importerKey("npm", "@babel/core"), 4]]);
    const report = externalReport(declared, importers);
    expect(report.cities).toEqual([{ key: "babel", ecosystem: "npm", members: 3 }]);
    expect(report.dependencies.map((d) => [d.name, d.city, d.importers, d.lanes])).toEqual([
      ["@babel/cli", "babel", 0, 1],
      ["@babel/core", "babel", 4, 4],
      ["babel-loader", "babel", 0, 1],
      ["left-pad", undefined, 0, 1],
      ["Foo_Bar", undefined, 0, 1],
    ]);
  });

  it("gives a Highway at least one Lane even with no importing file", () => {
    expect(highwayLanes(0)).toBe(1);
    expect(highwayLanes(7)).toBe(7);
  });
});
