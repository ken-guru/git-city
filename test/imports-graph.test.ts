import { describe, expect, it } from "vitest";
import { ImportGraph, type GraphCommit, widthStepFor } from "../src/cli/imports/graph.js";

/**
 * Seams under test: `ImportGraph` fed one commit at a time (writes and deletions, with blob text read through
 * an injected function), observed through its queries; and `widthStepFor`, the fan-in thresholds.
 * Expected values are literals written from the sources below.
 */

/** Drives a graph with commits given as file maps. `blobs` holds each blob's text by blob ID. */
class Repo {
  private readonly blobs = new Map<string, string>();
  private nextBlob = 0;
  readonly graph: ImportGraph;

  constructor() {
    this.graph = new ImportGraph({ readText: async (blob) => this.blobs.get(blob) ?? "" });
  }

  async commit(writes: Record<string, string>, deleted: string[] = []): Promise<void> {
    const commit: GraphCommit = { writes: [], deleted };
    for (const [path, text] of Object.entries(writes)) {
      const blob = `b${this.nextBlob++}`;
      this.blobs.set(blob, text);
      commit.writes.push({ path, blob });
    }
    await this.graph.apply(commit);
  }
}

describe("fan-in and width steps", () => {
  it("steps the width at fan-in 3, 10 and 30", () => {
    expect([0, 2, 3, 9, 10, 29, 30, 500].map(widthStepFor)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("counts distinct internal importers of a file", async () => {
    const repo = new Repo();
    await repo.commit({
      "src/shared.ts": "",
      "src/a.ts": `import "./shared";`,
      "src/b.ts": `import "./shared";\nimport "./shared";`,
    });

    expect(repo.graph.fanIn("src/shared.ts")).toBe(2);
    expect(repo.graph.fanIn("src/a.ts")).toBe(0);
  });
});

describe("incremental resolution", () => {
  it("resolves an import once its missing target arrives", async () => {
    const repo = new Repo();
    await repo.commit({ "src/a.ts": `import "./later";` });
    expect(repo.graph.targetsOf("src/a.ts")).toEqual([]);

    await repo.commit({ "src/later.ts": "" });

    expect(repo.graph.targetsOf("src/a.ts")).toEqual(["src/later.ts"]);
    expect(repo.graph.fanIn("src/later.ts")).toBe(1);
  });

  it("drops an edge when its target is deleted, and restores it when the target returns", async () => {
    const repo = new Repo();
    await repo.commit({ "src/a.ts": `import "./b";`, "src/b.ts": "" });

    await repo.commit({}, ["src/b.ts"]);
    expect(repo.graph.fanIn("src/b.ts")).toBe(0);
    expect(repo.graph.targetsOf("src/a.ts")).toEqual([]);

    await repo.commit({ "src/b.ts": "" });
    expect(repo.graph.targetsOf("src/a.ts")).toEqual(["src/b.ts"]);
  });

  it("replaces a rewritten file's imports", async () => {
    const repo = new Repo();
    await repo.commit({ "src/a.ts": `import "./b";`, "src/b.ts": "", "src/c.ts": "" });

    await repo.commit({ "src/a.ts": `import "./c";` });

    expect(repo.graph.fanIn("src/b.ts")).toBe(0);
    expect(repo.graph.fanIn("src/c.ts")).toBe(1);
  });

  it("re-resolves every importer when a tsconfig changes", async () => {
    const repo = new Repo();
    await repo.commit({ "src/a.ts": `import "@app/x";`, "src/app/x.ts": "" });
    expect(repo.graph.packagesOf("src/a.ts")).toEqual(["@app/x"]);

    await repo.commit({
      "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"] } } }`,
    });

    expect(repo.graph.targetsOf("src/a.ts")).toEqual(["src/app/x.ts"]);
    expect(repo.graph.packagesOf("src/a.ts")).toEqual([]);
  });

  it("aggregates file edges into District-to-District links, counting edges per direction", async () => {
    const repo = new Repo();
    await repo.commit({
      "app/main.ts": `import "../lib/one";\nimport "../lib/two";`,
      "app/other.ts": `import "../lib/one";`,
      "lib/one.ts": `import "./two";`,
      "lib/two.ts": "",
    });

    const links = repo.graph.districtLinks((path) => path.split("/")[0]!);

    expect(links).toEqual(
      expect.arrayContaining([
        { from: "app", to: "lib", strength: 3 },
        { from: "lib", to: "lib", strength: 1 },
      ]),
    );
    expect(links).toHaveLength(2);
  });
});
