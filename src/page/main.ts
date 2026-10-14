import { Color, DirectionalLight, HemisphereLight, Mesh, MeshLambertMaterial, PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { decodeChunk, decodeWorld, FormatVersionError, SECONDS_PER_DAY, type World } from "../shared/format.js";
import { type PlacesFile, parsePlaces } from "../shared/places.js";
import { CityBuildings } from "./buildings.js";
import { addCountryside } from "./countryside.js";
import { cityTitle, createDistrictLabels } from "./labels.js";
import { LodController, settingsFor } from "./lod.js";
import { buildTimelines, gridColumns, gridSlot, TRANSITION_COMMITS } from "./state.js";

/** Tuning values for the City. The player and camera tickets replace the rest. */
const TUNING = {
  commitsPerSecond: 2,
  lotSpacing: 1.5,
  /** World distance between Block-grid cells, where District labels are anchored. */
  blockSpacing: 6,
  /** District labels are hidden beyond this many City extents from the camera, at a height of `labelHeight`. */
  labelDistance: 1.5,
  labelHeight: 3,
  groundMargin: 4,
  cameraFov: 45,
  /** Camera offset from the grid centre, as a multiple of the grid's extent plus a fixed distance. */
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
    if (e instanceof FormatVersionError) {
      showNotice("This page and its data come from different git-city versions. Rebuild the site with ", code("git-city build"));
      return;
    }
    throw e;
  }
  const firstChunk = world.chunks[0];
  if (!firstChunk) throw new Error("world.bin lists no chunks");
  const chunk = decodeChunk(await fetchBytes(`chunks/${firstChunk.name}`));
  // Without places.json the City still plays, just without District labels.
  let places: PlacesFile | undefined;
  try {
    places = parsePlaces(new TextDecoder().decode(await fetchBytes("places.json", { cache: "no-store" })));
  } catch (e) {
    console.warn("District names could not be loaded", e);
  }
  play(world, buildTimelines(chunk, world.fileCount), places);
}

function play(world: World, timelines: ReturnType<typeof buildTimelines>, places?: PlacesFile) {
  const commitCount = world.commitDays.length;
  const endTime = commitCount - 1 + TRANSITION_COMMITS;
  const columns = gridColumns(world.fileCount);
  const extent = columns * TUNING.lotSpacing;

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
  addCountryside(scene, {
    // The world file has no City seed yet, so the first file's seed stands in: stable for the repo's life.
    seed: world.seed[0] ?? 0,
    theme: colours === PALETTE.dark ? "dark" : "light",
    keepOut: extent / 2 + TUNING.groundMargin,
  });

  const origin = ((columns - 1) * TUNING.lotSpacing) / 2;
  const place = (file: number) => {
    const { column, row } = gridSlot(file, columns);
    return { x: column * TUNING.lotSpacing - origin, z: row * TUNING.lotSpacing - origin };
  };
  const city = new CityBuildings(
    scene,
    {
      fileCount: world.fileCount,
      buildingType: world.buildingType,
      language: world.language,
      seed: world.seed,
      buildings: timelines.buildings,
      scaffolds: timelines.scaffolds,
      place,
    },
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  const camera = new PerspectiveCamera(TUNING.cameraFov, 1, 0.1, extent * 20 + 100);
  const { x, y, z } = TUNING.cameraOffset;
  camera.position.set(extent * x[0] + x[1], extent * y[0] + y[1], extent * z[0] + z[1]);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const labels = places
    ? createDistrictLabels(scene, places, TUNING.blockSpacing, extent * TUNING.labelDistance, TUNING.labelHeight)
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
  function applyDetail() {
    const detail = settingsFor(lod.level);
    city.setDetail(detail);
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
    city.update(t, TUNING.commitsPerSecond);
    const commit = Math.min(commitCount - 1, Math.max(0, Math.floor(t)));
    const day = new Date(world.commitDays[commit]! * SECONDS_PER_DAY * 1000).toISOString().slice(0, 10);
    status.textContent = `Commit ${commit + 1} of ${commitCount} · ${day}`;
  }

  renderer.setAnimationLoop((now) => {
    if (lod.frame(now)) applyDetail();
    const seconds = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      time = Math.min(endTime, time + seconds * TUNING.commitsPerSecond);
      if (time >= endTime) setPlaying(false);
    }
    draw(time);
    controls.update();
    renderer.render(scene, camera);
    labels?.update(camera);
    labels?.render(scene, camera);
  });
}

main().catch((e: unknown) => {
  console.error(e);
  showNotice(`This City could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
});
