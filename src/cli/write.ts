import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CHUNK_HASH_BYTES, chunkName, encodeChunk, encodeWorld } from "../shared/format.js";
import { encodeStrings, type StringTable } from "./naming.js";
import type { TimelineData } from "./timeline.js";

export class OutputError extends Error {}

/**
 * Writes the site into a staging folder next to `outDir`, then swaps it in,
 * so a failed run never leaves a half-written site behind. `check` runs on the
 * staged folder before the swap; if it throws, nothing is swapped in.
 */
export async function writeSite(
  outDir: string,
  pageDir: string,
  timeline: TimelineData,
  names: StringTable,
  check: (stagingDir: string) => Promise<void>,
): Promise<void> {
  await assertReplaceable(outDir);
  const staging = `${outDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await cp(pageDir, staging, { recursive: true });
  await mkdir(join(staging, "chunks"), { recursive: true });

  // The walking skeleton writes the whole Timeline as one chunk, with an empty snapshot.
  const chunk = encodeChunk({
    firstCommit: 0,
    snapshot: new Uint32Array(0),
    eventCommit: timeline.eventCommit,
    eventFile: timeline.eventFile,
    eventKind: timeline.eventKind,
    eventValue: timeline.eventValue,
  });
  const hash = createHash("sha256").update(chunk).digest().subarray(0, CHUNK_HASH_BYTES);
  await writeFile(join(staging, "chunks", chunkName(0, hash)), chunk);
  await writeFile(
    join(staging, "world.bin"),
    encodeWorld({
      commitDays: timeline.commitDays,
      fileCount: timeline.fileCount,
      buildingType: timeline.buildingType,
      language: timeline.language,
      seed: timeline.seed,
      chunks: [{ firstCommit: 0, hash }],
    }),
  );
  await writeFile(join(staging, "strings.json"), encodeStrings(names));

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
