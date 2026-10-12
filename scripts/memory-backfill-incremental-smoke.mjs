// Smoke test: incremental semantic backfill (iteration 11).
// Bug: backfill only fired while the semantic index had <5 entries, so every
// memory added AFTER the first seed was never semantically indexed — recall
// silently went stale. Fix: backfill whenever an eligible memory is unindexed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { MemoryStore } = await import(pathToFileURL(path.join(ROOT, "src/core/memory-store.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-bf-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
const now = new Date().toISOString();
// 8 long-term memories — comfortably past the old size<5 seed cutoff.
const longTerm = Array.from({ length: 8 }, (_, i) => ({
  id: `m${i}`, title: `topic ${i}`, text: `long term memory number ${i} about subject ${i}`, createdAt: now,
}));
fs.writeFileSync(path.join(tmp, "data", "memory.json"), JSON.stringify({ longTerm }));
const store = new MemoryStore(tmp);

// Fake semantic memory whose backfill actually "indexes" (adds ids), records
// each call's item ids, and self-throttles like the real one.
const makeSemantic = () => {
  const embeddings = new Map();
  const calls = [];
  return {
    embeddings,
    async searchText() { return []; },
    async backfillFromItems(items = [], { max = 200 } = {}) {
      calls.push(items.map((i) => i.id));
      let indexed = 0;
      for (const it of items) {
        if (indexed >= max) break;
        if (embeddings.has(it.id)) continue;
        embeddings.set(it.id, { text: it.text, embedding: [1], metadata: {}, timestamp: now });
        indexed += 1;
      }
      return { indexed };
    },
    _callLog: calls,
  };
};

// ── 1. Empty index + 8 eligible → backfill fires (past the old <5 cutoff) ────
const sem = makeSemantic();
await store.hybridSearch({ query: "subject", semanticMemory: sem, limit: 5 });
await new Promise((r) => setTimeout(r, 30)); // let the fire-and-forget settle
check("backfill fires even with >5 items (old bug: it wouldn't)", sem._callLog.length >= 1, JSON.stringify(sem._callLog.length));
check("all 8 eligible items indexed", sem.embeddings.size === 8, String(sem.embeddings.size));

// ── 2. Everything indexed → next search does NOT re-trigger backfill ─────────
const before = sem._callLog.length;
await store.hybridSearch({ query: "subject", semanticMemory: sem, limit: 5 });
await new Promise((r) => setTimeout(r, 30));
check("no redundant backfill when all indexed", sem._callLog.length === before, `before=${before} after=${sem._callLog.length}`);

// ── 3. A NEW memory added later → backfill catches it up (the core fix) ──────
const data = JSON.parse(fs.readFileSync(path.join(tmp, "data", "memory.json"), "utf8"));
data.longTerm.push({ id: "m_new", title: "fresh topic", text: "a brand new long term memory added later", createdAt: now });
fs.writeFileSync(path.join(tmp, "data", "memory.json"), JSON.stringify(data));
await store.hybridSearch({ query: "fresh", semanticMemory: sem, limit: 5 });
await new Promise((r) => setTimeout(r, 30));
check("new memory triggers incremental backfill", sem._callLog.length === before + 1, `calls=${sem._callLog.length}`);
check("new memory now in semantic index", sem.embeddings.has("m_new"), JSON.stringify([...sem.embeddings.keys()]));

// ── 4. No semantic memory provided → keyword path unaffected ────────────────
const res = await store.hybridSearch({ query: "subject", limit: 5 });
check("keyword-only path still works", res.mode === "keyword" && res.count > 0, JSON.stringify({ mode: res.mode, n: res.count }));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
