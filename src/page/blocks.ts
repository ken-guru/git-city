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

export interface BlockInput {
  x: number;
  z: number;
  /** Position of the owning District in the places file, or a value past the end when there is none. */
  district: number;
}

/**
 * The Blocks on the page: one merged mesh for all the paving (one draw call), and one instanced mesh for the far
 * masses, which stand at scale zero until a Block is far enough from the camera to draw as a mass.
 */
export class BlockLayer {
  readonly paving: Mesh;
  readonly masses: InstancedMesh;
  private readonly centres: Spot[];
  private readonly heights: number[];
  private readonly shown: Uint8Array;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly matrix = new Matrix4();

  constructor(scene: Scene, blocks: readonly BlockInput[], land: Countryside, places: readonly DistrictPlace[] | undefined, theme: "light" | "dark") {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    this.centres = blocks.map((b) => blockSpot(b.x, b.z));
    this.heights = blocks.map((b) => land.heightAt(Math.round(b.x), Math.round(b.z)) + PAVING_LIFT);
    blocks.forEach((block, i) => {
      const colour = blockPaving(block.district, places, theme);
      const y = this.heights[i]!;
      const base = positions.length / 3;
      for (const corner of blockCorners(block.x, block.z)) positions.push(corner.x, y, corner.z);
      for (let k = 0; k < 4; k++) colors.push(colour.r, colour.g, colour.b);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.paving = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.paving.frustumCulled = false;

    const size = BLOCK_WORLD - 2 * STREET_HALF;
    const mass = new BoxGeometry(size, MASS_HEIGHT, size).translate(0, MASS_HEIGHT / 2, 0);
    this.masses = new InstancedMesh(mass, new MeshLambertMaterial({ flatShading: true }), Math.max(1, blocks.length));
    this.masses.frustumCulled = false;
    this.shown = new Uint8Array(blocks.length);
    blocks.forEach((block, i) => {
      this.masses.setColorAt(i, blockPaving(block.district, places, theme).clone().multiplyScalar(0.9));
      this.place(i, 0);
    });
    this.masses.count = blocks.length;
    this.masses.instanceMatrix.needsUpdate = true;
    if (this.masses.instanceColor) this.masses.instanceColor.needsUpdate = true;
    scene.add(this.paving, this.masses);
  }

  /** Shows the far masses of Blocks beyond `massFar` from the camera, and hides the rest. */
  update(camera: Vector3, massFar: number): void {
    let changed = false;
    this.centres.forEach((c, i) => {
      const distance = Math.hypot(c.x - camera.x, this.heights[i]! - camera.y, c.z - camera.z);
      const show = massShown(distance, massFar) ? 1 : 0;
      if (show === this.shown[i]) return;
      this.shown[i] = show;
      this.place(i, show);
      changed = true;
    });
    if (changed) this.masses.instanceMatrix.needsUpdate = true;
  }

  private place(i: number, shown: number) {
    const c = this.centres[i]!;
    this.position.set(c.x, this.heights[i]!, c.z);
    this.scale.setScalar(shown);
    this.matrix.compose(this.position, this.rotation, this.scale);
    this.masses.setMatrixAt(i, this.matrix);
  }
}
