// Builds the viewer into dist/page/: index.html plus one content-hashed bundle.
// three.js is bundled here at package time; the CLI only copies the result.
import { build } from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const outDir = new URL("../dist/page/", import.meta.url);
await rm(outDir, { recursive: true, force: true });

const result = await build({
  entryPoints: [new URL("../src/page/main.ts", import.meta.url).pathname],
  outdir: new URL("assets/", outDir).pathname,
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
const html = await readFile(new URL("../src/page/index.html", import.meta.url), "utf8");
await writeFile(new URL("index.html", outDir), html.replace("%PAGE_SCRIPT%", `assets/${basename(script)}`));
