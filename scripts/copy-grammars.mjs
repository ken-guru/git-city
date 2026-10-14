// Copies the grammar .wasm files from the official per-language packages into dist/grammars/.
// Only the wasm is shipped (SPEC §12); the CLI loads them with web-tree-sitter.
import { copyFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";

const grammars = [
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  "tree-sitter-python/tree-sitter-python.wasm",
];

const outDir = new URL("../dist/grammars/", import.meta.url);
await mkdir(outDir, { recursive: true });
for (const grammar of grammars) {
  // A missing package or file throws here, so a broken install fails the build.
  await copyFile(new URL(`../node_modules/${grammar}`, import.meta.url), new URL(basename(grammar), outDir));
}
