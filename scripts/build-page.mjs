// Builds the viewer into dist/page/: index.html plus one content-hashed bundle.
// three.js is bundled here at package time; the CLI only copies the result.
import { build } from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// Paths go through fileURLToPath: a URL's path form on Windows is "/D:/...", which esbuild cannot resolve.
const outDir = fileURLToPath(new URL("../dist/page/", import.meta.url));
const assetsDir = fileURLToPath(new URL("../dist/page/assets/", import.meta.url));
const entry = fileURLToPath(new URL("../src/page/main.ts", import.meta.url));
const template = fileURLToPath(new URL("../src/page/index.html", import.meta.url));
const indexPath = fileURLToPath(new URL("../dist/page/index.html", import.meta.url));

await rm(outDir, { recursive: true, force: true });

const result = await build({
  entryPoints: [entry],
  outdir: assetsDir,
  entryNames: "page.[hash]",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "eof", // keeps the three.js MIT notice in the bundle
  metafile: true,
  logLevel: "warning",
});

const [script] = Object.keys(result.metafile.outputs).filter((path) => path.endsWith(".js"));
const html = await readFile(template, "utf8");
await writeFile(indexPath, html.replace("%PAGE_SCRIPT%", `assets/${basename(script)}`));
