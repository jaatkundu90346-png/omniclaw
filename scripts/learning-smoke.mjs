// Smoke test for the 2026-07-02 continuous-learning system (task playbooks +
// curator): classifier, refinement, reinforcement, prompt injection, decay.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskPlaybooks, classifyTask } from "../src/core/task-playbooks.js";
import { MemoryStore } from "../src/core/memory-store.js";
import { OmniLoop } from "../src/core/omni-loop.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-learn-"));

// ── 1. deterministic task-type classifier (English + Hinglish) ─────────────
{
  assert.equal(classifyTask("ek react component banao vite ke saath"), "react-app");
  assert.equal(classifyTask("mera portfolio website bana do html css me"), "website-build");
  assert.equal(classifyTask("ye script error de rahi hai fix karo"), "debugging");
  assert.equal(classifyTask("research karo latest AI models pe aur compare karo"), "research");
  assert.equal(classifyTask("Downloads folder organize karo files move karke"), "file-ops");
  assert.equal(classifyTask("hello kaise ho"), "");
  assert.equal(classifyTask("kuch bhi", { htmlEdited: true }), "website-build", "tool-signal fallback");
  ok("classifier: english + hinglish + tool-signal fallback");
}

// ── 2. playbook refinement + reinforcement over runs ───────────────────────
{
  const pb = new TaskPlaybooks({ rootDir: tmp });
  const provider = {
    complete: async (messages) => {
      const user = messages[1].content;
      assert.ok(user.includes("Task type: website-build"), "type passed to refiner");
      return { text: "- Build a single self-contained index.html first\n- Verify with browser_open file:// URL and check consoleErrors\n- Pitfall: never reference local assets that don't exist" };
    },
  };
  const r1 = await pb.learnFromRun({ type: "website-build", message: "site banao", outcome: "SUCCESS (verified)", workSummary: "• Files created: index.html", provider });
  assert.ok(r1.learned && r1.isNew, "first run creates the playbook");
  // Reinforcement on later runs of the same type:
  pb.recordOutcome("website-build", { success: true });
  pb.recordOutcome("website-build", { success: false });
  const entry = pb.get("website-build");
  assert.equal(entry.uses, 2, "uses counted");
  assert.equal(entry.successes, 1, "success counted");
  assert.equal(entry.failures, 1, "failure counted");
  const r2 = await pb.learnFromRun({ type: "website-build", message: "aur ek site", outcome: "STUCK", workSummary: "• Failed/blocked: web_fetch x4", provider });
  assert.ok(r2.learned && !r2.isNew, "second run refines, not duplicates");
  assert.equal(pb.load().length, 1, "one entry per type");
  ok("playbook: create -> reinforce -> refine (no duplicates)");
}

// ── 3. prompt injection with usage record ───────────────────────────────────
{
  const pb = new TaskPlaybooks({ rootDir: tmp });
  const section = pb.buildSection("website-build");
  assert.ok(section.includes("Learned Playbook: website-build"), "section headed by type");
  assert.ok(section.includes("used 2x, 1 succeeded, 1 failed"), "usage record visible");
  assert.ok(section.includes("browser_open"), "playbook content present");
  assert.equal(pb.buildSection("react-app"), "", "no section for unlearned type");
  ok("playbook injects into prompt with track record");
}

// ── 4. OmniLoop system prompt carries the playbook ──────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = {
    rootDir: tmp,
    config: { getConfig: () => ({ provider: {}, app: {} }) },
    sessions: { listSessions: () => [] },
    gateway: { listRuns: () => [] },
    memory: null,
  };
  loop.playbooks = new TaskPlaybooks({ rootDir: tmp });
  const prompt = loop.buildSystemPrompt({
    agent: { id: "main", name: "Main" },
    profile: {},
    contextBundle: {},
    session: { id: "s" },
    run: { id: "r" },
    message: "ek aur website bana do portfolio wali",
  }).system; // buildSystemPrompt returns { system, zoneA, zoneB, ... } — the rendered text is .system
  assert.ok(prompt.includes("Learned Playbook: website-build"), "matched playbook in system prompt");
  ok("OmniLoop injects the learned playbook for matching tasks");
}

