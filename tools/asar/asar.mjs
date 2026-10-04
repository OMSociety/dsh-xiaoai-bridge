// Read the DSH app.asar (no extraction to disk). Usage:
//   node asar.mjs list  <asarPath> <innerPath>
//   node asar.mjs cat   <asarPath> <innerPath>
//   node asar.mjs grep  <asarPath> <innerPath> <regex> [maxHits]
import { openSync, readSync, closeSync } from 'node:fs';

const [cmd, asarPath, innerPath = '', pattern = '', maxArg] = process.argv.slice(2);
const maxHits = Number(maxArg) || 30;

function readHeader(fd) {
  const b = Buffer.alloc(16);
  readSync(fd, b, 0, 16, 0);
  const headerSize = b.readUInt32LE(12);
  const hb = Buffer.alloc(headerSize);
  readSync(fd, hb, 0, headerSize, 16);
  const header = JSON.parse(hb.toString('utf8').replace(/\0+$/, ''));
  return { header, dataOffset: 16 + headerSize };
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p, out);
    else out.push({ path: p, size: child.size ?? 0, offset: String(child.offset) });
  }
}

function readFileAt(fd, dataOffset, entry) {
  const buf = Buffer.alloc(entry.size);
  readSync(fd, buf, 0, entry.size, dataOffset + Number(entry.offset));
  return buf;
}

const fd = openSync(asarPath, 'r');
try {
  const { header, dataOffset } = readHeader(fd);
  if (cmd === 'list') {
    const node = nodeAt(header, innerPath);
    if (!node) throw new Error(`no such path: ${innerPath}`);
    if (node.files) {
      if (innerPath.endsWith('.json') || /\.(d\.ts|js|mjs|cjs)$/.test(innerPath)) {
        console.log(readFileAt(fd, dataOffset, { size: node.size, offset: String(node.offset) }).toString('utf8'));
      } else {
        console.log(Object.keys(node.files).sort().join('\n'));
      }
    } else {
      console.log(readFileAt(fd, dataOffset, { size: node.size, offset: String(node.offset) }).toString('utf8'));
    }
  } else if (cmd === 'cat') {
    const node = nodeAt(header, innerPath);
    if (!node || node.files) throw new Error(`not a file: ${innerPath}`);
    process.stdout.write(readFileAt(fd, dataOffset, node));
  } else if (cmd === 'find') {
    const files = [];
    walk(nodeAt(header, innerPath) ?? header, innerPath, files);
    const re = new RegExp(pattern, 'i');
    let hits = 0;
    for (const f of files) {
      if (!re.test(f.path)) continue;
      console.log(`${f.path}  (${f.size}B)`);
      hits += 1;
      if (hits >= maxHits) break;
    }
    console.log(`-- ${hits} path hit(s) --`);
  } else if (cmd === 'grep') {
    const files = [];
    walk(nodeAt(header, innerPath) ?? header, innerPath, files);
    const re = new RegExp(pattern, 'i');
    let hits = 0;
    for (const f of files) {
      if (!/\.(js|mjs|cjs|json|ts|d\.ts|yml|yaml)$/.test(f.path)) continue;
      let text;
      try { text = readFileAt(fd, dataOffset, f).toString('utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits < maxHits; i += 1) {
        if (re.test(lines[i])) {
          console.log(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          hits += 1;
        }
      }
      if (hits >= maxHits) break;
    }
    console.log(`-- ${hits} hit(s) --`);
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} finally {
  closeSync(fd);
}

function nodeAt(header, p) {
  if (!p) return header;
  let node = header;
  for (const part of p.split('/').filter(Boolean)) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}
