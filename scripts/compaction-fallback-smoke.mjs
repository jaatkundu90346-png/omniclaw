// Compaction-model 429 resilience: every cheap-model call site must resolve
// safely (log + skip) when the compaction model 429s — a free-tier quota
// failure must NEVER fail the user's main run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";
import { SummarizationEngine } from "../src/core/summarization-engine.js";

function assert(condition, message) {
  if (!condition) throw new Error("ASSERT: " + message);
  console.log("ok: " + message);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-fallback-"));
const err429 = new Error("Provider planner request failed with status 429: free-models-per-day exhausted");
err429.status = 429;
const throwingProvider = {
  complete: async () => { throw err429; },
  completeWithTools: async () => { throw err429; },
  getInfo: () => ({ id: "openai-compatible", model: "nex-agi/nex-n2.5-pro:free", ready: true }),
};
const events = [];
const runtime = {
  rootDir: tmpRoot,
  config: { getConfig: () => ({ provider: { compactionModel: "tencent/hy3:free" } }) },
  provider: throwingProvider,
  gateway: { addEvent: (event, payload) => events.push(event) },
  tools: { run: async () => { throw new Error("plan tool should not be reached on 429"); } },
  skills: { getAll: () => [] },
  memory: {
    promoteMemory: () => { throw new Error("memory write should not be reached on 429"); },
    getLongTermMemory: () => [],
  },
};
const loop = new OmniLoop({ agentRuntime: runtime });

// 1. transcript summarization degrades to truncation path input (no throw)
const messages = [{ role: "system", content: "sys" }];
for (let i = 0; i < 22; i += 1) messages.push({ role: "user", content: `old turn ${i} ` + "x".repeat(2000) });
for (let i = 0; i < 10; i += 1) messages.push({ role: "assistant", content: `recent ${i}` });
const sumRes = await loop.summarizeOldTranscript(messages, { contextCharBudget: 8000, roundTimeoutMs: 5000 }, "do the thing");
assert(sumRes && sumRes.summarized === false, "summarizeOldTranscript resolves {summarized:false} on 429");

// 2. plan seeding is skipped silently (one-attempt flag still set, run continues)
const report2 = {};
await loop.maybeSeedPlan({ message: "build a widget", run: { id: "r" }, session: { id: "s" }, agent: { id: "main" }, report: report2, settings: {}, toolOutputs: [] });
assert(report2.autoPlanSeeded === true && !report2.autoPlanSeedApplied, "maybeSeedPlan logs + skips on 429");

// 3. instinct learning logs + skips
await loop.learnFromRun(
  { finalReady: true, toolCallCount: 6, codeEdited: true, verificationRan: true, stoppedReason: "model-final-ready", failedObservationCount: 0 },
  [{ tool: "exec", input: { command: "npm run build" }, output: { exitCode: 0, stdout: "ok" } }],
);
assert(events.includes("learning.instinct_failed"), "instinct 429 emits learning.instinct_failed");

// 4. skill review returns acted:false
const skillRes = await loop.maybeRunSkillReview("build a widget", { finalReady: true, stoppedReason: "model-final-ready", codeEdited: true, verificationRan: true, toolCallCount: 40 }, [{ tool: "exec", input: { command: "npm run build" }, output: { exitCode: 0 } }]);
assert(skillRes && skillRes.acted === false && /error/i.test(skillRes?.reason || ""), "skill review 429 resolves acted:false with error reason (reason=" + skillRes?.reason + ")");

// 5. durable-fact capture logs + skips
await loop.captureDurableFacts("my name is Testuser, always use pnpm", { id: "main" }, {});
assert(events.includes("omni_loop.facts_capture_failed"), "fact capture 429 emits omni_loop.facts_capture_failed");

// 6. session summarizer keeps old summary + logs failure
const engine = new SummarizationEngine(tmpRoot, throwingProvider, { addEvent: (e) => events.push(e) }, runtime.config);
const entries = [];
for (let i = 0; i < 6; i += 1) entries.push({ type: "message", role: i % 2 ? "assistant" : "user", text: "turn text " + i });
const sessRes = await engine.summarizeSession({ id: "sess429" }, entries);
assert(sessRes === null, "summarizer returns existing(null) on 429");
assert(events.includes("session.summarization_failed"), "summarizer 429 emits session.summarization_failed");

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("\ncompaction-fallback: ALL PASS (main run never sees the 429)");
process.exit(0);
