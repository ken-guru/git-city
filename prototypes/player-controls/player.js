// ---------- UI: player prototype (git-city#18) ----------
// The layout is fixed to the chosen villages (variant F). Three player designs, switchable with #A / #B / #C or [ and ].
variant = 'F';
function rules() { replay(false); allLotsInOrder = null; lastLogT = -1; }
const PV = ['A', 'B', 'C'], PNAME = { A: 'Media bar', B: 'Story ribbon', C: 'Minimal pill + edge scrubber' };
let pv = 'A';
{ const m = /^#([ABC])$/.exec(location.hash); if (m) pv = m[1]; }
$('showMoved').checked = false;

// ---- time model: commits are placed on an axis; "real" follows dates with idle gaps capped, "equal" gives each commit one step
const DAY0 = Date.parse(COMMITS[0][0] + 'T00:00:00Z');
const days = COMMITS.map(c => (Date.parse(c[0] + 'T00:00:00Z') - DAY0) / 864e5);
const IDLE_CAP = 7, SAME_DAY = 0.15;     // a quiet stretch never takes longer than a week; same-day commits are spread a little
let mode = 'real', axis = null;
function buildAxis() {
  axis = new Float64Array(T);
  for (let k = 1; k < T; k++) axis[k] = axis[k - 1] + (mode === 'equal' ? 1 : Math.max(SAME_DAY, Math.min(IDLE_CAP, days[k] - days[k - 1])));
}
const tailLen = () => mode === 'equal' ? D : 3;
const axisEnd = () => axis[T - 1] + tailLen();
function posToT(p) {
  if (p >= axis[T - 1]) return T - 1 + (p - axis[T - 1]) / tailLen() * D;
  let lo = 0, hi = T - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (axis[mid] <= p) lo = mid; else hi = mid - 1; }
  return lo + (p - axis[lo]) / ((axis[lo + 1] - axis[lo]) || 1);
}
function tToPos(t) { if (t >= T - 1) return axis[T - 1] + (t - (T - 1)) / D * tailLen(); const k = Math.floor(t); return axis[k] + (t - k) * (axis[k + 1] - axis[k]); }
const SPEEDS = { real: [[7, '1 week/s'], [30, '1 month/s'], [91, '3 months/s'], [365, '1 year/s']], equal: [[5, '5 commits/s'], [15, '15 commits/s'], [40, '40 commits/s'], [120, '120 commits/s']] };
let speedI = 1;

// ---- simulated chunk streaming (Data format between the CLI and the page): 100-commit chunks, fetched in order in the background
const CHUNK = 100, NCH = Math.ceil(T / CHUNK), loaded = new Set([0]), pendingC = new Map();
function request(c, urgent) {
  if (loaded.has(c) || pendingC.has(c)) return;
  pendingC.set(c, setTimeout(() => { loaded.add(c); pendingC.delete(c); }, urgent ? 450 : 650));
}
setInterval(() => { for (let c = 0; c < NCH; c++) if (!loaded.has(c)) { if (!pendingC.size) request(c, false); break; } }, 200);
const chunkOf = t => Math.min(NCH - 1, Math.max(0, Math.floor(Math.min(t, T - 1) / CHUNK)));

// ---- state
let playing = false, dir = 1, pos = 0, shownT = 0, wantPos = null;   // wantPos: a scrub target waiting for its chunk

// ---- per-commit facts for the timeline visuals
let topColour = [];                                  // per commit: [[css colour, files touched]]
function computeActivity() {
  const colourByTop = new Map(); for (const r of regions) if (r.node.depth === 1) colourByTop.set(r.node.names[0][1].split('/')[0], '#' + districtColour.get(r.node.id).getHexString());
  topColour = COMMITS.map(([, ev]) => { const m = new Map(); for (const e of ev) { const top = PATHS[e[1]].split('/')[0]; const c = colourByTop.get(top) ?? css('--muted'); m.set(c, (m.get(c) ?? 0) + 1); } return [...m]; });
}
const markers = () => [
  ...events.filter(e => /splits off|merges back/.test(e[1])).map(e => ({ t: e[0], kind: 'district', text: e[1].replace(/<[^>]+>/g, '') })),
  ...(full.villages ?? []).slice(1).map(v => ({ t: v.born, kind: 'village', text: 'Village founded: ' + v.node.names[0][1].split('/').pop() })),
];

