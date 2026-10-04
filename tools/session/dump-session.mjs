// Dump a DSH session file (session.v4.jsonl.zstd) to plain JSONL and report tool facts.
// Usage: node dump-session.mjs <path-to-.jsonl.zstd> [outFile] [regex]
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const [, , src, out, rePat] = process.argv;
if (!src) {
  console.error("usage: node dump-session.mjs <src.jsonl.zstd> [out.jsonl] [regex]");
  process.exit(2);
}
const raw = readFileSync(src);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
for (let i = 0; i + 3 < raw.length; i++) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) offsets.push(i);
}
let text;
if (offsets.length > 1) {
  // The session file is a concatenation of zstd frames (one per append) and a
  // one-shot decompress only yields the first frame: decode frame by frame.
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
    try {
      parts.push(zlib.zstdDecompressSync(raw.subarray(offsets[k], end)));
    } catch (err) {
      console.error(`frame ${k} failed: ${err.message}`);
    }
  }
  text = Buffer.concat(parts).toString("utf8");
  console.error(`frames: ${offsets.length}`);
} else if (typeof zlib.zstdDecompressSync === "function") {
  text = zlib.zstdDecompressSync(raw).toString("utf8");
} else {
  console.error("no zstd support in this node");
  process.exit(3);
}
if (out) writeFileSync(out, text, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
console.log(`lines: ${lines.length}  bytes: ${Buffer.byteLength(text)}`);

// Every distinct tool name mentioned anywhere as a JSON "name" inside a tools array.
const toolNames = new Set();
for (const line of lines) {
  const m = line.matchAll(/"name":"([a-zA-Z0-9_\-.:]{2,60})"/g);
  for (const hit of m) toolNames.add(hit[1]);
}
const interesting = [...toolNames].filter((n) => /^(sidebar|browser|kimi|argo|filesystem|web|skill|read|write|edit|glob|grep|pwsh|bash|task|todo|present)/i.test(n));
console.log("toolish names:", interesting.sort().join(", "));
console.log("total distinct names:", toolNames.size);

if (rePat) {
  const re = new RegExp(rePat, "i");
  const hits = lines.filter((l) => re.test(l));
  console.log(`--- ${hits.length} line(s) matching ${rePat} ---`);
  for (const h of hits.slice(0, 20)) console.log(h.slice(0, 900));
}
