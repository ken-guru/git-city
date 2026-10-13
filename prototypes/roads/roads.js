
// ---------- Roads and Lanes (git-city#20) ----------
// Direction is real: package A has a Lane towards package B when A's manifest declares B (A imports B).
// Strength over time is a STAND-IN: 1 + how often A and B changed together in the last 150 commits (no import data in the
// API fetch). Lanes per direction = 1 + floor(log2(strength) / 2), capped. A road is a curved ribbon with asymmetric halves.
const LW = 0.34, TRACK = 0.22, MAXL = 4, MAXL_NET = 6, WINDOW = 150;
let net = 'A';
function connectionModel(vl) {
  const M = DATA.manifests ?? {}, byName = new Map(Object.entries(M).map(([d, m]) => [m.name, d]));
  const pkgDirs = Object.keys(M).filter(d => dirByPath.has(d));
  // per commit: which packages were touched
  const touched = COMMITS.map(([, ev]) => { const s = new Set(); for (const e of ev) { const p = PATHS[e[1]]; for (const d of pkgDirs) if (p.startsWith(d + '/')) s.add(d); } return s; });
  const villageOfDir = d => { const n = neighbourhoodOf(dirByPath.get(d)); const k = vl.villageOf.get(n.id); return k ? vl.villageMap.get(k) : null; };
  const pairs = new Map();          // 'vA|vB' (A imports B) -> [{a, b, born}]
  for (const a of pkgDirs) for (const dep of M[a].deps) {
    const b = byName.get(dep); if (!b || !dirByPath.has(b)) continue;
    const va = villageOfDir(a), vb = villageOfDir(b); if (!va || !vb || va === vb) continue;
    const born = Math.max(dirByPath.get(a).born, dirByPath.get(b).born, va.born, vb.born);
    const key = va.key + '|' + vb.key; if (!pairs.has(key)) pairs.set(key, { va, vb, edges: [] });
    pairs.get(key).edges.push({ a, b, born });
  }
  const strength = (edges, t) => { let w = 0; for (const e of edges) { if (e.born > t) continue; let c = 0; for (let k = Math.max(0, t - WINDOW + 1); k <= t; k++) if (touched[k].has(e.a) && touched[k].has(e.b)) c++; w += 1 + c; } return w; };
  return { pairs, strength };
}
const lanesFor = (w, cap) => w > 0 ? Math.min(cap, 1 + Math.floor(Math.log2(w) / 2)) : 0;
function curvePoints(a, b, seed, trimA, trimB) {
  // a cubic Bézier between village centres, bowed sideways by a seeded amount, sampled about every 0.8 units
  const r = rngF(seed), dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), nx = -dz / L, nz = dx / L;
  const o1 = (r() - 0.5) * 0.5 * L, o2 = (r() - 0.5) * 0.5 * L;
  const c1 = [a[0] + dx / 3 + nx * o1, a[1] + dz / 3 + nz * o1], c2 = [a[0] + 2 * dx / 3 + nx * o2, a[1] + 2 * dz / 3 + nz * o2];
  const n = Math.max(8, Math.ceil(L / 0.8)), pts = [];
  for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u;
    const x = v * v * v * a[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * b[0], z = v * v * v * a[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * b[1];
    const wob = (fbm(x * 0.06, z * 0.06, seed, 2) - 0.5) * 1.2; pts.push([x + nx * wob, z + nz * wob]); }
  return pts;
}
// road surface + markings, widths and visible span driven by uniforms so Lanes can ease without rebuilding geometry
function roadMaterial(kind, U) {
  const m = new THREE.MeshLambertMaterial({ color: kind === 'surface' ? 0xffffff : kind === 'centre' ? '#d8b64a' : '#f2f2ec', side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: kind === 'surface' ? -1 : -2, polygonOffsetUnits: kind === 'surface' ? -1 : -2 });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
      attribute vec2 aLat; attribute float aSide; attribute float aU; attribute float aDiv; attribute float aAbs;
      uniform float uWL; uniform float uWR; uniform float uLL; uniform float uLR; varying float vU; varying float vHide;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      vU = aU; vHide = 0.0;
      float hw = aSide < 0.0 ? uWL : uWR, lanes = aSide < 0.0 ? uLL : uLR;
      float off = aDiv > 0.0 ? (aDiv / max(lanes, 1.0)) * hw : aDiv < 0.0 ? 0.0 : abs(aSide) * hw;
      if (aDiv > 0.0 && aDiv >= lanes - 0.01) vHide = 1.0;
      if (aDiv < 0.0 && (uWL < 0.01 || uWR < 0.01)) vHide = 1.0;      // centre line only on two-way roads
      transformed.xz += aLat * (sign(aSide) * off + aAbs);`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      uniform float uU0; uniform float uU1; uniform vec3 uTint; varying float vU; varying float vHide;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      if (vU < uU0 || vU > uU1 || vHide > 0.5) discard;
      ${kind === 'surface' ? 'diffuseColor.rgb = uTint;' : ''}`);
  };
  return m;
}
function ribbon(pts, kind, st) {
  // surface: 3 vertices per sample (left edge, centre, right edge). markings: thin strips at lane dividers (dashed) or centre.
  const pos = [], lat = [], side = [], uu = [], div = [], abs = [], idx = [];
  const L = pts.length - 1, Y = (x, z) => { const [d, w] = riverAt(x, z); return d < w + 1.2 ? 0.35 : Math.max(0, terrainH(x, z, st)) + 0.05; };
  const push = (x, z, lx, lz, s, u, dv, ab) => { pos.push(x, Y(x, z), z); lat.push(lx, lz); side.push(s); uu.push(u); div.push(dv); abs.push(ab); return pos.length / 3 - 1; };
  const normalAt = i => { const p = pts[Math.max(0, i - 1)], q = pts[Math.min(L, i + 1)], dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1; return [dz / l, -dx / l]; };   // points left
  if (kind === 'surface') {
    for (let i = 0; i <= L; i++) { const [lx, lz] = normalAt(i), [x, z] = pts[i], u = i / L;
      push(x, z, lx, lz, -1, u, 0, 0); push(x, z, lx, lz, 0, u, 0, 0); push(x, z, lx, lz, 1, u, 0, 0);
      if (i) { const a = (i - 1) * 3, b = i * 3; idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); } }
  } else {
    const strips = kind === 'centre' ? [[-1, -1], [1, -1]] : [];
    if (kind === 'dividers') for (const s of [-1, 1]) for (let d = 1; d < MAXL_NET; d++) strips.push([s, d]);
    for (const [s, dv] of strips) {
      const ab = kind === 'centre' ? 0.03 * s : 0;
      for (let i = 0; i < L; i++) {
        if (kind === 'dividers' && (i % 3) === 2) continue;             // dashes
        const [lx, lz] = normalAt(i), [lx2, lz2] = normalAt(i + 1), [x, z] = pts[i], [x2, z2] = pts[i + 1];
        const w = 0.025, a = push(x, z, lx, lz, s, i / L, dv, ab - w), b = push(x, z, lx, lz, s, i / L, dv, ab + w), c = push(x2, z2, lx2, lz2, s, (i + 1) / L, dv, ab - w), e = push(x2, z2, lx2, lz2, s, (i + 1) / L, dv, ab + w);
        idx.push(a, c, b, b, c, e);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aLat', new THREE.Float32BufferAttribute(lat, 2));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1)); g.setAttribute('aU', new THREE.Float32BufferAttribute(uu, 1));
  g.setAttribute('aDiv', new THREE.Float32BufferAttribute(div, 1)); g.setAttribute('aAbs', new THREE.Float32BufferAttribute(abs, 1));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// villages' radius over time, so roads stop at the edge of town
function villageRadius(v, t) { let r = CW; for (const c of cells) if (c.village === v && c.born <= t) r = Math.max(r, Math.hypot(c.x - v.seed[0], c.z - v.seed[1]) + CW * 0.6); return r; }
let roads = [], roadGroup = null, roadStats = { roads: 0, maxLanes: 0 };
function buildRoads() {
  if (roadGroup) { scene.remove(roadGroup); roadGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
  roadGroup = new THREE.Group(); scene.add(roadGroup); roads = [];
  const st = STYLES.A, model = connectionModel(full);
  const KEY = 5, keys = []; for (let t = 0; t < T; t += KEY) keys.push(t); keys.push(T - 1);
  const V = full.villages;
  // links to draw: [{a, b (villages), flows: [[t, fwd, back]]}] where fwd = a->b
  let links = [];
  if (net === 'A') {
    const seen = new Map();
    for (const { va, vb, edges } of model.pairs.values()) {
      const [a, b, flip] = va.key < vb.key ? [va, vb, false] : [vb, va, true], key = a.key + '|' + b.key;
      if (!seen.has(key)) seen.set(key, { a, b, fwd: [], back: [] });
      seen.get(key)[flip ? 'back' : 'fwd'].push(...edges);
    }
    for (const l of seen.values()) l.flows = keys.map(t => [t, lanesFor(model.strength(l.fwd, t), MAXL), lanesFor(model.strength(l.back, t), MAXL)]);
    links = [...seen.values()];
    // villages with no connection keep an unpaved track to their nearest older village
    for (const fl of full.links) { const a = V.find(v => v.seed === fl.a), b = V.find(v => v.seed === fl.b); if (!links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))) links.push({ a, b, track: true, flows: [[fl.born, 0, 0]] }); }
  } else {
    // shared network: a relative-neighbourhood graph over village centres; every connection is routed along shortest paths
    const E = [];
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) {
      const p = V[i].seed, q = V[j].seed, d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (V.some((w, k) => k !== i && k !== j && Math.max(Math.hypot(w.seed[0] - p[0], w.seed[1] - p[1]), Math.hypot(w.seed[0] - q[0], w.seed[1] - q[1])) < d)) continue;
      E.push({ a: V[i], b: V[j], d, fwd: [], back: [] });
    }
    const adj = new Map(V.map(v => [v, []])); for (const e of E) { adj.get(e.a).push(e); adj.get(e.b).push(e); }
    const path = (s, g) => {                     // Dijkstra over the network
      const dist = new Map([[s, 0]]), prev = new Map(), open = new Set([s]);
      while (open.size) { let u = null; for (const x of open) if (!u || dist.get(x) < dist.get(u)) u = x; open.delete(u); if (u === g) break;
        for (const e of adj.get(u)) { const w = e.a === u ? e.b : e.a, nd = dist.get(u) + e.d; if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, [u, e]); open.add(w); } } }
      const out = []; for (let x = g; prev.has(x); x = prev.get(x)[0]) out.push([prev.get(x)[0], prev.get(x)[1], x]); return out;
    };
    for (const { va, vb, edges } of model.pairs.values()) for (const [from, e] of path(va, vb)) (e.a === from ? e.fwd : e.back).push(...edges);
    for (const e of E) e.flows = keys.map(t => [t, lanesFor(model.strength(e.fwd, t), MAXL_NET), lanesFor(model.strength(e.back, t), MAXL_NET)]);
    links = E.map(e => ({ a: e.a, b: e.b, flows: e.flows, track: !e.fwd.length && !e.back.length }));
  }
  const tint = new THREE.Color(isDark() ? '#3d4440' : '#7d857f'), trackTint = new THREE.Color(isDark() ? '#5a5144' : '#b8a88a');
  for (const l of links) {
    const pts = curvePoints(l.a.seed, l.b.seed, l.a.node.id * 977 + l.b.node.id * 131);
    const U = { uWL: { value: 0 }, uWR: { value: 0 }, uLL: { value: 0 }, uLR: { value: 0 }, uU0: { value: 0 }, uU1: { value: 0 }, uTint: { value: l.track ? trackTint : tint } };
    const surf = new THREE.Mesh(ribbon(pts, 'surface', st), roadMaterial('surface', U));
    const centre = new THREE.Mesh(ribbon(pts, 'centre', st), roadMaterial('centre', U));
    const divs = new THREE.Mesh(ribbon(pts, 'dividers', st), roadMaterial('dividers', U));
    for (const m of [surf, centre, divs]) { m.frustumCulled = false; roadGroup.add(m); }
    centre.visible = divs.visible = !l.track && $('rd-marks').checked;
    // bridges where the curve crosses a river
    const crossings = []; let wet = -1;
    pts.forEach((p, i) => { const [d, w] = riverAt(p[0], p[1]), isWet = d < w + 1.2; if (isWet && wet < 0) wet = i; if (!isWet && wet >= 0) { crossings.push([wet, i]); wet = -1; } });
    const bridges = crossings.map(([i0, i1]) => { const p = pts[Math.max(0, i0 - 1)], q = pts[Math.min(pts.length - 1, i1)], m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.16, 1), new THREE.MeshLambertMaterial({ color: isDark() ? '#6b6157' : '#a8988a' }));
      m.position.set((p[0] + q[0]) / 2, 0.24, (p[1] + q[1]) / 2); m.rotation.y = Math.atan2(-(q[1] - p[1]), q[0] - p[0]); m.userData.len = Math.hypot(q[0] - p[0], q[1] - p[1]) + 0.6; m.userData.u = (i0 + i1) / 2 / (pts.length - 1); roadGroup.add(m); return m; });
    const born = Math.max(l.a.born, l.b.born, l.track ? 0 : (l.flows.find(f => f[1] + f[2] > 0)?.[0] ?? Infinity));
    roads.push({ ...l, pts, U, surf, centre, divs, bridges, born, len: pts.length });
  }
  roadStats.roads = roads.filter(r => !r.track).length;
  roadStats.maxLanes = Math.max(0, ...roads.map(r => Math.max(...r.flows.map(f => Math.max(f[1], f[2])))));
  lastRoadT = null;
}
let lastRoadT = null;
function lanesAt(r, t) {                         // eased lanes per direction at commit-time t
  const f = r.flows; let i = 0; while (i + 1 < f.length && f[i + 1][0] <= t) i++;
  const prev = i ? f[i - 1] : [0, 0, 0], cur = f[i], k = ease((t - cur[0]) / D);
  return [prev[1] + (cur[1] - prev[1]) * k, prev[2] + (cur[2] - prev[2]) * k, cur[1], cur[2]];
}
function roadsFrame(t) {
  if (lastRoadT !== null && Math.abs(t - lastRoadT) < 0.02) return; lastRoadT = t;
  for (const r of roads) {
    const g = t < r.born ? 0 : ease((t - r.born) / (D * 2));
    if (!g) { r.U.uU1.value = -1; r.bridges.forEach(b => b.visible = false); continue; }
    const ra = villageRadius(r.a, t), rb = villageRadius(r.b, t), L = r.pts.length;
    let len = 0; for (let i = 1; i < L; i++) len += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
    const u0 = Math.min(0.45, ra / len), u1 = Math.max(0.55, 1 - rb / len);
    r.U.uU0.value = u0; r.U.uU1.value = u0 + (u1 - u0) * g;            // built outwards from the older village
    if (r.track) { r.U.uWL.value = r.U.uWR.value = TRACK / 2; r.U.uLL.value = r.U.uLR.value = 0; }
    else { const [fw, bk, tf, tb] = lanesAt(r, t); r.U.uWL.value = fw * LW; r.U.uWR.value = bk * LW; r.U.uLL.value = tf; r.U.uLR.value = tb;
      if (fw + bk < 0.05) { r.U.uWL.value = r.U.uWR.value = TRACK / 2; } }
    for (const b of r.bridges) { b.visible = r.U.uU1.value >= b.userData.u; b.scale.set(b.userData.len, 1, Math.max(TRACK, r.U.uWL.value + r.U.uWR.value) + 0.3); }
  }
}
