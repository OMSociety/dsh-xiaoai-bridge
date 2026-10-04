import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const p = fileURLToPath(new URL("../../lib/client.js", import.meta.url));
const s = statSync(p);
console.log("mtimeMs =", s.mtimeMs, "ctimeMs =", s.ctimeMs, "size =", s.size);

function shortHash(input) { return createHash("sha1").update(input).digest("hex").slice(0, 12); }
function framedHash(domain, parts) {
  const h = createHash("sha1").update(domain);
  for (const part of parts) h.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return h.digest("hex").slice(0, 12);
}
const rev = framedHash("plugin-artifact", [String(s.mtimeMs), String(s.ctimeMs), String(s.size)]);
console.log("computed rev =", rev);

for (const suffix of ["", ".map"]) {
  const url = `http://127.0.0.1:19387/plugins/dsh-xiaoai-bridge/client.js${suffix}?rev=${rev}`;
  const r = await fetch(url);
  const body = await r.text();
  console.log(url, "->", r.status, "bytes=" + body.length, r.status === 200 ? body.slice(0, 60).replace(/\n/g, "\\n") : body.slice(0, 80));
}
