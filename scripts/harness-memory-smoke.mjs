// Smoke test for the 2026-07-02 harness+memory batch:
// 1. head+tail tool-result truncation (errors at the end survive)
// 2. original-task pin in transcript compaction
// 3. relevance-ranked memory brief
// 4. structured session summary prompt (engine still returns/persists)
// 5. fact-bearing gate for auto memory capture
import assert from "node:assert";
import { OmniLoop } from "../src/core/omni-loop.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };

// ── 1. head+tail truncation ────────────────────────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  // truncateToolResult is module-private; exercise it via formatToolResultForModel
  const { formatToolResultForModel } = await import("../src/core/omni-loop.js");
  const bigOutput = `${"x".repeat(9000)}\nFAIL src/app.test.js\nError: expected 2 to equal 3\nTests: 1 failed`;
  const rendered = formatToolResultForModel(bigOutput, 2000);
  assert.ok(rendered.includes("expected 2 to equal 3"), "tail (the error) must survive truncation");
  assert.ok(rendered.includes("middle truncated"), "truncation marker present");
  assert.ok(rendered.length < 2600, "stays near the cap");
  ok("tool-result truncation keeps the tail (errors visible)");
  void loop;
}

// ── 2. original-task pin in compaction summary ─────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = {
    provider: { complete: async () => ({ text: "- did stuff\n- created files" }) },
    config: { getConfig: () => ({}) },
  };
  const filler = (role, i) => ({ role, content: `${role} message ${i} ${"pad".repeat(120)}` });
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "ORIGINAL TASK: build the dashboard" },
    ...Array.from({ length: 20 }, (_, i) => filler(i % 2 ? "assistant" : "user", i)),
  ];
  const res = await loop.summarizeOldTranscript(messages, { contextCharBudget: 500, roundTimeoutMs: 5000 }, "ORIGINAL TASK: build the dashboard");
  assert.equal(res.summarized, true, "summarization ran");
  const summaryMsg = messages[1];
  assert.ok(summaryMsg.content.includes("Original task"), "summary message pins the original task");
  assert.ok(summaryMsg.content.includes("build the dashboard"), "original ask text survives verbatim");
  ok("compaction pins the original task");
}

// ── 3. relevance-ranked memory brief ───────────────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  const longTerm = [
    { title: "Likes pizza", text: "User likes pizza on fridays", importance: "low" },
    { title: "Deploy target", text: "Project deploys to vercel with pnpm build", importance: "high" },
    ...Array.from({ length: 20 }, (_, i) => ({ title: `Filler ${i}`, text: `unrelated filler memory ${i}` })),
  ];
  loop.runtime = { memory: { getLongTermMemory: () => longTerm, getNotes: () => [] } };
  const brief = loop.buildMemoryBriefSection({ longTermMemory: [], notes: [] }, {
    message: "deploy the project to vercel using pnpm",
    agent: { id: "main" },
  });
  const deployPos = brief.indexOf("Deploy target");
  assert.ok(deployPos !== -1, "relevant memory included");
  const firstFiller = brief.indexOf("Filler");
  assert.ok(firstFiller === -1 || deployPos < firstFiller, "relevant memory ranked above filler");
  ok("memory brief is relevance-ranked");
}

// ── 4. structured session summary ──────────────────────────────────────────
{
  const { SummarizationEngine } = await import("../src/core/summarization-engine.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-sum-"));
  let capturedPrompt = "";
  let capturedOpts = null;
  const engine = new SummarizationEngine(tmp, {
    complete: async (msgs, opts) => {
      capturedPrompt = msgs[1].content;
      capturedOpts = opts;
      // Must clear the quality gate in summarizeSession (>= 40 chars + a
      // structured section label), otherwise the summary is rejected as garbage.
      return { text: "GOAL: test the summarizer\nDONE: made a.js and ran it\nNEXT: verify output" };
    },
  }, null, { getConfig: () => ({ provider: { compactionModel: "cheap/model" } }) });
  const entries = Array.from({ length: 6 }, (_, i) => ({ type: "message", role: i % 2 ? "assistant" : "user", text: `turn ${i}` }));
  const result = await engine.summarizeSession({ id: "s1" }, entries);
  assert.ok(/GOAL:/.test(capturedPrompt) && /DECISIONS:/.test(capturedPrompt), "structured prompt sections present");
  assert.equal(capturedOpts.model, "cheap/model", "compaction model forwarded");
  assert.ok(capturedOpts.maxTokens > 0, "bounded output tokens");
  assert.ok(result.text.includes("GOAL"), "summary persisted/returned");
  fs.rmSync(tmp, { recursive: true, force: true });
  ok("session summary is structured + uses compaction model");
}

