// Offline contract smoke for the OmniLoop transcript agent loop.
// Uses a stub provider + stub tool registry: no network, no real provider.
// Verifies: native tool-call transcript shape, tool execution wiring,
// per-result truncation, multi-round flow, final answer extraction,
// budget-exhausted summary, and unknown-tool rejection.

import { OmniLoop } from "../src/core/omni-loop.js";
import { OpenAICompatibleProvider } from "../src/core/providers/openai-compatible-provider.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`ok: ${label}`);
  return true;
}

function makeRuntime({ providerScript, streaming = true }) {
  const events = [];
  const transients = [];
  const toolRuns = [];
  let callIndex = 0;
  return {
    events,
    transients,
    toolRuns,
    config: {
      getConfig: () => ({
        provider: { systemPrompt: "You are OmniClaw test agent." },
        runtime: {
          agentLoop: { maxSteps: 100, maxToolCallsPerStep: 5, maxRepeatedToolCalls: 2, outputPreviewChars: 2000 },
          omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, maxToolResultChars: 400, readResultChars: 4000, historyMessages: 4, contextCharBudget: 100000, maxTools: 16, providerRetries: 0, streaming },
        },
      }),
    },
    gateway: {
      addEvent: (event, payload) => events.push({ event, payload }),
      emitTransient: (event, payload) => transients.push({ event, payload }),
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
        // Reads render as plain text with their own (bigger) readResultChars
        // budget; the 2000-char stub content must fit under it but stay bounded.
        if (toolMsg.content.length > 4400) throw new Error("tool result not bounded");
        if (!toolMsg.content.includes("✅ read OK")) throw new Error("read result not plain-rendered");
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

// Scenario 1a: Hermes-style tool-use enforcement. If the model tries to answer
// an actionable file/tool task without using any tool, OmniLoop should nudge it
// once instead of accepting a fake final answer.
{
  const runtime = makeRuntime({
    providerScript: [
      () => ({ text: "Ho gaya, maine file padh li.", toolCalls: [] }),
      ({ messages }) => {
        const nudge = messages[messages.length - 1];
        if (nudge.role !== "user" || !/call a tool|use tools|read_file/i.test(nudge.content || "")) {
          throw new Error("tool-use nudge missing");
        }
        return {
          text: "",
          toolCalls: [{ id: "nudge_read", tool: "read_file", input: { path: "a.txt" } }],
          assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "nudge_read", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
        };
      },
      () => ({ text: "Ab sach me a.txt padh li.", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "a.txt read karo aur batao kya hai",
    agent: { id: "main" },
    profile: {},
    session: { id: "s1a" },
    run: { id: "r1a" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(report.actionNudges === 1, `scenario1a: action/tool nudge fired once (got ${report.actionNudges})`);
  assert(report.toolCallCount === 1 && runtime.toolRuns[0]?.id === "read_file", "scenario1a: model used read_file after nudge");
  assert(report.finalReady && /sach me/i.test(report.finalAnswer), "scenario1a: final answer comes after real tool observation");
}

// Scenario 1b: mixed rounds should parallelize consecutive read-only calls even
// when the same round also contains a later side-effecting tool. Claude/Codex
// style tool loops should not serialize independent reads just because a write
// appears later in the round, but writes must still wait for earlier reads.
{
  let activeSafeReads = 0;
  let safeReadPeak = 0;
  let writeOverlappedSafeRead = false;
  const runtime = makeRuntime({
    providerScript: [
      () => ({
        text: "",
        toolCalls: [
          { id: "mix_r", tool: "read_file", input: { path: "a.txt" } },
          { id: "mix_l", tool: "list_files", input: { path: "." } },
          { id: "mix_w", tool: "write_file", input: { path: "b.txt", content: "done" } },
        ],
        assistantMessage: { role: "assistant", content: null, tool_calls: [] },
      }),
      () => ({ text: "Mixed batch complete.", toolCalls: [] }),
    ],
  });
  runtime.tools.run = async (id, toolInput, context) => {
    runtime.toolRuns.push({ id, toolInput, context });
    if (id === "read_file" || id === "list_files") {
      activeSafeReads += 1;
      safeReadPeak = Math.max(safeReadPeak, activeSafeReads);
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeSafeReads -= 1;
      return id === "read_file"
        ? { path: toolInput.path, content: "read ok", bytesRead: 7 }
        : { path: toolInput.path, entries: ["a.txt"] };
    }
    if (id === "write_file") {
      if (activeSafeReads > 0) writeOverlappedSafeRead = true;
      return { path: toolInput.path, bytesWritten: 4 };
    }
    return { ok: true };
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const tools = [
    ...baseTools,
    { id: "list_files", description: "List files", schema: { type: "object", properties: { path: { type: "string" } } } },
  ];
  const { report } = await loop.run({
    message: "read a, list files, then write b",
    agent: { id: "main" },
    profile: {},
    session: { id: "s1b" },
    run: { id: "r1b" },
    tools,
    contextBundle: {},
  });
  assert(safeReadPeak >= 2, `scenario1b: safe read-only prefix ran in parallel (peak ${safeReadPeak})`);
  assert(!writeOverlappedSafeRead, "scenario1b: write waited for earlier read-only batch");
  assert(report.parallelToolBatches >= 1, "scenario1b: report records partial parallel batch");
  assert(report.finalReady && report.toolCallCount === 3, "scenario1b: mixed round completed");
}

// Scenario 1c: weak-model malformed args are repaired against tool schema before
// execution. The model got the tool name right but used `filepath` instead of
// required `path`; the harness owns that contract, not the model.
{
  const runtime = makeRuntime({
    providerScript: [
      () => ({
        text: "",
        toolCalls: [{ id: "bad_args_read", tool: "read_file", input: { filepath: "a.txt" } }],
        assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "bad_args_read", type: "function", function: { name: "read_file", arguments: '{"filepath":"a.txt"}' } }] },
      }),
      () => ({ text: "Read complete after harness repaired args.", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "a.txt padho",
    agent: { id: "main" },
    profile: {},
    session: { id: "s1c" },
    run: { id: "r1c" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(runtime.toolRuns[0]?.toolInput?.path === "a.txt", "scenario1c: filepath alias repaired into path before tool run");
  assert(!("filepath" in (runtime.toolRuns[0]?.toolInput || {})), "scenario1c: bad alias removed from executed args");
  assert(report.toolArgRepairs === 1, `scenario1c: repair counted (got ${report.toolArgRepairs})`);
  assert(runtime.events.some((e) => e.event === "model_tool_loop.tool_args_repaired"), "scenario1c: repair event emitted");
}

// Scenario 1d: harness hooks/permissions are deterministic and outside the
// model. A pre-tool hook can modify safe args and block unsafe tool calls before
// runtime.tools.run is reached; post-tool hook still observes the final output.
{
  const runtime = makeRuntime({
    providerScript: [
      () => ({
        text: "",
        toolCalls: [
          { id: "hook_read", tool: "read_file", input: { path: "./a.txt" } },
          { id: "hook_write", tool: "write_file", input: { path: "danger.txt", content: "nope" } },
        ],
        assistantMessage: { role: "assistant", content: null, tool_calls: [] },
      }),
      ({ messages }) => {
        const blockedMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "hook_write");
        if (!blockedMsg || !/permission denied/i.test(blockedMsg.content || "")) throw new Error("blocked hook output missing");
        return { text: "Read ran, write was blocked by harness policy.", toolCalls: [] };
      },
    ],
  });
  const hookCalls = [];
  runtime.runHook = async (name, payload) => {
    hookCalls.push({ name, payload });
    if (name === "before_tool_call" && payload.tool === "read_file") {
      return [{ pluginId: "policy", result: { input: { path: "a.txt" } } }];
    }
    if (name === "before_tool_call" && payload.tool === "write_file") {
      return [{ pluginId: "policy", result: { blocked: true, reason: "permission denied: writes disabled" } }];
    }
    return [];
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "read then write",
    agent: { id: "main" },
    profile: {},
    session: { id: "s1d" },
    run: { id: "r1d" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(runtime.toolRuns.length === 1 && runtime.toolRuns[0].id === "read_file", "scenario1d: blocked write never reached tool runtime");
  assert(runtime.toolRuns[0]?.toolInput?.path === "a.txt", "scenario1d: before hook can normalize tool args");
  assert(hookCalls.filter((h) => h.name === "before_tool_call").length === 2, "scenario1d: before_tool_call hook fired for every attempted tool");
  assert(hookCalls.some((h) => h.name === "after_tool_call" && h.payload.tool === "write_file" && h.payload.output?.blocked), "scenario1d: after_tool_call hook observed blocked output");
  assert(report.hookToolBlocks === 1, `scenario1d: hook block counted (got ${report.hookToolBlocks})`);
  assert(runtime.events.some((e) => e.event === "model_tool_loop.tool_blocked_by_hook"), "scenario1d: hook block event emitted");
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

// Scenario 4: model reasoning is captured, streamed to the UI, and recorded.
// streaming:false forces the loop's one-shot reasoning emit path.
{
  const runtime = makeRuntime({
    streaming: false,
    providerScript: [
      () => ({
        text: "",
        reasoning: "Pehle a.txt padhni chahiye taaki samajh aaye usme kya hai, fir aage badhunga.",
        toolCalls: [{ id: "call_r1", tool: "read_file", input: { path: "a.txt" } }],
        assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_r1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      }),
      () => ({ text: "Padh li a.txt, sab clear hai.", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "a.txt padho",
    agent: { id: "main" },
    profile: {},
    session: { id: "s4" },
    run: { id: "r4" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(report.reasoningRounds === 1, `scenario4: reasoning round counted (got ${report.reasoningRounds})`);
  assert(report.reasoningChars > 0, "scenario4: reasoning chars recorded");
  assert(runtime.transients.some((t) => t.event === "assistant.reasoning" && /a\.txt padhni/.test(t.payload.text)), "scenario4: reasoning streamed to UI");
  assert(runtime.events.some((e) => e.event === "model_tool_loop.reasoning"), "scenario4: reasoning gateway event emitted");
}

// Scenario 5: model returns thinking but an empty answer -> fall back to the
// reasoning instead of handing the user silence.
{
  const runtime = makeRuntime({
    providerScript: [
      () => ({ text: "", reasoning: "Jawab yahi hai: kaam ho gaya, koi aur step nahi chahiye.", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "kuch socho",
    agent: { id: "main" },
    profile: {},
    session: { id: "s5" },
    run: { id: "r5" },
    tools: baseTools,
    contextBundle: {},
  });
  assert(report.finalFromReasoning === true, "scenario5: empty answer fell back to reasoning");
  assert(/kaam ho gaya/.test(report.finalAnswer), "scenario5: reasoning became the final answer");
  assert(report.stoppedReason === "model-final-from-reasoning", `scenario5: stop reason tagged (got ${report.stoppedReason})`);
}

// Provider-level: reasoning capture from the OpenAI-compatible wire format.
{
  const realFetch = global.fetch;
  const makeConfigStore = (providerOverrides = {}) => ({
    getConfig: () => ({
      provider: { baseUrl: "https://api.example.com/v1", model: "test-model", apiKeyEnv: "OMNI_TEST_KEY", apiKeyProviderId: "test", timeoutMs: 5000, ...providerOverrides },
    }),
  });
  const secretStore = { getProviderKey: () => "sk-test", getProviderKeyStatus: () => ({ configured: true, masked: "sk-***" }) };
  const toolSchema = [{ type: "function", function: { name: "noop", parameters: { type: "object", properties: {} } } }];

  // Scenario 6: non-streaming reasoning_content captured + opt-in request passthrough.
  let captured = null;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "the answer", reasoning_content: "the thinking" } }], model: "test-model", usage: null }) };
  };
  const provider = new OpenAICompatibleProvider(makeConfigStore({ reasoning: { effort: "medium" } }), secretStore);
  const res6 = await provider.completeWithTools([{ role: "user", content: "hi" }], { tools: toolSchema, stream: false });
  assert(res6.reasoning === "the thinking", "scenario6: non-streaming reasoning captured");
  assert(res6.text === "the answer", "scenario6: non-streaming content captured");
  assert(captured && captured.reasoning && captured.reasoning.effort === "medium", "scenario6: object reasoning passed in request body");

  const providerStr = new OpenAICompatibleProvider(makeConfigStore({ reasoning: "high" }), secretStore);
  await providerStr.completeWithTools([{ role: "user", content: "hi" }], { tools: toolSchema, stream: false });
  assert(captured && captured.reasoning_effort === "high", "scenario6: string reasoning -> reasoning_effort");

  const providerNone = new OpenAICompatibleProvider(makeConfigStore({ reasoning: null }), secretStore);
  await providerNone.completeWithTools([{ role: "user", content: "hi" }], { tools: toolSchema, stream: false });
  assert(captured && !("reasoning" in captured) && !("reasoning_effort" in captured), "scenario6: no reasoning fields when explicitly off");

  // With NOTHING configured the shipped default must still ask for effort —
  // that is the whole point of the default. This case used to assert "no
  // reasoning fields"; it is the behaviour that was silently costing quality.
  const providerDefault = new OpenAICompatibleProvider(makeConfigStore(), secretStore);
  await providerDefault.completeWithTools([{ role: "user", content: "hi" }], { tools: toolSchema, stream: false });
  assert(captured && captured.reasoning_effort === "high",
    `scenario6: unconfigured provider still asks for high effort (got ${JSON.stringify(captured?.reasoning_effort)})`);

  // The "/no-think" sentinel must beat the shipped default.
  await providerDefault.completeWithTools([{ role: "user", content: "hi" }], { tools: toolSchema, stream: false, reasoning: false });
  assert(captured && !("reasoning_effort" in captured) && !("reasoning" in captured),
    "scenario6: input.reasoning=false beats the shipped default");

  // Scenario 7: streaming reasoning deltas accumulated + forwarded on their channel.
  const sse = [
    'data: {"choices":[{"delta":{"reasoning":"think A"}}]}',
    'data: {"choices":[{"delta":{"reasoning":"think B"}}]}',
    'data: {"choices":[{"delta":{"content":"hello "}}]}',
    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  global.fetch = async () => {
    const bytes = new TextEncoder().encode(sse);
    let sent = false;
    return {
      ok: true,
      body: { getReader: () => ({ read: async () => (sent ? { value: undefined, done: true } : ((sent = true), { value: bytes, done: false })) }) },
    };
  };
  const reasoningChunks = [];
  const contentChunks = [];
  const res7 = await providerNone.completeWithTools([{ role: "user", content: "hi" }], {
    tools: toolSchema,
    stream: true,
    onDelta: (c) => contentChunks.push(c),
    onReasoning: (c) => reasoningChunks.push(c),
  });
  assert(res7.reasoning === "think Athink B", `scenario7: streaming reasoning accumulated (got ${JSON.stringify(res7.reasoning)})`);
  assert(res7.text === "hello world", "scenario7: streaming content accumulated");
  assert(reasoningChunks.join("") === "think Athink B", "scenario7: onReasoning channel forwarded chunks");
  assert(contentChunks.join("") === "hello world", "scenario7: onDelta channel forwarded chunks");

  global.fetch = realFetch;
}

// Scenario 8: anti-spin — model gathers (web_search) for 4 rounds without
// building, so the loop nudges it ONCE to decide and finish.
{
  const tools = [...baseTools, { id: "web_search", description: "Search the web", schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } }];
  const search = (q) => ({
    text: "",
    toolCalls: [{ id: "s_" + q, tool: "web_search", input: { query: q } }],
    assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "s_" + q, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: q }) } }] },
  });
  const runtime = makeRuntime({
    providerScript: [
      () => search("q1"), () => search("q2"), () => search("q3"), () => search("q4"),
      ({ messages }) => {
        const nudged = messages.some((m) => m.role === "user" && /Progress check/.test(String(m.content || "")));
        if (!nudged) throw new Error("anti-spin nudge not injected before round 5");
        return { text: "Theek hai, jo mila usi se bana deta hoon.", toolCalls: [] };
      },
    ],
  });
  runtime.tools.run = async (id, input) => (id === "web_search" ? { results: [] } : { ok: true });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "ek 3d watch website banao", agent: { id: "main" }, profile: {},
    session: { id: "s8" }, run: { id: "r8" }, tools, contextBundle: {},
  });
  assert(report.spinNudges === 1, `scenario8: spin nudge fired once (got ${report.spinNudges})`);
  assert(runtime.events.some((e) => e.event === "model_tool_loop.spin_nudge"), "scenario8: spin_nudge event emitted");
  assert(report.finalReady, "scenario8: recovered to a final answer after nudge");
}

// Scenario 9: summarizeWorkDone reports REAL work (files + failures), so a
// cancelled/budget-exhausted run never says "kuch nahi hua".
{
  const loop = new OmniLoop({ agentRuntime: makeRuntime({ providerScript: [] }) });
  const summary = loop.summarizeWorkDone([
    { tool: "write_file", input: { path: "watchstore/index.html" }, output: { path: "watchstore/index.html" } },
    { tool: "write_file", input: { path: "watchstore/style.css" }, output: { path: "watchstore/style.css" } },
    { tool: "web_search", input: { query: "free 3d watch model" }, output: { results: [] } },
    { tool: "web_fetch", input: { url: "https://x/watch.gltf" }, output: { error: true, message: "404" } },
  ]);
  assert(/watchstore\/index\.html/.test(summary) && /watchstore\/style\.css/.test(summary), "scenario9: work summary lists created files");
  assert(/Searched/.test(summary) && /Failed/.test(summary) && /watch\.gltf/.test(summary), "scenario9: work summary lists searches + failures");
  assert(loop.summarizeWorkDone([]) === "", "scenario9: empty work summary when nothing ran");
}

// Scenario 10: provider 429 (free-tier daily cap) on round 1 with no tools ->
// clear actionable message + provider-rate-limited stop, NOT the generic
// "Provider brain failed... fix the provider in Brain setup".
{
  const runtime = makeRuntime({
    providerScript: [
      () => { throw new Error('Provider native tool request failed with status 429: {"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits"}}'); },
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "build a big website", agent: { id: "main" }, profile: {},
    session: { id: "s10" }, run: { id: "r10" }, tools: baseTools, contextBundle: {},
  });
  assert(report.stoppedReason === "provider-rate-limited", `scenario10: rate-limit stop reason (got ${report.stoppedReason})`);
  assert(report.finalReady && /quota|rate limit|429/i.test(report.finalAnswer), "scenario10: clear rate-limit message produced");
  assert(/continue|nvidia|paid|provider/i.test(report.finalAnswer), "scenario10: message is actionable (continue/switch model)");
  assert(!/Provider brain failed/i.test(report.finalAnswer), "scenario10: no generic provider-brain-failed garbage");
}

// Scenario 10b: context-overflow on round 1 -> the loop compacts and re-runs
// the SAME round (Hermes "compress, not failover") instead of dying. Second
// attempt succeeds.
{
  const overflow = () => { throw new Error("Provider request failed with status 400: This model's maximum context length is 8192 tokens. Please reduce the length of the messages."); };
  const runtime = makeRuntime({
    providerScript: [
      overflow,
      () => ({ text: "Recovered after compaction — here is the answer.", toolCalls: [] }),
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "long task", agent: { id: "main" }, profile: {},
    session: { id: "s10b" }, run: { id: "r10b" }, tools: baseTools, contextBundle: {},
  });
  assert((report.contextOverflowRecoveries || 0) === 1, `scenario10b: one context-overflow recovery (got ${report.contextOverflowRecoveries || 0})`);
  assert(report.finalReady && /Recovered after compaction/.test(report.finalAnswer || ""), "scenario10b: succeeded on retry after compaction");
  assert(report.stoppedReason !== "provider-context-overflow", "scenario10b: did NOT die on the overflow it recovered from");
  assert(runtime.events.some((e) => e.event === "omni_loop.context_overflow_recovered"), "scenario10b: recovery event emitted");
}

// Scenario 10c: persistent context-overflow -> bounded recovery (max 2), then a
// graceful, actionable context-overflow message instead of an infinite loop.
{
  const runtime = makeRuntime({
    providerScript: [
      () => { throw new Error("400 context_length_exceeded: the input is too long for this model's context window"); },
    ],
  });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "long task", agent: { id: "main" }, profile: {},
    session: { id: "s10c" }, run: { id: "r10c" }, tools: baseTools, contextBundle: {},
  });
  assert((report.contextOverflowRecoveries || 0) === 2, `scenario10c: recovery is bounded at 2 (got ${report.contextOverflowRecoveries || 0})`);
  assert(report.stoppedReason === "provider-context-overflow", `scenario10c: ends with context-overflow stop (got ${report.stoppedReason})`);
  assert(report.finalReady && /context|compact|continue/i.test(report.finalAnswer || ""), "scenario10c: actionable context-overflow message");
}

// Scenario 18: steering — a user message that arrives mid-run is injected at the
// next round boundary (after the current tool calls finish), without
// interrupting the run. Simulates the steer arriving during round 1.
{
  let sawSteer = false;
  let drainCalls = 0;
  const runtime = makeRuntime({
    providerScript: [
      // round 1: call a tool so the loop continues to round 2
      () => ({ text: "", toolCalls: [{ id: "t1", tool: "read_file", input: { path: "a.txt" } }] }),
      // round 2: the steer must now be present in the transcript
      ({ messages }) => {
        sawSteer = messages.some((m) => m.role === "user" && /add a footer/i.test(String(m.content || "")));
        return { text: "Done — added the footer too.", toolCalls: [] };
      },
    ],
  });
  // Steer "arrives" during round 1 -> returned on the 2nd drain (round 2 top).
  runtime.drainSteer = () => { drainCalls += 1; return drainCalls === 2 ? "Also, add a footer." : ""; };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "build the page", agent: { id: "main" }, profile: {},
    session: { id: "s18" }, run: { id: "r18" }, tools: baseTools, contextBundle: {},
  });
  assert(sawSteer, "scenario18: steer message injected into transcript before the next model call");
  assert((report.steers || 0) === 1, `scenario18: one steer recorded (got ${report.steers || 0})`);
  assert(runtime.events.some((e) => e.event === "omni_loop.steered"), "scenario18: steer event emitted");
  assert(report.finalReady && /footer/i.test(report.finalAnswer || ""), "scenario18: run finished normally after steering (not interrupted)");
}

// Scenario 11: harness failure notices ("Provider brain failed", stale 429)
// are DROPPED from reloaded history so a weak model can't parrot them back as
// its own reply after the user switched providers.
{
  const runtime = makeRuntime({ providerScript: [] });
  runtime.sessions.getSession = () => ({ transcript: [
    { type: "message", role: "user", text: "build a watch site" },
    { type: "message", role: "assistant", text: "Provider brain failed, so OmniClaw did not generate a fake local answer. Detail: status 429 Rate limit exceeded: free-models-per-day" },
    { type: "message", role: "user", text: "continue" },
    { type: "message", role: "assistant", text: "Created watchstore/index.html and style.css." },
    { type: "message", role: "user", text: "continue" },
  ] });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const hist = loop.loadHistoryMessages({ id: "s11" }, 24);
  const blob = hist.map((m) => `${m.role}:${m.content}`).join(" | ");
  assert(!/Provider brain failed|free-models-per-day/i.test(blob), "scenario11: stale failure notice dropped from history");
  assert(/Created watchstore\/index\.html/.test(blob), "scenario11: real assistant work kept in history");
}

// Scenario 12: cross-session memory — a fresh session's prompt includes a brief
// of recent PRIOR sessions (what was asked + done), excluding the current/empty.
{
  const runtime = makeRuntime({ providerScript: [] });
  runtime.sessions.listSessions = () => ([
    { id: "s_old1", agentId: "main", messageCount: 4, updatedAt: "2026-06-19T10:00:00Z", lastUserMessagePreview: "build a 3d watch website", lastAssistantPreview: "Created watchstore/index.html + style.css" },
    { id: "s_cur", agentId: "main", messageCount: 2, updatedAt: "2026-06-20T10:00:00Z", lastUserMessagePreview: "CURRENTSESSIONMARKER", lastAssistantPreview: "x" },
    { id: "s_empty", agentId: "main", messageCount: 0, updatedAt: "2026-06-18T10:00:00Z", lastUserMessagePreview: "", lastAssistantPreview: "" },
  ]);
  const loop = new OmniLoop({ agentRuntime: runtime });
  const section = loop.buildRecentSessionsSection({ session: { id: "s_cur" }, agent: { id: "main" } });
  assert(/Recent Sessions/.test(section) && /build a 3d watch website/.test(section), "scenario12: recent prior sessions in cross-session memory");
  assert(/Created watchstore\/index\.html/.test(section), "scenario12: prior session's actual work included");
  assert(!/CURRENTSESSIONMARKER/.test(section), "scenario12: current session excluded from its own brief");
}

// Scenario 13: token-aware context tracking — report carries context % full +
// window, and a context.usage event fires each round (Claude Code style).
{
  const runtime = makeRuntime({ providerScript: [() => ({ text: "done bhai", toolCalls: [] })] });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "hi", agent: { id: "main" }, profile: {}, session: { id: "s13" }, run: { id: "r13" }, tools: baseTools, contextBundle: {},
  });
  assert(report.contextWindowTokens === 128000, `scenario13: context window tokens tracked (got ${report.contextWindowTokens})`);
  assert(typeof report.contextPercentFull === "number" && report.contextPercentFull >= 0, "scenario13: context % full computed");
  assert(runtime.transients.some((t) => t.event === "context.usage" && typeof t.payload.percentFull === "number"), "scenario13: context.usage event emitted");
}

// Scenario 14: read-before-edit (Claude Code parity) — a blind edit (no prior
// read) is BLOCKED; after read_file, the edit is allowed.
{
  const mk = (id, tool, input) => ({ text: "", toolCalls: [{ id, tool, input }], assistantMessage: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(input) } }] } });
  const runtime = makeRuntime({
    providerScript: [
      () => mk("e1", "edit", { path: "app.js", find: "a", replace: "b" }),
      ({ messages }) => {
        const block = messages.find((m) => m.role === "tool" && m.tool_call_id === "e1");
        if (!block || !/read .* first/i.test(block.content)) throw new Error("read-before-edit block not returned");
        return mk("r1", "read_file", { path: "app.js" });
      },
      () => mk("e2", "edit", { path: "app.js", find: "x", replace: "y" }),
      () => ({ text: "edit ho gaya", toolCalls: [] }),
    ],
  });
  runtime.tools.run = async (id, input) => {
    if (id === "read_file") return { path: input.path, content: "x y", bytesRead: 3 };
    if (id === "edit") return { edited: true, path: input.path };
    return { ok: true };
  };
  const tools = [...baseTools, { id: "edit", description: "Edit a file", schema: { type: "object", required: ["path", "find"], properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } } } }];
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({ message: "edit app.js", agent: { id: "main" }, profile: {}, session: { id: "s14" }, run: { id: "r14" }, tools, contextBundle: {} });
  assert(report.readBeforeEditBlocks === 1, `scenario14: blind edit blocked once (got ${report.readBeforeEditBlocks})`);
  assert(runtime.events.some((e) => e.event === "model_tool_loop.read_before_edit_block"), "scenario14: read-before-edit block event emitted");
  assert(report.finalReady && /ho gaya/.test(report.finalAnswer), "scenario14: completed after reading then editing");
}

