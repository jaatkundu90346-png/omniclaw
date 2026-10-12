// Smoke test for the reasoning-only length-cut guard in OmniLoop.
//
// Bug it locks in: a reasoning/thinking model (DeepSeek-R1, QwQ, o-series,
// OpenRouter :thinking) can spend the whole output-token budget on
// reasoning_content and get cut MID-THOUGHT — finish_reason "length", a big
// reasoning block, but no answer text and no tool call. Before the guard, the
// loop accepted that truncated thinking as the "final answer"
// (model-final-from-reasoning) and HALTED, so the user had to type "continue"
// again and again (reasoning is output-only, so the model re-derived from
// scratch and hit the same cut). The guard bumps the output budget and nudges
// the model to emit output directly; after repeated cuts it stops honestly.
//
// Offline: stub provider + stub tools, no network.

import { OmniLoop } from "../src/core/omni-loop.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

const TIMEOUT_MS = 20000;
const timer = setTimeout(() => {
  console.error(`TIMEOUT: reasoning-length-cut-smoke did not finish in ${TIMEOUT_MS}ms`);
  process.exit(2);
}, TIMEOUT_MS);
timer.unref();

function makeRuntime({ providerScript, streaming = false }) {
  const events = [];
  const transients = [];
  const toolRuns = [];
  let callIndex = 0;
  const sentMaxTokens = [];
  return {
    events,
    transients,
    toolRuns,
    sentMaxTokens,
    config: {
      getConfig: () => ({
        provider: { systemPrompt: "You are OmniClaw test agent." },
        runtime: {
          agentLoop: { maxSteps: 100, maxToolCallsPerStep: 5, maxRepeatedToolCalls: 2, outputPreviewChars: 2000 },
          omniLoop: { enabled: true, maxRounds: 6, maxTokens: 1000, roundTimeoutMs: 5000, maxToolResultChars: 400, readResultChars: 4000, historyMessages: 4, contextCharBudget: 100000, maxTools: 16, providerRetries: 0, streaming },
        },
      }),
    },
    gateway: {
      addEvent: (event, payload) => events.push({ event, payload }),
      emitTransient: (event, payload) => transients.push({ event, payload }),
    },
    sessions: {
      getSession: () => ({ transcript: [{ type: "message", role: "user", text: "purana sawal" }] }),
    },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      completeWithTools: async (messages, input) => {
        sentMaxTokens.push(Number(input.maxTokens || 0));
        const step = providerScript[Math.min(callIndex, providerScript.length - 1)];
        callIndex += 1;
        return step({ messages, input });
      },
      complete: async () => ({ text: "summary: budget khatam." }),
    },
    tools: {
      run: async (id, toolInput) => {
        toolRuns.push({ id, toolInput });
        if (id === "read_file") return { path: toolInput.path, content: "x".repeat(500), bytesRead: 500 };
        return { ok: true };
      },
    },
  };
}

const baseTools = [
  { id: "read_file", description: "Read a file", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
];

// Scenario A: one reasoning-only length cut, then recovery (tool call, then a
// real final answer). The truncated thinking must NOT become the final answer.
console.log("scenario A: reasoning-only length cut recovers instead of halting");
{
  const runtime = makeRuntime({
    providerScript: [
      // Round 1: thinks forever, gets cut mid-thought. Nothing usable.
      () => ({
        text: "",
        reasoning: "Let me analyze the task step by step. ".repeat(80),
        toolCalls: [],
        finishReason: "length",
      }),
      // Round 2: with the bumped budget it emits a real tool call.
      ({ messages }) => {
        const nudge = messages[messages.length - 1];
        if (nudge.role !== "user" || !/cut at token limit mid-thinking/i.test(String(nudge.content || ""))) {
          throw new Error("reasoning-length-cut nudge message missing");
        }
        return {
          text: "",
          toolCalls: [{ id: "call_1", tool: "read_file", input: { path: "a.txt" } }],
          assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
        };
      },
      // Round 3: real final answer grounded in the observation.
      () => ({ text: "a.txt padh liya, 500 bytes ka content hai.", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "a.txt padho aur batao kya hai",
    agent: { id: "main" },
    profile: {},
    session: { id: "sA" },
    run: { id: "rA" },
    tools: baseTools,
    contextBundle: {},
  });
  ok(report.reasoningLengthCuts === 1, `scenarioA: reasoningLengthCuts=1 (got ${report.reasoningLengthCuts})`);
  ok(report.stoppedReason === "model-final-ready", `scenarioA: stopped on a REAL final answer, not truncated thinking (got ${report.stoppedReason})`);
  ok(!report.finalFromReasoning, "scenarioA: final answer is NOT the truncated reasoning");
  ok(report.finalReady && /a\.txt/.test(report.finalAnswer), "scenarioA: real final answer produced");
  ok(report.toolCallCount === 1, `scenarioA: tool call still executed after recovery (got ${report.toolCallCount})`);
  ok(runtime.sentMaxTokens[0] === 1000, `scenarioA: round 1 uses base budget (got ${runtime.sentMaxTokens[0]})`);
  ok(runtime.sentMaxTokens[1] === 2000, `scenarioA: round 2 budget doubled to 2000 (got ${runtime.sentMaxTokens[1]})`);
  ok(runtime.events.some((e) => e.event === "model_tool_loop.reasoning_length_cut"), "scenarioA: reasoning_length_cut event emitted");
}

// Scenario B: the model keeps getting cut mid-thinking even as the budget
// grows. The loop must stop HONESTLY instead of looping forever or handing the
// user a truncated thought.
console.log("scenario B: repeated reasoning cuts end in an honest stop");
{
  const cut = () => ({
    text: "",
    reasoning: "Thinking about it more. ".repeat(60),
    toolCalls: [],
    finishReason: "length",
  });
  const runtime = makeRuntime({
    providerScript: [cut, cut, cut, cut, cut, cut],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "ye task solve karo",
    agent: { id: "main" },
    profile: {},
    session: { id: "sB" },
    run: { id: "rB" },
    tools: baseTools,
    contextBundle: {},
  });
  ok(report.reasoningLengthCuts === 3, `scenarioB: escalated after 3 cuts (got ${report.reasoningLengthCuts})`);
  ok(report.stoppedReason === "reasoning-length-exhausted", `scenarioB: honest stop reason (got ${report.stoppedReason})`);
  ok(report.finalReady && /maxTokens/i.test(report.finalAnswer), "scenarioB: user gets an actionable message, not a truncated thought");
  ok(runtime.sentMaxTokens[0] === 1000 && runtime.sentMaxTokens[1] === 2000 && runtime.sentMaxTokens[2] === 4000,
    `scenarioB: budget grows 1000->2000->4000 (got ${runtime.sentMaxTokens.slice(0, 3).join(",")})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
clearTimeout(timer);
if (failed > 0) process.exit(1);
process.exit(0);
