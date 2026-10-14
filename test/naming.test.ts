import { describe, expect, it } from "vitest";
import type { Config, Rule } from "../src/cli/config.js";
import { displayName, encodeStrings, findNearMisses, labelFor, nameFiles } from "../src/cli/naming.js";

const config = (rules: Rule[] = [], seed?: string): Config => ({
  rules,
  naming: seed === undefined ? {} : { seed },
  exclude: [],
  scale: {},
  sources: [],
});
const reveal = (value: string): Rule => ({ target: { kind: "path", value }, action: "reveal" });
const pseudo = (value: string, as: string): Rule => ({ target: { kind: "path", value }, action: "pseudonym", as });
const concept = (value: string, as: string): Rule => ({ target: { kind: "concept", value }, action: "pseudonym", as });
const conceptReveal = (value: string): Rule => ({ target: { kind: "concept", value }, action: "reveal" });

describe("labelFor", () => {
  it("is the type plus the birth order, never the path", () => {
    expect(labelFor("src/index.ts", 411)).toBe("TypeScript file 412");
    expect(labelFor("README", 0)).toBe("Other file 1");
    expect(labelFor("docs/Guide.MD", 1)).toBe("Markdown file 2");
  });
});

describe("displayName", () => {
  it("follows pseudonym, then real name, then generated name, then label", () => {
    const label = "TypeScript file 1";
    expect(displayName({ pseudonym: "P", real: "r", generated: "g", label })).toEqual({ text: "P", source: "pseudonym" });
    expect(displayName({ real: "r", generated: "g", label })).toEqual({ text: "r", source: "real" });
    expect(displayName({ generated: "g", label })).toEqual({ text: "g", source: "generated" });
    expect(displayName({ label })).toEqual({ text: label, source: "label" });
  });
});

describe("nameFiles", () => {
  it("hides every name by default and returns one string per file id", () => {
    const { table, revealed } = nameFiles(["src/a.ts", "docs/b.md"], config(), {});

    expect(table.strings).toEqual(["TypeScript file 1", "Markdown file 2"]);
    expect(revealed).toEqual([]);
  });

  it("shows the real path only where a reveal rule matches", () => {
    const { table, revealed } = nameFiles(["src/a.ts", "docs/b.md"], config([reveal("src/**")]), {});

    expect(table.strings).toEqual(["src/a.ts", "Markdown file 2"]);
    expect(revealed).toEqual([{ id: 0, text: "src/a.ts" }]);
  });

  it("prefers a pseudonym even over a reveal", () => {
    const rules = [reveal("src/**"), pseudo("src/billing.ts", "Ledger")];

    expect(nameFiles(["src/billing.ts"], config(rules), {}).table.strings).toEqual(["Ledger"]);
  });

  it("replaces a Concept everywhere, keeping its case", () => {
    const rules = [reveal("**"), concept("Acme", "Vendor")];
    const { table } = nameFiles(["Acme/acme-core.ts", "ACME_TOOLS.md", "lib/acme.js"], config(rules), {});

    expect(table.strings).toEqual(["Vendor/vendor-core.ts", "VENDOR_TOOLS.md", "lib/vendor.js"]);
  });

  it("falls back to a label when a hidden Concept would appear in a revealed name", () => {
    const rules = [reveal("**")];
    const withHidden = nameFiles(["Acme/x.ts"], config([...rules, { target: { kind: "concept", value: "Acme" }, action: "allow" }]), {});

    expect(withHidden.table.strings).toEqual(["TypeScript file 1"]);
  });

  it("shows a revealed Concept word when its reveal rule says so", () => {
    const rules = [reveal("**"), conceptReveal("Acme")];

    expect(nameFiles(["Acme/x.ts"], config(rules), {}).table.strings).toEqual(["Acme/x.ts"]);
  });

  it("with --private ignores every reveal, so only pseudonyms and labels remain", () => {
    const rules = [reveal("**"), conceptReveal("Acme"), pseudo("docs/a.md", "Notes")];
    const { table, revealed } = nameFiles(["Acme/x.ts", "docs/a.md"], config(rules), { private: true });

    expect(table.strings).toEqual(["TypeScript file 1", "Notes"]);
    expect(revealed).toEqual([]);
  });

  it("reports near-misses of hidden terms in revealed names unless allowed", () => {
    const rules = [reveal("src/**"), { target: { kind: "concept", value: "Initech" }, action: "pseudonym", as: "Co" } as Rule];
    const { nearMisses } = nameFiles(["src/initec.ts", "secret/platform.ts"], config(rules), {});

    expect(nearMisses).toEqual([{ id: 0, text: "src/initec.ts", term: "Initech" }]);
  });

  it("does not report near-misses on an item or Concept that is allowed", () => {
    const rules: Rule[] = [
      reveal("src/**"),
      { target: { kind: "concept", value: "Initech" }, action: "allow" },
    ];

    expect(nameFiles(["src/initec.ts"], config(rules), {}).nearMisses).toEqual([]);
  });
});

describe("findNearMisses", () => {
  it("catches case and separator variants and terms split across a boundary", () => {
    expect(findNearMisses("src/auth/service.ts", ["AuthService"])).toEqual(["AuthService"]);
    expect(findNearMisses("src/a-c-m-e.ts", ["acme"])).toEqual(["acme"]);
  });

  it("allows one edit for a 4-7 character term and two for a longer one", () => {
    expect(findNearMisses("xacmx", ["acme"])).toEqual(["acme"]);
    expect(findNearMisses("xacxxx", ["acme"])).toEqual([]);
    expect(findNearMisses("parxrss", ["parserss"])).toEqual(["parserss"]);
  });

  it("ignores short terms, which would match everything", () => {
    expect(findNearMisses("tax.ts", ["ts"])).toEqual([]);
  });
});

describe("encodeStrings", () => {
  it("writes the strings as a JSON array", () => {
    const { table } = nameFiles(["a.ts"], config(), {});

    expect(JSON.parse(encodeStrings(table))).toEqual(["TypeScript file 1"]);
  });
});
