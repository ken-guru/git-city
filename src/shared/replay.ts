import {
  type ChunkSnapshot,
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_LANGUAGE,
  EVENT_RELOCATE,
  EVENT_RENOVATE,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
} from "./format.js";

/**
 * The state of every file at one point on the Timeline: columns indexed by file id.
 * Shared by the CLI, which cuts chunks from it, and the page, which replays a chunk to a commit,
 * so both agree on what each event does.
 */
export interface FileStates {
  /** 1 while the file stands. */
  standing: Uint8Array;
  floors: Uint8Array;
  /** 1 while the scaffolding is up. */
  scaffolded: Uint8Array;
  buildingType: Uint8Array;
  language: Uint8Array;
}

/** The state before any event: nothing stands. Birth types and languages come from the world file. */
export function birthStates(buildingType: Uint8Array, language: Uint8Array): FileStates {
  return {
    standing: new Uint8Array(buildingType.length),
    floors: new Uint8Array(buildingType.length),
    scaffolded: new Uint8Array(buildingType.length),
    buildingType: Uint8Array.from(buildingType),
    language: Uint8Array.from(language),
  };
}

export function applySnapshot(state: FileStates, snapshot: ChunkSnapshot): void {
  snapshot.file.forEach((file, i) => {
    state.standing[file] = 1;
    state.floors[file] = snapshot.floors[i]!;
    state.scaffolded[file] = snapshot.scaffolded[i]!;
    state.buildingType[file] = snapshot.buildingType[i]!;
    state.language[file] = snapshot.language[i]!;
  });
}

/** Applies one event (see the event kinds in format.ts). A file's birth type and language are not changed by ADD. */
export function applyEvent(state: FileStates, kind: number, file: number, value: number): void {
  switch (kind) {
    case EVENT_ADD:
      state.standing[file] = 1;
      state.floors[file] = value;
      break;
    case EVENT_DELETE:
      state.standing[file] = 0;
      state.scaffolded[file] = 0;
      break;
    case EVENT_FLOORS:
      state.floors[file] = value;
      break;
    case EVENT_SCAFFOLD_ON:
      state.scaffolded[file] = 1;
      break;
    case EVENT_SCAFFOLD_OFF:
      state.scaffolded[file] = 0;
      break;
    case EVENT_RELOCATE:
    case EVENT_RENOVATE:
      state.buildingType[file] = value;
      break;
    case EVENT_LANGUAGE:
      state.language[file] = value;
      break;
  }
}
