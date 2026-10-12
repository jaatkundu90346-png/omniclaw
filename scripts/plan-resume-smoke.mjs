// Budget-exhaustion resume contract (E2): a dying run with NO plan still
// leaves resumable state (synthesized session plan + durable run.resume
// transcript event); a FRESH run with EMPTY memory inherits from the
// transcript and resumes without redoing completed work. No network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) {
    failures++;
    console.log(`FAIL: ${label}`);
    return;
  }
  console.log(`ok: ${label}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-resume-"));

function makeTools() {
  const runPlans = new Map();
  const sessionPlans = new Map();
  return {
    runPlans,
    sessionPlans,
    getRunPlan: (id) => runPlans.get(String(id)) || null,
    setRunPlan: (id, plan) => { runPlans.set(String(id), plan); },
    getSessionPlan: (id) => sessionPlans.get(String(id)) || null,
    setSessionPlan: (id, plan) => { sessionPlans.set(String(id), plan); },
    getRunToolsets: () => [],
    getSessionToolsets: () => [],
    run: async (tool) => {
      if (tool === "read_file") return { path: "a.txt", content: "x".repeat(3000), bytesRead: 3000 };
      return { ok: true };
    },
  };
}

function makeSessions() {
  const log = [];
  return {
    log,
    getSession: () => ({ transcript: [...log] }),
    appendSystemEvent: (sid, event, payload) => {
      log.push({ type: "event", event, payload, sessionId: sid, at: new Date().toISOString() });
    },
  };
}

function baseLoopCfg() {
  return {
    enabled: true, maxRounds: 18, maxTokens: 500, roundTimeoutMs: 5000,
    maxToolResultChars: 4000, readResultChars: 8000, historyMessages: 0,
    contextCharBudget: 20000, maxTools: 8, maxToolCallsPerRound: 4,
    providerRetries: 0, streaming: false, runTokenBudget: 50000,
  };
}

const readTool = { id: "read_file", description: "Read a file", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } };

// Phase 1: burn rounds until the tiny run budget trips (no plan exists).
const tools1 = makeTools();
const sessions = makeSessions();
const events1 = [];
const runtime1 = {
  rootDir: tmpRoot,
  config: {
    getConfig: () => ({
      provider: { systemPrompt: "You are OmniClaw test agent." },
      runtime: { agentLoop: { maxSteps: 100, maxToolCallsPerStep: 5, maxRepeatedToolCalls: 10, outputPreviewChars: 2000 }, omniLoop: baseLoopCfg() },
    }),
  },
  gateway: {
    addEvent: (event, payload) => events1.push({ event, payload }),
    emitTransient: () => {},
  },
  sessions,
  provider: {
    getInfo: () => ({ id: "stub" }),
    completeWithTools: async () => ({
      text: "",
      toolCalls: [{ id: `r${Math.random().toString(36).slice(2, 7)}`, tool: "read_file", input: { path: "a.txt" } }],
      assistantMessage: { role: "assistant", content: null, tool_calls: [] },
    }),
    complete: async () => ({ text: "summary" }),
  },
  tools: tools1,
};

const loop1 = new OmniLoop({ agentRuntime: runtime1 });
const res1 = await loop1.run({
  message: "read a.txt repeatedly until budget trips",
  agent: { id: "main" }, profile: {}, session: { id: "s-resume" }, run: { id: "run1" },
  tools: [readTool], contextBundle: {},
});
assert(res1.report.stoppedReason === "budget-exhausted", `phase1: stopped on budget-exhausted (got ${res1.report.stoppedReason})`);
assert(res1.report.resumeSynthesized === true, "phase1: resume plan synthesized (run had no plan)");
assert(res1.report.resumeEventWritten === true, "phase1: durable run.resume transcript event written");
assert(events1.some((e) => e.event === "omni_loop.budget_exhausted"), "phase1: budget_exhausted event emitted");
const memPlan = tools1.getSessionPlan("s-resume");
assert(memPlan && memPlan.steps.length > 0, `phase1: session plan in memory (${memPlan?.steps?.length || 0} steps)`);
const resumeEv = sessions.log.find((e) => e.type === "event" && e.event === "run.resume");
assert(resumeEv && Array.isArray(resumeEv.payload.steps) && resumeEv.payload.steps.length > 0, "phase1: run.resume carries steps");
assert(fs.existsSync(path.join(tmpRoot, "PROGRESS.md")), "phase1: human handoff still written to PROGRESS.md");

// Phase 2: FRESH loop + EMPTY plan memory, same session transcript → inherit.
const tools2 = makeTools();
const events2 = [];
const runtime2 = {
  ...runtime1,
  gateway: {
    addEvent: (event, payload) => events2.push({ event, payload }),
    emitTransient: () => {},
  },
  provider: {
    getInfo: () => ({ id: "stub" }),
    completeWithTools: async () => ({ text: "Resumed and finished.", toolCalls: [] }),
    complete: async () => ({ text: "Resumed and finished." }),
  },
  tools: tools2,
};
const loop2 = new OmniLoop({ agentRuntime: runtime2 });
const res2 = await loop2.run({
  message: "continue",
  agent: { id: "main" }, profile: {}, session: { id: "s-resume" }, run: { id: "run2" },
  tools: [readTool], contextBundle: {},
});
assert((res2.report.planInherited || 0) > 0, `phase2: plan inherited from transcript resume (got ${res2.report.planInherited || 0})`);
assert(res2.report.planInheritSource === "transcript-resume", `phase2: source tagged transcript-resume (got ${res2.report.planInheritSource})`);
assert(Boolean(tools2.getRunPlan("run2")?.steps?.length), "phase2: inherited plan installed on the new run");
assert(events2.some((e) => e.event === "omni_loop.plan_inherited"), "phase2: plan_inherited event emitted");
assert(res2.report.finalReady && /Resumed/.test(res2.report.finalAnswer || ""), "phase2: run finished normally after inheriting");

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(failures ? `\nplan-resume: ${failures} FAILURES` : "\nplan-resume: ALL PASS");
process.exit(failures ? 1 : 0);
