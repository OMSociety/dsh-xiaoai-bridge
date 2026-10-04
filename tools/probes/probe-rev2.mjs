import { statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function framedHash(domain, parts) {
  const h = createHash("sha1").update(domain);
  for (const part of parts) h.update(`${String(Buffer.byteLength(part))}:`).update(part);
  return h.digest("hex").slice(0, 12);
}
function revOf(p) {
  const s = statSync(p);
  return framedHash("plugin-artifact", [String(s.mtimeMs), String(s.ctimeMs), String(s.size)]);
}

const profile = process.env.DSH_PROFILE_NODE_MODULES ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');
for (const id of ["dsh-mineru", "dsh-better-sidebar", "dsh-git-forge", "dsh-ssh-tunnel", "dsh-xiaoai-bridge"]) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(`${profile}/${id}/package.json`, "utf8")); } catch (e) { console.log(id, "no package.json"); continue; }
  const ex = pkg.exports?.["./client"];
  const rel = typeof ex === "string" ? ex : ex?.default;
  if (!rel) { console.log(id, "-> no ./client export"); continue; }
  const full = `${profile}/${id}/${rel.replace(/^\.\//, "")}`;
  let rev;
  try { rev = revOf(full); } catch (e) { console.log(id, "-> stat failed", full); continue; }
  const url = `http://127.0.0.1:19387/plugins/${id}/client.js?rev=${rev}`;
  const r = await fetch(url);
  console.log(`${id}  rev=${rev}  -> ${r.status}`);
}
