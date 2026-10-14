import { describe, expect, it } from "vitest";
import { planChunks, type ChunkInput } from "../src/cli/chunks.js";
import {
  type Chunk,
  decodeChunk,
  decodeWorld,
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_RENOVATE,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
  encodeWorld,
  FORMAT_VERSION,
  FormatVersionError,
  type EventKind,
  type World,
} from "../src/shared/format.js";
import { ChunkStream, replayTo } from "../src/page/chunks.js";
import { appendTimelines, buildingPose, buildTimelines, displayedFloors, scaffoldPose, TRANSITION_COMMITS } from "../src/page/state.js";

/**
 * A Timeline with `commits` commits and a varied mix of events across `files` files. Each file's events come
 * after its birth and inside the Timeline, as real Timelines do.
 */
function timelineOf(commits: number, files: number): ChunkInput {
  const events: [number, number, EventKind, number][] = [];
  const at = (commit: number, file: number, kind: EventKind, value: number) => {
    if (commit < commits) events.push([commit, file, kind, value]);
  };
  for (let file = 0; file < files; file++) {
    const born = (file * 11) % Math.max(1, commits - 60);
    at(born, file, EVENT_ADD, (file % 4) + 1);
    at(born + 13, file, EVENT_SCAFFOLD_ON, 0);
    at(born + 40, file, EVENT_FLOORS, (file % 6) + 2);
    at(born + 41, file, EVENT_SCAFFOLD_OFF, 0);
    if (file % 3 === 0) at(born + 90, file, EVENT_RENOVATE, 2);
    if (file % 5 === 0) at(born + 110, file, EVENT_DELETE, 0);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    commitDays: Int32Array.from({ length: commits }, (_, i) => 19000 + i),
    fileCount: files,
    buildingType: new Uint8Array(files),
    language: new Uint8Array(files),
    eventCommit: Uint32Array.from(events, (e) => e[0]),
    eventFile: Uint32Array.from(events, (e) => e[1]),
    eventKind: Uint8Array.from(events, (e) => e[2]),
    eventValue: Uint8Array.from(events, (e) => e[3]),
  };
}

/** Writes the planned chunks the way the CLI does and returns the world, the bytes by name, and the decoded chunks. */
function publish(timeline: ChunkInput, chunkCommits: number) {
  const plans = planChunks(timeline, { chunkCommits, checkEvery: 7 });
  const world = decodeWorld(
    encodeWorld({
      commitDays: timeline.commitDays,
      fileCount: timeline.fileCount,
      buildingType: timeline.buildingType,
      language: timeline.language,
      seed: new Uint32Array(timeline.fileCount),
      chunks: plans.map((p) => ({ firstCommit: p.firstCommit, hash: p.hash })),
    }),
  );
  const bytes = new Map(world.chunks.map((c, i) => [c.name, plans[i]!.bytes]));
  return { world, bytes, plans };
}

/** A stream over published chunks, plus the log of every chunk fetched. */
function streamOf(world: World, bytes: Map<string, Uint8Array>) {
  const fetched: string[] = [];
  const stream = new ChunkStream(world, async (name) => {
    fetched.push(name);
    const found = bytes.get(name);
    if (!found) throw new Error(`no such chunk ${name}`);
    return found;
  });
  return { stream, fetched };
}

describe("chunk streaming", () => {
  it("streams chunks in order, and the City can play through every commit it has loaded", async () => {
    const { world, bytes } = publish(timelineOf(25, 4), 10);
    const { stream, fetched } = streamOf(world, bytes);

    expect(stream.loadedThrough()).toBe(-1);
    await stream.loadAll();

    expect(fetched).toEqual(world.chunks.map((c) => c.name));
    expect(stream.loadedThrough()).toBe(24);
  });

  it("holds the City at the first commit that is not loaded yet", async () => {
    const { world, bytes } = publish(timelineOf(25, 4), 10);
    const { stream } = streamOf(world, bytes);

    await stream.load(0);
    await stream.load(2);

    // Chunk 1 (commits 10 to 19) is missing, so the City can play through commit 9 only.
    expect(stream.loadedThrough()).toBe(9);
  });

  it("seeks by loading only the chunk that holds the target commit", async () => {
    const { world, bytes } = publish(timelineOf(25, 4), 10);
    const { stream, fetched } = streamOf(world, bytes);

    const { index, chunk } = await stream.seek(17);

    expect(index).toBe(1);
    expect(chunk.firstCommit).toBe(10);
    expect(fetched).toEqual([world.chunks[1]!.name]);
  });

  it("loads each chunk once, however many times it is asked for", async () => {
    const { world, bytes } = publish(timelineOf(25, 4), 10);
    const { stream, fetched } = streamOf(world, bytes);

    await Promise.all([stream.load(1), stream.load(1), stream.seek(12)]);

    expect(fetched).toEqual([world.chunks[1]!.name]);
  });

  it("refuses a chunk from another format version, and does not keep the failure", async () => {
    const { world, bytes } = publish(timelineOf(5, 2), 10);
    const name = world.chunks[0]!.name;
    const stale = Uint8Array.from(bytes.get(name)!);
    new DataView(stale.buffer).setUint32(4, FORMAT_VERSION - 1, true);
    const served = new Map<string, Uint8Array>([[name, stale]]);
    const { stream } = streamOf(world, served);

    await expect(stream.load(0)).rejects.toBeInstanceOf(FormatVersionError);

    served.set(name, bytes.get(name)!);
    await expect(stream.load(0)).resolves.toMatchObject({ firstCommit: 0 });
  });
});

