import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(process.argv[2]));
for (const lang of ['java', 'kotlin']) {
  const rs = d.filter(r => r.language === lang);
  const kind = r => r.pom && !(r.groovy + r.kts) ? 'maven' : (r.groovy + r.kts) && !r.pom ? (r.kts >= r.groovy ? 'gradle-kts' : 'gradle-groovy') : r.pom ? 'both' : 'none';
  const c = {};
  rs.forEach(r => { const k = kind(r); c[k] = (c[k] || 0) + 1; });
  const gradle = rs.filter(r => r.groovy + r.kts);
  const s = gradle.reduce((a, r) => { for (const k in r.styles) a[k] = (a[k] || 0) + r.styles[k]; return a; }, {});
  const pom = rs.filter(r => r.pom).reduce((a, r) => { for (const k of ['pomDep', 'pomDepPropertyVersion', 'pomDepNoVersion']) a[k] = (a[k] || 0) + r.styles[k]; a.parent = (a.parent || 0) + r.pomParent; return a; }, {});
  // per-repo coverage for gradle: share of external declarations that are catalog or string literal
  const cov = gradle.map(r => { const ext = r.styles.catalog + r.styles.stringLiteral + r.styles.mapNotation + r.styles.otherRef; return ext ? (r.styles.catalog + r.styles.stringLiteral + r.styles.mapNotation) / ext : null; }).filter(x => x !== null);
  const ge80 = cov.filter(x => x >= 0.8).length;
  console.log(lang, 'repos', rs.length, JSON.stringify(c), 'toml repos', rs.filter(r => r.toml).length, 'buildSrc/build-logic', rs.filter(r => r.buildSrc).length);
  console.log('  gradle styles', JSON.stringify(s), 'repos with >=80% static ext decls', ge80, '/', cov.length);
  console.log('  pom', JSON.stringify(pom));
  console.log('  low-coverage gradle repos:', gradle.filter(r => { const ext = r.styles.catalog + r.styles.stringLiteral + r.styles.mapNotation + r.styles.otherRef; return ext && (r.styles.otherRef / ext) > 0.2; }).map(r => r.repo + '(' + r.styles.otherRef + '/' + (r.styles.catalog + r.styles.stringLiteral + r.styles.mapNotation + r.styles.otherRef) + ')').join(' '));
  console.log('  none:', rs.filter(r => kind(r) === 'none').map(r => r.repo).join(' '));
}
