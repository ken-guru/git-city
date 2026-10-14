import { describe, expect, it } from "vitest";
import type { Rule } from "../src/cli/config.js";
import { globToRegExp, resolveConcept, resolveItem } from "../src/cli/rules.js";

const rule = (kind: Rule["target"]["kind"], value: string, rest: { action: Rule["action"]; as?: string; category?: string }): Rule =>
  ({ target: { kind, value }, ...rest }) as Rule;

describe("globToRegExp", () => {
  it("matches ** across folders, * within one folder and ? one character", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/c.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("resolveItem", () => {
  it("lets the last matching rule decide the name policy", () => {
    const rules = [rule("path", "src/**", { action: "reveal" }), rule("path", "src/secret/**", { action: "pseudonym", as: "Vault" })];

    expect(resolveItem(rules, { path: "src/app.ts" }).name).toEqual({ mode: "reveal" });
    expect(resolveItem(rules, { path: "src/secret/key.ts" }).name).toEqual({ mode: "pseudonym", as: "Vault" });
  });

  it("hides names by default", () => {
    expect(resolveItem([], { path: "a.ts" }).name).toEqual({ mode: "hidden" });
  });

  it("ignores every reveal when told to, keeping earlier pseudonyms", () => {
    const rules = [rule("path", "a/**", { action: "pseudonym", as: "Alpha" }), rule("path", "a/**", { action: "reveal" })];

    expect(resolveItem(rules, { path: "a/x.ts" }, { ignoreReveal: true }).name).toEqual({ mode: "pseudonym", as: "Alpha" });
    expect(resolveItem([rule("module", "core", { action: "reveal" })], { module: "core" }, { ignoreReveal: true }).name).toEqual({
      mode: "hidden",
    });
  });

  it("matches module, contributor and external targets exactly", () => {
    const rules = [
      rule("module", "payments", { action: "reveal" }),
      rule("contributor", "jane", { action: "pseudonym", as: "Contributor 1" }),
      rule("external", "left-pad", { action: "reveal" }),
    ];

    expect(resolveItem(rules, { module: "payments" }).name).toEqual({ mode: "reveal" });
    expect(resolveItem(rules, { module: "payments-old" }).name).toEqual({ mode: "hidden" });
    expect(resolveItem(rules, { contributor: "jane" }).name).toEqual({ mode: "pseudonym", as: "Contributor 1" });
    expect(resolveItem(rules, { external: "left-pad" }).name).toEqual({ mode: "reveal" });
  });

  it("takes the category from the last category rule, separately from the name policy", () => {
    const rules = [rule("path", "docs/**", { action: "category", category: "docs" }), rule("path", "docs/**", { action: "reveal" })];

    expect(resolveItem(rules, { path: "docs/a.md" })).toMatchObject({ category: "docs", name: { mode: "reveal" } });
  });

  it("reports allow for a deliberate near-miss without changing the name", () => {
    const rules = [rule("concept", "Acme", { action: "allow" })];

    const policy = resolveItem(rules, { path: "x.ts" });

    expect(policy.name).toEqual({ mode: "hidden" });
    expect(resolveConcept(rules, "acme").allow).toBe(true);
    expect(resolveConcept(rules, "Other").allow).toBe(false);
  });
});

describe("resolveConcept", () => {
  it("matches the Concept word case-insensitively and returns its policy", () => {
    const rules = [rule("concept", "Acme", { action: "pseudonym", as: "Vendor" })];

    expect(resolveConcept(rules, "ACME")).toMatchObject({ name: { mode: "pseudonym", as: "Vendor" } });
    expect(resolveConcept(rules, "Acmex")).toMatchObject({ name: { mode: "hidden" } });
  });
});
