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
import type { Countryside } from "../shared/countryside.js";
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
 * draws as a mass beyond `massFar`. The owners are read from the timeline, which fills in as chunks load.
 */
export class BlockLayer {
  readonly paving: Mesh;
  readonly masses: InstancedMesh;
  private readonly centres: Spot[];
  private readonly heights: number[];
  private readonly positions: Float32BufferAttribute;
  private readonly colours: Float32BufferAttribute;
  private readonly shown: Uint8Array;
  private readonly massVisible: Uint8Array;
  private readonly lastHex: Int32Array;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly matrix = new Matrix4();

  constructor(
    scene: Scene,
    private readonly blocks: readonly BlockInput[],
    land: Countryside,
    private readonly owners: Map<number, OwnerSegment[]>,
    private readonly colourOf: (district: number) => Color | undefined,
  ) {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    this.centres = blocks.map((b) => blockSpot(b.x, b.z));
    this.heights = blocks.map((b) => land.heightAt(Math.round(b.x), Math.round(b.z)) + PAVING_LIFT);
    blocks.forEach((block, i) => {
      const y = this.heights[i]!;
      const base = positions.length / 3;
      for (const corner of blockCorners(block.x, block.z)) positions.push(corner.x, y, corner.z);
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

    const size = BLOCK_WORLD - 2 * STREET_HALF;
    const mass = new BoxGeometry(size, MASS_HEIGHT, size).translate(0, MASS_HEIGHT / 2, 0);
    this.masses = new InstancedMesh(mass, new MeshLambertMaterial({ flatShading: true }), Math.max(1, blocks.length));
    this.masses.frustumCulled = false;
    this.shown = new Uint8Array(blocks.length);
    this.massVisible = new Uint8Array(blocks.length);
    this.lastHex = new Int32Array(blocks.length).fill(-1);
    this.masses.count = blocks.length;
    blocks.forEach((_, i) => this.placeMass(i, 0));
    this.masses.instanceMatrix.needsUpdate = true;
    scene.add(this.paving, this.masses);
    this.applyPositions(new Array(blocks.length).fill(false));
  }

  /**
   * Shows every Block at time `t` (in commits) for a camera at `camera`: claimed Blocks are drawn with their paving
   * at the colour of their owner, and the far ones as masses. `duration` is the transition length in commits.
   */
  update(t: number, duration: number, camera: Vector3, massFar: number): void {
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
      if (!isClaimed) {
        if (this.massVisible[i]) {
          this.massVisible[i] = 0;
          this.placeMass(i, 0);
          massChanged = true;
        }
        return;
      }
      const colour = pavingAt(this.owners.get(i), t, duration, this.colourOf);
      const hex = colour.getHex();
      if (hex !== this.lastHex[i]) {
        this.lastHex[i] = hex;
        this.writeColour(i, colour);
        this.masses.setColorAt(i, colour.clone().multiplyScalar(0.9));
        colourChanged = true;
      }
      const c = this.centres[i]!;
      const far = massShown(Math.hypot(c.x - camera.x, c.z - camera.z), massFar) ? 1 : 0;
      if (far !== this.massVisible[i]) {
        this.massVisible[i] = far;
        this.placeMass(i, far);
        massChanged = true;
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
        array[at + 1] = this.heights[i]!;
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

  private placeMass(i: number, shown: number) {
    const c = this.centres[i]!;
    this.position.set(c.x, this.heights[i]!, c.z);
    this.scale.setScalar(shown);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.masses.setMatrixAt(i, this.matrix);
  }
}
