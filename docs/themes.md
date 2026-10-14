# Writing a theme

A Theme sets the names and colours for a whole City: the word pieces for District, Neighbourhood and person names, the
street suffixes, a noun for every Role, and a palette hue for every Role. Two Themes ship: `modern` (the default) and
`medieval`. Pick one with `--theme <name>` or `theme` in the config.

A Theme is data only. It is a JSON file that is validated against
[`schema/theme.schema.json`](../schema/theme.schema.json) and executes no code.

## Loading

In this release git-city loads only the built-in Themes. A Theme is a file in `themes/`, and its name must be listed in
`BUILT_IN_THEMES` in `src/cli/theme.ts`. User Theme files are planned for a later release, and the same loader will
read them. Until then, a new Theme is a change to this package.

## The pack

| Field | Rule |
|---|---|
| `$schema` | Optional. Points an editor at the schema, for example `"../schema/theme.schema.json"`. |
| `name` | Lower-case words and hyphens, starting with a letter, such as `medieval`. |
| `display.title`, `display.description` | Non-empty text naming and describing the Theme. |
| `wordPieces.prefixes` | One or more words of letters only, such as `Ash`. |
| `wordPieces.suffixes` | One or more lower-case words, such as `ford`. |
| `streetSuffixes` | One or more words of letters and spaces, such as `Lane`. |
| `roleNouns` | A noun for every key in the coverage list below. Letters and single spaces, at most 24 characters. |
| `palette` | Optional. When given, a `hue` from 0 to 360 for every key in the coverage list below. When left out, the built-in palette gives the hues (the modern Theme's). |

No other keys are allowed at any level.

## Coverage rules

Every Role needs a noun, and the fallback needs one too. The fallback is used for anything with no detected Role. A
palette is optional. If you give one, it needs a hue for every key too. These are the keys, which must appear in
`roleNouns`, and in `palette` when you give one:

- Roles: `tests`, `docs`, `api`, `ui`, `auth`, `data`, `cli`, `infra`, `utils`, `core`, `config`, `build`
- Fallback: `fallback`

A missing key fails validation, and so does an extra one. A Role noun is a suffix in a District's name ("Ashford Keep"),
so it should read naturally after a proper name.

Hues decide how Districts are coloured. Districts with the same Role share a hue, and paving never uses the yellow-green
to green band. Colour is never the only cue, so a hue should not be the only way a Role is told apart.

## Leak check

Generated names are checked before they are used. A candidate is rejected when it contains a hidden Real name or a
Concept, matched case-insensitively and with near-miss matching. A Role noun that would leak is replaced by the fallback
noun, and if the fallback leaks too, the name is built from its proper name alone. The final scan then looks at every
output file (except the page bundle in `assets/`), and any hidden name that gets through fails the run with exit code 2.

When you write a Theme, check its word pieces and nouns against the names your repos use. Run a build with
`--strict`, which makes near-misses fail, and read the build summary's near-miss warnings. `git-city audit` lists every
string in the output, so you can see the names the Theme produced.

## Checking a Theme

- Validate it against `schema/theme.schema.json` in your editor, or run `npx vitest run test/schemas.test.ts`, which
  checks the validator and the schema against each other.
- Build a sample repo with it: `git-city build --theme <name> --out <dir>`.
- Read `git-city audit <dir>` and check the names.

## Example

```json
{
  "$schema": "../schema/theme.schema.json",
  "name": "harbour",
  "display": { "title": "Harbour", "description": "Quays, wharves and warehouses." },
  "wordPieces": { "prefixes": ["Salt", "Gull", "Tide"], "suffixes": ["quay", "wharf", "mere"] },
  "streetSuffixes": ["Quay", "Wharf", "Row"],
  "roleNouns": {
    "tests": "Slipway", "docs": "Chart Room", "api": "Customs House", "ui": "Market", "auth": "Harbourmaster",
    "data": "Warehouse", "cli": "Signal Tower", "infra": "Dock", "utils": "Workshop", "core": "Lighthouse",
    "config": "Ledger", "build": "Shipyard", "fallback": "Quarter"
  },
  "palette": {
    "tests": { "hue": 42 }, "docs": { "hue": 270 }, "api": { "hue": 28 }, "ui": { "hue": 340 },
    "auth": { "hue": 355 }, "data": { "hue": 15 }, "cli": { "hue": 245 }, "infra": { "hue": 205 },
    "utils": { "hue": 38 }, "core": { "hue": 215 }, "config": { "hue": 180 }, "build": { "hue": 220 },
    "fallback": { "hue": 40 }
  }
}
```
