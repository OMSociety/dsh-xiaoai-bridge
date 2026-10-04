// 从 app.asar 里取出 presets/*.patch.yml（只读，不改 asar）。
// 不依赖 pickle 细节：直接在头部字节里定位 JSON 起点，再用大括号配平扫描取整段 JSON。
import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ASAR = process.argv[2] ?? process.env.DSH_ASAR ?? 'D:\\Program Files\\DeepSeek Harness\\resources\\app.asar';
const OUT = process.argv[3] ?? 'asar-presets';

const fd = openSync(ASAR, 'r');
const head = Buffer.alloc(8 * 1024 * 1024);
const got = readSync(fd, head, 0, head.length, 0);
const buf = head.subarray(0, got);

const start = buf.indexOf('{"files"');
if (start < 0) throw new Error('could not locate the asar header JSON');

// 大括号配平扫描（跳过字符串与转义）
let depth = 0, inStr = false, esc = false, end = -1;
for (let i = start; i < buf.length; i += 1) {
  const c = buf[i];
  if (inStr) {
    if (esc) esc = false;
    else if (c === 0x5c) esc = true;
    else if (c === 0x22) inStr = false;
  } else if (c === 0x22) inStr = true;
  else if (c === 0x7b) depth += 1;
  else if (c === 0x7d) { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) throw new Error('asar header JSON did not terminate inside the first 8 MiB');

const tree = JSON.parse(buf.subarray(start, end).toString('utf8'));
// 数据区起点：JSON 之后按 4 字节对齐
const headerSize = Math.ceil(end / 4) * 4;

const hits = [];
(function walk(node, prefix) {
  if (node.files) { for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name); return; }
  if (/(^|\/)presets\/[^/]*\.patch\.yml$/.test(prefix)) hits.push({ path: prefix, offset: Number(node.offset), size: node.size });
})(tree, '');

mkdirSync(OUT, { recursive: true });
const report = [];
for (const hit of hits) {
  const out = Buffer.alloc(hit.size);
  readSync(fd, out, 0, hit.size, headerSize + hit.offset);
  const name = hit.path.replace(/[\\/]/g, '__');
  writeFileSync(join(OUT, name), out);
  report.push({ path: hit.path, bytes: hit.size, out: join(OUT, name) });
}
closeSync(fd);
console.log(JSON.stringify({ asar: ASAR, headerJsonAt: start, headerSize, found: report.length, files: report }, null, 2));
