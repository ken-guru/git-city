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
  const pattern = hiddenPattern(needles);
  if (pattern === undefined) return;
  for (const file of await listFiles(stagingDir)) {
    if (pattern.test(scannedText(file, await readFile(file)))) {
      throw new PrivacyError(`privacy check failed: a hidden name or Concept appears in ${relative(stagingDir, file)}`);
    }
  }
}

/**
 * One case-insensitive pattern for every hidden name. A needle matches only as a whole word, so a short name such as
 * "git" does not fail the build on "GitCity" or on a generated name that happens to contain it. A hidden name that is
 * a whole word still fails, wherever it appears.
 */
function hiddenPattern(needles: readonly string[]): RegExp | undefined {
  const words = [...new Set(needles.map((n) => n.trim()))].filter((n) => n.length > 0);
  if (words.length === 0) return undefined;
  const alternatives = words.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "iu");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text a file is scanned as. A JSON file is scanned by its string values only: its keys are the
 * output's own fixed vocabulary, never user data, so a folder named "name" or "source" cannot fail the build.
 */
function scannedText(file: string, raw: Buffer): string {
  const text = raw.toString("utf8");
  if (!file.endsWith(".json")) return text;
  try {
    return stringValues(JSON.parse(text)).join("\n");
  } catch {
    return text;
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringValues);
  return [];
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
