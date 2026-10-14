import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { decodeChunk, decodeWorld, FormatVersionError, type World } from "../shared/format.js";
import { gridSlot, lifetimes, scaleAt, TRANSITION_COMMITS } from "./state.js";

/** Tuning values for the walking skeleton. */
const COMMITS_PER_SECOND = 2;
const LOT_SPACING = 1.5;
const BOX_FOOTPRINT = 1;
const BOX_HEIGHT = 1;

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
  play(world, lifetimes(chunk, world.fileCount));
}

function play(world: World, { birth, death }: ReturnType<typeof lifetimes>) {
  const commitCount = world.commitDays.length;
  const endTime = commitCount - 1 + TRANSITION_COMMITS;
  const columns = Math.max(1, Math.ceil(Math.sqrt(world.fileCount)));
  const extent = columns * LOT_SPACING;

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  document.body.prepend(renderer.domElement);

  const scene = new Scene();
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  scene.background = new Color(dark ? 0x10161c : 0xe9eef2);
  scene.add(new HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);

  const ground = new Mesh(new PlaneGeometry(extent + 4, extent + 4), new MeshLambertMaterial({ color: dark ? 0x26313b : 0xc9d3db }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // One instance per file; boxes grow up from the ground, so the unit box sits on y = 0.
  const box = new BoxGeometry(BOX_FOOTPRINT, BOX_HEIGHT, BOX_FOOTPRINT).translate(0, BOX_HEIGHT / 2, 0);
  const boxes = new InstancedMesh(box, new MeshLambertMaterial({ color: 0x5b8cc4, flatShading: true }), world.fileCount);
  scene.add(boxes);
  const origin = ((columns - 1) * LOT_SPACING) / 2;
  const matrix = new Matrix4();

  const camera = new PerspectiveCamera(45, 1, 0.1, extent * 20 + 100);
  camera.position.set(extent * 0.9 + 4, extent * 0.8 + 4, extent * 1.1 + 6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

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
    for (let file = 0; file < world.fileCount; file++) {
      const s = scaleAt(birth[file]!, death[file]!, t);
      const { column, row } = gridSlot(file, world.fileCount);
      // A scale of 0 collapses the instance entirely rather than flattening it onto the ground.
      matrix.makeScale(s, s, s).setPosition(column * LOT_SPACING - origin, 0, row * LOT_SPACING - origin);
      boxes.setMatrixAt(file, matrix);
    }
    boxes.instanceMatrix.needsUpdate = true;
    const commit = Math.min(commitCount - 1, Math.max(0, Math.floor(t)));
    const day = new Date(world.commitDays[commit]! * 86_400_000).toISOString().slice(0, 10);
    status.textContent = `Commit ${commit + 1} of ${commitCount} · ${day}`;
  }

  renderer.setAnimationLoop((now) => {
    const seconds = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      time = Math.min(endTime, time + seconds * COMMITS_PER_SECOND);
      if (time >= endTime) setPlaying(false);
    }
    draw(time);
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((e: unknown) => {
  console.error(e);
  showNotice(`This City could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
});
