/**
 * The binary output format, shared by the CLI (which writes it) and the page (which reads it).
 * Numbers only: every human-readable string lives in `strings.json`.
 * All integers are little-endian; arrays are stored column by column.
 */

export const FORMAT_VERSION = 3;

const WORLD_MAGIC = 0x57435447; // "GTCW"
const CHUNK_MAGIC = 0x43435447; // "GTCC"
export const CHUNK_HASH_BYTES = 8;
export const SECONDS_PER_DAY = 86_400;

/**
 * Event kinds. A value column carries one number per event:
 * ADD: the Floors the Building starts with; FLOORS: the new Floors;
 * RELOCATE and RENOVATE: the new Building type index; LANGUAGE: the new language index; the others ignore it.
 */
export const EVENT_ADD = 1;
export const EVENT_DELETE = 2;
export const EVENT_FLOORS = 3;
export const EVENT_SCAFFOLD_ON = 4;
export const EVENT_SCAFFOLD_OFF = 5;
/** The same Building, moved to another directory: torn down and rebuilt on a new Lot. */
export const EVENT_RELOCATE = 6;
/** The Building type changed: rebuilt as the new type on the same Lot. */
export const EVENT_RENOVATE = 7;
/** The language changed: the roof and trim colour eases. */
export const EVENT_LANGUAGE = 8;
export type EventKind =
  | typeof EVENT_ADD
  | typeof EVENT_DELETE
  | typeof EVENT_FLOORS
  | typeof EVENT_SCAFFOLD_ON
  | typeof EVENT_SCAFFOLD_OFF
  | typeof EVENT_RELOCATE
  | typeof EVENT_RENOVATE
  | typeof EVENT_LANGUAGE;

export interface ChunkRef {
  /** Sequence number of the chunk's first commit. */
  firstCommit: number;
  /** File name inside `chunks/`: index plus content hash. */
  name: string;
}

/** Everything that never changes during playback. Always fetched fresh. */
export interface World {
  formatVersion: number;
  /** Day of each commit (days since 1970-01-01 UTC), in sequence order. */
  commitDays: Int32Array;
  /** Number of files ever standing; file ids run from 0 to fileCount - 1. */
  fileCount: number;
  /** Per file: its Building type (index into BUILDING_TYPES). */
  buildingType: Uint8Array;
  /** Per file: its language index (index into LANGUAGES). */
  language: Uint8Array;
  /** Per file: its seed. */
  seed: Uint32Array;
  chunks: ChunkRef[];
}

/**
 * The state of every standing file as the chunk's first commit begins, before its own events. Columns run
 * in step: entry i describes file `file[i]`. Replaying the events from here reaches any commit in the chunk.
 */
export interface ChunkSnapshot {
  file: Uint32Array;
  /** Floors on screen once the commit before has settled. */
  floors: Uint8Array;
  /** 1 when the scaffolding is up, else 0. */
  scaffolded: Uint8Array;
  /** Building type index (see BUILDING_TYPES) right now. */
  buildingType: Uint8Array;
  /** Language index (see LANGUAGES) right now. */
  language: Uint8Array;
}

/** A snapshot at the chunk's first commit plus the events inside the chunk. */
export interface Chunk {
  formatVersion: number;
  firstCommit: number;
  snapshot: ChunkSnapshot;
  eventCommit: Uint32Array;
  eventFile: Uint32Array;
  eventKind: Uint8Array;
  /** One value per event; see the event kinds. */
  eventValue: Uint8Array;
}

export class FormatVersionError extends Error {
  constructor(readonly found: number) {
    super(`unsupported format version ${found} (expected ${FORMAT_VERSION})`);
  }
}

