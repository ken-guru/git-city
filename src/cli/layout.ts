/**
 * Layout: decides where every Building's Lot stands, as a fold over the Timeline in history order.
 * Every decision uses only what came before it, so a prefix of the history yields a prefix of the
 * layout, and a Lot, once handed out, never moves or is reused.
 */

/** Files a commit adds or deletes, with the file ids the Timeline gave them. */
export interface LayoutChange {
  added: { file: number; path: string }[];
  deleted: { file: number; path: string }[];
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
const MAX_WIDTH_STEP = 3;
/** Paving: medium-low saturation and a fixed lightness, with seeded offsets of 15 and 6 points. */
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

export interface LotRecord {
  file: number;
  block: number;
  /** First unit slot within the Block, row by row (0 to 7). */
  slot: number;
  slots: number;
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
  index: number;
  village: number;
  neighbourhoods: Set<string>;
  scores: Map<Role, number>;
  role: Role | null;
}

/** Mutable layout state. Feed it commits in order with `apply`, read it with `result`. */
export class LayoutBuilder {
  private readonly manifestDirs = new Map<string, number>();
  private readonly manifestPaths = new Set<string>();
  private readonly standingDirs = new Map<string, number>();
  private readonly inPlace = new Set<string>();
  private readonly districts = new Map<string, DistrictState>();
  private readonly villages: VillageRecord[] = [];
  private readonly blocks: BlockRecord[] = [];
  private readonly lots: LotRecord[] = [];
  private readonly blockAt = new Map<string, number>();
  private readonly blockSlots: boolean[][] = [];
  private readonly ownedBlocks = new Map<string, number[]>();
  private readonly categoryOf: (path: string) => string;
  private readonly widthStepOf: (file: number) => number;

  constructor(private readonly options: LayoutOptions) {
    this.categoryOf = options.categoryOf ?? guessCategory;
    this.widthStepOf = options.widthStepOf ?? (() => 0);
  }

  apply(change: LayoutChange): void {
    for (const { path } of change.deleted) this.unstand(path);
    for (const { file, path } of change.added) {
      this.addManifest(path);
      this.stand(path);
      this.build(file, path);
    }
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
    // A manifest arriving in a directory that already holds files splits off in place.
    if ((this.standingDirs.get(dir) ?? 0) > 0) this.inPlace.add(dir);
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
      if (count === 0) this.manifestDirs.delete(dir);
      else this.manifestDirs.set(dir, count);
    }
  }

  /** Places one new Building: its District, Neighbourhood, Lot and the Block that holds the Lot. */
  private build(file: number, path: string): void {
    const dir = splitPath(path).dir;
    const dirs = dir === "" ? [] : dir.split("/");
    const key = this.districtOf(dirs);
    const district = this.districtFor(key, dirs);
    const rootDepth = key === "." ? 0 : key.split("/").length;
    const neighbourhood = dirs.length > rootDepth ? dirs.slice(0, rootDepth + 1).join("/") : key;
    district.neighbourhoods.add(neighbourhood);
    this.scoreRoles(district, path);

    const slots = Math.min(this.widthStepOf(file) + 2, BLOCK_SLOTS_PER_ROW);
    const at = this.allocate(`${key}|${neighbourhood}`, district.village, neighbourhood, slots);
    this.lots.push({ file, block: at.block, slot: at.slot, slots });
  }

  /** The District a path belongs to: nearest ancestor with a manifest, else its top-level directory, else ".". */
  private districtOf(dirs: string[]): string {
    for (let depth = dirs.length; depth >= 1; depth--) {
      const prefix = dirs.slice(0, depth).join("/");
      if (this.manifestDirs.has(prefix)) return prefix;
    }
    return dirs[0] ?? ".";
  }

  private districtFor(key: string, dirs: string[]): DistrictState {
    const existing = this.districts.get(key);
    if (existing) return existing;
    const village = this.inPlace.has(key) ? this.parentVillage(dirs, key) : this.foundVillage(key);
    const district: DistrictState = {
      key,
      index: this.districts.size,
      village,
      neighbourhoods: new Set(),
      scores: new Map(),
      role: null,
    };
    this.districts.set(key, district);
    return district;
  }

  /** The village of the nearest ancestor District, for a Module that splits off in place. */
  private parentVillage(dirs: string[], key: string): number {
    for (let depth = dirs.length - 1; depth >= 1; depth--) {
      const parent = this.districts.get(dirs.slice(0, depth).join("/"));
      if (parent) return parent.village;
    }
    return this.foundVillage(key);
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
  private claimBlock(owner: string, village: number, neighbourhood: string): number {
    const anchor = this.villages[village]!;
    const globalSpot = this.bestBlockSpot(anchor, village);
    const own = this.ownedBlocks.get(owner) ?? [];
    let cohesive: { col: number; row: number } | undefined;
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
  private bestBlockSpot(anchor: VillageRecord, village: number): { col: number; row: number } {
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
  ): { col: number; row: number } {
    let best: { col: number; row: number } | undefined;
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
    if (best) return best;
    if (maxRing !== Infinity) return this.nearest(accept, Infinity, fromCol, fromRow);
    throw new Error("no free spot found");
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
    if (district.role === null || bestScore > current * 1.5) district.role = best;
  }
}

const CATEGORY_ROLE: Record<string, Role | undefined> = {
  tests: "tests", docs: "docs", build: "build", config: "config", data: "data",
};

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
function lessCell(col: number, row: number, other: { col: number; row: number }): boolean {
  return row < other.row || (row === other.row && col < other.col);
}

function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at === -1 ? { dir: "", name: path } : { dir: path.slice(0, at), name: path.slice(at + 1) };
}

/** Every directory above a path, shallowest first, not including the root. */
function ancestors(path: string): string[] {
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
