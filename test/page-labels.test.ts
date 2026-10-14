import { describe, expect, it } from "vitest";
import { cityTitle, isLabelVisible, labelModel } from "../src/page/labels.js";
import { type DistrictPlace, NAME_SOURCES } from "../src/shared/places.js";

const place: DistrictPlace = {
  id: 2,
  name: "Ashford Keep",
  source: NAME_SOURCES.indexOf("generated"),
  generated: "Ashford Keep",
  colour: { hue: 355, saturation: 0.5, lightness: { light: 0.5, dark: 0.3 } },
  anchor: { col: 3, row: -2 },
  neighbourhoods: [],
};

describe("isLabelVisible", () => {
  it("shows a label up to its maximum distance and hides it beyond", () => {
    expect(isLabelVisible(100, 100)).toBe(true);
    expect(isLabelVisible(100.5, 100)).toBe(false);
  });
});

describe("labelModel", () => {
  it("places the label at its anchor and colours its edge with the District colour", () => {
    const model = labelModel(place, 6);
    expect(model).toMatchObject({ name: "Ashford Keep", x: 18, z: -12 });
    expect(model.colour).toBe("hsl(355 50% 50%)");
  });

  it("takes the lightness of the page theme it is drawn on", () => {
    expect(labelModel(place, 6, "dark").colour).toBe("hsl(355 50% 30%)");
  });

  it("shows no subtitle for a Generated name, and the Generated name beneath a revealed one", () => {
    expect(labelModel(place, 6).subtitle).toBeUndefined();
    const revealed = { ...place, name: "auth", source: NAME_SOURCES.indexOf("real") };
    expect(labelModel(revealed, 6)).toMatchObject({ name: "auth", subtitle: "Ashford Keep" });
  });
});

describe("cityTitle", () => {
  it("is the City's name", () => {
    expect(cityTitle({ formatVersion: 1, city: { name: "Thornwick", source: 0 }, districts: [] })).toBe("Thornwick");
  });
});
