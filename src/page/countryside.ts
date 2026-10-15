import {
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Scene,
  Vector3,
} from "three";
import {
  type Countryside,
  countryside,
  MOUNTAIN_MAX,
  type Point,
  sceneryFade,
  STYLE_A,
  TERRAIN,
  type StyleColours,
  type Swatch,
  unit,
} from "../shared/countryside.js";

/** World units per Block cell. */
const CELL = 6;
/** Cells drawn on each side of the centre. */
const RADIUS = 60;
const SIDE = 2 * RADIUS + 1;
/** Instance cap for trees, from the Countryside budget (about 14k). */
const MAX_TREES = 14000;
const TREES_PER_FOREST_CELL = 2;
const RIVER_BED_Y = -0.1;
const GROUND_Y = 0.01;
const BANK_Y = 0.04;
const WATER_Y = 0.06;
const FIELD_Y = 0.03;
/** Half-widths of the water and of its sandy bank, in cells. */
const WATER_HALF = 0.6;
const BANK_HALF = 1;

export interface CountrysideScene {
  seed: number;
  theme: "light" | "dark";
  /** Radius, in world units, around the centre where the City stands: no scenery there. */
  keepOut: number;
  /** Claimed Blocks, as Block-grid cells. Scenery next to them fades out. */
  claimed?: Point[];
  /** The level of detail the page starts at: how far trees thin, and how many are kept at the far end. */
  detail?: CountrysideDetail;
}

/** The level-of-detail values scenery uses (see `LodSettings`). */
export interface CountrysideDetail {
  sceneryFar: number;
  sceneryFloor: number;
}

export interface CountrysideHandle {
  /** The land the scenery was drawn from, so the Blocks and Roads sit on the same ground. */
  land: Countryside;
  /** Applies a level of detail: a lower level thins the trees sooner with distance. */
  setDetail(detail: CountrysideDetail): void;
}

/**
 * Adds the Countryside to the scene in six draw calls: ground, water, river banks, fields, trees (instanced)
 * and mountains (instanced). Every position is a pure function of the seed, so nothing here needs data
 * from the world file beyond the seed.
 */
export function addCountryside(scene: Scene, options: CountrysideScene): CountrysideHandle {
  const land = countryside(options.seed);
  const colours = STYLE_A[options.theme];
  const claimed = options.claimed ?? [];
  const inKeepOut = (c: number, r: number) => Math.hypot(c, r) * CELL < options.keepOut;
  const claimedCells = new Set(claimed.map((p) => cellKey(p.col, p.row)));
  // Scenery is full beyond the fade radius, so only the rings inside it need searching.
  const fadeAt = (c: number, r: number) => {
    for (let d = 0; d < TERRAIN.fadeRadius; d++) {
      if (ringHasClaim(claimedCells, c, r, d)) return sceneryFade(d);
    }
    return 1;
  };
  const thinning = {
    uSceneryFar: { value: options.detail?.sceneryFar ?? DEFAULT_DETAIL.sceneryFar },
    uSceneryFloor: { value: options.detail?.sceneryFloor ?? DEFAULT_DETAIL.sceneryFloor },
  };

  scene.add(ground(land, colours, inKeepOut));
  scene.add(ribbons(land, WATER_HALF, WATER_Y, colours.water, false));
  // Banks follow the ground beside them, so a hill next to a river does not bury its bank.
  scene.add(ribbons(land, BANK_HALF, BANK_Y, colours.sand, true));
  scene.add(fields(land, colours, options.seed, inKeepOut, fadeAt));
  scene.add(trees(land, colours, options.seed, inKeepOut, fadeAt, thinning));
  scene.add(mountains(land, colours, options.seed));
  return {
    land,
    setDetail(detail) {
      thinning.uSceneryFar.value = detail.sceneryFar;
      thinning.uSceneryFloor.value = detail.sceneryFloor;
    },
  };
}

const DEFAULT_DETAIL: CountrysideDetail = { sceneryFar: 150, sceneryFloor: 1 };

function cellKey(col: number, row: number): number {
  return col * 1_000_003 + row;
}

/** Whether a cell at Chebyshev distance `d` from (col, row) is claimed. Distance 0 is the cell itself. */
function ringHasClaim(claimed: ReadonlySet<number>, col: number, row: number, d: number): boolean {
  for (let dc = -d; dc <= d; dc++) {
    for (let dr = -d; dr <= d; dr++) {
      if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
      if (claimed.has(cellKey(col + dc, row + dr))) return true;
    }
  }
  return false;
}

/** Uniforms that thin the trees with distance from the camera. */
interface ThinningUniforms {
  uSceneryFar: { value: number };
  uSceneryFloor: { value: number };
}

/** The height of the ground mesh at one of its grid corners (a cell of the Countryside grid), in world units. */
export function groundY(land: Countryside, c: number, r: number): number {
  return land.levelAt(c, r) === "river" ? RIVER_BED_Y : GROUND_Y + land.heightAt(c, r);
}

