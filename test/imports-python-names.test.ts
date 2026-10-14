import { describe, expect, it } from "vitest";
import { normalisePythonName, pythonNameMatches } from "../src/cli/imports/python.js";

/**
 * Seam under test: the PEP 503 name normalisation that matching an import against a declared dependency uses.
 * Expected values are literals written from PEP 503 (lowercase; each run of `-`, `_` or `.` becomes `-`).
 */

describe("PEP 503 name normalisation", () => {
  it("lowercases and collapses each run of '-', '_' and '.' into one '-'", () => {
    expect(normalisePythonName("Foo_Bar")).toBe("foo-bar");
    expect(normalisePythonName("zope.interface")).toBe("zope-interface");
    expect(normalisePythonName("a--__..b")).toBe("a-b");
  });
});

describe("matching an import against a declared dependency", () => {
  it("matches an import name to a declared name that differs only in case and separators", () => {
    expect(pythonNameMatches("foo-bar", "Foo_Bar")).toBe(true);
    expect(pythonNameMatches("Foo_Bar", "foo-bar")).toBe(true);
    expect(pythonNameMatches("zope", "Zope.Interface")).toBe(false);
  });

  it("does not match a different distribution that shares a prefix", () => {
    expect(pythonNameMatches("requests", "requests-oauthlib")).toBe(false);
  });
});