describe("playing across streamed chunks", () => {
  it("plays the same as one whole chunk, once each boundary's transitions have settled", async () => {
    const files = 9;
    const commits = 120;
    const timeline = timelineOf(commits, files);
    const { world, bytes } = publish(timeline, 25);
    const { stream } = streamOf(world, bytes);
    const whole = buildTimelines(decodeChunk(planChunks(timeline, { chunkCommits: commits })[0]!.bytes), files);
    let streamed: ReturnType<typeof buildTimelines> | undefined;
    await stream.loadAll((index, chunk) => {
      if (streamed === undefined) streamed = buildTimelines(chunk, files);
      else appendTimelines(streamed, chunk);
    });
    const played = streamed!;

    for (let t = 0; t < commits + TRANSITION_COMMITS; t++) {
      // A transition that began in the previous chunk may still be in flight at a boundary; from D on it has settled.
      const chunk = world.chunks[stream.indexAt(Math.min(t, commits - 1))]!;
      if (t < chunk.firstCommit + TRANSITION_COMMITS) continue;
      for (let f = 0; f < files; f++) {
        const a = buildingPose(whole.buildings[f]!, t, TRANSITION_COMMITS);
        const b = buildingPose(played.buildings[f]!, t, TRANSITION_COMMITS);
        expect(b.visible).toBe(a.visible);
        if (a.visible) expect(displayedFloors(b, t, TRANSITION_COMMITS)).toBeCloseTo(displayedFloors(a, t, TRANSITION_COMMITS));
        expect(scaffoldPose(played.scaffolds[f]!, b, t, TRANSITION_COMMITS).visible).toBe(
          scaffoldPose(whole.scaffolds[f]!, a, t, TRANSITION_COMMITS).visible,
        );
      }
    }
  });
});

describe("replaying a chunk", () => {
  it("reaches the same state at every commit from one chunk as a full replay from the start", () => {
    const timeline = timelineOf(120, 9);
    const { world, bytes } = publish(timeline, 25);
    const chunks = world.chunks.map((c) => decodeChunk(bytes.get(c.name)!));
    const full = decodeChunk(planChunks(timeline, { chunkCommits: 120 })[0]!.bytes);

    for (let commit = 0; commit < 120; commit++) {
      const from = chunks[Math.floor(commit / 25)]!;
      expect(replayTo(from, commit, world)).toEqual(replayTo(full, commit, world));
    }
  });

  it("reports a file as standing with its Floors and scaffolding at the commit asked for", () => {
    const timeline: ChunkInput = {
      commitDays: Int32Array.from({ length: 6 }, (_, i) => i),
      fileCount: 2,
      buildingType: Uint8Array.of(0, 0),
      language: Uint8Array.of(0, 0),
      eventCommit: Uint32Array.of(0, 1, 2, 4),
      eventFile: Uint32Array.of(0, 1, 0, 0),
      eventKind: Uint8Array.of(EVENT_ADD, EVENT_ADD, EVENT_FLOORS, EVENT_SCAFFOLD_ON),
      eventValue: Uint8Array.of(2, 5, 7, 0),
    };
    const chunk: Chunk = decodeChunk(planChunks(timeline, { chunkCommits: 10 })[0]!.bytes);
    const birth = { buildingType: Uint8Array.of(0, 0), language: Uint8Array.of(0, 0) };

    expect(replayTo(chunk, 1, birth)).toEqual({
      standing: Uint8Array.of(1, 1),
      floors: Uint8Array.of(2, 5),
      scaffolded: Uint8Array.of(0, 0),
      buildingType: Uint8Array.of(0, 0),
      language: Uint8Array.of(0, 0),
    });
    expect(replayTo(chunk, 4, birth)).toEqual({
      standing: Uint8Array.of(1, 1),
      floors: Uint8Array.of(7, 5),
      scaffolded: Uint8Array.of(1, 0),
      buildingType: Uint8Array.of(0, 0),
      language: Uint8Array.of(0, 0),
    });
  });
});
