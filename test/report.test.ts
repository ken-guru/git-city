import { describe, expect, it } from "vitest";
import type { BuildSummary } from "../src/cli/build.js";
import { buildJson, formatBuildLine, formatBuildSummary, scaleWarnings } from "../src/cli/report.js";
import { browserCommand } from "../src/cli/serve.js";

const summary: BuildSummary = {
  branch: "main",
  commits: 2,
  files: 2,
  outDir: "/repo/git-city-site",
  configSources: [],
  revealed: [],
  nearMisses: [],
  warnings: [],
  sizes: { chunks: 1, worldBytes: 100, firstPlayBytes: 2048, totalBytes: 4096 },
  theme: "modern",
  outputIgnored: false,
};

describe("build report", () => {
  it("prints the interactive summary with the gitignore hint", () => {
    const text = formatBuildSummary(summary);
    expect(text).toContain("Built 2 commits and 2 files from main into /repo/git-city-site");
    expect(text).toContain("Revealed 0 names.");
    expect(text).toContain("Theme: modern");
    expect(text).toContain("Steps: none");
    expect(text).toContain(".gitignore");
    expect(text).toContain('Run "git-city serve"');
  });

  it("drops the hint once the output folder is ignored", () => {
    expect(formatBuildSummary({ ...summary, outputIgnored: true })).not.toContain(".gitignore");
  });

  it("prints one line for CI", () => {
    const line = formatBuildLine(summary);
    expect(line).toBe("Built 2 commits and 2 files from main into /repo/git-city-site (theme modern, 2 KB to first play)");
    expect(line.includes("\n")).toBe(false);
  });

  it("emits JSON with the sizes, warnings and output path", () => {
    const json = JSON.parse(buildJson({ ...summary, warnings: ["w"] })) as Record<string, unknown>;
    expect(json).toMatchObject({ branch: "main", commits: 2, outDir: "/repo/git-city-site", warnings: ["w"], theme: "modern" });
    expect(json.sizes).toEqual(summary.sizes);
  });

  it("warns about more than 20k standing Buildings and about the size budget", () => {
    expect(scaleWarnings(20_000, summary.sizes)).toEqual([]);
    expect(scaleWarnings(20_001, summary.sizes)).toEqual([expect.stringContaining("level of detail")]);
    const huge = { ...summary.sizes, totalBytes: 16 * 1024 * 1024, firstPlayBytes: 2 * 1024 * 1024 };
    expect(scaleWarnings(10, huge)).toEqual([expect.stringContaining("size budget")]);
  });
});

describe("browserCommand", () => {
  it("picks the opener for each platform", () => {
    expect(browserCommand("darwin", "http://localhost:4173/")).toEqual(["open", ["http://localhost:4173/"]]);
    expect(browserCommand("linux", "http://localhost:4173/")).toEqual(["xdg-open", ["http://localhost:4173/"]]);
    expect(browserCommand("win32", "http://localhost:4173/")).toEqual(["cmd", ["/c", "start", "", "http://localhost:4173/"]]);
  });
});
