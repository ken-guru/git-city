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

export interface Config {
  /** Rules in file order: the last matching rule wins. */
  rules: Rule[];
  naming: { seed?: string };
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
  return { rules, naming, sources: [source] };
}

/**
 * Reads and merges config files in the order given. Rules keep that order,
 * so a later file's rules win (the personal config comes last).
 */
export function loadConfig(paths: readonly string[]): Config {
  const merged: Config = { rules: [], naming: {}, sources: [] };
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
