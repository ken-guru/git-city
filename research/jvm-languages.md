# Cost of supporting Java and Kotlin in v1

Research for [issue #28](https://github.com/ken-guru/git-city/issues/28). Date: 2026-10-13. Measurements were taken in a scratch directory (`scratchpad/jvm/`) with web-tree-sitter 0.27.1 on Node 24.21, linux/arm64. Five sample repos were used: google/guava, spring-projects/spring-petclinic, square/okhttp, Kotlin/kotlinx.coroutines and android/nowinandroid. Claims tagged *[measured]* come from those runs. All other claims cite a source listed at the bottom.

## Answer

- **Grammars are cheap and they load.** Java comes from `tree-sitter-java@0.23.5` (MIT). It ships a 415 KB `.wasm` (50 KB gzipped) on npm.
- **Kotlin needs a choice of grammar:**
  - **fwcd/tree-sitter-kotlin** (MIT) is the maintained one. It had commits in Aug 2026, and nvim-treesitter, Helix and Zed all pin it. Its last npm release (0.3.8, Aug 2024) ships **no** `.wasm`. The GitHub release does ship one (4.05 MB), but that build left syntax errors in 8% of okhttp's files.
  - A wasm built from HEAD is 5.77 MB (391 KB gzipped). It parsed all okhttp files cleanly. Building it needed only `tree-sitter build --wasm`: CLI 0.27.1 downloads wasi-sdk and binaryen by itself, so no emscripten or docker.
  - **@tree-sitter-grammars/tree-sitter-kotlin@1.1.0** (MIT) ships a 3.44 MB wasm (296 KB gzipped) on npm. It has been dormant since Jan 2025.
  - All three load in web-tree-sitter 0.27.1 (ABI 14) *[measured]*.
- **Added install size:** about **3.9 MB on disk and 0.35 MB gzipped** using the npm Kotlin grammar, or 6.2 MB and 0.44 MB with a fwcd HEAD build. For comparison, the 12-grammar set is 18 MB.
- **Extraction is easy.** One query per language captures each import's path plus its static, wildcard and alias flags, the package, and the top-level declarations. Parse plus query runs at **3–6 MB/s** *[measured]*.
- **Resolution has to use package declarations, not directories.** In kotlinx.coroutines, 963 of 1039 files sit in a directory that doesn't match their package *[measured]*, and the Kotlin conventions recommend omitting the common root package. The proposed resolver builds a per-commit index `(package, top-level name) → files` from stage-1 facts:
  - **Explicit imports:** walk from the longest prefix down, which handles nested classes and static members.
  - **Wildcard and same-package references:** matched against a per-file set of referenced identifiers, also extracted in stage 1.
  - **Why same-package matching is worth it:** same-package references, which need no import, are **19–74% of all file-to-file edges** in the samples (guava 43%, okhttp 46%, petclinic 74%) *[measured]*. Ignoring them loses a large share of the Roads.
  - **Why wildcards need filtering:** linking every file in a wildcard-imported package gives 20× the edges of the identifier-filtered version (kotlinx.coroutines: 186,967 against 9,168) *[measured]*.
- **Manifests can be read without running the build** for most projects. Only `groupId:artifactId` is needed, so versions, `dependencyManagement` and parent-POM version inheritance don't matter. The approach is to parse `pom.xml` as XML, parse `gradle/libs.versions.toml` as TOML, and map `libs.x.y` accessors and string-literal `"g:a:v"` coordinates found in `dependencies {}`.
  - **Coverage in a survey of the top 80 Java and Kotlin repos:** Maven is effectively fully covered. In Gradle builds, **≥80% of external declarations were static (catalog or literal) in 50 of 57 repos** *[measured, crude]*.
  - **What it misses:** convention plugins in buildSrc or build-logic (16 of 40 Kotlin repos have one), constants objects such as `Deps.x`, and Kotlin Multiplatform `sourceSets` blocks.
- **Matching imports to coordinates without mapping tables works if it scores rather than doing strict prefix matching.**
  - **Strict groupId-prefix matching** covered only 14–86% of external imports. It fails on guava (`com.google.common`), okio, assertk, kotlinx (`org.jetbrains.kotlinx`), `junit:junit` (`org.junit`), and Spring Boot starters.
  - **The combined rule** is groupId prefix, falling back to matching artifactId or groupId tokens against import segments. It matched **91–99.7%** *[measured]*, but needs a tie-break because 1–76% of matches had more than one candidate group. Precision was not measured (no ground truth).
- **Module manifests:** `pom.xml` and `build.gradle(.kts)` below the root should count. `settings.gradle(.kts)` below the root should count too, because it marks an included build such as `build-logic`.
- **Cost:**
  - **Java and Kotlin together are about L, roughly 1.5–2× the Python extractor.** Extraction is S, the resolver is M, manifests are M, and matching is S–M.
  - **Kotlin adds little once Java exists,** because both share one resolver and one manifest reader.
  - **Main risks:** picking and packaging the Kotlin grammar, false positives from identifier matching, Gradle dependencies hidden in convention plugins, and duplicate `(package, name)` pairs across source sets or flavours (1,564 in guava, which keeps an `android/` copy).
- **Recommendation: include Java and Kotlin in v1 with a reduced scope.**
  - **In scope:** Roads from explicit, wildcard and same-package references. External Dependencies from `pom.xml` `<dependencies>`, `libs.versions.toml` plus `libs.*` accessors, and string-literal coordinates.
  - **Cut:** parent-POM `<dependencies>` inheritance, buildSrc constants, KMP source sets, Groovy map notation, and Java 25 `import module`.
  - **Grammars:** ship `@tree-sitter-grammars/tree-sitter-kotlin` for now, since it fits the "official npm package, copy only the .wasm" rule, and keep fwcd as the swap-in candidate.
  - **If v1 must shrink further,** ship Java and Kotlin Roads only. Highways still appear for every declared dependency, because existence follows declarations and only strength depends on matching.

---

## 1. Grammars

| | Java | Kotlin (fwcd) | Kotlin (tree-sitter-grammars) |
|---|---|---|---|
| Repo | tree-sitter/tree-sitter-java | fwcd/tree-sitter-kotlin | tree-sitter-grammars/tree-sitter-kotlin |
| Licence | MIT | MIT | MIT |
| Latest npm | `tree-sitter-java@0.23.5` (2024-12-21) | `tree-sitter-kotlin@0.3.8` (2024-08-03); `package.json` on main says 0.4.0, unreleased | `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` (2025-01-09) |
| `.wasm` in npm tarball | yes, 414,641 B | **no** | yes, 3,441,042 B |
| `.wasm` gzip -9 | 49,771 B | — | 295,551 B |
| GitHub release `.wasm` | yes | 0.3.8: 4,052,625 B (319,537 B gz) | yes |
| Built from HEAD (`tree-sitter build --wasm`, CLI 0.27.1) | — | 5,773,627 B (391,244 B gz) | — |
| Activity | commits since the 2024 release are only CI/chore | real grammar fixes in Apr–Aug 2026, 190★ | last real commit Jan 2025, 8★ |
| Used by | nvim-treesitter, Helix | nvim-treesitter, Helix, Zed | — |
| Loads in web-tree-sitter 0.27.1 | yes (ABI 14) | yes (ABI 14), both release and HEAD builds | yes (ABI 14) |
| npm package unpacked (dev install only) | 6.2 MB | 24 MB | 47 MB |

**Files with ERROR nodes** *[measured]*:

| Repo (files) | Java 0.23.5 | ktG 1.1.0 | fwcd 0.3.8 | fwcd HEAD |
|---|---|---|---|---|
| guava (3275 .java) | 13 (0.4%) | | | |
| okhttp (573 .kt) | | 7 (1.2%) | 48 (8.4%) | 0 |
| kotlinx.coroutines (1039 .kt) | | 19 (1.8%) | | 15 (1.4%) |
| nowinandroid (310 .kt) | | 0 | | 11 (3.5%) |

Packages, imports and top-level declarations sit at the top of the file, so a parse error further down rarely loses them. Import counts agreed within 0.3% between grammars on okhttp.

**Install notes:**
- `npm install` of both Kotlin packages together fails with ERESOLVE. fwcd 0.3.8 has a non-optional peer `tree-sitter@^0.21`, which clashes with the optional `^0.22.4` peer of the tree-sitter-grammars package.
- The Java and tree-sitter-grammars packages declare their `tree-sitter` peer as optional, so they cause no conflict unless native `tree-sitter` is installed. `tree-sitter-python` wants `^0.25`.
- Use `--ignore-scripts`, or rely on prebuilds, because the packages carry a `node-gyp-build` install script.

**Building a wasm:**
- The tree-sitter docs say `build --wasm` uses the WASI SDK from `TREE_SITTER_WASI_SDK_PATH` or downloads it.
- In practice it fetched wasi-sdk-34 (183 MB) and binaryen 132 (106 MB) into `~/.cache/tree-sitter` and built in under a minute. No emscripten or docker was needed.
- That is feasible in CI. However, it breaks the settled rule of copying the `.wasm` from an official npm package.

**Java 25 `import module java.base;`** (JEP 511) is not in grammar 0.23.5 and parses as an ERROR. Those imports name JDK modules, so they would be dropped anyway.

## 2. Extraction

These are the queries tested *[measured]*. Each match gives the path plus its flags.

```scheme
; Java (tree-sitter-java 0.23.5)
(package_declaration [(identifier) (scoped_identifier)] @package)
(import_declaration "static"? @static [(identifier) (scoped_identifier)] @name (asterisk)? @wildcard) @import
(program [(class_declaration name: (identifier) @decl) (interface_declaration name: (identifier) @decl)
          (enum_declaration name: (identifier) @decl) (record_declaration name: (identifier) @decl)
          (annotation_type_declaration name: (identifier) @decl)])
(type_identifier) @ref (identifier) @ref

; Kotlin (@tree-sitter-grammars 1.1.0): wildcard is the anonymous "*" token; alias is a trailing identifier
(package_header (qualified_identifier) @package)
(import (qualified_identifier) @name "*"? @wildcard (identifier)? @alias) @import

; Kotlin (fwcd): different node names
(package_header (identifier) @package)
(import_header (identifier) @name (wildcard_import)? @wildcard (import_alias (type_identifier) @alias)?) @import
(source_file [(class_declaration (type_identifier) @decl) (object_declaration (type_identifier) @decl)
              (type_alias (type_identifier) @decl) (function_declaration (simple_identifier) @decl)
              (property_declaration (variable_declaration (simple_identifier) @decl))])
(type_identifier) @ref (simple_identifier) @ref
```

**Forms to capture:**
- **Java:** `import a.b.C;`, `import a.b.*;`, `import static a.b.C.m;` and `import static a.b.C.*;` (JLS §7.5).
- **Kotlin:** `import a.b.C`, `import a.b.*` and `import a.b.C as D`. An import can also name a top-level function or property, or an object member. Backticked segments need their backticks stripped (Kotlin docs, "Packages and imports").

**What the samples showed** *[measured]*:
- Wildcards are rare in Java and okhttp, which follow Google's style rule against them. kotlinx.coroutines is the exception: 3,543 of its 4,299 imports are wildcards.
- Java `import static` was 28% of guava's imports.
- Kotlin files with more than one top-level declaration: okhttp 3.5%, nowinandroid 7%, kotlinx.coroutines 14%. Java has almost none.

**Stage-1 facts** cached per blob:
- `package`;
- `imports[]` of `{path, static, wildcard, alias}`;
- `decls[]` of top-level names (Kotlin also includes top-level functions and properties);
- `refs`, the set of simple identifiers used in the file.

**Speed** (parse plus query, single thread) *[measured]*:

| Language | Throughput | Example |
|---|---|---|
| Java | 3.5–6.2 MB/s | guava, 29 MB in 4.7 s |
| Kotlin, both grammars | 3.0–4.3 MB/s | |

Grammar load takes 3–11 ms.

## 3. Resolution to repo files

**Layout.** Directories are a hint only:
- Maven's standard layout is `src/main/java`, `src/test/java` and so on (Maven docs).
- Kotlin conventions say: *"In pure Kotlin projects, the recommended directory structure follows the package structure with the common root package omitted."*
- kotlinx.coroutines keeps files directly under `module/src/` and `module/common/src/`. 963 of its 1039 files don't match their directory *[measured]*.
- Java tools usually require the directory to match the package (JLS §7.2 leaves this to the host), but Kotlin does not.
- Kotlin also *encourages* several declarations per file, and the file name need not match.

**Resolver design:** a per-commit index built from cached stage-1 facts with no filesystem access.

1. **Build `index: package → name → files[]`** from each file's `package` and `decls`. Files with no package go under `""`.
2. **Explicit import `a.b.C.d`:**
   - for `i` from `len-1` down to `1`, look up `(parts[0..i], parts[i])`, and the first hit wins;
   - this covers nested types (`Outer.Inner`), static members (`C.m`) and Kotlin top-level functions (`pkg.fn`).
3. **Wildcard `a.b.*`:**
   - if `a.b` is a repo package, link to the files in that package whose declared names appear in this file's `refs`;
   - otherwise, if `a.b` names a type (`import static a.B.*`), link to that type's file.
4. **Same package:** link to the files in the importer's package that declare a name in its `refs`. Excluding the file itself, this fills in what needs no import (JLS §6.3, Kotlin default package scope).
5. **Duplicates:** when one `(package, name)` maps to several files, prefer the one in the importer's own Module and source set, `main` before `test`. Otherwise link to all of them, or none (to be decided).
6. **Aliases** (`as D`) affect only `refs` matching. Map `D` back to the real name when filtering.

**Edges per strategy** in the prototype (`scripts/resolve.mjs`) *[measured]*:

| Repo | Explicit | Wildcard (ref-filtered) | Wildcard (all files) | Same package (ref-filtered) | Union | Only from same package |
|---|---|---|---|---|---|---|
| petclinic | 24 | 0 | 0 | 67 | 91 | 67 (74%) |
| guava | 26,971 | 0 | 0 | 24,296 | 47,215 | 20,244 (43%) |
| okhttp (kt) | 1,963 | 0 | 0 | 1,886 | 3,665 | 1,702 (46%) |
| kotlinx.coroutines | 221 | 9,168 | 186,967 | 4,228 | 13,460 | 4,164 (31%) |
| nowinandroid | 815 | 0 | 0 | 201 | 1,005 | 190 (19%) |

**Same-package references:**
- **If ignored,** roughly 20–75% of Roads disappear, and whole intra-package Districts look disconnected.
- **The identifier heuristic** costs one extra `refs` set per cached blob plus a set intersection.
- **False positives** come from identifiers that only happen to equal a declared name, such as a local variable called `launch` matching a Kotlin top-level `fun launch`.
  - Java type names are capitalised, which keeps this low.
  - To be safer, Kotlin could match only capitalised names plus names used in call position.
- **Wildcards** must be filtered by `refs`. Without the filter they produce dense, meaningless meshes.

## 4. Manifests

**Maven `pom.xml`** (POM reference; dependency mechanism):
- Read `project/dependencies/dependency` and take `groupId:artifactId`. Ignore `<dependencyManagement>` (it declares versions only) and `<build><plugins>`.
- `<version>` is irrelevant to us. 800 of 1,223 surveyed dependencies had no version, because it is managed elsewhere *[measured]*.
- `${...}` in `groupId` is rare and mostly means `${project.groupId}`, a link to a sibling module, which is not external.
- A parent POM can contribute inherited `<dependencies>`. Following `<parent><relativePath>` inside the repo is cheap, but it is out of scope for v1. A remote parent such as `spring-boot-starter-parent` adds versions, not dependencies.

**Gradle** (Groovy `build.gradle` / Kotlin DSL `build.gradle.kts`):
- These are programs, so a static read is only a heuristic. Inside `dependencies { … }`, take each configuration call: `implementation`, `api`, `testImplementation`, `compileOnly`, `kapt`, `ksp` and so on.
- Classify each argument:
  - **string literal** `"g:a:v"` or `'g:a'`: take `g:a`;
  - **catalog accessor** `libs.foo.bar`: map it through the catalog. Aliases are split by `-` or `_` and normalised to dots (Gradle docs), so `libs.kotlinx.coroutines.test` matches alias `kotlinx-coroutines-test`. `libs.bundles.x` expands to that bundle;
  - **`project(":x")` / `projects.x`:** a module-to-module link, already covered by Roads;
  - **anything else** (`Deps.x`, `kotlin("stdlib")`, `compose.ui`): drop it.
- `platform(...)` wraps any of the above.
- Tree-sitter could parse `.kts` with the Kotlin grammar, but a line or regex scan is enough here. Groovy would need yet another grammar, so it doesn't pay off.

**`gradle/libs.versions.toml`:**
- It is plain TOML. Read `[libraries]` entries of the forms `{ module = "g:a" }`, `{ group, name }` or `"g:a:v"`, plus `[bundles]`.
- Gradle imports this file automatically. Catalogs created in `settings.gradle(.kts)` with `versionCatalogs { create(...) }` are rarer; skip them.

**Survey coverage** *[measured, crude]*. The survey took the top 40 repos per language (`stars>3000`, pushed in 2026), scanned at most 12 build files each, and classified lines inside `dependencies {` with a regex (`scripts/survey.mjs`).

| | Java repos (40) | Kotlin repos (40) |
|---|---|---|
| Build system | Maven 17, Gradle Groovy 11, Gradle KTS 3, both 4, none 5 (docs/algorithm repos) | KTS 33, Groovy 3, both 3, none 1 |
| Has `libs.versions.toml` | 7 | 32 |
| Has buildSrc or build-logic | 6 | 16 |
| Gradle dependency lines: catalog / literal / project / other | 707 / 547 / 492 / 290 | 1983 / 197 / 719 / 313 |
| Gradle repos with ≥80% of external declarations static | 15 / 18 | 35 / 39 |
| Low-coverage repos | elasticsearch, kafka (buildSrc constants) | JetBrains/kotlin, fresco, Signal, Thunderbird |

**Estimate:**
- `pom.xml` + `libs.versions.toml` + string literals cover essentially all direct dependencies in Maven projects, and most of them in about 85–90% of Gradle projects.
- What remains is mostly big builds whose dependencies live in code: buildSrc constants, convention plugins that add dependencies (nowinandroid's `nowinandroid.android.*` plugins), and KMP `commonMain.dependencies {}` blocks.
- For the catalog case only, a useful fallback is to count every `[libraries]` entry as declared by the root manifest when no module references it.

## 5. Matching imports to coordinates without mapping tables

Matching was evaluated in `scripts/match.mjs` against external, non-platform imports, that is, those that are neither in the repo nor `java.`, `kotlin.` or `android.` *[measured]*:

| Repo | External imports | groupId prefix | groupId minus last segment | Token segment | Combined (prefix, else token) | Combined, more than one group |
|---|---|---|---|---|---|---|
| petclinic | 373 | 13.9% | 61.9% | 90.9% | 90.9% | 10.7% |
| okhttp | 2,368 | 27.8% | 28.2% | 98.5% | 98.9% | 37.1% |
| nowinandroid | 2,403 | 61.9% | 48.2% | 98.6% | 99.2% | 76.0% |
| guava | 6,687 | 85.8% | 23.3% | 99.7% | 99.7% | 0.7% |

The token rule takes tokens from the artifactId split on `-_.`, plus groupId segments after the first. It drops generic tokens (core, api, ktx, android, jvm, common, runtime, starter, test, annotations…), then matches any import package segment.

**Where strict groupId prefix works:**
- `org.apache.commons:commons-lang3` → `org.apache.commons.lang3`;
- `org.jspecify:jspecify`;
- `androidx.room:room-runtime` → `androidx.room`;
- `jakarta.persistence:jakarta.persistence-api` → `jakarta.persistence`.

**Where it fails:**

| Coordinate | Imported as |
|---|---|
| `com.google.guava:guava` | `com.google.common` |
| `com.fasterxml.jackson.core:jackson-databind` | `com.fasterxml.jackson.databind` |
| `org.jetbrains.kotlinx:kotlinx-coroutines-core` | `kotlinx.coroutines` |
| `com.squareup.okio:okio` | `okio` |
| `com.willowtreeapps.assertk:assertk` | `assertk` |
| `junit:junit` | `org.junit`, `junit.framework` |
| `org.springframework.boot:spring-boot-starter-web` | `org.springframework.web` (the starter brings it in transitively) |
| `com.google.dagger:hilt-android` | `dagger.hilt` |
| `javax.inject:javax.inject` | `javax.inject` (works) |
| `jakarta.*` / `javax.*` | split between JDK and libraries, so `javax.*` can't be treated as all-platform |

**Still unmatched with the combined rule:**
- `org.assertj.core` (assertj usually comes through `spring-boot-starter-test`);
- `org.hamcrest` and `org.mockito` (also transitive);
- `jsinterop.annotations` (`com.google.jsinterop:jsinterop-annotations`: the token is "jsinterop", but the generic stoplist removed "annotations"). Tuning would fix this one.

**Tie-break proposal.** Score each candidate by:
1. the number of leading groupId segments shared with the import;
2. the number of artifact or group tokens found among the import's segments, with longer tokens weighted more.

Take the top score and drop ties across *different* groups. Within one group, ties are harmless for Highway strength at group level.

Precision is unverified, because there is no ground truth without resolving jars.

**Grouping for External Cities** uses a vendor key:
- the first two groupId segments when the first is a TLD-like token (`com`, `org`, `io`, `net`, `dev`, `app`, `me`, `co`), giving `com.squareup`, `org.jetbrains` and `org.apache` (`org.apache` is arguably too broad, so config can override);
- otherwise the first segment, giving `androidx`, `junit`, `jakarta` and `dagger`;
- `com.google` is a mixed bag (guava, gson, dagger, firebase), so a stoplist could make it use three segments.

This keeps the spirit of the npm "scope" rule.

## 6. Module manifests

**`pom.xml` below the root: yes.** Each Maven module has its own POM and `artifactId`. guava has 9 and okhttp has a `maven-tests/pom.xml`.

**`build.gradle(.kts)` below the root: yes.** Each Gradle subproject usually has one; okhttp has 30 or more. Caveats:
- a subproject can exist with no build file, or have its `projectDir` remapped in settings. Accept both misses;
- `buildSrc/` and `build-logic/` become Modules. That is correct, because they are real build units.

**`settings.gradle(.kts)` below the root: yes.** It marks an included or composite build, such as okhttp's `build-logic/settings.gradle.kts`. It nearly always sits next to a build file, so it only matters when one is missing.

**Root manifests** follow the existing rule: they never form a Module, and their Highways leave from the City centre.

## 7. Cost estimate and recommendation

**Download and install size:**
- **On disk:** Java 0.41 MB plus Kotlin 3.44 MB (npm grammar) is about **+3.9 MB**, roughly 21% more than the 18 MB 12-grammar set. With fwcd HEAD it would be +6.2 MB.
- **Over the wire:** gzipped, about +0.35 MB or +0.44 MB.
- **Dev only:** the Kotlin npm package unpacks to 47 MB in `node_modules`.

**Effort, relative to the Python extractor (M):**

| Part | Size | Why |
|---|---|---|
| Extractors | S | Two queries. Facts are wider than "specifiers": package, decls and refs |
| Resolver | M | Package index, prefix walk-down, wildcard and same-package `refs` filtering, duplicate preference by Module and source set. Simpler than Python source-root inference, but the `refs` facts are new in the cache schema |
| Manifests | M | POM XML, TOML, Gradle line scanner and accessor normalisation, plus Module detection for three new files |
| Matching and grouping | S–M | Scoring heuristic and stoplist, tuned on a fixture corpus |
| Total | **L** | About 1.5–2× Python. Kotlin's marginal cost on top of Java is S |

**Main risks:**
1. **Kotlin grammar.** The maintained grammar (fwcd) doesn't publish a wasm, and the published one is dormant. Changing grammar means rewriting the query and invalidating the cache through the grammar version stamp.
2. **Identifier heuristics.** False-positive Roads, mainly Kotlin lowercase top-level functions.
3. **Gradle declarations in code.** Convention plugins and buildSrc constants, especially in large Android and KMP builds, which then show few or no Highways.
4. **Duplicate types.** Android flavours, guava's `android/` mirror, and test fixtures.
5. **Matching precision is unmeasured.** It needs a fixture set.
6. **New syntax.** Java 25 `import module` is unparsed (low impact).

**Minimal v1 scope:**
- **Roads:**
  - explicit imports with prefix walk-down;
  - same-package and wildcard references filtered by `refs` (Kotlin restricted to capitalised names and call sites);
  - main before test, and same Module first.
- **External Dependencies:**
  - `pom.xml` `<dependencies>`;
  - `libs.versions.toml` together with `libs.*` and `libs.bundles.*` accessors;
  - string-literal `g:a[:v]` in `dependencies {}`.
- **Matching:** combined prefix and token scoring. Drop ambiguous ties across groups.
- **Cut to Later:**
  - parent-POM dependency inheritance;
  - Groovy map notation (`group: 'x', name: 'y'`);
  - buildSrc or convention-plugin evaluation;
  - KMP `sourceSets`;
  - settings-defined catalogs;
  - Java module imports.

**Verdict: include Java and Kotlin in v1** with the scope above. The size cost is small. Roads, the main visual payoff, are reliable from package indexing alone, and weak dependency matching degrades gracefully because Highways exist per declaration. If the schedule is tight, ship Roads first and External Dependencies for JVM manifests as a fast follow.

**Grammar choice:**
- **Now:** use `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0`. It satisfies the packaging rule.
- **Revisit:** fwcd, once it publishes 0.4.x with a wasm, or vendor a CI-built HEAD wasm if parse quality becomes an issue.

---

## Sources

**Primary**
- npm registry metadata (`npm view`) and tarball contents: [tree-sitter-java](https://www.npmjs.com/package/tree-sitter-java), [tree-sitter-kotlin](https://www.npmjs.com/package/tree-sitter-kotlin), [@tree-sitter-grammars/tree-sitter-kotlin](https://www.npmjs.com/package/@tree-sitter-grammars/tree-sitter-kotlin), [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter).
- GitHub API: releases, commits and licences for [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java), [fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin) (release 0.3.8 asset `tree-sitter-kotlin.wasm`; `package.json` on main says 0.4.0) and [tree-sitter-grammars/tree-sitter-kotlin](https://github.com/tree-sitter-grammars/tree-sitter-kotlin).
- Grammar pins used by editors: [nvim-treesitter parsers.lua](https://github.com/nvim-treesitter/nvim-treesitter/blob/main/lua/nvim-treesitter/parsers.lua), [Helix languages.toml](https://github.com/helix-editor/helix/blob/master/languages.toml), [zed-extensions/kotlin extension.toml](https://github.com/zed-extensions/kotlin/blob/main/extension.toml).
- [tree-sitter CLI `build`](https://tree-sitter.github.io/tree-sitter/cli/build.html): `--wasm` uses the WASI SDK from `TREE_SITTER_WASI_SDK_PATH`, or downloads it. Observed CLI 0.27.1 downloading wasi-sdk-34 and binaryen 132.
- Java Language Specification SE 21: [§6.3 scope](https://docs.oracle.com/javase/specs/jls/se21/html/jls-6.html#jls-6.3), [§7.2 host support for packages](https://docs.oracle.com/javase/specs/jls/se21/html/jls-7.html#jls-7.2), [§7.5 import declarations](https://docs.oracle.com/javase/specs/jls/se21/html/jls-7.html#jls-7.5), [§7.6 top-level types](https://docs.oracle.com/javase/specs/jls/se21/html/jls-7.html#jls-7.6); [JEP 511 module import declarations](https://openjdk.org/jeps/511).
- Kotlin docs: [Packages and imports](https://kotlinlang.org/docs/packages.html); [Coding conventions, directory structure and source file organisation](https://kotlinlang.org/docs/coding-conventions.html) (quoted from the [kotlin-web-site source](https://github.com/JetBrains/kotlin-web-site/blob/master/docs/topics/coding-conventions.md)).
- Maven: [POM reference](https://maven.apache.org/pom.html), [Dependency mechanism / dependencyManagement](https://maven.apache.org/guides/introduction/introduction-to-dependency-mechanism.html), [Standard directory layout](https://maven.apache.org/guides/introduction/introduction-to-the-standard-directory-layout.html).
- Gradle: [Version catalogs](https://docs.gradle.org/current/userguide/version_catalogs.html) (alias separators `-`/`_` normalised to dots; `gradle/libs.versions.toml` imported automatically; quoted from the [docs source](https://github.com/gradle/gradle/blob/master/platforms/documentation/docs/src/docs/userguide/reference/dependency-management/centralizing-dependencies/version_catalogs.adoc)), [Declaring dependencies between subprojects / type-safe project accessors](https://docs.gradle.org/current/userguide/declaring_dependencies_between_subprojects.html), [Multi-project builds](https://docs.gradle.org/current/userguide/multi_project_builds.html).
- [Google Java Style §3.3.1](https://google.github.io/styleguide/javaguide.html#s3.3.1-wildcard-imports): no wildcard imports.

**Measurements**
- Scripts are in `scratchpad/jvm/scripts/`:
  - `shape.mjs` and `edge.mjs`: loading and node shapes;
  - `bench.mjs`: speed and error rates;
  - `resolve.mjs`: resolver prototype;
  - `match.mjs`: matching heuristics;
  - `survey.mjs` and `summ.mjs`: GitHub build-file survey, raw data in `scratchpad/jvm/survey.json`.
- Corpora: GitHub archives of google/guava (master), spring-projects/spring-petclinic (main), square/okhttp (master), Kotlin/kotlinx.coroutines (master) and android/nowinandroid (main), downloaded 2026-10-13.
