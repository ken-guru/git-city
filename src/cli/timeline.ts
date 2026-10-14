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
import { ancestors, wholeDirectoryMoves } from "./layout.js";
import { buildingTypeOf, categoryOf, floorsFor, languageOf, seedFor, TUNING } from "./model.js";

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

  add(commit: CommitRecord): void {
    const seq = this.days.length;
    const day = commit.day;
    this.days.push(day);

    // A rename whose old path does not stand is not a rename here: its new path is simply added.
    const renames = (commit.renamed ?? []).filter((r) => this.standing.has(r.from));
    const renamedFrom = new Set(renames.map((r) => r.from));
    const renamedTo = new Set(renames.map((r) => r.to));
    const whole = wholeDirectoryMoves(renames, this.standingCounts(renames));

    for (const path of commit.deleted) {
      if (renamedFrom.has(path)) continue;
      const file = this.standing.get(path);
      if (file === undefined) continue;
      this.retire(seq, path, file);
    }

    renames.forEach((move, i) => this.rename(seq, move, whole.covered.has(i)));

    const touched = new Set<number>();
    for (const path of commit.added) {
      if (renamedTo.has(path)) continue;
      const previous = this.standing.get(path);
      if (previous !== undefined) this.retire(seq, path, previous);

      const file = this.nextFile++;
      this.filePaths.push(path);
      const floors = floorsFor(commit.lines?.get(path) ?? 0);
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

  /** A file keeps its id under its new path. Renames are not changes: they do not count towards scaffolding. */
  private rename(seq: number, move: { from: string; to: string }, wholeDirectory: boolean) {
    const file = this.standing.get(move.from)!;
    this.standing.delete(move.from);
    const previous = this.standing.get(move.to);
    if (previous !== undefined) this.retire(seq, move.to, previous);
    this.standing.set(move.to, file);

    // A Relocation keeps the name it was born with; any other rename shows its new path.
    const relocated = !wholeDirectory && directoryOf(move.from) !== directoryOf(move.to);
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

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
