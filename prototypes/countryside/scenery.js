
// ---------- Countryside (git-city#21): seeded terrain, rivers and decorative scenery ----------
// Everything here is a pure function of the seed: it never depends on the repo and never moves. Villages found and grow on
// the flat plains away from rivers and hills (falling back only when there is nowhere else); scenery gives way, fading out,
// at the moment a Block is claimed next to it, so the landscape at any commit is identical on every run.
const SEED = 20261013;
let nRivers = 2;
function hash2(ix, iz, s) { let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(s, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, z, s) { const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s), c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s); return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w; }
function fbm(x, z, s, oct = 4) { let f = 0, amp = 0.5, fr = 1, tot = 0; for (let i = 0; i < oct; i++) { f += amp * vnoise(x * fr, z * fr, s + i * 17); tot += amp; fr *= 2; amp *= 0.5; } return f / tot; }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const RIVERS = [];
function makeRivers() {
  RIVERS.length = 0; riverMemo.clear(); blockMemo.clear();
  const r = rngF(SEED + 1);
  for (let i = 0; i < nRivers; i++) {
    const ang = r() * Math.PI, off = [24, -70, 95][i] + (r() - 0.5) * 20, dir = [Math.cos(ang), Math.sin(ang)], nrm = [-dir[1], dir[0]], pts = [];
    for (let s = -520; s <= 520; s += 5) { const m = (fbm(s * 0.011 + 3, i * 7.3, SEED + 50 + i, 3) - 0.5) * 90; pts.push([dir[0] * s + nrm[0] * (off + m), dir[1] * s + nrm[1] * (off + m)]); }
    const boxes = []; for (let k = 0; k < pts.length - 1; k += 10) { const seg = pts.slice(k, k + 11); boxes.push([k, Math.min(...seg.map(p => p[0])), Math.min(...seg.map(p => p[1])), Math.max(...seg.map(p => p[0])), Math.max(...seg.map(p => p[1]))]); }
    RIVERS.push({ pts, boxes, w: 2.0 + r() * 1.4 });
  }
}
const riverMemo = new Map();
function riverInfo(x, z) {                      // [distance to the nearest river centreline, that river's half-width]
  let best = Infinity, w = 0;
  for (const rv of RIVERS) for (const [k, x0, z0, x1, z1] of rv.boxes) {
    const bx = Math.max(x0 - x, 0, x - x1), bz = Math.max(z0 - z, 0, z - z1); if (Math.hypot(bx, bz) > best) continue;
    for (let i = k; i < Math.min(k + 10, rv.pts.length - 1); i++) {
      const [ax, az] = rv.pts[i], [cx, cz] = rv.pts[i + 1], dx = cx - ax, dz = cz - az, L = dx * dx + dz * dz, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
      const d = Math.hypot(ax + u * dx - x, az + u * dz - z); if (d < best) { best = d; w = rv.w; }
    }
  }
  return [best, w];
}
function riverAt(x, z) { const k = Math.round(x) + ',' + Math.round(z); let v = riverMemo.get(k); if (!v) { v = riverInfo(Math.round(x), Math.round(z)); riverMemo.set(k, v); } return v; }
function terrainRaw(x, z) {                     // hill and mountain strength, 0..1, before carving by rivers
  const hill = Math.max(0, fbm(x * 0.02, z * 0.02, SEED + 3, 4) - 0.56) / 0.44;
  const far = smooth(110, 230, Math.hypot(x, z));
  const mount = Math.max(0, fbm(x * 0.009 + 40, z * 0.009, SEED + 9, 4) - 0.5) / 0.5 * far;
  return [hill, mount];
}
const terrainMemo = new Map();
function terrainAt(x, z) { const k = Math.round(x) + ',' + Math.round(z); let v = terrainMemo.get(k); if (!v) { v = terrainRaw(Math.round(x), Math.round(z)); terrainMemo.set(k, v); } return v; }
const blockMemo = new Map();
function blockedArea(x, z, lvl) { const k = Math.round(x * 2) + ',' + Math.round(z * 2) + ',' + lvl; let v = blockMemo.get(k); if (v === undefined) { v = blockedAreaRaw(x, z, lvl); blockMemo.set(k, v); } return v; }
function blockedAreaRaw(x, z, lvl) {               // lvl 2: avoid rivers and hills; 1: rivers only; 0: nothing
  if (!lvl) return false;
  const rr = Math.hypot(CW, CH) / 2 * 0.85;
  for (const [ox, oz] of [[0, 0], [rr, 0], [-rr, 0], [0, rr], [0, -rr]]) {
    const [d, w] = riverAt(x + ox, z + oz); if (d < w + 2.5) return true;
    if (lvl >= 2) { const [h, m] = terrainAt(x + ox, z + oz); if (h > 0.1 || m > 0.03) return true; }
  }
  return false;
}
const STYLES = {
  A: { name: 'Muted naturalistic', hill: 2.6, mount: 15, snow: false, forest: 0.6, scatter: 0.012, fields: 0.52, tree: 'cone',
       light: { plain: '#b7c2a0', hill: '#a3ae8c', rock: '#a29d93', snow: '#e9e9e4', water: '#8fb0c0', bank: '#cfc6a6', tree: '#7d9372', field: ['#cdc79f', '#b9c49a', '#c4b59a', '#aebc94'] },
       dark: { plain: '#36443a', hill: '#3e4b3e', rock: '#55524c', snow: '#8b8f8f', water: '#30495a', bank: '#4b4a3c', tree: '#2f4434', field: ['#4a4a36', '#3f4c38', '#4a4236', '#3b4834'] } },
  B: { name: 'Lively diorama', hill: 4.2, mount: 24, snow: true, forest: 0.56, scatter: 0.02, fields: 0.48, tree: 'cone',
       light: { plain: '#a9c18e', hill: '#93ad7a', rock: '#9b9184', snow: '#f4f5f2', water: '#6fa3c4', bank: '#d8c99c', tree: '#5f8a54', field: ['#d9cb84', '#a9c47e', '#c7a87e', '#9cc08a'] },
       dark: { plain: '#30472f', hill: '#37502f', rock: '#5a5249', snow: '#a9adad', water: '#27506a', bank: '#544c35', tree: '#264a2c', field: ['#5a5430', '#3d5530', '#57452f', '#33512f'] } },
  C: { name: 'Tinted map', hill: 0.8, mount: 9, snow: false, forest: 0.6, scatter: 0.0, fields: 0.5, tree: 'blob',
       light: { plain: '#d6dccb', hill: '#cbd2bf', rock: '#c4c0b8', snow: '#e6e6e2', water: '#b4cad6', bank: '#dcd6c2', tree: '#b4c3a8', field: ['#dcd9c2', '#cfd6c0', '#d6cfc0', '#ccd3be'] },
       dark: { plain: '#2a302b', hill: '#2f352f', rock: '#3f3d3a', snow: '#5a5c5c', water: '#2b3d47', bank: '#37362f', tree: '#33402f', field: ['#36362c', '#30382d', '#37332c', '#2f362c'] } },
};
let sv = 'A', sceneryGroup = null, treeInst = null, fieldInst = null, trees = [], fields = [], bridges = [], bridgeInst = null, roadInst = null, roadSegs = [], lastSceneryT = null;
function isDark() { return css('--bg') === '#141a17' || matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light'; }
function terrainH(x, z, st) {
  const [h, m] = terrainRaw(x, z), [d, w] = riverAt(x, z), carve = smooth(w + 0.5, w + 9, d);
  return (h * st.hill + m * m * st.mount) * carve;
}
// when a decoration at (x, z) with radius r gives way: the birth of the first Block that reaches it
function clearTimes(items, r) {
  const B = 8, grid = new Map();
  for (const c of cells) { const k = Math.floor(c.x / B) + ',' + Math.floor(c.z / B); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
  const reach = Math.hypot(CW, CH) / 2 + 0.6;
  for (const it of items) {
    let t = Infinity; const gx = Math.floor(it.x / B), gz = Math.floor(it.z / B);
    for (let a = gx - 2; a <= gx + 2; a++) for (let b = gz - 2; b <= gz + 2; b++) for (const c of grid.get(a + ',' + b) ?? []) if (c.born < t && Math.hypot(c.x - it.x, c.z - it.z) < reach + (it.r ?? r)) t = c.born;
    it.clear = t;
  }
}
function buildScenery() {
  if (sceneryGroup) { scene.remove(sceneryGroup); sceneryGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
  sceneryGroup = new THREE.Group(); sceneryGroup.name = 'scenery'; scene.add(sceneryGroup);
  const flat = scene.getObjectByName('flatGround'); if (flat) flat.visible = !$('sc-on').checked;
  for (const n of ['countryTrees']) { const o = scene.getObjectByName(n); if (o) o.visible = !$('sc-on').checked; }
  if (linkMesh) linkMesh.visible = !$('sc-on').checked;
  lastSceneryT = null;
  if (!$('sc-on').checked) { trees = []; fields = []; bridges = []; roadSegs = []; return; }
  const st = STYLES[sv], pal = isDark() ? st.dark : st.light, C = h => new THREE.Color(h);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of cells) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z); }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, size = Math.max(maxX - minX, maxZ - minZ) + 220, SEG = 220;
  // ground: one subdivided plane, heights and vertex colours from the terrain
  const g = new THREE.PlaneGeometry(size, size, SEG, SEG); g.rotateX(-Math.PI / 2); g.translate(cx, 0, cz);
  const P = g.attributes.position, col = new Float32Array(P.count * 3), tmp = new THREE.Color();
  const cPlain = C(pal.plain), cHill = C(pal.hill), cRock = C(pal.rock), cSnow = C(pal.snow), cBank = C(pal.bank), cWater = C(pal.water);
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), z = P.getZ(i), [h, m] = terrainRaw(x, z), [d, w] = riverAt(x, z), y = terrainH(x, z, st);
    P.setY(i, y - (d < w ? 0.25 : 0));
    tmp.copy(cPlain).lerp(cHill, Math.min(1, h * 1.6)).lerp(cRock, smooth(0.15, 0.55, m));
    if (st.snow && y > st.mount * 0.5) tmp.lerp(cSnow, smooth(st.mount * 0.5, st.mount * 0.7, y));
    if (d < w + 1.5) tmp.lerp(cBank, 1 - smooth(w, w + 1.5, d));
    if (d < w) tmp.copy(cWater);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: sv !== 'C' }));
  ground.position.y = -0.03; sceneryGroup.add(ground);
  // water surface: a flat ribbon along each river
  for (const rv of RIVERS) {
    const pos = [], idx = [];
    rv.pts.forEach((p, i) => { const q = rv.pts[Math.min(i + 1, rv.pts.length - 1)], o = rv.pts[Math.max(i - 1, 0)], dx = q[0] - o[0], dz = q[1] - o[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L, nz = dx / L;
      pos.push(p[0] + nx * rv.w, -0.08, p[1] + nz * rv.w, p[0] - nx * rv.w, -0.08, p[1] - nz * rv.w); if (i) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); } });
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); wg.setIndex(idx); wg.computeVertexNormals();
    sceneryGroup.add(new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color: pal.water, side: THREE.DoubleSide })));
  }
  const rnd = rngF(SEED + 7), x0 = cx - size / 2, z0 = cz - size / 2;
  // fields: muted patchwork on the plains
  fields = [];
  for (let gx = x0; gx < x0 + size; gx += 5.5) for (let gz = z0; gz < z0 + size; gz += 5.5) {
    const x = gx + rnd() * 3, z = gz + rnd() * 3;
    if (fbm(x * 0.03, z * 0.03, SEED + 21, 3) < st.fields) continue;
    const [h, m] = terrainRaw(x, z), [d, w] = riverAt(x, z); if (h > 0.05 || m > 0.02 || d < w + 2) continue;
    fields.push({ x, z, w: 3 + rnd() * 2.2, d: 2 + rnd() * 2, a: fbm(x * 0.01, z * 0.01, SEED + 22, 2) * Math.PI, c: pal.field[Math.floor(rnd() * 4)], r: 2.5 });
  }
  // forests: clusters where the forest noise is high, plus a few scattered trees
  trees = [];
  for (let gx = x0; gx < x0 + size; gx += 1.7) for (let gz = z0; gz < z0 + size; gz += 1.7) {
    const x = gx + (rnd() - 0.5) * 1.5, z = gz + (rnd() - 0.5) * 1.5, f = fbm(x * 0.035, z * 0.035, SEED + 31, 4);
    if (f < st.forest && rnd() > st.scatter) continue;
    const [, m] = terrainRaw(x, z), [d, w] = riverAt(x, z); if (m > 0.55 || d < w + 1) continue;
    if (fields.length && f < st.forest && fbm(x * 0.03, z * 0.03, SEED + 21, 3) >= st.fields) continue;   // keep scattered trees off fields
    trees.push({ x, z, y: terrainH(x, z, st), s: 0.6 + rnd() * 0.7, r: 0.5 });
    if (trees.length > 14000) break;
  }
  clearTimes(fields, 2.5); clearTimes(trees, 0.5);
  const fg = new THREE.BoxGeometry(1, 0.03, 1);
  fieldInst = new THREE.InstancedMesh(fg, new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, fields.length)); fieldInst.count = fields.length;
  fields.forEach((f, i) => fieldInst.setColorAt(i, C(f.c)));
  const tg = st.tree === 'blob' ? new THREE.IcosahedronGeometry(0.55, 0).translate(0, 0.5, 0) : new THREE.ConeGeometry(0.45, 1.5, 6).translate(0, 0.75, 0);
  treeInst = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: pal.tree, flatShading: true }), Math.max(1, trees.length)); treeInst.count = trees.length;
  for (const m of [fieldInst, treeInst]) { m.frustumCulled = false; sceneryGroup.add(m); }
  // country roads follow the terrain; bridges where they cross a river
  roadSegs = []; bridges = [];
  for (const l of links) {
    const dx = l.b[0] - l.a[0], dz = l.b[1] - l.a[1], L = Math.hypot(dx, dz), n = Math.max(2, Math.ceil(L / 3)), ang = Math.atan2(-dz, dx);
    let wet = null;
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n, um = (u0 + u1) / 2, x = l.a[0] + dx * um, z = l.a[1] + dz * um, [d, w] = riverAt(x, z);
      roadSegs.push({ x, z, y: Math.max(0, terrainH(x, z, st)) + 0.03, len: L / n + 0.05, ang, born: l.born, u: um, wet: d < w + 0.8 });
      if (d < w + 0.8 && !wet) wet = { u0: um, x, z }; if (wet && d >= w + 0.8) { bridges.push({ x: (wet.x + x) / 2, z: (wet.z + z) / 2, len: Math.hypot(x - wet.x, z - wet.z) + 3, ang, born: l.born }); wet = null; }
    }
  }
  roadInst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.05, SW * 0.8), new THREE.MeshLambertMaterial({ color: css('--street') }), Math.max(1, roadSegs.length)); roadInst.count = roadSegs.length;
  const bgeo = new THREE.BoxGeometry(1, 0.18, SW * 1.3); bgeo.translate(0, 0.25, 0);
  bridgeInst = new THREE.InstancedMesh(bgeo, new THREE.MeshLambertMaterial({ color: isDark() ? '#6b6157' : '#a8988a' }), Math.max(1, bridges.length)); bridgeInst.count = bridges.length;
  for (const m of [roadInst, bridgeInst]) { m.frustumCulled = false; sceneryGroup.add(m); }
  // obstacles overlay: where villages may not found or grow
  if ($('sc-obst').checked) {
    const og = new THREE.PlaneGeometry(size, size, 110, 110); og.rotateX(-Math.PI / 2); og.translate(cx, 0, cz);
    const OP = og.attributes.position, oc = new Float32Array(OP.count * 4);
    for (let i = 0; i < OP.count; i++) { const x = OP.getX(i), z = OP.getZ(i), b2 = blockedArea(x, z, 2), b1 = blockedArea(x, z, 1); OP.setY(i, terrainH(x, z, st) + 0.15); oc.set(b1 ? [0.85, 0.2, 0.2, 0.45] : b2 ? [0.95, 0.6, 0.15, 0.35] : [0, 0, 0, 0], i * 4); }
    og.setAttribute('color', new THREE.BufferAttribute(oc, 4));
    sceneryGroup.add(new THREE.Mesh(og, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })));
  }
  $('st-dec').textContent = `${trees.length.toLocaleString()} trees · ${fields.length.toLocaleString()} fields · ${bridges.length} bridges`;
}
function sceneryFrame(t) {
  if (!treeInst || !$('sc-on').checked) return;
  if (lastSceneryT !== null && Math.abs(t - lastSceneryT) < 0.02) return;
  lastSceneryT = t;
  const m4s = new THREE.Matrix4(), qs = new THREE.Quaternion(), vs = new THREE.Vector3(), ss = new THREE.Vector3(), Yv = new THREE.Vector3(0, 1, 0);
  trees.forEach((tr, i) => { const k = t < tr.clear ? 1 : 1 - ease((t - tr.clear) / D); m4s.compose(vs.set(tr.x, tr.y, tr.z), qs.identity(), ss.setScalar(Math.max(0.0001, tr.s * k))); treeInst.setMatrixAt(i, k < 0.01 ? ZERO : m4s); });
  fields.forEach((f, i) => { const k = t < f.clear ? 1 : 1 - ease((t - f.clear) / D); qs.setFromAxisAngle(Yv, f.a); m4s.compose(vs.set(f.x, 0.0, f.z), qs, ss.set(f.w * k, 1, f.d * k)); fieldInst.setMatrixAt(i, k < 0.01 ? ZERO : m4s); });
  roadSegs.forEach((r, i) => { const g = ease((t - r.born) / D); if (t < r.born || g < r.u) { roadInst.setMatrixAt(i, ZERO); return; } qs.setFromAxisAngle(Yv, r.ang); m4s.compose(vs.set(r.x, r.y, r.z), qs, ss.set(r.len, 1, 1)); roadInst.setMatrixAt(i, m4s); });
  bridges.forEach((b, i) => { if (t < b.born) { bridgeInst.setMatrixAt(i, ZERO); return; } const g = ease((t - b.born) / D); qs.setFromAxisAngle(Yv, b.ang); m4s.compose(vs.set(b.x, 0, b.z), qs, ss.set(b.len * g, 1, 1)); bridgeInst.setMatrixAt(i, m4s); });
  for (const m of [treeInst, fieldInst, roadInst, bridgeInst]) m.instanceMatrix.needsUpdate = true;
  if (fieldInst.instanceColor) fieldInst.instanceColor.needsUpdate = true;
}
