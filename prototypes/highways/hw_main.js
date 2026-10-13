// ---------- UI: Highways prototype (git-city#22) ----------
// Villages, countryside style A and the shared road network (B). Two Highway designs: #A direct, #B orbital motorway.
variant = 'F'; sv = 'A'; net = 'B';
$('showMoved').checked = false;
function rules() { replay(false); allLotsInOrder = null; lastLogT = -1; }
{ const m = /^#([AB])$/.exec(location.hash); if (m) hwVariant = m[1]; }
$('srepo').textContent = DATA.repo;
$('time').max = T - 1 + D;
const HNAME = { A: 'Direct Highways: each District straight to its External Cities', B: 'Orbital motorway: a ring on the horizon, spurs to External Cities' };
function showHw() { $('vtag2').innerHTML = `<b>${hwVariant}</b> ${HNAME[hwVariant]}`; try { history.replaceState(null, '', '#' + hwVariant); } catch { } }
function afterScenery() { if (roadInst) roadInst.visible = false; if (bridgeInst) bridgeInst.visible = false; }
function hwStatsShow() { $('hw-deps').textContent = hwStats.deps; $('hw-groups').textContent = hwStats.groups; $('hw-cities').textContent = hwStats.cities; $('hw-n').textContent = hwStats.highways; $('hw-max').textContent = hwStats.maxLanes; }
function rebuildAll() { allLotsInOrder = null; build(true); buildScenery(); afterScenery(); buildRoads(); buildHighways(); hwStatsShow(); fitCamera(); }
function fitCamera() { const R = horizonRadius() + 40; controls.target.set(0, 0, 0); camera.position.set(R * 0.45, R * 0.9, R * 1.05); }
const cycleH = () => { hwVariant = hwVariant === 'A' ? 'B' : 'A'; showHw(); buildHighways(); hwStatsShow(); };
$('vprev').onclick = cycleH; $('vnext').onclick = cycleH;
addEventListener('keydown', e => { if (e.target.closest('input, select, textarea')) return; if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') cycleH(); if (e.key === ' ') { e.preventDefault(); $('play').click(); } });
addEventListener('hashchange', () => { const m = /^#([AB])$/.exec(location.hash); if (m) { hwVariant = m[1]; showHw(); buildHighways(); hwStatsShow(); } });
$('sc-on').addEventListener('change', () => { buildScenery(); afterScenery(); if (roadGroup) roadGroup.visible = $('sc-on').checked; });
$('rd-marks').addEventListener('change', () => { for (const r of roads) r.centre.visible = r.divs.visible = !r.track && $('rd-marks').checked; buildHighways(); });
$('showLabels2').addEventListener('change', () => { $('showLabels').checked = $('showLabels2').checked; lastHwT = null; });
$('topn').addEventListener('change', () => { topN = +$('topn').value; buildHighways(); hwStatsShow(); });
$('topn').addEventListener('input', () => { $('o-topn').textContent = $('topn').value; });
$('o-topn').textContent = topN;
let playing = false, t = 0;
$('play').onclick = () => { if (!playing && t >= T - 1 + D) t = 0; playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$('time').addEventListener('input', () => { t = +$('time').value; });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rebuildAll);
function resize() { renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);
const clock = new THREE.Clock(); let frames = 0, acc = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) { t = Math.min(T - 1 + D, t + dt * +$('speed').value); if (t >= T - 1 + D) { playing = false; $('play').textContent = 'Play'; } $('time').value = t; }
  frame(t); sceneryFrame(t); roadsFrame(t); highwaysFrame(t); controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
  frames++; acc += dt;
  if (acc > 0.5) { $('st-fps').textContent = Math.round(frames / acc) + ' fps'; $('st-tris').textContent = renderer.info.render.triangles.toLocaleString(); $('st-calls').textContent = renderer.info.render.calls; frames = 0; acc = 0; }
  requestAnimationFrame(tick);
}
camera.far = 8000; camera.updateProjectionMatrix();
makeRivers(); rules(); resize(); build(); buildScenery(); afterScenery(); buildRoads(); buildHighways(); hwStatsShow(); showHw(); fitCamera();
t = T - 1 + D; $('time').value = t;
requestAnimationFrame(tick);
</script>
