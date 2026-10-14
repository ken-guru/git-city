import { BUILDING_TYPES } from "../shared/buildings.js";
import {
  EVENT_ADD,
  EVENT_DELETE,
  EVENT_FLOORS,
  EVENT_LANGUAGE,
  EVENT_RELOCATE,
  EVENT_RENOVATE,
  EVENT_SCAFFOLD_OFF,
  EVENT_SCAFFOLD_ON,
  type EventKind,
} from "../shared/format.js";
import type { CommitRecord } from "./history.js";
import { ancestors, type LayoutChange, type PathMove, splitPath, wholeDirectoryMoves } from "./layout.js";
import { buildingTypeOf, categoryOf, floorsForPath, languageOf, seedFor, TUNING } from "./model.js";

/**
 * Turns commits into numbered files and events.
 * Every add gives a new file id; a path that comes back later is a new file. A rename keeps its file id:
 * within its directory it changes only the name, into another directory it is a Relocation, and a whole
 * directory moving together is no event at all (the layout relabels it).
 * Events: add and delete, Floors changes, scaffolding on and off, and the identity events (see the event kinds in the format).
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
  /** Per file id: its Building type and language at birth. Events carry any later change. */
  private readonly buildingType: number[] = [];
  private readonly language: number[] = [];
  /** Per file id: the Building type and language it has now. */
  private readonly currentType: number[] = [];
  private readonly currentLanguage: number[] = [];
  private readonly seed: number[] = [];
  private nextFile = 0;
  /** The path each file id was born with, indexed by file id. */
  private readonly filePaths: string[] = [];
  private readonly eventCommit: number[] = [];
  private readonly eventFile: number[] = [];
  private readonly eventKind: EventKind[] = [];
  private readonly eventValue: number[] = [];

  /** Applies one commit and returns what it changed, for the layout. Every commit gives a change, even an empty one. */
  add(commit: CommitRecord): TimelineChange {
    const seq = this.days.length;
    const day = commit.day;
    this.days.push(day);
    const change: TimelineChange = { added: [], deleted: [], moved: [] };

    // A rename whose old path does not stand is not a rename here: its new path is simply added.
    const renames = (commit.renamed ?? []).filter((r) => this.standing.has(r.from));
    const renamedFrom = new Set(renames.map((r) => r.from));
    const renamedTo = new Set(renames.map((r) => r.to));
    const whole = wholeDirectoryMoves(renames, this.standingCounts(renames));

    for (const path of commit.deleted) {
      if (renamedFrom.has(path)) continue;
      const file = this.standing.get(path);
      if (file === undefined) continue;
      this.retire(seq, path, file, change);
    }

    renames.forEach((move, i) => this.rename(seq, move, whole.covered.has(i), change));

    const touched = new Set<number>();
    for (const path of commit.added) {
      if (renamedTo.has(path)) continue;
      const previous = this.standing.get(path);
      if (previous !== undefined) this.retire(seq, path, previous, change);

      const file = this.nextFile++;
      this.filePaths.push(path);
      const floors = floorsForPath(path, commit.lines?.get(path) ?? 0);
      this.standing.set(path, file);
      this.alive.push(true);
      this.floors.push(floors);
      this.changeDays.push([]);
      const type = BUILDING_TYPES.indexOf(buildingTypeOf(categoryOf(path)));
      const language = languageOf(path);
      this.buildingType.push(type);
      this.language.push(language);
      this.currentType.push(type);
      this.currentLanguage.push(language);
      this.seed.push(seedFor(file));
      this.event(seq, file, EVENT_ADD, floors);
      change.added.push({ file, path });
      touched.add(file);
    }

    for (const path of commit.modified) {
      const file = this.standing.get(path);
      if (file === undefined) continue;
      touched.add(file);
      const lines = commit.lines?.get(path);
      if (lines === undefined) continue;
      const floors = floorsForPath(path, lines);
      if (floors !== this.floors[file]) {
        this.floors[file] = floors;
        this.event(seq, file, EVENT_FLOORS, floors);
      }
    }

    for (const file of touched) this.changeDays[file]!.push(day);
    for (const file of [...touched, ...this.scaffolded]) this.updateScaffolding(seq, file, day);
    return change;
  }

  /** The file id standing at `path` now, or undefined when nothing stands there. */
  fileAt(path: string): number | undefined {
    return this.standing.get(path);
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
      currentType: this.currentType,
      currentLanguage: this.currentLanguage,
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
    appendAll(b.currentType, s.currentType);
    appendAll(b.currentLanguage, s.currentLanguage);
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
      /** One commit per Step until the Timeline is grouped into Steps (see steps.ts). */
      stepCommits: Uint32Array.from(this.days, () => 1),
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

  /** A file keeps its id under its new path. Renames are not changes: they do not count towards scaffolding. */
  private rename(seq: number, move: PathMove, wholeDirectory: boolean, change: TimelineChange) {
    const file = this.standing.get(move.from)!;
    this.standing.delete(move.from);
    const previous = this.standing.get(move.to);
    if (previous !== undefined) this.retire(seq, move.to, previous, change);
    this.standing.set(move.to, file);
    change.moved.push({ file, from: move.from, to: move.to });

    // A Relocation keeps the name it was born with; any other rename shows its new path.
    const relocated = !wholeDirectory && splitPath(move.from).dir !== splitPath(move.to).dir;
    if (!relocated) this.filePaths[file] = move.to;

    const type = BUILDING_TYPES.indexOf(buildingTypeOf(categoryOf(move.to)));
    const language = languageOf(move.to);
    const typeChanged = type !== this.currentType[file];
    const languageChanged = language !== this.currentLanguage[file];
    this.currentType[file] = type;
    this.currentLanguage[file] = language;
    if (relocated) this.event(seq, file, EVENT_RELOCATE, type);
    else if (typeChanged) this.event(seq, file, EVENT_RENOVATE, type);
    if (languageChanged) this.event(seq, file, EVENT_LANGUAGE, language);
  }

  /** Files standing under each directory a rename leaves, before the commit: what a whole-directory move is measured against. */
  private standingCounts(renames: readonly { from: string }[]): (dir: string) => number {
    const wanted = new Set(renames.flatMap((r) => ancestors(r.from)));
    const counts = new Map<string, number>();
    if (wanted.size > 0) {
      for (const path of this.standing.keys()) {
        for (const dir of ancestors(path)) if (wanted.has(dir)) counts.set(dir, (counts.get(dir) ?? 0) + 1);
      }
    }
    return (dir) => counts.get(dir) ?? 0;
  }

  private retire(seq: number, path: string, file: number, change: TimelineChange) {
    this.standing.delete(path);
    this.alive[file] = false;
    this.scaffolded.delete(file);
    this.event(seq, file, EVENT_DELETE, 0);
    change.deleted.push({ file, path });
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

/** What one commit changed in the Timeline's files, for the layout. */
export type TimelineChange = Required<Omit<LayoutChange, "widths">>;

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
  currentType: number[];
  currentLanguage: number[];
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
