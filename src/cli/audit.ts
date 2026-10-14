import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePlaces } from "../shared/places.js";

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
  const lines = strings.map((text, id) => `${id}\t${text}`);
  // Names of Districts, Neighbourhoods and the City come from places.json, which older sites may not have.
  const placesFile = join(dir, "places.json");
  if (existsSync(placesFile)) {
    const places = parsePlaces(await readFile(placesFile, "utf8"));
    lines.push(`city\t${places.city.name}`);
    for (const district of places.districts) {
      lines.push(`district ${district.id}\t${district.name}`);
      for (const n of district.neighbourhoods) lines.push(`neighbourhood ${district.id}.${n.id}\t${n.name}`);
    }
  }
  return lines;
}
