# Research: rendering stack for the GitCity viewer

Ticket: ken-guru/git-city#4 (map #1). Researched 2026-10-11.

## Question

Which browser rendering stack best fits an animated low-poly City with up to about 20k procedurally generated Buildings, Roads with asymmetric Lanes, eased construction and deconstruction transitions, a scripted showcase fly-around and a scrubbable Timeline, delivered as a static folder? Candidates are three.js, Babylon.js, and raw WebGL2/WebGPU (with helpers such as regl).

## Recommendation

**three.js (r186), with `WebGLRenderer` for v1.** Draw Buildings with `InstancedMesh`, one per procedural archetype (or one `BatchedMesh` when archetypes vary a lot). Animate them in the vertex shader as a pure function of Timeline time. Keep `WebGPURenderer` (from `three/webgpu`) as a later upgrade path rather than the v1 default.

Why:

- three.js has both primitives the City needs: same-geometry instancing (`InstancedMesh`) and multi-geometry batching with per-object culling (`BatchedMesh`). Babylon's equivalent (thin instances) culls all-or-nothing.
- It had the smallest bundle of the two engines in our measurement: about 111 KiB brotli for a realistic minimal scene, against about 260 KiB for Babylon.
- Flat shading is a single material flag.
- `CatmullRomCurve3` covers the camera path. Easing is something we have to own anyway, because scrubbing backwards must be deterministic.
- Raw WebGL2/WebGPU saves bytes but means rebuilding the camera, math, lighting and culling ourselves. regl is WebGL1-only.

## Findings

### 1. Instancing and merging procedural geometry

| | three.js | Babylon.js | Raw WebGL2 / regl / WebGPU |
|---|---|---|---|
| Same geometry, many transforms | `InstancedMesh`: "render a large number of objects with the same geometry and material(s) but with different world transformations" [1] | Thin instances: `thinInstanceSetBuffer('matrix', Float32Array, 16, false)`, plus custom attributes via `thinInstanceRegisterAttribute` [3] | `drawArraysInstanced`, or instancing through an extension in regl [6] |
| Different geometries, one draw | `BatchedMesh`: "multi draw batch rendering", meaning many objects that share one material but differ in geometry or transform [2] | Merge meshes or use separate thin-instance meshes (not covered here) | Hand-rolled (multi-draw or indirect) |
| Per-object culling | `InstancedMesh`: no. It culls on one bounding sphere, which "you may need to recompute … if an instance is transformed" [1]. `BatchedMesh`: yes, `perObjectFrustumCulled` (default true) plus `sortObjects` [2] | Thin instances: no. "either all thin instances are drawn (if the mesh is deemed visible) or none are" [3] | Your own |
| Per-instance colour | `setColorAt` on both classes [1][2]. `BatchedMesh` also has per-instance opacity since r183 [4] | Registered `color` attribute [3] | Your own |

The three.js manual's own example is the same scale as GitCity. It draws about 19,000 boxes and went from "under 20fps" as separate meshes to "60 frames per second" once merged. It also warns that once merged, "it's no longer easy to move any part that was previously separate" [5]. Instancing keeps the single draw call and still lets each Building move independently, so we should use it rather than merging.

For GitCity this means:

- Buildings are a small set of procedural archetypes (box, stepped tower, gabled block, and so on), scaled per instance. Use one `InstancedMesh` per archetype, which keeps draw calls in the tens.
- If per-Building geometry varies too much for archetypes, put it in one `BatchedMesh` instead.
- Districts and Neighbourhoods should not each get their own mesh. That would mean thousands of draw calls.
- Roads and Lanes fit merged static geometry rebuilt per Timeline chunk, or instanced lane segments (a unit quad scaled and rotated per segment). Asymmetric Lanes are then just a different instance count per direction.

### 2. Per-instance animation (construction, deconstruction, scrubbing)

Every engine updates instances by writing a CPU buffer and flagging it for re-upload:

- three.js: "set the `needsUpdate` flag of `instanceMatrix` to `true`" [1]
- Babylon: "you must call `thinInstanceBufferUpdated`" [3]

Re-uploading 20k matrices every frame is affordable (20k × 64 B ≈ 1.3 MB/frame). A better design for a Timeline that plays, scrubs backwards and changes speed is to make the animation stateless. This is our own design inference, not something any engine provides:

