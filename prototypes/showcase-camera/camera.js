
// ---------- Showcase camera (git-city#23) ----------
// Once the Timeline is at the latest commit and the viewer is idle, the camera shows the City off. Three styles:
// A grand tour (sweep the land, then glide past the busiest villages), B drone along the roads, C postcards (composed
// shots with a slow push-in). Any touch of the controls pauses it; it resumes after an idle delay while history is up
// to date. During playback the camera either stays where the viewer left it or gently follows where changes happen.
let camStyle = 'A', camSpeed = 1, followDuringPlay = true, simReducedMotion = false;
const IDLE_RESUME = 12;   // seconds of no interaction before the showcase resumes
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function villageActivity(t, window = 120) {
  const act = new Map();
  for (const lot of lots) { const p = full.lots.get(lot.id); if (!p) continue;
    let n = 0; for (const [kt] of lot.keys) if (kt <= t && kt > t - window) n++; if (lot.from <= t && lot.from > t - window) n += 2;
    if (!n) continue; const c = cells.find(c => Math.hypot(c.x - p[0], c.z - p[1]) < CW); if (!c) continue; act.set(c.village, (act.get(c.village) ?? 0) + n); }
  return [...act].sort((a, b) => b[1] - a[1]);
}
const vRadius = v => { let r = CW; for (const c of cells) if (c.village === v) r = Math.max(r, Math.hypot(c.x - v.seed[0], c.z - v.seed[1]) + CW); return r; };
// Building clusters: per village, the Buildings standing at t, plus which of its Lots changed recently
let lotVillageCache = null;
function lotVillage(id) {
  if (!lotVillageCache || lotVillageCache.full !== full) {
    const B = 8, grid = new Map(); for (const c of cells) { const k = Math.floor(c.x / B) + ',' + Math.floor(c.z / B); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
    const map = new Map();
    for (const [lid, [x, z]] of full.lots) { let best = null, bd = Infinity; const gx = Math.floor(x / B), gz = Math.floor(z / B);
      for (let a = gx - 1; a <= gx + 1; a++) for (let b = gz - 1; b <= gz + 1; b++) for (const c of grid.get(a + ',' + b) ?? []) { const d = Math.hypot(c.x - x, c.z - z); if (d < bd) { bd = d; best = c; } }
      if (best) map.set(lid, best.village); }
    lotVillageCache = { full, map };
  }
  return lotVillageCache.map.get(id);
}
function clusters(t, window) {
  const m = new Map();
  for (const lot of lots) {
    if (lot.from > t) continue;
    const alive = t < lot.to, recent = lot.from > t - window || (lot.to <= t && lot.to > t - window) || lot.keys.some(([kt]) => kt <= t && kt > t - window);
    if (!alive && !recent) continue;
    const v = lotVillage(lot.id), p = full.lots.get(lot.id); if (!v || !p) continue;
    if (!m.has(v)) m.set(v, { v, pts: [], changed: [] });
    const e = m.get(v); if (alive) e.pts.push(p); if (recent) e.changed.push(p);
  }
  for (const e of m.values()) {
    const src = e.pts.length ? e.pts : e.changed;
    e.cx = src.reduce((a, p) => a + p[0], 0) / src.length; e.cz = src.reduce((a, p) => a + p[1], 0) / src.length;
    const ds = src.map(p => Math.hypot(p[0] - e.cx, p[1] - e.cz)).sort((a, b) => a - b); e.r = Math.max(4, ds[Math.floor(ds.length * 0.8)] ?? 4);
    if (e.changed.length) { e.chx = e.changed.reduce((a, p) => a + p[0], 0) / e.changed.length; e.chz = e.changed.reduce((a, p) => a + p[1], 0) / e.changed.length; }
  }
  return [...m.values()];
}
let tour = null;
function buildTour() {
  const RH = horizonRadius(), busiest = villageActivity(T - 1).slice(0, 6).map(x => x[0]);
  const reduced = simReducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || camStyle === 'C') {
    // postcards: an establishing shot, then the busiest clusters of standing Buildings. The camera sits low on the inner
    // side of each cluster and looks outwards and slightly up, so the countryside and horizon fill the background.
    const shots = [{ pos: V3(RH * 0.35, RH * 0.75, RH * 0.95), look: V3(0, 0, 0), name: 'The whole land' }];
    const top = clusters(T - 1, 120).filter(c => c.pts.length >= 4).sort((a, b) => (b.changed.length * 3 + b.pts.length) - (a.changed.length * 3 + a.pts.length)).slice(0, 6);
    top.forEach((c, i) => {
      const d = Math.hypot(c.cx, c.cz), ux = d > 1 ? c.cx / d : 1, uz = d > 1 ? c.cz / d : 0, side = i % 2 ? 0.45 : -0.45;
      // street level: Buildings are only a few units tall, so the camera stands just above them, a little way back, and aims
      // at the middle of the cluster at about Building height. Nearly level, so the countryside and horizon show behind them.
      const dx = ux * Math.cos(side) - uz * Math.sin(side), dz = ux * Math.sin(side) + uz * Math.cos(side), back = c.r * 1.6 + 5, h = 1.5 + c.r * 0.15;
      shots.push({ pos: V3(c.cx - dx * back, h, c.cz - dz * back), look: V3(c.cx + dx * c.r * 0.3, 0.9, c.cz + dz * c.r * 0.3), centre: V3(c.cx, h, c.cz), name: villageName(c.v) });
    });
    tour = { kind: 'shots', shots, reduced };
    return;
  }
  if (camStyle === 'A') {
    // grand tour: a high sweep around the land, then a lower glide past each busy village, back out again
    const pts = [], looks = [];
    for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2; pts.push(V3(Math.cos(a) * RH * 0.9, RH * 0.55, Math.sin(a) * RH * 0.9)); looks.push(V3(0, 0, 0)); }
    for (const v of busiest) { const r = vRadius(v), a = Math.atan2(v.seed[1], v.seed[0]);
      pts.push(V3(v.seed[0] + Math.cos(a + 0.9) * r * 1.4, r * 0.8 + 5, v.seed[1] + Math.sin(a + 0.9) * r * 1.4)); looks.push(V3(v.seed[0], 0, v.seed[1])); }
    tour = { kind: 'curve', pos: new THREE.CatmullRomCurve3(pts, true, 'centripetal'), look: new THREE.CatmullRomCurve3(looks, true, 'centripetal'), secs: 70 + busiest.length * 12 };
    return;
  }
  // drone: follow roads from the busiest village, visiting neighbours, low over the ground and looking ahead
  const pts = [], used = new Set(); let v = busiest[0] ?? full.villages[0];
  for (let step = 0; step < 9; step++) {
    const opts = roads.filter(r => !r.track && (r.a === v || r.b === v) && !used.has(r)).sort((a, b) => a.pts.length - b.pts.length);
    const r = opts[0] ?? roads.find(r => (r.a === v || r.b === v) && !used.has(r)); if (!r) break; used.add(r);
    const seq = r.a === v ? r.pts : [...r.pts].reverse();
    for (let i = 0; i < seq.length; i += 3) { const [x, z] = seq[i]; pts.push(V3(x, Math.max(0, terrainH(x, z, STYLES.A)) + 5, z)); }
    v = r.a === v ? r.b : r.a;
  }
  if (pts.length < 4) { camStyle = 'A'; return buildTour(); }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  tour = { kind: 'drone', pos: curve, secs: curve.getLength() / 6 };
}
const villageName = v => { const p = v.node.names[0][1]; return p ? p.split('/').pop() : 'the old town'; };
// state machine: off (history playing or not at the end) / flying / paused (interrupted, counting down to resume)
const show = { state: 'off', u: 0, idle: 0, shot: 0, shotT: 0, from: null, fromLook: null };
function showcaseInterrupt() { if (show.state === 'flying') show.state = 'paused'; show.idle = 0; }
function showcaseStart() { buildTour(); show.state = 'flying'; show.u = 0; show.shot = 0; show.shotT = 0; show.from = camera.position.clone(); show.fromLook = controls.target.clone(); show.blend = tour.reduced ? 1 : 0; }   // reduced motion cuts instead of flying in
function showcaseFrame(dt, atEnd, playingNow) {
  if (playingNow || !atEnd) { if (show.state !== 'off') show.state = 'off'; show.idle = 0; return; }
  if (show.state === 'off' || show.state === 'paused') { show.idle += dt; if (show.idle >= IDLE_RESUME) showcaseStart(); return; }
  // flying: blend in from wherever the viewer left the camera over the first 2.5 s
  show.blend = Math.min(1, show.blend + dt / 2.5); const b = ease(show.blend);
  let pos, look;
  if (tour.kind === 'shots') {
    const s = tour.shots[show.shot], DUR = 7 / camSpeed, MOVE = tour.reduced ? 0 : 1.8;
    show.shotT += dt;
    const push = tour.reduced ? 0 : Math.min(1, show.shotT / DUR) * 0.15;
    pos = s.pos.clone().lerp(s.centre ?? s.look, push); look = s.look.clone();
    if (show.shotT >= DUR) { show.from = camera.position.clone(); show.fromLook = controls.target.clone(); show.shot = (show.shot + 1) % tour.shots.length; show.shotT = 0; show.blend = tour.reduced ? 1 : 1 - Math.min(1, MOVE / 2.5) + 0.0001; if (!tour.reduced) show.blend = 0; }
    $('cam-caption').textContent = s.name;
  } else {
    show.u = (show.u + dt * camSpeed / tour.secs) % 1;
    pos = tour.pos.getPointAt(tour.kind === 'drone' ? show.u : show.u);
    look = tour.kind === 'drone' ? tour.pos.getPointAt(Math.min(1, show.u + 12 / tour.pos.getLength())).setY(0) : tour.look.getPointAt(show.u);
    if (tour.kind === 'drone' && show.u > 0.995) show.u = 0;
    $('cam-caption').textContent = '';
  }
  camera.position.copy(show.from.clone().lerp(pos, b)); controls.target.copy(show.fromLook.clone().lerp(look, b));
  camera.lookAt(controls.target);   // controls.update() is skipped while flying, so face the target here
}
// during playback: focus on the cluster with the most changes right now (new, changed or removed files in the last 15
// commits), centred on those changes. Switch only when another cluster is clearly busier, so the camera doesn't jitter.
const follow = { v: null, goal: null, acc: 0 };
function followFrame(dt, t) {
  if (!followDuringPlay) return;
  follow.acc += dt;
  if (follow.acc > 0.4 || !follow.goal) {
    follow.acc = 0;
    const cs = clusters(t, 15).filter(c => c.changed.length).sort((a, b) => b.changed.length - a.changed.length);
    if (cs.length) {
      const cur = cs.find(c => c.v === follow.v), best = cs[0];
      const pick = cur && cur.changed.length * 1.5 >= best.changed.length ? cur : best;
      follow.v = pick.v; follow.goal = V3(pick.chx, 0, pick.chz);
    }
  }
  if (!follow.goal) return;
  const k = 1 - Math.exp(-dt * 0.8), off = camera.position.clone().sub(controls.target);
  controls.target.lerp(follow.goal, k); camera.position.copy(controls.target).add(off);
}
