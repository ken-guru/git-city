import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, type BuildSummary } from "../src/cli/build.js";
import { decodeWorld, type World } from "../src/shared/format.js";
import { FixtureRepo } from "./fixture.js";

/**
 * Seams under test: `build()` end to end, observed through the written world file and the build summary.
 * Layout and Lots must be the same with and without Steps; claim times are the only thing that moves to Steps.
 * Changing `exclude` must rebuild from scratch and say so.
 */

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

/** One commit per file, 20 days apart, with the first file changing every time: about 2 years of history. */
function history(commits: number): FixtureRepo {
  const repo = new FixtureRepo();
  cleanups.push(() => repo.remove());
  for (let i = 0; i < commits; i++) {
    repo.write(`src/f${i}.ts`, `export const v${i} = ${i};\n`);
    repo.write("src/f0.ts", `// revision ${i}\n`.repeat(i + 1));
    repo.commit(`commit ${i}`, 20);
  }
  return repo;
}

async function run(repo: FixtureRepo, config?: string): Promise<{ summary: BuildSummary; world: World; outDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "git-city-steps-build-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pageDir = join(root, "page");
  mkdirSync(pageDir);
  writeFileSync(join(pageDir, "index.html"), "<!doctype html>stub page");
  const outDir = join(root, "git-city-site");
  let configPath: string | undefined;
  if (config !== undefined) {
    configPath = join(root, "git-city.config.jsonc");
    writeFileSync(configPath, config);
  }
  const summary = await build({ repoDir: repo.dir, outDir, pageDir, configPath });
  const world = decodeWorld(readFileSync(join(outDir, "world.bin")));
  return { summary, world, outDir };
}

/** The month a day falls in, as a single number, for independent expected values. */
function monthOf(day: number): number {
  const date = new Date(day * 86_400_000);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

describe("build with Steps", () => {
  it("leaves Lots and Block positions unchanged when history is grouped by month", async () => {
    const repo = history(40);
    const perCommit = await run(repo, `{ "scale": { "timeline": "commit" } }`);
    const grouped = await run(repo, `{ "scale": { "timeline": "month" } }`);

    expect(grouped.world.lots).toEqual(perCommit.world.lots);
    expect(grouped.world.blocks.x).toEqual(perCommit.world.blocks.x);
    expect(grouped.world.blocks.z).toEqual(perCommit.world.blocks.z);
    expect(grouped.world.blocks.village).toEqual(perCommit.world.blocks.village);
    expect(grouped.world.blocks.brick).toEqual(perCommit.world.blocks.brick);
    expect(grouped.world.widthStep).toEqual(perCommit.world.widthStep);
    // The comparison only means something if grouping happened.
    expect(grouped.world.commitDays.length).toBeLessThan(perCommit.world.commitDays.length);
  });

  it("maps each Block's claim to the month Step its commit belongs to", async () => {
    const repo = history(40);
    const perCommit = await run(repo, `{ "scale": { "timeline": "commit" } }`);
    const grouped = await run(repo, `{ "scale": { "timeline": "month" } }`);

    const days = [...perCommit.world.commitDays];
    const stepOfCommit = (c: number) => new Set(days.slice(0, c + 1).map(monthOf)).size - 1;
    const expected = [...perCommit.world.blocks.claimed].map(stepOfCommit);
    expect([...grouped.world.blocks.claimed]).toEqual(expected);
    expect(grouped.world.commitDays.length).toBeLessThan(perCommit.world.commitDays.length);
  });

  it("counts the commits in each Step, which add up to the whole history", async () => {
    const repo = history(40);
    const grouped = await run(repo, `{ "scale": { "timeline": "month" } }`);
    const total = [...grouped.world.stepCommits].reduce((sum, n) => sum + n, 0);
    expect(total).toBe(40);
    expect(grouped.world.stepCommits.length).toBe(grouped.world.commitDays.length);
  });

  it("reports the Steps used per era, and forced levels group the whole history", async () => {
    const repo = history(40);
    const monthly = await run(repo, `{ "scale": { "timeline": "month" } }`);
    expect(monthly.summary.steps).toEqual([
      { level: "month", fromCommit: 0, toCommit: 40, steps: monthly.world.commitDays.length },
    ]);
    expect(monthly.world.commitDays.length).toBeLessThan(40);
  });

  it("rebuilds from scratch, with a warning, when exclude changes, and leaves the excluded files out", async () => {
    const repo = history(12);
    const first = await run(repo);
    expect(first.world.fileCount).toBe(12);
    expect(first.summary.warnings.some((w) => w.includes("exclude rules changed"))).toBe(false);

    const excluded = await run(repo, `{ "exclude": ["src/f1*.ts"] }`);
    expect(excluded.summary.warnings.some((w) => w.includes("exclude rules changed"))).toBe(true);
    // f1 and f10 and f11 are gone.
    expect(excluded.world.fileCount).toBe(9);

    const again = await run(repo, `{ "exclude": ["src/f1*.ts"] }`);
    expect(again.summary.warnings.some((w) => w.includes("exclude rules changed"))).toBe(false);
    expect(again.world.fileCount).toBe(9);
  });
});
