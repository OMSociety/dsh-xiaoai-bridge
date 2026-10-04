// CHANGELOG structure QA: version headings, CN-then-EN ordering, 1:1 items. Run from anywhere: node tools/changelog-check.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const body = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const lines = body.split('\n');

const CN = { 新增: 'Added', 变更: 'Changed', 废弃: 'Deprecated', 移除: 'Removed', 修复: 'Fixed', 安全: 'Security' };
const EN = new Set(Object.values(CN));

const versions = [];
let version = null;
let group = null;
let problems = 0;

lines.forEach((line, i) => {
  const v = /^## \[([^\]]+)\](.*)$/.exec(line);
  if (v) {
    version = { name: v[1], date: v[2].trim(), groups: [], line: i + 1 };
    versions.push(version);
    group = null;
    return;
  }
  const c = /^### (.+)$/.exec(line);
  if (c && version) {
    const name = c[1].trim();
    const lang = CN[name] ? 'cn' : EN.has(name) ? 'en' : 'other';
    group = { name, lang, items: 0, line: i + 1 };
    version.groups.push(group);
    if (lang === 'other') {
      console.log(`CATEGORY unknown "${name}" at line ${i + 1}`);
      problems += 1;
    }
    return;
  }
  if (/^- /.test(line) && group) group.items += 1;
});

for (const v of versions) {
  const seenEn = v.groups.findIndex((g) => g.lang === 'en');
  const lastCn = v.groups.reduce((acc, g, i) => (g.lang === 'cn' ? i : acc), -1);
  if (seenEn !== -1 && lastCn > seenEn) {
    console.log(`ORDER ${v.name}: Chinese category after English`);
    problems += 1;
  }
  const cn = new Map(v.groups.filter((g) => g.lang === 'cn').map((g) => [CN[g.name], g]));
  const en = new Map(v.groups.filter((g) => g.lang === 'en').map((g) => [g.name, g]));
  for (const [enName, cng] of cn) {
    const eng = en.get(enName);
    if (!eng) {
      console.log(`MISSING ${v.name}: ### ${enName} has no English counterpart`);
      problems += 1;
    } else if (eng.items !== cng.items) {
      console.log(`COUNT ${v.name}: ${enName} ${cng.items} cn vs ${eng.items} en`);
      problems += 1;
    }
  }
  for (const enName of en.keys()) {
    if (!cn.has(enName)) {
      console.log(`MISSING ${v.name}: ### ${enName} has no Chinese counterpart`);
      problems += 1;
    }
  }
  if (v.name !== 'Unreleased' && !/^- \d{4}-\d{2}-\d{2}$/.test(v.date)) {
    console.log(`DATE ${v.name}: "${v.date}"`);
    problems += 1;
  }
  if (v.name === 'Unreleased' && v.date !== '') {
    console.log(`DATE Unreleased must not carry a date`);
    problems += 1;
  }
}

console.log(`versions: ${versions.length} (${versions.map((v) => v.name).join(', ')})`);
console.log(problems === 0 ? 'changelog check OK' : `changelog check: ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
