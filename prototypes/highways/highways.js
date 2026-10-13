
// ---------- Highways and External Cities (git-city#22) ----------
// External Dependencies are real: every package.json revision in the history was fetched, so a dependency arrives and leaves
// when a manifest added or dropped it. They are grouped by npm scope, or by a shared name prefix; the top N groups get their
// own External City, the rest share the Outskirts. Lanes are a STAND-IN: the number of declaring packages in the District
// (the real measure is importing files). Arrival: the city fades in on the horizon, then its Highway is built. Departure:
// the Highway is dismantled, then the city fades away.
let hwVariant = 'A', topN = 8;
const EXT_NAMES = ['Thornwick', 'Ashbury', 'Kettlemere', 'Wexford Vale', 'Harrowgate', 'Millbrook', 'Ravensholm', 'Coldharbour', 'Fennick', 'Oakhampton', 'Brightwater', 'Stonecross', 'Larkspur', 'Hollowell'];
function externalModel() {
  const H = DATA.manifestHistory ?? [], internal = new Set(H.map(r => r.name).filter(Boolean));
  // spans per (declaring dir, dependency)
  const byPath = new Map(); for (const r of H) { if (!byPath.has(r.path)) byPath.set(r.path, []); byPath.get(r.path).push(r); }
  const spans = [];   // {dir, dep, from, to}
  for (const [p, revs] of byPath) {
    revs.sort((a, b) => a.i - b.i);
    const dir = dirname(p), open = new Map();
    for (const r of revs) {
      const now = new Set(r.gone ? [] : r.deps.map(([d]) => d).filter(d => !internal.has(d)));
      for (const d of now) if (!open.has(d)) open.set(d, r.i);
      for (const [d, from] of [...open]) if (!now.has(d)) { spans.push({ dir, dep: d, from, to: r.i }); open.delete(d); }
    }
    for (const [d, from] of open) spans.push({ dir, dep: d, from, to: Infinity });
  }
  // group by scope, or by a prefix that at least two dependencies share
  const names = [...new Set(spans.map(s => s.dep))], prefixCount = new Map();
  for (const n of names) if (!n.startsWith('@') && n.includes('-')) { const p = n.split('-')[0]; prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1); }
  const groupOf = n => n.startsWith('@') ? n.split('/')[0] : n.includes('-') && prefixCount.get(n.split('-')[0]) > 1 ? n.split('-')[0] : n;
  for (const s of spans) s.group = groupOf(s.dep);
  // weight: how many (declaring dir, dependency) pairs a group ever had; the top N become their own External City
  const weight = new Map(); for (const s of spans) weight.set(s.group, (weight.get(s.group) ?? 0) + 1);
  const groups = [...weight].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const own = new Set(groups.slice(0, topN).map(g => g[0]));
  for (const s of spans) s.city = own.has(s.group) ? s.group : '(outskirts)';
  return { spans, groups, own, depCount: names.length };
}
let externals = [], hwGroup = null, hwStats = {};
function horizonRadius() { let r = 40; for (const c of cells) r = Math.max(r, Math.hypot(c.x, c.z)); return r + 70; }
function buildHighways() {
  if (hwGroup) { scene.remove(hwGroup); hwGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); for (const l of o.userData.labels ?? []) l.element.remove(); }); }
  for (const e of externals) e.label?.element.remove();
  hwGroup = new THREE.Group(); scene.add(hwGroup); externals = [];
  const m = externalModel(), V = full.villages, RH = horizonRadius(), st = STYLES.A;
  const villageOfDir = d => { const node = dirByPath.get(d) ?? (d === '' ? root : null); if (!node) return null; const n = d === '' ? root : neighbourhoodOf(node); const k = full.villageOf.get(n.id); return k ? full.villageMap.get(k) : null; };
  for (const s of m.spans) s.village = villageOfDir(s.dir);
  const spans = m.spans.filter(s => s.village);
  // External Cities: placed once, in the direction of the villages that first declared them, kept apart by angle
  const cityNames = [...new Set(spans.map(s => s.city))];
  const placed = [];
  const ordered = cityNames.map(c => ({ c, from: Math.min(...spans.filter(s => s.city === c).map(s => s.from)) })).sort((a, b) => a.from - b.from);
  const sky = new THREE.Color(css('--sky'));
  ordered.forEach(({ c, from }, idx) => {
    const first = spans.filter(s => s.city === c && s.from === from);
    let ax = 0, az = 0; for (const s of first) { ax += s.village.seed[0]; az += s.village.seed[1]; }
    let ang = Math.atan2(az, ax) || rngF(idx + 5)() * Math.PI * 2;
    for (let tries = 0; tries < 40 && placed.some(a => Math.abs(Math.atan2(Math.sin(a - ang), Math.cos(a - ang))) < 0.32); tries++) ang += (tries % 2 ? -1 : 1) * 0.11 * (tries + 1);
    placed.push(ang);
    const outskirts = c === '(outskirts)', cx = Math.cos(ang) * (RH + (outskirts ? 18 : 30)), cz = Math.sin(ang) * (RH + (outskirts ? 18 : 30));
    // silhouette: hazy towers sized by weight; the Outskirts is a low sprawl
    const w = spans.filter(s => s.city === c).length, r = rngF(idx * 101 + 3), parts = [];
    const n = outskirts ? 34 : 6 + Math.round(3 * Math.sqrt(w)), spread = outskirts ? 16 : 5 + Math.sqrt(w);
    for (let k = 0; k < n; k++) { const h = outskirts ? 0.6 + r() * 1.6 : 3 + r() * (5 + Math.sqrt(w) * 1.5), bw = 1 + r() * 1.6, a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      parts.push(new THREE.BoxGeometry(bw, h, bw).translate(cx + Math.cos(a) * d, h / 2, cz + Math.sin(a) * d)); }
    const geo = mergeBoxes(parts), colour = new THREE.Color(isDark() ? '#6c7a86' : '#8c9aa6').lerp(sky, 0.35);
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: colour, transparent: true, opacity: 0, depthWrite: false }));
    hwGroup.add(mesh);
    const el = document.createElement('div'); el.className = 'label'; el.style.setProperty('--c', '#' + colour.getHexString());
    el.innerHTML = `${outskirts ? 'The Outskirts' : EXT_NAMES[idx % EXT_NAMES.length]}<small>${outskirts ? 'everything minor' : c}</small>`;
    const label = new CSS2DObject(el); label.position.set(cx, (outskirts ? 3 : 10), cz); hwGroup.add(label);
    externals.push({ c, ang, x: cx, z: cz, mesh, el, label, outskirts, spans: spans.filter(s => s.city === c) });
  });
  // Highways: per (village, External City) in A; per village access road + orbital ring + spurs in B
  const hws = [];
  const lanesOf = n => n > 0 ? Math.min(4, 1 + Math.floor(Math.log2(n))) : 0;
  const KEY = 5, keys = []; for (let t = 0; t < T; t += KEY) keys.push(t); keys.push(T - 1);
  const countAt = (list, t) => list.filter(s => s.from <= t && t < s.to).length;
  const vEdge = v => { let r = CW; for (const c of cells) if (c.village === v) r = Math.max(r, Math.hypot(c.x - v.seed[0], c.z - v.seed[1]) + CW * 0.6); return r; };
  if (hwVariant === 'A') {
    for (const e of externals) {
      const byV = new Map(); for (const s of e.spans) { if (!byV.has(s.village)) byV.set(s.village, []); byV.get(s.village).push(s); }
      for (const [v, list] of byV) hws.push({ a: v.seed, b: [e.x, e.z], trimA: vEdge(v), trimB: e.outskirts ? 14 : 8, ext: e, flows: keys.map(t => [t, lanesOf(countAt(list, t))]), seed: v.node.id * 31 + e.ang * 1000 });
    }
  } else {
    // ring at the horizon; one access road per village; one spur per External City
    const ringR = RH, angOf = (x, z) => Math.atan2(z, x);
    const NSEG = 96, segFlow = Array.from({ length: NSEG }, () => new Map());   // per segment: t -> count, built below
    const access = new Map();
    for (const s of spans) { if (!access.has(s.village)) access.set(s.village, []); access.get(s.village).push(s); }
    for (const [v, list] of access) { const a = angOf(v.seed[0], v.seed[1]) || 0; hws.push({ a: v.seed, b: [Math.cos(a) * ringR, Math.sin(a) * ringR], trimA: vEdge(v), trimB: 0, flows: keys.map(t => [t, lanesOf(countAt(list, t))]), seed: v.node.id * 17, straightish: true, ext: null, list }); }
    for (const e of externals) hws.push({ a: [Math.cos(e.ang) * ringR, Math.sin(e.ang) * ringR], b: [e.x, e.z], trimA: 0, trimB: e.outskirts ? 14 : 8, ext: e, flows: keys.map(t => [t, lanesOf(countAt(e.spans, t))]), seed: e.ang * 777, straightish: true });
    // ring segments carry every span between its village's access point and its city's spur, along the shorter arc
    const segOf = a => ((Math.floor((a + Math.PI) / (2 * Math.PI) * NSEG) % NSEG) + NSEG) % NSEG;
    const ringLists = Array.from({ length: NSEG }, () => []);
    for (const s of spans) { const e = externals.find(x => x.c === s.city), a0 = segOf(angOf(s.village.seed[0], s.village.seed[1]) || 0), a1 = segOf(e.ang);
      let d = ((a1 - a0) % NSEG + NSEG) % NSEG, step = 1; if (d > NSEG / 2) { d = NSEG - d; step = -1; }
      for (let k = 0, i = a0; k < d; k++, i = (i + step + NSEG) % NSEG) ringLists[i].push(s); }
    for (let i = 0; i < NSEG; i++) {
      const a0 = -Math.PI + i / NSEG * 2 * Math.PI, a1 = -Math.PI + (i + 1) / NSEG * 2 * Math.PI;
      hws.push({ a: [Math.cos(a0) * ringR, Math.sin(a0) * ringR], b: [Math.cos(a1) * ringR, Math.sin(a1) * ringR], trimA: 0, trimB: 0, ring: true, flows: keys.map(t => [t, lanesOf(countAt(ringLists[i], t))]), seed: i, straightish: true, list: ringLists[i] });
    }
  }
  // geometry: reuse the road ribbon with a darker surface, white markings, a wider minimum, and bridges
  const tint = new THREE.Color(isDark() ? '#2b302d' : '#5b625d');
  hwStats = { deps: m.depCount, groups: m.groups.length, cities: externals.length, highways: 0, maxLanes: 0 };
  for (const h of hws) {
    const maxL = Math.max(...h.flows.map(f => f[1])); if (!maxL) continue;
    const pts = h.straightish ? straightPoints(h.a, h.b, h.seed) : curvePoints(h.a, h.b, Math.floor(h.seed));
    const U = { uWL: { value: 0 }, uWR: { value: 0 }, uLL: { value: 0 }, uLR: { value: 0 }, uU0: { value: 0 }, uU1: { value: -1 }, uTint: { value: tint } };
    const surf = new THREE.Mesh(ribbon(pts, 'surface', st), roadMaterial('surface', U)), divs = new THREE.Mesh(ribbon(pts, 'dividers', st), roadMaterial('dividers', U)), centre = new THREE.Mesh(ribbon(pts, 'centre', st), roadMaterial('centre', U));
    centre.material.color = new THREE.Color('#e9e9e2');
    for (const o of [surf, divs, centre]) { o.frustumCulled = false; hwGroup.add(o); }
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    h.U = U; h.len = len; h.pts = pts; hwStats.highways++; hwStats.maxLanes = Math.max(hwStats.maxLanes, maxL);
  }
  highwaysList = hws.filter(h => h.U);
  lastHwT = null;
}
let highwaysList = [], lastHwT = null;
function mergeBoxes(parts) { const pos = [], nor = [], idx = []; let off = 0; for (const g of parts) { const ng = g.index ? g.toNonIndexed() : g; pos.push(...ng.attributes.position.array); nor.push(...ng.attributes.normal.array); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); return g; }
function straightPoints(a, b, seed) { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), n = Math.max(4, Math.ceil(L / 1.2)), nx = -dz / L, nz = dx / L, bow = (rngF(Math.floor(seed) + 9)() - 0.5) * 0.12 * L, pts = [];
  for (let i = 0; i <= n; i++) { const u = i / n, o = Math.sin(u * Math.PI) * bow; pts.push([a[0] + dx * u + nx * o, a[1] + dz * u + nz * o]); } return pts; }
