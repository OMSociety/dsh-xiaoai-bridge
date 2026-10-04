// One-off: list files inside an asar archive whose path matches a pattern.
// Usage: node asar-list.mjs <archive> <regex> [--extract <outDir> <regex>]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [archive, pattern, ...rest] = process.argv.slice(2);
const re = new RegExp(pattern, 'i');
const extractMode = rest[0] === '--extract';
const outDir = extractMode ? resolve(rest[1]) : null;

const fd = readFileSync(archive);
const headerSize = fd.readUInt32LE(4);
const jsonSize = fd.readUInt32LE(12);
const json = JSON.parse(fd.subarray(16, 16 + jsonSize).toString('utf8'));
const base = 8 + headerSize;

const hits = [];
function walk(node, prefix) {
	for (const [name, entry] of Object.entries(node.files ?? {})) {
		const p = `${prefix}/${name}`;
		if (entry.files) walk(entry, p);
		else {
			if (re.test(p)) hits.push({ path: p.slice(1), size: entry.size, offset: entry.offset ? Number(entry.offset) : 0 });
			if (extractMode) {
				const out = join(outDir, p.slice(1));
				mkdirSync(dirname(out), { recursive: true });
				writeFileSync(out, entry.offset ? fd.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size) : Buffer.alloc(0));
			}
		}
	}
}
walk(json, '');
hits.sort((a, b) => a.path.localeCompare(b.path));
for (const h of hits) console.log(`${h.size}\t${h.path}`);
console.log(`TOTAL ${hits.length}${extractMode ? ` extracted to ${outDir}` : ''}`);
