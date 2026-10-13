// Survey of top-starred Java/Kotlin repos: build system + dependency declaration styles.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { maxBuffer: 1 << 28 }).toString());
const out = [];
for (const language of ['java', 'kotlin']) {
  const repos = gh(`search/repositories?q=language:${language}+stars:>3000+pushed:>2026-01-01&sort=stars&per_page=40`).items;
  for (const r of repos) {
    let tree;
    try { tree = gh(`repos/${r.full_name}/git/trees/${r.default_branch}?recursive=1`).tree; } catch { continue; }
    const paths = tree.filter(t => t.type === 'blob').map(t => t.path).filter(p => !/(^|\/)(test|tests|src\/test|samples?|examples?|fixtures?|testdata|resources)\//i.test(p));
    const build = paths.filter(p => /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|libs\.versions\.toml)$/.test(p));
    const rec = { repo: r.full_name, language, stars: r.stargazers_count, pom: build.filter(p => p.endsWith('pom.xml')).length, groovy: build.filter(p => p.endsWith('build.gradle')).length, kts: build.filter(p => p.endsWith('build.gradle.kts')).length, toml: build.filter(p => p.endsWith('libs.versions.toml')).length, buildSrc: paths.some(p => /^(buildSrc|build-logic|gradle\/plugins)\//.test(p)), styles: { catalog: 0, stringLiteral: 0, mapNotation: 0, project: 0, otherRef: 0, pomDep: 0, pomDepPropertyVersion: 0, pomDepNoVersion: 0 }, pomParent: 0 };
    const gradleFiles = build.filter(p => /build\.gradle(\.kts)?$/.test(p)).slice(0, 12);
    const pomFiles = build.filter(p => p.endsWith('pom.xml')).slice(0, 12);
    for (const p of [...gradleFiles, ...pomFiles]) {
      let txt;
      try { txt = execFileSync('curl', ['-sfL', `https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/${p}`]).toString(); } catch { continue; }
      if (p.endsWith('pom.xml')) {
        if (/<parent>/.test(txt)) rec.pomParent++;
        const body = txt.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '').replace(/<build>[\s\S]*?<\/build>/g, '');
        for (const d of body.match(/<dependency>[\s\S]*?<\/dependency>/g) || []) {
          rec.styles.pomDep++;
          if (!/<version>/.test(d)) rec.styles.pomDepNoVersion++;
          else if (/<version>\s*\$\{/.test(d)) rec.styles.pomDepPropertyVersion++;
        }
        continue;
      }
      // crude: take text inside dependencies { ... } blocks (top-level and nested), line by line
      const lines = [];
      let depth = 0, inDeps = 0;
      for (const line of txt.split('\n')) {
        if (/^\s*dependencies\s*\{/.test(line) && !inDeps) { inDeps = 1; depth = 0; }
        if (inDeps) {
          lines.push(line);
          depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          if (depth <= 0) inDeps = 0;
        }
      }
      for (const l of lines) {
        const m = l.match(/^\s*(\w+)\s*[\( ]\s*(.*)$/);
        if (!m || /^(dependencies|if|for|val|def|constraints|exclude|because|attributes|capabilities)$/.test(m[1])) continue;
        const arg = m[2];
        if (/^(platform\(|enforcedPlatform\()?\s*libs\./.test(arg) || /^\(?libs\./.test(arg)) rec.styles.catalog++;
        else if (/^(platform\(|enforcedPlatform\(|kotlin\(|testFixtures\()?\s*["'][\w.\-]+:[\w.\-]+/.test(arg)) rec.styles.stringLiteral++;
        else if (/group\s*[:=]/.test(arg)) rec.styles.mapNotation++;
        else if (/^(platform\()?\s*(project\(|projects\.|path\s*:)/.test(arg) || /^\(?project/.test(arg)) rec.styles.project++;
        else if (/^[(\s]*[\w$]/.test(arg)) rec.styles.otherRef++;
      }
    }
    out.push(rec);
    process.stderr.write('.');
  }
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
