// usage: node match.mjs <root>   (uses java + fwcd-head kotlin grammars)
// Evaluates import -> declared-coordinate heuristics with no mapping tables.
import { Parser, Language, Query } from 'web-tree-sitter';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const base = '/tmp/claude-1000/-workspace/29babd88-0ee3-42fc-9906-f088e1d90ef2/scratchpad/jvm/';
const root = process.argv[2];
const files = [];
(function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else files.push(p); } })(root);
// declared coordinates: pom.xml dependencies (outside dependencyManagement/build) + libs.versions.toml modules + gradle string literals
const coords = new Set();
for (const f of files) {
  const t = () => readFileSync(f, 'utf8');
  if (f.endsWith('pom.xml')) {
    const body = t().replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '').replace(/<build>[\s\S]*?<\/build>/g, '');
    for (const d of body.match(/<dependency>[\s\S]*?<\/dependency>/g) || []) {
      const g = d.match(/<groupId>([^<]+)</)?.[1], a = d.match(/<artifactId>([^<]+)</)?.[1];
      if (g && a && !g.includes('${')) coords.add(g.trim() + ':' + a.trim());
    }
  } else if (f.endsWith('libs.versions.toml')) {
    for (const m of t().matchAll(/module\s*=\s*"([^":]+):([^"]+)"/g)) coords.add(m[1] + ':' + m[2]);
    for (const m of t().matchAll(/group\s*=\s*"([^"]+)"\s*,\s*name\s*=\s*"([^"]+)"/g)) coords.add(m[1] + ':' + m[2]);
    for (const m of t().matchAll(/^\s*[\w-]+\s*=\s*"([\w.-]+):([\w.-]+):[^"]*"/gm)) coords.add(m[1] + ':' + m[2]);
  } else if (/build\.gradle(\.kts)?$/.test(f)) {
    for (const m of t().matchAll(/["']([\w.-]+):([\w.-]+)(:[^"']*)?["']/g)) if (m[1].includes('.')) coords.add(m[1] + ':' + m[2]);
  }
}
await Parser.init();
const java = await Language.load(base + 'node_modules/tree-sitter-java/tree-sitter-java.wasm');
const kt = await Language.load(base + 'build/tree-sitter-kotlin.wasm');
const qs = { java: new Query(java, '(package_declaration [(identifier) (scoped_identifier)] @p) (import_declaration [(identifier) (scoped_identifier)] @i)'), kt: new Query(kt, '(package_header (identifier) @p) (import_header (identifier) @i)') };
const parser = new Parser();
const repoPkgs = new Set(); const imports = [];
for (const f of files) {
  const isJ = f.endsWith('.java'), isK = f.endsWith('.kt');
  if (!isJ && !isK) continue;
  parser.setLanguage(isJ ? java : kt);
  const tree = parser.parse(readFileSync(f, 'utf8'));
  for (const c of qs[isJ ? 'java' : 'kt'].captures(tree.rootNode)) {
    const s = c.node.text.replace(/[\s`]/g, '');
    if (c.name === 'p') repoPkgs.add(s); else imports.push(s);
  }
  tree.delete();
}
const platform = /^(java|javax\.(annotation\.processing|crypto|net|security|lang|naming|management|swing|xml|sql|tools|script|imageio|sound)|kotlin|android|dalvik|sun|jdk|org\.w3c|org\.xml)\./;
const inRepo = s => { const p = s.split('.'); for (let i = p.length - 1; i >= 1; i--) if (repoPkgs.has(p.slice(0, i).join('.'))) return true; return false; };
const ext = imports.filter(s => !platform.test(s + '.') && !inRepo(s));
const generic = new Set(['core', 'api', 'android', 'jvm', 'ktx', 'common', 'runtime', 'starter', 'test', 'testing', 'annotations', 'annotation', 'lib', 'library', 'java', 'kotlin', 'bom', 'all', 'impl', 'compiler', 'plugin', 'spring', 'boot', 'org', 'com', 'io', 'net']);
const cs = [...coords].map(c => { const [g, a] = c.split(':'); return { c, g, gs: g.split('.'), toks: new Set([...g.split('.').slice(1), ...a.split(/[-_.]/)].map(x => x.toLowerCase()).filter(x => x.length > 2 && !generic.has(x))) }; });
const H = {
  groupPrefix: s => cs.filter(c => (s + '.').startsWith(c.g + '.')),
  groupPrefixMinus1: s => cs.filter(c => c.gs.length >= 3 && (s + '.').startsWith(c.gs.slice(0, -1).join('.') + '.')),
  tokenSegment: s => cs.filter(c => s.split('.').slice(0, -1).some(seg => c.toks.has(seg.toLowerCase()))),
};
H.combined = s => { const a = H.groupPrefix(s); return a.length ? a : H.tokenSegment(s); };
const res = {};
for (const [k, h] of Object.entries(H)) {
  let hit = 0, amb = 0; const miss = new Map();
  for (const s of ext) { const m = h(s); if (m.length) { hit++; if (new Set(m.map(x => x.g)).size > 1) amb++; } else { const k3 = s.split('.').slice(0, 3).join('.'); miss.set(k3, (miss.get(k3) || 0) + 1); } }
  res[k] = { matchedPct: +(100 * hit / ext.length).toFixed(1), multiGroupPct: +(100 * amb / ext.length).toFixed(1), topMisses: [...miss].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => p + ':' + n) };
}
console.log(JSON.stringify({ root, declared: coords.size, imports: imports.length, externalNonPlatform: ext.length, res }, null, 1));
