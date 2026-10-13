// ---------- UI: countryside prototype (git-city#21) ----------
// The layout is fixed to the chosen villages (variant F, spacing 10, high cohesion). Three scenery styles: #A / #B / #C.
variant = 'F';
$('showMoved').checked = false;
function rules() { replay(false); allLotsInOrder = null; lastLogT = -1; }
{ const m = /^#([ABC])$/.exec(location.hash); if (m) sv = m[1]; }
$('srepo').textContent = DATA.repo;
$('time').max = T - 1 + D;
function showStyle() { $('vtag2').innerHTML = `<b>${sv}</b> ${STYLES[sv].name}`; try { history.replaceState(null, '', '#' + sv); } catch { } }
function layoutStats() {
  $('st-vil').textContent = full.villages.length; $('st-forced').textContent = full.forced ?? 0;
  const first = layoutVillages(Math.floor(T * 0.6), +$('spacing').value, +$('slack').value); let m = 0;
  for (const [id, p] of first.lots) { const q = full.lots.get(id); if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) m++; }
  $('st-moved').textContent = `${m} of ${first.lots.size} (first run cut at 60%)`;
}
function rebuildAll() { makeRivers(); allLotsInOrder = null; build(true); buildScenery(); layoutStats(); }
const cycleS = d => { const K = ['A', 'B', 'C']; sv = K[(K.indexOf(sv) + d + 3) % 3]; showStyle(); buildScenery(); };
$('vprev').onclick = () => cycleS(-1); $('vnext').onclick = () => cycleS(1);
addEventListener('keydown', e => { if (e.target.closest('input, select, textarea')) return; if (e.key === 'ArrowLeft') cycleS(-1); if (e.key === 'ArrowRight') cycleS(1); if (e.key === ' ') { e.preventDefault(); $('play').click(); } });
addEventListener('hashchange', () => { const m = /^#([ABC])$/.exec(location.hash); if (m) { sv = m[1]; showStyle(); buildScenery(); } });
$('sc-on').addEventListener('change', buildScenery);
$('sc-obst').addEventListener('change', buildScenery);
$('showLabels2').addEventListener('change', () => { $('showLabels').checked = $('showLabels2').checked; });
$('rivers').addEventListener('input', () => { nRivers = +$('rivers').value; $('o-rivers').textContent = nRivers; rebuildAll(); });
$('o-rivers').textContent = nRivers;
let playing = false, t = 0;
$('play').onclick = () => { if (!playing && t >= T - 1 + D) t = 0; playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$('time').addEventListener('input', () => { t = +$('time').value; });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { build(true); buildScenery(); });
function resize() { renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);
const clock = new THREE.Clock(); let frames = 0, acc = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) { t = Math.min(T - 1 + D, t + dt * +$('speed').value); if (t >= T - 1 + D) { playing = false; $('play').textContent = 'Play'; } $('time').value = t; }
  frame(t); sceneryFrame(t); controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
  frames++; acc += dt;
  if (acc > 0.5) { $('st-fps').textContent = Math.round(frames / acc) + ' fps'; $('st-tris').textContent = renderer.info.render.triangles.toLocaleString(); $('st-calls').textContent = renderer.info.render.calls; frames = 0; acc = 0; }
  requestAnimationFrame(tick);
}
makeRivers(); rules(); resize(); build(); buildScenery(); layoutStats(); showStyle();
t = T - 1 + D; $('time').value = t;
requestAnimationFrame(tick);
</script>
