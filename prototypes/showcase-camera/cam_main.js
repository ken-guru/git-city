// ---------- UI: showcase camera prototype (git-city#23) ----------
// The full scene (villages, countryside A, shared roads, orbital motorway). Three showcase styles: #A / #B / #C.
variant = 'F'; sv = 'A'; net = 'B'; hwVariant = 'B'; topN = 8;
$('showMoved').checked = false;
function rules() { replay(false); allLotsInOrder = null; lastLogT = -1; }
{ const m = /^#([ABC])$/.exec(location.hash); if (m) camStyle = m[1]; }
$('srepo').textContent = DATA.repo;
$('time').max = T - 1 + D;
const CNAME = { A: 'Grand tour: sweep the land, then glide past the busiest villages', B: 'Drone: follow the roads from village to village', C: 'Postcards: composed shots with a slow push-in' };
function showCam() { $('vtag2').innerHTML = `<b>${camStyle}</b> ${CNAME[camStyle]}`; try { history.replaceState(null, '', '#' + camStyle); } catch { } }
function afterScenery() { if (roadInst) roadInst.visible = false; if (bridgeInst) bridgeInst.visible = false; }
const cycleC = d => { const K = ['A', 'B', 'C']; camStyle = K[(K.indexOf(camStyle) + d + 3) % 3]; showCam(); if (show.state === 'flying') showcaseStart(); };
$('vprev').onclick = () => cycleC(-1); $('vnext').onclick = () => cycleC(1);
// any interaction with the view takes over from the showcase
for (const ev of ['pointerdown', 'wheel']) renderer.domElement.addEventListener(ev, showcaseInterrupt, { passive: true });
controls.addEventListener('start', showcaseInterrupt);
addEventListener('keydown', e => { if (e.target.closest('input, select, textarea')) return;
  if (e.key === '[') { cycleC(-1); return; } if (e.key === ']') { cycleC(1); return; }
  showcaseInterrupt(); if (e.key === ' ') { e.preventDefault(); $('play').click(); } });
addEventListener('hashchange', () => { const m = /^#([ABC])$/.exec(location.hash); if (m) { camStyle = m[1]; showCam(); } });
$('cam-now').onclick = () => { t = T - 1 + D; $('time').value = t; playing = false; $('play').textContent = 'Play'; showcaseStart(); };
$('cspeed').addEventListener('input', () => { camSpeed = +$('cspeed').value; $('o-cspeed').textContent = camSpeed + '×'; });
$('o-cspeed').textContent = '1×';
$('cam-reduced').addEventListener('change', () => { simReducedMotion = $('cam-reduced').checked; if (show.state === 'flying') showcaseStart(); });
$('cam-follow').addEventListener('change', () => { followDuringPlay = $('cam-follow').checked; });
$('cam-toggle').onclick = () => { const c = $('spanel').classList.toggle('collapsed'); $('cam-toggle').textContent = c ? 'Show panel' : 'Hide panel'; $('cam-toggle').setAttribute('aria-expanded', String(!c)); };
let playing = false, t = 0;
$('play').onclick = () => { showcaseInterrupt(); if (!playing && t >= T - 1 + D) t = 0; playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$('time').addEventListener('input', () => { showcaseInterrupt(); t = +$('time').value; });
function resize() { renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);
const clock = new THREE.Clock(); let frames = 0, acc = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) { t = Math.min(T - 1 + D, t + dt * +$('speed').value); if (t >= T - 1 + D) { playing = false; $('play').textContent = 'Play'; } $('time').value = t; followFrame(dt, t); }
  const atEnd = t >= T - 1;
  showcaseFrame(dt, atEnd, playing);
  $('cam-status').className = show.state === 'flying' ? 'flying' : '';
  $('cam-status').textContent = playing || !atEnd ? 'Off while history plays or is scrubbed back' : show.state === 'flying' ? 'Flying (touch to take over)' : `Paused: resumes in ${Math.max(0, Math.ceil(IDLE_RESUME - show.idle))} s`;
  if (show.state !== 'flying') $('cam-caption').textContent = '';
  frame(t); sceneryFrame(t); roadsFrame(t); highwaysFrame(t); if (show.state !== 'flying') controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
  frames++; acc += dt;
  if (acc > 0.5) { $('st-fps').textContent = Math.round(frames / acc) + ' fps'; frames = 0; acc = 0; }
  requestAnimationFrame(tick);
}
camera.far = 8000; camera.updateProjectionMatrix();
makeRivers(); rules(); resize(); build(); buildScenery(); afterScenery(); buildRoads(); buildHighways(); showCam();
{ const R = horizonRadius() + 40; controls.target.set(0, 0, 0); camera.position.set(R * 0.45, R * 0.9, R * 1.05); }
t = T - 1 + D; $('time').value = t;
requestAnimationFrame(tick);
</script>
