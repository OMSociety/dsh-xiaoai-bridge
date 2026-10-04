// Docs QA: emoji / `---` / table width / README anchors. Run from anywhere: node tools/doc-check.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{2049}\u{203C}]/u;

function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]+/gu, '')
    .replace(/ /g, '-');
}

let problems = 0;
for (const file of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
  const body = readFileSync(`${root}/${file}`, 'utf8');
  const lines = body.split('\n');

  lines.forEach((line, i) => {
    if (EMOJI.test(line)) {
      console.log(`EMOJI  ${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
      problems += 1;
    }
    if (/^---\s*$/.test(line)) {
      console.log(`HRULE  ${file}:${i + 1}`);
      problems += 1;
    }
  });

  // table column parity
  let table = null;
  lines.forEach((line, i) => {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (isRow) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').length;
      if (!table) table = { start: i + 1, cells, rows: 1 };
      else {
        table.rows += 1;
        if (cells !== table.cells) {
          console.log(`TABLE  ${file}:${i + 1}  ${cells} cells, table at ${table.start} has ${table.cells}`);
          problems += 1;
        }
      }
    } else {
      table = null;
    }
  });
}

const readme = readFileSync(`${root}/README.md`, 'utf8');
const headings = new Set(
  readme
    .split('\n')
    .filter((l) => /^#{2,3} /.test(l))
    .map((l) => slug(l.replace(/^#{2,3} /, ''))),
);
const anchors = [
  ...[...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]),
  ...[...readme.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]),
];
const missing = [...new Set(anchors)].filter((a) => !headings.has(a));
console.log(`anchors in README: ${new Set(anchors).size}, headings: ${headings.size}`);
if (missing.length) {
  console.log(`ANCHOR missing: ${missing.join(', ')}`);
  problems += missing.length;
}

console.log(problems === 0 ? 'docs check OK' : `docs check: ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
