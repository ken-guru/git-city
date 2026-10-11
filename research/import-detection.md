# Detecting imports across languages

Research for ticket [#3](https://github.com/ken-guru/git-city/issues/3), part of map [#1](https://github.com/ken-guru/git-city/issues/1).

**Question:** How should GitCity find file-to-file connections (Roads) and file-to-package connections (External Dependencies) for each commit?

**Settled context:** tree-sitter behind a pluggable extractor, with TS/JS and Python guaranteed in v1. Roads are internal only. External Dependencies become External Cities, grouped by name prefix where possible. The CLI may read anything locally, but the output holds only structural facts. The target is about 50k commits and 20k files.

## Answer in brief

1. **Use `web-tree-sitter` (WASM), not the native `tree-sitter` bindings.** On a real corpus it was only 8–38% slower than native, and it avoids a fragile native install. During this research the native install failed on linux-arm64 *and* on npm peer-dependency resolution.
2. **Split the work into two stages: extract, then resolve.** *Extract* is a pure function of blob content: tree-sitter plus one query per language yields a list of raw specifiers, cached by **blob SHA**. *Resolve* maps those specifiers onto the commit's **file set and config files** (tsconfig, package.json, Python roots) using GitCity's own small resolver that works over an in-memory path set. It never touches the real filesystem or `node_modules`, because historical commits have neither.
3. **Per-commit work is proportional to the diff.** Re-extract only changed blobs. Re-resolve only the specifiers whose candidate paths were touched, or all specifiers under a config file when that config changes. Measured on vite, this comes to about 2.2 changed TS/JS files per commit and roughly 0.4 ms to parse each one.
4. **Classify each specifier in a fixed order:** relative or aliased (to a repo file) → **Road**; platform builtin or stdlib → **dropped**; anything else bare → **External Dependency**, keyed by package name (npm) or top-level import name (Python).
5. **Group External Dependencies with these rules:** the npm scope; then the first name token shared by two or more packages, or equal to a package that exists; `@types/*` folded into its target; a scope merged with the same unscoped token. A small stoplist and a config override cover the rest. On vite this turned 137 packages into 110 cities, with sensible groups.
6. **Reuse ideas, not tools.** dependency-cruiser and madge both resolve against the live filesystem plus `node_modules`, so neither can run against historical blobs. Borrow dependency-cruiser's dependency-type taxonomy and its resolver test cases. Keep `es-module-lexer` in mind as an optional fast path for TS/JS behind the same extractor interface.

---

## 1. tree-sitter from Node: WASM vs native

### What the primary sources say

- `web-tree-sitter` loads each grammar as a separate `.wasm` file. Grammar npm packages ship it, for example `tree-sitter-typescript/tree-sitter-typescript.wasm`. It supports incremental re-parse via `tree.edit()` with `parser.parse(src, oldTree)`. Its README says that running `.wasm` in Node "is considerably slower than the native Node bindings" and suggests it is mainly useful for testing. ([web-tree-sitter README](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md))
- ABI note from the same README: web-tree-sitter 0.25.0 and later loads parser ABI 13–15. Some older prebuilt `.wasm` files use a dynamic-linking format that newer versions can't load, and need rebuilding.
- The native `tree-sitter` package (0.25.1) installs with `node-gyp-build`, depends on `node-addon-api` (N-API), and ships prebuilds made with `prebuildify` ([package.json](https://github.com/tree-sitter/node-tree-sitter/blob/master/package.json)).
- Query predicates such as `#eq?` and `#match?` "are not handled directly by the Tree-sitter C library"; the bindings implement them ([Predicates and directives](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html)). Both Node bindings evaluated `#eq?` identically in the benchmark below.

### What happened when installing (2026-10-11, Node 24.21, npm 12, linux-arm64)

- `npm install tree-sitter tree-sitter-typescript tree-sitter-python` **failed with ERESOLVE**. `tree-sitter-typescript@0.23.2` has an optional peer dependency on `tree-sitter@^0.21.0`, while `tree-sitter-python@0.25.0` wants `^0.25.0`. The install only works with `--legacy-peer-deps`, which a CLI cannot ask its users to pass.
- npm 12 **blocks install scripts by default** (`allowScripts`), so `node-gyp-build` never ran. Loading then depends entirely on the bundled prebuilds.
- `tree-sitter-typescript@0.23.2`'s `prebuilds/linux-arm64/tree-sitter-typescript.node` is an **x86-64 ELF** (e_machine `0x3e`), so `dlopen` failed on arm64. Building from source needed a C toolchain, local Node headers (`--nodedir=/usr`) and network access to nodejs.org, which the sandbox blocked.
- The WASM path needed nothing: `web-tree-sitter@0.27.1` loaded the `.wasm` files shipped inside the grammar packages. Sizes: runtime 210 KB, TypeScript 1.4 MB, TSX 1.4 MB, Python 458 KB.

### Benchmark

Method: parse every file, then run the import query below over the tree. Same machine, warm runs, two repeats with consistent results. Native TS was built from source for the comparison. Corpora: vite `main` (1,542 TS/JS files, 3.13 MB, `.d.ts` excluded) and the CPython 3.14 stdlib (624 `.py` files, 11.15 MB).

| Binding | TS/JS ms/file | TS/JS MB/s | Python ms/file | Python MB/s |
|---|---|---|---|---|
| native `tree-sitter` 0.25.1 | 0.38–0.40 | 5.1–5.4 | 2.44–2.50 | 7.2–7.3 |
| `web-tree-sitter` 0.27.1 | 0.43 | 4.7–4.8 | 3.37–3.43 | 5.2–5.3 |

The two bindings found identical specifier counts (3,726 TS/JS and 3,789 Python). WASM costs about 8–14% on TS/JS and about 38% on Python. That is far less than the README's "considerably slower" suggests, and a worker pool hides it either way.

**Recommendation:** use `web-tree-sitter` with the grammar `.wasm` files vendored into the GitCity package at pinned versions. This gives one artifact for every OS and architecture, no install scripts, and no compiler. Run extraction in a `worker_threads` pool, with one parser per worker. Grammar mapping: `.ts/.mts/.cts` → typescript; `.tsx` → tsx; `.js/.jsx/.mjs/.cjs` → tsx or the javascript grammar (needed for JSX); `.py/.pyi` → python. tree-sitter is error-tolerant, so files that fail to parse still produce partial results.

### Queries used (load-bearing)

TS/JS, which covers ESM imports, re-exports, `require()` and dynamic `import()` with literal arguments:

```scheme
(import_statement source: (string (string_fragment) @spec))
(export_statement source: (string (string_fragment) @spec))
(call_expression function: (identifier) @fn
  arguments: (arguments . (string (string_fragment) @spec)) (#eq? @fn "require"))
(call_expression function: (import)
  arguments: (arguments . (string (string_fragment) @spec)))
```

Python:

```scheme
(import_statement name: (dotted_name) @spec)
(import_statement name: (aliased_import name: (dotted_name) @spec))
(import_from_statement module_name: (_) @spec)   ; includes relative_import (leading dots)
```

For `from pkg import a, b`, the resolver also needs the imported names, because `a` may be a submodule (see §2). Extend the query to capture the `name:` fields of `import_from_statement`. Specifiers that aren't literals (`require(x)`, `importlib.import_module(name)`) are ignored.

### Alternative fast path (optional)

`es-module-lexer` lexes ESM import and export specifiers in JS and TS, including type-only imports, at about 3–5 ms/MB. tree-sitter measured about 200 ms/MB. It does not mention CommonJS `require` ([README](https://github.com/guybedford/es-module-lexer)). It could slot in behind the same extractor interface if TS/JS extraction ever becomes the bottleneck. At the numbers below it does not need to.

## 2. Resolving specifiers to repo files

### Why not an off-the-shelf resolver

- **dependency-cruiser** "uses the defaults of `enhanced-resolve`" and decides whether a dependency is declared by reading the closest `package.json` ([FAQ](https://github.com/sverweij/dependency-cruiser/blob/main/doc/faq.md)). **madge** depends on dependency-tree, precinct and filing-cabinet. It needs `tsConfig` or `webpackConfig` to resolve aliases, and silently skips files it "can't resolve" ([README](https://github.com/pahen/madge)). Both assume a checked-out tree, and usually an installed `node_modules`.
- **enhanced-resolve** accepts any fs-compatible `fileSystem`; memfs is the example given. It supports `exportsFields`, `conditionNames`, `extensionAlias` (`.js` → `.ts`), `alias`, `mainFields` and a `tsconfig` option for paths ([README](https://github.com/webpack/enhanced-resolve)). **oxc-resolver** is a Rust port of enhanced-resolve, tsconfig-paths-webpack-plugin and tsconfck. It covers tsconfig `extends`, `paths` and project references, and supports an in-memory FS through a Rust trait, but its README does not say whether the npm binding exposes that ([README](https://github.com/oxc-project/oxc-resolver)).
- Historical commits have **no `node_modules`**, and GitCity only needs to answer "which repo file, or which package name?" It never needs to read into a dependency. A small resolver over the commit's **path set** is simpler, deterministic, and supports incremental work, which a general resolver with its own caches does not. Use enhanced-resolve or oxc-resolver as **reference behaviour and test oracles**, not as the runtime.

### TS/JS rules (from the TypeScript and Node references)

- **Relative specifiers** (`./`, `../`). Probe in TypeScript's order. "For `import x from "./mod.js"`, the lookup order is `./mod.ts`, `./mod.tsx`, `./mod.d.ts`, then `./mod.js`", so a `.js` specifier can resolve to a `.ts` file. Extensionless paths and directory `index` files are allowed under `bundler` and CJS `require` ([TS modules reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html)). GitCity should be lenient and accept the union of all modes. It is drawing a map, not type-checking.
- **tsconfig `paths`.** "The pattern with the longest matching prefix before any `*` token is used"; fallback arrays are tried in order. Targets are relative to `baseUrl` if set, otherwise to the tsconfig that defines them. `baseUrl` alone also maps bare specifiers (same source). Follow `extends` within the repo. Each tsconfig applies to the files under its directory; use the nearest one.
- **package.json `imports`** (`#`-prefixed) and **self-reference** by the package's own name. Self-reference "is available only if package.json has "exports"" ([Node packages docs](https://github.com/nodejs/node/blob/main/doc/api/packages.md)). Map `imports` targets and `exports` subpaths back to source with TS's `rootDir`/`outDir` remapping idea. TS does this for `./dist/utils.d.mts` → `./src/utils.mts` (TS reference). When the target file doesn't exist, fall back to the package root (`src/index.*`, `index.*`). This keeps the Road at the right District even when the exact file is a build output.
- **Workspaces.** A workspace "can be consumed by its declared package.json name" ([npm workspaces](https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/workspaces.md)). Collect every `package.json` `name` in the commit's tree (pnpm, yarn and npm workspaces all reduce to this). A bare specifier whose package name matches one is internal, and resolves through that package's `exports`/`main` remapped to source, as above. This lines up with the map's Module rule (a directory with a package manifest).
- **Package name of a bare specifier:** `@scope/name` for scoped packages ([npm scope](https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/scope.md)), otherwise the first path segment.

### Python rules (from the language reference and PEP 420)

- **Relative imports.** "A single leading dot indicates a relative import, starting with the current package. Two or more leading dots indicate a relative import to the parent(s)", and they are only allowed in the `from … import …` form ([import system](https://github.com/python/cpython/blob/main/Doc/reference/import.rst)). The current package is the importing file's directory; `__init__.py` belongs to its own directory.
- **Absolute imports** `a.b.c`. Python "first tries to import foo, then foo.bar, and finally foo.bar.baz" (same source). Probe `a/b/c.py`, `a/b/c/__init__.py` and `a/b/c.pyi` under each **source root**. For `from a.b import x`, also try `a/b/x.py` and `a/b/x/__init__.py`, because `x` may be a submodule; if not, the Road goes to `a/b/__init__.py` or `a/b.py`. Each segment that lands on a file is technically imported too, but GitCity should only draw the deepest match.
- **Namespace packages.** A directory without `__init__.py` is still importable: it "is recorded and the scan continues", and "namespace packages cannot contain an `__init__.py`" ([PEP 420](https://github.com/python/peps/blob/main/peps/pep-0420.rst)). The resolver must therefore treat plain directories as packages.
- **Source roots** stand in for `sys.path`, which "is initialized from the PYTHONPATH environment variable" and is not knowable from the repo (import system docs). Use heuristics: the repo root; any `src/`; directories holding `pyproject.toml`, `setup.py` or `setup.cfg` (and their `src/`); plus a config override. When several roots match, take the longest match.
- **Stdlib.** `sys.stdlib_module_names` (added in 3.10) is "a frozenset of strings containing the names of standard library modules … the same on all platforms" ([sys docs](https://github.com/python/cpython/blob/main/Doc/library/sys.rst)). There are 297 names in 3.14. Ship a snapshot as static data, so the user needs no Python installed.

### Unresolvable specifiers

- A **relative** specifier that doesn't resolve (file not in this commit, generated code, a typo) gets dropped and counted.
- A **bare** specifier that matches no alias, workspace or root is an External Dependency (§3). This mirrors dependency-cruiser's split between `unknown` and `npm-no-pkg` ([rules reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)): GitCity does not require the package to be declared in a manifest.
- **Non-code targets** (`./style.css`, images) become Roads when the target file exists in the repo, since every file is a Building.

## 3. Internal (Road) vs external (External Dependency)

Apply these rules in order, first match wins:

| Specifier | Result |
|---|---|
| TS/JS relative or absolute path; Python leading dots | resolve → **Road**, or drop |
| `#…` (package `imports`) | resolve → **Road**, or drop |
| matches a tsconfig `paths`/`baseUrl` pattern and resolves | **Road** |
| package name equals a workspace or self package name | **Road** (to that Module's entry or the subpath file) |
| Python: top-level name found under a source root | **Road** |
| `node:` prefix, or name in `module.builtinModules` (72 entries in Node 24); Python top-level name in the stdlib snapshot or `__future__` | **dropped**: platform, not a third-party dependency |
| URL or protocol specifiers (`https:`, `npm:`, `jsr:`, `virtual:`) | `npm:x` → external `x`; everything else dropped (v1) |
| any other bare specifier | **External Dependency**, keyed by npm package name or Python top-level import name |

Python caveat: the import name is not the distribution name (`import yaml` comes from PyYAML, `bs4` from beautifulsoup4). Key Python External Dependencies on the **import name**, which needs no metadata and is what appears in the code.

Keep dependency-cruiser-style **kind flags** on every edge: `static`, `dynamic`, `type-only`, `re-export`, `require`. Later tickets can then weight Lanes, for example treating type-only imports as lighter traffic, without re-parsing.

## 4. Grouping External Dependencies by prefix

Each ecosystem has its own naming conventions:

- **npm:** a scope is a namespace owned by a user or org ([npm scope](https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/scope.md)), so it is a strong grouping signal. DefinitelyTyped names types for `@foo/bar` as `@types/foo__bar` ("note the double underscore") ([DefinitelyTyped README](https://github.com/DefinitelyTyped/DefinitelyTyped)), so `@types/*` maps back to its target package.
- **Go:** an import path is "the module path joined with the subdirectory". A module path is usually the repository root path, the first element "by convention a domain name" containing a dot, with an optional `/vN` suffix ([Go modules reference](https://go.dev/ref/mod)). Group by the longest `require` in go.mod matching the import, then by host plus owner (`github.com/aws/...`) or by host for vanity domains (`golang.org/x`). Strip `/vN`. A first element without a dot is the standard library.
- **Maven/Java:** a groupId "should follow Java's package name rules", which means a reversed domain the publisher controls, with sub-groups appended; artifactIds are lowercase words joined by hyphens ([Maven naming conventions](https://github.com/apache/maven-site/blob/master/content/markdown/guides/mini/guide-naming-conventions.md)). Java imports name packages, not coordinates, so group by the first 2–3 reversed-domain segments (`org.springframework`, `com.google.common`).

**Proposed rule for v1 (npm and Python):**

1. Fold `@types/x` into `x`, and `@types/a__b` into `@a/b`.
2. Compute a **group token**: for a scoped package, the scope without `@`; otherwise the first token after splitting on `-`, `.` or `_`.
3. A token becomes a group when (a) the package is scoped, or (b) two or more packages share the token, or the token is itself a package. The token must also not be on a small stoplist of generic words (`node`, `is`, `get`, `has`, `to`, `p`, `fast`, `string`, `js`, …).
4. **Merge** a scope group with the unscoped group of the same token (`@babel` + `babel-*`, `@rollup` + `rollup-*`).
5. A config map (`externalGroups: { "vue": ["vue", "@vue/*", "pinia"] }`) overrides everything.
6. Python: group by the top-level import name, which is already coarse (`google.*`), and apply steps 2–3 on `_` (for example `django_filters` → `django`).

**Check on vite (HEAD):** 137 distinct external packages became 110 groups. The resulting groups: `@babel` (6), `@vitejs` (7), `postcss` (5: postcss, postcss-import, postcss-modules, postcss-nested, postcss-load-config), `eslint` (eslint plus 3 `eslint-plugin-*`), `@rollup` (3), `react` (react, react-dom), `rollup` (rollup, rollup-plugin-license), `rolldown`, `browserslist`, `@jridgewell`, `babel`. This exposed two gaps that the rule above now covers. `@rollup`/`rollup` and `@babel`/`babel-*` came out split (step 4 fixes this). Test-fixture names like `nested-external*` also grouped; these become a non-issue once fixture paths are excluded or the names fall into the Outskirts. The top-N plus Outskirts rule from the map absorbs the long tail.

**Privacy flag (for the naming/privacy tickets):** External City names come from import specifiers in the code. A private scope such as `@acme/secret-thing` would show up in the output. Consider passing External Dependency names through the same Pseudonym and Generated-name policy, or at least offering an option to anonymise scopes that aren't on the public registry.

## 5. Per-commit cost at 50k commits and 20k files

**Pipeline per first-parent commit:**

1. `git log --first-parent --raw --no-renames` gives the changed paths and new blob SHAs. On vite, 3,302 commits took 123 ms for the whole log.
2. For each changed source blob not already in the **blob cache**, read it through one long-lived `git cat-file --batch` process (7,043 blobs, 110 MB, 191 ms total; about 0.03 ms per blob). Then extract its specifiers in the worker pool.
3. Update the commit's **path set**. Re-resolve:
   - the specifiers of changed files;
   - specifiers whose recorded **probe set** contains an added or deleted path. Keep a reverse index from probed path to specifiers, including failed probes, so that adding `foo/index.ts` re-resolves every `./foo` that missed before;
   - every specifier under a tsconfig, package.json or Python root marker that changed. These changes are rare, and their cost is bounded by the size of that Module.
4. Emit Road and External Dependency deltas (added and removed edges) for the commit. Only the deltas reach the output, which suits chunked data and resume.

**Measured on vite (3,302 first-parent commits, TS/JS only):** changed source files per commit had mean 2.23, p50 1, p90 4, p99 17. Blob reuse across history was low: 95.6% of changed blobs were unique, so the cache mainly pays off on reverts, re-runs and resume. The max of 870 is the shallow-clone boundary commit, which stands in for the **initial snapshot** that every run pays once.

**Estimate for the target:** 50k commits × about 2.2 files ≈ 110k parses at about 0.4 ms (TS/JS) to 3.4 ms (Python) each. That is roughly 45 s single-threaded for TS/JS and about 6 min for an all-Python repo, divided by the worker count. The initial snapshot of 20k files adds about 10–70 s single-threaded. Blob reads and resolution are minor next to parsing. This is one repo and one machine; treat it as an order of magnitude.

**Resume:** persist the blob-SHA → specifiers cache, keyed by extractor and grammar version, along with the last commit's path set and resolver state. Re-runs then only process new commits (map: "Re-runs resume from where the last run finished").

## 6. Pluggable extractor interface (sketch)

```ts
interface ImportExtractor {
  id: string; version: string;                 // cache key component
  matches(path: string): boolean;              // by extension
  extract(source: string, path: string): RawImport[];   // pure, runs in worker
}
interface RawImport { specifier: string; names?: string[]; kind: 'static'|'dynamic'|'type-only'|'re-export'|'require' }

interface Resolver {                            // per language family
  configFiles(path: string): boolean;           // tsconfig.json, package.json, pyproject.toml...
  resolve(imp: RawImport, from: string, tree: CommitTree): { road: string } | { external: string } | { drop: string; probes: string[] };
}
```

Adding a language means writing a query and a resolver. Files with no extractor still become Buildings, just without Roads (as settled on the map).

## What to reuse or learn from

| Tool | Take |
|---|---|
| **web-tree-sitter** plus grammar `.wasm` files | Runtime parser (recommended) |
| **dependency-cruiser** | Dependency-type taxonomy (`local`, `npm*`, `core`, `aliased-tsconfig-paths`, `aliased-workspace`, `aliased-subpath-import`, `type-only`, `dynamic-import`, …) and its resolver fixtures as test cases ([rules reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)) |
| **madge** (dependency-tree / precinct / filing-cabinet) | Prior art only; its silent skipping of unresolvable files is a pitfall to avoid ([README](https://github.com/pahen/madge)) |
| **enhanced-resolve / oxc-resolver** | Oracle in tests for TS/JS resolution edge cases; possible fallback for exotic configs through enhanced-resolve's custom `fileSystem` |
| **es-module-lexer** | Optional fast path for TS/JS, about 50× faster than tree-sitter by the README's figures |
| **grimp** (Python) | Prior art for a Python import graph with optional external packages listed by top-level name ([README](https://github.com/python-grimp/grimp)) |

## Open points for downstream tickets

- Should type-only and dynamic imports count as full Roads or lighter traffic? (Lane weighting)
- Default stoplist and top-N threshold for External City grouping. (External Cities ticket)
- Whether External Dependency names go through the privacy and naming policy. (Privacy / Generated names)
- Python source-root inference needs validation on src-layout monorepos and Django projects.

## Sources

- tree-sitter web binding README — https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md
- tree-sitter predicates and directives — https://tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html
- node-tree-sitter package.json and README — https://github.com/tree-sitter/node-tree-sitter
- TypeScript modules reference — https://www.typescriptlang.org/docs/handbook/modules/reference.html
- Node.js packages docs — https://github.com/nodejs/node/blob/main/doc/api/packages.md
- npm scope and workspaces docs — https://github.com/npm/cli/tree/latest/docs/lib/content/using-npm
- Python import system — https://github.com/python/cpython/blob/main/Doc/reference/import.rst
- Python `sys` docs — https://github.com/python/cpython/blob/main/Doc/library/sys.rst
- PEP 420 — https://github.com/python/peps/blob/main/peps/pep-0420.rst
- Go modules reference — https://go.dev/ref/mod
- Maven naming conventions — https://github.com/apache/maven-site/blob/master/content/markdown/guides/mini/guide-naming-conventions.md
- DefinitelyTyped README — https://github.com/DefinitelyTyped/DefinitelyTyped
- dependency-cruiser FAQ and rules reference — https://github.com/sverweij/dependency-cruiser/tree/main/doc
- madge README — https://github.com/pahen/madge
- enhanced-resolve README — https://github.com/webpack/enhanced-resolve
- oxc-resolver README — https://github.com/oxc-project/oxc-resolver
- es-module-lexer README — https://github.com/guybedford/es-module-lexer
- grimp README — https://github.com/python-grimp/grimp
- Local measurements (2026-10-11): Node 24.21.0, npm 12.0.2, linux-arm64; tree-sitter 0.25.1, web-tree-sitter 0.27.1, tree-sitter-typescript 0.23.2, tree-sitter-python 0.25.0; corpora vitejs/vite (main, 3,302 first-parent commits) and the CPython 3.14 stdlib.
