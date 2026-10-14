import { describe, expect, it } from "vitest";
import { EVENT_ADD, EVENT_DELETE } from "../src/shared/format.js";
import { gridSlot, lifetimes, scaleAt } from "../src/page/state.js";

describe("page time-state", () => {
  it("grows a box in as its commit plays and shrinks it out when deleted", () => {
    // Born at commit 2, deleted at commit 5, with a one-commit eased transition.
    const at = (t: number) => scaleAt(2, 5, t);

    expect(at(1)).toBe(0);
    expect(at(2)).toBe(0);
    expect(at(2.5)).toBeCloseTo(0.875); // ease-out cubic: 1 - 0.5³
    expect(at(3)).toBe(1);
    expect(at(5)).toBe(1);
    expect(at(5.5)).toBeCloseTo(0.125);
    expect(at(6)).toBe(0);
    expect(at(100)).toBe(0);
  });

  it("keeps a file that is never deleted standing to the end", () => {
    expect(scaleAt(0, Infinity, 1e6)).toBe(1);
  });

  it("reads each file's lifetime from a chunk's snapshot and events", () => {
    const { birth, death } = lifetimes(
      {
        formatVersion: 1,
        firstCommit: 3,
        snapshot: Uint32Array.of(0),
        eventCommit: Uint32Array.of(3, 4, 4),
        eventFile: Uint32Array.of(1, 0, 2),
        eventKind: Uint8Array.of(EVENT_ADD, EVENT_DELETE, EVENT_ADD),
      },
      3,
    );

    expect([...birth]).toEqual([-Infinity, 3, 4]);
    expect([...death]).toEqual([4, Infinity, Infinity]);
  });

  it("gives every file its own spot on a square grid", () => {
    const slots = Array.from({ length: 10 }, (_, file) => gridSlot(file, 10));

    expect(slots[0]).toEqual({ column: 0, row: 0 });
    expect(slots[3]).toEqual({ column: 3, row: 0 });
    expect(slots[4]).toEqual({ column: 0, row: 1 });
    expect(new Set(slots.map((s) => `${s.column},${s.row}`)).size).toBe(10);
  });
});
