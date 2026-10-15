import { Color, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { BlockLayer, blockCorners, blockPaving, massShown, pavingAt, pavingColour, STREET_HALF } from "../src/page/blocks.js";
import { BLOCK_WORLD } from "../src/page/lots.js";
import { mixColour, type MassBox } from "../src/page/buildings.js";
import type { OwnerSegment } from "../src/page/state.js";
import { type DistrictPlace, NAME_SOURCES } from "../src/shared/places.js";

const district = (hue: number): DistrictPlace => ({
  id: 0,
  name: "Ashford Keep",
  source: NAME_SOURCES.indexOf("generated"),
  generated: "Ashford Keep",
  colour: { hue, saturation: 0.4, lightness: { light: 0.6, dark: 0.35 } },
  anchor: { col: 0, row: 0 },
  neighbourhoods: [],
});

describe("blockCorners", () => {
  it("insets the paving from the Block's edges, so the streets show between Blocks", () => {
    const corners = blockCorners(2, -1);
    const half = BLOCK_WORLD / 2 - STREET_HALF;
    const centre = { x: 2 * BLOCK_WORLD, z: -1 * BLOCK_WORLD };
    expect(corners[0]).toEqual({ x: centre.x - half, z: centre.z - half });
    expect(corners[3]).toEqual({ x: centre.x + half, z: centre.z + half });
    expect(corners[3]!.x - corners[0]!.x).toBeCloseTo(BLOCK_WORLD - 2 * STREET_HALF);
  });
});

describe("paving colour", () => {
  it("takes the owning District's hue and the lightness of the page theme", () => {
    const light = pavingColour(district(200).colour, "light");
    const dark = pavingColour(district(200).colour, "dark");
    expect(light.getHSL({ h: 0, s: 0, l: 0 }).l).toBeCloseTo(0.6, 2);
    expect(dark.getHSL({ h: 0, s: 0, l: 0 }).l).toBeCloseTo(0.35, 2);
  });

  it("paves a Block with no District in stone", () => {
    const stone = blockPaving(99, [district(200)], "light");
    const other = blockPaving(0, [district(200)], "light");
    expect(stone.getHex()).not.toBe(other.getHex());
  });

  it("paves each Block in its owner's colour, and two Districts' Blocks differently", () => {
    const places = [district(20), district(230)];
    expect(blockPaving(0, places, "light").getHex()).not.toBe(blockPaving(1, places, "light").getHex());
  });
});

describe("pavingAt", () => {
  const colours = new Map<number, Color>([
    [0, new Color(1, 0, 0)],
    [1, new Color(0, 0, 1)],
    [-1, new Color(0.5, 0.5, 0.5)],
  ]);
  const colourOf = (d: number) => colours.get(d);

  it("is stone before the Block has an owner", () => {
    expect(pavingAt(undefined, 10, 4, colourOf).getHex()).toBe(new Color(0.5, 0.5, 0.5).getHex());
  });

  it("paints a newly claimed Block in its owner's colour at once", () => {
    const segments: OwnerSegment[] = [{ start: 5, owner: 0, from: -1 }];
    expect(pavingAt(segments, 5, 4, colourOf).getHex()).toBe(new Color(1, 0, 0).getHex());
  });

  it("eases a split's recolour from the parent's colour to the new owner's over D commits", () => {
    const segments: OwnerSegment[] = [
      { start: 0, owner: 0, from: -1 },
      { start: 20, owner: 1, from: 0 },
    ];
    const half = pavingAt(segments, 20 + 2, 4, colourOf); // halfway through the ease (D = 4 commits, eased)
    expect(half.r).toBeGreaterThan(0);
    expect(half.r).toBeLessThan(1);
    expect(pavingAt(segments, 20 + 4, 4, colourOf).getHex()).toBe(new Color(0, 0, 1).getHex());
    expect(pavingAt(segments, 19, 4, colourOf).getHex()).toBe(new Color(1, 0, 0).getHex());
  });
});

describe("massShown", () => {
  it("draws a Block as a simple mass only beyond the far distance", () => {
    expect(massShown(100, 160)).toBe(false);
    expect(massShown(200, 160)).toBe(true);
  });
});

describe("mixColour", () => {
  it("blends two colours channel by channel", () => {
    expect(mixColour(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mixColour(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mixColour(0x000000, 0x0000ff, 0.5)).toBe(0x000080);
  });
});

describe("BlockLayer", () => {
  const blocks = [
    { x: 0, z: 0, claimed: 0 },
    { x: 1, z: 0, claimed: 0 },
    { x: 0, z: 1, claimed: 50 },
  ];
  const owners = new Map<number, OwnerSegment[]>([
    [0, [{ start: 0, owner: 0, from: -1 }]],
    [1, [{ start: 0, owner: 1, from: -1 }]],
    [2, [{ start: 50, owner: 0, from: -1 }]],
  ]);
  const colourOf = (d: number) => (d < 0 ? new Color(0.5, 0.5, 0.5) : new Color(d === 0 ? 1 : 0, 0, d === 1 ? 1 : 0));
  const flat = () => 0;
  const box: MassBox = { minX: -1, maxX: 1, minZ: -2, maxZ: 2, baseY: 0.5, topY: 6 };

  it("draws every Block's paving in one mesh, four corners and two triangles each", () => {
    const scene = new Scene();
    const layer = new BlockLayer(scene, blocks, flat, owners, colourOf);
    expect(layer.paving.geometry.getAttribute("position").count).toBe(blocks.length * 4);
    expect(layer.paving.geometry.getIndex()!.count).toBe(blocks.length * 6);
    expect(scene.children).toContain(layer.paving);
  });

  it("hides a Block before its claim, and paves it from the claim on", () => {
    const layer = new BlockLayer(new Scene(), blocks, flat, owners, colourOf);
    const corner = () => layer.paving.geometry.getAttribute("position").getX(2 * 4);
    layer.update(10, 4, new Vector3(0, 0, 0), 1000);
    expect(corner()).toBeCloseTo(0); // the third Block is collapsed onto its centre
    layer.update(60, 4, new Vector3(0, 0, 0), 1000);
    expect(corner()).not.toBeCloseTo(0);
  });

  it("lays each paving corner on the ground under it", () => {
    const slope = (x: number) => 0.25 * x;
    const layer = new BlockLayer(new Scene(), [blocks[0]!], slope, owners, colourOf);
    layer.update(10, 4, new Vector3(0, 0, 0), 1000);
    const position = layer.paving.geometry.getAttribute("position");
    for (let k = 0; k < 4; k++) {
      const x = position.getX(k);
      expect(position.getY(k)).toBeCloseTo(slope(x) + 0.05);
    }
  });

  it("draws a far Block as the mass of its standing Buildings, and hides it when the camera comes near", () => {
    const layer = new BlockLayer(new Scene(), blocks, flat, owners, colourOf);
    const scale = (i: number) => {
      const m = layer.masses.instanceMatrix.array;
      return Math.hypot(m[i * 16]!, m[i * 16 + 1]!, m[i * 16 + 2]!);
    };
    const boxes = [box, undefined, undefined];
    layer.update(100, 4, new Vector3(0, 0, 0), 100, boxes);
    expect(scale(0)).toBe(0);
    layer.update(100, 4, new Vector3(500, 0, 0), 100, boxes);
    expect(scale(0)).toBeGreaterThan(0);
    layer.update(100, 4, new Vector3(0, 0, 0), 100, boxes);
    expect(scale(0)).toBe(0);
  });

  it("stretches the mass to the box exactly: its footprint, its base and its top", () => {
    const layer = new BlockLayer(new Scene(), blocks, flat, owners, colourOf);
    layer.update(100, 4, new Vector3(500, 0, 0), 100, [box, undefined, undefined]);
    const m = layer.masses.instanceMatrix.array;
    // Columns of the instance matrix: scale on the diagonal, translation in the fourth column.
    const sx = m[0]!;
    const sy = m[5]!;
    const sz = m[10]!;
    expect(sx).toBeCloseTo(box.maxX - box.minX);
    expect(sz).toBeCloseTo(box.maxZ - box.minZ);
    expect(sy).toBeCloseTo(box.topY - box.baseY);
    expect(m[12]).toBeCloseTo((box.minX + box.maxX) / 2);
    expect(m[13]).toBeCloseTo(box.baseY);
    expect(m[14]).toBeCloseTo((box.minZ + box.maxZ) / 2);
  });
});
