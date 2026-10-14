# GitCity specification

GitCity is a TypeScript CLI, `git-city`, that reads one branch's first-parent git history and writes a static webpage. The page plays that history as an animated low-poly 3D **City**. Files are Buildings, Modules are Districts (villages on open Countryside), internal references are Roads, and declared External Dependencies are External Cities reached by Highways.

This document gathers every decision from the planning map, [GitCity map](https://github.com/ken-guru/git-city/issues/1), into one spec that can be sliced into build tickets. Each section links the ticket that holds the reasoning and the paths not chosen. Domain terms are capitalised and defined in [`GLOSSARY.md`](GLOSSARY.md).

**Reading the cut line.** Everything is **v1** unless it is marked **⏭ Later**. Later items are part of the vision, and v1 must not close the door on them; how it keeps them open is noted where it matters.

**Conventions.**
- **Naming:** every lowercase name uses `git-city`, never `gitcity`. That covers the CLI and `git city`, `git-city.config.jsonc`, `.git/git-city/` and `git-city-site/`.
- **Tuning values:** numbers called tuning values are starting points. They live as named, configurable constants, never inline literals.

---

## 1. Principles

1. **Private by default.** The CLI may read anything locally, but the output holds only structural facts and display names. It never contains code, comments, strings, hashes, URLs, the repo name, email addresses or (unless opted in) commit messages. ([Privacy model](https://github.com/ken-guru/git-city/issues/6))
2. **Nothing that has been published moves.** A Lot, once handed out, keeps its place across playback and across re-runs. The only exceptions are a history rewrite and `--fresh`. ([Identity](https://github.com/ken-guru/git-city/issues/13), [Layout](https://github.com/ken-guru/git-city/issues/12))
3. **A re-run equals a fresh run.** Every layout and naming decision is made in history order from seeded inputs, so resuming gives exactly the City a fresh run would.
4. **The CLI decides meaning, the page only draws.** Floors, widths, Lanes, names and colours are computed by the CLI. The page turns them into geometry and animates them. ([Data format](https://github.com/ken-guru/git-city/issues/9))
5. **State is a pure function of time.** Every visual property is computed from one shared time value, so play, reverse, scrub and speed changes need no extra logic. ([Rendering](https://github.com/ken-guru/git-city/issues/4))
6. **Every transition is eased.** Nothing ever pops in.
7. **Data size is the CLI's job; frame rate is the page's.** ([Degradation](https://github.com/ken-guru/git-city/issues/25))

---

## 2. Architecture

```
            ┌──────────────── CLI (Node ≥ 22) ───────────────────────────────┐
 git repo ─►│ history → file facts → imports → model → layout → names → write│─► git-city-site/
            │      ▲ cache: .git/git-city/ (3 layers + run state + config)   │   index.html, page bundle,
            └──────┴─────────────────────────────────────────────────────────┘   world.bin, chunks/, strings.json
                                                                                           │
                                                          browser (three.js) ◄─────────────┘ served over HTTP
```

### Pipeline phases
The progress display shows one line per phase.

| Phase | Does | Section |
|---|---|---|
| history | first-parent walk, file lists, renames, dates | §3 |
| file facts | size, lines, binary, raw imports per blob | §3, §4 |
| imports | resolve per commit into Roads and Highways | §4 |
| model | Buildings, Modules, events, Floors, widths, Categories | §5 |
| layout | villages, Blocks, Lots, Countryside obstacles, roads, horizon | §6, §7 |
| names | privacy rules, Pseudonyms, Generated names, Labels | §8 |
| write | world file, chunks, `strings.json`, final scan, swap | §9 |

---

## 3. History extraction and cache

Sources: [Extracting git history](https://github.com/ken-guru/git-city/issues/2), [Resuming and the cache](https://github.com/ken-guru/git-city/issues/8).

### Extraction
- **Run the `git` binary.** Do not use isomorphic-git or libgit2.
  1. `rev-list --first-parent <branch>`
  2. `git log --first-parent -M --raw -z --no-abbrev --no-textconv --no-ext-diff`. Pin its output format against the user's config.
  3. `cat-file --batch-check` for sizes.
  4. `cat-file --batch` to count lines in process, about 8 parallel processes.
- **Timeline:** the first-parent history of one branch: the default branch, or `--branch`. A merge counts as one commit carrying its net change.
- **Renames:** git's default similarity of at least 50%. Past `diff.renameLimit`, a move becomes a delete plus an add, and that is accepted.
- **Binary:** a NUL byte in the first 8000 bytes. Binary files have 0 lines, and their line-equivalent is bytes ÷ 40.
- **Submodules:** mode `160000` becomes a special Building with no size.
- **LFS pointers:** parse their `size` field and treat the file as opaque.
- **Hardening:**
  - read the object database only and never check out;
  - set `GIT_NO_LAZY_FETCH=1`;
  - detect shallow clones and warn.
- **Memory:** stream everything and never hold the whole history in memory.

### Cache at `.git/git-city/`
It is shared by all worktrees and never committed.

| Layer | Keyed by | Holds | Invalidated by |
|---|---|---|---|
| 1. File-version facts | blob ID | size, lines, binary, raw import specifiers | extractor or grammar version |
| 2. Commit records | commit hash | changes, resolved Roads and Highways | commit leaving the first-parent chain |
| 3. Run state | branch | checkpoint, persisted layout (villages, Blocks, Lots), chosen Roles | history rewrite rolls back to the newest surviving checkpoint |

- **Never cached:** names, privacy rules, Category rules and rendered output. They are recomputed every run.
- **Version stamps:** each layer has its own. A new git-city version rebuilds only the layers whose stamp changed.
- **Crash safety:**
  - cache chunks are written atomically (temporary file, then rename) before the checkpoint advances;
  - the output is built in a staging folder and swapped in only when complete;
  - `.git/git-city/lock` stops two runs at once.
- **What re-runs process:** new commits only, which appends to layers 2 and 3. After a rewrite, the run rolls back to the newest checkpoint still on the chain.

---

## 4. Imports, Roads and External Dependencies

Sources: [Detecting imports](https://github.com/ken-guru/git-city/issues/3), [External Dependencies from manifests](https://github.com/ken-guru/git-city/issues/16), [Highways](https://github.com/ken-guru/git-city/issues/22).

### Extract
- web-tree-sitter (WASM) behind a pluggable **extractor** interface turns a blob into raw specifiers with kind flags: static, dynamic, type-only, re-export, require.
- Results are cached by blob ID.
- **v1 extractors:** TS, TSX, JS and Python.
- **⏭ Later:**
  - **Java and Kotlin:** costed in [Cost of supporting Java and Kotlin in v1](https://github.com/ken-guru/git-city/issues/28) and postponed until after v1.
  - Go, Rust, C#, Ruby, PHP, C and C++. Files in unsupported languages still become Buildings, just without Roads.

### Resolve
- Specifiers are resolved against each commit's in-memory path set. No filesystem and no `node_modules`.
- **TS/JS** follows TypeScript's lookup order:
  - `./x.js` → `x.ts`, and index files;
  - tsconfig `paths` and `baseUrl` with `extends`;
  - package.json `imports` (`#`), self-reference and workspace package names;
  - `exports` and `dist` remapped back to source.
- **Python:**
  - leading-dot relative imports;
  - absolute imports under inferred source roots (repo root, `src/`, pyproject directories, plus config);
  - `from a import submodule`;
  - PEP 420 namespace packages.
- **Incremental:** re-resolve through a reverse index of probed paths, or fully when a resolver config file changed.
- **Test oracles:** enhanced-resolve or oxc-resolver, plus dependency-cruiser's fixtures.

### Classify
- **Resolves to a repo file:** a **Road** connection, file to file.
- **Matches a declared dependency:** an **External Dependency** import. Matching is by normalised name: npm exact, Python normalised. Project-to-import-name tables are **⏭ Later**.
- **Anything else is dropped:** builtins, the standard library, transitive and undeclared packages.

### External Dependencies
- **What counts:** direct dependencies declared in a Module's manifest. That means `dependencies`, `devDependencies` and `peerDependencies` in `package.json`, plus `pyproject.toml` and `requirements*.txt`.
- **Not used:** lockfiles (transitive dependencies are **⏭ Later**).
- **Existence follows declarations,** not imports.
- **Grouping:**
  - by npm scope, or by a shared first name token that at least 2 dependencies share or that is itself a package, minus a stoplist;
  - `@types/x` folds into `x`, and `@babel` merges with `babel-*`;
  - config can override grouping.
- **External City:** a group with **≥ 3 distinct members** ever (configurable 3–5). There are **at most 16**; the largest win by member count, then by declarations. Everything else goes to the **Outskirts**.
- **Promotion:** a group that later reaches the threshold is promoted at that commit.

### Strength
- **Road strength** from District A to B is the number of file-to-file import edges.
- **Highway strength** is the number of importing files matched to the dependency. A declared dependency with no matching import still gets 1.

---

## 5. Model: Buildings, Modules and events

Sources: [Building shape](https://github.com/ken-guru/git-city/issues/7), [Identity](https://github.com/ken-guru/git-city/issues/13), [Building generator](https://github.com/ken-guru/git-city/issues/11).

### Building attributes
All of these are computed by the CLI.

| Attribute | Rule | Tuning default |
|---|---|---|
| Floors | ⌈√lines ÷ k⌉, at least 1, capped | k = 3, cap 32 |
| Width step | fan-in (distinct internal importers) into steps | 3 / 10 / 30 |
| Category | from path and extension, overridable by a `category` rule | — |
| Building type | from Category (table below) | — |
| Language | from extension, shown as roof and trim colour | — |
| Scaffolding | on while ≥ 4 changes in 14 days of Timeline time | 4 / 14 d |
| Seed | City seed + birth-order number | — |

| Category | Building type |
|---|---|
| Source code | Office tower |
| Tests | Laboratory: low and wide, rooftop dish |
| Docs | Library: columns, pitched roof |
| Config and manifests | Utility: water tower or silo |
| Build, CI and scripts | Factory: sawtooth roof, chimney |
| Data | Storage: cylindrical tanks |
| Assets | Warehouse: wide shed |
| Generated, vendored, lockfiles | Rail yard or parking lot: flat, height capped very low |
| Unknown | House |

- Dot-directories are classified like any other path: `.github/` is Build/CI, `.vscode/` is Config.
- **⏭ Later:** age weathering of materials.

### Modules and Districts
- **What a Module is:** a directory below the root with a package manifest. Any other file belongs to its top-level directory's Module. A root manifest never forms a Module; its Highways leave from the City centre.
- **Neighbourhoods:** exactly one nested level. Anything deeper belongs to its nearest Neighbourhood.
- **A manifest appearing partway through history:**
  - if the Module already existed when its first files arrived, it becomes its own village;
  - otherwise it **splits off in place**, with an eased recolour and rename and no Lot moving;
  - removing the manifest merges it back the same way.

  A District that merged back is gone for good; if the directory becomes a Module again, that is a new District.

### Events
These are the events the chunks carry.

| Event | When | Treatment |
|---|---|---|
| build | file added | foundation, then Floors rise |
| grow / shrink | Floors or width step change | Floors added or removed from the top |
| scaffolding on / off | churn threshold crossed | scaffolding and crane |
| Relocation | moved to another directory | same Building (seed, name, age) torn down, rebuilt on a new Lot in the target Neighbourhood's current Block |
| rename in place | same directory | no animation; display name only |
| whole-directory move | ≥ 80% of a directory's files go to one new directory in one commit | Neighbourhood's Blocks relabelled; nothing rebuilt |
| Renovation | Building type changes | rebuilt as the new type on the same Lot |
| language change | extension changes | roof and trim colour eases |
| demolish | file deleted | sinks into dust; the Lot stays empty forever |
| District split / merge | manifest added / removed | paving colour and name ease |
| village founded | first file of a new village | — |
| Road Lanes | strength changes | Lanes ease |
| External City in / out, Highway built / dismantled, promotion | declarations change | §7 |

A file re-added at the same path is a **new Building on a new Lot**.

### Lots
- **Sizing:** a Lot is sized for the widest step its Building ever has on it, **plus one step of headroom** (the widest step needs none). Height never needs more Lot.
- **Clamp:** if a re-run still outgrows a Lot, the footprint is clamped to it. The Building still gets taller and still gains Lanes.

---

## 6. Layout: villages, Blocks and Countryside

Sources: [City layout](https://github.com/ken-guru/git-city/issues/12), [Countryside](https://github.com/ken-guru/git-city/issues/21). The prototype on `prototype/countryside` is the reference implementation.

### Founding and growth
Everything is decided in history order.
- **Founding:**
  - The first village sits at the centre.
  - Each new village is founded at the free spot nearest the centre that keeps **village spacing** (default **10 Blocks**) of open land from every existing village.
  - Each village sits on a grid turned by a seeded angle.
- **Blocks:** 2 × 4 Lots in offset brick rows, each owned by one Neighbourhood.
- **Growth:**
  - A Neighbourhood that needs room claims the free Block spot nearest its village centre.
  - **High cohesion:** a slack of 8 Blocks keeps Neighbourhoods next to their own Blocks.
  - A village keeps at least one Block of open land from its neighbours unless it has nowhere else to grow.
- **Lots** are handed out in birth order, never moved and never reused.
- **Wider footprints inside a uniform Block:** the method is left to implementation. It must stay deterministic and never move an existing Lot. A Lot may span several unit slots.

### Countryside
Everything here is seeded and fixed, and it never represents anything in the repo.
- **Terrain:** gentle hills (relief ≤ 2.6), and mountains far from the centre (≤ 15, no snow).
- **Rivers:** **2 rivers** by default (1–3), as meandering polylines with sandy banks.
- **Vegetation:** a muted field patchwork and low-poly cone forests.
- **Villages avoid rivers and hills.** When there is no room, the rule relaxes in two steps: first allowing hills, then anything.
- **Scenery fades out** where a Block is claimed next to it.
- **Style A (muted naturalistic):** every colour sits in the green to yellow-green band that District paving never uses, dimmer than paving, with light and dark variants.
- **Style only paints.** Relief and density are separate settings that default to style A's values.

---

## 7. Roads, Highways and External Cities

Sources: [Road and Lane geometry](https://github.com/ken-guru/git-city/issues/20), [Highways](https://github.com/ken-guru/git-city/issues/22).

### Roads between villages
- **Network:** one shared network, a **relative-neighbourhood graph** over the village centres.
- **Routing:**
  - each District-to-District connection takes the shortest path;
  - a Road carries the **sum of all connections** passing over it, per direction;
  - a Road no connection uses is an **unpaved track**.
- **Lanes per direction:** 1 + ½·log₂(strength), rounded down and capped at **6**. **Every Road has at least 1 Lane each way.**
- **Look:**
  - gently curved ribbons (a seeded Bézier bow plus a noise wobble) that follow the terrain;
  - asymmetric halves;
  - a double centre line, and dashed lane dividers;
  - bridges as wide as the road where it crosses a river.
- **Over time:** a Road is built outward from the older village when its first connection appears, and is trimmed at each village edge as villages grow. Lane counts ease.

### Roads inside a District
- **Streets:** connections between Neighbourhoods run along the Block streets.
- **Width:** streets widen with strength, up to about **2× base width**.

### Highways and External Cities
- **Orbital motorway:** a ring on the horizon around the Countryside.
  - **Access Highway:** one per declaring District, from its village edge to the ring. The root manifest's access road leaves from the City centre.
  - **Spur:** one per External City.
  - **Ring segments** carry every dependency travelling along the shorter arc, so their Lanes add up.
- **External City:**
  - **Placement:** placed once, at the angle of the villages that first declared it, spaced apart from the others by angle, just beyond the ring.
  - **Look:** hazy, desaturated towers sized by group weight. The Outskirts is a single low sprawl.
- **Horizon:**
  - **Distance:** set from the City's extent.
  - **On re-runs:** when a re-run finds the City has outgrown it, the ring, spurs and External Cities move outward. These are not Lots, so this is allowed.
- **Look of Highways:** darker asphalt than Roads, wider Lanes, white markings, nearly straight with a slight bow, and bridges. Each direction keeps at least 1 Lane.
- **Arrival:** the External City fades in, then its Highway is built outward.
- **Departure:** the Highway is dismantled, then the External City fades away once its last Highway is gone.

---

## 8. Names, privacy and Themes

Sources: [Privacy model](https://github.com/ken-guru/git-city/issues/6), [Generated names](https://github.com/ken-guru/git-city/issues/10), [District colour](https://github.com/ken-guru/git-city/issues/19), [External Dependencies](https://github.com/ken-guru/git-city/issues/16).

### Defaults
| Data | Default |
|---|---|
| File, directory, Module and repo names | hidden; shown as a Generated name or a Label |
| External Dependency names | hidden; External Cities get Generated names |
| Dates | to the day; exact times opt-in |
| Commit hashes, remote URLs, repo name | never in the output; commits are sequence numbers |
| Contributors | off |
| Commit messages | off |
| Email addresses | never |

### Display-name precedence
**Pseudonym → Real name (only when revealed) → Generated name → Label.**
- A revealed Module can keep its Generated name as a subtitle.
- **Labels** are the type plus birth order ("TypeScript file 412"), never a hash.

### Rules
- **One ordered list,** last match wins: the shared config's rules, then the personal config's.
- **Targets:** path glob, module, **Concept**, contributor, `external:`.
- **Actions:** `pseudonym`, `reveal`, `allow` (a deliberate near-miss), `category`.
- **Concept Pseudonyms** replace the word everywhere, keeping its case. That includes file names, Modules, External Dependency names, Generated names and (best-effort) commit messages.

### Contributors
They appear only when opted in in config. There are four levels:
- **off:** no markers, legend or names.
- **anonymous:** "Contributor 9", numbered by first commit.
- **generated:** themed person names, unique and leak-checked.
- **real:** names after `.mailmap`, with contributor rules for per-person Pseudonyms.

All bots are grouped as **Automation**.

### Generated names
| Thing | Form | Example (medieval) |
|---|---|---|
| District | proper name + Role noun | "Ashford Keep" |
| Neighbourhood | proper name + street suffix | "Mill Lane" |
| External City, the City | proper name | "Thornwick", "Brindlemere" |
| Contributor (generated level) | person name | "Elric Thatcher" |
| File | Label | "TypeScript file 412" |

- **Seed:** the root commit hash (never in the output) + birth order + Theme. `naming.seed` overrides it.
- **Stability:**
  - proper names never change during an item's life;
  - Role nouns are fixed for a whole output;
  - across re-runs, a Role switches only when another Role clearly dominates (hysteresis, kept in run state).
- **Uniqueness and leak checks:**
  - names are unique within a City;
  - a candidate is rejected if it contains a hidden Real name, Concept or Contributor name, checked case-insensitively and with near-miss matching.
- **Roles:**
  - **From:** path tokens matched against a curated vocabulary (auth, api, ui, web, test, docs, db, models, cli, infra, utils, core…), plus the District's Category mix.
  - **Never from:** manifest free text.
- **Namer interface:** inputs are structural metadata only. The Theme namer is the only v1 implementation. **⏭ Later:** an LLM namer behind the same interface and checks.

### Themes
- **Format:** a data-only JSON pack validated against a published schema, executing no code.
- **Contents:** word pieces, street suffixes, a Role-noun table covering every Role plus a fallback, display metadata, and an optional palette.
- **v1 ships** **modern** (the default) and **medieval**. They load through the same loader that will later take a file path.
- **⏭ Later:** user Theme files.
- **Docs:** a "Writing a theme" guide.

### District colour
- **Hue = Role.** Each District also gets a seeded offset of ±15% saturation and ±6% lightness, kept for life.
- **Fallback Role:** near-neutral stone.
- **A District that splits off** takes the lightness offset on the opposite side from its parent's.
- **Paving:**
  - medium-low saturation at a fixed lightness per page theme (light and dark);
  - never uses the yellow-green to green band.
- **Where it appears:** only on paving, on the ribbon and its tooltip swatches, and on the edges of District labels. **Colour is never the only cue.**
- **Default palette:** tests amber, docs violet, API orange, UI rose, data rust, build/CI slate-blue, config teal, auth crimson, CLI indigo, infra steel, utils sand, core blue.

### Checking an output
- **Build summary:**
  - what was revealed, and how many names;
  - every detected External Dependency;
  - near-miss warnings: edit distance 1–2 scaled to length, case and separator variants, a term split across a camelCase or path boundary.
- **`--strict`:** near-misses fail the build.
- **Final scan:** before the swap, every output file is scanned for hidden Real names and Concepts with the same matching, and any hit fails the run.
- **`git-city audit`:** lists every string in `strings.json`.
- **Never in the output:** the mapping between Real names and Pseudonyms.
- **Documented residual risks:** structural fingerprinting of a known public repo, and regenerating seeded names to confirm a guess. Setting `naming.seed` removes the second.

---

## 9. Output format

Sources: [Data format](https://github.com/ken-guru/git-city/issues/9), [Degradation](https://github.com/ken-guru/git-city/issues/25), [Packaging](https://github.com/ken-guru/git-city/issues/26).

```
git-city-site/
  index.html             page shell
  assets/page.<hash>.js  three.js + viewer bundle (keeps the three.js MIT notice)
  world.bin              always fetched fresh; lists current chunk names
  strings.json           every human-readable string, and nothing else carries text
  chunks/0000.<hash>.bin …
```

### World file
Everything that never changes during playback.
- `formatVersion`;
- villages (centre, angle, founding commit), Blocks (owner, position, claimed commit) and Lots;
- District areas with split and merge times, colours and name ids;
- Countryside seed and parameters;
- the road network, the horizon ring and External City slots;
- the commit list (sequence number, day and Step), chunk boundaries and names.

### Chunks
- **Contents:** a **snapshot** at the chunk's first commit, plus the **events** inside it (§5).
- **Cut:** a new chunk starts at whichever comes first, **2,000 commits or about 256 KB compressed**.
- **Seeking:** jumping to a commit loads one chunk, applies its snapshot and replays events to the target.
- **Re-runs** rewrite only the last chunk and append the rest. Regrouping Steps may rewrite older chunks.

### Encoding
- **Binary, numbers only:** column-oriented typed arrays that load straight into GPU buffers.
- **Text:** all of it goes in `strings.json`, which is fed only by the naming step's display-name call.
- **Opt-in fields:** Contributors and commit messages are string ids on commit records. When the option is off, they are absent entirely.
- **No raw counts:** the output has no raw line or importer counts.

### Versioning
- **One `formatVersion`.** The page and data always come from the same run.
- **Mismatch:** the page shows a message instead of playing.
- **Format change:** a release that changes the format rewrites all chunks from the cache.

### Budget at 50k commits / 20k files
- **To first play:** world file plus first chunk under **1 MB** compressed.
- **Total:** under **15 MB** compressed, excluding the bundle.
- **Reporting:** the build summary reports actual sizes.

### Steps for long histories
When the output would exceed the budget, or history passes about 50k commits:
- **older** commits are grouped into Steps of a day, then a week, then a month, using the smallest Step that fits;
- recent history stays per commit;
- layout and Lots are unchanged.

`scale.timeline` in config pins this: `"commit"` refuses grouping and only warns; `"day"`, `"week"` or `"month"` force that Step.

### Serving
- **Chunk names:** index plus a content hash, so hosts can cache them forever. The world file is never cached.
- **Over HTTP:** GitHub Pages, any static host, or `git-city serve`.
- **From disk:** opened from `file://`, the page shows a one-line explanation and the command to run.

---

## 10. CLI surface

Sources: [CLI and config](https://github.com/ken-guru/git-city/issues/17), [Degradation](https://github.com/ken-guru/git-city/issues/25), [Packaging](https://github.com/ken-guru/git-city/issues/26).

### Commands
Each also runs as `git city …`.

| Command | Does |
|---|---|
| `git-city` / `git-city build` | build or resume |
| `git-city serve [dir]` | localhost only, the first free port from 4173 up (about 10 tries; `--port` names one exactly and fails if it is taken; `--open`); correct content types; world file never cached; no live reload |
| `git-city audit [dir]` | list every string in the output |
| `git-city init [--shared]` | write a commented starter config (personal by default) listing detected Modules, External Dependencies and Themes |
| `git-city cache status\|clear` | inspect or remove `.git/git-city/` |

### Config
- **Files:**
  - shared: `git-city.config.jsonc` at the repo root, committed;
  - personal: `.git/git-city/config.jsonc`, whose rules come last;
  - `--config <path>` replaces both.
- **Format:** JSONC with a published schema; it never executes code.
- **Sections:**
  - `rules` (§8);
  - `contributors` (off / anonymous / generated / real);
  - `commitMessages`, `exactTimes`;
  - `theme`, `naming.seed`;
  - `externals` (grouping overrides, threshold 3–5);
  - `exclude` (path globs);
  - `scale` (`timeline`);
  - `tuning`.
- **`tuning`:**
  - Floor k and cap;
  - fan-in steps;
  - scaffolding threshold and window;
  - village spacing and cohesion;
  - rivers, relief and density;
  - street-width cap.

  It changes the look, never privacy.
- **⏭ Later:** `collapse` rules, which turn a whole directory into one Building. Changing `exclude` or `collapse` asks for a full rebuild, with a warning that the layout changes.

### Flags
**Flags can only make output more private.** Anything that reveals more lives only in config.

| Kind | Flags |
|---|---|
| run | `--branch`, `--out` (default `git-city-site/`), `--fresh`, `-C <path>`, `--wait` |
| presentation | `--theme`, `--seed` |
| output | `--json`, `--quiet` |
| more private | `--strict`, `--private` (ignore every Reveal) |

When a flag and the config set the same thing, the flag wins.

### Terminal
- **Interactive:** progress per phase, then the build summary: privacy summary, near-misses, sizes against budget, any Steps used, scale warnings, and the output path.
- **CI:** one-line logs.
- **First run:** a hint to add the output folder to `.gitignore`. GitCity never edits `.gitignore` itself.
- **Help:** `-h` is documented, and a man page ships, because `git city --help` asks git for a man page.

### Exit codes
| Code | Meaning |
|---|---|
| `0` | success (possibly with warnings) |
| `1` | error |
| `2` | privacy check failed |
| `3` | another run holds the lock (no `--wait`) |

### Scale warnings
**Warn and adapt, never refuse.**
- **More than 20k Buildings standing at once:** the page will lean on level of detail; consider `exclude`.
- **Over the size budget:** Steps are applied as in §9.

---

## 11. The page

Sources: [Rendering](https://github.com/ken-guru/git-city/issues/4), [Building generator](https://github.com/ken-guru/git-city/issues/11), [Player](https://github.com/ken-guru/git-city/issues/18), [Showcase camera](https://github.com/ken-guru/git-city/issues/23), [Contributors](https://github.com/ken-guru/git-city/issues/24), [Degradation](https://github.com/ken-guru/git-city/issues/25).

### Rendering
- **Library:** three.js `WebGLRenderer` with `MeshLambertMaterial({ flatShading: true })`.
- **⏭ Later:** `WebGPURenderer`.
- **Buildings: modular kit (art direction B).**
  - **Instancing:** one `InstancedMesh` per Building type, plus one for scaffolding and cranes, about 10 draw calls.
  - **Shape:** each type is a unit-height kit that the vertex shader stretches to its Floors, with roof props in the language colour.
  - **Windows:** seeded and painted per Floor in the fragment shader, some lit. They fade with distance to avoid shimmer.
- **Animation:** per-instance event times and one `uTime` uniform drive every eased transition in the shader.
  - An empty Lot **collapses its instance entirely**; flattening it z-fights the ground.
- **Other layers:** roads, Highways, Countryside (about 6 draw calls, up to about 14k instanced trees), External Cities and labels.
- **Light and dark** page themes.
- **Level of detail:** always on, driven by measured frame rate.
  - Distant Buildings drop windows and props, and far Blocks draw as simple masses.
  - Scenery thins with distance.
  - Distant labels are hidden.
  - Slow devices drop a render-resolution step.

### Shared animation timing
Units are **commits of Timeline position**, as in every prototype.
- **Easing:** ease-out cubic.
- **Base duration:** **D = 4 commits**.

| Transition | Length |
|---|---|
| Building build, grow, shrink, demolish; Renovation (down, then up) | D |
| Relocation | demolish on the old Lot over D, build on the new over D, starting together |
| Language colour, District split/merge recolour and rename | D |
| Scaffolding on and off | D/2 |
| Road built outward | 2D |
| Lane change on a Road or Highway | D |
| Village edge and scenery clearing | D |
| External City fade in or out | D |
| Highway built or dismantled | 2D, after or before the fade |
| Contributor marker | settles in over about 1 commit, holds, fades by 6 commits |

- **Speed floor:** so busy periods at high speed don't look like popping, every transition lasts **at least 0.25 s of viewing time** at the current speed.
- **Reduced motion:** transitions shorten to cross-fades, and the camera cuts.

### Player
- **Layout:** a story ribbon along the bottom, holding:
  - controls: play/pause, play backwards, jump to latest;
  - the date and "commit k of N";
  - the latest identity event as a caption (hidden on phones);
  - visible speed and mode buttons;
  - the ribbon itself.
- **Ribbon:**
  - activity per stretch, stacked in District colours and scaled by square root;
  - year ticks;
  - a diamond where a village is founded, and a tick for a split or merge;
  - the playhead.
- **Tooltip:** on hover, or while a finger is on the ribbon on phones. It lists:
  - the date range;
  - commits and file changes (a grouped Step says "12 commits");
  - the busiest Districts;
  - villages founded, splits and merges, renamed streets, and Relocations.
- **Speeds:**
  - **Real time (the default):** 1 week/s, **1 month/s** (default), 3 months/s or 1 year/s. A quiet stretch never takes longer than one week, and same-day commits are spread by about 0.15 day.
  - **Per commit:** 5, 15, 40 or 120 commits/s.
- **Mode switch:** switching between Real time and Per commit keeps the current commit.
- **Buffering:**
  - chunks stream in order, and loaded history shows darker on the track;
  - scrubbing past the loaded part shows a dashed target and "Loading this part of history…", and the City holds until that chunk arrives;
  - playback buffers the same way.
- **Keyboard:** `Space`, `←`/`→`, `Shift`+arrows, `Home`/`End`, `R`.
- **Accessibility:** the scrubber is a native range input with a text description.

### Camera
- **Default:** orbit controls.
- **During playback:** the camera focuses on the cluster with the most changes in the last 15 commits.
  - It switches only when another cluster is 1.5× busier.
  - It keeps the viewer's angle and distance.
  - The viewer can turn this off.
- **Showcase:** postcards, once history is up to date.
  - **Shots:** a wide establishing shot, then the **6 busiest clusters** of standing Buildings (by changes in the last 120 commits, then by size; at least 4 Buildings each).
  - **Pacing:** about 7 s each with a slow push-in, looping, with the District's display name as a caption.
  - **Framing:**
    - aim at the centre of the Buildings standing now, at about Building height;
    - camera height 1.5 + 0.15 × radius;
    - set back 1.6 × radius + 5, on the side facing the land's centre;
    - `lookAt` every frame.
  - **Starts** after **12 s idle** at the latest commit.
  - **Stops:** any input takes over, and it resumes after 12 s idle. Playing or scrubbing turns it off.
  - **Reduced motion:** cuts only.

### Contributors and commit messages
Opt-in only.
- **Markers:** a pin over each changed Building, up to **12 per commit**, fading after about **6 commits**.
- **Colours:** the **top 8** people each get a colour (clear of paving and countryside), everyone else is grey, and Automation has its own grey.
- **Legend:** the top 8 with commit counts, "+N more people" and Automation. Hover or tap lights up a person's Buildings from the last 120 commits.
- **Commit messages** (a separate opt-in): a caption with the date, Contributor and message. Above about 6 commits in 2 s it becomes a summary: "23 commits by 4 people · latest: …".

### Labels
- **What:** District and External City labels show display names, with the District's colour on their edge.
- **Distance:** hidden past a distance.

---

## 12. Packaging and distribution

Source: [Packaging](https://github.com/ken-guru/git-city/issues/26).

- **npm:** published as unscoped **`git-city`** with `bin: { "git-city": … }`. The fallback is `@ken-guru/git-city`.
- **Node:** `engines.node: ">=22"`, ESM, tested on Node 22, 24 and 26.
- **Layout:** `dist/cli/`, `dist/page/` (pre-built viewer) and `dist/grammars/` (`.wasm`, CLI only), with `files: ["dist", "THIRD_PARTY_NOTICES.md"]`.
  - At runtime the CLI finds the page via `new URL('../page/', import.meta.url)` and copies it with `fs.promises.cp`.
- **Grammars:** taken from the official per-language packages as devDependencies, with only their `.wasm` files copied. Avoid `tree-sitter-wasms`, whose grammars don't load in current web-tree-sitter.
- **Dependencies:** three is a build-time dependency only.
- **Running:**
  - `npx git-city` works;
  - `git city` works after `npm i -g git-city`, or with `npx -p git-city git city`;
  - a Windows CI smoke test checks the extensionless shim.
- **Licences:** everything bundled is MIT. The page keeps the three.js notice (esbuild legal comments stay on), and `THIRD_PARTY_NOTICES.md` covers web-tree-sitter and each grammar.

---

## 13. Build parts

These are for slicing into build tickets, in dependency order. Each part should land with tests against small fixture repos, plus the `changesets/changesets` history used by the prototypes as a realistic check.

| # | Part | Covers | Depends on |
|---|---|---|---|
| P1 | Project skeleton and packaging | TS/ESM layout, build of CLI and page, npm `bin`, notices, CI on Node 22/24/26 and Windows | — |
| P2 | History extraction | §3 extraction, layer 1 sizes and lines, layer 2 commit records | P1 |
| P3 | Cache, resume and locking | layers and version stamps, checkpoints, rollback on rewrite, lock, `--fresh`, `cache` command | P2 |
| P4 | Import extraction and resolution | extractor interface, TS/JS and Python, resolver, classification, manifests, External Dependencies and grouping | P2 |
| P5 | Model | Buildings, Modules and Districts over time, events, Floors, widths, Categories, scaffolding, Lots | P2, P4 |
| P6 | Layout | villages, Blocks, Lots, Countryside obstacles and seeded scenery parameters | P5 |
| P7 | Networks | Road graph, routing, Lanes, inner street widths, horizon ring, access roads, spurs, External City placement | P4, P6 |
| P8 | Naming and privacy | config loading and schema, rules, Concepts, display-name precedence, Themes (modern, medieval), Roles, Generated names, Labels, near-miss, Contributors and `.mailmap` | P5 |
| P9 | Output writer | world file, chunks, `strings.json`, Steps, budget, staging and swap, final scan | P5–P8 |
| P10 | CLI surface | commands, flags, progress and summary, `--json`, exit codes, `init`, `audit`, `serve`, man page | P3, P8, P9 |
| P11 | Page: data and time | loader, chunk streaming and seeking, format check, `file://` notice, play-time mapping, Steps | P9 |
| P12 | Page: City rendering | Building kit and shader animation, scaffolding, paving and colour, light/dark, LOD | P11 |
| P13 | Page: land and networks | terrain, rivers, fields, forests, clearing, Roads, bridges, Highways, ring, External Cities | P11 |
| P14 | Page: player | ribbon, tooltip, speeds and modes, buffering, keyboard, accessibility | P11 |
| P15 | Page: camera | orbit, follow-the-changes, showcase postcards, reduced motion | P12, P13 |
| P16 | Page: people and labels | Contributor markers, legend, commit captions, District and External City labels | P12, P14 |
| P17 | Docs | README, config reference and schema, "Writing a theme", privacy and residual risks | P8, P10 |

---

## 14. Later (beyond the v1 cut)

Each item has a follow-up ticket labelled `after-v1`, to pick up once v1 has shipped.

- [Import extractors for more languages](https://github.com/ken-guru/git-city/issues/29): Go, Rust, C#, Ruby, PHP, C and C++.
- [Java and Kotlin support](https://github.com/ken-guru/git-city/issues/37): the costing and the proposed first scope are in [Cost of supporting Java and Kotlin in v1](https://github.com/ken-guru/git-city/issues/28).
- [Python project-name to import-name mapping](https://github.com/ken-guru/git-city/issues/30)
- [Lockfiles and transitive dependencies](https://github.com/ken-guru/git-city/issues/31)
- [Collapse rules: a directory as one Building](https://github.com/ken-guru/git-city/issues/32)
- [Age weathering of Building materials](https://github.com/ken-guru/git-city/issues/33)
- [User Theme files loaded from a path](https://github.com/ken-guru/git-city/issues/34)
- [LLM namer behind the Namer interface](https://github.com/ken-guru/git-city/issues/35)
- [WebGPURenderer upgrade](https://github.com/ken-guru/git-city/issues/36)

## 15. Out of scope

- Visualizing several branches.
- District nesting deeper than 2 levels.
- A single-file `.html` output mode.
