# Extracting git history privately at scale

Research for ticket #2 on the GitCity map (#1).

**Question.** How can a Node/TypeScript CLI walk a branch's first-parent history (about 50k commits, 20k files at once) and get, for every commit, the full file list with paths, blob sizes, line counts, added/removed/renamed files and commit dates, as fast as possible, without file content ever leaving the process?

**Settled context.** First-parent history of one branch. Output never contains file content. Re-runs resume from where the last run stopped.

## Answer in short

Shell out to the `git` binary. Do not use isomorphic-git or libgit2 bindings.

1. **Commit chain:** `git rev-list --first-parent --reverse <branch>`.
2. **Per-commit changes:** stream `git log --first-parent -M --raw -z --no-abbrev --format=...` (or the plumbing equivalent, `git diff-tree --stdin`). This gives every add, delete, modify and rename with full blob IDs and modes. It took **2.6 s for 24k commits** in our benchmark, rename detection included.
3. **Blob sizes:** `git cat-file --batch-check='%(objectname) %(objectsize)'` on the distinct new blob IDs. This reads no content. It took **0.3 s for 92k blobs**.
4. **Line counts:** stream each distinct blob once through `git cat-file --batch`, count `\n` in process and throw the bytes away. Cache the result by blob ID. It took **7 s for 2.6 GB / 92k blobs serially and about 1.5 s with 8 parallel `cat-file` processes**. The alternative is `--numstat` deltas, which give the same numbers (verified exactly at the tip) but cost **16.5 s serially, or 4 s split 8 ways**.
5. **Resume:** each run persists the last processed first-parent SHA plus a cache keyed by blob ID (`size, lines, binary`). Blob IDs are content-addressed and immutable, so the cache can never go stale. A re-run rebuilds the file list at the saved SHA with one `git ls-tree -r -l -z` (0.01 s), then walks `<saved>..<tip>`.

Content does pass from the `git` child process to Node through a local pipe, but it is only ever counted and never stored or written out. This meets the privacy rule: "may read anything locally, output only structural facts."

## Benchmarks run for this ticket

**Setup.** Bare clone of `git/git` with `master` at `6de20f6` (Oct 2026). That is 82,443 commits in total, **24,380 on the first-parent chain** (15,698 of them merges), 4,857 files at the tip, and a 322 MB pack. git 2.55.0, Node 24.21, Linux arm64, 10 cores, 32 GB RAM. The scripts are throwaway and were not committed. Times are wall clock. RSS comes from `getrusage` and includes mmapped pack pages.

| Approach | Wall time (24k commits) | Peak RSS | Notes |
|---|---|---|---|
| `git log --first-parent --raw --no-renames -z` | 2.42 s | 345 MB | file list and blob IDs only |
| same with `-M` (renames) | 2.58 s | 356 MB | 1,818 renames found, about 6% extra cost |
| `git log --first-parent -M --raw --numstat -z` | 16.73 s | 435 MB | numstat is about 85% of the cost |
| same, split into 4 / 8 parallel `A..B` segments | 7.67 s / 3.98 s | per process | output identical |
| `git diff-tree --stdin -r -M --raw --numstat -z --root` fed `commit firstparent` pairs, 1 / 8 workers | 16.47 s / 4.15 s | — | same 292,449 change records as `git log` (sorted diff empty) |
| `cat-file --batch-check` sizes for 92,512 distinct blobs | 0.3 s | — | no content read |
| `cat-file --batch` + newline count in Node, 92,512 blobs (2.61 GB), walk order | 7.0 s | Node 229 MB | |
| `cat-file --batch` raw throughput, sorted OIDs, 1 / 8 processes | 10.8 s / 1.5 s | — | walk order beats sorted order (delta-base locality) |
| Prototype extractor in Node (stream parse of log `--raw --numstat`, state map, sizes) | 16.5 s + 0.3 s | Node 272 MB | parse overhead ≈ 0 next to git |
| **es-git 0.7.0** (libgit2 via napi-rs): first-parent revwalk + `diffTreeToTree` + `findSimilar` | 20.2 s | 1,304 MB | no per-file line stats; 1,868 renames (different heuristic) |
| **isomorphic-git 1.43.3**: tree diff + read changed blobs, newest 2,000 commits only | 21.5 s | 935 MB | crashed further back on mode `100664`; no rename detection |
| isomorphic-git without a shared `cache` object | over 500 s for 100 commits (killed) | — | re-parses the packfile on every call |

