# Sourcing the Well-known package allowlist

Research for [#14](https://github.com/ken-guru/git-city/issues/14), part of the map [#1](https://github.com/ken-guru/git-city/issues/1).
Researched 2026-10-11.

**The question:** where does GitCity's offline **Well-known package** allowlist come from, how is it built and kept current, and how does it interact with grouping External Dependencies by name prefix?

**Constraint** (from [#6](https://github.com/ken-guru/git-city/issues/6)): the list is bundled with the CLI, and nothing is looked up in a registry at run time.

## Recommendation

1. **Build the list ourselves in a release-time script. Do not vendor a third-party list.** The script ranks each ecosystem from first-party or openly licensed data and writes one sorted, newline-separated file per ecosystem. These files are committed to the repo, so every change shows up in review.
   - **npm:** a package is on the list if it has **≥ 1,000,000 weekly downloads or ≥ 500 dependents**. This is npm's own definition of a "high-impact" package. It gives about **17k names**, about **320 KB raw and 110 KB gzipped**.
   - **PyPI:** the **top 15,000 projects by downloads over the last 30 days**, which cuts off at about 50k downloads a month. The list stores **import names, not project names**, so it needs a mapping step. That gives about **15k names**, about **215 KB raw and 90 KB gzipped**.
   - **Cost to install size:** together the two lists add about **200 KB to the npm tarball** and about **0.5 MB unpacked**.
2. **Refresh once per release, with a monthly scheduled job that opens a PR.** Add hysteresis: once a name is on the list, it stays until it falls below half the cut-off. Without this, names would flip between Real and hidden from one release to the next.
3. **Decide whether a package is Well-known one name at a time, before any grouping, and only on an exact match.** A Well-known name never makes a whole prefix or scope Well-known. Hidden packages never join a group whose label comes from a Well-known name. They group only with other hidden packages, under a Label. This closes the "private package that shares a public prefix" leak described in [Prefix grouping](#prefix-grouping-and-the-list).
4. **Plan for the future extractors now, but ship only npm and PyPI.** Go, Maven, Cargo and NuGet each have a usable source (see [the table](#future-ecosystems)). Maven and NuGet also need a map from namespace to package, because Java and C# imports are namespaces, not package coordinates.

## npm

### Sources

| Source | What it gives | Licence or terms | Verdict |
|---|---|---|---|
| npm downloads API (`api.npmjs.org/downloads/point/{period}/{pkg}`) [^npm-dl] | Download counts per package, for periods up to `last-year`. Bulk queries take up to 128 packages, but *"Scoped packages are not yet supported in bulk queries."* There is **no "top packages" endpoint**. | No licence or terms are stated on the docs page. Data comes from npm's first-party API. | **Use it** to rank candidates. Scoped names (about 43% of the list) need one request each. |
| deps.dev BigQuery `bigquery-public-data.deps_dev_v1` [^depsdev] | Tables include `Dependents` and `Dependencies` for npm, Go, Maven, PyPI and Cargo. There is no precomputed dependents count; the docs give an example query that computes one. | *"This generated data is available under a CC-BY 4.0 license."* | **Use it** for the dependents criterion and as the candidate set. Needs attribution. |
| ecosyste.ms packages API [^eco] | Sorts by `downloads` and `dependent_packages_count` across all of npm. | Data is **CC BY-SA 4.0** (code is AGPL). Free tier rate-limited. | **Seed only.** Share-alike would extend to a bundled list derived from it. |
| [`npm-high-impact`](https://github.com/wooorm/npm-high-impact) (wooorm) [^nhi] | A ready-made list using the same ≥1M weekly downloads or ≥500 dependents rule. Version 1.13.0 has 17,338 names. | Package is MIT. It is crawled from ecosyste.ms, so the data underneath is CC BY-SA. The author warns *"download counts can be gamed"*. | **Use as a reference** to check our own build, and as a candidate seed. |

### Cut-off

**Use npm's own "high-impact" threshold**, which GitHub defined when it enforced 2FA: packages with *more than 1 million weekly downloads or 500 dependents* [^gh2fa]. This has three advantages:

- It is a threshold the registry itself uses, so it is easy to defend in the docs.
- It is not arbitrary.
- `npm-high-impact` gives an independent build to compare against.

### Size

These figures come from `npm-high-impact@1.13.0`. Raw size is the names joined by newlines; gz is gzip -9.

| Slice | Names | Scoped | Distinct scopes | Raw | gz |
|---|---|---|---|---|---|
| ≥1M/week **or** ≥500 dependents | 17,338 | 7,439 | 1,001 | 317 KB | 111 KB |
| ≥1M/week only | 15,916 | 7,186 | 960 | 292 KB | 102 KB |
| ≥500 dependents only | 4,687 | 996 | 188 | 76 KB | 28 KB |
| top 10k by downloads | 10,000 | 4,145 | 602 | 178 KB | 62 KB |
| top 5k by downloads | 5,000 | 1,790 | 289 | 87 KB | 30 KB |
| top 1k by downloads | 1,000 | 284 | 46 | 16 KB | 6 KB |

The largest scopes on the list are `@types` (883), `@aws-sdk` (179), `@babel` (177), `@turf`, `@storybook` and `@stdlib`.

A live check on 2026-10-11 showed that download ranks move between builds. For example, the package ranked about 10,000th in the dataset now gets about 640k downloads a week. A fixed top-N would therefore churn more than the threshold rule.

### Build steps

1. **Candidates.** Take the union of three sets:
   - packages from deps.dev with ≥ 500 dependents;
   - the previous list (for hysteresis);
   - optionally, an ecosyste.ms or `npm-high-impact` seed, used only as candidate names.
2. **Rank by downloads.** Query `api.npmjs.org/downloads/point/last-week`:
   - unscoped names in bulk, 128 at a time;
   - scoped names one at a time, with `/` encoded as `%2F` [^npm-dl].

   For about 10k scoped names, this means thousands of sequential requests. That is acceptable for a release job, so throttle it.
3. **Filter.** Keep a name if it has ≥ 1M weekly downloads or ≥ 500 dependents. Keep a name that is already on the list until it falls below 500k downloads and below 250 dependents.
4. **Fold `@types/x`.** Keep `@types/*` entries only where `x` is also on the list or the `@types` name passes the threshold by itself. This matches the import resolver's rule that folds `@types/x` into `x`.

## PyPI

### Sources

| Source | What it gives | Licence or terms | Verdict |
|---|---|---|---|
| `bigquery-public-data.pypi.file_downloads` [^pypi-bq] | Every download, streamed in by Linehaul | *"The tables and its pertaining data are licensed under the Creative Commons License"*, which links to CC BY 4.0 | **Use it.** It is first-party. |
| `bigquery-public-data.pypi.distribution_metadata` [^pypi-bq] | Core metadata for every release | CC BY 4.0 | Useful for `Import-Name` where projects publish it (see below) |
| [`hugovk/top-pypi-packages`](https://github.com/hugovk/top-pypi-packages) [^hugo] | Monthly JSON of the top 15,000 projects by downloads over 30 days, taken from ClickHouse's ClickPy | **No licence declared** in the repo | **Use as a reference only.** It is fine for checking our build, but not for bundling. |

### Cut-off

The top **15,000** projects over the last 30 days, the same depth as hugovk's list. In the 2026-10-01 snapshot:

| Rank | Downloads per month at the cut-off | Raw | gz |
|---|---|---|---|
| 1,000 | 13.6M | 12 KB | 5 KB |
| 5,000 | 616k | 69 KB | 28 KB |
| 15,000 | 53k | 215 KB | 87 KB |

PyPI counts are inflated by CI and mirrors, which favours infrastructure projects. That is acceptable here, because we only need "publicly known name", not "popular".

### Project names are not import names

The import resolver keys Python External Dependencies by **top-level import name** ([#3](https://github.com/ken-guru/git-city/issues/3)). Project names often differ, for example `Pillow` gives `PIL`, `PyYAML` gives `yaml`, `scikit-learn` gives `sklearn` and `beautifulsoup4` gives `bs4`. PEP 794, *"Accepted"* on 2025-09-05, explains why: *"there is no clean, easy, accurate way to go from import name to project name and vice versa"*. It adds `Import-Name` and `Import-Namespace` fields in core metadata **2.5** [^pep794].

The build script should derive import names per project, in this order:

1. `Import-Name` and `Import-Namespace` from the latest release's metadata. This is the most accurate source, but only projects built with metadata 2.5 have it, and adoption is still early.
2. Otherwise, the top-level names in the latest wheel's `RECORD`: the first path segment, ignoring `*.dist-info`, `*.data` and `__pycache__`. Reading this means fetching wheel files at release time.
3. Otherwise, setuptools' `top_level.txt`, if present.
4. Otherwise, the normalised project name (lower-case, `-` replaced by `_`).

As a cross-check, use pipreqs' hand-curated `mapping` file (Apache-2.0, 1,157 import-to-project lines, for example `PIL:Pillow`, `cv2:opencv-python`, `sklearn:scikit_learn`) [^pipreqs].

**Collisions.** Some import names are provided by several projects, for example `jwt`. The import name is still a public string, so being on the list leaks nothing, whichever project provides it.

**Namespace packages.** `google`, `azure` and similar names appear only as `Import-Namespace` and must not be added as Well-known names by themselves. A top-level key cannot tell `google.cloud.storage` apart from a hypothetical private `google.acme`. In practice both are shown as `google`, so nothing private leaks. The known gap is that the import key is too coarse for namespace packages. That belongs to a later improvement of the Python extractor.

I could not test the PyPI JSON API or wheel downloads from this sandbox, because `pypi.org` was unreachable. Steps 1–4 come from the specs, not from a working run.

## Prefix grouping and the list

The import resolver groups External Dependencies like this ([#3](https://github.com/ken-guru/git-city/issues/3)):

- by npm scope;
- `@types/x` folded into `x`;
- on a shared first name token;
- `@babel` merged with `babel-*`;
- with overrides from config.

The privacy decision ([#6](https://github.com/ken-guru/git-city/issues/6)) shows Real names only for Well-known packages. Combining the two raises three questions.

**Is `@babel/*` Well-known as a group because `@babel/core` is on the list?** No. Whether a package is Well-known is a property of **one exact package name**, decided before grouping. Three cases:

- **A group made only of Well-known members** shows its Real label (`@babel`) and the members' Real names.
- **A group's label derived from Well-known members** is a string that is already public, so showing it is safe.
- **A package that is not on the list** (`@babel/acme-internal-preset`, `react-acme-widgets`) is hidden, as #6 requires.

**Could a private package leak through a shared prefix?** Yes, if hidden packages were allowed to join a Well-known group:

- **What it reveals.** Even with the private name replaced by a Label, putting it inside the `react` or `@babel` External City would show that the repo uses a non-public package **whose name starts with that prefix**. The member count would rise too.
- **How likely it is.** For npm scopes the risk is small but real. On the public registry a scope belongs to one org, so `@babel/x` should be Babel's. But private registries, workspace aliases and dependency-confusion setups can reuse public scopes. For unscoped first-token groups (`react-*`, `eslint-*`, `aws-*`) the risk is ordinary, because companies routinely name internal packages `eslint-config-acme` or `react-acme-ui`.

**Rule:**

1. Classify each package name as Well-known (exact match) or hidden.
2. Run the existing grouping rules **separately within each class**:
   - Well-known packages group with Well-known packages, using Real labels.
   - Hidden packages group with hidden packages under a **Label** (for example "External group 3"). Their names stay unknown, so even their prefix stays hidden, unless the user Reveals it or a Concept Pseudonym applies.
3. Fold `@types/x` into `x` only when both are in the same class.
4. Config grouping overrides are explicit user intent, so they may merge across classes. The privacy summary should count such a merge as a reveal.

**Near-miss detection** ([#6](https://github.com/ken-guru/git-city/issues/6)) also gains a check: warn when a hidden dependency name is within edit distance 1–2 of a Well-known name. The same rule catches typosquats and private forks such as `lodahs` or `lodash-acme`, which a user may not mean to show.

## Refresh cadence and install size

**When to run.** Run a `scripts/build-wellknown.ts` job:

- **before every release** (required), and
- **monthly in CI** (scheduled), opening a PR that shows the diff.

The repo stores each ecosystem's list as a sorted text file, plus a small JSON header:

- source snapshot dates;
- thresholds;
- counts;
- licence attributions, for deps.dev (CC BY 4.0) and PyPI BigQuery (CC BY 4.0). Both require attribution, so add a `NOTICE` entry.

**Hysteresis.** Hysteresis keeps names from flipping between releases. A re-run with a newer CLI could otherwise hide a name that an earlier output showed. Record the list version in the output's build metadata. The privacy summary should then report "N names newly Well-known or no longer Well-known since the last build".

**Install size.** npm and PyPI together add about **530 KB raw**, which is about **200 KB in the gzipped npm tarball**. That is small next to the grammar `.wasm` files the import extractor already vendors. Load each ecosystem's list lazily, the first time an extractor for that language runs, into a `Set<string>`.

## Future ecosystems

| Ecosystem | Popularity source | Licence or terms | Key and cut-off | Extra work |
|---|---|---|---|---|
| **Go** | deps.dev `Dependents` (Go is covered) [^depsdev]. proxy.golang.org publishes no download counts. pkg.go.dev's "imported by" count is an internal database field with no documented API [^pkgsite]. | CC BY 4.0 | Module path. Top ~5k modules by dependents. | Module paths include the host and org (`github.com/acme-internal/...`). The scope rule above applies at the org level, so `github.com/aws` being Well-known never makes another `github.com/*` org Well-known. |
| **Maven** | deps.dev `Dependents` [^depsdev]. Maven Central offers no public download statistics; publishers get theirs privately through Sonatype and Scarf [^scarf]. | CC BY 4.0 | `groupId:artifactId`. Top ~5k by dependents. | Java `import`s are **packages**, not coordinates. The list needs a package-prefix-to-artifact map built from the artifact jars at release time, or else Well-known means a **package prefix** derived from groupIds. That is riskier: `com.google.*` cannot be widened. |
| **Cargo** | crates.io daily database dump at `static.crates.io/db-dump.tar.gz`, *"updated every 24 hours"*. The API is limited to 1 request per second [^crates]. deps.dev also covers Cargo. | The dump's terms are in the tarball and were not checked here. deps.dev is CC BY 4.0. | Crate name with `-` changed to `_` (the `use` name). Top ~10k by recent downloads. | Small, because crate names map almost one-to-one to `use` roots. |
| **NuGet** | Search query service: results carry `totalDownloads`, with `skip` capped at 3,000 and `take` at 1,000 [^nuget]. | Microsoft API terms. Not a dataset licence. | Package ID. Top ~4k is all paging allows. | C# `using` names namespaces, not package IDs, so it needs a namespace map from package DLLs, as for Maven. deps.dev has no NuGet dependents data. |

## Residual risks and open points

- **Being on the list is not the same as being safe to show.** A private package that **exactly** shares a public Well-known name, for example an internal fork published as `lodash` to a private registry, will show its Real name. The name itself is public, so the string leaks nothing new, but it does suggest the repo uses that package. This is consistent with #6's documented risk of structural fingerprinting.
- **Gamed downloads** put some junk names on the npm list [^nhi]. Each one is still a public name, so this costs nothing in privacy.
- **Licences.** The deps.dev and PyPI datasets are CC BY 4.0, so attribution is needed. ecosyste.ms data is CC BY-SA 4.0, which is why it is used only as a candidate seed. hugovk's list declares no licence. Whether a list of names is copyrightable at all varies by jurisdiction. This is not legal advice; using attributed CC BY sources avoids the question.
- **Not measured.** I did not measure BigQuery query cost for a 30-day aggregate over `pypi.file_downloads` and the deps.dev dependents count. Run both once with `--dry_run` to see the bytes scanned before automating them.

## Sources

[^npm-dl]: npm registry docs, *download-counts.md*: https://github.com/npm/registry/blob/main/docs/download-counts.md. Verified live on 2026-10-11, e.g. `api.npmjs.org/downloads/point/last-week/react,lodash,express` and `.../@babel/core`.
[^depsdev]: deps.dev BigQuery dataset docs: https://docs.deps.dev/bigquery/v1/
[^eco]: ecosyste.ms pricing and licence: https://ecosyste.ms/pricing. Docs: https://docs.ecosyste.ms/docs/usage/
[^nhi]: wooorm/npm-high-impact README and `script/crawl-packages.js`: https://github.com/wooorm/npm-high-impact. Sizes were measured from the npm tarball of version 1.13.0.
[^gh2fa]: GitHub Blog, *Top-100 npm package maintainers now require 2FA*: https://github.blog/security/supply-chain-security/top-100-npm-package-maintainers-require-2fa-additional-security/. Changelog, *High-impact package maintainers now require 2FA* (2022-11-01): https://github.blog/changelog/2022-11-01-high-impact-package-maintainers-now-require-2fa/
[^pypi-bq]: PyPI docs, *BigQuery Datasets* (source: https://github.com/pypi/warehouse/blob/main/docs/user/api/bigquery.md), rendered at https://docs.pypi.org/api/bigquery/
[^hugo]: hugovk/top-pypi-packages: https://github.com/hugovk/top-pypi-packages. Snapshot `last_update` 2026-10-01, 15,000 rows. The GitHub API reports no licence.
[^pep794]: PEP 794, *Import Name Metadata*: https://peps.python.org/pep-0794/
[^pipreqs]: bndr/pipreqs `pipreqs/mapping` (Apache-2.0): https://github.com/bndr/pipreqs/blob/master/pipreqs/mapping
[^pkgsite]: golang/go#37912 *x/pkgsite: add import / imported by counts*: https://golang.org/issue/37912. pkgsite commit reading `search_documents.num_imported_by`: https://go.googlesource.com/pkgsite/+/24f7a580137ef38bca9fca65f4dbb3f113de6f3c
[^scarf]: Scarf docs, *Maven Central integration*: https://docs.scarf.sh/package-registry-integrations-maven-central/
[^crates]: crates.io *Data access* page (source: https://github.com/rust-lang/crates.io/blob/main/svelte/src/routes/data-access/%2Bpage.svelte), rendered at https://crates.io/data-access
[^nuget]: Microsoft Learn, *NuGet Search query service resource*: https://learn.microsoft.com/nuget/api/search-query-service-resource


---

## Update 2026-10-11: superseded, kept as a record of the path not chosen

**Status: superseded.** GitCity does **not** ship a Well-known package allowlist. An External Dependency is now any **direct dependency declared in a Module's manifest** (`package.json`, `pyproject.toml`, `requirements*.txt`, …). Every External Dependency name is **hidden by default** and shown with a Generated name or Label until the user Reveals it (for example `reveal external:*`). The decision and its reasoning are on the map, in the ticket [External Dependencies come from manifests](https://github.com/ken-guru/git-city/issues/16).

What follows is what we measured on the way, so a later popularity-based feature can start from data.

### Verification run (Verifying PyPI import-name mapping once pypi.org is allowed, #15)

Once `pypi.org` and `files.pythonhosted.org` were allowed, we built and ran the whole pipeline. Scripts are in [`pypi-allowlist/`](pypi-allowlist/).

**Ranking** ([`pypi_rank.py`](pypi-allowlist/pypi_rank.py)):
- **Source:** ClickPy, ClickHouse's public mirror of PyPI's download data (CC BY 4.0), at `sql-clickhouse.clickhouse.com` with user `demo`. No credentials are needed, unlike the BigQuery source this doc originally assumed.
- **Use the monthly table:** `pypi.pypi_downloads_per_day` is **incomplete** on the demo server. `boto3`, the top project, was missing from the top 3, and the result overlapped hugovk's list on only 4,991 of 15,000 projects. `pypi.pypi_downloads_per_month` for the last complete month matches exactly: 15,000 of 15,000, the same 53,155 cut-off, and boto3 at 2,460,723,068 for 2026-09.

**Mapping project names to import names** ([`pypi_import_names.py`](pypi-allowlist/pypi_import_names.py)):
- **How it reads wheels:** it fetches the latest release's JSON, then reads the wheel's zip central directory with HTTP range requests, never downloading the whole wheel.
  - Small wheels need a whole-file fallback, because the CDN answers a 64 KB tail range on a smaller file with **416**.
  - Ask for `Accept-Encoding: gzip`. The project JSON is the main cost: botocore is 3.8 MB uncompressed.
- **Namespace packages:** these must be walked down to dotted names. Otherwise `protobuf` and `google-cloud-storage` both come out as `google`, which would wrongly class every `google.*` import as Well-known.
- **PEP 794 `Import-Name`:** 0 of 305 sampled projects publish it.
- **Results for all 15,000:**
  - 13,533 projects (90%) resolved from their wheel file list.
  - 1,467 fell back to the normalised project name: 1,036 have no wheel (source distributions only), 428 have no importable names (stubs or binaries), and 3 returned 404.
  - It took 14 minutes with 8 workers: about 29k requests and **1.4 GB** downloaded.
- **Known mismatches all correct:** Pillow → `PIL`, PyYAML → `yaml`, beautifulsoup4 → `bs4`, scikit-learn → `sklearn`, opencv-python → `cv2`, PyJWT → `jwt`, python-dotenv → `dotenv`, pycryptodome → `Crypto`, grpcio → `grpc`.

**Output size** ([`pypi-well-known.txt`](pypi-allowlist/pypi-well-known.txt), [`pypi-import-map.jsonl`](pypi-allowlist/pypi-import-map.jsonl)):

| Top N projects | Import names | Raw | Gzipped | Share of top-15k downloads |
|---|---|---|---|---|
| 1,000 | 1,524 | 25 KB | 8 KB | 89.0% |
| 2,000 | 3,075 | 60 KB | 16 KB | 94.7% |
| 5,000 | 8,059 | 155 KB | 42 KB | 98.6% |
| 15,000 | 24,479 (9,590 dotted) | 494 KB | 130 KB | 100% |

**Junk names:** 1,012 import names are claimed by more than one project. The worst are generic top-level names that sloppy wheels ship, such as `tests`, `test`, `examples` and `docs.conf`. On an allowlist they would reveal private packages with those names.

### Why we stopped

1. **Size grows with every ecosystem**, and the 15k list came out about 130 KB gzipped for PyPI alone, worse than estimated.
2. **The data was answering the wrong question.** The allowlist asked "which external names are public and so safe to show?" That requires modelling each ecosystem's whole package catalogue and its popularity distribution. Hiding every External Dependency by default and letting the user Reveal them (the build summary lists them all) needs no such model.
3. **Manifests are enough.** "Not in the repo, and declared in a Module's manifest" needs only per-ecosystem knowledge of how dependencies are declared.

**Alternatives we considered on the way:**
- **A much smaller bundled list** (top 2k, 16 KB gzipped).
- **Downloading the list on first use.**
- **A Bloom or Golomb filter:** rejected because a false positive reveals a private name, which fails in the unsafe direction.
- **Lockfile evidence that a package came from the public registry:** rejected because being public isn't the same as being anonymous. `@acme/...` published publicly still identifies the owner.
