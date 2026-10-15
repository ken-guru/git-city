import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  type Scene,
  Vector3,
} from "three";
import type { MassBox } from "./buildings.js";
import type { DistrictPlace, PavingColour } from "../shared/places.js";
import { BLOCK_WORLD, blockSpot, type Spot } from "./lots.js";
import { type OwnerSegment, latestAt, easeOutCubic } from "./state.js";

/** Half the width of the street between two neighbouring Blocks, in world units. Paving stops this far inside its Block. */
export const STREET_HALF = 0.5;
/** Height of a far Block's simple mass, in world units. */
export const MASS_HEIGHT = 0.9;
/** Height of the paving above the ground, so it clears the fields. */
const PAVING_LIFT = 0.05;
/** A Block whose owner is no District is paved in stone. */
const STONE: PavingColour = { hue: 40, saturation: 0.08, lightness: { light: 0.6, dark: 0.36 } };

/** The paving colour of one District on a page theme. */
export function pavingColour(colour: PavingColour, theme: "light" | "dark"): Color {
  return new Color().setHSL(colour.hue / 360, colour.saturation, colour.lightness[theme]);
}

/** The paving colour of a Block: its owning District's, or stone when `district` names no District. */
export function blockPaving(district: number, places: readonly DistrictPlace[] | undefined, theme: "light" | "dark"): Color {
  const place = places?.[district];
  return pavingColour(place ? place.colour : STONE, theme);
}

/** A Block's paving corners in world units, inset from its edges so the streets show between Blocks. Order: top-left, top-right, bottom-left, bottom-right. */
export function blockCorners(x: number, z: number): Spot[] {
  const centre = blockSpot(x, z);
  const half = BLOCK_WORLD / 2 - STREET_HALF;
  return [
    { x: centre.x - half, z: centre.z - half },
    { x: centre.x + half, z: centre.z - half },
    { x: centre.x - half, z: centre.z + half },
    { x: centre.x + half, z: centre.z + half },
  ];
}

/** Whether a Block's far mass is shown from a camera at `distance`: beyond `massFar`, Blocks draw as simple masses. */
export function massShown(distance: number, massFar: number): boolean {
  return distance > massFar;
}

/**
 * The paving colour of a Block at `t`: it eases from its previous owner's colour to its owner's over `duration`
 * commits, and a Block with no owner yet is stone. `colourOf` gives a District's paving colour by birth index.
 */
export function pavingAt(segments: readonly OwnerSegment[] | undefined, t: number, duration: number, colourOf: (district: number) => Color | undefined): Color {
  const stone = colourOf(-1) ?? new Color();
  const segment = segments ? latestAt(segments, t) : undefined;
  if (!segment) return stone;
  const to = colourOf(segment.owner) ?? stone;
  const from = segment.from >= 0 ? (colourOf(segment.from) ?? to) : to;
  const share = easeOutCubic(Math.min(1, Math.max(0, (t - segment.start) / duration)));
  return new Color().lerpColors(from, to, share);
}

export interface BlockInput {
  x: number;
  z: number;
  /** The commit that claimed the Block: it is not drawn before then. */
  claimed: number;
}

/**
 * The Blocks on the page: one merged mesh for all the paving (one draw call), and one instanced mesh for the far
 * masses. A Block appears at its claim, its paving eases when its owner changes (a District split or merge), and it
 * draws as a mass beyond `massFar`. The mass is the box the Block's standing Buildings give (see `MassBox`), so it
 * takes over from them without a pop. The paving sits on the drawn ground at each corner.
 */
export class BlockLayer {
  readonly paving: Mesh;
  readonly masses: InstancedMesh;
  private readonly centres: Spot[];
  /** Per Block: the paving's height at each corner, and at its centre (where unclaimed corners collapse). */
  private readonly cornerY: Float64Array;
  private readonly centreY: Float64Array;
  private readonly positions: Float32BufferAttribute;
  private readonly colours: Float32BufferAttribute;
  private readonly shown: Uint8Array;
  private readonly massVisible: Uint8Array;
  private readonly lastHex: Int32Array;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();

