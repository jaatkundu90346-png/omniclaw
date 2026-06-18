// Offline contract smoke for the OmniLoop transcript agent loop.
// Uses a stub provider + stub tool registry: no network, no real provider.
// Verifies: native tool-call transcript shape, tool execution wiring,
// per-result truncation, multi-round flow, final answer extraction,
// budget-exhausted summary, and unknown-tool rejection.

import { OmniLoop } from "../src/core/omni-loop.js";

function assert(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`ok: ${label}`);
  return true;
}

function makeRuntime({ providerScript }) {
  const events = [];
  const toolRuns = [];
  let callIndex = 0;
  return {
    events,
    toolRuns,
    config: {
      getConfig: () => ({
        provider: { systemPrompt: "You are OmniClaw test agent." },
        runtime: {
          agentLoop: { maxSteps: 100, maxToolCallsPerStep: 5, maxRepeatedToolCalls: 2, outputPreviewChars: 2000 },
          omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, maxToolResultChars: 400, historyMessages: 4, contextCharBudget: 100000, maxTools: 16, providerRetries: 0 },
        },
      }),
    },
    gateway: {
      addEvent: (event, payload) => events.push({ event, payload }),
    },
    sessions: {
      getSession: () => ({
        transcript: [
          { type: "message", role: "user", text: "purana sawal" },
          { type: "message", role: "assistant", text: "purana jawab" },
          { type: "message", role: "user", text: "current message (should be dropped from history)" },
        ],
      }),
    },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      completeWithTools: async (messages, input) => {
        const step = providerScript[Math.min(callIndex, providerScript.length - 1)];
        callIndex += 1;
        return step({ messages, input });
      },
      complete: async (messages) => ({ text: "summary: budget khatam, file likh di thi." }),
    },
    tools: {
      run: async (id, toolInput, context) => {
        toolRuns.push({ id, toolInput, context });
        if (id === "read_file") {
          return { path: toolInput.path, content: "x".repeat(2000), bytesRead: 2000 };
        }
        if (id === "write_file") {
          return { path: toolInput.path, bytesWritten: 42 };
        }
        return { ok: true };
      },
    },
  };
}

const baseTools = [
  { id: "read_file", description: "Read a file", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
  { id: "write_file", description: "Write a file", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
];

// Scenario 1: read -> write -> final answer.
{
  const runtime = makeRuntime({
    providerScript: [
      ({ messages, input }) => {
        if (!Array.isArray(input.tools) || input.tools.length < 2) throw new Error("tool schemas missing");
        if (messages[0].role !== "system") throw new Error("system prompt missing");
        return {
          text: "",
          toolCalls: [{ id: "call_1", tool: "read_file", input: { path: "a.txt" } }],
          assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
        };
      },
      ({ messages }) => {
        const toolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
        if (!toolMsg) throw new Error("tool result not in transcript");
        if (toolMsg.content.length > 600) throw new Error("tool result not truncated");
        return {
          text: "",
          toolCalls: [{ id: "call_2", tool: "write_file", input: { path: "b.txt", content: "hi" } }],
          assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "write_file", arguments: '{"path":"b.txt","content":"hi"}' } }] },
        };
      },
      () => ({ text: "Ho gaya bhai: a.txt padhi aur b.txt likh di (42 bytes).", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report, toolOutputs } = await loop.run({
    message: "a.txt padho aur b.txt likho",
    agent: { id: "main", name: "Main" },
    profile: { id: "power" },
    session: { id: "session_test" },
    run: { id: "run_test" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(report.loopEngine === "omni-loop", "scenario1: loopEngine tagged");
  assert(report.rounds === 3, `scenario1: 3 rounds (got ${report.rounds})`);
  assert(report.toolCallCount === 2, `scenario1: 2 tool calls (got ${report.toolCallCount})`);
  assert(report.finalReady && /b\.txt/.test(report.finalAnswer), "scenario1: final answer ready");
  assert(toolOutputs.length === 2 && toolOutputs[0].tool === "read_file", "scenario1: toolOutputs recorded");
  assert(runtime.toolRuns[0].context.source === "omni-loop", "scenario1: tool context source set");
  assert(runtime.events.some((e) => e.event === "model_tool_loop.tool_completed"), "scenario1: UI events emitted");
}

// Scenario 2: unknown tool gets rejected with an error tool message, then final.
{
  const runtime = makeRuntime({
    providerScript: [
      () => ({
        text: "",
        toolCalls: [{ id: "call_x", tool: "rm_rf_everything", input: {} }],
        assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_x", type: "function", function: { name: "rm_rf_everything", arguments: "{}" } }] },
      }),
      ({ messages }) => {
        const rejection = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_x");
        if (!rejection || !/not available/i.test(rejection.content)) throw new Error("rejection message missing");
        return { text: "Woh tool available nahi tha, kaam allowed tools se karna hoga.", toolCalls: [] };
      },
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "test",
    agent: { id: "main" },
    profile: {},
    session: { id: "s2" },
    run: { id: "r2" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(report.rejectedToolCalls.length === 1, "scenario2: unknown tool rejected");
  assert(report.finalReady, "scenario2: recovered to final answer");
}

// Scenario 3: budget exhausted -> honest summary via complete().
{
  const runtime = makeRuntime({
    providerScript: [
      () => ({
        text: "",
        toolCalls: [{ id: "c", tool: "read_file", input: { path: "loop.txt" } }],
        assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: '{"path":"loop.txt"}' } }] },
      }),
    ],
  });
  // maxRepeatedToolCalls=2 means round 3+ gets blocked outputs, loop runs to maxRounds=5.
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "stuck task",
    agent: { id: "main" },
    profile: {},
    session: { id: "s3" },
    run: { id: "r3" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(report.stoppedReason === "max_rounds", `scenario3: stopped on max_rounds (got ${report.stoppedReason})`);
  assert(report.finalReady && /summary/i.test(report.finalAnswer), "scenario3: budget-exhausted summary produced");
  assert(report.repeatedToolCallsSkipped > 0, "scenario3: repeat-call cap engaged");
}

console.log(process.exitCode ? "\nOMNI-LOOP SMOKE: FAILED" : "\nOMNI-LOOP SMOKE: PASSED");
