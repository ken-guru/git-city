import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** A privacy check failed: a near-miss under --strict, or a hidden name in the output. Exit code 2. */
export class PrivacyError extends Error {}

/** Folders the scan skips: the page bundle is our own static code, and holds no user data. */
const SKIPPED_FOLDERS = new Set(["assets"]);

/**
 * The final scan over a staged output folder. Fails on the first hidden needle found.
 * The message names the file, never the needle, so a hidden name cannot leak into a log.
 */
export async function scanOutput(stagingDir: string, needles: readonly string[]): Promise<void> {
  const lowered = [...new Set(needles.map((n) => n.toLowerCase()))].filter((n) => n.length > 0);
  if (lowered.length === 0) return;
  for (const file of await listFiles(stagingDir)) {
    const text = (await readFile(file)).toString("utf8").toLowerCase();
    if (lowered.some((needle) => text.includes(needle))) {
      throw new PrivacyError(`privacy check failed: a hidden name or Concept appears in ${relative(stagingDir, file)}`);
    }
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) out.push(...(await listFiles(full)));
    } else if (entry.isFile()) out.push(full);
  }
  return out;
}
