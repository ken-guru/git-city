
// ---------- Contributors and commit messages (git-city#24) ----------
// Opt-in only. Levels from the privacy decision: off / anonymous ("Contributor 3") / generated names (themed person names) /
// real (names after .mailmap). Bots are grouped as Automation. The top 8 people get a colour; everyone else is neutral.
let crewStyle = 'A', contribLevel = 'anon', showMessages = true, legendHover = null;
const PERSON_FIRST = ['Elric', 'Maud', 'Osric', 'Wynn', 'Hilde', 'Bram', 'Isolde', 'Tobin', 'Agnes', 'Cedric', 'Edda', 'Garth', 'Rowena', 'Aldous', 'Nell', 'Percival'];
const PERSON_LAST = ['Thatcher', 'Cooper', 'Fletcher', 'Mason', 'Tanner', 'Wright', 'Miller', 'Chandler', 'Carter', 'Weaver', 'Smith', 'Baker'];
const CREW_PAL = ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#f79646', '#2c9fa3', '#d36ba6', '#7f6a3c'];
let people = [], commitAuthor = [], commitMsg = [], changedAt = [];
function contribModel() {
  const A = DATA.authors ?? { people: [], byCommit: [], msg: [] };
  const counts = new Map(); A.byCommit.forEach(a => counts.set(a, (counts.get(a) ?? 0) + 1));
  people = A.people.map((p, i) => ({ ...p, i, n: counts.get(i) ?? 0 }));
  const ranked = people.filter(p => !p.bot).sort((a, b) => b.n - a.n);
  ranked.slice(0, CREW_PAL.length).forEach((p, k) => p.colour = CREW_PAL[k]);
  for (const p of people) p.colour ??= p.bot ? '#8c8c84' : '#b7b2a6';
  commitAuthor = A.byCommit; commitMsg = A.msg;
  changedAt = Array.from({ length: T }, () => []);
  for (const lot of lots) { for (const [kt] of lot.keys) if (kt < T) changedAt[kt].push(lot.id); if (lot.to < T) changedAt[lot.to].push(lot.id); }
}
function personLabel(p) {
  if (p.bot) return 'Automation';
  if (contribLevel === 'real') return p.login ?? p.name;
  if (contribLevel === 'generated') { const r = rngF(p.i * 7 + 11); return PERSON_FIRST[Math.floor(r() * PERSON_FIRST.length)] + ' ' + PERSON_LAST[Math.floor(r() * PERSON_LAST.length)]; }
  return 'Contributor ' + (p.i + 1);
}
let crewMesh = null, pinMesh = null, beamCore = null, beamHalo = null, contribGroup = null;
function buildContrib() {
  if (contribGroup) { scene.remove(contribGroup); contribGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
  contribGroup = new THREE.Group(); scene.add(contribGroup);
  const body = new THREE.CylinderGeometry(0.16, 0.2, 0.55, 6).translate(0, 0.28, 0), hat = new THREE.ConeGeometry(0.22, 0.22, 6).translate(0, 0.66, 0);
  crewMesh = new THREE.InstancedMesh(mergeBoxes([body, hat]), new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), 400); crewMesh.count = 0;
  const pin = new THREE.ConeGeometry(0.16, 0.45, 6).rotateX(Math.PI).translate(0, 0.22, 0), head = new THREE.SphereGeometry(0.22, 8, 6).translate(0, 0.55, 0);
  pinMesh = new THREE.InstancedMesh(mergeBoxes([pin, head]), new THREE.MeshLambertMaterial({ color: 0xffffff }), 600); pinMesh.count = 0;
  // D: laser beams. A thin bright core inside a soft halo, additive so they read as light; intensity is baked into the colour
  const beamMat = o => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });
  beamCore = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true).translate(0, 0.5, 0), beamMat(0.95), 900); beamCore.count = 0;
  beamHalo = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.05, 1, 8, 1, true).translate(0, 0.5, 0), beamMat(0.35), 900); beamHalo.count = 0;
  for (const m of [crewMesh, pinMesh, beamCore, beamHalo]) { m.frustumCulled = false; contribGroup.add(m); }
  lastContribT = null;
}
let lastContribT = null;
const SHOW_FOR = 6;   // commits a crew or marker stays after its commit
function contribFrame(t) {
  if (lastContribT !== null && Math.abs(t - lastContribT) < 0.02 && legendHover === lastHover) return;
  lastContribT = t; lastHover = legendHover;
  const m4c = new THREE.Matrix4(), qc = new THREE.Quaternion(), vc = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  let nc = 0, np = 0, nb = 0;
  if (contribLevel !== 'off' && crewStyle === 'D') {
    // timings are in seconds of viewing, converted to commits at the current speed, so beams feel the same at any speed
    const cps = Math.max(1, +(document.getElementById('speed')?.value ?? 15)), RISE = 0.15 * cps, HOLD = 0.5 * cps, FADE = 1.2 * cps, LIFE = RISE + HOLD + FADE;
    for (let k = Math.max(0, Math.floor(t - LIFE)); k <= Math.min(T - 1, Math.floor(t)) && nb < 900; k++) {
      const p = people[commitAuthor[k]]; if (!p) continue;
      const age = t - k; if (age < 0 || age > LIFE) continue;
      const g = age < RISE ? ease(age / RISE) : age < RISE + HOLD ? 1 : 1 - ease((age - RISE - HOLD) / FADE);
      if (g < 0.01) continue;
      for (const id of changedAt[k]) {
        const lot = lots[id]; if (!full.lots.has(id) || lot.to === k) continue;          // built or changed, not demolished
        const [x, z] = full.lots.get(id), h = heightAt(lot, t) * FH, len = 30 * (0.35 + 0.65 * ease(Math.min(1, age / RISE)));
        m4c.compose(vc.set(x, h + 0.07, z), qc.identity(), sc.set(1, len, 1));
        col.set(p.colour).multiplyScalar(g);
        beamCore.setMatrixAt(nb, m4c); beamCore.setColorAt(nb, col.clone().lerp(new THREE.Color(1, 1, 1), 0.35 * g));
        beamHalo.setMatrixAt(nb, m4c); beamHalo.setColorAt(nb, col);
        if (++nb >= 900) break;
      }
    }
  }
  if (contribLevel !== 'off' && crewStyle !== 'C' && crewStyle !== 'D') {
    for (let k = Math.max(0, Math.floor(t - SHOW_FOR)); k <= Math.min(T - 1, Math.floor(t)); k++) {
      const p = people[commitAuthor[k]]; if (!p) continue;
      const age = t - k, g = Math.min(ease(age / 1.2), 1 - ease((age - SHOW_FOR + 1.5) / 1.5)); if (g <= 0.01) continue;
      const ids = changedAt[k].filter(id => full.lots.has(id));
      if (crewStyle === 'A') {
        // one crew member per village the commit touched (up to 3), standing beside the changed Buildings
        const groups = new Map(); for (const id of ids) { const v = lotVillage(id); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(full.lots.get(id)); }
        let gi = 0;
        for (const pts of [...groups.values()].sort((a, b) => b.length - a.length).slice(0, 3)) {
          const r = rngF(k * 13 + gi++), [x, z] = pts[Math.floor(r() * pts.length)], a = r() * Math.PI * 2;
          m4c.compose(vc.set(x + Math.cos(a) * 0.9, 0.06, z + Math.sin(a) * 0.9), qc.identity(), sc.setScalar(g * 1.4)); crewMesh.setMatrixAt(nc, m4c); crewMesh.setColorAt(nc, col.set(p.colour)); if (++nc >= 400) break;
        }
      } else {
        // a marker over each changed Building (up to 12 per commit), floating just above its roof
        for (const id of ids.slice(0, 12)) {
          const lot = lots[id], [x, z] = full.lots.get(id), h = heightAt(lot, t) * FH;
          m4c.compose(vc.set(x, h + 0.5 + (1 - g) * 0.6, z), qc.identity(), sc.setScalar(g)); pinMesh.setMatrixAt(np, m4c); pinMesh.setColorAt(np, col.set(p.colour)); if (++np >= 600) break;
        }
      }
    }
  }
  crewMesh.count = nc; pinMesh.count = np; beamCore.count = beamHalo.count = nb;
  for (const m of [crewMesh, pinMesh, beamCore, beamHalo]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
}
let lastHover = null;
// ledger (C) and legend hover: tint the Buildings a person changed in the last 120 commits
function highlightFrame(t) {
  if (legendHover == null) return;
  const set = new Set(); for (let k = Math.max(0, Math.floor(t) - 120); k <= Math.min(T - 1, Math.floor(t)); k++) if (commitAuthor[k] === legendHover) for (const id of changedAt[k]) set.add(id);
  const c = new THREE.Color(people[legendHover].colour);
  for (const id of set) if (full.lots.has(id) && t < lots[id].to) buildMesh.setColorAt(id, c);
  if (buildMesh.instanceColor) buildMesh.instanceColor.needsUpdate = true;
}
