/**
 * The binary output format, shared by the CLI (which writes it) and the page (which reads it).
 * Numbers only: every human-readable string lives in `strings.json`.
 * All integers are little-endian; arrays are stored column by column.
 */

export const FORMAT_VERSION = 10;

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
/**
 * A District is split off from its parent (a manifest appeared inside it). The file column holds the new District's
 * birth index and the stint column the parent's. Blocks change owner in the same commit (see EVENT_BLOCK_OWNER).
 */
export const EVENT_DISTRICT_SPLIT = 9;
/** A District merges back into its parent (its manifest went). File and stint columns as for EVENT_DISTRICT_SPLIT. */
export const EVENT_DISTRICT_MERGE = 10;
/**
 * A Block gets a new owner: when it is claimed, or when its Neighbourhood moves to another District. The file column
 * holds the Block id and the stint column the owning District's birth index. Its paving eases to the new colour.
 */
export const EVENT_BLOCK_OWNER = 11;
/** A Road first appears in the network. The file column holds the Road id (see the world file's roads). */
export const EVENT_ROAD_BUILT = 12;
/**
 * A Road's Lanes change. The file column holds the Road id, the value column the forward Lanes and the stint column
 * the backward Lanes. A Road with no Lanes either way is an unpaved track.
 */
export const EVENT_ROAD_LANES = 13;
export type EventKind =
  | typeof EVENT_ADD
  | typeof EVENT_DELETE
  | typeof EVENT_FLOORS
  | typeof EVENT_SCAFFOLD_ON
  | typeof EVENT_SCAFFOLD_OFF
  | typeof EVENT_RELOCATE
  | typeof EVENT_RENOVATE
  | typeof EVENT_LANGUAGE
  | typeof EVENT_DISTRICT_SPLIT
  | typeof EVENT_DISTRICT_MERGE
  | typeof EVENT_BLOCK_OWNER
  | typeof EVENT_ROAD_BUILT
  | typeof EVENT_ROAD_LANES;

/**
 * A Stint is one occupancy of a Lot by a Building: born with an ADD, RELOCATE or RENOVATE. Stints are numbered in
 * the order the Timeline creates them. A Relocated or Renovated file gets a new Stint; its old one is taken down.
 */
export interface StintTable {
  /** Per Stint: the file it belongs to. */
  file: Uint32Array;
  /** Per Stint: the Lot it stands on (index into the layout's Lots). */
  lot: Uint32Array;
  /** Per Stint: its Building type at creation (index into BUILDING_TYPES). */
  buildingType: Uint8Array;
}

export interface ChunkRef {
  /** Sequence number of the chunk's first commit. */
  firstCommit: number;
  /** File name inside `chunks/`: index plus content hash. */
  name: string;
}

/** Everything that never changes during playback. Always fetched fresh. */
export interface World {
  formatVersion: number;
  /** Day of each Step (days since 1970-01-01 UTC), in sequence order: the day of its first commit. */
  commitDays: Int32Array;
  /**
   * Per Step: the time of its first commit, in whole seconds since 1970 UTC. Present only with `exactTimes` (SPEC §8);
   * the page shows it in place of the day.
   */
  commitSeconds?: Uint32Array;
  /** Per Step: how many commits it holds (1 for a single commit). Steps are described in SPEC §9. */
  stepCommits: Uint32Array;
  /** Number of files ever standing; file ids run from 0 to fileCount - 1. */
  fileCount: number;
  /** Per file: its Building type (index into BUILDING_TYPES). */
  buildingType: Uint8Array;
  /** Per file: its language index (index into LANGUAGES). */
  language: Uint8Array;
  /** Per file: its seed. */
  seed: Uint32Array;
  chunks: ChunkRef[];
  /** The City seed. The Countryside and the layout are both drawn from it. */
  citySeed: number;
  /** Per file: its width step (0 narrowest, 3 widest) at the end of the run. */
  widthStep: Uint8Array;
  /** Villages, in founding order. Position is in Block widths; the angle turns the village's Block grid. */
  villages: { x: Float32Array; z: Float32Array; angle: Float32Array };
  /**
   * Blocks, in claim order. Position is in Block widths; `claimed` is the commit that claimed each Block;
   * `district` is the position of the District that owns it in the places file (0xffffffff for none).
   */
  blocks: { village: Uint32Array; x: Float32Array; z: Float32Array; claimed: Uint32Array; brick: Uint8Array; district: Uint32Array };
  /** Lots, in birth order. Each `slots` run is a contiguous run of unit slots within its Block. */
  lots: { file: Uint32Array; block: Uint32Array; slot: Uint8Array; slots: Uint8Array };
  /** The Road network between villages, one entry per Road. */
  roads: { a: Uint32Array; b: Uint32Array; forward: Uint8Array; backward: Uint8Array; track: Uint8Array };
  /** Every Stint, in creation order: the Lot and type each Building occupancy has. */
  stints: StintTable;
  /**
   * Per District, in the places file's order: its birth index (the number the District's events carry) and the width
   * factor of its Block streets, times 100 (SPEC §7: streets widen with strength, up to 2×).
   */
  districts: { index: Uint32Array; street: Uint8Array };
  /**
   * Contributors (SPEC §8), present only when contributors are on: per Contributor, its name (a string id in
   * strings.json) and whether it is Automation; per Step, the index of the Contributor who made its newest commit.
   */
  contributors?: { name: Uint32Array; automation: Uint8Array; ofStep: Uint32Array };
  /** Per Step: the string id of its commit message, or NO_CONTENT when it has none. Present only with commit messages (SPEC §11). */
  messages?: Uint32Array;
}

