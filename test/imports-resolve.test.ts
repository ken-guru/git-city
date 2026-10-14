import { describe, expect, it } from "vitest";
import { createSnapshot, resolveImport } from "../src/cli/imports/resolve.js";

/**
 * Seam under test: `resolveImport(snapshot, fromPath, specifier)`, where the snapshot is the commit's
 * path set plus the text of its config files. Observed only through the resolution it returns.
 * Expected paths are literals; the snapshot never touches a filesystem.
 */

/** A commit's files: a path maps to its text, and an empty string stands for a source file. */
const repo = (files: Record<string, string>) => createSnapshot(files);

describe("relative specifiers (TypeScript lookup order)", () => {
  it("finds a sibling .ts file and a .js specifier that names a .ts file", () => {
    const snap = repo({ "src/a.ts": "", "src/b.ts": "", "src/util.ts": "" });

    expect(resolveImport(snap, "src/a.ts", "./b").target).toEqual({ kind: "file", path: "src/b.ts" });
    expect(resolveImport(snap, "src/a.ts", "./util.js").target).toEqual({ kind: "file", path: "src/util.ts" });
  });

  it("finds a directory's index file", () => {
    const snap = repo({ "src/a.ts": "", "src/lib/index.tsx": "" });

    expect(resolveImport(snap, "src/a.ts", "./lib").target).toEqual({ kind: "file", path: "src/lib/index.tsx" });
  });

  it("walks up with ../ and returns nothing for a file that is not in the commit", () => {
    const snap = repo({ "src/deep/a.ts": "", "src/shared.ts": "" });

    expect(resolveImport(snap, "src/deep/a.ts", "../shared").target).toEqual({ kind: "file", path: "src/shared.ts" });
    expect(resolveImport(snap, "src/deep/a.ts", "./gone").target).toBeUndefined();
  });

  it("reports every path it probed, so a later addition can invalidate the result", () => {
    const snap = repo({ "src/a.ts": "" });

    const { probes } = resolveImport(snap, "src/a.ts", "./b");

    expect(probes).toContain("src/b.ts");
  });
});

describe("tsconfig paths, baseUrl and extends", () => {
  it("maps a paths alias through baseUrl", () => {
    const snap = repo({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"] } } }`,
      "src/main.ts": "",
      "src/app/feature.ts": "",
    });

    expect(resolveImport(snap, "src/main.ts", "@app/feature").target).toEqual({ kind: "file", path: "src/app/feature.ts" });
  });

  it("inherits paths from an extended tsconfig", () => {
    const snap = repo({
      "tsconfig.base.json": `{ // shared\n "compilerOptions": { "baseUrl": "src", "paths": { "lib/*": ["lib/*"] } } }`,
      "tsconfig.json": `{ "extends": "./tsconfig.base.json" }`,
      "src/main.ts": "",
      "src/lib/x/y.ts": "",
    });

    expect(resolveImport(snap, "src/main.ts", "lib/x/y").target).toEqual({ kind: "file", path: "src/lib/x/y.ts" });
  });
});

describe("package.json imports, workspaces and exports", () => {
  it("resolves a # import through the nearest package.json imports map", () => {
    const snap = repo({
      "pkg/package.json": `{ "name": "pkg", "imports": { "#utils": "./src/utils.ts" } }`,
      "pkg/src/a.ts": "",
      "pkg/src/utils.ts": "",
    });

    expect(resolveImport(snap, "pkg/src/a.ts", "#utils").target).toEqual({ kind: "file", path: "pkg/src/utils.ts" });
  });

  it("resolves a workspace package by name, mapping its dist export back to source", () => {
    const snap = repo({
      "package.json": `{ "name": "root", "workspaces": ["packages/*"] }`,
      "packages/ui/package.json": `{ "name": "@acme/ui", "exports": { ".": { "import": "./dist/index.js" } } }`,
      "packages/ui/src/index.ts": "",
      "app/main.ts": "",
    });

    expect(resolveImport(snap, "app/main.ts", "@acme/ui").target).toEqual({ kind: "file", path: "packages/ui/src/index.ts" });
  });

  it("reports a bare package name as a package and drops builtins", () => {
    const snap = repo({ "src/a.ts": "" });

    expect(resolveImport(snap, "src/a.ts", "react").target).toEqual({ kind: "package", name: "react" });
    expect(resolveImport(snap, "src/a.ts", "@scope/tool/sub").target).toEqual({ kind: "package", name: "@scope/tool" });
    expect(resolveImport(snap, "src/a.ts", "node:fs").target).toBeUndefined();
    expect(resolveImport(snap, "src/a.ts", "fs").target).toBeUndefined();
  });
});

describe("regressions from review", () => {
  it("uses the nearest tsconfig even when it sets no aliases", () => {
    const snap = repo({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"] } } }`,
      "packages/web/tsconfig.json": `{ "compilerOptions": { "strict": true } }`,
      "packages/web/src/a.ts": "",
      "src/app/x.ts": "",
    });

    expect(resolveImport(snap, "packages/web/src/a.ts", "@app/x").target).toEqual({ kind: "package", name: "@app/x" });
  });

  it("maps a child's own paths onto a baseUrl inherited from its parent", () => {
    const snap = repo({
      "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": "src" } }`,
      "web/tsconfig.json": `{ "extends": "../tsconfig.base.json", "compilerOptions": { "paths": { "ui/*": ["ui/*"] } } }`,
      "web/main.ts": "",
      "src/ui/button.ts": "",
    });

    expect(resolveImport(snap, "web/main.ts", "ui/button").target).toEqual({ kind: "file", path: "src/ui/button.ts" });
  });

  it("follows an extends target that is not named like a config file", () => {
    const snap = repo({
      "configs/base.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"] } } }`,
      "tsconfig.json": `{ "extends": "./configs/base.json" }`,
      "src/a.ts": "",
      "configs/lib/x.ts": "",
    });

    // baseUrl "." is relative to the extended file, so the target is under configs/.
    expect(resolveImport(snap, "src/a.ts", "@lib/x").target).toEqual({ kind: "file", path: "configs/lib/x.ts" });
  });

  it("maps a declaration entry in dist back to its source file", () => {
    const snap = repo({
      "package.json": `{ "name": "root", "workspaces": ["packages/*"] }`,
      "packages/ui/package.json": `{ "name": "@acme/ui", "types": "./dist/index.d.ts" }`,
      "packages/ui/src/index.ts": "",
      "app/main.ts": "",
    });

    expect(resolveImport(snap, "app/main.ts", "@acme/ui").target).toEqual({ kind: "file", path: "packages/ui/src/index.ts" });
  });

  it("matches workspace globs ending in /**", () => {
    const snap = repo({
      "package.json": `{ "name": "root", "workspaces": ["packages/**"] }`,
      "packages/group/ui/package.json": `{ "name": "@acme/deep" }`,
      "packages/group/ui/index.ts": "",
      "app/main.ts": "",
    });

    expect(resolveImport(snap, "app/main.ts", "@acme/deep").target).toEqual({ kind: "file", path: "packages/group/ui/index.ts" });
  });
});
