// Decode a concatenated zstd frame stream (DSH writes one frame per append batch).
// Node's zstdDecompressSync only handles the first frame, so walk the frame
// headers manually and decompress each frame slice on its own.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const src = process.argv[2];
if (!src) {
  console.error('usage: node zstd-jsonl.mjs <file.zstd>');
  process.exit(2);
}
const buf = readFileSync(src);
const MAGIC = 0xfd2fb528;
const DICT_SIZES = [0, 1, 2, 4];
const FCS_SIZES = [0, 1, 2, 4, 8];

let off = 0;
let frames = 0;
const out = [];
while (off + 4 <= buf.length) {
  const start = off;
  if (buf.readUInt32LE(off) !== MAGIC) {
    console.error(`stopped at ${off}: no frame magic`);
    break;
  }
  off += 4;
  const fhd = buf[off++];
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSegment) off += 1;
  off += DICT_SIZES[dictFlag];
  off += fcsFlag === 0 && singleSegment ? 1 : FCS_SIZES[fcsFlag];
  for (;;) {
    const h = buf.readUIntLE(off, 3);
    off += 3;
    const last = h & 1;
    const type = (h >> 1) & 3;
    const size = h >> 3;
    if (type === 0) off += size;
    else if (type === 1) off += 1;
    else if (type === 2) off += size;
    else throw new Error(`reserved block type at ${off}`);
    if (last) break;
  }
  if (checksum) off += 4;
  frames += 1;
  out.push(zstdDecompressSync(buf.subarray(start, off)).toString('utf8'));
}

console.error(`frames=${frames} bytes=${buf.length}`);
process.stdout.write(out.join(''));
