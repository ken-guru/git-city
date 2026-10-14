import { describe, expect, it } from "vitest";
import { type LayoutChange, type LotRecord, footprintSlots, layoutHistory } from "../src/cli/layout.js";
import { countryside } from "../src/shared/countryside.js";

/**
 * Seams under test (pre-agreed with the ticket): the layout module's public interface,
 * `layoutHistory` over a stream of commit changes, observed only through its result.
 */

/** Builds commit changes with file ids assigned the way the Timeline assigns them. */
class Changes {
  private nextFile = 0;
  private readonly standing = new Map<string, number>();
  readonly list: LayoutChange[] = [];

  /** Renames standing files: same file id, as the history reports a rename. */
  rename(pairs: [string, string][]): this {
    const change: LayoutChange = { added: [], deleted: [], moved: [] };
    for (const [from, to] of pairs) {
      const file = this.standing.get(from);
      if (file === undefined) continue;
      this.standing.delete(from);
      this.standing.set(to, file);
      change.moved!.push({ file, from, to });
    }
    this.list.push(change);
    return this;
  }

  commit(added: string[], deleted: string[] = []): this {
    const change: LayoutChange = { added: [], deleted: [] };
    for (const path of deleted) {
      const file = this.standing.get(path);
      if (file === undefined) continue;
      this.standing.delete(path);
      change.deleted.push({ file, path });
    }
    for (const path of added) {
      this.standing.set(path, this.nextFile);
      change.added.push({ file: this.nextFile++, path });
    }
    this.list.push(change);
    return this;
  }
}

const chebyshev = (a: { col: number; row: number }, b: { col: number; row: number }) =>
  Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

describe("Modules", () => {
  it("makes a directory with a manifest a District, and never the root manifest", () => {
    const history = new Changes()
      .commit(["package.json", "src/a.ts", "packages/api/package.json", "packages/api/index.ts"]);

    const result = layoutHistory(history.list, { seed: 1 });

    expect(result.districts.map((d) => d.key).sort()).toEqual([".", "packages/api", "src"]);
  });

  it("gives every file under a nested manifest to that manifest's District, and one Neighbourhood per first-level directory", () => {
    const history = new Changes()
      .commit(["packages/api/package.json", "packages/api/routes/x/y.ts", "packages/api/a.ts", "packages/web/b.ts"]);

    const result = layoutHistory(history.list, { seed: 1 });

    const api = result.districts.find((d) => d.key === "packages/api");
    expect(api?.neighbourhoods.sort()).toEqual(["packages/api", "packages/api/routes"]);
    // A file under no manifest belongs to its top-level directory's District.
    const packages = result.districts.find((d) => d.key === "packages");
    expect(packages?.neighbourhoods).toEqual(["packages/web"]);
  });
});

describe("Modules that appear partway through", () => {
  it("founds a village for a manifest directory that has no files yet", () => {
    const history = new Changes()
      .commit(["src/a.ts"])
      .commit(["packages/api/package.json", "packages/api/x.ts"]);
    const { districts, villages } = layoutHistory(history.list, { seed: 1 });
    const api = districts.find((d) => d.key === "packages/api");
    expect(villages[api!.village]!.district).toBe("packages/api");
    expect(api!.village).not.toBe(districts.find((d) => d.key === "src")!.village);
  });

  it("splits a directory that already holds files off in place, inside its parent's village, without moving a Lot", () => {
    const history = new Changes()
      .commit(["packages/web/a.ts", "packages/web/b.ts"])
      .commit(["packages/web/package.json", "packages/web/c.ts"]);
    const { districts, lots } = layoutHistory(history.list, { seed: 1 });
    const parent = districts.find((d) => d.key === "packages")!;
    const web = districts.find((d) => d.key === "packages/web")!;
    expect(web.village).toBe(parent.village);
    // The first two Lots stay where they were built, under the parent District.
    expect(lots.slice(0, 2).map((l) => l.file)).toEqual([0, 1]);
  });

  it("gives the same answer whichever order a commit lists its manifest and its files", () => {
    const first = new Changes()
      .commit(["packages/web/a.ts"])
      .commit(["packages/web/package.json", "packages/web/c.ts"]);
    const second = new Changes()
      .commit(["packages/web/a.ts"])
      .commit(["packages/web/c.ts", "packages/web/package.json"]);
    const village = (list: LayoutChange[]) =>
      layoutHistory(list, { seed: 1 }).districts.find((d) => d.key === "packages/web")!.village;
    expect(village(second.list)).toBe(village(first.list));
    expect(village(first.list)).toBe(layoutHistory(first.list, { seed: 1 }).districts.find((d) => d.key === "packages")!.village);
  });
});

