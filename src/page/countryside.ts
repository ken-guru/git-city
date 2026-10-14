import {
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
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
}

/**
 * Adds the Countryside to the scene in six draw calls: ground, water, river banks, fields, trees (instanced)
 * and mountains (instanced). Every position is a pure function of the seed, so nothing here needs data
 * from the world file beyond the seed.
 */
export function addCountryside(scene: Scene, options: CountrysideScene): void {
  const land = countryside(options.seed);
  const colours = STYLE_A[options.theme];
  const claimed = options.claimed ?? [];
  const inKeepOut = (c: number, r: number) => Math.hypot(c, r) * CELL < options.keepOut;
  const fadeAt = (c: number, r: number) => {
    if (claimed.length === 0) return 1;
    let nearest = Infinity;
    for (const p of claimed) nearest = Math.min(nearest, Math.max(Math.abs(p.col - c), Math.abs(p.row - r)));
    return sceneryFade(nearest);
  };

  scene.add(ground(land, colours, inKeepOut));
  scene.add(ribbons(land, WATER_HALF, WATER_Y, colours.water));
  scene.add(ribbons(land, BANK_HALF, BANK_Y, colours.sand));
  scene.add(fields(land, colours, options.seed, inKeepOut, fadeAt));
  scene.add(trees(land, colours, options.seed, inKeepOut, fadeAt));
  scene.add(mountains(land, colours, options.seed));
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
      const y = inKeepOut(c, r) ? 0 : land.levelAt(c, r) === "river" ? RIVER_BED_Y : GROUND_Y + height;
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
  return new Mesh(geometry(positions, colors, indices), material());
}

/** Water or a bank: one ribbon along each river's centre line. */
function ribbons(land: Countryside, half: number, y: number, swatch: Swatch): Mesh {
  const soup = new Soup();
  const colour = toColor(swatch);
  for (const river of land.rivers) {
    soup.ribbon(river.polyline(-RADIUS, RADIUS, 1), half, y, colour);
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
      soup.quad(
        [
          [c, land.heightAt(c, r), r],
          [c + 1, land.heightAt(c + 1, r), r],
          [c, land.heightAt(c, r + 1), r + 1],
          [c + 1, land.heightAt(c + 1, r + 1), r + 1],
        ],
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
): InstancedMesh {
  const geometry = new ConeGeometry(0.5, 1.4, 5);
  geometry.translate(0, 0.7, 0);
  const mesh = new InstancedMesh(geometry, material(), MAX_TREES);
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
        position.set((c + 0.2 + 0.6 * x) * CELL, GROUND_Y + land.heightAt(c, r), (r + 0.2 + 0.6 * z) * CELL);
        scale.set(s * CELL, s * CELL, s * CELL);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(count, matrix);
        mesh.setColorAt(count, toColor(colours.forest, (unit(seed, 12, c, r * 4 + k) - 0.5) * 0.06));
        count++;
      }
    }
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
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
  const geometry = new ConeGeometry(1, 1, 6);
  geometry.translate(0, 0.5, 0);
  const mesh = new InstancedMesh(geometry, material(), Math.max(1, cells.length));
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
  ribbon(line: Point[], half: number, y: number, colour: Color): void {
    const base = this.positions.length / 3;
    for (const p of line) {
      this.positions.push(p.col * CELL, y, (p.row - half) * CELL, p.col * CELL, y, (p.row + half) * CELL);
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
    return geometry(this.positions, this.colors, this.indices);
  }
}

function geometry(positions: number[], colors: number[], indices: number[]): BufferGeometry {
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
