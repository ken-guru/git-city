import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, loadTheme, ThemeError, validateTheme } from "../src/cli/theme.js";

function valid(): Record<string, unknown> {
  const roles = ["tests", "docs", "api", "ui", "auth", "data", "cli", "infra", "utils", "core", "config", "build", "fallback"];
  return {
    name: "test-theme",
    display: { title: "Test", description: "A test Theme." },
    wordPieces: { prefixes: ["Ash"], suffixes: ["ford"] },
    streetSuffixes: ["Lane"],
    roleNouns: Object.fromEntries(roles.map((r) => [r, "Noun"])),
    palette: Object.fromEntries(roles.map((r) => [r, { hue: 10 }])),
  };
}

describe("loadTheme", () => {
  it("loads the built-in modern and medieval packs, which validate", () => {
    expect(loadTheme("modern").name).toBe("modern");
    expect(loadTheme("medieval").name).toBe("medieval");
  });

  it("gives every Role a noun and a hue, plus a fallback", () => {
    const theme = loadTheme("medieval");
    for (const role of ["tests", "docs", "api", "ui", "auth", "data", "cli", "infra", "utils", "core", "config", "build", "fallback"]) {
      expect(theme.roleNouns[role as keyof typeof theme.roleNouns]).toMatch(/^[A-Za-z]/);
      expect(theme.palette[role as keyof typeof theme.palette].hue).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses an unknown Theme name", () => {
    expect(() => loadTheme("no-such-theme")).toThrow(ThemeError);
  });
});

describe("validateTheme", () => {
  it("accepts a complete pack", () => {
    expect(validateTheme(valid()).name).toBe("test-theme");
  });

  it("rejects a pack whose Role has no noun", () => {
    const pack = valid();
    delete (pack.roleNouns as Record<string, unknown>).auth;
    expect(() => validateTheme(pack)).toThrow(/roleNouns.*auth/);
  });

  it("rejects a pack without a fallback noun", () => {
    const pack = valid();
    delete (pack.roleNouns as Record<string, unknown>).fallback;
    expect(() => validateTheme(pack)).toThrow(/fallback/);
  });

  it("gives a Theme with no palette the built-in palette", () => {
    const pack = valid();
    delete pack.palette;
    const theme = validateTheme(pack);
    expect(theme.palette).toEqual(DEFAULT_PALETTE);
    expect(theme.palette.fallback.hue).toBe(40);
  });

  it("keeps the built-in palette equal to the modern Theme's, the default", () => {
    expect(DEFAULT_PALETTE).toEqual(loadTheme("modern").palette);
  });

  it("rejects a Role with no palette hue", () => {
    const pack = valid();
    delete (pack.palette as Record<string, unknown>).docs;
    expect(() => validateTheme(pack)).toThrow(/palette.*docs/);
  });

  it("rejects a hue out of range and an unknown key", () => {
    const hue = valid();
    (hue.palette as Record<string, { hue: number }>).ui = { hue: 400 };
    expect(() => validateTheme(hue)).toThrow(/hue/);

    const extra = valid();
    extra.code = "alert(1)";
    expect(() => validateTheme(extra)).toThrow(/unknown key "code"/);
  });
});
