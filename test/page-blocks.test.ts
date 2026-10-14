import { Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { BlockLayer, blockCorners, blockPaving, massShown, pavingColour, STREET_HALF } from "../src/page/blocks.js";
import { countryside } from "../src/shared/countryside.js";
import { type DistrictPlace, NAME_SOURCES } from "../src/shared/places.js";
import { BLOCK_WORLD } from "../src/page/lots.js";
import { mixColour } from "../src/page/buildings.js";

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
    { x: 0, z: 0, district: 0 },
    { x: 1, z: 0, district: 1 },
    { x: 0, z: 1, district: 9 },
  ];

  it("draws every Block's paving in one mesh, four corners and two triangles each", () => {
    const scene = new Scene();
    const layer = new BlockLayer(scene, blocks, countryside(3), [district(20), district(230)], "light");
    expect(layer.paving.geometry.getAttribute("position").count).toBe(blocks.length * 4);
    expect(layer.paving.geometry.getIndex()!.count).toBe(blocks.length * 6);
    expect(scene.children).toContain(layer.paving);
  });

  it("shows far Blocks as masses, and hides them again when the camera comes near", () => {
    const layer = new BlockLayer(new Scene(), blocks, countryside(3), undefined, "dark");
    const scale = (i: number) => {
      const m = layer.masses.instanceMatrix.array;
      return Math.hypot(m[i * 16]!, m[i * 16 + 1]!, m[i * 16 + 2]!);
    };
    layer.update(new Vector3(0, 0, 0), 100);
    expect(scale(0)).toBe(0);
    layer.update(new Vector3(500, 0, 0), 100);
    expect(scale(0)).toBeGreaterThan(0);
    layer.update(new Vector3(0, 0, 0), 100);
    expect(scale(0)).toBe(0);
  });
});