**Correctness check.** The prototype replayed all 24,380 first-parent commits from the root. At the tip it matched `git ls-tree -r -l` exactly: 4,857/4,857 paths, 0 blob-ID mismatches and 0 size mismatches. It also checked the numstat-accumulated line count of all 4,837 text files against a direct count of the blob, and 0 differed. That direct count includes the last line when the file has no trailing newline, as numstat does.

**Scaling to the target.** Cost follows the bytes of changed blobs and the diff work, not the commit count alone. A 50k-commit, 20k-file repo should be roughly 2–4× these numbers. That puts the `--raw` walk at about 5–10 s, line counting at a few seconds in parallel, and serial numstat at about 35–70 s. The state held in memory is one entry per live path (about 20k) plus the blob cache (one small record per distinct blob, around 100k–500k), so tens of MB.

## Comparison of the three routes

### Shelling out to `git` (recommended)
- **Fastest by a wide margin**, because git's C tree-diff, rename detection and xdiff run natively and streaming adds almost no overhead.
- **Ubiquitous.** Every user of the CLI already has `git`. It needs no native addon or prebuilt binaries.
- **Correct on old and odd history.** It handles legacy modes such as `100664`, gitlinks and grafts.
- **Easy to parallelise.** Split the first-parent chain into `A..B` ranges, or shard `diff-tree --stdin` and `cat-file` inputs.
- **Costs:** you parse text output (with `-z` it is unambiguous), and you need some hardening (below).

