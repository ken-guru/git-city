import { describe, expect, it } from "vitest";
import { createSnapshot, resolveImport } from "../src/cli/imports/resolve.js";

/**
 * Seam under test: `resolveImport(snapshot, fromPath, specifier, member?)` for a `.py` importer, observed through the
 * target it returns (a repo file, a package name, or nothing). Expected values are literals written from the
 * Python import rules in SPEC §4.
 */

/** Resolves against a commit whose files are the keys of `files`. Source files need no text. */
function resolveIn(files: Record<string, string>, from: string, specifier: string, member?: string) {
  return resolveImport(createSnapshot(Object.fromEntries(Object.keys(files).map((p) => [p, files[p] ?? ""]))), from, specifier, member);
}

const file = (path: string) => ({ kind: "file", path }) as const;

describe("Python relative imports", () => {
  it("resolves a leading-dot module beside the importer", () => {
    const files = { "app/sub/main.py": "", "app/sub/y.py": "" };
    expect(resolveIn(files, "app/sub/main.py", ".y").target).toEqual(file("app/sub/y.py"));
  });

  it("resolves `from . import x` to a submodule, or to the package when x is not a module", () => {
    const withSub = { "app/sub/main.py": "", "app/sub/x.py": "", "app/sub/__init__.py": "" };
    const withoutSub = { "app/sub/main.py": "", "app/sub/__init__.py": "" };

    expect(resolveIn(withSub, "app/sub/main.py", ".", "x").target).toEqual(file("app/sub/x.py"));
    expect(resolveIn(withoutSub, "app/sub/main.py", ".", "x").target).toEqual(file("app/sub/__init__.py"));
  });

  it("climbs one package per extra dot", () => {
    const files = { "app/sub/main.py": "", "app/pkg/mod.py": "" };
    expect(resolveIn(files, "app/sub/main.py", "..pkg.mod").target).toEqual(file("app/pkg/mod.py"));
  });

  it("resolves relative to a package's own __init__.py", () => {
    const files = { "app/__init__.py": "", "app/core.py": "" };
    expect(resolveIn(files, "app/__init__.py", ".core").target).toEqual(file("app/core.py"));
  });
});

describe("Python absolute imports", () => {
  it("resolves under the repository root", () => {
    const files = { "app/main.py": "", "lib/util.py": "" };
    expect(resolveIn(files, "app/main.py", "lib.util").target).toEqual(file("lib/util.py"));
  });

  it("resolves a package's __init__.py", () => {
    const files = { "app/main.py": "", "lib/util/__init__.py": "" };
    expect(resolveIn(files, "app/main.py", "lib.util").target).toEqual(file("lib/util/__init__.py"));
  });

  it("resolves under src/", () => {
    const files = { "tests/test_core.py": "", "src/pkg/core.py": "" };
    expect(resolveIn(files, "tests/test_core.py", "pkg.core").target).toEqual(file("src/pkg/core.py"));
  });

  it("resolves under the directory of a pyproject.toml", () => {
    const files = {
      "services/api/pyproject.toml": "[project]\nname = 'api'\n",
      "services/api/app/models.py": "",
      "services/api/tests/test_models.py": "",
    };
    expect(resolveIn(files, "services/api/tests/test_models.py", "app.models").target).toEqual(file("services/api/app/models.py"));
  });

  it("resolves under a source root declared in pyproject.toml", () => {
    const files = {
      "pyproject.toml": "[tool.pytest.ini_options]\npythonpath = [\n  \"lib\",\n]\n",
      "app/main.py": "",
      "lib/shared/x.py": "",
    };
    expect(resolveIn(files, "app/main.py", "shared.x").target).toEqual(file("lib/shared/x.py"));
  });

  it("resolves a PEP 420 namespace package, whose directory has no __init__.py", () => {
    const files = { "app/main.py": "", "ns/mod.py": "" };
    expect(resolveIn(files, "app/main.py", "ns.mod").target).toEqual(file("ns/mod.py"));
  });

  it("prefers a file in the repo over a standard-library name it shadows", () => {
    const files = { "app/main.py": "", "json.py": "" };
    expect(resolveIn(files, "app/main.py", "json").target).toEqual(file("json.py"));
  });
});

describe("Python from-imports", () => {
  it("resolves `from a import submodule` to the submodule, not the package", () => {
    const files = { "app/main.py": "", "a/__init__.py": "", "a/submodule.py": "" };
    expect(resolveIn(files, "app/main.py", "a", "submodule").target).toEqual(file("a/submodule.py"));
  });

  it("resolves `from a import name` to the package when name is not a submodule", () => {
    const files = { "app/main.py": "", "a/__init__.py": "" };
    expect(resolveIn(files, "app/main.py", "a", "helper").target).toEqual(file("a/__init__.py"));
  });
});

describe("Python imports that are not Roads", () => {
  it("drops standard-library imports", () => {
    const files = { "app/main.py": "" };
    expect(resolveIn(files, "app/main.py", "os").target).toBeUndefined();
    expect(resolveIn(files, "app/main.py", "collections", "OrderedDict").target).toBeUndefined();
    expect(resolveIn(files, "app/main.py", "os.path").target).toBeUndefined();
  });

  it("treats a bare import of an in-repo namespace directory as internal, not a package", () => {
    const files = { "app/main.py": "", "ns/mod.py": "" };
    expect(resolveIn(files, "app/main.py", "ns").target).toBeUndefined();
  });

  it("still reports a bare import as a package when no Python file lies under it", () => {
    const files = { "app/main.py": "", "ns/data.json": "" };
    expect(resolveIn(files, "app/main.py", "ns").target).toEqual({ kind: "package", name: "ns" });
  });

  it("reports a third-party import as a package, named by its top-level module", () => {
    const files = { "app/main.py": "" };
    expect(resolveIn(files, "app/main.py", "requests.adapters").target).toEqual({ kind: "package", name: "requests" });
  });

  it("drops a relative import that climbs above the repository root", () => {
    expect(resolveIn({ "x.py": "" }, "x.py", "..x").target).toBeUndefined();
  });

  it("drops a relative import that names nothing in the commit", () => {
    expect(resolveIn({ "app/main.py": "" }, "app/main.py", ".missing").target).toBeUndefined();
  });
});
