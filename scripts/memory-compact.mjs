// Memory maintenance: shrink + scrub data/memory.json and agent memory files.
// Dry-run by default; --apply writes a timestamped backup first.
//
// Why this exists: measured 2026-09-26, the live store was 49 MB of JSON —
// 755 conversation records, 38 MB raw toolOutputs (whole file contents) + 9.5 MB
// plan blobs that nothing reads — and workspace/agents/main/memory/ contained a
// file with a real API key. Bounding/redacting at write time is
// `boundConversationRecord` + `writeStructuredMemory` in memory-store.js; this
// script one-time-fixes an already-bloated / already-leaky store.
//
// Usage:
//   node scripts/memory-compact.mjs                 # dry run (safe)
//   node scripts/memory-compact.mjs --apply         # write + backups
import fs from "node:fs";
import path from "node:path";
import {
  boundConversationRecord, CONVERSATION_RETENTION,
} from "../src/core/memory-store.js";
import { redactSecrets } from "../src/core/secret-redact.js";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const file = path.join(ROOT, "data", "memory.json");
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backup = (p) => {
  const dest = `${p}.bak-precompact-${stamp()}`;
  fs.copyFileSync(p, dest);
  return path.relative(ROOT, dest);
};

console.log("=== memory maintenance ===");

// Redact AFTER parsing: rewriting the raw JSON text can break the document
// itself (the value patterns also match inside quoted URLs / JSON fields).
// Walking the parsed object keeps the JSON valid by construction.
function deepRedact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepRedact(item, depth + 1);
    return out;
  }
  return value;
}
function countStrings(value, pred, depth = 0) {
  if (depth > 6 || value == null) return 0;
  if (typeof value === "string") return pred(value) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((a, item) => a + countStrings(item, pred, depth + 1), 0);
  if (typeof value === "object") return Object.values(value).reduce((a, item) => a + countStrings(item, pred, depth + 1), 0);
  return 0;
}

if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8");
  const beforeBytes = Buffer.byteLength(raw, "utf8");
  const data = JSON.parse(raw);
  const sumOf = (key) => (data.conversations || []).reduce((a, c) => a + JSON.stringify(c[key] || "").length, 0);
  console.log(`store : ${kb(beforeBytes)} · ${(data.conversations || []).length} conversations · toolOutputs ${kb(sumOf("toolOutputs"))} · plans ${kb(sumOf("plan"))}`);
  const secretsBefore = countStrings(data, (s) => /sk-(?:live|test|prod|dev|free)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{30,}|nvapi-[A-Za-z0-9_-]{10,}/.test(s));
  const scrubbed = deepRedact(data);
  const conversations = (scrubbed.conversations || [])
    .slice(-CONVERSATION_RETENTION)
    .map((entry) => boundConversationRecord(entry));
  const encoded = JSON.stringify({ ...scrubbed, conversations }, null, 2);
  const afterBytes = Buffer.byteLength(encoded, "utf8");
  console.log(`after : ${kb(afterBytes)} · toolOutputs ${kb(conversations.reduce((a, c) => a + JSON.stringify(c.toolOutputs || []).length, 0))} · plans ${kb(conversations.reduce((a, c) => a + JSON.stringify(c.plan || "").length, 0))}`);
  console.log(`saved : ${kb(beforeBytes - afterBytes)} (${Math.round((1 - afterBytes / Math.max(1, beforeBytes)) * 100)}%)`);
  console.log(`secrets masked in store: ${secretsBefore}`);
  console.log(`user text intact in ${conversations.filter((c) => (c.user || "").length > 0).length} conversations`);
  if (APPLY) {
    try { JSON.parse(encoded); } catch (error) {
      console.log(`REFUSING TO WRITE — compacted JSON would be invalid: ${error.message}`);
      process.exit(2);
    }
    console.log(`APPLIED store → backup ${backup(file)}`);
    fs.writeFileSync(file, encoded);
  } else {
    console.log("DRY RUN — store not written (re-run with --apply)");
  }
} else {
  console.log(`no memory store at ${file} — skipping store pass`);
}

// Agent memory files (workspace/agents/<id>/memory/*.md) — secret scrub.
const agentsDir = path.join(ROOT, "workspace", "agents");
const secretish = /sk-(?:live|test|prod|dev|free)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{30,}|nvapi-[A-Za-z0-9_-]{10,}/;
let scanned = 0;
let dirty = 0;
for (const agent of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
  const memDir = path.join(agentsDir, agent, "memory");
  if (!fs.existsSync(memDir)) continue;
  for (const name of fs.readdirSync(memDir)) {
    if (!name.endsWith(".md")) continue;
    const p = path.join(memDir, name);
    let text = "";
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
    scanned += 1;
    if (!secretish.test(text)) continue;
    dirty += 1;
    console.log(`secret file: ${path.relative(ROOT, p).replace(/\\/g, "/")} → masked`);
    if (APPLY) {
      fs.copyFileSync(p, `${p}.bak-prescrub-${stamp()}`);
      fs.writeFileSync(p, redactSecrets(text));
    }
  }
}
console.log(`memory files scanned: ${scanned} · containing secrets: ${dirty}`);
if (!APPLY) console.log("\nDRY RUN — nothing written. Re-run with --apply to compact + scrub.");
process.exit(0);
