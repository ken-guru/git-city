/**
 * Layout: decides where every Building's Lot stands, as a fold over the Timeline in history order.
 * Every decision uses only what came before it, so a prefix of the history yields a prefix of the
 * layout, and a Lot, once handed out, never moves or is reused.
 */

/** Files a commit adds or deletes, with the file ids the Timeline gave them. */
export interface LayoutChange {
  added: { file: number; path: string }[];
  deleted: { file: number; path: string }[];
  /** Files that kept their identity under a new path (a rename). Same file id; a new directory means a Relocation. */
  moved?: { file: number; from: string; to: string }[];
}

export interface LayoutOptions {
  /** City seed: drives village angles and paving offsets. */
  seed: number;
  /** Maps a path to its Category name. Defaults to a plain path-based guess. */
  categoryOf?: (path: string) => string;
  /** Width step (0 narrowest, 3 widest) of a file when it is built. Defaults to 0. */
  widthStepOf?: (file: number) => number;
}

/** Tuning values. Starting points, named so they can be configured. */
export const VILLAGE_SPACING = 10;
export const COHESION_SLACK = 8;
/** A Block is 2 rows of 4 unit slots. */
export const BLOCK_ROWS = 2;
export const BLOCK_SLOTS_PER_ROW = 4;
/** A Lot is sized for its width step plus this many unit slots of headroom. */
export const LOT_HEADROOM_SLOTS = 2;
/** The share of a directory's files that must move to one new directory in one commit for it to count as a whole-directory move. */
export const WHOLE_DIRECTORY_SHARE = 0.8;
/** A District's Role switches only when another Role's score exceeds the current one by this ratio. */
export const ROLE_SWITCH_RATIO = 1.5;

/** A cell of the Block grid. */
interface Cell {
  col: number;
  row: number;
}
/**
 * Paving: medium-low saturation and a fixed lightness, with seeded offsets of 15 and 6 points.
 * All values are fractions of the full 0 to 1 range (absolute points, not relative percentages).
 * Known limits, for the page and later tickets: the seeded village angle is recorded but the Block grid
 * is not rotated by it; a Lot is sized from its Building's width step at birth, so a later wider step is
 * not re-sized; a District that splits off in place does not yet take the opposite lightness offset.
 */
const PAVING_SATURATION = 0.42;
const PAVING_LIGHTNESS = 0.55;
const SATURATION_OFFSET = 0.15;
const LIGHTNESS_OFFSET = 0.06;
const STONE = { hue: 40, saturation: 0.08 } as const;
/** The yellow-green to green band reserved for the Countryside. Paving never uses it. */
const GREEN_BAND = { from: 70, to: 160 } as const;
/** Ring search limit before a village may grow next to a neighbour. */
const BUFFER_SEARCH_RINGS = 256;

export const ROLES = [
  "tests", "docs", "api", "ui", "auth", "data", "cli", "infra", "utils", "core", "config", "build",
] as const;
export type Role = (typeof ROLES)[number];

/** Hue per Role, from the default palette. */
const ROLE_HUE: Record<Role, number> = {
  tests: 42, docs: 270, api: 28, ui: 340, auth: 355, data: 15,
  cli: 245, infra: 205, utils: 38, core: 215, config: 180, build: 220,
};

/** Path tokens that name a Role. */
const TOKEN_ROLE = new Map<string, Role>(
  Object.entries({
    tests: ["test", "tests", "spec", "specs", "e2e", "testing"],
    docs: ["docs", "doc", "documentation", "readme", "guide"],
    api: ["api", "routes", "route", "endpoints", "controllers", "graphql", "rest"],
    ui: ["ui", "components", "component", "views", "pages", "frontend", "web", "styles", "css"],
    auth: ["auth", "login", "logout", "session", "sessions", "oauth", "passport", "signin", "identity"],
    data: ["data", "db", "database", "models", "model", "schema", "schemas", "migrations", "sql"],
    cli: ["cli", "bin", "commands", "command"],
    infra: ["infra", "deploy", "deployment", "terraform", "k8s", "docker", "helm", "ops", "kubernetes"],
    utils: ["utils", "util", "helpers", "helper", "common", "shared"],
    core: ["core", "domain", "engine", "kernel", "internal"],
    config: ["config", "configs", "settings", "env"],
    build: ["build", "ci", "scripts", "workflows", "github"],
  } as Record<Role, string[]>).flatMap(([role, tokens]) => tokens.map((t) => [t, role as Role] as const)),
);

