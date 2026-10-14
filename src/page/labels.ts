import { type Object3D, type PerspectiveCamera, type Scene } from "three";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { type DistrictPlace, type PlacesFile, sourceName } from "../shared/places.js";

/** What a District label shows: its display name, its Generated name as a subtitle when that is not the name, and the District colour. */
export interface LabelModel {
  name: string;
  subtitle?: string;
  colour: string;
  x: number;
  z: number;
}

/** Whether a label is shown at a distance from the camera. Hidden beyond `maxDistance` (SPEC §11, Labels). */
export function isLabelVisible(distance: number, maxDistance: number): boolean {
  return distance <= maxDistance;
}

/** The label of one District, placed at its village anchor. `spacing` is the world distance between Block-grid cells. */
export function labelModel(place: DistrictPlace, spacing: number, pageTheme: "light" | "dark" = "light"): LabelModel {
  const { hue, saturation, lightness } = place.colour;
  const subtitle = sourceName(place.source) === "generated" ? undefined : place.generated;
  return {
    name: place.name,
    subtitle,
    colour: `hsl(${hue} ${Math.round(saturation * 100)}% ${Math.round(lightness[pageTheme] * 100)}%)`,
    x: place.anchor.col * spacing,
    z: place.anchor.row * spacing,
  };
}

/** The City's own name, for the page title. Empty when there is none. */
export function cityTitle(places: PlacesFile): string {
  return places.city.name;
}

export interface DistrictLabels {
  /** Hides or shows each label by its distance from the camera. */
  update(camera: Object3D): void;
  /** Sets the distance beyond which labels are hidden (the level of detail decides it). */
  setMaxDistance(distance: number): void;
  /** Renders the label layer over the WebGL canvas. */
  render(scene: Scene, camera: PerspectiveCamera): void;
  setSize(width: number, pixelHeight: number): void;
  readonly element: HTMLElement;
}

/**
 * Creates the label layer for Districts. Each label is an HTML element positioned in the scene,
 * with the District colour on its edge and its name as text, so colour is never the only cue.
 */
export function createDistrictLabels(
  scene: Scene,
  places: PlacesFile,
  spacing: number,
  maxDistance: number,
  height: number,
  pageTheme: "light" | "dark" = "light",
): DistrictLabels {
  const renderer = new CSS2DRenderer();
  renderer.domElement.classList.add("labels");
  const objects: { object: CSS2DObject; model: LabelModel }[] = [];
  let limit = maxDistance;
  for (const place of places.districts) {
    const model = labelModel(place, spacing, pageTheme);
    const element = document.createElement("div");
    element.className = "district-label";
    element.style.borderLeftColor = model.colour;
    const name = document.createElement("span");
    name.textContent = model.name;
    element.append(name);
    if (model.subtitle !== undefined) {
      const subtitle = document.createElement("small");
      subtitle.textContent = model.subtitle;
      element.append(subtitle);
    }
    const object = new CSS2DObject(element);
    object.position.set(model.x, height, model.z);
    scene.add(object);
    objects.push({ object, model });
  }
  return {
    element: renderer.domElement,
    update(camera) {
      for (const { object } of objects) {
        const visible = isLabelVisible(object.position.distanceTo(camera.position), limit);
        object.element.style.display = visible ? "" : "none";
      }
    },
    setMaxDistance(distance) {
      limit = distance;
    },
    render(scene, camera) {
      renderer.render(scene, camera);
    },
    setSize(width, pixelHeight) {
      renderer.setSize(width, pixelHeight);
    },
  };
}
