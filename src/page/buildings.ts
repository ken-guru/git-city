import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  type Object3D,
  type Scene,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BUILDING_TYPES, type BuildingType, LANGUAGES } from "../shared/buildings.js";
import { type BuildingSegment, buildingPose, durationFor, FOUNDATION_SHARE, KIND_CHANGE, KIND_NONE, type ScaffoldSegment, scaffoldPose } from "./state.js";

/**
 * The modular kit. Every Building type is one unit-height body (y 0..1) plus props on its roof (y from 1 up).
 * The vertex shader stretches the body to the Building's Floors and lifts the props with it.
 * Each kit is one InstancedMesh; scaffolding and cranes are one more.
 */

/** World units per Floor, and the plinth under every Building. */
export const FLOOR_HEIGHT = 1;
export const FOUNDATION_HEIGHT = 0.2;
/** Window columns per wall unit, and the distances (world units) over which windows fade out. */
const WINDOW_COLUMNS = 3;
const WINDOW_NEAR = 14;
const WINDOW_FAR = 40;

/** Vertex flags: `aRoof` 1 lifts a vertex with the roof; `aTrim` is 0 wall, 1 language colour, 2 fixed (crane). */
function flagged(geometry: BufferGeometry, roof: boolean, trim: number): BufferGeometry {
  const count = geometry.getAttribute("position").count;
  geometry.setAttribute("aRoof", new Float32BufferAttribute(new Array(count).fill(roof ? 1 : 0), 1));
  geometry.setAttribute("aTrim", new Float32BufferAttribute(new Array(count).fill(trim), 1));
  return geometry;
}

interface PartOptions {
  roof?: boolean;
  trim?: number;
}

/** A box whose base sits on `base`. */
function box(w: number, h: number, d: number, x: number, base: number, z: number, { roof = false, trim = 0 }: PartOptions = {}) {
  return flagged(new BoxGeometry(w, h, d).translate(x, base + h / 2, z), roof, trim);
}

/** A cylinder whose base sits on `base`. A zero top radius makes a cone. */
function cylinder(rTop: number, rBottom: number, h: number, segments: number, x: number, base: number, z: number, opts: PartOptions = {}) {
  return flagged(new CylinderGeometry(rTop, rBottom, h, segments).translate(x, base + h / 2, z), opts.roof ?? false, opts.trim ?? 0);
}

/** A four-sided pitched roof on `base`, turned so its edges run along the footprint. */
function pitch(radius: number, h: number, base: number) {
  return flagged(new CylinderGeometry(0, radius, h, 4).rotateY(Math.PI / 4).translate(0, base + h / 2, 0), true, 1);
}

const PROP = { roof: true, trim: 1 } as const;

const KITS: Record<BuildingType, () => BufferGeometry[]> = {
  office: () => [box(0.9, 1, 0.9, 0, 0, 0), box(0.3, 0.12, 0.3, 0, 1, 0, PROP), box(0.04, 0.35, 0.04, 0, 1.12, 0, PROP)],
  laboratory: () => [box(1, 1, 1, 0, 0, 0), cylinder(0.05, 0.05, 0.3, 6, 0, 1, 0, PROP), cylinder(0.22, 0.22, 0.04, 12, 0, 1.3, 0, PROP)],
  library: () => [box(0.9, 1, 0.9, 0, 0, 0), ...[-0.36, 0.36].flatMap((x) => [-0.36, 0.36].map((z) => box(0.08, 1, 0.08, x, 0, z))), pitch(0.72, 0.35, 1)],
  utility: () => [cylinder(0.38, 0.38, 1, 12, 0, 0, 0), cylinder(0, 0.45, 0.25, 12, 0, 1, 0, PROP)],
  factory: () => [box(0.95, 1, 0.95, 0, 0, 0), ...[-0.3, 0, 0.3].map((x) => box(0.28, 0.22, 0.9, x, 1, 0, PROP)), box(0.12, 0.6, 0.12, 0.3, 1, 0.3, PROP)],
  storage: () => [
    cylinder(0.3, 0.3, 1, 12, -0.22, 0, 0),
    cylinder(0.3, 0.3, 1, 12, 0.22, 0, 0),
    cylinder(0.32, 0.32, 0.05, 12, -0.22, 1, 0, PROP),
    cylinder(0.32, 0.32, 0.05, 12, 0.22, 1, 0, PROP),
  ],
  warehouse: () => [box(1, 1, 1, 0, 0, 0), box(1.02, 0.1, 1.02, 0, 1, 0, PROP)],
  "rail-yard": () => [box(1, 1, 1, 0, 0, 0), box(0.04, 0.5, 0.04, 0.42, 1, 0.42, PROP), box(0.04, 0.5, 0.04, -0.42, 1, -0.42, PROP)],
  house: () => [box(0.8, 1, 0.8, 0, 0, 0), pitch(0.6, 0.4, 1), box(0.1, 0.4, 0.1, 0.25, 1, -0.25, PROP)],
};