// Scenario 15: deeper auto-verification — a website (HTML/CSS), OmniClaw's most
// common output, now gets checked instead of being declared done blind. HTML
// referencing a missing local file is flagged; a self-contained page passes;
// a CSS brace mismatch is caught.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-autocheck-"));
  const runtime = makeRuntime({ providerScript: [] });
  runtime.rootDir = tmp;
  const loop = new OmniLoop({ agentRuntime: runtime });

  fs.writeFileSync(path.join(tmp, "broken.html"), '<!doctype html><html><body><script src="missing.js"></script></body></html>');
  const out1 = { path: "broken.html", edited: true };
  await loop.maybeAutoCheck({ tool: "write_file", input: { path: "broken.html" } }, out1);
  assert(out1.autoCheck && out1.autoCheck.ok === false && /missing/i.test(out1.autoCheck.message), "scenario15: HTML missing-asset reference flagged");

  fs.writeFileSync(path.join(tmp, "ok.html"), '<!doctype html><html><body><h1>Hi</h1><script>console.log(1)</script></body></html>');
  const out2 = { path: "ok.html", edited: true };
  await loop.maybeAutoCheck({ tool: "write_file", input: { path: "ok.html" } }, out2);
  assert(out2.autoCheck && out2.autoCheck.ok === true, "scenario15: clean self-contained HTML passes");

  fs.writeFileSync(path.join(tmp, "bad.css"), "body { color: red; ");
  const out3 = { path: "bad.css", edited: true };
  await loop.maybeAutoCheck({ tool: "write_file", input: { path: "bad.css" } }, out3);
  assert(out3.autoCheck && out3.autoCheck.ok === false && /brace/i.test(out3.autoCheck.message), "scenario15: CSS brace mismatch caught");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Scenario 16: stuck-detection ("stop if no improvement / escalate to human") —
