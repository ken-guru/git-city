/**
 * places.json: the display names and colours of Districts, Neighbourhoods and the City. Written by the naming
 * step only. Shared by the CLI (which writes it) and the page (which labels Districts with it).
 *
 * Only the names are text. Everything else is a number, so structural words (a source, a Role) can never
 * collide with a hidden folder name in the final privacy scan.
 */
export const PLACES_FORMAT_VERSION = 1;

/** Where a display name came from. Stored as an index into this list. */
export const NAME_SOURCES = ["generated", "real", "pseudonym"] as const;
export type NameSource = (typeof NAME_SOURCES)[number];

export interface PlaceName {
  name: string;
  /** Index into NAME_SOURCES. */
  source: number;
}

export interface NeighbourhoodPlace extends PlaceName {
  id: number;
}

export interface DistrictPlace extends PlaceName {
  /** Birth order of the District. */
  id: number;
  /** The Generated name, always present: a revealed District keeps it as a subtitle. */
  generated: string;
  /** Paving colour: hue in degrees, saturation and lightness as fractions. */
  colour: { hue: number; saturation: number; lightness: number };
  /** Where the District's village is anchored, in Block-grid cells. */
  anchor: { col: number; row: number };
  neighbourhoods: NeighbourhoodPlace[];
}

export interface PlacesFile {
  formatVersion: number;
  city: PlaceName;
  districts: DistrictPlace[];
}

/** Parses a places.json text, refusing one written by another format version. */
export function parsePlaces(text: string): PlacesFile {
  const value = JSON.parse(text) as PlacesFile;
  if (value.formatVersion !== PLACES_FORMAT_VERSION) {
    throw new Error(`places.json format ${value.formatVersion} does not match ${PLACES_FORMAT_VERSION}`);
  }
  return value;
}

/** The name source as its word. */
export function sourceName(index: number): NameSource {
  return NAME_SOURCES[index] ?? "generated";
}
