"""Inject compacted data into the template; also emit the module script and a logic-only harness for node.
usage: build.py template.html data.json out.html scratchdir"""
import os, re, sys

tpl, data, out, scratch = sys.argv[1:5]
s = open(tpl).read().replace("/*DATA*/", open(data).read().replace("</", "<\\/"))
open(out, "w").write(s)
mod = re.search(r'<script type="module">(.*?)</script>', s, re.S).group(1)
open(os.path.join(scratch, "check.mjs"), "w").write(mod)
logic = mod[mod.index("const PATHS"):mod.index("// ---------- three.js")]
harness = ("import fs from 'fs';\nconst DATA = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\n" + logic + r"""
function overlaps(out) {
  const g = new Map(); let bad = 0;
  for (const [id, [x, z]] of out.lots) { const k = Math.round(x * 4) + ',' + Math.round(z * 4); if (g.has(k)) bad++; g.set(k, id); }
  const pts = [...out.lots.values()]; let close = 0;
  const grid = new Map(); for (const p of pts) { const k = Math.floor(p[0]) + ',' + Math.floor(p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }
  for (const p of pts) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const q of grid.get((Math.floor(p[0]) + dx) + ',' + (Math.floor(p[1]) + dz)) ?? []) if (q !== p && Math.abs(p[0] - q[0]) < LOT - 0.01 && Math.abs(p[1] - q[1]) < LOT - 0.01) close++;
  return close / 2;
}
for (const cp of [false, true]) {
  replay(cp);
  console.log('crossParent', cp, 'buildings', buildings.length, 'lots', lots.length, 'dirs', dirs.length, 'H', JSON.stringify(H));
}
replay(false);
for (const v of ['A', 'B']) {
  const full = layout(T, v);
  const res = [];
  for (const f of [0.25, 0.5, 0.75, 0.9]) {
    const cut = Math.floor(T * f), first = layout(cut, v); let m = 0;
    for (const [id, p] of first.lots) { const q = full.lots.get(id); if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) m++; }
    res.push(`${f}: ${m}/${first.lots.size}`);
  }
  console.log(v, 'overlapping lot pairs', overlaps(full), 'moved:', res.join('  '));
}
for (const brick of [false, true]) for (const slack of [0, 2, 6]) {
  const out = layoutBlocks(T, brick, slack), xs = out.cells.map(c => c.x), zs = out.cells.map(c => c.z);
  const w = Math.max(...xs) - Math.min(...xs) + CW, h = Math.max(...zs) - Math.min(...zs) + CH;
  const r = out.cells.map(c => Math.hypot(c.x, c.z)), rmax = Math.max(...r), area = out.cells.length * CW * CH;
  let moved = 0; for (const f of [0.25, 0.5, 0.75]) { const first = layoutBlocks(Math.floor(T * f), brick, slack); for (const [id, p] of first.lots) { const q = out.lots.get(id); if (p[0] !== q[0] || p[1] !== q[1]) moved++; } }
  const torn = new Set(out.cells.filter(c => c.fragment).map(c => topOf(c.owner).id)).size;
  console.log(brick ? 'E' : 'D', 'slack', slack, 'blocks', out.cells.length, 'extent', w.toFixed(0), 'x', h.toFixed(0), 'fill of circle', (area / (Math.PI * rmax * rmax)).toFixed(2), 'fragments', out.fragments, 'torn districts', torn, 'moved', moved, 'overlaps', overlaps(out));
}
for (const spacing of [2, 4, 8]) {
  const out = layoutVillages(T, spacing, 2), xs = out.cells.map(c => c.x), zs = out.cells.map(c => c.z);
  let moved = 0; for (const f of [0.25, 0.5, 0.75]) { const first = layoutVillages(Math.floor(T * f), spacing, 2); for (const [id, p] of first.lots) { const q = out.lots.get(id); if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) moved++; } }
  let tight = 0; for (const a of out.cells) for (const b of out.cells) if (a !== b && a.village !== b.village && Math.hypot(a.x - b.x, a.z - b.z) < Math.hypot(CW, CH) + CW) tight++;
  console.log('F spacing', spacing, 'villages', out.villages.length, 'blocks', out.cells.length, 'extent', (Math.max(...xs) - Math.min(...xs)).toFixed(0), 'x', (Math.max(...zs) - Math.min(...zs)).toFixed(0), 'fragments', out.fragments, 'moved', moved, 'block pairs closer than 1 block of open land', tight / 2);
}
allLotsInOrder = null;
for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const cut = Math.floor(T * f), out = layoutFrozen(cut);
  const ext = [...out.streets.values()].filter(s => s.ext).length;
  console.log('C cut', f, 'lots', out.lots.size, '/', lots.length, 'streets', out.streets.size, 'ext streets', ext, 'ext lots', out.extLots.size, 'overlapping lot pairs', overlaps(out));
}
""")
open(os.path.join(scratch, "harness.mjs"), "w").write(harness)
print("ok", len(s) // 1024, "KB")
