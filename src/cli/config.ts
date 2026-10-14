import { readFileSync } from "node:fs";
import { ConfigError, parseJsonc } from "./jsonc.js";

export { ConfigError } from "./jsonc.js";

/** What a rule applies to. `concept` matches inside names; the others match whole items. */
export const TARGET_KINDS = ["path", "module", "concept", "contributor", "external"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface Target {
  kind: TargetKind;
  /** A glob for `path`; a literal name for the other kinds (Concepts match case-insensitively). */
  value: string;
}

/**
 * One rule. Typed shape, shared with the building rules of ticket #41:
 * `category` carries the Category name that the matched Buildings take.
 */
export type Rule =
  | { target: Target; action: "pseudonym"; as: string }
  | { target: Target; action: "reveal" }
  | { target: Target; action: "allow" }
  | { target: Target; action: "category"; category: string };

export type RuleAction = Rule["action"];
export const RULE_ACTIONS: readonly RuleAction[] = ["pseudonym", "reveal", "allow", "category"];

/** The `scale.timeline` setting: `auto` picks the smallest Step that fits; the others pin it (SPEC §9). */
export const TIMELINE_SETTINGS = ["auto", "commit", "day", "week", "month"] as const;
export type TimelineSetting = (typeof TIMELINE_SETTINGS)[number];

/** The `contributors` setting (SPEC §8): `off` shows no contributors; the others name them in the order given. */
export const CONTRIBUTOR_LEVELS = ["off", "anonymous", "generated", "real"] as const;
export type ContributorLevel = (typeof CONTRIBUTOR_LEVELS)[number];

export interface Config {
  /** Rules in file order: the last matching rule wins. */
  rules: Rule[];
  /** Whether contributors appear, and how they are named (SPEC §8). Off by default. */
  contributors?: ContributorLevel;
  /** Whether commit messages appear as captions (SPEC §11). Off by default. */
  commitMessages?: boolean;
  naming: { seed?: string };
  /** The Theme named in the config. The `--theme` flag wins over it. */
  theme?: string;
  /** Path globs of files left out of the City, from every config file. */
  exclude: string[];
  scale: { timeline?: TimelineSetting };
  /** Whether the output keeps each Step's time of day (SPEC §8). Off by default: dates are to the day. */
  exactTimes?: boolean;
  /** The `externals` section (SPEC §4): the External City threshold and grouping overrides. */
  externals?: ExternalsSetting;
  /** The files the config was read from, in merge order. */
  sources: string[];
}

/**
 * Sections owned by other tickets (contributors, theme, scale, tuning and so on).
 * They are listed here so that a typo elsewhere is caught, not so that they are read yet.
 */
const KNOWN_KEYS = new Set([
  "$schema",
  "rules",
  "naming",
  "contributors",
  "commitMessages",
  "exactTimes",
  "theme",
  "externals",
  "exclude",
  "scale",
  "tuning",
]);

const TARGET_KEYS: readonly TargetKind[] = TARGET_KINDS;

/** Parses one config file's text. `source` names the file in error messages. */
export function parseConfig(text: string, source: string): Config {
  const root = parseJsonc(text);
  if (!isObject(root)) throw new ConfigError(`${source}: the config must be a JSON object`);
  for (const key of Object.keys(root)) {
    if (!KNOWN_KEYS.has(key)) throw new ConfigError(`${source}: unknown key "${key}"`);
  }

  const rules = root.rules === undefined ? [] : parseRules(root.rules, source);
  const naming = root.naming === undefined ? {} : parseNaming(root.naming, source);
  checkSections(root, source);
  if (root.theme !== undefined && typeof root.theme !== "string") throw new ConfigError(`${source}: "theme" must be a string`);
  const theme = root.theme as string | undefined;
  const exclude = root.exclude === undefined ? [] : (root.exclude as string[]);
  const scale = root.scale === undefined ? {} : parseScale(root.scale, source);
  const exactTimes = root.exactTimes === undefined ? {} : { exactTimes: root.exactTimes === true };
  const externals = root.externals === undefined ? undefined : parseExternals(root.externals, source);
  const contributors = root.contributors === undefined ? undefined : (root.contributors as ContributorLevel);
  const commitMessages = root.commitMessages === undefined ? undefined : root.commitMessages === true;
  return {
    rules,
    naming,
    exclude,
    scale,
    sources: [source],
    ...(contributors === undefined ? {} : { contributors }),
    ...(commitMessages === undefined ? {} : { commitMessages }),
    ...exactTimes,
    ...(theme === undefined ? {} : { theme }),
    ...(externals === undefined ? {} : { externals }),
  };
}

/** The `externals` section: `threshold` (3 to 5) and `groups`, a map from a dependency's name to the group it joins. */
export interface ExternalsSetting {
  threshold?: number;
  groups?: Record<string, string>;
}

function parseExternals(value: unknown, source: string): ExternalsSetting {
  if (!isObject(value)) throw new ConfigError(`${source}: "externals" must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "threshold" && key !== "groups") throw new ConfigError(`${source}: unknown key "externals.${key}"`);
  }
  const setting: ExternalsSetting = {};
  if (value.threshold !== undefined) {
    if (typeof value.threshold !== "number" || !Number.isInteger(value.threshold) || value.threshold < 3 || value.threshold > 5) {
      throw new ConfigError(`${source}: "externals.threshold" must be a whole number from 3 to 5`);
    }
    setting.threshold = value.threshold;
  }
  if (value.groups !== undefined) {
    if (!isObject(value.groups) || !Object.values(value.groups).every((g) => typeof g === "string" && g.trim() !== "")) {
      throw new ConfigError(`${source}: "externals.groups" must map dependency names to group names`);
    }
    setting.groups = value.groups as Record<string, string>;
  }
  return setting;
}

function parseScale(value: unknown, source: string): { timeline?: TimelineSetting } {
  if (!isObject(value)) throw new ConfigError(`${source}: "scale" must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "timeline") throw new ConfigError(`${source}: unknown key "scale.${key}"`);
  }
  if (value.timeline === undefined) return {};
  if (typeof value.timeline !== "string" || !(TIMELINE_SETTINGS as readonly string[]).includes(value.timeline)) {
    throw new ConfigError(`${source}: "scale.timeline" must be one of ${TIMELINE_SETTINGS.join(", ")}`);
  }
  return { timeline: value.timeline as TimelineSetting };
}