/** The value that marks an absent Contributor or message in a per-Step column. */
export const NO_CONTENT = 0xffffffff;

/**
 * The state of every standing file as the chunk's first commit begins, before its own events. Columns run
 * in step: entry i describes file `file[i]`. Replaying the events from here reaches any commit in the chunk.
 */
export interface ChunkSnapshot {
  file: Uint32Array;
  /** Per standing file: the Stint it occupies now. */
  stint: Uint32Array;
  /** Blocks claimed before the chunk's first commit, and the birth index of each one's owning District. */
  blockIds: Uint32Array;
  blockDistricts: Uint32Array;
  /** Roads built before the chunk's first commit: the commit each was built at, and its Lanes each way. */
  roadIds: Uint32Array;
  roadBuilt: Uint32Array;
  roadForward: Uint8Array;
  roadBackward: Uint8Array;
  /** Floors on screen once the commit before has settled. */
  floors: Uint8Array;
  /** 1 when the scaffolding is up, else 0. */
  scaffolded: Uint8Array;
  /** Building type index (see BUILDING_TYPES) right now. */
  buildingType: Uint8Array;
  /** Language index (see LANGUAGES) right now. */
  language: Uint8Array;
}

/** The layout part of the world file: everything the CLI decides about where things stand. */
export type WorldLayout = Pick<World, "citySeed" | "widthStep" | "villages" | "blocks" | "lots" | "roads" | "stints" | "districts">;