const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "setup.py", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "mix.exs", "deno.json",
]);

export interface DistrictRecord {
  /** The Module's directory, "." for files directly in the root. */
  key: string;
  /** The village this District is drawn in. */
  village: number;
  /** Neighbourhood names: the District's own root and each first-level directory under it. */
  neighbourhoods: string[];
  role: Role | null;
  paving: { hue: number; saturation: number; lightness: number };
}

export interface VillageRecord {
  id: number;
  district: string;
  /** Anchor Block, which is also the village centre, on the Block grid. */
  col: number;
  row: number;
  /** Seeded angle, in radians, that turns the village's grid. */
  angle: number;
}

export interface BlockRecord {
  id: number;
  village: number;
  neighbourhood: string;
  col: number;
  row: number;
  /** Horizontal offset in Block widths, so that alternate rows sit like bricks. */
  brickOffset: number;
}

/**
 * A Lot a Building stood on. A Building that is relocated gets a new record under the same file id;
 * its last record is where it stands now, and earlier ones are Lots left empty.
 */
export interface LotRecord {
  file: number;
  block: number;
  /** First unit slot within the Block, row by row (0 to 7). */
  slot: number;
  slots: number;
}

/** A directory whose files moved together, as the layout relabels it: `from` is now `to`. */
export interface DirectoryMove {
  from: string;
  to: string;
}

export interface LayoutResult {
  districts: DistrictRecord[];
  villages: VillageRecord[];
  blocks: BlockRecord[];
  /** Lots in birth order. */
  lots: LotRecord[];
}

interface DistrictState {
  key: string;
  /** Birth order of the District: never reused, so a District that merged back and returned is a new one. */
  index: number;
  village: number;
  neighbourhoods: Set<string>;
  scores: Map<Role, number>;
  role: Role | null;
}

/** Whether a directory is `dir` itself or lies below it. */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + "/");
}

/** The key of a Neighbourhood's owner: the District it is drawn in and its name. Unambiguous, so it can be parsed back. */
function ownerKey(district: string, neighbourhood: string): string {
  return JSON.stringify([district, neighbourhood]);
}

/** Mutable layout state. Feed it commits in order with `apply`, read it with `result`. */
export class LayoutBuilder {
  private readonly manifestDirs = new Map<string, number>();
  private readonly manifestPaths = new Set<string>();
  private readonly standingDirs = new Map<string, number>();
  private readonly inPlace = new Set<string>();
  private readonly districts = new Map<string, DistrictState>();
  /** Directories whose manifest went this commit; each merges back once the commit's manifests are known. */
  private readonly vanishedManifests = new Set<string>();
  private nextDistrictIndex = 0;
  private readonly villages: VillageRecord[] = [];
  private readonly blocks: BlockRecord[] = [];
  private readonly lots: LotRecord[] = [];
  private readonly blockAt = new Map<string, number>();
  private readonly blockSlots: boolean[][] = [];
  /** Blocks each Neighbourhood owns, keyed by `ownerKey`. */
  private readonly ownedBlocks = new Map<string, number[]>();
  private readonly categoryOf: (path: string) => string;
  private readonly widthStepOf: (file: number) => number;

  constructor(private readonly options: LayoutOptions) {
    this.categoryOf = options.categoryOf ?? guessCategory;
    this.widthStepOf = options.widthStepOf ?? (() => 0);
  }