/**
 * The height of the drawn ground at a point (x, z), in world units. The ground mesh is a grid of corners joined by
 * triangles, split along the same diagonal in every cell; this interpolates within the triangle the point lies in.
 * Anything placed on the ground (roads, Blocks, Buildings) samples this, so it sits on the surface that is drawn.
 */
export function groundHeightAt(land: Countryside, x: number, z: number): number {
  const c = x / CELL;
  const r = z / CELL;
  const i = Math.floor(c);
  const j = Math.floor(r);
  const u = c - i;
  const v = r - j;
  const a = groundY(land, i, j);
  const b = groundY(land, i + 1, j);
  const cc = groundY(land, i, j + 1);
  const d = groundY(land, i + 1, j + 1);
  // Triangles (a, cc, b) and (b, cc, d): the first holds u + v <= 1.
  if (u + v <= 1) return a + u * (b - a) + v * (cc - a);
  return cc + b - d + (d - cc) * u + (d - b) * v;
}

function ground(land: Countryside, colours: StyleColours, inKeepOut: (c: number, r: number) => boolean): Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const relief = Math.max(land.settings.relief, 1e-6);
  for (let j = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++) {
      const c = i - RADIUS;
      const r = j - RADIUS;
      const height = land.heightAt(c, r);
      const y = inKeepOut(c, r) ? 0 : groundY(land, c, r);
      positions.push(c * CELL, y, r * CELL);
      const c3 = mixed(colours.field, colours.hill, Math.min(1, height / relief));
      colors.push(c3.r, c3.g, c3.b);
    }
  }
  for (let j = 0; j < SIDE - 1; j++) {
    for (let i = 0; i < SIDE - 1; i++) {
      const a = j * SIDE + i;
      const b = a + 1;
      const c = a + SIDE;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return new Mesh(buildGeometry(positions, colors, indices), material());
}

/** Water or a bank: one ribbon along each river's centre line. */
function ribbons(land: Countryside, half: number, lift: number, swatch: Swatch, followGround: boolean): Mesh {
  const soup = new Soup();
  const colour = toColor(swatch);
  // Each edge of a ribbon sits at its own height: the ground beside it, or the water level.
  const edgeY = (col: number, row: number) => (followGround ? Math.max(0, land.heightAt(col, row)) + GROUND_Y : 0) + lift;
  for (const river of land.rivers) {
    soup.ribbon(river.polyline(-RADIUS, RADIUS, 1), half, edgeY, colour);
  }
  return new Mesh(soup.geometry(), material());
}

/** Field cells: flat quads following the ground, each with a little lightness jitter for the patchwork. */
function fields(
  land: Countryside,
  colours: StyleColours,
  seed: number,
  inKeepOut: (c: number, r: number) => boolean,
  fadeAt: (c: number, r: number) => number,
): Mesh {
  const soup = new Soup();
  for (let r = -RADIUS; r < RADIUS; r++) {
    for (let c = -RADIUS; c < RADIUS; c++) {
      if (inKeepOut(c, r) || land.coverAt(c, r) !== "field" || fadeAt(c, r) < 0.5) continue;
      const jitter = (unit(seed, 9, c, r) - 0.5) * 0.08;
      const colour = toColor(colours.field, jitter);
      // A cell is centred on its integer coordinates, so its quad spans half a cell either side.
      const corners: [number, number][] = [
        [c - 0.5, r - 0.5],
        [c + 0.5, r - 0.5],
        [c - 0.5, r + 0.5],
        [c + 0.5, r + 0.5],
      ];
      soup.quad(
        corners.map(([x, z]) => [x, land.heightAt(x, z), z] as [number, number, number]),
        FIELD_Y,
        colour,
      );
    }
  }
  return new Mesh(soup.geometry(), material());
}

/** Forest cells as low-poly cones, instanced: one draw call for every tree. */
function trees(
  land: Countryside,
  colours: StyleColours,
  seed: number,
  inKeepOut: (c: number, r: number) => boolean,
  fadeAt: (c: number, r: number) => number,
  thinning: ThinningUniforms,
): InstancedMesh {
  const cone = new ConeGeometry(0.5, 1.4, 5);
  cone.translate(0, 0.7, 0);
  const mesh = new InstancedMesh(cone, thinningMaterial(thinning), MAX_TREES);
  const roll = new Float32Array(MAX_TREES);
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const rotation = new Quaternion();
  let count = 0;
  for (let r = -RADIUS; r < RADIUS && count < MAX_TREES; r++) {
    for (let c = -RADIUS; c < RADIUS && count < MAX_TREES; c++) {
      if (inKeepOut(c, r) || land.coverAt(c, r) !== "forest") continue;
      const fade = fadeAt(c, r);
      if (fade < 0.05) continue;
      for (let k = 0; k < TREES_PER_FOREST_CELL && count < MAX_TREES; k++) {
        const x = unit(seed, 10, c, r * 4 + k * 2);
        const z = unit(seed, 10, c, r * 4 + k * 2 + 1);
        const s = (0.8 + 0.5 * unit(seed, 11, c, r * 4 + k)) * fade;
        // Trees sit inside the cell: its centre plus or minus 0.3 cells.
        position.set((c - 0.3 + 0.6 * x) * CELL, GROUND_Y + land.heightAt(c, r), (r - 0.3 + 0.6 * z) * CELL);
        scale.set(s * CELL, s * CELL, s * CELL);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(count, matrix);
        mesh.setColorAt(count, toColor(colours.forest, (unit(seed, 12, c, r * 4 + k) - 0.5) * 0.06));
        // The tree's fixed roll: at a distance only the trees with a low roll stay (see `sceneryKept`).
        roll[count] = unit(seed, 14, c, r * 4 + k);
        count++;
      }
    }
  }
  mesh.geometry.setAttribute("aRoll", new InstancedBufferAttribute(roll, 1));
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/**
 * Trees thin with distance on the GPU: a tree is dropped when its roll is at or above the share kept at its
 * distance from the camera. This is `sceneryKept` (lod.ts) evaluated per vertex, so it stays in step with it.
 */
function thinningMaterial(thinning: ThinningUniforms): MeshLambertMaterial {
  const m = material();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, thinning);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute float aRoll;\nuniform float uSceneryFar;\nuniform float uSceneryFloor;`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        float thinning = clamp(-(modelViewMatrix * instanceMatrix * vec4(transformed, 1.0)).z / uSceneryFar, 0.0, 1.0);
        float kept = 1.0 - (1.0 - uSceneryFloor) * thinning;
        if (aRoll >= kept) transformed = vec3(0.0);`,
      );
  };
  return m;
}

