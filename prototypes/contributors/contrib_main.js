// ---------- UI: contributors prototype (git-city#24) ----------
// Villages, countryside A and the shared road network. Three ways to show Contributors: #A crews, #B markers, #C ledger.
variant = 'F'; sv = 'A'; net = 'B';
$('showMoved').checked = false;
function rules() { replay(false); allLotsInOrder = null; lastLogT = -1; }
{ const m = /^#([ABCD])$/.exec(location.hash); if (m) crewStyle = m[1]; }
$('srepo').textContent = DATA.repo;
$('time').max = T - 1 + D;
const KNAME = { A: 'Construction crews: a figure in their colour at the Buildings they change', B: 'Markers: a coloured pin over every changed Building', C: 'Ledger: a feed of commits and a legend; nothing in the City', D: 'Laser beams: a glowing beam in their colour rises from every Building they build' };
function showK() { $('vtag2').innerHTML = `<b>${crewStyle}</b> ${KNAME[crewStyle]}`; $('feed').hidden = crewStyle !== 'C'; try { history.replaceState(null, '', '#' + crewStyle); } catch { } lastContribT = null; }
function afterScenery() { if (roadInst) roadInst.visible = false; if (bridgeInst) bridgeInst.visible = false; }
const cycleK = d => { const K = ['A', 'B', 'C', 'D']; crewStyle = K[(K.indexOf(crewStyle) + d + 4) % 4]; showK(); };
$('vprev').onclick = () => cycleK(-1); $('vnext').onclick = () => cycleK(1);
addEventListener('keydown', e => { if (e.target.closest('input, select, textarea')) return; if (e.key === 'ArrowLeft') cycleK(-1); if (e.key === 'ArrowRight') cycleK(1); if (e.key === ' ') { e.preventDefault(); $('play').click(); } });
addEventListener('hashchange', () => { const m = /^#([ABCD])$/.exec(location.hash); if (m) { crewStyle = m[1]; showK(); } });
function showLevel() { for (const b of document.querySelectorAll('#lvl button')) b.setAttribute('aria-pressed', String(b.dataset.l === contribLevel)); legend(); lastContribT = null; }
$('lvl').onclick = e => { const b = e.target.closest('button'); if (b) { contribLevel = b.dataset.l; showLevel(); } };
$('msgs').addEventListener('change', () => { showMessages = $('msgs').checked; });
function legend() {
  if (contribLevel === 'off') { $('legend2').innerHTML = '<p class="note">Contributors are off: nobody appears in the City.</p>'; legendHover = null; return; }
  const humans = people.filter(p => !p.bot).sort((a, b) => b.n - a.n), bots = people.filter(p => p.bot), others = humans.slice(CREW_PAL.length);
  const row = (p, label, n) => `<button data-p="${p.i}" aria-pressed="false"><span class="sw" style="--c:${p.colour}"></span>${label}<span class="n">${n}</span></button>`;
  $('legend2').innerHTML = humans.slice(0, CREW_PAL.length).map(p => row(p, personLabel(p), p.n)).join('')
    + (others.length ? `<p class="note" style="margin:4px 0 0">+${others.length} more people, ${others.reduce((a, p) => a + p.n, 0)} commits (neutral colour)</p>` : '')
    + (bots.length ? row(bots[0], 'Automation', bots.reduce((a, p) => a + p.n, 0)) : '');
}
$('legend2').addEventListener('pointerover', e => { const b = e.target.closest('button[data-p]'); legendHover = b ? +b.dataset.p : null; });
$('legend2').addEventListener('pointerleave', () => { legendHover = null; });
$('legend2').addEventListener('click', e => { const b = e.target.closest('button[data-p]'); if (!b) return; const on = b.getAttribute('aria-pressed') !== 'true'; for (const x of $('legend2').querySelectorAll('button')) x.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-pressed', String(on)); legendHover = on ? +b.dataset.p : null; });
let playing = false, t = 0;
$('play').onclick = () => { if (!playing && t >= T - 1 + D) t = 0; playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$('time').addEventListener('input', () => { t = +$('time').value; });
function resize() { renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// caption: the current commit, or a summary when commits fly past faster than they can be read
const recentWall = []; let lastK = -1, capAcc = 0;
function caption(t, dt) {
  const k = Math.max(0, Math.min(T - 1, Math.floor(t))), now = performance.now();
  if (k !== lastK) { for (let i = Math.min(lastK, k) + 1; i <= Math.max(lastK, k); i++) recentWall.push([now, i]); lastK = k; }
  while (recentWall.length && now - recentWall[0][0] > 2000) recentWall.shift();
  capAcc += dt; if (capAcc < 0.15) return; capAcc = 0;
  const who = p => contribLevel === 'off' || !p ? '' : `<span class="sw" style="--c:${p.colour}"></span><span class="who">${esc(personLabel(p))}</span> · `;
  if (!showMessages && contribLevel === 'off') { $('caption2').innerHTML = ''; return; }
  if (playing && recentWall.length > 6) {
    const ks = recentWall.map(r => r[1]), ppl = new Set(ks.map(i => commitAuthor[i]));
    $('caption2').innerHTML = `<span class="meta">${COMMITS[ks[0]][0]} → ${COMMITS[ks[ks.length - 1]][0]}</span>${ks.length} commits${contribLevel === 'off' ? '' : ` by ${ppl.size} ${ppl.size === 1 ? 'person' : 'people'}`}${showMessages ? ` · latest: “${esc(commitMsg[k] ?? '')}”` : ''}`;
  } else {
    $('caption2').innerHTML = `<span class="meta">${COMMITS[k][0]} · commit ${k + 1}</span>${who(people[commitAuthor[k]])}${showMessages ? esc(commitMsg[k] ?? '') : '<i>message hidden</i>'}`;
  }
  if (crewStyle === 'C') {
    const rows = []; for (let i = k; i >= Math.max(0, k - 14); i--) { const p = people[commitAuthor[i]];
      rows.push(`<div class="row2"><span class="sw" style="--c:${contribLevel === 'off' || !p ? 'transparent' : p.colour}"></span><span>${showMessages ? esc(commitMsg[i] ?? '') : '<i>message hidden</i>'}</span><span class="meta">${COMMITS[i][0]}${contribLevel === 'off' || !p ? '' : ' · ' + esc(personLabel(p))} · ${changedAt[i].length} Buildings</span></div>`); }
    $('feed').innerHTML = rows.join('');
  }
}
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) { t = Math.min(T - 1 + D, t + dt * +$('speed').value); if (t >= T - 1 + D) { playing = false; $('play').textContent = 'Play'; } $('time').value = t; }
  frame(t); highlightFrame(t); sceneryFrame(t); roadsFrame(t); contribFrame(t); caption(t, dt);
  controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
  requestAnimationFrame(tick);
}
makeRivers(); rules(); resize(); build(); buildScenery(); afterScenery(); buildRoads(); contribModel(); buildContrib(); showK(); showLevel();
{ const p = clusters(T - 1, 120).sort((a, b) => b.changed.length - a.changed.length)[0]; if (p) { controls.target.set(p.cx, 0, p.cz); camera.position.set(p.cx + 30, 32, p.cz + 40); } }
t = Math.floor(T * 0.5); $('time').value = t;
requestAnimationFrame(tick);
</script>