  apply(change: LayoutChange): void {
    const moved = change.moved ?? [];
    const whole = wholeDirectoryMoves(moved, (dir) => this.standingDirs.get(dir) ?? 0);
    for (const { path } of change.deleted) this.unstand(path);
    for (const { from } of moved) this.unstand(from);
    // Manifests first, so that whether a directory splits off in place never depends on order within a commit.
    for (const { path } of change.added) this.addManifest(path);
    for (const { to } of moved) this.addManifest(to);
    for (const dir of this.vanishedManifests) this.mergeDistrict(dir);
    this.vanishedManifests.clear();

    for (const directory of whole.directories) this.relabel(directory);
    for (const { path } of change.added) this.stand(path);
    for (const { to } of moved) this.stand(to);
    for (const { file, path } of change.added) this.build(file, path);
    moved.forEach(({ file, from, to }, i) => {
      // A rename within its directory keeps its Lot; a whole-directory move keeps its Lots too.
      if (whole.covered.has(i) || splitPath(from).dir === splitPath(to).dir) return;
      this.build(file, to);
    });
  }

  result(): LayoutResult {
    const districts = [...this.districts.values()]
      .sort((a, b) => a.index - b.index)
      .map((d) => ({
        key: d.key,
        village: d.village,
        neighbourhoods: [...d.neighbourhoods],
        role: d.role,
        paving: paving(this.options.seed, d.index, d.role),
      }));
    return {
      districts,
      villages: this.villages.map((v) => ({ ...v })),
      blocks: this.blocks.map((b) => ({ ...b })),
      lots: this.lots.map((l) => ({ ...l })),
    };
  }

  private addManifest(path: string): void {
    const { dir, name } = splitPath(path);
    if (dir === "" || !MANIFEST_NAMES.has(name) || this.manifestPaths.has(path)) return;
    this.manifestPaths.add(path);
    this.manifestDirs.set(dir, (this.manifestDirs.get(dir) ?? 0) + 1);
    // A manifest arriving in a directory that already holds files splits off in place; otherwise it founds a village.
    if ((this.standingDirs.get(dir) ?? 0) > 0) this.inPlace.add(dir);
    else this.inPlace.delete(dir);
  }

  private stand(path: string): void {
    for (const dir of ancestors(path)) this.standingDirs.set(dir, (this.standingDirs.get(dir) ?? 0) + 1);
  }

  private unstand(path: string): void {
    for (const dir of ancestors(path)) {
      const count = (this.standingDirs.get(dir) ?? 1) - 1;
      if (count === 0) this.standingDirs.delete(dir);
      else this.standingDirs.set(dir, count);
    }
    const { dir, name } = splitPath(path);
    if (dir !== "" && MANIFEST_NAMES.has(name) && this.manifestPaths.delete(path)) {
      const count = (this.manifestDirs.get(dir) ?? 1) - 1;
      if (count === 0) {
        this.manifestDirs.delete(dir);
        this.vanishedManifests.add(dir);
      } else this.manifestDirs.set(dir, count);
    }
  }

  /** Places one new Building: its District, Neighbourhood, Lot and the Block that holds the Lot. */
  private build(file: number, path: string): void {
    const dir = splitPath(path).dir;
    const dirs = dir === "" ? [] : dir.split("/");
    const key = this.districtOf(dirs);
    const district = this.districtFor(key);
    const rootDepth = key === "." ? 0 : key.split("/").length;
    const neighbourhood = dirs.length > rootDepth ? dirs.slice(0, rootDepth + 1).join("/") : key;
    district.neighbourhoods.add(neighbourhood);
    this.scoreRoles(district, path);

    const slots = slotsFor(this.widthStepOf(file));
    const at = this.allocate(ownerKey(key, neighbourhood), district.village, neighbourhood, slots);
    this.lots.push({ file, block: at.block, slot: at.slot, slots });
  }

