// ---------- UI: roads prototype (git-city#20) ----------
// Villages (F, cohesion high) on countryside style A. Two road networks: #A direct roads per connected pair, #B shared network.
variant = 'F'; sv = 'A';
$('showMoved').checked = false;
function rules() { replay(false); allLotsInOrder = null; lastLogT = -1; }
{ const m = /^#([AB])$/.exec(location.hash); if (m) net = m[1]; }
$('srepo').textContent = DATA.repo;
$('time').max = T - 1 + D;
const NNAME = { A: 'Direct roads: one per connected pair of villages', B: 'Shared network: traffic merges onto main roads' };
function showNet() { $('vtag2').innerHTML = `<b>${net}</b> ${NNAME[net]}`; try { history.replaceState(null, '', '#' + net); } catch { } }
function afterScenery() { if (roadInst) roadInst.visible = false; if (bridgeInst) bridgeInst.visible = false; }   // the scenery's own simple roads give way to real ones
function rebuildAll() { allLotsInOrder = null; build(true); buildScenery(); afterScenery(); buildRoads(); stats(); }
function stats() { $('rd-n').textContent = roadStats.roads; $('rd-max').textContent = roadStats.maxLanes; }
const cycleN = d => { net = net === 'A' ? 'B' : 'A'; showNet(); buildRoads(); stats(); };
$('vprev').onclick = () => cycleN(-1); $('vnext').onclick = () => cycleN(1);
addEventListener('keydown', e => { if (e.target.closest('input, select, textarea')) return; if (e.key === 'ArrowLeft') cycleN(-1); if (e.key === 'ArrowRight') cycleN(1); if (e.key === ' ') { e.preventDefault(); $('play').click(); } });
addEventListener('hashchange', () => { const m = /^#([AB])$/.exec(location.hash); if (m) { net = m[1]; showNet(); buildRoads(); stats(); } });
$('sc-on').addEventListener('change', () => { buildScenery(); afterScenery(); });
$('rd-marks').addEventListener('change', () => { for (const r of roads) r.centre.visible = r.divs.visible = !r.track && $('rd-marks').checked; });
$('showLabels2').addEventListener('change', () => { $('showLabels').checked = $('showLabels2').checked; });
$('sp2').addEventListener('change', () => { $('spacing').value = $('sp2').value; $('o-sp2').textContent = $('sp2').value + ' blocks'; rebuildAll(); });
$('sp2').addEventListener('input', () => { $('o-sp2').textContent = $('sp2').value + ' blocks'; });
$('o-sp2').textContent = $('sp2').value + ' blocks';
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
  frame(t); sceneryFrame(t); roadsFrame(t); controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
  frames++; acc += dt;
  if (acc > 0.5) { $('st-fps').textContent = Math.round(frames / acc) + ' fps'; $('st-tris').textContent = renderer.info.render.triangles.toLocaleString(); $('st-calls').textContent = renderer.info.render.calls; frames = 0; acc = 0; }
  requestAnimationFrame(tick);
}
$('spacing').value = $('sp2').value;
makeRivers(); rules(); resize(); build(); buildScenery(); afterScenery(); buildRoads(); stats(); showNet();
t = T - 1 + D; $('time').value = t;
requestAnimationFrame(tick);
</script>
