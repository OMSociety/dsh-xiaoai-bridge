// Print a readable transcript from a dumped session JSONL.
// Usage: node dump-convo.mjs <session.jsonl> [maxChars]
import { readFileSync } from "node:fs";
const [, , file, maxArg] = process.argv;
const max = Number(maxArg || 400);
const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const t = rec.type;
  if (t !== "assistant/message" && t !== "user/message" && t !== "system/message" && t !== "tool/result" && t !== "request/header") continue;
  const msg = rec.data?.message;
  if (t === "request/header") {
    const cfg = rec.data?.header?.config;
    const tools = (rec.data?.header?.tools || []).map((x) => x.name);
    console.log(`\n== request/header  ${cfg?.provider}/${cfg?.model}  tools(${tools.length}): ${tools.join(" ")}`);
    continue;
  }
  const parts = [];
  for (const c of msg?.content || []) {
    if (c.type === "text") parts.push(c.text.replace(/\s+/g, " "));
    else if (c.type === "reasoning") parts.push(`[think] ${String(c.text).replace(/\s+/g, " ")}`);
    else if (c.type === "tool-call") parts.push(`[call] ${c.name} ${c.arguments}`);
    else parts.push(`[${c.type}]`);
  }
  const body = parts.join(" | ");
  console.log(`\n-- ${t} t${rec.data?.turn ?? "?"}s${rec.data?.step ?? "?"}: ${body.slice(0, max)}`);
}
