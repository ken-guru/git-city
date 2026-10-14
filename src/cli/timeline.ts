import { BUILDING_TYPES } from "../shared/buildings.js";
import { EVENT_ADD, EVENT_DELETE, EVENT_FLOORS, EVENT_SCAFFOLD_OFF, EVENT_SCAFFOLD_ON, type EventKind } from "../shared/format.js";
import type { CommitRecord } from "./history.js";
import { buildingTypeOf, categoryOf, floorsFor, languageOf, seedFor, TUNING } from "./model.js";

/**
 * Turns commits into numbered files and events.
 * Every add gives a new file id; a path that comes back later is a new file.
 * Events: add and delete, Floors changes, and scaffolding on and off (see the event kinds in the format).
 */
export class TimelineBuilder {
  private readonly days: number[] = [];
  private readonly standing = new Map<string, number>();
  /** Per file id: whether it still stands. */
  private readonly alive: boolean[] = [];
  /** Per file id: its Floors right now. */
  private readonly floors: number[] = [];
  /** Per file id: the days of its recent changes, oldest first; pruned to the scaffolding window. */
  private readonly changeDays: number[][] = [];
  /** File ids whose scaffolding is up. */
  private readonly scaffolded = new Set<number>();
  private readonly buildingType: number[] = [];
  private readonly language: number[] = [];
  private readonly seed: number[] = [];
  private nextFile = 0;
  /** The path each file id was born with, indexed by file id. */
  private readonly filePaths: string[] = [];
  private readonly eventCommit: number[] = [];
  private readonly eventFile: number[] = [];
  private readonly eventKind: EventKind[] = [];
  private readonly eventValue: number[] = [];

  add(commit: CommitRecord): void {
    const seq = this.days.length;
    const day = commit.day;
    this.days.push(day);

    for (const path of commit.deleted) {
      const file = this.standing.get(path);
      if (file === undefined) continue;
      this.retire(seq, path, file);
    }

    const touched = new Set<number>();
    for (const path of commit.added) {
      const previous = this.standing.get(path);
      if (previous !== undefined) this.retire(seq, path, previous);

      const file = this.nextFile++;
      this.filePaths.push(path);
      const floors = floorsFor(commit.lines?.get(path) ?? 0);
      this.standing.set(path, file);
      this.alive.push(true);
      this.floors.push(floors);
      this.changeDays.push([]);
      this.buildingType.push(BUILDING_TYPES.indexOf(buildingTypeOf(categoryOf(path))));
      this.language.push(languageOf(path));
      this.seed.push(seedFor(file));
      this.event(seq, file, EVENT_ADD, floors);
      touched.add(file);
    }

    for (const path of commit.modified) {
      const file = this.standing.get(path);
      if (file === undefined) continue;
      touched.add(file);
      const lines = commit.lines?.get(path);
      if (lines === undefined) continue;
      const floors = floorsFor(lines);
      if (floors !== this.floors[file]) {
        this.floors[file] = floors;
        this.event(seq, file, EVENT_FLOORS, floors);
      }
    }

    for (const file of touched) this.changeDays[file]!.push(day);
    for (const file of [...touched, ...this.scaffolded]) this.updateScaffolding(seq, file, day);
  }

  /** Everything the builder holds, as JSON-safe values, so a run can resume from it exactly. */
  snapshot(): TimelineSnapshot {
    return {
      days: this.days,
      standing: [...this.standing],
      alive: this.alive,
      floors: this.floors,
      changeDays: this.changeDays,
      scaffolded: [...this.scaffolded],
      buildingType: this.buildingType,
      language: this.language,
      seed: this.seed,
      nextFile: this.nextFile,
      filePaths: this.filePaths,
      eventCommit: this.eventCommit,
      eventFile: this.eventFile,
      eventKind: this.eventKind,
      eventValue: this.eventValue,
    };
  }

  static restore(s: TimelineSnapshot): TimelineBuilder {
    const b = new TimelineBuilder();
    appendAll(b.days, s.days);
    for (const [path, file] of s.standing) b.standing.set(path, file);
    appendAll(b.alive, s.alive);
    appendAll(b.floors, s.floors);
    appendAll(b.changeDays, s.changeDays.map((days) => [...days]));
    for (const file of s.scaffolded) b.scaffolded.add(file);
    appendAll(b.buildingType, s.buildingType);
    appendAll(b.language, s.language);
    appendAll(b.seed, s.seed);
    b.nextFile = s.nextFile;
    appendAll(b.filePaths, s.filePaths);
    appendAll(b.eventCommit, s.eventCommit);
    appendAll(b.eventFile, s.eventFile);
    appendAll(b.eventKind, (s.eventKind as EventKind[]));
    appendAll(b.eventValue, s.eventValue);
    return b;
  }

  result() {
    return {
      commitDays: Int32Array.from(this.days),
      fileCount: this.nextFile,
      /** Names are made from these and never leave the CLI: only the naming step writes text. */
      filePaths: [...this.filePaths],
      buildingType: Uint8Array.from(this.buildingType),
      language: Uint8Array.from(this.language),
      seed: Uint32Array.from(this.seed),
      eventCommit: Uint32Array.from(this.eventCommit),
      eventFile: Uint32Array.from(this.eventFile),
      eventKind: Uint8Array.from(this.eventKind),
      eventValue: Uint8Array.from(this.eventValue),
    };
  }

  private retire(seq: number, path: string, file: number) {
    this.standing.delete(path);
    this.alive[file] = false;
    this.scaffolded.delete(file);
    this.event(seq, file, EVENT_DELETE, 0);
  }

  /** Scaffolding goes up at `scaffoldChanges` changes within the window, and comes down when they age out. */
  private updateScaffolding(seq: number, file: number, day: number) {
    if (!this.alive[file]) return;
    const days = this.changeDays[file]!;
    const cutoff = day - TUNING.scaffoldWindowDays;
    while (days.length > 0 && days[0]! <= cutoff) days.shift();
    const busy = days.length >= TUNING.scaffoldChanges;
    const up = this.scaffolded.has(file);
    if (busy && !up) {
      this.scaffolded.add(file);
      this.event(seq, file, EVENT_SCAFFOLD_ON, 0);
    } else if (!busy && up) {
      this.scaffolded.delete(file);
      this.event(seq, file, EVENT_SCAFFOLD_OFF, 0);
    }
  }

  private event(commit: number, file: number, kind: EventKind, value: number) {
    this.eventCommit.push(commit);
    this.eventFile.push(file);
    this.eventKind.push(kind);
    this.eventValue.push(value);
  }
}

export type TimelineData = ReturnType<TimelineBuilder["result"]>;

/** A JSON-safe copy of a TimelineBuilder, written as a cache checkpoint. */
export interface TimelineSnapshot {
  days: number[];
  standing: [string, number][];
  alive: boolean[];
  floors: number[];
  changeDays: number[][];
  scaffolded: number[];
  buildingType: number[];
  language: number[];
  seed: number[];
  nextFile: number;
  filePaths: string[];
  eventCommit: number[];
  eventFile: number[];
  eventKind: number[];
  eventValue: number[];
}

/** Appends by loop: spreading a long array into push() overflows the call stack on long histories. */
function appendAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}
