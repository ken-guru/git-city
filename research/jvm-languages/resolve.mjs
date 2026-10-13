// usage: node resolve.mjs <java|kotlin> <root>
// Prototype of the proposed resolver: stage-1 facts per file, stage-2 (package,name)->file index.
import { Parser, Language, Query } from 'web-tree-sitter';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const base = '/tmp/claude-1000/-workspace/29babd88-0ee3-42fc-9906-f088e1d90ef2/scratchpad/jvm/';
const [, , lang, root] = process.argv;
const cfg = {
  java: {
    wasm: base + 'node_modules/tree-sitter-java/tree-sitter-java.wasm', ext: ['.java'],
    q: `
(package_declaration [(identifier) (scoped_identifier)] @package)
(import_declaration) @import
(program [(class_declaration name: (identifier) @decl)
          (interface_declaration name: (identifier) @decl)
          (enum_declaration name: (identifier) @decl)
          (record_declaration name: (identifier) @decl)
          (annotation_type_declaration name: (identifier) @decl)])
(type_identifier) @ref
(identifier) @ref`,
  },
  kotlin: {
    wasm: base + 'build/tree-sitter-kotlin.wasm', ext: ['.kt'],
    q: `
(package_header (identifier) @package)
(import_header) @import
(source_file [(class_declaration (type_identifier) @decl)
              (object_declaration (type_identifier) @decl)
              (type_alias (type_identifier) @decl)
              (function_declaration (simple_identifier) @decl)
              (property_declaration (variable_declaration (simple_identifier) @decl))])
(type_identifier) @ref
(simple_identifier) @ref`,
  },
}[lang];
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (cfg.ext.some(x => p.endsWith(x))) files.push(p);
  }
})(root);
await Parser.init();
const L = await Language.load(cfg.wasm);
const parser = new Parser(); parser.setLanguage(L);
const q = new Query(L, cfg.q);
// stage 1: facts
const facts = files.map(f => {
  const tree = parser.parse(readFileSync(f, 'utf8'));
  const r = { file: f, pkg: '', imports: [], decls: new Set(), refs: new Set() };
  for (const c of q.captures(tree.rootNode)) {
    const t = c.node.text;
    if (c.name === 'package') r.pkg = t.replace(/\s+/g, '');
    else if (c.name === 'decl') r.decls.add(t);
    else if (c.name === 'ref') r.refs.add(t);
    else if (c.name === 'import') {
      const m = t.replace(/\s+/g, ' ').match(/^import (static )?([\w.` ]+?)(\.\*)?(?: as (\w+))?;?$/);
      if (m) r.imports.push({ static: !!m[1], path: m[2].replace(/[` ]/g, ''), wildcard: !!m[3], alias: m[4] });
    }
  }
  tree.delete();
  return r;
});
// stage 2: index
const index = new Map(); // pkg -> name -> [file]
for (const f of facts) {
  if (!index.has(f.pkg)) index.set(f.pkg, new Map());
  const m = index.get(f.pkg);
  for (const d of f.decls) { if (!m.has(d)) m.set(d, []); m.get(d).push(f.file); }
}
let explicit = 0, explicitHit = 0, wild = 0, wildRepo = 0, unresolvedRepoPrefix = 0;
const eExplicit = new Set(), eWild = new Set(), eSame = new Set(), eWildAll = new Set();
const repoRoots = new Set([...index.keys()].filter(Boolean).map(p => p.split('.').slice(0, 2).join('.')));
for (const f of facts) {
  for (const im of f.imports) {
    const parts = im.path.split('.');
    if (im.wildcard) {
      wild++;
      const pm = index.get(im.path);
      if (pm) {
        wildRepo++;
        for (const [n, fs] of pm) for (const t of fs) { if (t !== f.file) eWildAll.add(f.file + '>' + t); if (f.refs.has(n) && t !== f.file) eWild.add(f.file + '>' + t); }
      } else {
        // static wildcard on a type: import static a.b.C.*
        for (let i = parts.length - 1; i >= 1; i--) {
          const fs = index.get(parts.slice(0, i).join('.'))?.get(parts[i]);
          if (fs) { fs.forEach(t => t !== f.file && eWild.add(f.file + '>' + t)); wildRepo++; break; }
        }
      }
      continue;
    }
    explicit++;
    let hit = false;
    for (let i = parts.length - 1; i >= 1 && !hit; i--) {
      const fs = index.get(parts.slice(0, i).join('.'))?.get(parts[i]);
      if (fs) { hit = true; fs.forEach(t => t !== f.file && eExplicit.add(f.file + '>' + t)); }
    }
    if (hit) explicitHit++;
    else if (repoRoots.has(parts.slice(0, 2).join('.'))) unresolvedRepoPrefix++;
  }
  const pm = index.get(f.pkg);
  if (pm) for (const [n, fs] of pm) if (f.refs.has(n)) for (const t of fs) if (t !== f.file) eSame.add(f.file + '>' + t);
}
const all = new Set([...eExplicit, ...eWild, ...eSame]);
const ambiguous = [...index.values()].reduce((a, m) => a + [...m.values()].filter(v => v.length > 1).length, 0);
console.log(JSON.stringify({ lang, root, files: files.length, packages: index.size, explicitImports: explicit, explicitResolvedToRepo: explicitHit, explicitUnresolvedButRepoPrefix: unresolvedRepoPrefix, wildcardImports: wild, wildcardIntoRepo: wildRepo, edges: { explicit: eExplicit.size, wildcardRefFiltered: eWild.size, wildcardAllFiles: eWildAll.size, samePackageRefFiltered: eSame.size, union: all.size, onlyFromSamePackage: [...eSame].filter(e => !eExplicit.has(e) && !eWild.has(e)).length }, ambiguousPkgNamePairs: ambiguous }));
