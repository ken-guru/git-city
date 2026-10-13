# Packaging and distributing the `git-city` CLI

Researched 2026-10-13. Registry and tarball data was fetched live on that date. Measurements were taken locally with Node v24.21.0, npm, and esbuild.

## Answer

- **Name:** `git-city` is **free on npm** (the registry returns 404). So are `gitcity`, `git-city-cli`, `gitcity-cli`, `@git-city/cli` and `@ken-guru/git-city`. A registry search for "git-city" finds no similar package. Publish the unscoped name `git-city` with `bin: { "git-city": ... }`. That makes `npx git-city` and `git city` work without a scope. Fallback: `@ken-guru/git-city` with the bin still named `git-city`. I could not check whether the `@git-city` npm org is free, because npmjs.com was unreachable from this sandbox.
- **Node minimum:** set `"engines": { "node": ">=22" }` and test on 22, 24 and 26. web-tree-sitter 0.27.1 and three 0.186.1 declare no `engines`. web-tree-sitter's Emscripten loader only rejects Node versions below 16. Node 20 reached end of life on 2026-04-30. Node 22 is in maintenance until 2027-04-30. Node 24 moves to maintenance on 2026-10-20. Node 26 becomes LTS on 2026-10-28. three is only needed at build time if the page is pre-bundled.
- **Page bundle:** pre-build the viewer with esbuild/Vite into `dist/page/` inside the package and list `dist` in `files`. At runtime, resolve it with `new URL('../page/', import.meta.url)` and copy it with `fs.promises.cp(src, out, { recursive: true })` (stable since Node 22.3). Then write the data file next to it. Neither three nor web-tree-sitter needs to be a runtime dependency.
- **Size:** the twelve grammars I tested (TS, TSX, JS, Python, Go, Rust, Java, C#, Ruby, PHP, C, C++) come to **18.0 MB of .wasm on disk** but only **about 1.56 MB gzipped** in the npm tarball. Add the web-tree-sitter runtime (0.37 MB if vendored, 4.7 MB as a dependency) and the page bundle (about 0.56 MB minified, 0.14 MB gzipped). Expected totals: **about 19–24 MB installed, about 2–3 MB download**. C# (5.35 MB), C++ (3.43 MB) and Ruby (2.1 MB) are the largest grammars.
- **Which grammar source to use:** do **not** use `tree-sitter-wasms`. Every one of its grammars failed to load in web-tree-sitter 0.27.1 (`getDylinkMetadata` error: the old dynamic-linking format). The `.wasm` files in the official per-language npm packages all load. So do `@vscode/tree-sitter-wasm`'s, but that package has no C grammar. The per-language packages run a `node-gyp-build` install script, so make them devDependencies and copy their `.wasm` files into `dist/grammars/` at build time.
- **Generated output:** it ships **no grammars and no web-tree-sitter**, because parsing happens in the CLI. The output holds only the page bundle (three.js plus viewer code) and data.
- **`npx git-city`:** works, because npm runs the single bin. **`git city`** works once the package is installed globally (`npm i -g git-city`), because git runs `git-<name>` from `PATH`. It does **not** work after a plain `npx git-city`, because the npx bin directory is only on the `PATH` of that one child process. `npx -p git-city git city` does work. Note that `git city --help` becomes `git help city`, which looks for a man page; `-h` reaches the CLI.
- **Windows:** Git for Windows looks for `git-city.exe` and then an extensionless `git-city` file with a `#!` line. It ignores `.cmd` and `.ps1`. npm's cmd-shim writes an extensionless `#!/bin/sh` shim, so `git city` should work. I have not tested this on a real Windows machine.
- **Licences:** three.js, web-tree-sitter, every per-language grammar package and `@vscode/tree-sitter-wasm` are MIT. `tree-sitter-wasms` is Unlicense, but its grammars are MIT underneath. The generated page must carry the **three.js MIT notice** (esbuild keeps it automatically in an end-of-file "Bundled license information" comment). Add a `THIRD_PARTY_NOTICES` file or a credits link as well. The CLI package must include the MIT notices for web-tree-sitter and each vendored grammar.

---

## 1. npm name availability

Checked against `https://registry.npmjs.org/<name>` on 2026-10-13:

| Name | Status |
|---|---|
| `git-city` | 404, available |
| `gitcity` | 404, available |
| `git-city-cli` | 404, available |
| `gitcity-cli` | 404, available |
| `git-city-3d` | 404, available |
| `@git-city/cli` | 404 (no package; I could not check whether the org exists) |
| `@ken-guru/git-city` | 404, available |

Searching the registry (`/-/v1/search?text=git-city`) returned only unrelated packages (`country-state-city`, `@builder.io/qwik-city`, `hosted-git-info`, …). No existing name differs from ours only by punctuation, so npm's typo-squatting check should not block `git-city`.

**Recommendation:** publish as `git-city` and register it early with a 0.0.x placeholder if the launch is far off. A scope only adds value if the project wants an org namespace (for example `@git-city/themes` later). The bin name, not the package name, is what makes `git city` work, so a scoped package can still provide `bin: { "git-city": "dist/cli.js" }`. The catch is that `npx @ken-guru/git-city` is longer to type.

## 2. Runtime requirements and Node minimum

| Package (latest, 2026-10-13) | `engines` | Notes |
|---|---|---|
| `web-tree-sitter@0.27.1` (registry modified 2026-10-08) | none | ESM plus CJS builds. Uses `import.meta.url`, `createRequire`, and dynamic `import("fs/promises")`. Its Emscripten loader throws `requires node v16.0.0` below Node 16. It supports parser ABI 13–15. |
| `three@0.186.1` (registry modified 2026-09-24) | none | ESM-only. `build/three.cjs` is now a deprecation stub that calls `require('./three.module.js')` (require(esm)), so `require('three')` needs Node 20.19+ or 22.12+. This does not matter if three is only bundled into the page at build time. |

Node release schedule (nodejs/Release `schedule.json`):

| Line | LTS from | Maintenance from | End of life |
|---|---|---|---|
| 20 | 2023-10-24 | 2024-10-22 | **2026-04-30 (EOL)** |
| 22 | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| 24 | 2025-10-28 | 2026-10-20 | 2028-04-30 |
| 26 | 2026-10-28 | 2027-10-20 | 2029-04-30 |

**Recommendation:** `"engines": { "node": ">=22" }`. This is the oldest line still supported, and it covers `fs.cp` (stable since 22.3.0), `import.meta.dirname` (since 20.11) and unflagged require(esm) (22.12). Run CI on 22, 24 and 26. Moving to `>=24` around April 2027, when 22 reaches end of life, is reasonable.

## 3. Shipping the prebuilt page bundle

The usual pattern is for a CLI to ship build artefacts in its own tarball and find them relative to its own module file. It does not use `require.resolve` on a dependency and does not assume a fixed install location. That works for global installs, local installs, the npx cache, and pnpm/yarn layouts.

Recommended layout:

```
git-city/
  package.json          # "type": "module", "bin": {"git-city": "dist/cli/index.js"},
                        # "files": ["dist", "THIRD_PARTY_NOTICES.md"], "engines": {"node": ">=22"}
  dist/
    cli/index.js        # bundled CLI (esbuild/tsup), starts with #!/usr/bin/env node
    cli/web-tree-sitter.wasm   # runtime wasm, copied from web-tree-sitter at build time
    grammars/*.wasm     # vendored grammar wasm (CLI only, never copied to the output)
    page/               # prebuilt viewer: index.html, assets/app-[hash].js (three bundled), styles
  THIRD_PARTY_NOTICES.md
```

Runtime copy:

```ts
import { cp, writeFile } from 'node:fs/promises';
const pageDir = new URL('../page/', import.meta.url);        // dist/cli -> dist/page
await cp(pageDir, outDir, { recursive: true });
await writeFile(join(outDir, 'city-data.js' /* or .json */), payload);
const grammar = (id: string) => new URL(`../grammars/tree-sitter-${id}.wasm`, import.meta.url);
// Parser.init({ locateFile: (n) => fileURLToPath(new URL(n, import.meta.url)) }) if web-tree-sitter is bundled
```

Notes:
- `files` is the allow-list that npm packs. Check it with `npm pack --dry-run`.
- If the page needs to work from `file://`, data loaded with `fetch()` of JSON is blocked by browsers. Writing data as a `<script>` (`window.__CITY__ = …`) or inlining it into `index.html` avoids that.
- Keep `three` and the grammar packages in `devDependencies`. Runtime `dependencies` can then be just the CLI's own libraries, or nothing if everything is bundled.
- If web-tree-sitter is bundled into the CLI, its `web-tree-sitter.wasm` must sit next to the bundle, or be pointed to with `locateFile` (as the README describes).

## 4. Size

### Grammar `.wasm` sizes (bytes on disk, measured from the tarballs on 2026-10-13)

| Grammar | Official per-language npm package (version) | `@vscode/tree-sitter-wasm@0.3.1` | `tree-sitter-wasms@0.1.13` (not loadable) |
|---|---|---|---|
| TypeScript | 1,413,849 (`tree-sitter-typescript@0.23.2`) | 1,413,849 | 2,342,690 |
| TSX | 1,445,638 (same package) | 1,445,638 | 2,411,272 |
| JavaScript | 411,770 (`tree-sitter-javascript@0.25.0`) | 411,770 | 647,334 |
| Python | 457,883 (`tree-sitter-python@0.25.0`) | 457,883 | 476,105 |
| Go | 217,182 (`tree-sitter-go@0.25.0`) | 217,182 | 235,957 |
| Rust | 1,102,547 (`tree-sitter-rust@0.24.0`) | 1,113,644 | 818,756 |
| Java | 414,641 (`tree-sitter-java@0.23.5`) | 414,641 | 430,239 |
| C# | 5,350,581 (`tree-sitter-c-sharp@0.23.5`) | 5,103,332 | 3,978,594 |
| Ruby | 2,106,352 (`tree-sitter-ruby@0.23.1`) | 2,106,352 | 2,106,447 |
| PHP | 1,058,041 (`tree-sitter-php@0.24.2`) | 1,058,041 | 812,594 |
| C | 625,918 (`tree-sitter-c@0.24.1`) | **not included** | 792,959 |
| C++ | 3,434,931 (`tree-sitter-cpp@0.23.4`) | 5,394,393 | 4,662,978 |
| **Total (12)** | **18,039,333 (~18.0 MB); tar.gz 1,558,513 (~1.56 MB)** | ~17.4 MB without C | n/a |

Loading test with `web-tree-sitter@0.27.1`, parsing a trivial input after `Language.load`:
- Official per-language `.wasm` files: all 12 **loaded** (ABI 14 or 15).
- `@vscode/tree-sitter-wasm` (built with tree-sitter-cli 0.25.10): all **loaded**.
- `tree-sitter-wasms` (built with tree-sitter-cli ^0.20.8, last published 2025-10-07): **all failed** in `getDylinkMetadata`. The web-tree-sitter README warns that "some prebuilt `.wasm` files use an older dynamic-linking format that newer versions of `web-tree-sitter` cannot load". Avoid this package.

Do not make the per-language packages runtime dependencies. They contain native sources and prebuilds (unpacked sizes: tree-sitter-c-sharp 68 MB, tree-sitter-cpp 42 MB, tree-sitter-typescript 39 MB), and they run `install: node-gyp-build`. Use them as devDependencies and copy only the `.wasm` files into `dist/grammars/`. If upgrades are coordinated, `@vscode/tree-sitter-wasm` is a tidy single devDependency, but it lacks C and its version lags.

### Other components

| Component | Size |
|---|---|
| `web-tree-sitter@0.27.1` as a dependency | 4.69 MB unpacked (includes the debug build and source maps) |
| web-tree-sitter vendored (`web-tree-sitter.js` + `.wasm`) | 156 KB + 210 KB ≈ 0.37 MB |
| `three@0.186.1` package (devDependency only) | 20.4 MB unpacked, 1,263 files |
| Page bundle: three (WebGLRenderer, InstancedMesh, MeshStandardMaterial, lights, OrbitControls) bundled by esbuild with `--minify` | 561,735 B minified, 141,097 B gzipped |

### Estimated `git-city` install

- Vendored runtime plus 12 grammars plus page bundle plus CLI code: **about 19.5 MB installed, about 2–2.5 MB tarball**.
- With `web-tree-sitter` as a runtime dependency instead: **about 24 MB installed**.
- Options to shrink it: drop C# and C++ (about 8.8 MB), or download grammars on demand into a cache. Since the tarball compresses to about 1.6 MB, the size mostly costs disk space, not download time.

### Generated output vs CLI

| Item | CLI package | Generated site |
|---|---|---|
| grammar `.wasm` | yes | **no** (parsing happens in Node) |
| web-tree-sitter | yes | **no** |
| three.js | bundled inside `dist/page/` | **yes** (inside the bundle, about 0.56 MB minified) |
| city data | no | yes |

Grammars would only need to ship in the output if the page parsed code in the browser, which is not planned.

## 5. Running without installing, and `git city`

- **`npx git-city`** works. When no `--package` is given and the package has a single `bin` entry (or a bin matching the unscoped package name), npm exec runs it. npx asks for confirmation before installing unless `-y` is passed.
- **How git dispatches commands:** `git.c` turns `git city …` into an exec of `git-city …` (`execv_dashed_external`, `strvec_pushf(&cmd.args, "git-%s", argv[0])`). git.c says: "We use PATH to find git commands, but we prepend some higher precedence paths" (`--exec-path`, `GIT_EXEC_PATH`, gitexecdir). Any `git-city` executable on `PATH` therefore works.
- **Global install:** `npm i -g git-city` links `git-city` into the global bin directory, which is on `PATH`, so `git city` works.
- **npx alone:** does **not** make `git city` work. npm only adds `--package` bins to "the `PATH` of the executed command". After `npx git-city` exits, nothing is left on the shell's `PATH`. `npx -p git-city git city` **does** work, because the child `git` inherits that `PATH`.
- **`--help` caveat:** git rewrites `git city --help` to `git help --exclude-guides city`, which looks for a `git-city` man page. The `git-city` process never sees `--help`. Options: ship a man page through package.json `"man"` (npm links it on global installs; not on Windows), or document `git city -h`.
- **Windows:** Git for Windows' `compat/mingw.c` `lookup_prog` tries `<dir>\git-city.exe` and then an extensionless `<dir>\git-city`. `parse_interpreter` runs extensionless files that start with `#!`. npm's `cmd-shim` writes three shims: `git-city.cmd`, `git-city.ps1`, and an extensionless `git-city` that starts with `#!/bin/sh`. Git for Windows will use the third one, through its bundled `sh`. The `.cmd` and `.ps1` shims are invisible to git. `npx git-city` and running `git-city` directly in cmd or PowerShell use the `.cmd`/`.ps1` shims and work. Not verified on real Windows; add a Windows CI smoke test for `git city -h`.

## 6. Licences and attribution

| Component | Licence | Copyright line |
|---|---|---|
| three.js | MIT | "Copyright © 2010-2026 three.js authors" |
| web-tree-sitter | MIT | "Copyright (c) 2018 Max Brunsfeld" |
| tree-sitter-typescript | MIT | (c) 2017 Max Brunsfeld |
| tree-sitter-javascript | MIT | (c) 2014 Max Brunsfeld |
| tree-sitter-python | MIT | (c) 2016 Max Brunsfeld |
| tree-sitter-go | MIT | (c) 2014 Max Brunsfeld |
| tree-sitter-rust | MIT | (c) 2017 Maxim Sokolov |
| tree-sitter-java | MIT | (c) 2017 Ayman Nadeem |
| tree-sitter-c-sharp | MIT | (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors |
| tree-sitter-ruby | MIT | (c) 2016 Rob Rix |
| tree-sitter-php | MIT | (c) 2017 Josh Vera, GitHub |
| tree-sitter-c | MIT | (c) 2014 Max Brunsfeld |
| tree-sitter-cpp | MIT | (c) 2014 Max Brunsfeld |
| @vscode/tree-sitter-wasm | MIT (Microsoft); grammars inside are MIT | — |
| tree-sitter-wasms | Unlicense for the build scripts; grammars inside remain MIT | — |

What has to be shipped:
- **Generated page:** three.js is the only third-party code in it, so it must carry the three.js MIT copyright and permission notice. esbuild's default `legalComments: "eof"` for bundles already appends `/*! Bundled license information: … @license Copyright 2010-2026 Three.js Authors SPDX-License-Identifier: MIT */` (seen in my test bundle). Do not set `legalComments: none`. A small "Built with git-city · three.js (MIT)" credit linking to a `LICENSES.txt` in the output is good practice, but not legally required beyond the notice.
- **CLI package:** vendoring `.wasm` binaries counts as redistributing the grammars, so include each grammar's MIT text and web-tree-sitter's MIT text in `THIRD_PARTY_NOTICES.md`, listed in `files`.

## Sources

- npm registry, fetched 2026-10-13: https://registry.npmjs.org/git-city (404), https://registry.npmjs.org/gitcity (404), https://registry.npmjs.org/git-city-cli (404), https://registry.npmjs.org/@git-city%2Fcli (404), https://registry.npmjs.org/-/v1/search?text=git-city
- https://registry.npmjs.org/web-tree-sitter (0.27.1); README "Wasm compatibility" and `locateFile`: https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
- https://registry.npmjs.org/three (0.186.1); https://github.com/mrdoob/three.js/blob/dev/LICENSE
- https://registry.npmjs.org/tree-sitter-wasms (0.1.13); https://github.com/Gregoor/tree-sitter-wasms
- https://registry.npmjs.org/@vscode/tree-sitter-wasm (0.3.1); https://github.com/microsoft/vscode-tree-sitter-wasm
- Per-language packages: https://registry.npmjs.org/tree-sitter-typescript, …/tree-sitter-javascript, …/tree-sitter-python, …/tree-sitter-go, …/tree-sitter-rust, …/tree-sitter-java, …/tree-sitter-c-sharp, …/tree-sitter-ruby, …/tree-sitter-php, …/tree-sitter-c, …/tree-sitter-cpp (tarballs inspected for sizes and LICENSE)
- Node release schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- Node docs: `fsPromises.cp` stable in v22.3.0 https://nodejs.org/api/fs.html#fspromisescpsrc-dest-options ; `import.meta.dirname` https://nodejs.org/api/esm.html#importmetadirname
- npm exec / npx: https://docs.npmjs.com/cli/v11/commands/npm-exec ; package.json `bin`, `files`, `man`, `engines`: https://docs.npmjs.com/cli/v11/configuring-npm/package-json
- npm cmd-shim (Windows shims incl. `#!/bin/sh`): https://github.com/npm/cmd-shim/blob/main/lib/index.js
- git dispatch: https://github.com/git/git/blob/master/git.c (`execv_dashed_external`, PATH comment, `--help` rewrite)
- Git for Windows lookup: https://github.com/git-for-windows/git/blob/main/compat/mingw.c (`lookup_prog`, `parse_interpreter`)
- esbuild legal comments: https://esbuild.github.io/api/#legal-comments