  /**
   * A whole directory moved: each of its Neighbourhoods keeps its Blocks, Lots and village, and takes the new name.
   * Nothing is rebuilt.
   */
  private relabel({ from, to }: DirectoryMove): void {
    for (const owner of [...this.ownedBlocks.keys()]) {
      const [district, neighbourhood] = JSON.parse(owner) as [string, string];
      if (!within(neighbourhood, from)) continue;
      const renamed = to + neighbourhood.slice(from.length);
      const blocks = this.ownedBlocks.get(owner)!;
      this.ownedBlocks.delete(owner);
      for (const id of blocks) this.blocks[id]!.neighbourhood = renamed;
      const newDistrict = this.districtOf(renamed.split("/"));
      const target = ownerKey(newDistrict, renamed);
      this.ownedBlocks.set(target, [...(this.ownedBlocks.get(target) ?? []), ...blocks]);
      this.districts.get(district)?.neighbourhoods.delete(neighbourhood);
      const village = this.blocks[blocks[0]!]!.village;
      this.districtFor(newDistrict, village).neighbourhoods.add(renamed);
    }
  }

  /** The District a path belongs to: nearest ancestor with a manifest, else its top-level directory, else ".". */
  private districtOf(dirs: string[]): string {
    for (let depth = dirs.length; depth >= 1; depth--) {
      const prefix = dirs.slice(0, depth).join("/");
      if (this.manifestDirs.has(prefix)) return prefix;
    }
    return dirs[0] ?? ".";
  }

  /**
   * The District with this key, created if it is new. A new District either takes the village it is given (a merge or
   * a relabelled directory), splits off in place inside its nearest ancestor District's village, or founds its own village.
   */
  private districtFor(key: string, villageHint?: number): DistrictState {
    const existing = this.districts.get(key);
    if (existing) return existing;
    const parent = villageHint === undefined && this.inPlace.has(key) ? this.parentDistrict(key) : undefined;
    const village = villageHint ?? parent?.village ?? this.foundVillage(key);
    const district: DistrictState = {
      key,
      index: this.nextDistrictIndex++,
      village,
      neighbourhoods: new Set(),
      scores: new Map(),
      role: null,
    };
    this.districts.set(key, district);
    // Its Neighbourhoods were drawn in the parent District; they now belong to this one, with the same Blocks.
    if (parent) this.moveOwners(parent, district, (nb) => within(nb, key));
    return district;
  }

  /** The nearest ancestor District of a key (dirs above it), if one exists. */
  private parentDistrict(key: string): DistrictState | undefined {
    const segments = key.split("/");
    for (let depth = segments.length - 1; depth >= 1; depth--) {
      const parent = this.districts.get(segments.slice(0, depth).join("/"));
      if (parent) return parent;
    }
    return undefined;
  }

  /** A District whose manifest went merges back into the District its files now belong to, and is gone for good. */
  private mergeDistrict(key: string): void {
    if (this.manifestDirs.has(key)) return;
    const district = this.districts.get(key);
    if (!district) return;
    const next = this.districtOf(key.split("/"));
    if (next === key) return;
    const target = this.districtFor(next, district.village);
    this.moveOwners(district, target, () => true);
    this.districts.delete(key);
  }

  /** Hands the Neighbourhoods of `from` that match `scope` over to `to`, along with their Blocks. */
  private moveOwners(from: DistrictState, to: DistrictState, scope: (neighbourhood: string) => boolean): void {
    for (const owner of [...this.ownedBlocks.keys()]) {
      const [district, neighbourhood] = JSON.parse(owner) as [string, string];
      if (district !== from.key || !scope(neighbourhood)) continue;
      const target = ownerKey(to.key, neighbourhood);
      this.ownedBlocks.set(target, [...(this.ownedBlocks.get(target) ?? []), ...this.ownedBlocks.get(owner)!]);
      this.ownedBlocks.delete(owner);
      from.neighbourhoods.delete(neighbourhood);
      to.neighbourhoods.add(neighbourhood);
    }
  }

