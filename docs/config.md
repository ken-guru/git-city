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
| `rules[].contributor` | string | Target: a contributor. Only used when contributors are on. |
| `rules[].external` | string | Target: an External Dependency, by its package name. |
| `rules[].action` | string | `pseudonym`, `reveal`, `allow` or `category`. |
| `rules[].as` | string | The Pseudonym. Required with `pseudonym`, not allowed with other actions. |
| `rules[].category` | string | The Category for matched Buildings. Required with `category`, not allowed with other actions. |
| `naming` | object | Settings for Generated names. |
| `naming.seed` | string | Overrides the seed for Generated names. The `--seed` flag wins over it. |
| `contributors` | string | `off` (default), `anonymous`, `generated` or `real`. Checked, but not yet applied by this release. |
| `commitMessages` | boolean | Whether commit messages appear. Default `false`. Checked, but not yet applied by this release. |
| `exactTimes` | boolean | Whether dates show exact times instead of the day. Default `false`. Checked, but not yet applied by this release. |
| `theme` | string | The Theme name: `modern` (default) or `medieval`. The `--theme` flag wins over it. |
| `externals` | object | Grouping overrides for External Dependencies. Free-form for now; checked to be an object. |
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
