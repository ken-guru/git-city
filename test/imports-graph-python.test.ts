import { describe, expect, it } from "vitest";
import { ImportGraph, type GraphCommit } from "../src/cli/imports/graph.js";
import { extractImports, extractorFor } from "../src/cli/imports/extract.js";

/**
 * Seam under test: `ImportGraph` fed Python files one commit at a time (writes with the specifiers the facts layer
 * would hold), observed through `targetsOf`, `fanIn` and `packagesOf`. Expected values are literals written from the
 * sources below.
 */

class Repo {
  private nextBlob = 0;
  private readonly blobs = new Map<string, string>();
  readonly graph = new ImportGraph({ readText: async (blob) => this.blobs.get(blob) ?? "" });

  async commit(writes: Record<string, string>, deleted: string[] = []): Promise<void> {
    const commit: GraphCommit = { writes: [], deleted };
    for (const [path, text] of Object.entries(writes)) {
      const blob = `b${this.nextBlob++}`;
      this.blobs.set(blob, text);
      const specifiers = extractorFor(path) ? await extractImports(path, text) : undefined;
      commit.writes.push({ path, blob, specifiers });
    }
    await this.graph.apply(commit);
  }
}

describe("Python imports in the graph", () => {
  it("resolves a `from pkg import module` edge once the module arrives", async () => {
    const repo = new Repo();
    await repo.commit({ "app/main.py": "from lib import util\n" });
    expect(repo.graph.targetsOf("app/main.py")).toEqual([]);

    await repo.commit({ "lib/util.py": "" });

    expect(repo.graph.targetsOf("app/main.py")).toEqual(["lib/util.py"]);
    expect(repo.graph.fanIn("lib/util.py")).toBe(1);
  });

  it("counts distinct Python importers of a module as its fan-in", async () => {
    const repo = new Repo();
    await repo.commit({
      "core/models.py": "",
      "app/a.py": "import core.models\n",
      "app/b.py": "from core import models\nfrom . import helpers\n",
      "app/helpers.py": "",
    });

    expect(repo.graph.fanIn("core/models.py")).toBe(2);
    expect(repo.graph.targetsOf("app/b.py")).toEqual(["app/helpers.py", "core/models.py"]);
  });

  it("drops standard-library imports and records third-party ones as packages", async () => {
    const repo = new Repo();
    await repo.commit({ "app/main.py": "import os\nfrom collections import OrderedDict\nimport requests\n" });

    expect(repo.graph.targetsOf("app/main.py")).toEqual([]);
    expect(repo.graph.packagesOf("app/main.py")).toEqual(["requests"]);
  });

  it("treats a bare import of a namespace directory as internal until its last Python file goes", async () => {
    const repo = new Repo();
    await repo.commit({ "app/main.py": "import ns\nimport requests\n", "ns/mod.py": "" });

    expect(repo.graph.packagesOf("app/main.py")).toEqual(["requests"]);

    await repo.commit({}, ["ns/mod.py"]);

    expect(repo.graph.packagesOf("app/main.py")).toEqual(["ns", "requests"]);

    await repo.commit({ "ns/other.py": "" });

    expect(repo.graph.packagesOf("app/main.py")).toEqual(["requests"]);
  });

  it("re-resolves an absolute import when a pyproject.toml gives its source root", async () => {
    const repo = new Repo();
    await repo.commit({
      "services/api/app/models.py": "",
      "services/api/tests/test_models.py": "import app.models\n",
    });
    expect(repo.graph.targetsOf("services/api/tests/test_models.py")).toEqual([]);

    await repo.commit({ "services/api/pyproject.toml": "[project]\nname = 'api'\n" });

    expect(repo.graph.targetsOf("services/api/tests/test_models.py")).toEqual(["services/api/app/models.py"]);
    expect(repo.graph.packagesOf("services/api/tests/test_models.py")).toEqual([]);
  });
});
