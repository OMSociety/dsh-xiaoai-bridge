// app.asar 读取/提取工具（只读原文件，不修改）
// 用法:
//   node asar-tool.mjs probe
//   node asar-tool.mjs find <substr>
//   node asar-tool.mjs extract <asar内路径> <输出目录> [数量上限]
import fs from 'node:fs';
import path from 'node:path';

const ASAR = process.env.DSH_ASAR ?? 'D:\\Program Files\\DeepSeek Harness\\resources\\app.asar';
const buf = fs.readFileSync(ASAR);

function loadHeader() {
  const a = buf.readUInt32LE(0), b = buf.readUInt32LE(4), c = buf.readUInt32LE(8), d = buf.readUInt32LE(12);
  const candidates = [
    { jsonStart: 16, size: d },
    { jsonStart: 8, size: b },
    { jsonStart: 12, size: c },
  ];
  for (const cand of candidates) {
    try {
      const s = buf.slice(cand.jsonStart, cand.jsonStart + cand.size).toString('utf8');
      const j = JSON.parse(s);
      return { ...cand, header: j, u32: [a, b, c, buf.readUInt32LE(12)] };
    } catch { /* try next */ }
  }
  throw new Error(`cannot parse header; u32@0,4,8,12 = ${a},${b},${c},${buf.readUInt32LE(12)}`);
}

const H = loadHeader();
const HEADER_END = H.jsonStart + H.size;

function walk(node, prefix, cb) {
  if (!node || typeof node !== 'object') return;
  if (node.files) {
    for (const [k, v] of Object.entries(node.files)) walk(v, prefix ? prefix + '/' + k : k, cb);
  } else {
    cb(prefix, node);
  }
}

function readFile(node) {
  const off = Number(node.offset);
  const size = Number(node.size);
  return buf.slice(HEADER_END + off, HEADER_END + off + size);
}

const mode = process.argv[2];
if (mode === 'probe') {
  console.log('u32@0,4,8,12 =', H.u32.join(','));
  console.log('jsonStart =', H.jsonStart, 'jsonSize =', H.size, 'headerEnd =', HEADER_END);
  console.log('top-level keys =', Object.keys(H.header.files || {}).join(', '));
} else if (mode === 'find') {
  const needle = (process.argv[3] || '').toLowerCase();
  let n = 0;
  walk(H.header, '', (p, node) => {
    if (p.toLowerCase().includes(needle)) { console.log(p, node.size ?? '(dir)'); n++; }
  });
  console.log('--- matches:', n);
} else if (mode === 'extract') {
  const target = process.argv[3].replace(/^\/+|\/+$/g, '');
  const outDir = process.argv[4];
  const limit = Number(process.argv[5] || 100000);
  let n = 0;
  walk(H.header, '', (p, node) => {
    if (n >= limit) return;
    if (!p.startsWith(target)) return;
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readFile(node));
    n++;
  });
  console.log('extracted files:', n, '->', outDir);
} else if (mode === 'grep') {
  const needle = process.argv[3];
  const pathFilter = process.argv[4] || '';
  const limit = Number(process.argv[5] || 40);
  let n = 0;
  walk(H.header, '', (p, node) => {
    if (n >= limit) return;
    if (pathFilter && !p.includes(pathFilter)) return;
    if ((node.size ?? 0) > 8 * 1024 * 1024) return;
    let text;
    try { text = readFile(node).toString('utf8'); } catch { return; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        console.log(`${p}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        n++;
        if (n >= limit) return;
      }
    }
  });
  console.log('--- matches:', n);
} else {
  console.log('usage: probe | find <substr> | grep <needle> [pathFilter] [limit] | extract <path> <outdir> [limit]');
}
