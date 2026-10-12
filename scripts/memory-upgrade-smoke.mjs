// Smoke test for the 2026-07-03 memory upgrade + complex-task guards:
// 1. token-ranked recall (multi-word Hinglish queries now match)
// 2. hybridSearch importance/recency boosts
// 3. AdaptiveEmbedder: provider embeddings + cache + lexical fallback
// 4. promote -> semantic index hook, and backfill
// 5. async memory brief includes relevant past exchanges
// 6. build-verify checkpoint fires on write-only runs (the GTA pattern)
// 7. rework-churn guard on repeated no-verify rewrites
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/core/memory-store.js";
import { SemanticMemory, SimpleTextEmbedder, AdaptiveEmbedder } from "../src/core/semantic-memory.js";
import { OmniLoop } from "../src/core/omni-loop.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-mem-"));

// ── 1. token-ranked recall ──────────────────────────────────────────────────
{
  const store = new MemoryStore(tmp);
  store.promoteMemory({ title: "User prefers dark theme", text: "Mankush ko dark theme pasand hai har website me", sourceType: "t", sourceId: "1", importance: "high" });
  store.promoteMemory({ title: "Project port", text: "OmniClaw gateway 3147 port par chalta hai", sourceType: "t", sourceId: "2" });
  store.addNote("user ka favourite stack: plain html css js with three.js", {});
  // Old substring search: this WHOLE message would match nothing.
  const hits = store.searchLongTerm("bhai website banao dark theme wali jaise pehle banayi thi");
  assert.ok(hits.length >= 1, "multi-word Hinglish query matches");
  assert.equal(hits[0].title, "User prefers dark theme", "most relevant memory ranked first");
  const noteHits = store.searchNotes("konsa stack use karna hai website ke liye three js");
  assert.ok(noteHits.length >= 1 && /three\.js/.test(noteHits[0].text), "notes ranked recall works");
  assert.equal(store.searchLongTerm("quantum blockchain kubernetes").length, 0, "irrelevant query returns nothing");
  ok("token-ranked recall (Hinglish multi-word queries)");
}

// ── 2. hybridSearch boosts ──────────────────────────────────────────────────
{
  const store = new MemoryStore(tmp);
  const res = await store.hybridSearch({ query: "dark theme website", limit: 5, semanticMemory: null });
  assert.ok(res.results.length >= 1, "hybrid results returned");
  const top = res.results[0];
  assert.ok(top.score > top.keywordScore * 0.7 - 0.001, "importance/recency boost applied");
  ok("hybridSearch ranks with importance + recency boosts");
}

// ── 3. AdaptiveEmbedder ─────────────────────────────────────────────────────
{
  // No embeddings config -> lexical vector (256 dims)
  const lex = new AdaptiveEmbedder({ configStore: { getConfig: () => ({ provider: {} }) }, secretStore: null });
  const v1 = await lex.embed("dark theme website");
  assert.equal(v1.length, 256, "lexical fallback vector");
  // Configured -> provider path with cache
  let fetchCalls = 0;
  const fake = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) }; };
  const prov = new AdaptiveEmbedder({
    configStore: { getConfig: () => ({ provider: { embeddingsModel: "text-embedding-3-small", baseUrl: "https://api.example.com/v1", apiKeyProviderId: "openai" } }) },
    secretStore: { getProviderKey: () => "sk-test" },
    fetchImpl: fake,
  });
  const p1 = await prov.embed("hello world");
  const p2 = await prov.embed("hello world");
  assert.equal(p1.length, 3, "provider embedding used");
  assert.equal(fetchCalls, 1, "second call served from cache");
  assert.deepEqual(p1, p2, "cache returns same vector");
  // Provider failure -> lexical fallback, health-tripped
  const bad = new AdaptiveEmbedder({
    configStore: { getConfig: () => ({ provider: { embeddingsModel: "x", baseUrl: "https://api.example.com/v1" } }) },
    secretStore: { getProviderKey: () => "" },
    fetchImpl: async () => { throw new Error("network down"); },
  });
  const f1 = await bad.embed("test text");
  assert.equal(f1.length, 256, "failure falls back to lexical");
  assert.equal(bad.providerHealthy, false, "health flag tripped");
  ok("AdaptiveEmbedder: provider + cache + fallback");
}

