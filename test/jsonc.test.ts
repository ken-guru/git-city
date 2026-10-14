import { describe, expect, it } from "vitest";
import { ConfigError, parseJsonc } from "../src/cli/jsonc.js";

describe("parseJsonc", () => {
  it("accepts line and block comments, trailing commas and comment-like text inside strings", () => {
    const value = parseJsonc(`// header
{
  /* block */
  "url": "https://example.com/a//b", // trailing
  "list": [1, 2,],
  "note": "/* not a comment */",
}`);

    expect(value).toEqual({ url: "https://example.com/a//b", list: [1, 2], note: "/* not a comment */" });
  });

  it("reports the line and column of a syntax error", () => {
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow(ConfigError);
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow(/line 3/);
  });
});