// 4 consecutive all-failing rounds stop the loop with an honest report instead
// of burning the whole round budget.
{
  const mk = (n) => ({ text: "", toolCalls: [{ id: "f" + n, tool: "exec", input: { command: "cmd" + n } }], assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "f" + n, type: "function", function: { name: "exec", arguments: JSON.stringify({ command: "cmd" + n }) } }] } });
  const runtime = makeRuntime({ providerScript: [() => mk(1), () => mk(2), () => mk(3), () => mk(4), () => mk(5)] });
  runtime.tools.run = async () => ({ error: true, message: "boom: command failed" });
  const tools = [...baseTools, { id: "exec", description: "Run a command", schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } }];
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({ message: "fix the build", agent: { id: "main" }, profile: {}, session: { id: "s16" }, run: { id: "r16" }, tools, contextBundle: {} });
  assert(report.stoppedReason === "stuck-no-progress", `scenario16: stuck stop reason (got ${report.stoppedReason})`);
  assert(report.consecutiveFailingRounds === 4, `scenario16: 4 consecutive failing rounds (got ${report.consecutiveFailingRounds})`);
  assert(report.finalReady && /atak gaya/.test(report.finalAnswer), "scenario16: honest stuck report escalated to user");
  assert(runtime.events.some((e) => e.event === "model_tool_loop.stuck"), "scenario16: stuck event emitted");
}

