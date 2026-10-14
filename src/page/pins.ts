import { Color, ConeGeometry, InstancedMesh, MeshLambertMaterial, Object3D, Scene } from "three";
import { type World } from "../shared/format.js";
import { FLOOR_HEIGHT, FOUNDATION_HEIGHT } from "./buildings.js";
import { type ChangeIndex, HIGHLIGHT_COMMITS, PINS_PER_COMMIT, PIN_LIFE, pinScale } from "./contributors.js";
import { placeLot } from "./lots.js";
import { displayedFloors, latestAt, type Timelines } from "./state.js";

/** A pin's place and colour, before its size is set by its age. */
export interface PinSpot {
  x: number;
  y: number;
  z: number;
  colour: number;
}

/** Height above a Building's roof where its pin hovers, in world units. */
const PIN_ABOVE_ROOF = 1.2;
/** Most pins a highlight draws, so a long quiet history cannot flood the scene. */
const HIGHLIGHT_CAPACITY = 2000;

/**
 * The pins over changed Buildings (SPEC §11): one cone per Building a recent commit changed, coloured by its author and
 * shrinking to nothing as it fades. A second set lights up one person's Buildings from the last 120 commits.
 */
export class PinLayer {
  private readonly pins: InstancedMesh;
  private readonly highlights: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly colour = new Color();

  constructor(scene: Scene) {
    const geometry = new ConeGeometry(0.35, 1.2, 6);
    // The cone's tip points down, onto the roof.
    geometry.rotateX(Math.PI);
    this.pins = new InstancedMesh(geometry, new MeshLambertMaterial({ flatShading: true }), PINS_PER_COMMIT * (PIN_LIFE + 1));
    this.highlights = new InstancedMesh(geometry, new MeshLambertMaterial({ flatShading: true }), HIGHLIGHT_CAPACITY);
    this.pins.count = 0;
    this.highlights.count = 0;
    scene.add(this.pins, this.highlights);
  }

  /** Places the pins that are visible at this moment. `spots` holds one entry per pin. */
  setPins(spots: readonly { spot: PinSpot; scale: number }[]): void {
    this.pins.count = write(this.pins, this.dummy, this.colour, spots);
  }

  /** Lights up a set of Buildings at full size, or clears the highlight when `spots` is empty. */
  setHighlight(spots: readonly PinSpot[]): void {
    this.highlights.count = write(this.highlights, this.dummy, this.colour, spots.map((spot) => ({ spot, scale: 1.4 })));
  }
}

function write(mesh: InstancedMesh, dummy: Object3D, colour: Color, items: readonly { spot: PinSpot; scale: number }[]): number {
  const count = Math.min(items.length, mesh.instanceMatrix.count);
  for (let i = 0; i < count; i++) {
    const { spot, scale } = items[i]!;
    dummy.position.set(spot.x, spot.y, spot.z);
    dummy.scale.setScalar(Math.max(scale, 0.0001));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, colour.setHex(spot.colour));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return count;
}

/**
 * Where the pin of one stint hovers at commit time `t`: over its Lot, above its roof at that moment.
 * A Stint with no segments yet hovers just above the ground.
 */
export function pinSpotOf(world: World, timelines: Timelines, stint: number, t: number, colour: number): PinSpot {
  const { x, z } = placeLot(world, world.stints.lot[stint]!);
  const segment = latestAt(timelines.buildings[stint] ?? [], t);
  const floors = segment === undefined ? 0 : displayedFloors(segment, t);
  return { x, y: FOUNDATION_HEIGHT + floors * FLOOR_HEIGHT + PIN_ABOVE_ROOF, z, colour };
}

/** The pins visible at commit time `t`: the changes of the last few commits, each fading with its age. */
export function visiblePins(
  index: ChangeIndex,
  world: World,
  timelines: Timelines,
  t: number,
  colourOfCommit: (commit: number) => number,
): { spot: PinSpot; scale: number }[] {
  const out: { spot: PinSpot; scale: number }[] = [];
  const last = Math.floor(t);
  for (let commit = Math.max(0, last - PIN_LIFE); commit <= last; commit++) {
    const scale = pinScale(t - commit);
    if (scale <= 0) continue;
    for (const stint of index.stintsAt(commit)) out.push({ spot: pinSpotOf(world, timelines, stint, t, colourOfCommit(commit)), scale });
  }
  return out;
}

/** The Buildings one person changed in the last HIGHLIGHT_COMMITS commits up to `commit`, newest first. */
export function highlightSpots(
  index: ChangeIndex,
  world: World,
  timelines: Timelines,
  commit: number,
  person: number,
  colourOf: (commit: number) => number,
  whoOf: (commit: number) => number | undefined,
): PinSpot[] {
  const spots: PinSpot[] = [];
  const seen = new Set<number>();
  for (let c = commit; c >= Math.max(0, commit - HIGHLIGHT_COMMITS) && spots.length < HIGHLIGHT_CAPACITY; c--) {
    if (whoOf(c) !== person) continue;
    for (const stint of index.stintsAt(c)) {
      if (seen.has(stint)) continue;
      seen.add(stint);
      spots.push(pinSpotOf(world, timelines, stint, commit + 1, colourOf(c)));
    }
  }
  return spots;
}