  /** Founds a village at the free spot nearest the centre that keeps VILLAGE_SPACING from every other village. */
  private foundVillage(key: string): number {
    const spot = this.nearest(
      (c, r) => !this.blockAt.has(cellKey(c, r)) && !this.anyBlockWithin(c, r, VILLAGE_SPACING - 1),
      Infinity,
      0,
      0,
    )!;
    const id = this.villages.length;
    const angle = seeded(this.options.seed, id, 0) * Math.PI * 2;
    this.villages.push({ id, district: key, col: spot.col, row: spot.row, angle });
    return id;
  }

  private anyBlockWithin(col: number, row: number, radius: number): boolean {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (this.blockAt.has(cellKey(col + dc, row + dr))) return true;
      }
    }
    return false;
  }

  /** Lots are first-fit within the Neighbourhood's Blocks, else in a new Block claimed for it. */
  private allocate(owner: string, village: number, neighbourhood: string, slots: number): { block: number; slot: number } {
    for (const id of this.ownedBlocks.get(owner) ?? []) {
      const slot = findRun(this.blockSlots[id]!, slots);
      if (slot !== undefined) return { block: id, slot };
    }
    const id = this.claimBlock(owner, village, neighbourhood);
    return { block: id, slot: findRun(this.blockSlots[id]!, slots)! };
  }

  /** Claims a Block for a Neighbourhood, preferring its own Blocks (within COHESION_SLACK) over the nearest free spot. */
  private claimBlock(owner: string, villageOfDistrict: number, neighbourhood: string): number {
    const own = this.ownedBlocks.get(owner) ?? [];
    // A Neighbourhood stays in the village its Blocks are in, even if its District has since moved.
    const village = own.length > 0 ? this.blocks[own[0]!]!.village : villageOfDistrict;
    const anchor = this.villages[village]!;
    const globalSpot = this.bestBlockSpot(anchor, village);
    let cohesive: Cell | undefined;
    let cohesiveDist = Infinity;
    for (const id of own) {
      const b = this.blocks[id]!;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const c = b.col + dc;
          const r = b.row + dr;
          if ((dc === 0 && dr === 0) || this.blockAt.has(cellKey(c, r)) || this.nextToOtherVillage(c, r, village)) continue;
          const d = Math.hypot(c - anchor.col, r - anchor.row);
          if (d < cohesiveDist || (d === cohesiveDist && lessCell(c, r, cohesive!))) {
            cohesive = { col: c, row: r };
            cohesiveDist = d;
          }
        }
      }
    }
    const globalDist = Math.hypot(globalSpot.col - anchor.col, globalSpot.row - anchor.row);
    const spot = cohesive && cohesiveDist <= globalDist + COHESION_SLACK ? cohesive : globalSpot;

    const id = this.blocks.length;
    this.blocks.push({
      id,
      village,
      neighbourhood,
      col: spot.col,
      row: spot.row,
      brickOffset: Math.abs(spot.row) % 2 === 1 ? 0.5 : 0,
    });
    this.blockAt.set(cellKey(spot.col, spot.row), id);
    this.blockSlots.push(Array.from({ length: BLOCK_ROWS * BLOCK_SLOTS_PER_ROW }, () => false));
    own.push(id);
    this.ownedBlocks.set(owner, own);
    return id;
  }

  /** The free spot nearest the village centre, keeping one Block of open land from other villages if it can. */
  private bestBlockSpot(anchor: VillageRecord, village: number): Cell {
    const buffered = this.nearest(
      (c, r) => !this.blockAt.has(cellKey(c, r)) && !this.nextToOtherVillage(c, r, village),
      BUFFER_SEARCH_RINGS,
      anchor.col,
      anchor.row,
    );
    return buffered ?? this.nearest((c, r) => !this.blockAt.has(cellKey(c, r)), Infinity, anchor.col, anchor.row)!;
  }

  private nextToOtherVillage(col: number, row: number, village: number): boolean {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const other = this.blockAt.get(cellKey(col + dc, row + dr));
        if (other !== undefined && this.blocks[other]!.village !== village) return true;
      }
    }
    return false;
  }

  /**
   * Ring search outward from (col, row) for the accepted cell nearest to it.
   * Ties go to the lower row, then the lower column.
   */
  private nearest(
    accept: (col: number, row: number) => boolean,
    maxRing: number,
    fromCol: number,
    fromRow: number,
  ): Cell | undefined {
    let best: Cell | undefined;
    let bestD = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      for (let dr = -r; dr <= r; dr++) {
        const fullRow = Math.abs(dr) === r;
        for (let dc = -r; dc <= r; dc += fullRow || r === 0 ? 1 : 2 * r) {
          const c = fromCol + dc;
          const row = fromRow + dr;
          const d = (c - fromCol) ** 2 + (row - fromRow) ** 2;
          if (d > bestD || (d === bestD && !lessCell(c, row, best!))) continue;
          if (accept(c, row)) {
            best = { col: c, row };
            bestD = d;
          }
        }
      }
      if (best && bestD <= (r + 1) ** 2) break;
    }
    return best;
  }

  private scoreRoles(district: DistrictState, path: string): void {
    const add = (role: Role, n: number) => district.scores.set(role, (district.scores.get(role) ?? 0) + n);
    for (const token of pathTokens(path)) {
      const role = TOKEN_ROLE.get(token);
      if (role) add(role, 1);
    }
    const categoryRole = CATEGORY_ROLE[this.categoryOf(path)];
    if (categoryRole) add(categoryRole, 1);

    let best: Role | null = null;
    let bestScore = 0;
    for (const role of ROLES) {
      const score = district.scores.get(role) ?? 0;
      if (score > bestScore) {
        best = role;
        bestScore = score;
      }
    }
    if (best === null) return;
    // A Role switches only when another clearly dominates the current one.
    const current = district.role === null ? 0 : (district.scores.get(district.role) ?? 0);
    if (district.role === null || bestScore > current * ROLE_SWITCH_RATIO) district.role = best;
  }
}

