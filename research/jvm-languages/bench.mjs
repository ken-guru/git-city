// usage: node bench.mjs <lang: java|ktG|ktF|ktHead> <root dir> [ext]
import { Parser, Language, Query } from 'web-tree-sitter';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const base = '/tmp/claude-1000/-workspace/29babd88-0ee3-42fc-9906-f088e1d90ef2/scratchpad/jvm/';
const [, , which, root] = process.argv;
const wasm = {
  java: base + 'node_modules/tree-sitter-java/tree-sitter-java.wasm',
  ktG: base + 'node_modules/@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm',
  ktF: base + 'dl/fwcd-0.3.8.wasm',
  ktHead: base + 'build/tree-sitter-kotlin.wasm',
}[which];
const ext = which === 'java' ? '.java' : '.kt';
const queries = {
  java: `
(package_declaration [(identifier) (scoped_identifier)] @package)
(import_declaration [(identifier) (scoped_identifier)] @import) @importDecl
(program [(class_declaration name: (identifier) @type)
          (interface_declaration name: (identifier) @type)
          (enum_declaration name: (identifier) @type)
          (record_declaration name: (identifier) @type)
          (annotation_type_declaration name: (identifier) @type)])`,
  ktG: `
(package_header (qualified_identifier) @package)
(import [(identifier) (qualified_identifier)] @import) @importDecl
(source_file [(class_declaration name: (identifier) @type)
              (object_declaration name: (identifier) @type)
              (type_alias type: (identifier) @type)])`,
  ktF: `
(package_header (identifier) @package)
(import_header (identifier) @import) @importDecl
(source_file [(class_declaration (type_identifier) @type)
              (object_declaration (type_identifier) @type)
              (type_alias (type_identifier) @type)])`,
};
queries.ktHead = queries.ktF;
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (p.endsWith(ext)) files.push(p);
  }
})(root);
await Parser.init();
const t0 = performance.now();
const lang = await Language.load(wasm);
const tLoad = performance.now() - t0;
const parser = new Parser();
parser.setLanguage(lang);
let q;
try { q = new Query(lang, queries[which]); } catch (e) { console.log('query error', e.message); process.exit(1); }
let bytes = 0, errFiles = 0, imports = 0, wild = 0, stat = 0, alias = 0, types = 0, noPkg = 0, pkgDirMismatch = 0, multiType = 0;
const srcs = files.map(f => readFileSync(f, 'utf8'));
const t1 = performance.now();
const examples = [];
srcs.forEach((src, i) => {
  bytes += Buffer.byteLength(src);
  const tree = parser.parse(src);
  if (tree.rootNode.hasError) errFiles++;
  let pkg = null, nTypes = 0;
  for (const c of q.captures(tree.rootNode)) {
    if (c.name === 'package') pkg = c.node.text.replace(/\s+/g, '');
    else if (c.name === 'type') { types++; nTypes++; }
    else if (c.name === 'importDecl') {
      imports++;
      const t = c.node.text;
      if (/\*\s*;?\s*$/.test(t)) wild++;
      if (/^import\s+static\b/.test(t)) stat++;
      if (/\bas\s+\w+\s*$/.test(t)) alias++;
    }
  }
  if (nTypes > 1) multiType++;
  if (!pkg) noPkg++;
  else {
    const dir = files[i].replace(/\/[^/]+$/, '');
    if (!dir.endsWith('/' + pkg.replace(/\./g, '/'))) { pkgDirMismatch++; if (examples.length < 3) examples.push(files[i] + ' pkg=' + pkg); }
  }
  tree.delete();
});
const tParse = performance.now() - t1;
console.log(JSON.stringify({ which, root, files: files.length, MB: +(bytes / 1e6).toFixed(2), loadMs: +tLoad.toFixed(0), parseAndQueryMs: +tParse.toFixed(0), MBperS: +((bytes / 1e6) / (tParse / 1000)).toFixed(1), filesWithErrors: errFiles, imports, wildcard: wild, static: stat, alias, topLevelTypes: types, filesWithMultipleTopLevelTypes: multiType, noPackage: noPkg, pkgDirMismatch, examples }, null, 0));