export function chunkName(index: number, hash: Uint8Array): string {
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${String(index).padStart(4, "0")}.${hex}.bin`;
}

const FILE_ATTRIBUTE_BYTES = 1 + 1 + 4;

export function encodeWorld(world: Omit<World, "formatVersion" | "chunks"> & { chunks: { firstCommit: number; hash: Uint8Array }[] }): Uint8Array {
  const n = world.fileCount;
  if (world.buildingType.length !== n || world.language.length !== n || world.seed.length !== n) {
    throw new Error("per-file columns differ in length from fileCount");
  }
  const w = new Writer(20 + world.commitDays.length * 4 + n * FILE_ATTRIBUTE_BYTES + world.chunks.length * (4 + CHUNK_HASH_BYTES));
  w.u32(WORLD_MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(world.commitDays.length);
  w.u32(world.fileCount);
  w.u32(world.chunks.length);
  for (const day of world.commitDays) w.i32(day);
  w.bytes(world.buildingType);
  w.bytes(world.language);
  for (const seed of world.seed) w.u32(seed);
  for (const chunk of world.chunks) {
    if (chunk.hash.length !== CHUNK_HASH_BYTES) throw new Error(`chunk hash must be ${CHUNK_HASH_BYTES} bytes`);
    w.u32(chunk.firstCommit);
    w.bytes(chunk.hash);
  }
  return w.done();
}

export function decodeWorld(bytes: Uint8Array): World {
  const r = new Reader(bytes, WORLD_MAGIC);
  const commitCount = r.u32();
  const fileCount = r.u32();
  const chunkCount = r.u32();
  const commitDays = new Int32Array(commitCount);
  for (let i = 0; i < commitCount; i++) commitDays[i] = r.i32();
  const buildingType = r.bytes(fileCount);
  const language = r.bytes(fileCount);
  const seed = r.u32s(fileCount);
  const chunks: ChunkRef[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const firstCommit = r.u32();
    chunks.push({ firstCommit, name: chunkName(i, r.bytes(CHUNK_HASH_BYTES)) });
  }
  return { formatVersion: r.formatVersion, commitDays, fileCount, buildingType, language, seed: Uint32Array.from(seed), chunks };
}

export function encodeChunk(chunk: Omit<Chunk, "formatVersion">): Uint8Array {
  const n = chunk.eventCommit.length;
  if (chunk.eventFile.length !== n || chunk.eventKind.length !== n || chunk.eventValue.length !== n) {
    throw new Error("event columns differ in length");
  }
  const s = chunk.snapshot;
  const m = s.file.length;
  if (s.floors.length !== m || s.scaffolded.length !== m || s.buildingType.length !== m || s.language.length !== m) {
    throw new Error("snapshot columns differ in length");
  }
  const w = new Writer(20 + m * (4 + 4) + n * 10);
  w.u32(CHUNK_MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(chunk.firstCommit);
  w.u32(m);
  w.u32(n);
  for (const id of s.file) w.u32(id);
  w.bytes(s.floors);
  w.bytes(s.scaffolded);
  w.bytes(s.buildingType);
  w.bytes(s.language);
  for (const c of chunk.eventCommit) w.u32(c);
  for (const f of chunk.eventFile) w.u32(f);
  w.bytes(chunk.eventKind);
  w.bytes(chunk.eventValue);
  return w.done();
}

export function decodeChunk(bytes: Uint8Array): Chunk {
  const r = new Reader(bytes, CHUNK_MAGIC);
  const firstCommit = r.u32();
  const snapshotCount = r.u32();
  const n = r.u32();
  const snapshot: ChunkSnapshot = {
    file: r.u32s(snapshotCount),
    floors: r.bytes(snapshotCount),
    scaffolded: r.bytes(snapshotCount),
    buildingType: r.bytes(snapshotCount),
    language: r.bytes(snapshotCount),
  };
  const eventCommit = r.u32s(n);
  const eventFile = r.u32s(n);
  const eventKind = r.bytes(n);
  const eventValue = r.bytes(n);
  return { formatVersion: r.formatVersion, firstCommit, snapshot, eventCommit, eventFile, eventKind, eventValue };
}

class Writer {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  u32(v: number) {
    this.view.setUint32(this.at, v, true);
    this.at += 4;
  }
  i32(v: number) {
    this.view.setInt32(this.at, v, true);
    this.at += 4;
  }
  bytes(b: Uint8Array) {
    this.buf.set(b, this.at);
    this.at += b.length;
  }
  done(): Uint8Array {
    if (this.at !== this.buf.length) throw new Error("encoded size mismatch");
    return this.buf;
  }
}

class Reader {
  private readonly view: DataView;
  private at = 0;
  readonly formatVersion: number;
  constructor(private readonly buf: Uint8Array, magic: number) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.byteLength < 8 || this.u32() !== magic) throw new Error("not a git-city data file");
    this.formatVersion = this.u32();
    if (this.formatVersion !== FORMAT_VERSION) throw new FormatVersionError(this.formatVersion);
  }
  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }
  u32s(n: number): Uint32Array {
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.u32();
    return out;
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.buf.byteLength) throw new RangeError("data file is truncated");
    const out = this.buf.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
}