// a span's life: the city fades in, then its Highway is built; on departure the Highway is dismantled, then the city fades away
const FADE = 4, BUILD = 8;
function highwaysFrame(t) {
  if (lastHwT !== null && Math.abs(t - lastHwT) < 0.02) return; lastHwT = t;
  for (const e of externals) {
    // the city exists from its first arrival until its last Highway is gone
    let alpha = 0;
    for (const s of e.spans) {
      const inA = ease((t - s.from) / FADE), outA = s.to === Infinity ? 1 : 1 - ease((t - s.to - BUILD) / FADE);
      if (t >= s.from) alpha = Math.max(alpha, Math.min(inA, outA));
    }
    e.mesh.material.opacity = alpha * 0.85; e.mesh.visible = alpha > 0.01;
    e.el.style.opacity = alpha > 0.3 && $('showLabels').checked ? alpha : 0;
  }
  for (const h of highwaysList) {
    const f = h.flows; let i = 0; while (i + 1 < f.length && f[i + 1][0] <= t) i++;
    const prev = i ? f[i - 1][1] : 0, cur = f[i][1];
    // building: starts after the city has faded in; dismantling: before it fades out
    const firstOn = f.find(x => x[1] > 0)?.[0] ?? Infinity, lastOn = [...f].reverse().find(x => x[1] > 0)?.[0] ?? -1, gone = lastOn < f[f.length - 1][0] ? lastOn + 5 : Infinity;
    let built = t < firstOn + FADE ? 0 : ease((t - firstOn - FADE) / BUILD);
    if (t >= gone) built = Math.min(built, 1 - ease((t - gone) / BUILD));
    const lanes = prev + (cur - prev) * ease((t - f[i][0]) / D);
    const fw = Math.max(lanes, built > 0 ? 1 : 0);
    const u0 = Math.min(0.45, h.trimA / h.len), u1 = Math.max(0.55, 1 - h.trimB / h.len);
    h.U.uU0.value = u0; h.U.uU1.value = built > 0 ? u0 + (u1 - u0) * built : -1;
    h.U.uWL.value = fw * LW * 1.15; h.U.uWR.value = 1 * LW * 1.15; h.U.uLL.value = Math.max(1, Math.round(cur)); h.U.uLR.value = 1;
  }
}
