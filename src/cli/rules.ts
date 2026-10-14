import type { Rule, Target } from "./config.js";

/** What a file, Module, contributor or External Dependency is shown as. */
export type NamePolicy = { mode: "hidden" } | { mode: "reveal" } | { mode: "pseudonym"; as: string };

/** The item a rule can target. Fields the build does not know yet are simply absent. */
export interface RuleItem {
  /** Repo-relative path of a file, forward slashes. */
  path?: string;
  module?: string;
  contributor?: string;
  external?: string;
}

export interface ItemPolicy {
  name: NamePolicy;
  /** The Category from the last `category` rule that matched, if any. */
  category?: string;
  /** True when an `allow` rule matched: a deliberate near-miss, not warned about. */
  allow: boolean;
}

export interface ResolveOptions {
  /** `--private`: reveal rules are ignored, so only pseudonyms and hidden names remain. */
  ignoreReveal?: boolean;
}

/**
 * Last match wins, per decision: the name policy (pseudonym, reveal), the category,
 * and the allow flag each take the last rule of their own kind that matches.
 */
export function resolveItem(rules: readonly Rule[], item: RuleItem, options: ResolveOptions = {}): ItemPolicy {
  const policy: ItemPolicy = { name: { mode: "hidden" }, allow: false };
  for (const rule of rules) {
    if (!targetMatches(rule.target, item)) continue;
    applyRule(policy, rule, options);
  }
  return policy;
}

/** The policy for a Concept word, from the rules whose target is that Concept. */
export function resolveConcept(rules: readonly Rule[], word: string, options: ResolveOptions = {}): ItemPolicy {
  const policy: ItemPolicy = { name: { mode: "hidden" }, allow: false };
  const key = word.toLowerCase();
  for (const rule of rules) {
    if (rule.target.kind !== "concept" || rule.target.value.toLowerCase() !== key) continue;
    applyRule(policy, rule, options);
  }
  return policy;
}

/** Distinct Concept words named by any rule, in first-seen order. */
export function conceptWords(rules: readonly Rule[]): string[] {
  const seen = new Map<string, string>();
  for (const rule of rules) {
    if (rule.target.kind !== "concept") continue;
    const key = rule.target.value.toLowerCase();
    if (!seen.has(key)) seen.set(key, rule.target.value);
  }
  return [...seen.values()];
}

function applyRule(policy: ItemPolicy, rule: Rule, options: ResolveOptions): void {
  switch (rule.action) {
    case "pseudonym":
      policy.name = { mode: "pseudonym", as: rule.as };
      break;
    case "reveal":
      if (!options.ignoreReveal) policy.name = { mode: "reveal" };
      break;
    case "allow":
      policy.allow = true;
      break;
    case "category":
      policy.category = rule.category;
      break;
  }
}

function targetMatches(target: Target, item: RuleItem): boolean {
  switch (target.kind) {
    case "path":
      return item.path !== undefined && globToRegExp(target.value).test(item.path);
    case "module":
      return item.module === target.value;
    case "contributor":
      return item.contributor === target.value;
    case "external":
      return item.external === target.value;
    case "concept":
      // Concepts match inside names, not whole items; see resolveConcept.
      return false;
  }
}

/** Converts a path glob: `**` crosses folders, `*` stays in one folder, `?` is one character. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` also matches zero folders, so `src/**/*.ts` matches `src/a.ts`.
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else source += "[^/]*";
    } else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
