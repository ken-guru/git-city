import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { encodeWorld, type WorldLayout } from "../shared/format.js";
import { type PlannedChunk, planChunks, sizeReport, type SizeReport, writeChunks } from "./chunks.js";
import { encodePlaces, encodeStrings, type PlaceTable, type StringTable } from "./naming.js";
import type { TimelineData } from "./timeline.js";

export class OutputError extends Error {}

/**
 * Writes the site into a staging folder next to `outDir`, then swaps it in,
 * so a failed run never leaves a half-written site behind. `check` runs on the
 * staged folder before the swap; if it throws, nothing is swapped in.
 * Returns the compressed sizes of the data against the budget.
 */
export async function writeSite(
  outDir: string,
  pageDir: string,
  timeline: TimelineData,
  layout: WorldLayout,
  names: StringTable,
  places: PlaceTable,
  check: (stagingDir: string) => Promise<void>,
  externals?: string,
): Promise<SizeReport> {
  await assertReplaceable(outDir);
  const staging = `${outDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await cp(pageDir, staging, { recursive: true });
  await mkdir(join(staging, "chunks"), { recursive: true });

  const plans = planChunks(timeline);
  await writeChunks(join(staging, "chunks"), plans, outDir);
  const world = encodeSiteWorld(timeline, plans, layout);
  await writeFile(join(staging, "world.bin"), world);
  await writeFile(join(staging, "strings.json"), encodeStrings(names));
  await writeFile(join(staging, "places.json"), encodePlaces(places));
  if (externals !== undefined) await writeFile(join(staging, "externals.json"), externals);
  const sizes = sizeReport(world, plans);

  try {
    await check(staging);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }

  const old = `${outDir}.old`;
  await rm(old, { recursive: true, force: true });
  if (existsSync(outDir)) await rename(outDir, old);
  await rename(staging, outDir);
  await rm(old, { recursive: true, force: true });
  return sizes;
}

/** The world file for a Timeline (already grouped into Steps) with its chunk plans and layout. */
export function encodeSiteWorld(timeline: TimelineData, plans: readonly PlannedChunk[], layout: WorldLayout): Uint8Array {
  return encodeWorld({
    commitDays: timeline.commitDays,
    stepCommits: timeline.stepCommits,
    fileCount: timeline.fileCount,
    buildingType: timeline.buildingType,
    language: timeline.language,
    seed: timeline.seed,
    chunks: plans.map((p) => ({ firstCommit: p.firstCommit, hash: p.hash })),
    ...layout,
  });
}

/** Refuses to replace a folder that holds something other than an earlier GitCity output. */
async function assertReplaceable(outDir: string): Promise<void> {
  if (!existsSync(outDir)) return;
  const entries = await readdir(outDir).catch(() => {
    throw new OutputError(`output path exists and is not a folder: ${outDir}`);
  });
  if (entries.length > 0 && !entries.includes("world.bin")) {
    throw new OutputError(`${basename(outDir)} already exists and is not a git-city site; choose another --out`);
  }
}