// ── 5. curator: stale pruning + instinct decay ──────────────────────────────
{
  const pb = new TaskPlaybooks({ rootDir: tmp });
  const list = pb.load();
  list.push({ type: "old-unused", playbook: "- stale", uses: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  pb.save(list);
  const result = pb.curate();
  assert.equal(result.removed, 1, "stale unused playbook pruned");
  assert.ok(pb.get("website-build"), "active playbook kept");

  // Instinct decay via the loop's curator
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = { rootDir: tmp, gateway: { addEvent: () => {} } };
  loop.playbooks = pb;
  fs.writeFileSync(path.join(tmp, "data", "instincts.json"), JSON.stringify([
    { text: "old weak lesson", confidence: 0.22, lastSeen: "2026-05-01T00:00:00Z" },
    { text: "fresh strong lesson", confidence: 0.9, lastSeen: new Date().toISOString() },
  ]));
  await loop.maybeRunCurator();
  const instincts = JSON.parse(fs.readFileSync(path.join(tmp, "data", "instincts.json"), "utf8"));
  assert.equal(instincts.length, 1, "decayed instinct below 0.2 dropped");
  assert.equal(instincts[0].text, "fresh strong lesson", "fresh instinct untouched");
  // Second call within 24h is a no-op (stamp written)
  await loop.maybeRunCurator();
  ok("curator prunes stale playbooks + decays old instincts (daily, idempotent)");
}

// ── 6. garbage refinement rejected (quality gate) ───────────────────────────
{
  const pb = new TaskPlaybooks({ rootDir: tmp });
  const before = pb.get("website-build").playbook;
  const r = await pb.learnFromRun({
    type: "website-build",
    message: "x",
    outcome: "SUCCESS",
    workSummary: "• Files created: a.html",
    provider: { complete: async () => ({ text: "summary: budget khatam, file likh di thi." }) },
  });
  assert.equal(r.learned, false, "prose/garbage refinement rejected");
  assert.equal(r.reason, "not-bullet-format", "rejected for format");
  assert.equal(pb.get("website-build").playbook, before, "existing playbook untouched");
  ok("garbage refinement can't overwrite learned knowledge");
}

// ── 7. self-knowledge in the system prompt ──────────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = {
    rootDir: tmp,
    config: { getConfig: () => ({ provider: {}, app: {} }) },
    sessions: { listSessions: () => [] },
    gateway: { listRuns: () => [] },
    memory: null,
  };
  loop.playbooks = new TaskPlaybooks({ rootDir: tmp });
  const prompt = loop.buildSystemPrompt({
    agent: { id: "main", name: "Main" }, profile: {}, contextBundle: {}, session: { id: "s" }, run: { id: "r" },
    message: "tumhare paas kya learning system hai?",
  }).system; // object return, rendered text is .system
  // NOTE 2026-09-26: the old "PLAYBOOKS" / "do NOT re-implement" assertions
  // referenced prompt text that no longer exists anywhere in src (stale test,
  // not a missing feature). They are replaced by what the prompt actually
  // guarantees now: the self-knowledge section and the context map.
  assert.ok(prompt.includes("Your Harness (self-knowledge"), "self-knowledge section present");
  assert.ok(prompt.includes("## Context Map"), "context map present (organization layer)");
  ok("agent knows its own harness (self-knowledge section)");
}

// ── 8. stub runtimes never write learning into real data/ ──────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = { provider: {}, config: { getConfig: () => ({}) } }; // no rootDir = test/stub
  loop.playbooks = new TaskPlaybooks({ rootDir: tmp });
  await loop.learnPlaybook("website banao", { finalReady: true, stoppedReason: "model-final-ready", toolCallCount: 9, codeEdited: true }, []);
  // If the guard failed this would have called provider.complete (undefined fn -> throw swallowed) or written entries.
  const entry = loop.playbooks.get("website-build");
  assert.equal(entry.runsLearnedFrom, 2, "no phantom learning from rootDir-less runtime");
  ok("rootDir guard: test/stub runtimes can't pollute the playbook store");
}

// ── 9. post-run memory dream sweep trigger ─────────────────────────────────
{
  const dreamTmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-dream-"));
  const memory = new MemoryStore(dreamTmp);
  memory.addNote("Always verify browser pages with consoleErrors before final answer", { agentId: "main" });
  memory.appendConversation({
    agentId: "main",
    user: "research karo latest AI tools compare karo",
    assistant: "Collected sources and compared the models.",
    intents: ["research"],
    runId: "r-dream-1",
    at: new Date().toISOString(),
  });
  const events = [];
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = {
    rootDir: dreamTmp,
    memory,
    provider: { complete: async () => ({ text: "[]" }) },
    config: { getConfig: () => ({ provider: {} }) },
    gateway: { addEvent: (type, payload) => events.push({ type, payload }) },
  };
  const report = { finalReady: true, stoppedReason: "model-final-ready", toolCallCount: 4, codeEdited: false, verificationRan: false, failedObservationCount: 0 };
  const result = await loop.maybeRunMemoryDreamSweep({ agent: { id: "main" }, report });
  assert.ok(result?.dream, "post-run dream sweep returns a dream record");
  assert.equal(result.promoted.length, 2, "high-value candidates promoted after a meaningful run");
  assert.equal(report.memoryDreamPromoted, 2, "report records promoted count");
  assert.ok(memory.getLongTermMemory(10, "main").every((m) => m.tags.includes("dream")), "promotions are tagged as dream-consolidated");
  assert.ok(events.some((e) => e.type === "learning.dream_sweep" && e.payload.promotedCount === 2), "gateway event emitted");
  const dreamCount = memory.getDreams(10, "main").length;
  const second = await loop.maybeRunMemoryDreamSweep({ agent: { id: "main" }, report });
  assert.equal(second.reason, "dream-sweep-not-due", "dream sweep is throttled after first post-run sweep");
  assert.equal(memory.getDreams(10, "main").length, dreamCount, "throttled call does not append duplicate dreams");
  fs.rmSync(dreamTmp, { recursive: true, force: true });
  ok("post-run dream sweep promotes candidates once and throttles duplicates");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nlearning-smoke: ${passed} checks passed, 0 failed`);