/** The kit of one Building type, merged into one geometry. */
export function buildingKit(type: BuildingType): BufferGeometry {
  return mergeGeometries(KITS[type](), false)!;
}

/** Scaffolding and a crane, stretched to the Building's Floors by the same shader. Crane parts use trim 2. */
export function scaffoldKit(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const x of [-0.62, 0.62]) for (const z of [-0.62, 0.62]) parts.push(box(0.05, 1, 0.05, x, 0, z));
  for (const level of [0.5, 0.99]) {
    parts.push(box(1.29, 0.05, 0.05, 0, level, -0.62), box(1.29, 0.05, 0.05, 0, level, 0.62));
    parts.push(box(0.05, 0.05, 1.29, -0.62, level, 0), box(0.05, 0.05, 1.29, 0.62, level, 0));
  }
  parts.push(box(0.08, 3.5, 0.08, 0.62, 1, -0.62, { roof: true, trim: 2 }));
  parts.push(box(0.07, 0.07, 2.4, 0.62, 4.45, -0.62, { roof: true, trim: 2 }));
  return mergeGeometries(parts, false)!;
}

/** Light and dark theme colours. Walls are per Building type; windows, dust and crane are per theme. */
export const PALETTE = {
  light: { glass: 0x3c4a58, lit: 0xffe08a, dust: 0xd9cbb0, steel: 0x8fa0b0 },
  dark: { glass: 0x1a2530, lit: 0xffd470, dust: 0x5a5147, steel: 0x5d6b78 },
} as const;

const WALL: Record<BuildingType, number> = {
  office: 0x7f97ad,
  laboratory: 0xb7c2c9,
  library: 0xd8c8a6,
  utility: 0xa9b0b7,
  factory: 0x9c8b7a,
  storage: 0xc0b6a0,
  warehouse: 0xb19d7e,
  "rail-yard": 0x6f7880,
  house: 0xc98f6b,
};

const CRANE = 0xf2c230;

/** Uniforms shared by every City material. `uTime` is the one time value; all eases come from it. */
export interface CityUniforms {
  uTime: { value: number };
  uDuration: { value: number };
  uGlass: { value: [number, number, number] };
  uLit: { value: [number, number, number] };
  uDust: { value: [number, number, number] };
  uSteel: { value: [number, number, number] };
  uCrane: { value: [number, number, number] };
}

const DECLARATIONS = /* glsl */ `
attribute float aRoof;
attribute float aTrim;
attribute float aStart;
attribute float aKind;
attribute float aFrom;
attribute float aTo;
attribute float aHeight;
attribute float aSeed;
attribute vec3 aLanguage;
uniform float uTime;
uniform float uDuration;
uniform vec3 uGlass;
uniform vec3 uLit;
uniform vec3 uDust;
uniform vec3 uSteel;
uniform vec3 uCrane;
uniform vec3 uWall;
varying vec3 vLocal;
varying vec3 vNormalObj;
varying float vTrim;
varying float vSeed;
varying vec3 vLang;
varying float vDust;
varying float vDistance;
`;

const CONSTANTS = /* glsl */ `
const float FLOOR_H = ${FLOOR_HEIGHT.toFixed(4)};
const float FOUNDATION_H = ${FOUNDATION_HEIGHT.toFixed(4)};
const float FOUNDATION_SHARE = ${FOUNDATION_SHARE.toFixed(4)};
`;

