import { describe, expect, it } from "vitest";
import { ExternalRegistry } from "../src/cli/imports/externals.js";
import { ImportGraph } from "../src/cli/imports/graph.js";

/**
 * Seam under test: the per-commit fold of manifests (SPEC §4, §7). The graph reports the declarations each commit added
 * and removed; the registry dates an External City from promotion (its distinct members reaching the threshold) until
 * its last member is removed, and keeps a Highway span per declaration.
 * Expected commit numbers are the 0-based commit indices written in each step below.
 */

const blobs = new Map<string, string>();
const graphFor = () => new ImportGraph({ readText: async (blob) => blobs.get(blob) ?? "" });
const manifest = (deps: string[]) => JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "1"])) });

async function step(graph: ImportGraph, registry: ExternalRegistry, commit: number, writes: [string, string[]][], deleted: string[] = []) {
  await graph.apply({
    writes: writes.map(([path, deps]) => {
      const blob = `${path}@${commit}`;
      blobs.set(blob, manifest(deps));
      return { path, blob };
    }),
    deleted,
  });
  const changes = graph.takeDeclarationChanges();
  for (const d of changes.removed) registry.undeclare(commit, d);
  for (const d of changes.added) registry.declare(commit, d);
}

describe("External Cities over history", () => {
  it("dates promotion to the commit the third member is declared, and departure to the commit the last one is removed", async () => {
    const graph = graphFor();
    const registry = new ExternalRegistry();
    await step(graph, registry, 0, [["package.json", ["@babel/core"]]]);
    await step(graph, registry, 1, [["package.json", ["@babel/core", "@babel/cli"]]]);
    expect(registry.promotedAt("babel")).toBeUndefined();
    await step(graph, registry, 2, [["package.json", ["@babel/core", "@babel/cli", "babel-loader"]]]);
    expect(registry.promotedAt("babel")).toBe(2);

    await step(graph, registry, 3, [["package.json", ["@babel/core", "babel-loader"]]]);
    expect(registry.presenceOf()[0]!.to).toBeUndefined();
    expect(registry.presenceOf()[0]).toMatchObject({ key: "babel", from: 2 });

    await step(graph, registry, 4, [["package.json", []]]);
    expect(registry.presenceOf()[0]).toMatchObject({ key: "babel", from: 2, to: 4 });
  });

  it("keeps the members a manifest has dropped, so the group's distinct count does not shrink", async () => {
    const graph = graphFor();
    const registry = new ExternalRegistry();
    await step(graph, registry, 0, [["package.json", ["@babel/core", "@babel/cli", "babel-loader"]]]);
    await step(graph, registry, 1, [["package.json", ["@babel/core"]]]);
    expect(registry.plan().cities[0]!.members).toHaveLength(3);
  });

  it("reports nothing for a rewrite that declares the same dependencies", async () => {
    const graph = graphFor();
    blobs.set("a", manifest(["react"]));
    blobs.set("b", manifest(["react"]));
    await graph.apply({ writes: [{ path: "web/package.json", blob: "a" }], deleted: [] });
    graph.takeDeclarationChanges();
    await graph.apply({ writes: [{ path: "web/package.json", blob: "b" }], deleted: [] });
    expect(graph.takeDeclarationChanges()).toEqual({ added: [], removed: [] });
  });

  it("gives a Highway span per declaring manifest, closed when the manifest drops the dependency", async () => {
    const graph = graphFor();
    const registry = new ExternalRegistry();
    await step(graph, registry, 0, [["web/package.json", ["react"]], ["package.json", ["react"]]]);
    await step(graph, registry, 1, [["web/package.json", []]]);
    const spans = registry.spansOf().map((s) => [s.manifest, s.from, s.to]);
    expect(spans).toEqual([
      ["web", 0, 1],
      ["", 0, undefined],
    ]);
  });

  it("removes a deleted manifest's declarations", async () => {
    const graph = graphFor();
    const registry = new ExternalRegistry();
    await step(graph, registry, 0, [["api/package.json", ["left-pad"]]]);
    await step(graph, registry, 1, [], ["api/package.json"]);
    expect(registry.currentlyDeclared()).toEqual([]);
  });

  it("keeps the same history after a snapshot and restore", async () => {
    const graph = graphFor();
    const registry = new ExternalRegistry();
    await step(graph, registry, 0, [["package.json", ["@babel/core", "@babel/cli", "babel-loader"]]]);
    const copy = ExternalRegistry.restore({}, JSON.parse(JSON.stringify(registry.snapshot())));
    expect(copy.promotedAt("babel")).toBe(0);
    expect(copy.currentlyDeclared()).toHaveLength(3);
  });
});