// ---- drawing a scrubber
function drawScrub(el) {
  const cv = el.querySelector('canvas'), r = el.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
  if (!r.width) return;
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const g = cv.getContext('2d'), W = r.width, H = r.height, style = el.dataset.style, end = axisEnd();
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const x = p => p / end * W;
  const track = css('--panel-edge'), fg = css('--fg'), acc = css('--accent'), muted = css('--muted');
  // buffered chunks
  const ty = style === 'thin' ? 0 : style === 'stream' ? H - 6 : H - 8, th = style === 'thin' ? H : 4;
  g.fillStyle = track; g.globalAlpha = 0.5; g.fillRect(0, ty, W, th); g.globalAlpha = 1;
  g.fillStyle = muted; g.globalAlpha = style === 'thin' ? 0.35 : 0.55;
  for (const c of loaded) { const a = tToPos(c * CHUNK), b = tToPos(Math.min(T - 1, (c + 1) * CHUNK)); g.fillRect(x(a), ty, Math.max(1, x(b) - x(a)), th); }
  g.globalAlpha = 1;
  // activity
  const N = Math.max(40, Math.floor(W / (style === 'stream' ? 3 : 4))), bw = W / N;
  if (style === 'bars' || style === 'thin') {
    const counts = new Float32Array(N); for (let k = 0; k < T; k++) counts[Math.min(N - 1, Math.floor(axis[k] / end * N))]++;
    const max = Math.max(...counts) || 1, top = style === 'thin' ? 2 : 2, bh = style === 'thin' ? H - 4 : H - 14;
    g.fillStyle = fg; g.globalAlpha = style === 'thin' ? 0.45 : 0.35;
    for (let i = 0; i < N; i++) if (counts[i]) { const h = Math.max(1.5, Math.sqrt(counts[i] / max) * bh); g.fillRect(i * bw + 0.5, top + bh - h, Math.max(1, bw - 1), h); }
    g.globalAlpha = 1;
  } else {
    // stacked by District colour, sqrt-scaled
    const stacks = Array.from({ length: N }, () => new Map());
    for (let k = 0; k < T; k++) { const b = stacks[Math.min(N - 1, Math.floor(axis[k] / end * N))]; for (const [c, n] of topColour[k]) b.set(c, (b.get(c) ?? 0) + n); }
    const tot = stacks.map(m => [...m.values()].reduce((a, b) => a + b, 0)), max = Math.max(...tot) || 1, bh = H - 26;
    el._N = N;
    for (let i = 0; i < N; i++) { if (!tot[i]) continue; const h = Math.max(2, Math.sqrt(tot[i] / max) * bh); let y = 4 + bh;
      for (const [c, n] of [...stacks[i]].sort()) { const hh = h * n / tot[i]; g.fillStyle = c; g.fillRect(i * bw, y - hh, Math.max(1, bw - 0.5), hh); y -= hh; } }
    // year ticks
    g.fillStyle = muted; g.font = '10px ' + css('--mono'); g.textBaseline = 'bottom';
    let lastYear = null; for (let k = 0; k < T; k++) { const yr = COMMITS[k][0].slice(0, 4); if (yr !== lastYear) { lastYear = yr; const xx = x(axis[k]); g.fillRect(xx, H - 16, 1, 6); g.fillText(yr, xx + 3, H - 8); } }
  }
  // markers: village founded (diamond), District split/merge (tick)
  if (style !== 'thin') for (const m of markers()) {
    const xx = x(tToPos(m.t)); g.fillStyle = m.kind === 'village' ? acc : muted;
    if (m.kind === 'village') { g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx + 3.5, 3.5); g.lineTo(xx, 7); g.lineTo(xx - 3.5, 3.5); g.fill(); }
    else g.fillRect(xx - 0.5, 0, 1, 5);
  }
  // pending scrub target and playhead
  if (wantPos != null) { g.strokeStyle = acc; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x(wantPos), 0); g.lineTo(x(wantPos), H); g.stroke(); g.setLineDash([]); }
  const px = x(tToPos(shownT));
  g.fillStyle = acc; g.fillRect(px - 1, 0, 2, H);
  if (style !== 'thin') { g.beginPath(); g.arc(px, ty + th / 2, 6, 0, Math.PI * 2); g.fill(); }
}

