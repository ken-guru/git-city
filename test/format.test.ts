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
    floors: new Uint8Array(0),
    scaffolded: new Uint8Array(0),
    buildingType: new Uint8Array(0),
    language: new Uint8Array(0),
  };
}

describe("binary format", () => {
  it("round-trips a world's per-file Building attributes", () => {
    const bytes = encodeWorld({
      commitDays: Int32Array.of(19000, 19001),
      fileCount: 3,
      buildingType: Uint8Array.of(0, 4, 8),
      language: Uint8Array.of(1, 0, 10),
      seed: Uint32Array.of(1, 4_000_000_000, 7),
      chunks: [{ firstCommit: 0, hash: new Uint8Array(CHUNK_HASH_BYTES) }],
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
        floors: Uint8Array.of(4, 31),
        scaffolded: Uint8Array.of(0, 1),
        buildingType: Uint8Array.of(2, 5),
        language: Uint8Array.of(0, 7),
      },
      eventCommit: Uint32Array.of(),
      eventFile: Uint32Array.of(),
      eventKind: Uint8Array.of(),
      eventValue: Uint8Array.of(),
    });

    const chunk = decodeChunk(bytes);

    expect(chunk.firstCommit).toBe(2000);
    expect([...chunk.snapshot.file]).toEqual([3, 9]);
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
      eventKind: Uint8Array.of(EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_SCAFFOLD_ON, EVENT_SCAFFOLD_OFF),
      eventValue: Uint8Array.of(5, 0, 9, 0, 0),
    });

    const chunk = decodeChunk(bytes);

    expect([...chunk.eventKind]).toEqual([EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_SCAFFOLD_ON, EVENT_SCAFFOLD_OFF]);
    expect([...chunk.eventValue]).toEqual([5, 0, 9, 0, 0]);
    expect([...chunk.eventFile]).toEqual([1, 0, 0, 0, 0]);
  });
});