// Scenario 17: continuous learning — instincts are extracted from a meaningful
// run, stored with confidence, reinforced (not duplicated) on repeat, and
// rendered into the prompt so the agent gets smarter over time.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omni-instinct-"));
  const runtime = makeRuntime({ providerScript: [] });
  runtime.rootDir = tmp;
  // The default stub reply ("summary: budget khatam...") is now REJECTED by the
  // instinct quality gate (meta/status lines can't become instincts) — return a
  // real one-sentence lesson for this scenario.
  runtime.provider.complete = async () => ({ text: "When building HTML pages, always verify rendering in a real browser before declaring done." });
  const loop = new OmniLoop({ agentRuntime: runtime });
  assert(loop.loadInstincts().length === 0 && loop.buildInstinctsSection() === "", "scenario17: empty instinct store + no section initially");
  const report = { finalReady: true, stoppedReason: "model-final-ready", codeEdited: true, verificationRan: true, toolCallCount: 5, failedObservationCount: 0 };
  const toolOutputs = [{ tool: "write_file", input: { path: "a.html" }, output: { path: "a.html" } }];
  await loop.learnFromRun(report, toolOutputs);
  assert(loop.loadInstincts().length === 1 && report.instinctLearned === "new", "scenario17: learnFromRun stored a NEW instinct");
  const r2 = { ...report, instinctLearned: undefined };
  await loop.learnFromRun(r2, toolOutputs);
  const after = loop.loadInstincts();
  assert(after.length === 1 && r2.instinctLearned === "reinforced" && after[0].confidence > 0.5, "scenario17: repeat REINFORCES (confidence up, no duplicate)");
  assert(/Learned Instincts/.test(loop.buildInstinctsSection()), "scenario17: instincts render into the prompt section");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Scenario 19 (T2.2): menuV2 builds CORE-only menu (no cap, no boost leak)