/** Building vertices: a build (kind 1), a change (kind 2) or a demolition (kind 3), eased from uTime. */
const BUILDING_VERTEX = /* glsl */ `
  float p = clamp((uTime - aStart) / uDuration, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - p, 3.0);
  float height;
  float sink = 0.0;
  vDust = 0.0;
  if (aKind < 1.5) {
    float q = clamp((p - FOUNDATION_SHARE) / (1.0 - FOUNDATION_SHARE), 0.0, 1.0);
    float fe = 1.0 - pow(1.0 - clamp(p / FOUNDATION_SHARE, 0.0, 1.0), 3.0);
    height = FOUNDATION_H * fe + aTo * FLOOR_H * (1.0 - pow(1.0 - q, 3.0));
  } else if (aKind < 2.5) {
    height = FOUNDATION_H + mix(aFrom, aTo, e) * FLOOR_H;
  } else {
    height = FOUNDATION_H + aFrom * FLOOR_H;
    sink = e * height;
    vDust = e;
  }
  transformed.y = (aRoof > 0.5 ? height + (transformed.y - 1.0) : transformed.y * height) - sink;
  vLocal = transformed;
  vNormalObj = objectNormal;
  vTrim = aTrim;
  vSeed = aSeed;
  vLang = aLanguage;
`;

/** Scaffolding and crane: they rise and come down over D/2 (aFrom to aTo) on a Building of aHeight Floors. */
const SCAFFOLD_VERTEX = /* glsl */ `
  float p = clamp((uTime - aStart) / (uDuration * 0.5), 0.0, 1.0);
  float level = mix(aFrom, aTo, 1.0 - pow(1.0 - p, 3.0));
  float height = (FOUNDATION_H + aHeight * FLOOR_H) * level;
  transformed.y = aRoof > 0.5 ? height + (transformed.y - 1.0) : transformed.y * height;
  vLocal = transformed;
  vNormalObj = objectNormal;
  vTrim = aTrim;
  vSeed = 0.0;
  vLang = vec3(0.0);
  vDust = 0.0;
`;

const FRAGMENT_HELPERS = /* glsl */ `
uniform vec3 uGlass;
uniform vec3 uLit;
uniform vec3 uDust;
uniform vec3 uSteel;
uniform vec3 uCrane;
uniform vec3 uWall;
varying vec3 vLocal;
varying vec3 vNormalObj;
varying float vTrim;
varying float vSeed;
varying vec3 vLang;
varying float vDust;
varying float vDistance;
${CONSTANTS}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Windows are seeded per Floor and per column, some lit, and fade out with distance. Dust dithers away. */
const BUILDING_FRAGMENT = /* glsl */ `
  vec3 base = vTrim > 1.5 ? uCrane : (vTrim > 0.5 ? vLang : uWall);
  if (vTrim < 0.5) {
    float fade = 1.0 - smoothstep(${WINDOW_NEAR.toFixed(1)}, ${WINDOW_FAR.toFixed(1)}, vDistance);
    if (fade > 0.0) {
      vec3 n = normalize(vNormalObj);
      float along = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
      vec2 wall = vec2((along + 0.5) * ${WINDOW_COLUMNS.toFixed(1)}, vLocal.y / FLOOR_H);
      vec2 inside = fract(wall);
      float inWindow = step(0.25, inside.x) * step(inside.x, 0.75) * step(0.3, inside.y) * step(inside.y, 0.7);
      float lit = step(0.55, hash13(vec3(floor(wall), vSeed)));
      base = mix(base, mix(uGlass, uLit, lit), inWindow * fade);
    }
  }
  if (vDust > 0.0) {
    if (hash12(gl_FragCoord.xy) < smoothstep(0.45, 1.0, vDust)) discard;
    base = mix(base, uDust, smoothstep(0.0, 0.6, vDust));
  }
  diffuseColor.rgb = base;
`;

const SCAFFOLD_FRAGMENT = /* glsl */ `
  diffuseColor.rgb = vTrim > 1.5 ? uCrane : uSteel;
