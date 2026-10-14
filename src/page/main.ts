import { Color, DirectionalLight, HemisphereLight, Mesh, MeshLambertMaterial, PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { decodeWorld, FormatVersionError, SECONDS_PER_DAY, type World } from "../shared/format.js";
import { type ExternalCitiesFile, parseExternalCities } from "../shared/externals.js";
import { type PlacesFile, parsePlaces } from "../shared/places.js";
import { ExternalLayer } from "./externals.js";
import { externalsGeometry } from "./externals-geometry.js";
import { CityBuildings } from "./buildings.js";
import { addCountryside, type CountrysideHandle } from "./countryside.js";
import { BlockLayer, blockPaving } from "./blocks.js";
import { ChunkStream } from "./chunks.js";
import { BLOCK_WORLD, cityExtent, lotBlock, placeLot } from "./lots.js";
import { cityTitle, createDistrictLabels } from "./labels.js";
import { LodController, type LodSettings, settingsFor } from "./lod.js";
import { RoadLayer } from "./roads.js";
import { appendTimelines, buildTimelines, durationFor, TRANSITION_COMMITS, type Timelines } from "./state.js";

/** Tuning values for the City. The player and camera tickets replace the rest. */
const TUNING = {
  commitsPerSecond: 2,
  /** District labels are hidden beyond this many City extents from the camera, at a height of `labelHeight`. */
  labelDistance: 1.5,
  labelHeight: 3,
  groundMargin: 4,
  cameraFov: 45,
  /** Camera offset from the City's centre, as a multiple of its extent plus a fixed distance. */
  cameraOffset: { x: [0.9, 4], y: [0.8, 4], z: [1.1, 6] },
  skyLight: 1.6,
  sunLight: 1.4,
  sunDirection: [1, 2, 1.5],
} as const;

const PALETTE = {
  light: { background: 0xe9eef2, ground: 0xc9d3db },
  dark: { background: 0x10161c, ground: 0x26313b },
  sky: 0xffffff,
  skyGround: 0x445566,
} as const;

const notice = document.getElementById("notice")!;
const player = document.getElementById("player")!;
const playButton = document.getElementById("play") as HTMLButtonElement;
const status = document.getElementById("status")!;

function showNotice(...parts: (string | Node)[]) {
  notice.replaceChildren(...parts);
  notice.hidden = false;
}

function code(text: string): HTMLElement {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
}

function showVersionNotice() {
  showNotice("This page and its data come from different git-city versions. Rebuild the site with ", code("git-city build"));
}

async function fetchBytes(path: string, init?: RequestInit): Promise<Uint8Array> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main() {
  if (location.protocol === "file:") {
    showNotice("This City has to be served over HTTP. In the folder above this one, run ", code("npx git-city serve"));
    return;
  }

  let world: World;
  try {
    world = decodeWorld(await fetchBytes("world.bin", { cache: "no-store" }));
  } catch (e) {
    if (e instanceof FormatVersionError) return showVersionNotice();
    throw e;
  }
  if (world.chunks.length === 0) throw new Error("world.bin lists no chunks");
  const stream = new ChunkStream(world, (name) => fetchBytes(`chunks/${name}`));
  // The first chunk is needed to play at all; the rest stream in behind it, in order.
  let timelines: Timelines;
  try {
    timelines = buildTimelines(await stream.load(0), world.stints.file.length, world.language);
  } catch (e) {
    if (e instanceof FormatVersionError) return showVersionNotice();
    throw e;
  }
  // Without places.json the City still plays, just without District labels.
  let places: PlacesFile | undefined;
  try {
    places = parsePlaces(new TextDecoder().decode(await fetchBytes("places.json", { cache: "no-store" })));
  } catch (e) {
    console.warn("District names could not be loaded", e);
  }
  // Without externals.json the City still plays, just without the horizon and the External Cities.
  let externals: ExternalCitiesFile | undefined;
  try {
    externals = parseExternalCities(new TextDecoder().decode(await fetchBytes("externals.json", { cache: "no-store" })));
  } catch (e) {
    console.warn("External Cities could not be loaded", e);
  }
  play(world, timelines, stream, places, externals);
  stream
    .loadAll((index, chunk) => {
      if (index > 0) appendTimelines(timelines, chunk, world.language);
    })
    .catch((e: unknown) => {
      if (e instanceof FormatVersionError) return showVersionNotice();
      console.error("History stopped loading", e);
    });
}

function play(world: World, timelines: Timelines, stream: ChunkStream, places?: PlacesFile, externals?: ExternalCitiesFile) {
  const commitCount = world.commitDays.length;
  const endTime = commitCount - 1 + TRANSITION_COMMITS;
  // The City's extent is set by its Blocks: the layout places them all, so the page frames what it has.
  const extent = cityExtent(world);
  const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  const renderer = new WebGLRenderer({ antialias: true });
  document.body.prepend(renderer.domElement);

  const scene = new Scene();
  const colours = matchMedia("(prefers-color-scheme: dark)").matches ? PALETTE.dark : PALETTE.light;
  scene.background = new Color(colours.background);
  scene.add(new HemisphereLight(PALETTE.sky, PALETTE.skyGround, TUNING.skyLight));
  const sun = new DirectionalLight(PALETTE.sky, TUNING.sunLight);
  sun.position.set(...TUNING.sunDirection);
  scene.add(sun);

  const ground = new Mesh(new PlaneGeometry(extent + TUNING.groundMargin, extent + TUNING.groundMargin), new MeshLambertMaterial({ color: colours.ground }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // The Blocks are where the layout put them, so the scenery fades out next to each claimed Block.
  const blocks = blockSites(world);
  const duration = durationFor(TUNING.commitsPerSecond);
  const countryside: CountrysideHandle = addCountryside(scene, {
    // The City seed the CLI wrote into the world file: the same seed the layout used.
    seed: world.citySeed,
    theme,
    keepOut: 0,
    claimed: blocks.map((b) => ({ col: Math.round(b.x), row: Math.round(b.z) })),
  });
  // A District's paving is found from its birth index: the world file lists the places in order, with their indices.
  const districts = places?.districts;
  const positionOf = new Map(Array.from(world.districts.index, (index, position) => [index, position] as const));
  const paving = new Map<number, Color>();
  const colourOf = (birth: number): Color => {
    let colour = paving.get(birth);
    if (!colour) {
      colour = blockPaving(positionOf.get(birth) ?? -1, districts, theme);
      paving.set(birth, colour);
    }
    return colour;
  };
  const blockLayer = new BlockLayer(scene, blocks, countryside.land, timelines.owners, colourOf);
  const roadLayer = new RoadLayer(
    scene,
    roadInputs(world),
    villageSites(world),
    blocks,
    countryside.land,
    world.citySeed,
    theme,
    timelines.roads,
  );

  // The horizon, the Highways and the External Cities, from the CLI's externals.json, over the Countryside's terrain.
  const externalLayer = externals
    ? new ExternalLayer(
        scene,
        externalsGeometry(externals, villageSites(world), BLOCK_WORLD),
        theme,
        (x, z) => countryside.land.heightAt(x / BLOCK_WORLD, z / BLOCK_WORLD),
      )
    : undefined;

  const city = new CityBuildings(
    scene,
    {
      stintCount: world.stints.file.length,
      buildingType: world.stints.buildingType,
      language: Uint8Array.from(world.stints.file, (f) => world.language[f]!),
      seed: Uint32Array.from(world.stints.file, (f) => world.seed[f]!),
      buildings: timelines.buildings,
      scaffolds: timelines.scaffolds,
      languages: timelines.languages,
      place: (stint) => placeLot(world, world.stints.lot[stint]!),
      block: (stint) => lotBlock(world, world.stints.lot[stint]!),
    },
    theme,
  );

  const camera = new PerspectiveCamera(TUNING.cameraFov, 1, 0.1, extent * 20 + 100);
  const { x, y, z } = TUNING.cameraOffset;
  camera.position.set(extent * x[0] + x[1], extent * y[0] + y[1], extent * z[0] + z[1]);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const labels = places
    ? createDistrictLabels(scene, places, BLOCK_WORLD, extent * TUNING.labelDistance, TUNING.labelHeight, theme)
    : undefined;
  if (labels) document.body.append(labels.element);
  if (places) document.title = cityTitle(places);

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    labels?.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);

  // Level of detail follows the measured frame rate. A new level changes what is drawn, not the data.
  const lod = new LodController();
  let detail: LodSettings = settingsFor(lod.level);
  function applyDetail() {
    detail = settingsFor(lod.level);
    city.setDetail(detail);
    countryside.setDetail(detail);
    labels?.setMaxDistance(Math.min(extent * TUNING.labelDistance, detail.labelFar));
    renderer.setPixelRatio(Math.min(devicePixelRatio, detail.pixelRatioCap));
    resize();
  }
  applyDetail();

  let time = 0;
  let playing = false;
  let last = performance.now();

  function setPlaying(value: boolean) {
    if (value && time >= endTime) time = 0;
    playing = value;
    playButton.textContent = playing ? "Pause" : "Play";
  }
  playButton.addEventListener("click", () => setPlaying(!playing));
  setPlaying(false);
  player.hidden = false;

  function draw(t: number) {
    city.update(t, TUNING.commitsPerSecond, camera.position);
    externalLayer?.update(t);
    blockLayer.update(t, duration, camera.position, detail.massFar);
    roadLayer.update(t, duration);
    const commit = Math.min(commitCount - 1, Math.max(0, Math.floor(t)));
    const day = new Date(world.commitDays[commit]! * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
    status.textContent = Math.floor(t) > stream.loadedThrough()
      ? "Loading this part of history…"
      : `Commit ${commit + 1} of ${commitCount} · ${day}`;
  }

  renderer.setAnimationLoop((now) => {
    if (lod.frame(now)) applyDetail();
    const seconds = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      // The City holds at the last commit that has loaded, and carries on when the next chunk arrives.
      const loaded = stream.loadedThrough();
      const limit = loaded >= commitCount - 1 ? endTime : loaded;
      time = Math.min(limit, time + seconds * TUNING.commitsPerSecond);
      if (time >= endTime) setPlaying(false);
    }
    draw(time);
    controls.update();
    renderer.render(scene, camera);
    labels?.update(camera);
    labels?.render(scene, camera);
  });
}

/** The Blocks in world-file form: each with its position in Block widths, its village, and the commit that claimed it. */
function blockSites(world: World) {
  return Array.from({ length: world.blocks.x.length }, (_, i) => ({
    village: world.blocks.village[i]!,
    x: world.blocks.x[i]!,
    z: world.blocks.z[i]!,
    claimed: world.blocks.claimed[i]!,
  }));
}

function villageSites(world: World) {
  return Array.from({ length: world.villages.x.length }, (_, i) => ({ x: world.villages.x[i]!, z: world.villages.z[i]! }));
}

/** The Roads by id: their two villages, the older one first. */
function roadInputs(world: World) {
  return Array.from({ length: world.roads.a.length }, (_, i) => ({ a: world.roads.a[i]!, b: world.roads.b[i]! }));
}

main().catch((e: unknown) => {
  console.error(e);
  showNotice(`This City could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
});
