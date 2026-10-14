import type { BuildSummary } from "./build.js";
import { describeSizes, FIRST_PLAY_BUDGET_BYTES, type SizeReport, TOTAL_BUDGET_BYTES } from "./chunks.js";
import { describeSteps } from "./steps.js";

/** More standing Buildings than this and the page leans on level of detail (SPEC §10 scale warnings). */
export const MANY_BUILDINGS = 20_000;

/** Warnings for the scale limits. They never refuse a build: the build warns and adapts. */
export function scaleWarnings(buildings: number, sizes: SizeReport): string[] {
  const warnings: string[] = [];
  if (buildings > MANY_BUILDINGS) {
    warnings.push(
      `${buildings} Buildings stand at once; the page will lean on level of detail. Consider "exclude" in the config.`,
    );
  }
  if (sizes.firstPlayBytes > FIRST_PLAY_BUDGET_BYTES || sizes.totalBytes > TOTAL_BUDGET_BYTES) {
    warnings.push("the site is over its size budget (SPEC §9); the build summary shows the sizes.");
  }
  return warnings;
}

/** The interactive build summary: privacy, near-misses, sizes, Steps, the output path and the first-run hint. */
export function formatBuildSummary(summary: BuildSummary): string {
  const lines = [headline(summary)];
  if (summary.revealed.length > 0) {
    lines.push(`Revealed ${summary.revealed.length} name${summary.revealed.length === 1 ? "" : "s"}:`);
    for (const r of summary.revealed) lines.push(`  ${r.text}`);
  } else lines.push("Revealed 0 names.");
  for (const miss of summary.nearMisses) {
    lines.push(`Near-miss: "${miss.text}" is close to a hidden name or Concept (use --strict to fail on these)`);
  }
  lines.push(`Theme: ${summary.theme}`);
  lines.push(...describeSteps(summary.steps));
  lines.push(...describeSizes(summary.sizes));
  if (summary.configSources.length > 0) lines.push(`Config: ${summary.configSources.join(", ")}`);
  if (summary.outputIgnored === false) {
    const entry = summary.outputIgnoreEntry ?? "git-city-site/";
    lines.push(`Tip: add ${entry} to .gitignore so the site is not committed (git-city never edits .gitignore).`);
  }
  lines.push(`Run "git-city serve" to watch it.`);
  return `${lines.join("\n")}\n`;
}

/** One line for CI logs. */
export function formatBuildLine(summary: BuildSummary): string {
  return `${headline(summary)} (theme ${summary.theme}, ${kib(summary.sizes.firstPlayBytes)} to first play)`;
}

/** The build result as JSON, for `--json`. */
export function buildJson(summary: BuildSummary): string {
  return JSON.stringify(
    {
      branch: summary.branch,
      commits: summary.commits,
      files: summary.files,
      outDir: summary.outDir,
      theme: summary.theme,
      revealed: summary.revealed.map((r) => r.text),
      nearMisses: summary.nearMisses.map((m) => m.text),
      configSources: summary.configSources,
      warnings: summary.warnings,
      sizes: summary.sizes,
      outputIgnored: summary.outputIgnored ?? null,
    },
    null,
    2,
  );
}

/** The first line of both build formats. */
function headline(summary: BuildSummary): string {
  return `Built ${summary.commits} commits and ${summary.files} files from ${summary.branch} into ${summary.outDir}`;
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}