describe("Villages", () => {
  it("founds the first village at the centre and each later one at the nearest free spot 10 Blocks from every other", () => {
    const history = new Changes()
      .commit(["src/a.ts", "lib/b.ts", "docs/c.md"]);

    const { villages, blocks } = layoutHistory(history.list, { seed: 7 });

    expect(villages.map((v) => v.district)).toEqual(["src", "lib", "docs"]);
    expect([villages[0]!.col, villages[0]!.row]).toEqual([0, 0]);
    const dist = (v: number, w: number) =>
      Math.min(...blocks.filter((b) => b.village === v).flatMap((a) => blocks.filter((b) => b.village === w).map((b) => chebyshev(a, b))));
    expect(dist(0, 1)).toBeGreaterThanOrEqual(10);
    expect(dist(0, 2)).toBeGreaterThanOrEqual(10);
    expect(dist(1, 2)).toBeGreaterThanOrEqual(10);
    // The second village sits at the nearest such spot: exactly 10 Blocks out.
    expect(dist(0, 1)).toBe(10);
  });

  it("gives each village a seeded angle", () => {
    const history = new Changes().commit(["src/a.ts", "lib/b.ts"]);
    const a = layoutHistory(history.list, { seed: 7 }).villages.map((v) => v.angle);
    const b = layoutHistory(history.list, { seed: 7 }).villages.map((v) => v.angle);
    const c = layoutHistory(history.list, { seed: 8 }).villages.map((v) => v.angle);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const angle of a) {
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(Math.PI * 2);
    }
  });
});

