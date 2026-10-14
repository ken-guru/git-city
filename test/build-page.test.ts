import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows cannot run here, so this pins the rule the Windows smoke job depends on: build paths come
// from fileURLToPath. URL.pathname yields "/D:/..." on Windows, which esbuild cannot resolve.
const script = readFileSync(new URL("../scripts/build-page.mjs", import.meta.url), "utf8");

describe("scripts/build-page.mjs paths", () => {
  it("converts file URLs with fileURLToPath", () => {
    expect(script).toContain('import { fileURLToPath } from "node:url"');
    expect(script).toMatch(/entry = fileURLToPath\(new URL\("\.\.\/src\/page\/main\.ts", import\.meta\.url\)\)/);
  });

  it("never reads a URL pathname", () => {
    expect(script).not.toMatch(/\.pathname\b/);
  });
});
