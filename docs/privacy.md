# Privacy

git-city is built so that the static site it writes shows the shape of a repository's history without its names. By
default a viewer sees Districts, Buildings and Roads, and none of the words that identify the code. This page says what
is and is not in the output, how to check it, and what risks remain.

## What is in the output

- **Generated names** for Districts, Neighbourhoods, External Cities and the City, drawn from the chosen Theme. "Ashford
  Keep" stands for a Module, not for a real directory.
- **Labels** for Buildings, made from the type and birth order, such as "TypeScript file 412". They identify nothing
  outside the City.
- **Timing** to the day: when Buildings appeared, grew and were removed.
- **Shape**: how many Buildings there are, how large they get, and the connections between them (Roads and Highways).
- **Commit sequence numbers**, not hashes.
- **Names you chose to reveal**, and the Pseudonyms you set in config.
- **The Countryside**, which is scenery. It stands for nothing in the repo.

## What is not in the output

By default, none of the following are in the output:

- File, directory and Module names (only Generated names or Labels).
- External Dependency names. External Cities get Generated names.
- Commit hashes, remote URLs and the repository name.
- Email addresses, in any form.
- Contributors. They are off by default, and when on, they are shown only at the level you choose.
- Commit messages. They are off by default.
- Exact times of day. Off by default.
- Raw line or importer counts.
- The mapping from Real names to Pseudonyms or Generated names.

Revealing a name is always an explicit choice in config (`reveal` in `rules`). Nothing is revealed by default, and the
`--private` flag ignores every reveal. See the [config reference](config.md).

## How to check it

Run the build, then look at the output:

- The build summary lists what was revealed, how many names were made, every detected External Dependency and any
  near-miss warnings.
- `git-city audit [dir]` lists every string in the output, one per line as an id and its text. Read it before you publish.
- Before the output is swapped into place, every file is scanned for hidden Real names and Concepts. A hit fails the
  run with exit code 2 and names the file, never the hidden word.
- `--strict` makes near-miss warnings fail the build, also with exit code 2.

`git-city audit` is the check to run before publishing. It shows exactly the strings a viewer can read.

## Residual risks

Some things stay visible even with every default in place:

- **Structural fingerprinting.** The shape of the City (its Districts, their sizes, when they grew, and how they connect)
  can identify a public repository to anyone who already knows its history. Names stay hidden, but the shape can match.
  `exclude` can take parts of the repo out of the City, and `tuning` changes the look, but neither removes the shape.
- **Regenerating seeded names.** Generated names come from a seed, and the output contains a number derived from it. The
  default seed is the root commit, which is public for a public repository. Someone who knows the root commit and the
  Theme can regenerate the names and check a guess, for example whether a District is called "Ashford Keep". Setting
  `naming.seed` (or `--seed`) to a value you keep private removes this, because the seed no longer comes from the public
  root commit.
- **Labels reveal type and order.** A Label such as "TypeScript file 412" shows a Building's language and when it was
  first seen, though not its name.

If any of these matter for your repository, do not publish the output, or keep the parts that matter out with `exclude`.