/** A snapshot at the chunk's first commit plus the events inside the chunk. */
export interface Chunk {
  formatVersion: number;
  firstCommit: number;
  snapshot: ChunkSnapshot;
  eventCommit: Uint32Array;
  eventFile: Uint32Array;
  /** The Stint the event belongs to: the one it creates, or the file's current one. */
  eventStint: Uint32Array;
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

const VILLAGE_BYTES = 3 * 4;
const BLOCK_BYTES = 4 + 4 + 4 + 4 + 1 + 4;
const LOT_BYTES = 4 + 4 + 1 + 1;
const ROAD_BYTES = 4 + 4 + 1 + 1 + 1;
const STINT_BYTES = 4 + 4 + 1;
const DISTRICT_BYTES = 4 + 1;
const CONTRIBUTOR_BYTES = 4 + 1;
/** The chunk header: magic, version, first commit, and the counts of standing files, Blocks, Roads and events. */
const CHUNK_HEADER_BYTES = 4 * 7;

export function encodeWorld(world: Omit<World, "formatVersion" | "chunks"> & { chunks: { firstCommit: number; hash: Uint8Array }[] }): Uint8Array {
  const n = world.fileCount;
  if (world.buildingType.length !== n || world.language.length !== n || world.seed.length !== n || world.widthStep.length !== n) {
    throw new Error("per-file columns differ in length from fileCount");
  }
  const { villages, blocks, lots, roads } = world;
  const { contributors, messages } = world;
  const size =
    20 + world.commitDays.length * 8 + n * FILE_ATTRIBUTE_BYTES + world.chunks.length * (4 + CHUNK_HASH_BYTES) +
    4 + n + 4 + villages.x.length * VILLAGE_BYTES + 4 + blocks.x.length * BLOCK_BYTES +
    4 + lots.file.length * LOT_BYTES + 4 + roads.a.length * ROAD_BYTES + 4 + world.stints.file.length * STINT_BYTES +
    4 + world.districts.index.length * DISTRICT_BYTES + 4 + (world.commitSeconds ? world.commitDays.length * 4 : 0) +
    4 + (contributors ? 4 + contributors.name.length * CONTRIBUTOR_BYTES + world.commitDays.length * 4 : 0) +
    4 + (messages ? world.commitDays.length * 4 : 0);
  const w = new Writer(size);
  w.u32(WORLD_MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(world.commitDays.length);
  w.u32(world.fileCount);
  w.u32(world.chunks.length);
  for (const day of world.commitDays) w.i32(day);
  if (world.stepCommits.length !== world.commitDays.length) throw new Error("stepCommits differs in length from commitDays");
  for (const count of world.stepCommits) w.u32(count);
  w.bytes(world.buildingType);
  w.bytes(world.language);
  for (const seed of world.seed) w.u32(seed);
  for (const chunk of world.chunks) {
    if (chunk.hash.length !== CHUNK_HASH_BYTES) throw new Error(`chunk hash must be ${CHUNK_HASH_BYTES} bytes`);
    w.u32(chunk.firstCommit);
    w.bytes(chunk.hash);
  }
  w.u32(world.citySeed);
  w.bytes(world.widthStep);
  w.u32(villages.x.length);
  for (let i = 0; i < villages.x.length; i++) {
    w.f32(villages.x[i]!);
    w.f32(villages.z[i]!);
    w.f32(villages.angle[i]!);
  }
  w.u32(blocks.x.length);
  for (let i = 0; i < blocks.x.length; i++) {
    w.u32(blocks.village[i]!);
    w.f32(blocks.x[i]!);
    w.f32(blocks.z[i]!);
    w.u32(blocks.claimed[i]!);
    w.bytes(blocks.brick.subarray(i, i + 1));
    w.u32(blocks.district[i]!);
  }
  w.u32(lots.file.length);
  for (let i = 0; i < lots.file.length; i++) {
    w.u32(lots.file[i]!);
    w.u32(lots.block[i]!);
    w.bytes(lots.slot.subarray(i, i + 1));
    w.bytes(lots.slots.subarray(i, i + 1));
  }
  w.u32(roads.a.length);
  for (let i = 0; i < roads.a.length; i++) {
    w.u32(roads.a[i]!);
    w.u32(roads.b[i]!);
    w.bytes(roads.forward.subarray(i, i + 1));
    w.bytes(roads.backward.subarray(i, i + 1));
    w.bytes(roads.track.subarray(i, i + 1));
  }
  const { stints } = world;
  w.u32(stints.file.length);
  for (let i = 0; i < stints.file.length; i++) {
    w.u32(stints.file[i]!);
    w.u32(stints.lot[i]!);
    w.bytes(stints.buildingType.subarray(i, i + 1));
  }
  const { districts } = world;
  w.u32(districts.index.length);
  for (let i = 0; i < districts.index.length; i++) {
    w.u32(districts.index[i]!);
    w.bytes(districts.street.subarray(i, i + 1));
  }
  // Last, so the sections above keep their place: a flag, then the Steps' times when exact times are on.
  if (world.commitSeconds && world.commitSeconds.length !== world.commitDays.length) {
    throw new Error("commitSeconds differs in length from commitDays");
  }
  w.u32(world.commitSeconds ? 1 : 0);
  if (world.commitSeconds) for (const seconds of world.commitSeconds) w.u32(seconds);
  // Then the opt-in sections, each behind a flag: the Contributors, and the Steps' commit messages.
  w.u32(contributors ? 1 : 0);
  if (contributors) {
    if (contributors.ofStep.length !== world.commitDays.length) throw new Error("contributors.ofStep differs in length from commitDays");
    w.u32(contributors.name.length);
    for (let i = 0; i < contributors.name.length; i++) {
      w.u32(contributors.name[i]!);
      w.bytes(contributors.automation.subarray(i, i + 1));
    }
    for (const contributor of contributors.ofStep) w.u32(contributor);
  }
  w.u32(messages ? 1 : 0);
  if (messages) {
    if (messages.length !== world.commitDays.length) throw new Error("messages differs in length from commitDays");
    for (const message of messages) w.u32(message);
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
  const stepCommits = new Uint32Array(commitCount);
  for (let i = 0; i < commitCount; i++) stepCommits[i] = r.u32();
  const buildingType = r.bytes(fileCount);
  const language = r.bytes(fileCount);
  const seed = r.u32s(fileCount);
  const chunks: ChunkRef[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const firstCommit = r.u32();
    chunks.push({ firstCommit, name: chunkName(i, r.bytes(CHUNK_HASH_BYTES)) });
  }
  const citySeed = r.u32();
  const widthStep = r.bytes(fileCount);

  const villageCount = r.u32();
  const villages = { x: new Float32Array(villageCount), z: new Float32Array(villageCount), angle: new Float32Array(villageCount) };
  for (let i = 0; i < villageCount; i++) {
    villages.x[i] = r.f32();
    villages.z[i] = r.f32();
    villages.angle[i] = r.f32();
  }
  const blockCount = r.u32();
  const blocks = {
    village: new Uint32Array(blockCount),
    x: new Float32Array(blockCount),
    z: new Float32Array(blockCount),
    claimed: new Uint32Array(blockCount),
    brick: new Uint8Array(blockCount),
    district: new Uint32Array(blockCount),
  };
  for (let i = 0; i < blockCount; i++) {
    blocks.village[i] = r.u32();
    blocks.x[i] = r.f32();
    blocks.z[i] = r.f32();
    blocks.claimed[i] = r.u32();
    blocks.brick[i] = r.bytes(1)[0]!;
    blocks.district[i] = r.u32();
  }
  const lotCount = r.u32();
  const lots = { file: new Uint32Array(lotCount), block: new Uint32Array(lotCount), slot: new Uint8Array(lotCount), slots: new Uint8Array(lotCount) };
  for (let i = 0; i < lotCount; i++) {
    lots.file[i] = r.u32();
    lots.block[i] = r.u32();
    lots.slot[i] = r.bytes(1)[0]!;
    lots.slots[i] = r.bytes(1)[0]!;
  }
  const roadCount = r.u32();
  const roads = {
    a: new Uint32Array(roadCount),
    b: new Uint32Array(roadCount),
    forward: new Uint8Array(roadCount),
    backward: new Uint8Array(roadCount),
    track: new Uint8Array(roadCount),
  };
  for (let i = 0; i < roadCount; i++) {
    roads.a[i] = r.u32();
    roads.b[i] = r.u32();
    roads.forward[i] = r.bytes(1)[0]!;
    roads.backward[i] = r.bytes(1)[0]!;
    roads.track[i] = r.bytes(1)[0]!;
  }
  const stintCount = r.u32();
  const stints = { file: new Uint32Array(stintCount), lot: new Uint32Array(stintCount), buildingType: new Uint8Array(stintCount) };
  for (let i = 0; i < stintCount; i++) {
    stints.file[i] = r.u32();
    stints.lot[i] = r.u32();
    stints.buildingType[i] = r.bytes(1)[0]!;
  }
  const districtCount = r.u32();
  const districts = { index: new Uint32Array(districtCount), street: new Uint8Array(districtCount) };
  for (let i = 0; i < districtCount; i++) {
    districts.index[i] = r.u32();
    districts.street[i] = r.bytes(1)[0]!;
  }
  const exact = r.u32() === 1;
  const commitSeconds = exact ? new Uint32Array(commitCount) : undefined;
  if (commitSeconds) for (let i = 0; i < commitCount; i++) commitSeconds[i] = r.u32();
  let contributors: World["contributors"];
  if (r.u32() === 1) {
    const count = r.u32();
    const name = new Uint32Array(count);
    const automation = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      name[i] = r.u32();
      automation[i] = r.bytes(1)[0]!;
    }
    contributors = { name, automation, ofStep: r.u32s(commitCount) };
  }
  const messages = r.u32() === 1 ? r.u32s(commitCount) : undefined;

  return {
    formatVersion: r.formatVersion,
    commitDays,
    ...(commitSeconds ? { commitSeconds } : {}),
    stepCommits,
    fileCount,
    buildingType,
    language,
    seed: Uint32Array.from(seed),
    chunks,
    citySeed,
    widthStep,
    villages,
    blocks,
    lots,
    roads,
    stints,
    districts,
    ...(contributors ? { contributors } : {}),
    ...(messages ? { messages } : {}),
  };
}

export function encodeChunk(chunk: Omit<Chunk, "formatVersion">): Uint8Array {
  const n = chunk.eventCommit.length;
  if (chunk.eventFile.length !== n || chunk.eventKind.length !== n || chunk.eventValue.length !== n) {
    throw new Error("event columns differ in length");
  }
  if (!chunk.eventStint || chunk.eventStint.length !== n) throw new Error("event stint column differs in length");
  const s = chunk.snapshot;
  const m = s.file.length;
  if (s.floors.length !== m || s.scaffolded.length !== m || s.buildingType.length !== m || s.language.length !== m || s.stint.length !== m) {
    throw new Error("snapshot columns differ in length");
  }
  const b = s.blockIds.length;
  if (s.blockDistricts.length !== b) throw new Error("snapshot block columns differ in length");
  const k = s.roadIds.length;
  if (s.roadBuilt.length !== k || s.roadForward.length !== k || s.roadBackward.length !== k) {
    throw new Error("snapshot road columns differ in length");
  }
  const w = new Writer(CHUNK_HEADER_BYTES + m * (4 + 4 + 4) + b * (4 + 4) + k * (4 + 4 + 1 + 1) + n * (4 + 4 + 4 + 1 + 1));
  w.u32(CHUNK_MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(chunk.firstCommit);
  w.u32(m);
  w.u32(b);
  w.u32(k);
  w.u32(n);
  for (const id of s.file) w.u32(id);
  for (const id of s.stint) w.u32(id);
  w.bytes(s.floors);
  w.bytes(s.scaffolded);
  w.bytes(s.buildingType);
  w.bytes(s.language);
  for (const id of s.blockIds) w.u32(id);
  for (const district of s.blockDistricts) w.u32(district);
  for (const id of s.roadIds) w.u32(id);
  for (const commit of s.roadBuilt) w.u32(commit);
  w.bytes(s.roadForward);
  w.bytes(s.roadBackward);
  for (const c of chunk.eventCommit) w.u32(c);
  for (const f of chunk.eventFile) w.u32(f);
  for (const st of chunk.eventStint) w.u32(st);
  w.bytes(chunk.eventKind);
  w.bytes(chunk.eventValue);
  return w.done();
}

export function decodeChunk(bytes: Uint8Array): Chunk {
  const r = new Reader(bytes, CHUNK_MAGIC);
  const firstCommit = r.u32();
  const snapshotCount = r.u32();
  const blockCount = r.u32();
  const roadCount = r.u32();
  const n = r.u32();
  const snapshot: ChunkSnapshot = {
    file: r.u32s(snapshotCount),
    stint: r.u32s(snapshotCount),
    floors: r.bytes(snapshotCount),
    scaffolded: r.bytes(snapshotCount),
    buildingType: r.bytes(snapshotCount),
    language: r.bytes(snapshotCount),
    blockIds: r.u32s(blockCount),
    blockDistricts: r.u32s(blockCount),
    roadIds: r.u32s(roadCount),
    roadBuilt: r.u32s(roadCount),
    roadForward: r.bytes(roadCount),
    roadBackward: r.bytes(roadCount),
  };
  const eventCommit = r.u32s(n);
  const eventFile = r.u32s(n);
  const eventStint = r.u32s(n);
  const eventKind = r.bytes(n);
  const eventValue = r.bytes(n);
  return { formatVersion: r.formatVersion, firstCommit, snapshot, eventCommit, eventFile, eventStint, eventKind, eventValue };
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
  f32(v: number) {
    this.view.setFloat32(this.at, v, true);
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
  f32(): number {
    const v = this.view.getFloat32(this.at, true);
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
