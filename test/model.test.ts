import { describe, expect, it } from "vitest";
import { BUILDING_TYPES, buildingTypeOf, categoryOf, floorsFor, languageOf, seedFor } from "../src/cli/model.js";

describe("Floors", () => {
  it("is the ceiling of the square root of lines over k, at least one", () => {
    expect(floorsFor(0)).toBe(1);
    expect(floorsFor(1)).toBe(1);
    expect(floorsFor(9)).toBe(1); // sqrt 3 = 1.73, / 3 = 0.58
    expect(floorsFor(100)).toBe(4); // sqrt 10 = 3.16, / 3 = 1.05
    expect(floorsFor(900)).toBe(10); // sqrt 30 = 5.48, / 3 = 1.83
  });

  it("is capped at 32 Floors", () => {
    expect(floorsFor(10_000_000)).toBe(32);
  });
});

describe("Category and Building type", () => {
  it("detects the Category from the path", () => {
    expect(categoryOf("src/app.ts")).toBe("source");
    expect(categoryOf("test/app.test.ts")).toBe("tests");
    expect(categoryOf("docs/guide.md")).toBe("docs");
    expect(categoryOf("tsconfig.json")).toBe("config");
    expect(categoryOf(".github/workflows/ci.yml")).toBe("build");
    expect(categoryOf("data/users.csv")).toBe("data");
    expect(categoryOf("public/logo.png")).toBe("assets");
    expect(categoryOf("dist/bundle.js")).toBe("generated");
    expect(categoryOf("package-lock.json")).toBe("generated");
    expect(categoryOf("LICENSE")).toBe("unknown");
  });

  it("maps each Category to its Building type", () => {
    expect(buildingTypeOf("source")).toBe("office");
    expect(buildingTypeOf("tests")).toBe("laboratory");
    expect(buildingTypeOf("docs")).toBe("library");
    expect(buildingTypeOf("config")).toBe("utility");
    expect(buildingTypeOf("build")).toBe("factory");
    expect(buildingTypeOf("data")).toBe("storage");
    expect(buildingTypeOf("assets")).toBe("warehouse");
    expect(buildingTypeOf("generated")).toBe("rail-yard");
    expect(buildingTypeOf("unknown")).toBe("house");
  });

  it("has one kit per Building type", () => {
    expect(BUILDING_TYPES).toHaveLength(9);
    expect(new Set(BUILDING_TYPES).size).toBe(9);
  });
});

describe("language and seed", () => {
  it("gives a file its language colour from the extension, with a fallback", () => {
    expect(languageOf("src/app.ts")).toBe(languageOf("lib/other.ts"));
    expect(languageOf("src/app.ts")).not.toBe(languageOf("src/app.py"));
    expect(languageOf("README")).toBe(languageOf("NOTES.zzz-unknown"));
  });

  it("derives a seed from the birth order alone, and different orders give different seeds", () => {
    expect(seedFor(7)).toBe(seedFor(7));
    expect(seedFor(7)).not.toBe(seedFor(8));
    expect(seedFor(0)).toBeGreaterThanOrEqual(0);
    expect(seedFor(0)).toBeLessThan(2 ** 32);
  });
});