/**
 * Reads and merges config files in the order given. Rules keep that order,
 * so a later file's rules win (the personal config comes last).
 */
export function loadConfig(paths: readonly string[]): Config {
  const merged: Config = { rules: [], naming: {}, exclude: [], scale: {}, exactTimes: false, sources: [] };
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new ConfigError(`cannot read config ${path}: ${(e as Error).message}`);
    }
    const config = parseConfig(text, path);
    merged.rules.push(...config.rules);
    merged.naming = { ...merged.naming, ...config.naming };
    if (config.theme !== undefined) merged.theme = config.theme;
    merged.exclude.push(...config.exclude);
    merged.scale = { ...merged.scale, ...config.scale };
    // The last file that sets it wins, as for the other settings (the personal config comes last).
    if (config.exactTimes !== undefined) merged.exactTimes = config.exactTimes;
    if (config.contributors !== undefined) merged.contributors = config.contributors;
    if (config.commitMessages !== undefined) merged.commitMessages = config.commitMessages;
    if (config.externals !== undefined) {
      const groups = { ...merged.externals?.groups, ...config.externals.groups };
      merged.externals = {
        ...merged.externals,
        ...config.externals,
        ...(Object.keys(groups).length > 0 ? { groups } : {}),
      };
    }
    merged.sources.push(path);
  }
  return merged;
}

function parseRules(value: unknown, source: string): Rule[] {
  if (!Array.isArray(value)) throw new ConfigError(`${source}: "rules" must be a list`);
  return value.map((entry, i) => parseRule(entry, `${source}: rules[${i}]`));
}

function parseRule(entry: unknown, where: string): Rule {
  if (!isObject(entry)) throw new ConfigError(`${where} must be an object`);

  const targets = TARGET_KEYS.filter((key) => entry[key] !== undefined);
  if (targets.length === 0) throw new ConfigError(`${where} needs a target: one of ${TARGET_KEYS.join(", ")}`);
  if (targets.length > 1) throw new ConfigError(`${where} must name exactly one target, got ${targets.join(", ")}`);
  const kind = targets[0]!;
  const targetValue = entry[kind];
  if (typeof targetValue !== "string" || targetValue.trim() === "") {
    throw new ConfigError(`${where}: "${kind}" must be a non-empty string`);
  }
  const target: Target = { kind, value: targetValue };

  const action = entry.action;
  if (typeof action !== "string" || !(RULE_ACTIONS as readonly string[]).includes(action)) {
    throw new ConfigError(`${where}: action must be one of ${RULE_ACTIONS.join(", ")}`);
  }

  if (action === "pseudonym") {
    if (typeof entry.as !== "string" || entry.as.trim() === "") throw new ConfigError(`${where}: "pseudonym" requires "as"`);
    rejectKeys(entry, ["category"], action, where);
    return { target, action, as: entry.as };
  }
  if (action === "category") {
    if (typeof entry.category !== "string" || entry.category.trim() === "") {
      throw new ConfigError(`${where}: "category" requires "category"`);
    }
    rejectKeys(entry, ["as"], action, where);
    return { target, action, category: entry.category };
  }
  rejectKeys(entry, ["as", "category"], action, where);
  return { target, action: action as "reveal" | "allow" };
}

function rejectKeys(entry: Record<string, unknown>, keys: string[], action: string, where: string): void {
  for (const key of keys) {
    if (entry[key] !== undefined) throw new ConfigError(`${where}: "${key}" is only allowed with another action, not "${action}"`);
  }
}

/**
 * Checks the sections the config reads, so a wrong type is caught and matches the schema
 * (schema/git-city.config.schema.json).
 */
function checkSections(root: Record<string, unknown>, source: string): void {
  const level = root.contributors;
  if (level !== undefined && !(typeof level === "string" && (CONTRIBUTOR_LEVELS as readonly string[]).includes(level))) {
    throw new ConfigError(`${source}: "contributors" must be one of ${CONTRIBUTOR_LEVELS.join(", ")}`);
  }
  for (const key of ["commitMessages", "exactTimes"] as const) {
    if (root[key] !== undefined && typeof root[key] !== "boolean") throw new ConfigError(`${source}: "${key}" must be true or false`);
  }
  const exclude = root.exclude;
  if (exclude !== undefined && !(Array.isArray(exclude) && exclude.every((item) => typeof item === "string"))) {
    throw new ConfigError(`${source}: "exclude" must be a list of strings`);
  }
  for (const key of ["tuning"] as const) {
    if (root[key] !== undefined && !isObject(root[key])) throw new ConfigError(`${source}: "${key}" must be an object`);
  }
}

function parseNaming(value: unknown, source: string): { seed?: string } {
  if (!isObject(value)) throw new ConfigError(`${source}: "naming" must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "seed") throw new ConfigError(`${source}: unknown key "naming.${key}"`);
  }
  if (value.seed === undefined) return {};
  if (typeof value.seed !== "string") throw new ConfigError(`${source}: "naming.seed" must be a string`);
  return { seed: value.seed };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
