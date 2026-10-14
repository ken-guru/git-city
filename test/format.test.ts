import { describe, expect, it } from "vitest";
import {
  CHUNK_HASH_BYTES,
  decodeChunk,
  decodeWorld,
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
  encodeChunk,
  encodeWorld,
} from "../src/shared/format.js";

function emptySnapshot() {
  return {
    file: new Uint32Array(0),
    stint: new Uint32Array(0),
    blockIds: new Uint32Array(0),
    blockDistricts: new Uint32Array(0),
    roadIds: new Uint32Array(0),
    roadBuilt: new Uint32Array(0),
    roadForward: new Uint8Array(0),
    roadBackward: new Uint8Array(0),
    floors: new Uint8Array(0),
    scaffolded: new Uint8Array(0),
    buildingType: new Uint8Array(0),
    language: new Uint8Array(0),
  };
}

const emptyLayout = {
  citySeed: 0,
  widthStep: new Uint8Array(3),
  villages: { x: new Float32Array(0), z: new Float32Array(0), angle: new Float32Array(0) },
  blocks: { village: new Uint32Array(0), x: new Float32Array(0), z: new Float32Array(0), claimed: new Uint32Array(0), brick: new Uint8Array(0), district: new Uint32Array(0) },
  lots: { file: new Uint32Array(0), block: new Uint32Array(0), slot: new Uint8Array(0), slots: new Uint8Array(0) },
  roads: { a: new Uint32Array(0), b: new Uint32Array(0), forward: new Uint8Array(0), backward: new Uint8Array(0), track: new Uint8Array(0) },
  stints: { file: new Uint32Array(0), lot: new Uint32Array(0), buildingType: new Uint8Array(0) },
  districts: { index: new Uint32Array(0), street: new Uint8Array(0) },
};

describe("binary format", () => {
  it("round-trips a world's per-file Building attributes", () => {
    const bytes = encodeWorld({
      commitDays: Int32Array.of(19000, 19001),
      stepCommits: Uint32Array.of(1, 1),
      fileCount: 3,
      buildingType: Uint8Array.of(0, 4, 8),
      language: Uint8Array.of(1, 0, 10),
      seed: Uint32Array.of(1, 4_000_000_000, 7),
      chunks: [{ firstCommit: 0, hash: new Uint8Array(CHUNK_HASH_BYTES) }],
      ...emptyLayout,
    });

    const world = decodeWorld(bytes);

    expect([...world.buildingType]).toEqual([0, 4, 8]);
    expect([...world.language]).toEqual([1, 0, 10]);
    expect([...world.seed]).toEqual([1, 4_000_000_000, 7]);
    expect([...world.commitDays]).toEqual([19000, 19001]);
  });

  it("round-trips a snapshot's per-file state", () => {
    const bytes = encodeChunk({
      firstCommit: 2000,
      snapshot: {
        file: Uint32Array.of(3, 9),
        stint: Uint32Array.of(30, 90),
      blockIds: Uint32Array.of(4, 5),
      blockDistricts: Uint32Array.of(1, 0),
      roadIds: Uint32Array.of(2),
      roadBuilt: Uint32Array.of(1500),
      roadForward: Uint8Array.of(3),
      roadBackward: Uint8Array.of(0),
        floors: Uint8Array.of(4, 31),
        scaffolded: Uint8Array.of(0, 1),
        buildingType: Uint8Array.of(2, 5),
        language: Uint8Array.of(0, 7),
      },
      eventCommit: Uint32Array.of(),
      eventFile: Uint32Array.of(),
      eventStint: Uint32Array.of(),
      eventKind: Uint8Array.of(),
      eventValue: Uint8Array.of(),
    });

    const chunk = decodeChunk(bytes);

    expect(chunk.firstCommit).toBe(2000);
    expect([...chunk.snapshot.file]).toEqual([3, 9]);
    expect([...chunk.snapshot.stint]).toEqual([30, 90]);
    expect([...chunk.snapshot.blockIds]).toEqual([4, 5]);
    expect([...chunk.snapshot.blockDistricts]).toEqual([1, 0]);
    expect([...chunk.snapshot.roadIds]).toEqual([2]);
    expect([...chunk.snapshot.roadBuilt]).toEqual([1500]);
    expect([...chunk.snapshot.roadForward]).toEqual([3]);
    expect([...chunk.snapshot.roadBackward]).toEqual([0]);
    expect([...chunk.snapshot.floors]).toEqual([4, 31]);
    expect([...chunk.snapshot.scaffolded]).toEqual([0, 1]);
    expect([...chunk.snapshot.buildingType]).toEqual([2, 5]);
    expect([...chunk.snapshot.language]).toEqual([0, 7]);
  });

  it("round-trips event values alongside the events", () => {
    const bytes = encodeChunk({
      firstCommit: 0,
      snapshot: emptySnapshot(),
      eventCommit: Uint32Array.of(1, 1, 2, 3, 4),
      eventFile: Uint32Array.of(1, 0, 0, 0, 0),
      eventStint: Uint32Array.of(7, 8, 8, 8, 8),
      eventKind: Uint8Array.of(EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_SCAFFOLD_ON, EVENT_SCAFFOLD_OFF),
      eventValue: Uint8Array.of(5, 0, 9, 0, 0),
    });

    const chunk = decodeChunk(bytes);

    expect([...chunk.eventKind]).toEqual([EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_SCAFFOLD_ON, EVENT_SCAFFOLD_OFF]);
    expect([...chunk.eventValue]).toEqual([5, 0, 9, 0, 0]);
    expect([...chunk.eventFile]).toEqual([1, 0, 0, 0, 0]);
    expect([...chunk.eventStint]).toEqual([7, 8, 8, 8, 8]);
  });
});