`;

/** Gives a Lambert material the City's per-instance attributes, uniforms and shading. */
function cityMaterial(uniforms: CityUniforms, color: number, mode: "building" | "scaffold"): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color, flatShading: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uWall: { value: rgb(color) } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${CONSTANTS}${DECLARATIONS}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${mode === "building" ? BUILDING_VERTEX : SCAFFOLD_VERTEX}`)
      .replace("#include <project_vertex>", "#include <project_vertex>\nvDistance = -mvPosition.z;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_HELPERS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${mode === "building" ? BUILDING_FRAGMENT : SCAFFOLD_FRAGMENT}`);
  };
  return material;
}

function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export interface CityData {
  fileCount: number;
  buildingType: Uint8Array;
  language: Uint8Array;
  seed: Uint32Array;
  buildings: BuildingSegment[][];
  scaffolds: ScaffoldSegment[][];
  /** Where a file's Lot is on the ground. */
  place: (file: number) => { x: number; z: number };
}

interface TypeMesh {
  mesh: InstancedMesh;
  /** File ids in instance order. */
  files: number[];
  start: InstancedBufferAttribute;
  kind: InstancedBufferAttribute;
  from: InstancedBufferAttribute;
  to: InstancedBufferAttribute;
  seed: InstancedBufferAttribute;
  language: InstancedBufferAttribute;
}

/** The City's Buildings: one InstancedMesh per Building type, plus one for scaffolding and cranes. */
export class CityBuildings {
  readonly objects: Object3D[] = [];
  private readonly types: TypeMesh[] = [];
  private readonly slot: Int32Array;
  private readonly onBuilding: Uint8Array;
  private readonly scaffold: InstancedMesh;
  private readonly scaffoldAttrs: { start: InstancedBufferAttribute; from: InstancedBufferAttribute; to: InstancedBufferAttribute; height: InstancedBufferAttribute };
  private readonly onScaffold: Uint8Array;
  private readonly matrix = new Matrix4();
  private readonly uniforms: CityUniforms;
  private readonly place: CityData["place"];
  private readonly data: CityData;

  constructor(scene: Scene, data: CityData, theme: keyof typeof PALETTE) {
    this.data = data;
    this.place = data.place;
    const colours = PALETTE[theme];
    this.uniforms = {
      uTime: { value: 0 },
      uDuration: { value: durationFor(2) },
      uGlass: { value: rgb(colours.glass) },
      uLit: { value: rgb(colours.lit) },
      uDust: { value: rgb(colours.dust) },
      uSteel: { value: rgb(colours.steel) },
      uCrane: { value: rgb(CRANE) },
    };
    this.slot = new Int32Array(data.fileCount);
    this.onBuilding = new Uint8Array(data.fileCount);
    this.onScaffold = new Uint8Array(data.fileCount);

    BUILDING_TYPES.forEach((type, typeIndex) => {
      const files: number[] = [];
      for (let f = 0; f < data.fileCount; f++) {
        if (data.buildingType[f] === typeIndex) {
          this.slot[f] = files.length;
          files.push(f);
        }
      }
      const n = files.length;
      const geometry = buildingKit(type);
      const attrs = {
        start: new InstancedBufferAttribute(new Float32Array(n), 1),
        kind: new InstancedBufferAttribute(new Float32Array(n), 1),
        from: new InstancedBufferAttribute(new Float32Array(n), 1),
        to: new InstancedBufferAttribute(new Float32Array(n), 1),
        seed: new InstancedBufferAttribute(new Float32Array(n), 1),
        language: new InstancedBufferAttribute(new Float32Array(n * 3), 3),
      };
      geometry.setAttribute("aStart", attrs.start);
      geometry.setAttribute("aKind", attrs.kind);
      geometry.setAttribute("aFrom", attrs.from);
      geometry.setAttribute("aTo", attrs.to);
      geometry.setAttribute("aSeed", attrs.seed);
      geometry.setAttribute("aLanguage", attrs.language);
      const mesh = new InstancedMesh(geometry, cityMaterial(this.uniforms, WALL[type], "building"), n);
      files.forEach((f, i) => {
        const language = LANGUAGES[data.language[f]!]?.colour ?? 0;
        attrs.language.array.set(rgb(language), i * 3);
        attrs.seed.setX(i, data.seed[f]! & 0xffffff);
        this.setPlacement(mesh, i, f, false);
      });
      // Instance bounds are computed once, so collapsing and growing instances would leave them stale.
      mesh.frustumCulled = false;
      this.types.push({ mesh, files, ...attrs });
      this.objects.push(mesh);
    });

    const scaffoldGeometry = scaffoldKit();
    const scaffoldAttrs = {
      start: new InstancedBufferAttribute(new Float32Array(data.fileCount), 1),
      from: new InstancedBufferAttribute(new Float32Array(data.fileCount), 1),
      to: new InstancedBufferAttribute(new Float32Array(data.fileCount), 1),
      height: new InstancedBufferAttribute(new Float32Array(data.fileCount), 1),
    };
    scaffoldGeometry.setAttribute("aStart", scaffoldAttrs.start);
    scaffoldGeometry.setAttribute("aFrom", scaffoldAttrs.from);
    scaffoldGeometry.setAttribute("aTo", scaffoldAttrs.to);
    scaffoldGeometry.setAttribute("aHeight", scaffoldAttrs.height);
    this.scaffoldAttrs = scaffoldAttrs;
    this.scaffold = new InstancedMesh(scaffoldGeometry, cityMaterial(this.uniforms, PALETTE[theme].steel, "scaffold"), data.fileCount);
    this.scaffold.frustumCulled = false;
    for (let f = 0; f < data.fileCount; f++) this.setPlacement(this.scaffold, f, f, false);
    this.objects.push(this.scaffold);

    for (const object of this.objects) scene.add(object);
  }

