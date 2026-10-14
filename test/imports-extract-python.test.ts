import { describe, expect, it } from "vitest";
import { type RawImport, extractImports, extractorFor } from "../src/cli/imports/extract.js";

/**
 * Seam under test: `extractImports(path, source)` for a `.py` file, observed through the specifiers, kind flags
 * and `member` names it returns. Expected values are literals written from the source below.
 */

const sorted = (imports: RawImport[]) =>
  [...imports].sort((a, b) => (a.specifier + (a.member ?? "") + a.kind).localeCompare(b.specifier + (b.member ?? "") + b.kind));

describe("Python import extraction", () => {
  it("claims .py files", () => {
    expect(extractorFor("pkg/mod.py")?.name).toBe("python");
  });

  it("finds plain and dotted imports, with aliases", async () => {
    const source = ["import os", "import a.b.c as c", "import x, y.z"].join("\n");

    expect(sorted(await extractImports("app/main.py", source))).toEqual(
      sorted([
        { specifier: "os", kind: "static" },
        { specifier: "a.b.c", kind: "static" },
        { specifier: "x", kind: "static" },
        { specifier: "y.z", kind: "static" },
      ]),
    );
  });

  it("emits one entry per name for from-imports, and the module alone for a wildcard", async () => {
    const source = ["from a import b, c as d", "from a.sub import *", "from a import (e,\n  f)"].join("\n");

    expect(sorted(await extractImports("app/main.py", source))).toEqual(
      sorted([
        { specifier: "a", member: "b", kind: "static" },
        { specifier: "a", member: "c", kind: "static" },
        { specifier: "a.sub", kind: "static" },
        { specifier: "a", member: "e", kind: "static" },
        { specifier: "a", member: "f", kind: "static" },
      ]),
    );
  });

  it("keeps the leading dots of relative imports", async () => {
    const source = ["from . import x", "from .y import z", "from ..pkg.mod import w"].join("\n");

    expect(sorted(await extractImports("app/sub/main.py", source))).toEqual(
      sorted([
        { specifier: ".", member: "x", kind: "static" },
        { specifier: ".y", member: "z", kind: "static" },
        { specifier: "..pkg.mod", member: "w", kind: "static" },
      ]),
    );
  });

  it("drops __future__ imports", async () => {
    expect(await extractImports("app/main.py", "from __future__ import annotations")).toEqual([]);
  });

  it("marks imports under `if TYPE_CHECKING:` as type-only", async () => {
    const source = ["from typing import TYPE_CHECKING", "if TYPE_CHECKING:", "    import heavy", "import plain"].join("\n");

    expect(sorted(await extractImports("app/main.py", source))).toEqual(
      sorted([
        { specifier: "typing", member: "TYPE_CHECKING", kind: "static" },
        { specifier: "heavy", kind: "type" },
        { specifier: "plain", kind: "static" },
      ]),
    );
  });

  it("finds literal importlib.import_module and __import__ calls as dynamic, skipping non-literal ones", async () => {
    const source = [`m = importlib.import_module("foo.bar")`, `n = __import__("baz")`, `p = importlib.import_module(name)`].join("\n");

    expect(sorted(await extractImports("app/main.py", source))).toEqual(
      sorted([
        { specifier: "foo.bar", kind: "dynamic" },
        { specifier: "baz", kind: "dynamic" },
      ]),
    );
  });
});