// ---- wiring
const root = $('player');
const all = sel => root.querySelectorAll(sel);
function showVariant() {
  for (const el of root.querySelectorAll('[data-v]')) el.hidden = el.dataset.v !== pv;
  $('vtag2').innerHTML = `<b>${pv}</b> ${PNAME[pv]}`;
  try { history.replaceState(null, '', '#' + pv); } catch { }
}
function setMode(m) { const t = shownT; mode = m; buildAxis(); pos = tToPos(t); wantPos = null; syncControls(); }
function syncControls() {
  for (const b of all('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  for (const s of all('[data-ctl="speed"]')) { s.innerHTML = SPEEDS[mode].map(([, l], i) => `<button data-speed="${i}" aria-pressed="${i === speedI}">${l}</button>`).join(''); }
  for (const b of all('[data-ctl="speedcycle"]')) b.textContent = SPEEDS[mode][speedI][1];
  for (const b of all('[data-ctl="modecycle"]')) b.textContent = mode === 'real' ? 'Real time' : 'Per commit';
  for (const b of all('[data-act="play"]')) { b.textContent = playing ? '❚❚' : '▶'; b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  for (const b of all('[data-act="reverse"]')) b.setAttribute('aria-pressed', String(dir < 0));
}
function act(a) {
  if (a === 'play') { if (!playing && dir > 0 && pos >= axisEnd()) pos = 0; if (!playing && dir < 0 && pos <= 0) pos = axisEnd(); playing = !playing; }
  if (a === 'reverse') { dir = -dir; if (!playing) playing = true; }
  if (a === 'start') { seek(0); }
  if (a === 'end') { seek(axisEnd()); }
  syncControls();
}
function seek(p) { pos = Math.max(0, Math.min(axisEnd(), p)); const c = chunkOf(posToT(pos)); if (!loaded.has(c)) { wantPos = pos; request(c, true); } else wantPos = null; }
root.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.act) act(b.dataset.act);
  if (b.dataset.mode) setMode(b.dataset.mode);
  if (b.dataset.speed) { speedI = +b.dataset.speed; syncControls(); }
  if (b.dataset.ctl === 'speedcycle') { speedI = (speedI + 1) % 4; syncControls(); }
  if (b.dataset.ctl === 'modecycle') setMode(mode === 'real' ? 'equal' : 'real');
});
for (const inp of all('.scrub input')) {
  inp.addEventListener('input', () => { seek(+inp.value / 1e6 * axisEnd()); });
  inp.addEventListener('pointerdown', () => { $('pc-edge').classList.add('open'); });
  inp.addEventListener('pointerup', () => { $('pc-edge').classList.remove('open'); });
}
// ---- tooltip: what one bar of the ribbon contains
const tip = document.createElement('div'); tip.id = 'tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip'); proot.appendChild(tip);
function showTip(el, clientX) {
  const r = el.getBoundingClientRect(), N = el._N, end = axisEnd(); if (!N) return;
  const i = Math.max(0, Math.min(N - 1, Math.floor((clientX - r.left) / r.width * N))), a = i * end / N, b = (i + 1) * end / N;
  const ks = []; for (let k = 0; k < T; k++) if (axis[k] >= a && axis[k] < b) ks.push(k);
  if (!ks.length) { tip.innerHTML = `<div class="t">Quiet</div><div class="s">no commits here</div>`; }
  else {
    const per = new Map(); let files = 0;
    const colourByTop = new Map(); for (const rg of regions) if (rg.node.depth === 1) colourByTop.set(rg.node.names[0][1].split('/')[0], '#' + districtColour.get(rg.node.id).getHexString());
    for (const k of ks) for (const e of COMMITS[k][1]) { const p = PATHS[e[1]], top = p.includes('/') ? p.split('/')[0] : '(root files)'; files++; per.set(top, (per.get(top) ?? 0) + 1); }
    const k0 = ks[0], k1 = ks[ks.length - 1];
    const fmt = k => new Date(COMMITS[k][0] + 'T00:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const top = [...per].sort((x, y) => y[1] - x[1]), shown = top.slice(0, 4);
    const evs = [...events.filter(e => e[0] >= k0 && e[0] <= k1 && /splits off|merges back|Street renamed/.test(e[1])).map(e => e[1]),
      ...(full.villages ?? []).slice(1).filter(v => v.born >= k0 && v.born <= k1).map(v => '<i>Village founded</i> ' + v.node.names[0][1].split('/').pop())];
    const reloc = events.filter(e => e[0] >= k0 && e[0] <= k1 && /Relocation/.test(e[1])).length;
    if (reloc) evs.push(`<i>${reloc} Relocation${reloc > 1 ? 's' : ''}</i>`);
    tip.innerHTML = `<div class="t">${k0 === k1 ? fmt(k0) : fmt(k0) + ' – ' + fmt(k1)}</div>
      <div class="s">${ks.length} commit${ks.length > 1 ? 's' : ''} · ${files} file change${files > 1 ? 's' : ''}</div>
      <ul>${shown.map(([n, c]) => `<li><span class="sw" style="--c:${colourByTop.get(n) ?? css('--muted')}"></span>${n}<span class="n">${c}</span></li>`).join('')}
      ${top.length > shown.length ? `<li><span class="sw" style="--c:transparent"></span>+${top.length - shown.length} more Districts</li>` : ''}</ul>
      ${evs.length ? `<div class="ev">${evs.slice(0, 3).join('<br>')}${evs.length > 3 ? `<br>+${evs.length - 3} more` : ''}</div>` : ''}`;
  }
  tip.hidden = false;
  const w = 250, x = Math.max(8, Math.min(innerWidth - w - 8, clientX - w / 2));
  tip.style.left = x + 'px'; tip.style.bottom = (innerHeight - r.top + 10) + 'px';
}
for (const inp of all('.scrub[data-style="stream"] input')) {
  const el = inp.closest('.scrub');
  inp.addEventListener('pointermove', e => showTip(el, e.clientX));
  inp.addEventListener('pointerdown', e => showTip(el, e.clientX));
  inp.addEventListener('pointerleave', () => { tip.hidden = true; });
  inp.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') tip.hidden = true; });
  inp.addEventListener('blur', () => { tip.hidden = true; });
}
const cyclePV = d => { pv = PV[(PV.indexOf(pv) + d + PV.length) % PV.length]; showVariant(); };
$('vprev').onclick = () => cyclePV(-1); $('vnext').onclick = () => cyclePV(1);
$('hidehelp').onclick = () => { $('help').hidden = true; };
addEventListener('keydown', e => {
  if (e.target.closest('select, textarea') || (e.target.closest('input') && !e.target.closest('.scrub'))) return;
  const step = e.shiftKey ? axisEnd() * 0.05 : null;
  const commitStep = d => { const t = Math.round(shownT) + d; seek(tToPos(Math.max(0, Math.min(T - 1, t)))); };
  if (e.key === ' ') { e.preventDefault(); act('play'); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); playing = false; step ? seek(pos + step) : commitStep(1); syncControls(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); playing = false; step ? seek(pos - step) : commitStep(-1); syncControls(); }
  else if (e.key === 'Home') { e.preventDefault(); seek(0); }
  else if (e.key === 'End') { e.preventDefault(); seek(axisEnd()); }
  else if (e.key === 'r' || e.key === 'R') act('reverse');
  else if (e.key === '[') cyclePV(-1);
  else if (e.key === ']') cyclePV(1);
});
addEventListener('hashchange', () => { const m = /^#([ABC])$/.exec(location.hash); if (m) { pv = m[1]; showVariant(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { build(true); computeActivity(); });
function resize() { renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);

function fmtWhen(t) {
  const k = Math.max(0, Math.min(T - 1, Math.floor(t))), d = new Date(COMMITS[k][0] + 'T00:00:00Z');
  const date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `<b>${date}</b><span>commit ${(k + 1).toLocaleString()} of ${T.toLocaleString()}</span>`;
}
const clock = new THREE.Clock();
let uiAcc = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing) {
    const next = Math.max(0, Math.min(axisEnd(), pos + dir * dt * SPEEDS[mode][speedI][0]));
    const c = chunkOf(posToT(next));
    if (loaded.has(c)) { pos = next; wantPos = null; } else { request(c, true); }     // buffering: hold until the chunk arrives
    if ((dir > 0 && pos >= axisEnd()) || (dir < 0 && pos <= 0)) { playing = false; syncControls(); }
  }
  if (wantPos != null && loaded.has(chunkOf(posToT(wantPos)))) { pos = wantPos; wantPos = null; }
  if (wantPos == null) shownT = posToT(pos);
  frame(shownT); controls.update(); renderer.render(scene, camera); labels.render(scene, camera);
  uiAcc += dt;
  if (uiAcc > 1 / 30) {
    uiAcc = 0;
    for (const el of all('.when')) el.innerHTML = fmtWhen(shownT);
    const buffering = wantPos != null || (playing && !loaded.has(chunkOf(posToT(pos + dir * 0.5))));
    for (const el of all('.status')) { el.className = 'status' + (buffering ? ' loading' : ''); el.textContent = buffering ? 'Loading this part of history…' : loaded.size < NCH ? `${Math.round(loaded.size / NCH * 100)}% loaded` : ''; }
    for (const inp of all('.scrub input')) if (document.activeElement !== inp || !inp.matches(':active')) inp.value = Math.round(pos / axisEnd() * 1e6);
    for (const inp of all('.scrub input')) inp.setAttribute('aria-valuetext', fmtWhen(shownT).replace(/<[^>]+>/g, ' ').trim());
    const recent = events.filter(e => e[0] <= shownT).slice(-1)[0];
    for (const el of all('.recent')) el.innerHTML = recent ? `${COMMITS[recent[0]][0]} ${recent[1]}` : '';
    for (const el of root.querySelectorAll('.scrub')) if (el.offsetParent || el.closest('#pc-edge:not([hidden])')) drawScrub(el);
  }
  requestAnimationFrame(tick);
}
rules(); resize(); build(); computeActivity(); buildAxis(); showVariant(); syncControls();
pos = 0; shownT = 0;
requestAnimationFrame(tick);
</script>
