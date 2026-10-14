import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  engines: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");

/** Grammar packages and the wasm file each one ships (the file copied into dist/grammars). */
const GRAMMARS = [
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  "tree-sitter-python/tree-sitter-python.wasm",
];
const GRAMMAR_PACKAGES = ["tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python"];

describe("package metadata", () => {
  it("publishes the git-city bin and the Node range", () => {
    expect(pkg.name).toBe("git-city");
    expect(pkg.bin).toEqual({ "git-city": "dist/cli/main.js" });
    expect(pkg.engines.node).toBe(">=22");
  });

  it("ships dist, the schema and the notices", () => {
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "THIRD_PARTY_NOTICES.md"]));
  });

  it("keeps three as a build-time dependency only", () => {
    expect(pkg.devDependencies?.three).toBeDefined();
    expect(pkg.dependencies?.three).toBeUndefined();
  });

  it("takes the grammars from their official packages as devDependencies", () => {
    for (const name of GRAMMAR_PACKAGES) {
      expect(pkg.devDependencies?.[name], name).toBeDefined();
      expect(pkg.dependencies?.[name], name).toBeUndefined();
    }
  });

  it("depends on web-tree-sitter at runtime", () => {
    expect(pkg.dependencies?.["web-tree-sitter"]).toBeDefined();
  });
});

describe("THIRD_PARTY_NOTICES.md", () => {
  it("covers three.js, web-tree-sitter and each grammar package", () => {
    expect(notices).toContain("three.js");
    expect(notices).toContain("web-tree-sitter");
    for (const name of GRAMMAR_PACKAGES) expect(notices).toContain(name);
  });
});

describe("npm pack contents (needs `npm run build` first)", () => {
  const files = (() => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
      cwd: new URL("..", import.meta.url).pathname,
    });
    // npm 7-10 print an array, npm 11+ print an object keyed by package name.
    const parsed = JSON.parse(out) as unknown;
    const entry = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]) as {
      files: { path: string }[];
    };
    return new Set(entry.files.map((f) => f.path));
  })();

  it("contains the CLI, the page and the notices", () => {
    expect(files.has("dist/cli/main.js")).toBe(true);
    expect(files.has("dist/page/index.html")).toBe(true);
    expect(files.has("THIRD_PARTY_NOTICES.md")).toBe(true);
  });

  it("contains exactly the grammar wasm files under dist/grammars", () => {
    for (const grammar of GRAMMARS) {
      expect(files.has(`dist/grammars/${grammar.split("/")[1]}`), grammar).toBe(true);
    }
  });

  it("does not ship three.js sources in the tarball beyond the page bundle", () => {
    const nodeModules = [...files].filter((p) => p.includes("node_modules/"));
    expect(nodeModules).toEqual([]);
  });
});
