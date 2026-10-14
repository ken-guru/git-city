import { describe, expect, it } from "vitest";
import { type ChunkInput, planChunks } from "../src/cli/chunks.js";
import {
  decodeChunk,
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_SCAFFOLD_ON,
  type EventKind,
} from "../src/shared/format.js";

/** A synthetic Timeline: `commits` commits, `fileCount` files, and the given events in commit order. */
function input(commits: number, events: [commit: number, file: number, kind: EventKind, value: number][], fileCount = 1): ChunkInput {
  return {
    commitDays: Int32Array.from({ length: commits }, (_, i) => 19000 + i),
    fileCount,
    buildingType: new Uint8Array(fileCount),
    language: new Uint8Array(fileCount),
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    eventKind: Uint8Array.from(events, (e) => e[2]),
    eventValue: Uint8Array.from(events, (e) => e[3]),
  };
}

describe("chunk planning", () => {
  it("gives each chunk a snapshot at its first commit and the events inside it", () => {
    const timeline = input(5, [
      [0, 0, EVENT_ADD, 1],
      [1, 0, EVENT_SCAFFOLD_ON, 0],
      [3, 0, EVENT_FLOORS, 4],
      [4, 0, EVENT_DELETE, 0],
    ]);

    const chunks = planChunks(timeline, { chunkCommits: 2 }).map((c) => decodeChunk(c.bytes));

    expect(chunks.map((c) => c.firstCommit)).toEqual([0, 2, 4]);
    // Chunk 0 starts empty: nothing stands before commit 0.
    expect([...chunks[0]!.snapshot.file]).toEqual([]);
    expect([...chunks[0]!.eventKind]).toEqual([EVENT_ADD, EVENT_SCAFFOLD_ON]);
    // Chunk 1 starts with the file standing at one Floor, its scaffolding up, and replays the Floors change.
    expect([...chunks[1]!.snapshot.file]).toEqual([0]);
    expect([...chunks[1]!.snapshot.floors]).toEqual([1]);
    expect([...chunks[1]!.snapshot.scaffolded]).toEqual([1]);
    expect([...chunks[1]!.eventKind]).toEqual([EVENT_FLOORS]);
    expect([...chunks[1]!.eventValue]).toEqual([4]);
    // Chunk 2 starts at four Floors, then the file is deleted inside it.
    expect([...chunks[2]!.snapshot.floors]).toEqual([4]);
    expect([...chunks[2]!.eventKind]).toEqual([EVENT_DELETE]);
  });

  it("starts a new chunk every 2,000 commits by default", () => {
    const chunks = planChunks(input(4500, []));

    expect(chunks.map((c) => c.firstCommit)).toEqual([0, 2000, 4000]);
    expect(chunks.map((c) => decodeChunk(c.bytes).eventCommit.length)).toEqual([0, 0, 0]);
  });

  it("starts a new chunk when the compressed size reaches the byte limit", () => {
    // A byte limit of 1 is crossed by any chunk, so every commit that can be checked ends a chunk.
    const chunks = planChunks(input(6, [[0, 0, EVENT_ADD, 1]]), { chunkBytes: 1, checkEvery: 1 });

    expect(chunks.map((c) => c.firstCommit)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps earlier chunks byte-identical when the Timeline grows, so a re-run rewrites only the last chunk", () => {
    const events: [number, number, EventKind, number][] = [];
    for (let c = 0; c < 4000; c += 7) events.push([c, c % 3, EVENT_FLOORS, (c % 5) + 1]);
    // The first run ends part-way into its third chunk; the second run adds commits to it and beyond.
    const before = planChunks(input(2500, events.filter((e) => e[0] < 2500), 3), { chunkCommits: 1000 });
    const after = planChunks(input(4000, events, 3), { chunkCommits: 1000 });

    expect(before.map((c) => c.firstCommit)).toEqual([0, 1000, 2000]);
    expect(after.map((c) => c.firstCommit)).toEqual([0, 1000, 2000, 3000]);
    // The two complete chunks match exactly, name and bytes.
    for (let i = 0; i < 2; i++) {
      expect(after[i]!.hash).toEqual(before[i]!.hash);
      expect(after[i]!.bytes).toEqual(before[i]!.bytes);
    }
    expect(after[2]!.hash).not.toEqual(before[2]!.hash);
  });

  it("keeps one empty chunk for an empty Timeline, so the page always has a first chunk", () => {
    const chunks = planChunks(input(0, []));

    expect(chunks.map((c) => c.firstCommit)).toEqual([0]);
  });
});