  constructor(
    scene: Scene,
    private readonly blocks: readonly BlockInput[],
    surface: (x: number, z: number) => number,
    private readonly owners: Map<number, OwnerSegment[]>,
    private readonly colourOf: (district: number) => Color | undefined,
  ) {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    this.centres = blocks.map((b) => blockSpot(b.x, b.z));
    this.centreY = Float64Array.from(this.centres, (c) => surface(c.x, c.z) + PAVING_LIFT);
    this.cornerY = new Float64Array(blocks.length * 4);
    blocks.forEach((block, i) => {
      const base = positions.length / 3;
      blockCorners(block.x, block.z).forEach((corner, k) => {
        const y = surface(corner.x, corner.z) + PAVING_LIFT;
        this.cornerY[i * 4 + k] = y;
        positions.push(corner.x, y, corner.z);
      });
      for (let k = 0; k < 4; k++) colors.push(0, 0, 0);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    });
    const geometry = new BufferGeometry();
    this.positions = new Float32BufferAttribute(positions, 3);
    this.colours = new Float32BufferAttribute(colors, 3);
    geometry.setAttribute("position", this.positions);
    geometry.setAttribute("color", this.colours);
    geometry.setIndex(indices);
    this.paving = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.paving.frustumCulled = false;

    // A unit box standing on its base; each Block's instance is stretched to its mass box.
    const mass = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.masses = new InstancedMesh(mass, new MeshLambertMaterial({ flatShading: true }), Math.max(1, blocks.length));
    this.masses.frustumCulled = false;
    this.shown = new Uint8Array(blocks.length);
    this.massVisible = new Uint8Array(blocks.length);
    this.lastHex = new Int32Array(blocks.length).fill(-1);
    this.masses.count = blocks.length;
    blocks.forEach((_, i) => this.placeMass(i, undefined));
    this.masses.instanceMatrix.needsUpdate = true;
    scene.add(this.paving, this.masses);
    this.applyPositions(new Array(blocks.length).fill(false));
  }

  /**
   * Shows every Block at time `t` (in commits) for a camera at `camera`: claimed Blocks are drawn with their paving
   * at the colour of their owner, and the far ones as their masses, from `boxes` (the Buildings' boxes, by Block).
   * `duration` is the transition length in commits.
   */
  update(t: number, duration: number, camera: Vector3, massFar: number, boxes: readonly (MassBox | undefined)[] = []): void {
    const claimed: boolean[] = [];
    let colourChanged = false;
    let massChanged = false;
    this.blocks.forEach((block, i) => {
      const isClaimed = t >= block.claimed;
      claimed[i] = isClaimed;
      if (isClaimed !== Boolean(this.shown[i])) {
        this.shown[i] = isClaimed ? 1 : 0;
        this.applyPositions(claimed, i);
      }
      const c = this.centres[i]!;
      const far = isClaimed && massShown(Math.hypot(c.x - camera.x, c.z - camera.z), massFar);
      const box = far ? boxes[i] : undefined;
      if (box !== undefined || this.massVisible[i]) {
        this.massVisible[i] = box !== undefined ? 1 : 0;
        this.placeMass(i, box);
        massChanged = true;
      }
      if (!isClaimed) return;
      const colour = pavingAt(this.owners.get(i), t, duration, this.colourOf);
      const hex = colour.getHex();
      if (hex !== this.lastHex[i]) {
        this.lastHex[i] = hex;
        this.writeColour(i, colour);
        this.masses.setColorAt(i, colour.clone().multiplyScalar(0.9));
        colourChanged = true;
      }
    });
    if (colourChanged) {
      this.colours.needsUpdate = true;
      if (this.masses.instanceColor) this.masses.instanceColor.needsUpdate = true;
    }
    if (massChanged) this.masses.instanceMatrix.needsUpdate = true;
  }

  /** Collapses the corners of a Block that is not claimed yet onto its centre (or restores them), and flags the buffer. */
  private applyPositions(claimed: boolean[], only?: number): void {
    const array = this.positions.array as Float32Array;
    const indices = only === undefined ? this.blocks.map((_, i) => i) : [only];
    for (const i of indices) {
      const c = this.centres[i]!;
      const block = this.blocks[i]!;
      const corners = blockCorners(block.x, block.z);
      const shown = claimed[i] ?? false;
      for (let k = 0; k < 4; k++) {
        const at = (i * 4 + k) * 3;
        array[at] = shown ? corners[k]!.x : c.x;
        array[at + 1] = shown ? this.cornerY[i * 4 + k]! : this.centreY[i]!;
        array[at + 2] = shown ? corners[k]!.z : c.z;
      }
    }
    this.positions.needsUpdate = true;
  }

  private writeColour(i: number, colour: Color): void {
    const array = this.colours.array as Float32Array;
    for (let k = 0; k < 4; k++) {
      const at = (i * 4 + k) * 3;
      array[at] = colour.r;
      array[at + 1] = colour.g;
      array[at + 2] = colour.b;
    }
  }

  /** Stretches a Block's mass to its box, or hides it (scale zero) when there is no box to show. */
  private placeMass(i: number, box: MassBox | undefined) {
    if (box === undefined) {
      this.matrix.makeScale(0, 0, 0);
      this.masses.setMatrixAt(i, this.matrix);
      return;
    }
    this.position.set((box.minX + box.maxX) / 2, box.baseY, (box.minZ + box.maxZ) / 2);
    this.scale.set(box.maxX - box.minX, box.topY - box.baseY, box.maxZ - box.minZ);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.masses.setMatrixAt(i, this.matrix);
  }
}