/** Mountains: instanced cones, snowless, rising only beyond the mountain start. */
function mountains(land: Countryside, colours: StyleColours, seed: number): InstancedMesh {
  const cells: { c: number; r: number; h: number }[] = [];
  for (let r = -RADIUS; r <= RADIUS; r += 2) {
    for (let c = -RADIUS; c <= RADIUS; c += 2) {
      const h = land.mountainAt(c, r);
      if (h > 0.5) cells.push({ c, r, h: Math.min(h, MOUNTAIN_MAX) });
    }
  }
  const cone = new ConeGeometry(1, 1, 6);
  cone.translate(0, 0.5, 0);
  const mesh = new InstancedMesh(cone, material(), Math.max(1, cells.length));
  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const rotation = new Quaternion();
  cells.forEach(({ c, r, h }, i) => {
    position.set(c * CELL, 0, r * CELL);
    scale.set(CELL * 2.5, h, CELL * 2.5);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, toColor(colours.mountain, (unit(seed, 13, c, r) - 0.5) * 0.06));
  });
  mesh.count = cells.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/** Accumulates vertices, colours and triangles for one merged mesh. */
class Soup {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  /** A strip along a centre line, `half` cells to each side. */
  ribbon(line: Point[], half: number, edgeY: (col: number, row: number) => number, colour: Color): void {
    const base = this.positions.length / 3;
    for (const p of line) {
      const near = edgeY(p.col, p.row - half);
      const far = edgeY(p.col, p.row + half);
      this.positions.push(p.col * CELL, near, (p.row - half) * CELL, p.col * CELL, far, (p.row + half) * CELL);
      this.colors.push(colour.r, colour.g, colour.b, colour.r, colour.g, colour.b);
    }
    for (let k = 0; k < line.length - 1; k++) {
      const a = base + 2 * k;
      const b = a + 2;
      this.indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  /** A quad given as [col, height, row] corners in the order: top-left, top-right, bottom-left, bottom-right. */
  quad(corners: [number, number, number][], lift: number, colour: Color): void {
    const base = this.positions.length / 3;
    for (const [c, h, r] of corners) {
      this.positions.push(c * CELL, h + lift, r * CELL);
      this.colors.push(colour.r, colour.g, colour.b);
    }
    this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  geometry(): BufferGeometry {
    return buildGeometry(this.positions, this.colors, this.indices);
  }
}

function buildGeometry(positions: number[], colors: number[], indices: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function material(): MeshLambertMaterial {
  return new MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

function toColor(swatch: Swatch, lightnessShift = 0): Color {
  const lightness = Math.min(1, Math.max(0, swatch.lightness + lightnessShift));
  return new Color().setHSL(swatch.hue / 360, swatch.saturation, lightness);
}

function mixed(a: Swatch, b: Swatch, t: number): Color {
  const from = toColor(a);
  const to = toColor(b);
  return from.lerp(to, t);
}
