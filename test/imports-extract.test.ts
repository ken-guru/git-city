import { describe, expect, it } from "vitest";
import { ImportCache, type RawImport, extractorFor, extractImports } from "../src/cli/imports/extract.js";

/**
 * Seam under test: `extractImports(path, source)` from the import extractor module, observed only through
 * the specifiers and kind flags it returns. Expected values are literals written from the source below.
 */

const sorted = (imports: RawImport[]) =>
  [...imports].sort((a, b) => (a.specifier + a.kind).localeCompare(b.specifier + b.kind));

describe("TS/JS import extraction", () => {
  it("finds static imports, type-only imports and re-exports with their kind flags", async () => {
    const source = [
      `import a from "./a";`,
      `import { b } from "./b.js";`,
      `import type { C } from "./c";`,
      `import type D from "./d";`,
      `export * from "./e";`,
      `export { f } from "./f";`,
      `export type { G } from "./g";`,
    ].join("\n");

    const found = await extractImports("src/index.ts", source);

    expect(sorted(found)).toEqual(
      sorted([
        { specifier: "./a", kind: "static" },
        { specifier: "./b.js", kind: "static" },
        { specifier: "./c", kind: "type" },
        { specifier: "./d", kind: "type" },
        { specifier: "./e", kind: "reexport" },
        { specifier: "./f", kind: "reexport" },
        { specifier: "./g", kind: "type" },
      ]),
    );
  });

  it("finds dynamic imports, require calls and import-equals requires", async () => {
    const source = [
      `const lazy = () => import("./lazy");`,
      `const cjs = require("./cjs");`,
      `import legacy = require("./legacy");`,
    ].join("\n");

    const found = await extractImports("src/loader.ts", source);

    expect(sorted(found)).toEqual(
      sorted([
        { specifier: "./lazy", kind: "dynamic" },
        { specifier: "./cjs", kind: "require" },
        { specifier: "./legacy", kind: "require" },
      ]),
    );
  });

  it("parses TSX and plain JS with the matching grammar, ignoring non-literal specifiers", async () => {
    const tsx = `import Button from "../ui/Button";\nconst C = () => <Button />;\nconst x = require(name);`;
    const js = `import fs from "node:fs";\nexport default function go() { return import(path); }`;

    expect(sorted(await extractImports("web/App.tsx", tsx))).toEqual([{ specifier: "../ui/Button", kind: "static" }]);
    expect(sorted(await extractImports("lib/go.mjs", js))).toEqual([{ specifier: "node:fs", kind: "static" }]);
  });

  it("returns nothing for a file in a language it does not handle", async () => {
    expect(extractorFor("README.md")).toBeUndefined();
    expect(await extractImports("README.md", `import x from "./y";`)).toEqual([]);
  });

  it("caches results by blob ID and extractor version, so an unchanged blob is parsed once", async () => {
    const cache = new ImportCache();
    const source = `import a from "./a";`;

    const first = await cache.get("blob-1", "src/x.ts", source);
    const again = await cache.get("blob-1", "src/x.ts", "this text is never read");

    expect(again).toBe(first);
    expect(first).toEqual([{ specifier: "./a", kind: "static" }]);
  });
});