const CATEGORY_ROLE: Record<string, Role | undefined> = {
  tests: "tests", docs: "docs", build: "build", config: "config", data: "data",
};

/** The Lot size, in unit slots, for a Building of a given width step: its step plus headroom, at most a Block row. */
export function slotsFor(widthStep: number): number {
  return Math.min(widthStep + LOT_HEADROOM_SLOTS, BLOCK_SLOTS_PER_ROW);
}

/**
 * The slots a Building's footprint takes on its Lot at a width step. A Building that outgrows its Lot
 * keeps the Lot's size: the footprint is clamped, and the Building only gets taller.
 */
export function footprintSlots(lot: LotRecord, widthStep: number): number {
  return Math.min(slotsFor(widthStep), lot.slots);
}

/**
 * Whole-directory moves in one commit. A directory counts as moved when at least WHOLE_DIRECTORY_SHARE of its
 * standing files move to one new directory, keeping their relative paths. Shallowest directories win, so a move of
 * a whole tree is one move. `covered` holds the indexes of the moves a whole-directory move accounts for.
 * `standingUnder` counts the files standing under a directory before the commit.
 */
export function wholeDirectoryMoves(
  moves: readonly { from: string; to: string }[],
  standingUnder: (dir: string) => number,
): { directories: DirectoryMove[]; covered: Set<number> } {
  const directories: DirectoryMove[] = [];
  const covered = new Set<number>();
  const candidates = [...new Set(moves.flatMap((m) => ancestors(m.from)))].sort(
    (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const dir of candidates) {
    const counts = new Map<string, number>();
    moves.forEach((move, i) => {
      const target = covered.has(i) ? undefined : targetDirectory(dir, move);
      if (target !== undefined) counts.set(target, (counts.get(target) ?? 0) + 1);
    });
    for (const [target, count] of counts) {
      if (count === 0 || count < WHOLE_DIRECTORY_SHARE * standingUnder(dir)) continue;
      directories.push({ from: dir, to: target });
      moves.forEach((move, i) => {
        if (targetDirectory(dir, move) === target) covered.add(i);
      });
      break;
    }
  }
  return { directories, covered };
}

/** Where a move takes files under `dir` (keeping their path below it), or undefined when it does not. */
function targetDirectory(dir: string, move: { from: string; to: string }): string | undefined {
  if (!within(move.from, dir) || move.from === dir) return undefined;
  const rest = move.from.slice(dir.length + 1);
  if (!move.to.endsWith("/" + rest)) return undefined;
  return move.to.slice(0, move.to.length - rest.length - 1);
}

/** Layout over a whole Timeline, or over any prefix of one. */
export function layoutHistory(changes: Iterable<LayoutChange>, options: LayoutOptions): LayoutResult {
  const builder = new LayoutBuilder(options);
  for (const change of changes) builder.apply(change);
  return builder.result();
}

/** Paving for a District: its Role's hue, or stone, with seeded offsets that stay for the District's life. */
export function paving(seed: number, index: number, role: Role | null): LayoutResult["districts"][number]["paving"] {
  const lightness = PAVING_LIGHTNESS + (seeded(seed, index, 2) * 2 - 1) * LIGHTNESS_OFFSET;
  if (role === null) return { hue: STONE.hue, saturation: STONE.saturation, lightness };
  const saturation = PAVING_SATURATION + (seeded(seed, index, 1) * 2 - 1) * SATURATION_OFFSET;
  return { hue: avoidGreen(ROLE_HUE[role]), saturation, lightness };
}

function avoidGreen(hue: number): number {
  if (hue < GREEN_BAND.from || hue > GREEN_BAND.to) return hue;
  return hue < (GREEN_BAND.from + GREEN_BAND.to) / 2 ? GREEN_BAND.from - 1 : GREEN_BAND.to + 1;
}

/** A unit in [0, 1) from the seed, a salt and a lane: the same inputs always give the same value. */
function seeded(seed: number, salt: number, lane: number): number {
  return mix(mix(seed ^ mix(salt)) + lane) / 2 ** 32;
}

function mix(value: number): number {
  let a = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (a ^ (a >>> 16)) >>> 0;
}

/** First free run of `slots` unit slots within one Block row, as the first slot index, or undefined. */
function findRun(taken: boolean[], slots: number): number | undefined {
  for (let row = 0; row < BLOCK_ROWS; row++) {
    for (let start = 0; start + slots <= BLOCK_SLOTS_PER_ROW; start++) {
      const first = row * BLOCK_SLOTS_PER_ROW + start;
      let free = true;
      for (let s = first; s < first + slots && free; s++) free = !taken[s];
      if (free) {
        for (let s = first; s < first + slots; s++) taken[s] = true;
        return first;
      }
    }
  }
  return undefined;
}

function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

/** True when (col, row) comes before the other cell in the nearest-spot tie-break order. */
function lessCell(col: number, row: number, other: Cell): boolean {
  return row < other.row || (row === other.row && col < other.col);
}

function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

/** Every directory above a path, shallowest first, not including the root. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Lower-cased word tokens from every segment of a path, camelCase and punctuation split. */
function pathTokens(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
}

/** A plain path-based Category guess, used when no Category is supplied. */
function guessCategory(path: string): string {
  const lower = path.toLowerCase();
  if (/(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\./.test(lower)) return "tests";
  if (/\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//.test(lower)) return "docs";
  if (/(^|\/)(\.github|scripts|ci)\/|(^|\/)(dockerfile|makefile)$/.test(lower)) return "build";
  if (/\.(json|ya?ml|toml|ini|env|conf|rc)$/.test(lower)) return "config";
  if (/\.(csv|sql|parquet|db|sqlite)$/.test(lower)) return "data";
  if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/.test(lower)) return "assets";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|cs|kt|swift)$/.test(lower)) return "source";
  return "unknown";
}