### isomorphic-git
- Pure JS, so it has no install problems. But it has **no rename detection and no line diff / numstat**. Line counts mean reading whole blobs in JS.
- It is **10–100× slower** in our run: 21.5 s for 2,000 commits, against 2.6 s for all 24k with git. Without the shared `cache` parameter its own docs warn of pathological slowness (["The `cache` parameter"](https://github.com/isomorphic-git/isomorphic-git/blob/main/docs/cache.md)). We saw over 500 s for 100 commits.
- It holds the pack in memory, which gave 935 MB RSS for a 322 MB pack.
- **It failed on real history.** `InternalError: Unexpected GitTree entry mode: 100664` on older `git/git` trees. Such modes exist in many repos that predate git 1.5 or were imported by old tools.

### nodegit / libgit2 bindings
- **nodegit:** the last stable release is 0.27.0, from 2020-07-28. 0.28 has been in alpha for years (0.28.0-alpha.38 dates from 2026-04-23) and needs Node ≥ 20 ([package.json](https://github.com/nodegit/nodegit/blob/master/package.json)). `npm install nodegit@0.28.0-alpha.38` **failed here under npm 12**. It depends on a git-hosted fork of `nan` (`github:axosoft/nan#v2.26.2-axosoft.0`), and npm refuses git dependencies by default (`EALLOWGIT`). Shipping it inside a CLI means native builds or prebuilt-binary risk for every user.
- **es-git** (Toss, git2-rs via napi-rs, prebuilt binaries; [repo](https://github.com/toss/es-git)) installs cleanly. It can walk first-parent (`revwalk().simplifyFirstParent()`) and diff trees with rename detection. But it took **20 s** against git's 2.6 s for the same walk, at 1.3 GB RSS. Its `DiffStats` is totals only, with no per-file numstat, and `Commit` exposes no parent IDs. It is pre-1.0 and publishes very frequently.
- libgit2's rename limit also defaults to 1000 ([`diff.h`, `rename_limit`](https://github.com/libgit2/libgit2/blob/main/include/git2/diff.h)), so it gains nothing there.

## Topic details

### Line counts: numstat deltas vs reading blobs
- `--numstat` prints added and removed lines per file, and `-` `-` for binary ([diff-options `--numstat`](https://git-scm.com/docs/diff-options#Documentation/diff-options.txt---numstat)). If you replay from the root and sum `added − removed` per path (carrying the count across renames), you get the exact line count. We verified this at the tip of `git/git`. **Catch:** the count is a running sum, so resuming needs the per-path counts persisted, and any parse bug drifts forever.
- **Reading blobs** (`cat-file --batch`, count `\n`) is *cheaper* in practice: 7 s against 16.5 s serially. Each distinct blob is read once, and the result is a pure function of the blob ID, so it caches perfectly across runs and branches. It also yields a binary flag for free: git's own heuristic is "a NUL in the first 8000 bytes" (`buffer_is_binary`, `FIRST_FEW_BYTES 8000` in [`xdiff-interface.c`](https://github.com/git/git/blob/master/xdiff-interface.c)).
- **Recommendation:** count lines from blobs. Use `--numstat` only if per-commit *churn* (lines added and removed, as opposed to net size) is wanted for visuals. If it is, run it in parallel segments.
- Get sizes with `--batch-check` first, and skip line-counting blobs above a threshold, so huge generated or binary files don't dominate. Git itself treats files above `core.bigFileThreshold` (default 512 MiB) as binary for diffs ([config docs](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corebigFileThreshold)).

### Rename detection cost
- Measured cost of `-M` on the `--raw` walk: **+0.16 s (about 6%)** for 1,818 renames over 24k commits. Exact renames (same blob) are found by hash. The quadratic inexact pass is capped by `diff.renameLimit`, "currently 1000" ([git-config `diff.renameLimit`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-diffrenameLimit)). When a commit exceeds the cap, git skips inexact detection for that commit and warns on stderr, so huge directory moves degrade to delete+add. `-l<n>` raises it, and 0 means unlimited ([diff-options `-l`](https://git-scm.com/docs/diff-options#Documentation/diff-options.txt--lltnumgt)).
- Pass `-M` explicitly. Don't rely on the user's `diff.renames` config.
- Raw rename records carry a similarity score (`R087`) and both paths, so a Building can be "moved" rather than demolished and rebuilt.

### Binary files
- `--raw` shows them like any other file. `--numstat` shows `-\t-`. When reading blobs, mark a blob binary if it has a NUL in the first 8000 bytes (git's rule), record its size, and give it 0 lines. In our run, 57 binary change events showed up in `git/git`.
- `.gitattributes` `binary` / `-diff` also force numstat to `-`. Matching that exactly from blob reading would need `git check-attr`. That is probably not worth it for visuals.
- **Disable textconv and external diff:** pass `--no-textconv --no-ext-diff`. textconv is *enabled by default for `git log`* ([diff-options `--textconv`](https://git-scm.com/docs/diff-options#Documentation/diff-options.txt---textconv)), which would both distort counts and run repo-configured commands.

### Submodules and LFS
- **Submodules** appear as mode `160000` gitlink entries whose "blob ID" is a commit in another repo. There is nothing to read (`cat-file` fails on it). Treat it as a special Building with no size or lines. There were 4 such events in `git/git`.
- **LFS** files are committed as small text pointer files: `version https://git-lfs.github.com/spec/v1`, `oid sha256:…`, `size <bytes>`. Pointers "must be less than 1024 bytes" ([LFS spec](https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md)). Without special handling they look like 3-line, roughly 130-byte files. **Recommendation:** for blobs under 1024 bytes that start with the `version https://git-lfs` line, parse `size` as the real size and treat the file as binary/opaque. This needs no network access and no LFS install. Smudge filters never run, because we read the object database and not the work tree.

### Privacy and safety hardening
- Read the object database only. Never check out, so no smudge or clean filters run.
- **Partial clones** (`--filter=blob:none`) would make `cat-file` *lazily fetch every blob over the network*. Set `GIT_NO_LAZY_FETCH=1` (or `--no-lazy-fetch`, git ≥ 2.45) and treat missing blobs as "unknown lines" ([git(1) `GIT_NO_LAZY_FETCH`](https://git-scm.com/docs/git#Documentation/git.txt-GITNOLAZYFETCH)).
- **Shallow clones** truncate the first-parent chain. Detect them with `git rev-parse --is-shallow-repository` and say so.
- Pin output against user config: `-z`, `--no-abbrev`, an explicit `--format`, `--no-color`, `--no-textconv`, `--no-ext-diff`, `--no-show-signature`, `--no-notes`, and `--root` (or rely on `log.showRoot`). Optionally set `GIT_CONFIG_NOSYSTEM=1`.
- `-z` makes paths unambiguous (no quoting of unusual characters; [diff-options `-z`](https://git-scm.com/docs/diff-options#Documentation/diff-options.txt--z)). Decode paths as bytes or latin1 if non-UTF-8 names must round-trip.
- Commit messages: never request `%s`/`%B` unless the user has opted in. Dates: `%ct` is committer time and `%at` is author time. Neither is guaranteed monotonic along the chain, so the Timeline should clamp.

### First-parent semantics
- With `git log --first-parent`, merges are diffed against their first parent by default ("This option also changes default diff format for merge commits to `first-parent`"; [rev-list-options](https://git-scm.com/docs/git-log#Documentation/git-log.txt---first-parent)). Each merge therefore shows as one commit carrying the net change it brought to the branch, which is exactly the Timeline semantics.
- `git diff-tree --stdin` takes `"<commit> <parent>"` lines, and the given parent is used *in place of* the real parents ([git-diff-tree `--stdin`](https://git-scm.com/docs/git-diff-tree#Documentation/git-diff-tree.txt---stdin)). Feeding `C P1` pairs gives the same first-parent diffs from a plumbing command. It **omits commits with an empty diff** unless `--always` is given: 59 such commits in `git/git`.

### Memory
- git's RSS of 345–435 MB is mostly mmapped pack pages and is shared, reclaimable page cache. It is not heap, and it follows pack size, not history length.
- Node holds about 20k path entries plus the blob-stat cache, measured at 230–270 MB RSS total for the prototype. Output must be streamed into chunks, not built as one big array. 24k commits of `--raw --numstat` text is 11 MB.
- Avoid in-process git implementations at this scale: 0.9–1.3 GB RSS in our runs.

### What makes extraction resumable by commit SHA
1. **Checkpoint** = the last fully processed first-parent commit SHA, written atomically (temp file + rename) *after* that commit's output chunk is flushed.
2. **Content-addressed cache** of blob ID → `{size, lines, binary, lfsSize?}`. It is immutable and never invalidated, and is shared by every commit and every future run. This is the expensive part, and it makes re-runs nearly free.
3. **No accumulated state is needed.** The file list at the checkpoint comes from `git ls-tree -r -l -z <sha>` (10 ms), joined with the blob cache. This is why blob-based line counts beat numstat for resuming: numstat needs the persisted per-path running totals to stay exactly right.
4. **Validity check on re-run:** the checkpoint must still be on the branch's first-parent chain. Check whether `<sha>` appears in `git rev-list --first-parent <tip>`; the whole chain is cheap to list. If it does, process `git log --first-parent <sha>..<tip>`. On a first-parent chain the range is exactly the newer first-parent commits. If it doesn't (force-push or rebase), find the newest checkpointed commit still on the chain (keep a list of chunk-boundary SHAs), truncate the output there and continue. Fall back to a full rebuild if none survives. The blob cache stays valid either way.
5. Chunk boundaries also give natural parallel segments for a first run: process `A..B` ranges concurrently and commit checkpoints in order.

## Suggested extraction pipeline (for the build tickets)

```
rev-list --first-parent --reverse <branch>          -> chain (resume: cut at checkpoint)
 ├─ K × git log --first-parent -M --raw -z ... A..B  -> change events per commit (parallel segments)
 ├─ cat-file --batch-check (new blob IDs)            -> sizes            ┐ cache by blob ID
 └─ K × cat-file --batch (new, non-huge blob IDs)    -> lines, binary,   ┘ (persisted)
                                                         LFS pointer size
merge in chain order -> per-commit records {sha, date, adds, deletes, modifies, renames(sim)}
                     -> output chunks + atomic checkpoint
```

Add `--numstat` to the log step only if churn per commit is wanted.

## Sources
- git documentation, read from the `git/git` source at `6de20f6` (also published at https://git-scm.com/docs): `Documentation/rev-list-options.adoc` (`--first-parent`), `Documentation/diff-options.adoc` (`--numstat`, `-z`, `-l`, `--textconv`), `Documentation/config/diff.adoc` (`diff.renameLimit` default 1000), `Documentation/config/core.adoc` (`core.bigFileThreshold`), `Documentation/git-diff-tree.adoc` (`--stdin`, `--always`), `Documentation/git-cat-file.adoc`, `Documentation/git.adoc` (`GIT_NO_LAZY_FETCH`, added in `RelNotes/2.45.0`).
- git source: `xdiff-interface.c`, `buffer_is_binary` / `FIRST_FEW_BYTES 8000`.
- Git LFS pointer spec: https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md
- libgit2 `include/git2/diff.h` (`rename_limit`, default 1000): https://github.com/libgit2/libgit2
- isomorphic-git `docs/cache.md`, and the `mode2type` error observed in `isomorphic-git@1.43.3`.
- npm registry metadata (`npm view`) for isomorphic-git, nodegit and es-git, taken 2026-10-11.
- Benchmarks: run for this ticket, as described above.