// ── 4. promote -> semantic index + backfill ─────────────────────────────────
{
  const store = new MemoryStore(tmp);
  const sem = new SemanticMemory({ rootDir: tmp, embedder: new SimpleTextEmbedder() });
  store.onPromote = (record) => sem.addText(record.id, `${record.title}\n${record.text}`, { layer: "longTerm" }).catch(() => {});
  const promoted = store.promoteMemory({ title: "Deploy flow", text: "deploy ke liye scripts/deploy-gateway.ps1 chalao", sourceType: "t", sourceId: "3" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sem.embeddings.has(promoted.memory.id), "promoted memory semantically indexed");
  const back = await sem.backfillFromItems([
    { id: "bf1", text: "user haryana se hai", layer: "longTerm" },
    { id: "bf2", text: "", layer: "longTerm" },
  ], { max: 10 });
  assert.equal(back.indexed, 1, "backfill indexes items with text");
  const found = await sem.searchText("deploy gateway script", 5, 0.1);
  assert.ok(found.some((f) => f.id === promoted.memory.id), "semantic search finds the promoted memory");
  ok("promote hook + backfill make semantic search real");
}

// ── 5. async memory brief with past exchanges ───────────────────────────────
{
  const store = new MemoryStore(tmp);
  store.appendConversation({ user: "portfolio website bana do dark theme me", assistant: "banaya - index.html with dark palette", intents: [] });
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = { rootDir: tmp, memory: store, semanticMemory: null, config: { getConfig: () => ({ provider: {} }) } };
  loop.playbooks = { buildSection: () => "" };
  const brief = await loop.buildMemoryBriefAsync({}, { message: "ek aur website banao portfolio dark theme wali", agent: { id: "main" } });
  assert.ok(brief.includes("Relevant Past Exchanges"), "past-exchanges section present");
  assert.ok(/portfolio website bana/.test(brief), "matching past conversation recalled");
  ok("async memory brief recalls relevant past exchanges");
}

// ── 6+7. build-verify checkpoint + rework churn (the GTA pattern) ──────────
{
  const runtime = {
    rootDir: null, // learning off
    config: { getConfig: () => ({ provider: {}, runtime: { omniLoop: { maxRounds: 14, providerRetries: 0, streaming: false, historyMessages: 0, autoVerifyEdits: false } } }) },
    gateway: { addEvent: () => {}, emitTransient: () => {}, listRuns: () => [] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true, model: "stub" }),
      completeWithTools: (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n <= 12) {
            // Endless architecture: write system file N (same file every 4th).
            const file = n % 4 === 0 ? "src/Game.ts" : `src/System${n}.ts`;
            return { text: "", toolCalls: [{ id: `w${n}`, tool: "write_file", input: { path: file, content: `// system ${n}` } }] };
          }
          return { text: "maine bahut systems likhe.", toolCalls: [] };
        };
      })(),
      complete: async () => ({ text: "" }),
    },
    tools: { run: async (tool, input) => ({ path: input.path, bytesWritten: 10 }) },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "3d game banao gta jaisa",
    agent: { id: "main" }, profile: {}, session: { id: "s9" }, run: { id: "r9" },
    tools: [{ id: "write_file", description: "w", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } }],
    contextBundle: {},
  });
  assert.ok((report.buildVerifyNudges || 0) >= 1, `build-verify checkpoint fired (got ${report.buildVerifyNudges})`);
  assert.ok(report.roundDetails.some((d) => d.status === "rework-churn-nudge" && d.path === "src/Game.ts"), "rework churn flagged for the re-rewritten file");
  ok("GTA pattern guards: build-verify checkpoint + rework churn");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nmemory-upgrade-smoke: ${passed} checks passed, 0 failed`);