// ── 5. auto-capture gate + dedupe ──────────────────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  assert.equal(loop.looksFactBearing("mera naam Mankush hai, yaad rakhna"), true, "Hinglish fact detected");
  assert.equal(loop.looksFactBearing("I prefer tabs over spaces from now on"), true, "English preference detected");
  assert.equal(loop.looksFactBearing("fix the bug in app.js line 20"), false, "task-only message NOT fact-bearing");

  const promoted = [];
  loop.runtime = {
    memory: {
      promoteMemory: (m) => { promoted.push(m); return { memory: m }; },
      getLongTermMemory: () => [{ title: "User prefers tabs", text: "User prefers tabs over spaces in code" }],
    },
    provider: { complete: async () => ({ text: '[{"title":"Prefers tabs","text":"User prefers tabs over spaces"},{"title":"Name","text":"User is called Mankush"}]' }) },
    config: { getConfig: () => ({}) },
  };
  const report = {};
  await loop.captureDurableFacts("remember: I prefer tabs over spaces and my name is Mankush", { id: "main" }, report);
  assert.equal(promoted.length, 1, "duplicate fact skipped, new fact promoted");
  assert.ok(/mankush/i.test(promoted[0].text), "the new fact is the name");
  assert.equal(report.memoryFactsCaptured, 1, "report counter set");
  ok("auto memory capture gates, dedupes, and promotes");
}

// ── 6. memory replace/forget (Hermes parity) + capacity header ─────────────
{
  const { MemoryStore } = await import("../src/core/memory-store.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-memedit-"));
  const store = new MemoryStore(tmp);
  store.promoteMemory({ agentId: "main", title: "Editor preference", text: "User prefers dark mode in all editors", sourceType: "manual", sourceId: "t1" });
  store.promoteMemory({ agentId: "main", title: "User location", text: "User works from Haryana, India", sourceType: "manual", sourceId: "t2" });

  // Ambiguous substring must be rejected with the matching titles named.
  const ambiguous = store.replaceMemory({ agentId: "main", match: "User", text: "whatever" });
  assert.equal(ambiguous.ok, false, "ambiguous match rejected");
  assert.ok(/matches 2 memories/.test(ambiguous.error), "error says how many matched");

  // Unique substring replaces in place — no duplicate correction memory.
  const replaced = store.replaceMemory({ agentId: "main", match: "dark mode", text: "User prefers light mode in VS Code, dark mode in terminal" });
  assert.equal(replaced.ok, true, "unique match replaced");
  const memories = store.getLongTermMemory(10, "main");
  assert.equal(memories.length, 2, "replace did not add a duplicate");
  assert.ok(memories.some((m) => m.text.includes("light mode in VS Code")), "text actually updated");
  const memFile = path.join(store.getLayeredMemoryPaths("main").dailyMemoryDir, "editor-preference.md");
  assert.ok(fs.readFileSync(memFile, "utf8").includes("light mode in VS Code"), "structured file rewritten");

  // Forget removes the record, its file, and its index line.
  const missing = store.removeMemory({ agentId: "main", match: "no such memory xyz" });
  assert.equal(missing.ok, false, "no-match remove rejected");
  const removed = store.removeMemory({ agentId: "main", match: "Haryana" });
  assert.equal(removed.ok, true, "unique match removed");
  assert.equal(store.getLongTermMemory(10, "main").length, 1, "record gone from long-term store");
  const removedFile = path.join(store.getLayeredMemoryPaths("main").dailyMemoryDir, "user-location.md");
  assert.equal(fs.existsSync(removedFile), false, "structured file deleted");
  assert.ok(!store.readMemoryIndex("main").includes("user-location"), "index line removed");

  // Capacity header shows up in the injected brief so the model knows fullness.
  const cap = store.getMemoryCapacityInfo("main");
  assert.ok(cap.memories === 1 && cap.indexChars > 0 && cap.percent >= 0, "capacity info computed");
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = { memory: store };
  const brief = loop.buildMemoryBriefSection({ longTermMemory: [], notes: [] }, { message: "editor setup", agent: { id: "main" } });
  assert.ok(/index \d+% full/.test(brief), "brief carries the capacity header");
  assert.ok(brief.includes("memory_forget"), "brief teaches the delete tool");
  fs.rmSync(tmp, { recursive: true, force: true });
  ok("memory replace/forget edits in place + capacity header injected");
}

console.log(`\nharness-memory-smoke: ${passed}/6 checks passed`);
