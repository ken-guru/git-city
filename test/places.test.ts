import { describe, expect, it } from "vitest";
import { encodePlaces, type PlaceInput, namePlaces, nameFiles } from "../src/cli/naming.js";
import { parseConfig } from "../src/cli/config.js";
import { loadTheme } from "../src/cli/theme.js";
import { sourceName } from "../src/shared/places.js";

const theme = loadTheme("modern");
const colour = { hue: 300, saturation: 0.4, lightness: { light: 0.55, dark: 0.34 } };

function district(key: string, role: PlaceInput["role"], neighbourhoods: string[] = []): PlaceInput {
  return { key, role, neighbourhoods, anchor: { col: 0, row: 0 }, colour };
}

function config(rules: unknown[] = []) {
  return parseConfig(JSON.stringify({ rules }), "test");
}

function places(paths: string[], districts: PlaceInput[], cfg = config(), options: { private?: boolean } = {}) {
  const names = nameFiles(paths, cfg, options);
  return namePlaces(districts, cfg, { theme, seed: "root-commit", hidden: names.hidden, ...options });
}

describe("namePlaces", () => {
  it("gives a District a Generated name with its Role's noun, and keeps its colour and anchor", () => {
    const table = places(["docs/a.md"], [district("docs", "docs", ["docs"])]);
    const [d] = table.file.districts;
    expect(sourceName(d!.source)).toBe("generated");
    expect(d!.name).toBe(d!.generated);
    expect(d!.name.endsWith(` ${theme.roleNouns.docs}`)).toBe(true);
    expect(d!.colour).toEqual(colour);
    expect(d!.anchor).toEqual({ col: 0, row: 0 });
  });

  it("gives the City a proper name only, and each Neighbourhood a street name", () => {
    const table = places(["src/a.ts"], [district("src", null, ["src"])]);
    expect(table.file.city.name).not.toContain(" ");
    expect(sourceName(table.file.city.source)).toBe("generated");
    const [n] = table.file.districts[0]!.neighbourhoods;
    expect(sourceName(n!.source)).toBe("generated");
    expect(theme.streetSuffixes.some((s) => n!.name.endsWith(` ${s}`))).toBe(true);
  });

  it("shows a revealed Real name, keeping the Generated name as a subtitle", () => {
    const cfg = config([{ module: "auth", action: "reveal" }]);
    const [d] = places(["auth/a.ts"], [district("auth", "auth")], cfg).file.districts;
    expect(d!.name).toBe("auth");
    expect(sourceName(d!.source)).toBe("real");
    expect(d!.generated).not.toBe("auth");
  });

  it("prefers a Pseudonym over a revealed Real name", () => {
    const cfg = config([
      { module: "auth", action: "reveal" },
      { module: "auth", action: "pseudonym", as: "Login Service" },
    ]);
    const [d] = places(["auth/a.ts"], [district("auth", "auth")], cfg).file.districts;
    expect(d!.name).toBe("Login Service");
    expect(sourceName(d!.source)).toBe("pseudonym");
  });

  it("ignores reveals under --private", () => {
    const cfg = config([{ module: "auth", action: "reveal" }]);
    const [d] = places(["auth/a.ts"], [district("auth", "auth")], cfg, { private: true }).file.districts;
    expect(sourceName(d!.source)).toBe("generated");
  });

  it("never gives a Generated name that contains a hidden Concept", () => {
    // "Hub" is the Role noun for api. Hidden, it must not appear in any name.
    const cfg = config([{ concept: "Hub", action: "allow" }]);
    const districts = [district("api", "api"), district("svc", "api"), district("lib", "api")];
    const table = places(["api/a.ts", "svc/b.ts", "lib/c.ts"], districts, cfg);
    for (const d of table.file.districts) expect(d.name.toLowerCase()).not.toContain("hub");
    expect(encodePlaces(table).toLowerCase()).not.toContain("hub");
  });

  it("never gives a Generated name that contains a hidden folder name, including near-misses", () => {
    // A folder called "checkpoint" stays hidden, so no name may hold "checkpoint" or a close variant.
    const paths = ["checkpoint/a.ts", "checkpoints/b.ts"];
    const table = places(paths, [district("checkpoint", "auth"), district("checkpoints", "auth")]);
    const text = encodePlaces(table).toLowerCase();
    expect(text).not.toContain("checkpoint");
  });

  it("keeps every Generated name unique within the City", () => {
    const districts = Array.from({ length: 60 }, (_, i) => district(`m${i}`, "core"));
    const paths = districts.map((d) => `${d.key}/a.ts`);
    const names = places(paths, districts).file.districts.map((d) => d.generated);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps a Neighbourhood's street name when another District gains a Neighbourhood", () => {
    const before = places(["a/x.ts", "b/x.ts"], [district("a", null, ["a"]), district("b", null, ["b"])]);
    const after = places(["a/x.ts", "a/sub/y.ts", "b/x.ts"], [district("a", null, ["a", "a/sub"]), district("b", null, ["b"])]);
    expect(after.file.districts[1]!.neighbourhoods[0]!.name).toBe(before.file.districts[1]!.neighbourhoods[0]!.name);
  });

  it("fixes one Role noun for every District with that Role", () => {
    const districts = [district("a", "ui"), district("b", "ui"), district("c", "ui")];
    const nouns = places(["a/x.ts", "b/x.ts", "c/x.ts"], districts).file.districts.map((d) => d.generated.split(" ").slice(-1)[0]);
    expect(new Set(nouns)).toEqual(new Set([theme.roleNouns.ui.split(" ").slice(-1)[0]]));
  });
});