describe("layout section of the world file", () => {
  const layout = {
    citySeed: 123_456,
    widthStep: Uint8Array.of(0, 3),
    villages: { x: Float32Array.of(0, 10.5), z: Float32Array.of(-2, 4), angle: Float32Array.of(0.25, 3.5) },
    blocks: {
      village: Uint32Array.of(0, 1, 1),
      x: Float32Array.of(1, 2.5, -3),
      z: Float32Array.of(0, 0.5, 9),
      claimed: Uint32Array.of(0, 4, 7),
      brick: Uint8Array.of(0, 1, 0),
      district: Uint32Array.of(0, 1, 0xffffffff),
    },
    lots: { file: Uint32Array.of(0, 1), block: Uint32Array.of(0, 2), slot: Uint8Array.of(0, 4), slots: Uint8Array.of(2, 4) },
    roads: { a: Uint32Array.of(0), b: Uint32Array.of(1), forward: Uint8Array.of(2), backward: Uint8Array.of(0), track: Uint8Array.of(0) },
    stints: { file: Uint32Array.of(0, 1, 1), lot: Uint32Array.of(0, 1, 2), buildingType: Uint8Array.of(3, 4, 5) },
    districts: { index: Uint32Array.of(7, 2), street: Uint8Array.of(100, 180) },
  };

  it("round-trips the city seed, width steps, villages, Blocks, Lots and Roads", () => {
    const world = decodeWorld(
      encodeWorld({
        commitDays: Int32Array.of(19000),
        stepCommits: Uint32Array.of(1),
        fileCount: 2,
        buildingType: Uint8Array.of(0, 0),
        language: Uint8Array.of(0, 0),
        seed: Uint32Array.of(1, 2),
        chunks: [{ firstCommit: 0, hash: new Uint8Array(CHUNK_HASH_BYTES) }],
        ...layout,
      }),
    );

    expect(world.citySeed).toBe(123_456);
    expect([...world.widthStep]).toEqual([0, 3]);
    expect([...world.villages.x]).toEqual([0, 10.5]);
    expect([...world.villages.angle]).toEqual([0.25, 3.5]);
    expect([...world.blocks.village]).toEqual([0, 1, 1]);
    expect([...world.blocks.z]).toEqual([0, 0.5, 9]);
    expect([...world.blocks.claimed]).toEqual([0, 4, 7]);
    expect([...world.blocks.brick]).toEqual([0, 1, 0]);
    expect([...world.blocks.district]).toEqual([0, 1, 0xffffffff]);
    expect([...world.lots.slot]).toEqual([0, 4]);
    expect([...world.lots.slots]).toEqual([2, 4]);
    expect([...world.roads.forward]).toEqual([2]);
    expect([...world.roads.track]).toEqual([0]);
    expect([...world.stints.file]).toEqual([0, 1, 1]);
    expect([...world.stints.lot]).toEqual([0, 1, 2]);
    expect([...world.stints.buildingType]).toEqual([3, 4, 5]);
    expect([...world.districts.index]).toEqual([7, 2]);
    expect([...world.districts.street]).toEqual([100, 180]);
  });
});
