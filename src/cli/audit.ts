import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class AuditError extends Error {}

/**
 * Lists every string in a built site, as `id<TAB>text` lines, in the order
 * strings.json holds them. Reads only the output folder.
 */
export async function auditSite(dir: string): Promise<string[]> {
  const file = join(dir, "strings.json");
  if (!existsSync(file)) throw new AuditError(`no strings.json in ${dir}: not a built git-city site`);
  const strings = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!Array.isArray(strings) || !strings.every((s) => typeof s === "string")) {
    throw new AuditError(`strings.json in ${dir} is not a list of strings`);
  }
  return strings.map((text, id) => `${id}\t${text}`);
}
