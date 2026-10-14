# Config reference

git-city reads its settings from JSONC config files. Every key is checked against the published schema,
[`schema/git-city.config.schema.json`](../schema/git-city.config.schema.json), so an editor that supports JSON Schema
can complete and check them. Comments and trailing commas are allowed. A config file never runs code.

## Where config lives

| File | Committed | Rules |
|---|---|---|
| `git-city.config.jsonc` at the repository root | yes, shared with the team | come first |
| `.git/git-city/config.jsonc` | no, personal to this clone | come last |

`--config <path>` reads that one file instead of both. `git-city init` writes a commented starter config
(personal by default; `--shared` writes the root file).

Rules keep their file order, so the last matching rule wins. Settings from the personal file override the shared file.
A flag always beats the config for the same setting.

## Keys

<!-- schema-keys:start -->
| Key | Type | What it does |
|---|---|---|
| `$schema` | string | Points an editor at the schema. Not read by git-city. |
| `rules` | list | Ordered rules that pseudonym, reveal, allow or categorise names. See [Rules](#rules). |
| `rules[].path` | string | Target: a path glob, such as `src/**`. |
| `rules[].module` | string | Target: a Module, by its name. |
| `rules[].concept` | string | Target: a Concept, matched case-insensitively inside names. |
| `rules[].contributor` | string | Target: a contributor, by its name (after `.mailmap`) or its email. Only used when contributors are on, and only `pseudonym` applies to it. |
| `rules[].external` | string | Target: an External Dependency, by its package name. |
| `rules[].action` | string | `pseudonym`, `reveal`, `allow` or `category`. |
| `rules[].as` | string | The Pseudonym. Required with `pseudonym`, not allowed with other actions. |
| `rules[].category` | string | The Category for matched Buildings. Required with `category`, not allowed with other actions. |
| `naming` | object | Settings for Generated names. |
| `naming.seed` | string | Overrides the seed for Generated names. The `--seed` flag wins over it. |
| `contributors` | string | Who changed what: `off` (default, nothing shown), `anonymous` ("Contributor 9", numbered by first commit), `generated` (themed person names, unique and checked for leaks) or `real` (names after `.mailmap`). Bots are grouped as one "Automation" Contributor. Emails are never written. `--private` replaces real names with generated ones. |
| `commitMessages` | boolean | Whether commit messages appear as captions, with the date and Contributor. Default `false`. Concept pseudonyms apply; a message with a hidden name in it, or with only an email address, is shown without its text. |
| `exactTimes` | boolean | Whether the page shows each Step's time of day (UTC) instead of its day. Default `false`, which keeps dates to the day. |
| `externals` | object | Settings for External Cities: how External Dependencies group on the horizon. |
| `externals.threshold` | integer | The smallest group that gets its own External City, from 3 to 5. Default 3. |
| `externals.groups` | object | Maps a dependency's name to the group it joins, overriding the automatic grouping. |
| `theme` | string | The Theme name: `modern` (default) or `medieval`. The `--theme` flag wins over it. |
| `externals` | object | Grouping overrides for External Dependencies, where the grouping threshold (3 to 5) is planned. Free-form for now; checked to be an object. |
| `exclude` | list of strings | Path globs of files left out of the City. From both config files. |
| `scale` | object | Settings for long histories. |
| `scale.timeline` | string | `auto` (default), `commit`, `day`, `week` or `month`. `commit` refuses grouping and only warns. |
| `tuning` | object | Layout and look settings. Free-form for now; checked to be an object. Changes the look, never privacy. |
<!-- schema-keys:end -->

## Rules

A rule has exactly one target (`path`, `module`, `concept`, `contributor` or `external`) and one `action`:

- `pseudonym` replaces the name with `as`.
- `reveal` shows the Real name. It is ignored under `--private`.
- `allow` marks a deliberate near-miss, so the build does not warn about it.
- `category` sets the Category of the matched Buildings.

```jsonc
{
  "rules": [
    { "path": "src/payments/**", "action": "reveal" },
    { "concept": "Acme", "action": "pseudonym", "as": "Acorn" },
    { "path": "vendor/**", "action": "category", "category": "generated" }
  ]
}
```

A Concept pseudonym replaces the word everywhere it appears, keeping its case.