  /** Puts a file's instance on its Lot, or collapses it to nothing. */
  private setPlacement(mesh: InstancedMesh, instance: number, file: number, visible: boolean) {
    const { x, z } = this.place(file);
    const scale = visible ? 1 : 0;
    this.matrix.makeScale(scale, scale, scale).setPosition(x, 0, z);
    mesh.setMatrixAt(instance, this.matrix);
  }

  /** Sets every instance for time `t` (in commits) and at `commitsPerSecond` speed. */
  update(t: number, commitsPerSecond: number): void {
    const duration = durationFor(commitsPerSecond);
    this.uniforms.uTime.value = t;
    this.uniforms.uDuration.value = duration;

    for (const type of this.types) {
      const { files, start, kind, from, to } = type;
      files.forEach((f, i) => {
        const pose = buildingPose(this.data.buildings[f]!, t, duration);
        start.setX(i, Math.max(-1e6, pose.start));
        // A hidden Lot has no transition; it is collapsed by its matrix, so any kind will do. Use a change to keep the shader on one branch.
        kind.setX(i, pose.kind === KIND_NONE ? KIND_CHANGE : pose.kind);
        from.setX(i, pose.from);
        to.setX(i, pose.to);
        if (pose.visible !== Boolean(this.onBuilding[f])) {
          this.onBuilding[f] = pose.visible ? 1 : 0;
          this.setPlacement(type.mesh, i, f, pose.visible);
        }
      });
      start.needsUpdate = kind.needsUpdate = from.needsUpdate = to.needsUpdate = true;
      type.mesh.instanceMatrix.needsUpdate = true;
    }

    for (let f = 0; f < this.data.fileCount; f++) {
      const building = buildingPose(this.data.buildings[f]!, t, duration);
      const pose = scaffoldPose(this.data.scaffolds[f]!, building, t, duration);
      this.scaffoldAttrs.start.setX(f, Math.max(-1e6, pose.start));
      this.scaffoldAttrs.from.setX(f, pose.from);
      this.scaffoldAttrs.to.setX(f, pose.to);
      this.scaffoldAttrs.height.setX(f, pose.height);
      if (pose.visible !== Boolean(this.onScaffold[f])) {
        this.onScaffold[f] = pose.visible ? 1 : 0;
        this.setPlacement(this.scaffold, f, f, pose.visible);
      }
    }
    this.scaffoldAttrs.start.needsUpdate = this.scaffoldAttrs.from.needsUpdate = true;
    this.scaffoldAttrs.to.needsUpdate = this.scaffoldAttrs.height.needsUpdate = true;
    this.scaffold.instanceMatrix.needsUpdate = true;
  }
}