- Each instance carries static attributes: `tBorn`, `tDied`, target height and colour.
- One uniform, `uTime`, is the playhead.
- The vertex shader computes `ease(clamp((uTime - tBorn)/dur, 0, 1))` and scales the Building's height and opacity from that value.
- Scrubbing, reverse playback and speed changes then only change one uniform. There is no CPU tween state to rewind, and deconstruction is simply the same ease run from `tDied`.
- In three.js the attributes go in as `InstancedBufferAttribute`s and get into the shader through `Material.onBeforeCompile` ("Useful for the modification of built-in materials") [7], or through TSL nodes under `WebGPURenderer`.
- Babylon needs the same pattern through `thinInstanceRegisterAttribute` plus a custom or Node material.
- Buffers are rewritten only when a new Timeline chunk loads.

The three.js manual animates merged geometry with morph targets [5b]. That only works when "Morphtargets are required to all have exactly the same number of vertices", which doesn't fit a City that grows. The approach above avoids that limit.

Babylon has a built-in easing library: `CubicEase`, `SineEase`, `BezierCurveEase`, `BackEase`, `ElasticEase` and others [8]. three.js has no general-purpose easing classes. Either way the shader needs its own GLSL/TSL easing, so this advantage of Babylon mostly doesn't apply to us.

### 3. Flat-shaded low-poly look

- three.js: `MeshLambertMaterial` / `MeshStandardMaterial` take `flatShading: true` ("Whether the material is rendered with flat shading or not"). Lambert is described as cheaper than physically based materials ("performance will be greater") [9].
- Babylon: `mesh.convertToFlatShadedMesh()` duplicates vertices so that "each mesh facet will then have its own normals". It allocates a new vertex buffer [10].
- Raw: compute face normals with derivatives (`dFdx`/`dFdy`) in the fragment shader, a few lines of code.

All three are easy. three.js's material flag doesn't touch geometry, which suits instanced meshes.

### 4. Performance budget on a mid-range laptop

There is no maintained cross-engine benchmark from a primary source. The figures below are estimates from the data above, not measurements on hardware:

- **Draw calls:** keep them under about 100 per frame. Per-archetype instancing gives about 5–20 for Buildings plus a few for Roads, Highways and External Cities.
- **Triangles:** 20k Buildings × 12–200 triangles each (box to detailed tower) is roughly 0.25–4M. Integrated GPUs comfortably handle low millions of flat-shaded triangles with one directional light and no shadows.
- **Shadows:** a full-City shadow map is the most likely thing to break the budget. Treat it as optional or low resolution.
- **CPU:** stateless shader animation keeps per-frame JS at about one uniform write. `BatchedMesh` culling and sorting cost CPU per frame for 20k objects [2], so prefer `InstancedMesh` per archetype unless culling measurably helps.
- **Static-folder constraint:** none. All options run from a plain `index.html` plus a module bundle.