// and the finish tool ends the run with its summary.
{
  const runtime = makeRuntime({
    providerScript: [
      ({ messages, input }) => {
        const names = (input.tools || []).map((t) => t.function.name);
        if (names.includes("browser_open")) throw new Error(`browser toolset leaked into unboosted menu: ${names.join(",")}`);
        for (const need of ["read_file", "write_file", "finish"]) {
          if (!names.includes(need)) throw new Error(`CORE member missing from menu: ${need}`);
        }
        return {
          text: "",
          toolCalls: [{ id: "call_1", tool: "finish", input: { summary: "All wrapped up.", ok: true } }],
          assistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "finish", arguments: '{"summary":"All wrapped up.","ok":true}' } }] },
        };
      },
    ],
  });
  runtime.config.getConfig = () => ({
    provider: { systemPrompt: "You are OmniClaw test agent." },
    tools: { menuV2: true },
    runtime: {
      agentLoop: { maxSteps: 100, maxToolCallsPerStep: 5, maxRepeatedToolCalls: 2, outputPreviewChars: 2000 },
      omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, maxToolResultChars: 400, readResultChars: 4000, historyMessages: 4, contextCharBudget: 100000, maxTools: 16, providerRetries: 0, streaming: true },
    },
  });
  runtime.tools.run = async (id, toolInput, context) => {
    runtime.toolRuns.push({ id, toolInput, context });
    if (id === "finish") return { finished: true, ok: true, summary: String(toolInput.summary || "") };
    return { ok: true };
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "wrap up now",
    agent: { id: "main", name: "Main" },
    profile: { id: "power" },
    session: { id: "session_test" },
    run: { id: "run_test" },
    tools: [
      ...baseTools,
      { id: "finish", description: "Finish", schema: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } } },
      { id: "browser_open", description: "Browser", schema: { type: "object", properties: {} } },
    ],
    contextBundle: {},
  });
  assert(report.stoppedReason === "finish-tool", `scenario19: finish tool ends run (got ${report.stoppedReason})`);
  assert(report.finalReady && /wrapped up/.test(report.finalAnswer), "scenario19: finish summary becomes the answer");
  const menuEv = runtime.events.find((e) => e.event === "toolset.menu");
  assert(menuEv && menuEv.payload.size === 3 && menuEv.payload.tokens > 0, `scenario19: toolset.menu logged (got ${JSON.stringify(menuEv && menuEv.payload)})`);
  assert(report.menu && report.menu.size === 3, "scenario19: report.menu recorded");
}

console.log(process.exitCode ? "\nOMNI-LOOP SMOKE: FAILED" : "\nOMNI-LOOP SMOKE: PASSED");
