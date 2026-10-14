import { type Chunk, decodeChunk, type World } from "../shared/format.js";
import { applyEvent, applySnapshot, birthStates, type FileStates } from "../shared/replay.js";

/**
 * Loads the chunks of one site: streams them in order, and seeks by loading the one chunk that holds a commit.
 * No rendering here, so the loader runs headlessly; the City asks it which commits it can play through.
 */
export class ChunkStream {
  private readonly loading = new Map<number, Promise<Chunk>>();
  private readonly ready = new Set<number>();

  constructor(
    private readonly world: World,
    private readonly fetchChunk: (name: string) => Promise<Uint8Array>,
  ) {}

  /** The chunk that holds `commit`: the last one whose first commit is at or before it. */
  indexAt(commit: number): number {
    const chunks = this.world.chunks;
    let lo = 0;
    let hi = chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (chunks[mid]!.firstCommit <= commit) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Loads one chunk. Each chunk is fetched once; a failed load is forgotten so it can be tried again. */
  load(index: number): Promise<Chunk> {
    const known = this.loading.get(index);
    if (known !== undefined) return known;
    const entry = this.world.chunks[index];
    if (!entry) return Promise.reject(new RangeError(`no chunk ${index}`));
    // Every step runs after this call returns, so the entry is stored before a failure can clear it.
    const pending = Promise.resolve()
      .then(() => this.fetchChunk(entry.name))
      .then((bytes) => {
        const chunk = decodeChunk(bytes);
        this.ready.add(index);
        return chunk;
      })
      .catch((error: unknown) => {
        this.loading.delete(index);
        throw error;
      });
    this.loading.set(index, pending);
    return pending;
  }

  /** Loads every chunk in order, calling `onLoaded` as each one arrives. */
  async stream(onLoaded?: (index: number, chunk: Chunk) => void): Promise<void> {
    for (let index = 0; index < this.world.chunks.length; index++) {
      const chunk = await this.load(index);
      onLoaded?.(index, chunk);
    }
  }

  /** Loads the chunk holding `commit`, and nothing else. */
  async seek(commit: number): Promise<{ index: number; chunk: Chunk }> {
    const index = this.indexAt(commit);
    return { index, chunk: await this.load(index) };
  }

  /** The last commit the City can play through: every chunk up to it has loaded. -1 when none has. */
  loadedThrough(): number {
    const commits = this.world.commitDays.length;
    let through = -1;
    for (let index = 0; index < this.world.chunks.length && this.ready.has(index); index++) {
      const next = this.world.chunks[index + 1];
      through = next ? next.firstCommit - 1 : commits - 1;
    }
    return through;
  }
}

/**
 * The state of every file at `commit`: the chunk's snapshot, then each event up to and including that commit.
 * `birth` gives each file's Building type and language when it was born, which no event carries.
 */
export function replayTo(chunk: Chunk, commit: number, birth: { buildingType: Uint8Array; language: Uint8Array }): FileStates {
  const state = birthStates(birth.buildingType, birth.language);
  applySnapshot(state, chunk.snapshot);
  for (let i = 0; i < chunk.eventCommit.length && chunk.eventCommit[i]! <= commit; i++) {
    applyEvent(state, chunk.eventKind[i]!, chunk.eventFile[i]!, chunk.eventValue[i]!);
  }
  return state;
}