describe("Blocks and Lots", () => {
  it("sizes a Lot for the width step plus one step of headroom, and four slots at the widest step", () => {
    const history = new Changes().commit(["src/a.ts", "src/b.ts"]);
    const narrow = layoutHistory(history.list, { seed: 1 });
    expect(narrow.lots.map((l) => l.slots)).toEqual([2, 2]);
    const widest = layoutHistory(history.list, { seed: 1, widthStepOf: () => 3 });
    expect(widest.lots.map((l) => l.slots)).toEqual([4, 4]);
  });

  it("hands out Lots in birth order, never overlapping, and claims a new Block when one is full", () => {
    const history = new Changes().commit(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);

    const { lots, blocks } = layoutHistory(history.list, { seed: 1 });

    expect(lots.map((l) => l.file)).toEqual([0, 1, 2, 3, 4]);
    // A Block holds 2 x 4 unit slots, so two Lots of two slots fill one row and a Block holds four.
    expect(lots.slice(0, 4).map((l) => l.block)).toEqual([0, 0, 0, 0]);
    expect(lots[4]!.block).toBe(1);
    const seen = new Set<string>();
    for (const lot of lots) {
      for (let s = lot.slot; s < lot.slot + lot.slots; s++) {
        const key = `${lot.block}:${s}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(blocks.every((b) => b.village === 0 && b.neighbourhood === "src")).toBe(true);
  });

  it("never mixes two Neighbourhoods in one Block", () => {
    const history = new Changes().commit(["src/a.ts", "src/x/b.ts", "src/a2.ts", "src/x/b2.ts"]);

    const { lots, blocks } = layoutHistory(history.list, { seed: 1 });

    for (const lot of lots) {
      const block = blocks[lot.block]!;
      expect(block.neighbourhood).toBe(lot.file % 2 === 0 ? "src" : "src/x");
    }
  });

  it("offsets alternate Block rows like bricks", () => {
    const history = new Changes().commit(Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`));
    const { blocks } = layoutHistory(history.list, { seed: 1 });
    for (const block of blocks) expect(block.brickOffset).toBe(block.row % 2 === 0 ? 0 : 0.5);
  });

  it("keeps every Village's Blocks one Block clear of other Villages' Blocks", () => {
    const paths = [
      ...Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `lib/g${i}.ts`),
    ];
    const { blocks } = layoutHistory(new Changes().commit(paths).list, { seed: 3 });
    for (const a of blocks) for (const b of blocks) {
      if (a.village !== b.village) expect(chebyshev(a, b)).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Roles and paving", () => {
  it("detects a Role from path tokens", () => {
    const history = new Changes().commit(["src/auth/login.ts", "src/auth/session.ts", "tests/a.test.ts"]);
    const { districts } = layoutHistory(history.list, { seed: 1 });
    expect(districts.find((d) => d.key === "src")?.role).toBe("auth");
    expect(districts.find((d) => d.key === "tests")?.role).toBe("tests");
  });

  it("falls back to stone when nothing in the District names a Role", () => {
    const history = new Changes().commit(["zz/q.ts"]);
    const [district] = layoutHistory(history.list, { seed: 1 }).districts;
    expect(district?.role).toBeNull();
    expect(district?.paving.saturation).toBeLessThan(0.15);
  });

  it("never paves in the green band", () => {
    const names = ["tests", "docs", "api", "ui", "data", "ci", "config", "auth", "cli", "infra", "utils", "core"];
    for (let seed = 0; seed < 20; seed++) {
      const history = new Changes().commit(names.map((n) => `${n}/x.ts`));
      for (const d of layoutHistory(history.list, { seed }).districts) {
        expect(d.paving.hue < 70 || d.paving.hue > 160).toBe(true);
      }
    }
  });

  it("offsets saturation by at most 15 points and lightness by at most 6 points, seeded per District", () => {
    // Four Districts that all name the tests Role, so they share a base colour and differ only by seeded offset.
    const history = new Changes().commit(["tests/a.ts", "spec/a.ts", "e2e/a.ts", "testing/a.ts"]);
    const sets = [1, 2, 3].map((seed) => layoutHistory(history.list, { seed }).districts.map((d) => d.paving));
    expect(sets[0]).toEqual(layoutHistory(history.list, { seed: 1 }).districts.map((d) => d.paving));
    expect(sets[0]).not.toEqual(sets[1]);
    const sats = sets[0]!.map((p) => p.saturation);
    const lights = sets[0]!.map((p) => p.lightness.light);
    expect(Math.max(...sats) - Math.min(...sats)).toBeLessThanOrEqual(0.3);
    expect(Math.max(...lights) - Math.min(...lights)).toBeLessThanOrEqual(0.12);
  });

  it("fixes lightness per page theme, so the dark page paves darker than the light one", () => {
    const { districts } = layoutHistory(new Changes().commit(["src/a.ts"]).list, { seed: 1 });
    const [district] = districts;
    expect(district!.paving.lightness.dark).toBeLessThan(district!.paving.lightness.light);
  });

  it("gives a District split off in place the opposite lightness offset from its parent's", () => {
    const history = new Changes()
      .commit(["packages/web/a.ts", "packages/x/b.ts"])
      .commit(["packages/web/package.json", "packages/web/c.ts"]);
    for (const seed of [1, 2, 3, 4, 5]) {
      const { districts } = layoutHistory(history.list, { seed });
      const parent = districts.find((d) => d.key === "packages");
      const child = districts.find((d) => d.key === "packages/web");
      expect(child, `seed ${seed}`).toBeDefined();
      const offset = (d: typeof parent) => d!.paving.lightness.light - 0.55;
      expect(Math.sign(offset(child)), `seed ${seed}`).toBe(-Math.sign(offset(parent)));
    }
  });
});

describe("Cut points and re-runs", () => {
  /** A deterministic history with manifests appearing and vanishing partway through. */
  function generated(): LayoutChange[] {
    let state = 12345;
    const rand = (n: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % n;
    };
    const dirs = ["src", "src/auth", "lib", "packages/api", "packages/web/ui", "tests", "docs"];
    const changes = new Changes();
    const standing: string[] = [];
    for (let c = 0; c < 60; c++) {
      const added: string[] = [];
      const deleted: string[] = [];
      for (let k = 0; k < 1 + rand(4); k++) {
        const dir = dirs[rand(dirs.length)]!;
        added.push(`${dir}/f${c}_${k}.ts`);
      }
      if (c % 9 === 4) added.push(`${dirs[rand(dirs.length)]}/package.json`);
      if (c % 13 === 7 && standing.length) deleted.push(standing[rand(standing.length)]!);
      standing.push(...added);
      changes.commit(added, deleted);
      for (const p of deleted) standing.splice(standing.indexOf(p), 1);
    }
    return changes.list;
  }

  it("moves no Lot for any first-run cut point", () => {
    const list = generated();
    const options = { seed: 99, widthStepOf: (file: number) => file % 4 };
    const full = layoutHistory(list, options);
    for (let cut = 0; cut <= list.length; cut++) {
      const prefix = layoutHistory(list.slice(0, cut), options);
      const built = new Set(list.slice(0, cut).flatMap((c) => c.added.map((a) => a.file)));
      const expected = full.lots.filter((l) => built.has(l.file));
      expect(prefix.lots).toEqual(expected);
      expect(prefix.blocks).toEqual(full.blocks.slice(0, prefix.blocks.length));
    }
  });

  it("a re-run equals a fresh run", () => {
    const list = generated();
    const options = { seed: 99 };
    expect(layoutHistory(list, options)).toEqual(layoutHistory(list, options));
  });
});

describe("Countryside terrain", () => {
  const land = (levelOf: (col: number, row: number) => "flat" | "hill" | "river") => ({ levelAt: levelOf });

  it("keeps every Block off rivers and hills by default when there is room", () => {
    const paths = [
      ...Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `lib/g${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `docs/h${i}.md`),
    ];
    const seed = 3;
    const { blocks } = layoutHistory(new Changes().commit(paths).list, { seed });
    const countrysideLand = countryside(seed);
    for (const b of blocks) expect(countrysideLand.levelAt(b.col, b.row)).toBe("flat");
  });

  it("relaxes to hills when every cell is hill, and to anything when every cell is river", () => {
    const paths = ["src/a.ts", "lib/b.ts", "docs/c.md"];
    const hills = layoutHistory(new Changes().commit(paths).list, { seed: 1, terrain: land(() => "hill") });
    expect(hills.villages).toHaveLength(3);
    const rivers = layoutHistory(new Changes().commit(paths).list, { seed: 1, terrain: land(() => "river") });
    expect(rivers.villages).toHaveLength(3);
    expect(rivers.blocks).toHaveLength(3);
  });

  it("prefers flat land over hills when both are open", () => {
    const hillsNear = land((col, row) => (Math.max(Math.abs(col), Math.abs(row)) <= 3 ? "hill" : "flat"));
    const { blocks } = layoutHistory(new Changes().commit(["src/a.ts", "src/b.ts", "src/c.ts"]).list, { seed: 1, terrain: hillsNear });
    for (const b of blocks) expect(hillsNear.levelAt(b.col, b.row)).toBe("flat");
  });
});

describe("Identity across history", () => {
  const placements = (lots: LotRecord[], file: number) => lots.filter((l) => l.file === file);

  it("rebuilds a Relocated file on a new Lot in the target Neighbourhood, under the same file id", () => {
    const history = new Changes()
      .commit(["a/x.ts", "a/y.ts", "a/z.ts", "b/w.ts"])
      .rename([["a/x.ts", "b/x.ts"]]);

    const { lots, blocks } = layoutHistory(history.list, { seed: 1 });

    const [old, moved] = placements(lots, 0);
    expect(blocks[old!.block]!.neighbourhood).toBe("a");
    // The Relocation takes a Lot in the Block its target Neighbourhood already fills.
    expect(blocks[moved!.block]!.neighbourhood).toBe("b");
    expect(moved!.block).toBe(placements(lots, 3)[0]!.block);
    expect(lots.length).toBe(5);
  });

  it("changes nothing for a rename within a directory", () => {
    const before = layoutHistory(new Changes().commit(["a/x.ts", "a/y.ts"]).list, { seed: 1 });
    const after = layoutHistory(new Changes().commit(["a/x.ts", "a/y.ts"]).rename([["a/x.ts", "a/renamed.ts"]]).list, { seed: 1 });
    expect(after).toEqual(before);
  });

  it("relabels a Neighbourhood's Blocks and rebuilds nothing when a whole directory moves", () => {
    const base = new Changes().commit(["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts", "src/auth/d.ts", "src/auth/e.ts", "src/other.ts"]);
    const before = layoutHistory(base.list, { seed: 1 });
    const after = layoutHistory(
      base.rename([
        ["src/auth/a.ts", "src/identity/a.ts"],
        ["src/auth/b.ts", "src/identity/b.ts"],
        ["src/auth/c.ts", "src/identity/c.ts"],
        ["src/auth/d.ts", "src/identity/d.ts"],
        ["src/auth/e.ts", "src/identity/e.ts"],
      ]).list,
      { seed: 1 },
    );
    expect(after.lots).toEqual(before.lots);
    expect(after.blocks.length).toBe(before.blocks.length);
    const authBlocks = before.blocks.filter((b) => b.neighbourhood === "src/auth").map((b) => b.id);
    expect(authBlocks.length).toBeGreaterThan(0);
    for (const id of authBlocks) expect(after.blocks[id]!.neighbourhood).toBe("src/identity");
  });

  it("treats a move of fewer than 80% of a directory's files as Relocations", () => {
    const history = new Changes()
      .commit(["src/auth/a.ts", "src/auth/b.ts", "src/auth/c.ts", "src/auth/d.ts", "src/auth/e.ts"])
      .rename([["src/auth/a.ts", "src/identity/a.ts"], ["src/auth/b.ts", "src/identity/b.ts"], ["src/auth/c.ts", "src/identity/c.ts"]]);
    const { lots, blocks } = layoutHistory(history.list, { seed: 1 });
    expect(lots.length).toBe(8);
    for (const file of [0, 1, 2]) expect(blocks[placements(lots, file)[1]!.block]!.neighbourhood).toBe("src/identity");
  });

  it("makes a re-added file at the same path a new Building on a new Lot", () => {
    const history = new Changes().commit(["a/x.ts"]).commit([], ["a/x.ts"]).commit(["a/x.ts"]);
    const { lots } = layoutHistory(history.list, { seed: 1 });
    expect(lots.map((l) => l.file)).toEqual([0, 1]);
    expect(lots.map((l) => [l.block, l.slot])).toEqual([[0, 0], [0, 2]]);
  });

  it("merges a District back when its manifest is removed, so its files join the parent District's Neighbourhood", () => {
    const history = new Changes()
      .commit(["packages/web/a.ts", "packages/web/b.ts"])
      .commit(["packages/web/package.json"])
      .commit([], ["packages/web/package.json"])
      .commit(["packages/web/c.ts"]);
    const { districts, lots, blocks } = layoutHistory(history.list, { seed: 1 });
    expect(districts.some((d) => d.key === "packages/web")).toBe(false);
    expect(blocks[lots[2]!.block]!.neighbourhood).toBe("packages/web");
  });

  it("clamps a Building's footprint to its Lot when it outgrows the Lot", () => {
    const lot: LotRecord = { file: 0, block: 0, slot: 0, slots: 2 };
    expect(footprintSlots(lot, 0)).toBe(2);
    expect(footprintSlots(lot, 3)).toBe(2);
    expect(footprintSlots({ ...lot, slots: 4 }, 3)).toBe(4);
  });
});
