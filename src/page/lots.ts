/**
 * Where things stand on the ground: Lots inside their Blocks, and the Blocks on the Block grid.
 * The layout (in the CLI) decides every position in Block widths; this module only turns those into world units.
 */

/** World units per Block width. A Block is one cell of the Countryside grid, so the two line up. */
export const BLOCK_WORLD = 6;
/** Unit slots per Block: rows by columns (SPEC §6: 2 × 4 Lots). Slots run row by row, as the layout numbers them. */
export const SLOT_ROWS = 2;
export const SLOT_COLUMNS = 4;

export interface Spot {
  x: number;
  z: number;
}

/** The centre of one unit slot, relative to the centre of its Block, in world units. */
export function slotSpot(slot: number): Spot {
  const row = Math.floor(slot / SLOT_COLUMNS);
  const column = slot % SLOT_COLUMNS;
  return {
    x: (column - (SLOT_COLUMNS - 1) / 2) * (BLOCK_WORLD / SLOT_COLUMNS),
    z: (row - (SLOT_ROWS - 1) / 2) * (BLOCK_WORLD / SLOT_ROWS),
  };
}

/** The centre of a Lot that runs `slots` unit slots from `slot`, relative to its Block's centre. */
export function lotSpot(slot: number, slots: number): Spot {
  let x = 0;
  let z = 0;
  const count = Math.max(1, slots);
  for (let i = 0; i < count; i++) {
    const spot = slotSpot(slot + i);
    x += spot.x;
    z += spot.z;
  }
  return { x: x / count, z: z / count };
}

/** A Block's centre in world units, from its position in Block widths. */
export function blockSpot(x: number, z: number): Spot {
  return { x: x * BLOCK_WORLD, z: z * BLOCK_WORLD };
}

/** The layout columns of the world file that placement needs. */
export interface LotTable {
  blocks: { x: ArrayLike<number>; z: ArrayLike<number> };
  lots: { file: ArrayLike<number>; block: ArrayLike<number>; slot: ArrayLike<number>; slots: ArrayLike<number> };
}

/**
 * Where each file stands: on its last Lot, which is where it stands now (a relocated Building has a
 * record per Lot it has held). A file with no Lot has no spot, and the caller keeps it out of sight.
 */
export function placeFiles(table: LotTable, fileCount: number): (file: number) => Spot | undefined {
  const lotOf = new Int32Array(fileCount).fill(-1);
  for (let i = 0; i < table.lots.file.length; i++) {
    const file = table.lots.file[i]!;
    if (file < fileCount) lotOf[file] = i;
  }
  return (file) => {
    const lot = lotOf[file];
    if (lot === undefined || lot < 0) return undefined;
    const block = table.lots.block[lot]!;
    const origin = blockSpot(table.blocks.x[block]!, table.blocks.z[block]!);
    const within = lotSpot(table.lots.slot[lot]!, table.lots.slots[lot]!);
    return { x: origin.x + within.x, z: origin.z + within.z };
  };
}

/**
 * The width of the City's ground in world units: every village and Block, with a Block to spare on each side.
 * Never narrower than four Blocks, so an empty City still has room to frame.
 */
export function cityExtent(table: { blocks: { x: ArrayLike<number>; z: ArrayLike<number> }; villages: { x: ArrayLike<number>; z: ArrayLike<number> } }): number {
  let reach = 0;
  for (const set of [table.blocks, table.villages]) {
    for (let i = 0; i < set.x.length; i++) reach = Math.max(reach, Math.abs(set.x[i]!), Math.abs(set.z[i]!));
  }
  return Math.max(4 * BLOCK_WORLD, 2 * (reach * BLOCK_WORLD + BLOCK_WORLD));
}
