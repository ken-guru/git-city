import { describe, expect, it } from "vitest";
import { BLOCK_WORLD, cityExtent, lotSpot, placeLot, slotSpot } from "../src/page/lots.js";

describe("slotSpot and lotSpot", () => {
  it("lays the 2 by 4 unit slots out row by row, centred on the Block", () => {
    expect(slotSpot(0)).toEqual({ x: -2.25, z: -1.5 });
    expect(slotSpot(3)).toEqual({ x: 2.25, z: -1.5 });
    expect(slotSpot(4)).toEqual({ x: -2.25, z: 1.5 });
    expect(slotSpot(7)).toEqual({ x: 2.25, z: 1.5 });
  });

  it("keeps every slot inside its Block", () => {
    for (let slot = 0; slot < 8; slot++) {
      const { x, z } = slotSpot(slot);
      expect(Math.abs(x)).toBeLessThanOrEqual(BLOCK_WORLD / 2);
      expect(Math.abs(z)).toBeLessThanOrEqual(BLOCK_WORLD / 2);
    }
  });

  it("centres a Lot that spans several slots on the middle of them", () => {
    expect(lotSpot(0, 1)).toEqual(slotSpot(0));
    const pair = lotSpot(0, 2);
    expect(pair.x).toBeCloseTo(-1.5);
    expect(pair.z).toBeCloseTo(-1.5);
  });
});

describe("placeLot", () => {
  // Block 0 at the origin, Block 1 one Block to the east. Lot 0 is slot 5 of block 0; lot 1 is slot 0 of block 1.
  const table = {
    blocks: { x: Float32Array.of(0, 1), z: Float32Array.of(0, 0) },
    lots: {
      file: Uint32Array.of(0, 1),
      block: Uint32Array.of(0, 1),
      slot: Uint8Array.of(5, 0),
      slots: Uint8Array.of(1, 1),
    },
  };

  it("puts a Lot inside its Block, at the Block's world position", () => {
    expect(placeLot(table, 0)).toEqual({ x: slotSpot(5).x, z: slotSpot(5).z });
    expect(placeLot(table, 1)).toEqual({ x: BLOCK_WORLD + slotSpot(0).x, z: slotSpot(0).z });
  });
});

describe("cityExtent", () => {
  it("covers every village and Block with a Block to spare on each side", () => {
    const extent = cityExtent({ blocks: { x: [0, -3], z: [0, 2] }, villages: { x: [0], z: [0] } });
    expect(extent).toBeCloseTo(2 * (3 * BLOCK_WORLD + BLOCK_WORLD));
  });

  it("is never narrower than four Blocks, even for an empty City", () => {
    expect(cityExtent({ blocks: { x: [], z: [] }, villages: { x: [], z: [] } })).toBe(4 * BLOCK_WORLD);
  });
});
