import { describe, expect, it } from "vitest";
import { ImportGraph, type GraphCommit, type GraphSnapshot, widthStepFor } from "../src/cli/imports/graph.js";
import { extractImports, extractorFor } from "../src/cli/imports/extract.js";

/**
 * Seams under test: `ImportGraph` fed one commit at a time (writes with the specifiers the facts layer holds,
 * and deletions), observed through its queries, its touched targets and its snapshot; and `widthStepFor`.
 * Expected values are literals written from the sources below.
 */

/** Drives a graph with commits given as file maps. `blobs` holds each blob's text by blob ID. */
class Repo {
  nextBlob = 0;
  readonly graph: ImportGraph;

  constructor(
    private readonly blobs = new Map<string, string>(),
    snapshot?: GraphSnapshot,
  ) {
    const options = { readText: async (blob: string) => this.blobs.get(blob) ?? "" };
    this.graph = snapshot ? ImportGraph.restore(options, snapshot) : new ImportGraph(options);
  }

  /** A repo that resumes from a JSON round trip of this one's snapshot, sharing its blobs. */
  fork(): Repo {
    const copy = new Repo(this.blobs, JSON.parse(JSON.stringify(this.graph.snapshot())) as GraphSnapshot);
    copy.nextBlob = this.nextBlob;
    return copy;
  }

  async commit(writes: Record<string, string>, deleted: string[] = []): Promise<Set<string>> {
    const commit: GraphCommit = { writes: [], deleted };
    for (const [path, text] of Object.entries(writes)) {
      const blob = `b${this.nextBlob++}`;
      this.blobs.set(blob, text);
      const specifiers = extractorFor(path) ? await extractImports(path, text) : undefined;
      commit.writes.push({ path, blob, specifiers });
    }
    return this.graph.apply(commit);
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

  it("returns the targets whose fan-in a commit changed", async () => {
    const repo = new Repo();
    await repo.commit({ "src/shared.ts": "", "src/other.ts": "" });

    const touched = await repo.commit({ "src/a.ts": `import "./shared";` });

    expect([...touched]).toEqual(["src/shared.ts"]);
  });

  it("resumes from a snapshot exactly as a run that never stopped", async () => {
    const repo = new Repo();
    await repo.commit({ "src/a.ts": `import "./later";`, "src/x.ts": `import "./a";` });
    const resumed = repo.fork();

    await repo.commit({ "src/later.ts": "", "src/y.ts": `import "./later";` });
    await resumed.commit({ "src/later.ts": "", "src/y.ts": `import "./later";` });

    expect(resumed.graph.targetsOf("src/a.ts")).toEqual(["src/later.ts"]);
    expect(resumed.graph.fanIn("src/later.ts")).toBe(2);
    expect(resumed.graph.targetsOf("src/a.ts")).toEqual(repo.graph.targetsOf("src/a.ts"));
    expect(resumed.graph.fanIn("src/later.ts")).toBe(repo.graph.fanIn("src/later.ts"));
    expect(resumed.graph.districtLinks((p) => p.split("/")[0]!)).toEqual(repo.graph.districtLinks((p) => p.split("/")[0]!));
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
