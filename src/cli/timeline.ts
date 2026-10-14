import { EVENT_ADD, EVENT_DELETE, type EventKind } from "../shared/format.js";
import type { CommitRecord } from "./history.js";

/**
 * Turns commits into numbered files and add/delete events.
 * Every add gives a new file id; a path that comes back later is a new file.
 */
export class TimelineBuilder {
  private readonly days: number[] = [];
  private readonly standing = new Map<string, number>();
  private nextFile = 0;
  /** The path each file id was born with, indexed by file id. */
  private readonly filePaths: string[] = [];
  private readonly eventCommit: number[] = [];
  private readonly eventFile: number[] = [];
  private readonly eventKind: EventKind[] = [];

  add(commit: CommitRecord): void {
    const seq = this.days.length;
    this.days.push(commit.day);
    for (const path of commit.deleted) {
      const file = this.standing.get(path);
      if (file === undefined) continue;
      this.standing.delete(path);
      this.event(seq, file, EVENT_DELETE);
    }
    for (const path of commit.added) {
      const previous = this.standing.get(path);
      if (previous !== undefined) this.event(seq, previous, EVENT_DELETE);
      const file = this.nextFile++;
      this.filePaths.push(path);
      this.standing.set(path, file);
      this.event(seq, file, EVENT_ADD);
    }
  }

  result() {
    return {
      commitDays: Int32Array.from(this.days),
      fileCount: this.nextFile,
      /** Names are made from these and never leave the CLI: only the naming step writes text. */
      filePaths: [...this.filePaths],
      eventCommit: Uint32Array.from(this.eventCommit),
      eventFile: Uint32Array.from(this.eventFile),
      eventKind: Uint8Array.from(this.eventKind),
    };
  }

  private event(commit: number, file: number, kind: EventKind) {
    this.eventCommit.push(commit);
    this.eventFile.push(file);
    this.eventKind.push(kind);
  }
}

export type TimelineData = ReturnType<TimelineBuilder["result"]>;
