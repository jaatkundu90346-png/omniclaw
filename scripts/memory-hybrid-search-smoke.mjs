// Smoke test: hybridSearch keyword+semantic UNION (iteration 10).
// Bug: `merged` was built ONLY from keyword matches, so a memory relevant
// SEMANTICALLY but sharing no literal keywords (the whole point of embeddings)
// was silently dropped — the "hybrid" search was keyword-gated. Fix: union of
// keyword AND semantic candidates.
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

// Temp workspace with three long-term memories.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-mem-"));
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(path.join(tmp, "data", "memory.json"), JSON.stringify({
  longTerm: [
    { id: "m1", title: "deploy runbook", text: "run npm run build then deploy the gateway exe", createdAt: now },
    { id: "m2", title: "login token flow", text: "the session cookie is issued after the pairing handshake", createdAt: now },
    { id: "m3", title: "unrelated recipe", text: "how to bake sourdough bread at home", createdAt: now },
  ],
}));

const store = new MemoryStore(tmp);

// Fake semantic memory: for the query, m2 is the semantically-closest match
// even though it shares NO keyword with the query "how do I authenticate a user".
const fakeSemantic = {
  embeddings: { size: 100 }, // pretend already-indexed so no backfill path
  searchText: async () => ([
    { id: "m2", text: "login token flow", similarity: 0.62, metadata: {}, timestamp: now },
  ]),
};

// ── Query with NO keyword overlap with m2 ("authenticate" vs "login/token") ──
const q = "how do I authenticate a user";
const res = await store.hybridSearch({ query: q, semanticMemory: fakeSemantic, limit: 10 });
const ids = res.results.map((r) => r.id);
check("mode is keyword+semantic", res.mode === "keyword+semantic", res.mode);
check("semantic-only match m2 INCLUDED (was dropped before)", ids.includes("m2"), JSON.stringify(ids));
const m2 = res.results.find((r) => r.id === "m2");
check("m2 has semanticScore, keywordScore 0", m2 && m2.semanticScore > 0 && m2.keywordScore === 0, JSON.stringify(m2 && { k: m2.keywordScore, s: m2.semanticScore }));
check("semantic-only ranks by similarity (score>0)", m2 && m2.score > 0, JSON.stringify(m2 && m2.score));

// ── Keyword-only still works when no semantic memory is provided ─────────────
const res2 = await store.hybridSearch({ query: "deploy the gateway", limit: 10 });
const ids2 = res2.results.map((r) => r.id);
check("keyword-only mode without embeddings", res2.mode === "keyword", res2.mode);
check("keyword match m1 present", ids2.includes("m1"), JSON.stringify(ids2));
check("irrelevant recipe m3 absent", !ids2.includes("m3"), JSON.stringify(ids2));

// ── Union does not duplicate an item that matches BOTH ways ─────────────────
const fakeSemantic2 = {
  embeddings: { size: 100 },
  searchText: async () => ([{ id: "m1", text: "deploy runbook", similarity: 0.7, metadata: {}, timestamp: now }]),
};
const res3 = await store.hybridSearch({ query: "deploy the gateway", semanticMemory: fakeSemantic2, limit: 10 });
const m1Count = res3.results.filter((r) => r.id === "m1").length;
check("item matching both keyword+semantic appears ONCE", m1Count === 1, `count=${m1Count}`);
const m1 = res3.results.find((r) => r.id === "m1");
check("both-match item has both scores combined", m1 && m1.keywordScore > 0 && m1.semanticScore > 0, JSON.stringify(m1 && { k: m1.keywordScore, s: m1.semanticScore }));

// ── Empty query short-circuits ──────────────────────────────────────────────
const res4 = await store.hybridSearch({ query: "  " });
check("empty query → empty-query mode", res4.mode === "empty-query" && res4.count === 0, JSON.stringify(res4));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