A prototype on a real integrated-GPU laptop should confirm these numbers before spec assembly (#12).

### 5. Bundle size (measured)

Each library was bundled with esbuild 0.28.2 (`--bundle --minify --format=esm`) using a realistic minimal scene: renderer, camera, two lights, flat-shaded material, 20k-instance mesh, Catmull-Rom curve. Package versions are three@0.186.1, @babylonjs/core@9.30.0 (ES module deep imports) and regl@2.1.1.

| Scene | Minified | gzip -9 | brotli |
|---|---|---|---|
| three.js `WebGLRenderer` + `InstancedMesh` | 531 KiB | 135 KiB | 111 KiB |
| three.js `WebGLRenderer` + `BatchedMesh` | 546 KiB | 139 KiB | 114 KiB |
| three.js `WebGPURenderer` (`three/webgpu`) + `InstancedMesh` | 776 KiB | 215 KiB | 174 KiB |
| Babylon.js `Engine` + thin instances | 1463 KiB | 340 KiB | 260 KiB |
| regl (WebGL1 wrapper only, no math or camera) | 120 KiB | 41 KiB | 36 KiB |

Babylon's tree-shaking via `@babylonjs/core` deep imports still pulls in about 2.4× three.js. A static page has no CDN cache to lean on, so this matters.

### 6. Camera tooling for a scripted fly-around

- **three.js:** `CatmullRomCurve3` (`getPointAt(u)` gives arc-length-parameterised positions) for the path, plus a look-at target curve. Interruption and resume can use `OrbitControls` from `three/addons`. The fly-around is then a pure function of `u` and fits the stateless-time model.
- **Babylon.js:** `Curve3.CreateCatmullRomSpline` plus the `Animation` system with built-in easing functions [8], and `UniversalCamera`/`ArcRotateCamera`. This is the richest built-in tooling of the three options.
- **Raw:** write the spline, look-at and controls yourself.

### 7. WebGPU and raw-API status

- **WebGPU:** shipped in Chrome/Edge (desktop since 113, Android 121+), Firefox 141+ on Windows (macOS ARM from 145; Linux and Android in progress), and Safari 26 [11]. Linux Chrome and Firefox are still in progress, so a WebGL2 path is still required.
- **three.js `WebGPURenderer`:** handles the fallback itself. It "tries to use a WebGPU backend if the browser supports WebGPU. If not, `WebGPURenderer` falls backs to a WebGL 2 backend", and `forceWebGL` forces it [12]. It is under heavy development (r185 and r186 renderer fixes [4]) and costs about 60 KiB brotli more. WebGPU's main advantage is compute shaders, which we don't need at 20k instances.
- **Babylon `WebGPUEngine`:** needs `await engine.initAsync()`. WebGL and WebGPU "will both be maintained side by side", but the engine is chosen up front with no automatic fallback [13].
- **regl:** not archived (last push 2026-09) [6b], but `createContext` only requests `'webgl'` / `'experimental-webgl'` [6c]. It is WebGL1 only, so instancing goes through `ANGLE_instanced_arrays`, and there is no WebGL2 or WebGPU path. It is not a fit.
- **Raw WebGL2/WebGPU:** smallest bytes and full control, but we would have to own the matrix math, camera, picking (for hover labels), resize/DPR handling, culling and the fallback between the two APIs. That cost isn't justified when three.js already provides instancing in one draw call.

## Open points for later tickets

- **Road and Lane geometry:** instanced segments or merged per-chunk meshes. Decide with the layout.
- **Animation system:** adopt the stateless `uTime` shader model above, and specify the easing curve library in GLSL/TSL.
- **Graceful degradation:** use the `InstancedMesh.count` and `BatchedMesh` `setVisibleAt` levers [1][2] for level of detail and sampling.
- **Prototype:** measure frame time for 20k instances with the shader animation on an integrated-GPU laptop.

## Sources

1. three.js source, `src/objects/InstancedMesh.js` (dev, r186): https://github.com/mrdoob/three.js/blob/dev/src/objects/InstancedMesh.js
2. three.js source, `src/objects/BatchedMesh.js` (dev, r186): https://github.com/mrdoob/three.js/blob/dev/src/objects/BatchedMesh.js
3. Babylon.js docs, "Thin Instances": https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/mesh/copies/thinInstances.md (published at https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/thinInstances)
4. three.js release notes r183–r186: https://github.com/mrdoob/three.js/releases
5. three.js manual, "Optimize Lots of Objects": https://github.com/mrdoob/three.js/blob/dev/manual/pages/optimize-lots-of-objects.html
   5b. three.js manual, "Optimize Lots of Objects Animated": https://github.com/mrdoob/three.js/blob/dev/manual/pages/optimize-lots-of-objects-animated.html
6. regl README: https://github.com/regl-project/regl
   6b. GitHub API `repos/regl-project/regl`: `archived: false`, `pushed_at: 2026-09-08`
   6c. regl source, `lib/webgl.js` `createContext` (regl@2.1.1)
7. three.js source, `src/materials/Material.js` (`onBeforeCompile` doc): https://github.com/mrdoob/three.js/blob/dev/src/materials/Material.js
8. Babylon.js `@babylonjs/core@9.30.0` `Animations/easing.d.ts` (exported easing classes)
9. three.js source, `src/materials/MeshLambertMaterial.js`: https://github.com/mrdoob/three.js/blob/dev/src/materials/MeshLambertMaterial.js
10. Babylon.js `@babylonjs/core@9.30.0` `Meshes/mesh.pure.d.ts`, `convertToFlatShadedMesh` doc comment
11. web.dev, "WebGPU is now supported in major browsers": https://web.dev/blog/webgpu-supported-major-browsers
12. three.js source, `src/renderers/webgpu/WebGPURenderer.js`: https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgpu/WebGPURenderer.js
13. Babylon.js docs, WebGPU support: https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU.md
14. Bundle sizes: measured locally with esbuild 0.28.2 on the package versions listed in section 5.
