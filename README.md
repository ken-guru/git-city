# git-city

git-city turns a repository's git history into an animated 3D city, published as a static web page. Each file is a
building that grows and shrinks with the file. Each module (a folder with its own package manifest) is a district, and
each connection between files is a road. You scrub or play through the commits and watch the city grow.

Names are hidden by default. See [Privacy](docs/privacy.md) for exactly what the output contains.

## Install

git-city needs Node 22 or later and a git repository.

```sh
npx git-city              # run without installing
npm i -g git-city        # or install globally, then run git-city
```

## First run

From the root of a repository, run:

```sh
git-city
```

This reads the default branch and writes the site to `git-city-site/`. The build prints its progress, then a summary:
what was revealed, how many names were made, any near-miss warnings, the sizes of the output, and the output path.

The first run also suggests adding the output folder to `.gitignore`. git-city never edits `.gitignore` itself, so add
the line yourself, or the site will be committed:

```gitignore
git-city-site/
```

Builds are cached in `.git/git-city/`, so the next run resumes where the last one stopped. Use `--fresh` to rebuild from
scratch.

## Viewing

The site must be served over HTTP. Opened straight from disk (`file://`), the page shows a short explanation instead of
the city.

```sh
git-city serve --open
```

`serve` runs a server on localhost only, starting at port 4173 and using the first free port after that. Use `--port <n>`
to name a port exactly. Press Ctrl+C to stop it.

## Publishing

The site is a folder of static files, so any static host works: GitHub Pages, your own web server, or any host that
serves a folder. Copy the contents of `git-city-site/` to the host. The world file is always fetched fresh; the other
files are cached with content hashes in their names.

Before you publish, check the output:

```sh
git-city audit             # lists every string the site contains
```

A build with `--strict` fails on near-miss names, and a build always fails, with exit code 2, if a hidden name is found in
the output.

## Commands

| Command | Does |
|---|---|
| `git-city` / `git-city build` | build the site, or resume the last build |
| `git-city serve [dir]` | serve a built site on localhost |
| `git-city audit [dir]` | list every string in a built site |
| `git-city init [--shared]` | write a commented starter config, listing the detected Modules, External Dependencies and Themes |
| `git-city cache status\|clear` | inspect or remove the build cache in `.git/git-city/` |

Common options: `--branch <name>`, `--out <dir>`, `--config <path>`, `--theme <name>`, `--seed <text>`, `--strict`,
`--private`, `--fresh`, `--json`, `--quiet`, and `-C <path>`. Run `git-city --help` for the full list.

Exit codes: `0` success (possibly with warnings), `1` error, `2` privacy check failed, `3` another build holds the lock.

The manual page is `git-city(1)`. Read it with `man git-city` when the package's `man` folder is on your `MANPATH`.

## Configuration

Settings live in two optional JSONC files. `git-city.config.jsonc` at the repository root is shared and committed. The
personal file `.git/git-city/config.jsonc` is never committed, and its rules come last. Every key is listed in the
[config reference](docs/config.md), which is checked against the published schema.

To start a config with the detected Modules and External Dependencies, run `git-city init` (or `git-city init --shared`).

## Themes

Two Themes ship: `modern` (the default) and `medieval`. A Theme sets the names and colours of a City. To add one, read
[Writing a theme](docs/themes.md).

## Documentation

- [Config reference](docs/config.md)
- [Privacy](docs/privacy.md)
- [Writing a theme](docs/themes.md)
- [Specification](SPEC.md) and [glossary](GLOSSARY.md)

## Licence

MIT. Bundled third-party code and its notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
