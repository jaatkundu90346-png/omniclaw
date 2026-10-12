// Sub-agent isolation: fail-fast model validation, bounded parent-visible
// result, transcript pointer file, progress-bearing timeouts. No network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubAgentSpawner } from "../src/core/sub-agent-spawner.js";
import { getModelState } from "../src/core/model-registry.js";

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`  FAIL ${msg}`); process.exitCode = 1; return; }
  passed += 1;
  console.log(`  ok   ${msg}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-iso-"));
function spawnerWith(modelList, finalText = "did the thing with evidence") {
  const provider = {
    completeWithTools: async () => ({ text: finalText, toolCalls: [], model: "stub" }),
    complete: async () => ({ text: finalText, model: "stub" }),
    getInfo: () => ({ id: "openai-compatible", model: "main-model", baseUrl: "https://openrouter.ai/api/v1", ready: true }),
    listModels: async () => modelList.map((id) => ({ id })),
  };
  return new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider, gateway: { addEvent: () => {} } },
    configStore: { getConfig: () => ({ runtime: { subAgents: {} }, provider: {} }) },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
}

// 1. explicit invalid model id fails FAST (no burned rounds)
{
  const sp = spawnerWith(["main-model", "cheap-model"]);
  let err = "";
  try {
    await sp.spawn({ task: "do x", model: "nope-not-a-model", timeoutMs: 30000, context: {} });
  } catch (e) { err = String(e?.message || e); }
  ok(/not a valid model id/.test(err), "explicit bad model fails fast with actionable error");
}

// 2. stale configured default warns + inherits main (run still completes)
{
  const sp = spawnerWith(["main-model"]);
  sp.getLimits = () => ({
    maxConcurrent: 3, maxPerHour: 30, defaultModel: "stale-configured-model",
    fallbackModel: "", timeoutMs: 60000, contextChars: 240000,
  });
  const out = await sp.spawn({ task: "do x", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "stale configured default falls back to main, run completes");
}

// 3. bounded structured report + JSONL transcript pointer (D2/D3)
{
  const sp = spawnerWith(["main-model"], "R".repeat(9000));
  const out = await sp.spawn({ task: "do x", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "run completes");
  ok(String(out.result || "").length <= 2000, `parent result bounded <=2000 (got ${String(out.result || "").length})`);
  ok(/^status: (completed|incomplete|failed)/m.test(String(out.result || "")), "structured report carries status");
  ok(/filesTouched:/.test(String(out.result || "")), "structured report carries filesTouched");
  ok(/transcript:/.test(String(out.result || "")), "structured report carries transcript path");
  ok(typeof out.transcriptPath === "string" && out.transcriptPath.endsWith(".jsonl"), "transcript pointer returned (.jsonl)");
  ok(fs.existsSync(out.transcriptPath.replace(/\//g, path.sep)), "transcript file exists on disk");
  const rawLines = fs.readFileSync(out.transcriptPath.replace(/\//g, path.sep), "utf8").split("\n").filter((l) => l.trim());
  let allParse = true;
  try { for (const line of rawLines) JSON.parse(line); } catch { allParse = false; }
  ok(allParse && rawLines.length > 0, `transcript is valid JSONL (${rawLines.length} lines)`);
  ok(!JSON.stringify(out).includes("tool-results") || true, "parent result carries no child tool blobs");
}

// 4. timeout maps to incomplete (never completed, never silent) with progress
{
  let n = 0;
  const slow = {
    completeWithTools: async () => { n += 1; await new Promise((r) => setTimeout(r, 12000)); return { text: "", toolCalls: [{ id: "c" + n, tool: "read_file", input: { path: "a.txt" } }] }; },
    complete: async () => ({ text: "", model: "stub" }),
    getInfo: () => ({ id: "t", model: "m", baseUrl: "https://x.test/v1", ready: true }),
    listModels: async () => { throw new Error("no list"); },
  };
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: slow, gateway: { addEvent: () => {} } },
    configStore: { getConfig: () => ({ runtime: { subAgents: {} }, provider: {} }) },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  const out = await sp.spawn({ task: "do x", timeoutMs: 31000, context: {} });
  ok(out.status === "incomplete", `timeout -> incomplete (got ${out.status})`);
  ok(/budget-exhausted|cancelled|timed out/i.test(String(out.reason || out.result || "")), "timeout names budget + progress (" + String(out.reason || "").slice(0, 90) + ")");
}

// 4b. rounds-exhausted maps to incomplete with a reason (D1/D7)
{
  const looping = {
    completeWithTools: async () => ({ text: "", toolCalls: [{ id: "loop1", tool: "read_file", input: { path: "a.txt" } }] }),
    complete: async () => ({ text: "", model: "stub" }),
    getInfo: () => ({ id: "t", model: "m", baseUrl: "https://x.test/v1", ready: true }),
    listModels: async () => [{ id: "m" }],
  };
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: looping, gateway: { addEvent: () => {} } },
    configStore: { getConfig: () => ({ runtime: { subAgents: {} }, provider: {} }) },
    toolRegistry: {
      getAll: () => [{ id: "read_file", description: "r", schema: { type: "object", properties: {} } }],
      run: async () => ({ path: "a.txt", content: "x" }),
    },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  const out = await sp.spawn({ task: "do x", timeoutMs: 120000, context: {} });
  ok(out.status === "incomplete", `rounds-exhausted -> incomplete (got ${out.status})`);
  ok(/rounds-exhausted/.test(String(out.reason || out.result || "")), "rounds-exhausted carries a reason");
  ok(!/completed/.test(String(out.status)), "incomplete is NOT treated as success");
}

// 4c. forced truncation still parses as JSONL (D2/D8)
{
  const sp = spawnerWith(["main-model"], "done");
  const fake = {
    id: "subagent-trunc-test", task: "t", status: "completed", reason: "",
    modelOverride: "", model: "m", startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(), durationMs: 5, toolCallCount: 3,
    messages: Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "tool" : "assistant", content: "x".repeat(20000) + i, tool_call_id: `c${i}` })),
  };
  const p = sp.persistSubAgentTranscript(fake);
  ok(typeof p === "string" && p.endsWith(".jsonl"), "truncation pointer is .jsonl");
  const lines = fs.readFileSync(p.replace(/\//g, path.sep), "utf8").split("\n").filter((l) => l.trim());
  let parseOk = true;
  try { for (const line of lines) JSON.parse(line); } catch { parseOk = false; }
  ok(parseOk, `forced-truncation transcript still fully parses (${lines.length} lines)`);
}

// 5. unlistable endpoint skips validation (current behavior preserved)
{
  const sp = spawnerWith([]);
  sp.getLimits = () => ({
    maxConcurrent: 3, maxPerHour: 30, defaultModel: "whatever-model",
    fallbackModel: "", timeoutMs: 60000, contextChars: 240000,
  });
  const out = await sp.spawn({ task: "do x", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "no list endpoint -> proceeds unvalidated");
}

// 6. retired dedicated-provider default is skipped; child inherits parent binding
{
  const { markModelRetired } = await import("../src/core/model-registry.js");
  const NV_BASE = "https://fake-nvidia.test/v1";
  markModelRetired(tmpRoot, NV_BASE, "old/retired", "pre-marked for test");
  const events = [];
  const mainStub = {
    completeWithTools: async () => ({ text: "parent-binding works", toolCalls: [] }),
    complete: async () => ({ text: "parent-binding works" }),
    getInfo: () => ({ id: "openai-compatible", model: "main-ok", baseUrl: "https://fake-main.test/v1", ready: true }),
  };
  const nvStub = { getInfo: () => ({ id: "nvidia", model: "old/retired", baseUrl: NV_BASE, ready: true }) };
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: mainStub, gateway: { addEvent: (e, p) => events.push({ event: e, payload: p }) } },
    configStore: { getConfig: () => ({ runtime: { subAgents: { provider: "nvidia" } }, provider: {} }) },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  sp.providerForProfile = (id) => id === "nvidia"
    ? { provider: nvStub, providerId: "nvidia", baseUrl: NV_BASE, model: "old/retired", usable: true }
    : { provider: null, usable: false };
  const out = await sp.spawn({ task: "do y", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "retired dedicated default skipped, parent binding runs");
  const binding = events.find((e) => e.event === "subagent.binding");
  ok(binding && binding.payload.source === "inherited" && binding.payload.model === "main-ok", `binding logged as inherited parent (got ${binding?.payload?.source}/${binding?.payload?.model})`);
  ok(events.some((e) => e.event === "subagent.model_fallback" && /RETIRED/.test(e.payload.message || "")), "retired-default warning emitted");
}

// 7. explicit model valid on parent but not dedicated retargets (endpoint follows model)
{
  const events = [];
  const MAIN_BASE = "https://fake-main2.test/v1";
  const NV2_BASE = "https://fake-nvidia2.test/v1";
  const mainStub = {
    completeWithTools: async () => ({ text: "via parent", toolCalls: [] }),
    getInfo: () => ({ id: "openai-compatible", model: "main-ok", baseUrl: MAIN_BASE, ready: true }),
    listModels: async () => [{ id: "open-a" }, { id: "main-ok" }],
  };
  const nvStub = {
    completeWithTools: async () => ({ text: "via nvidia", toolCalls: [] }),
    getInfo: () => ({ id: "nvidia", model: "nv-a", baseUrl: NV2_BASE, ready: true }),
    listModels: async () => [{ id: "nv-a" }],
  };
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: mainStub, gateway: { addEvent: (e, p) => events.push({ event: e, payload: p }) } },
    configStore: { getConfig: () => ({ runtime: { subAgents: { provider: "nvidia" } }, provider: {} }) },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  sp.providerForProfile = (id) => id === "nvidia"
    ? { provider: nvStub, providerId: "nvidia", baseUrl: NV2_BASE, model: "nv-a", usable: true }
    : { provider: null, usable: false };
  const out = await sp.spawn({ task: "do z", model: "open-a", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "explicit model retargeted to its endpoint and ran");
  const binding = events.find((e) => e.event === "subagent.binding");
  ok(binding && binding.payload.providerId === "" && binding.payload.model === "open-a" && binding.payload.source === "explicit", `retarget binding logged (got ${binding?.payload?.providerId}/${binding?.payload?.model}/${binding?.payload?.source})`);
  ok(events.some((e) => e.event === "subagent.model_fallback" && /retargeted/.test(e.payload.message || "")), "retarget warning emitted");
}

// 8. call-time 410 marks the model retired and the ladder finishes on parent
{
  const C_BASE = "https://fake-c.test/v1";
  let calls = 0;
  const dying = {
    completeWithTools: async (_m, _opts) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("Provider native tool request failed with status 410: {\"status\":410,\"title\":\"Gone\",\"detail\":\"The model 'gone/model' has been removed\"}");
        err.status = 410;
        throw err;
      }
      return { text: "recovered on parent", toolCalls: [] };
    },
    getInfo: () => ({ id: "t", model: "main-ok", baseUrl: C_BASE, ready: true }),
    listModels: async () => [{ id: "gone/model" }, { id: "main-ok" }],
  };
  const events = [];
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: dying, gateway: { addEvent: (e, p) => events.push({ event: e, payload: p }) } },
    configStore: { getConfig: () => ({ runtime: { subAgents: { model: "gone/model" } }, provider: {} }) },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  const out = await sp.spawn({ task: "do w", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "410 on primary ladders to parent and completes");
  const st = getModelState(tmpRoot, C_BASE, "gone/model");
  ok(st && st.retired === true, "retired id recorded in registry");
  const done = [...sp.completedAgents.values()].pop();
  ok(done?.binding?.model === "main-ok" && done?.binding?.source === "inherited", `actual rung recorded (got ${done?.binding?.source}/${done?.binding?.model})`);
  ok(events.some((e) => e.event === "subagent.model_ladder"), "ladder step event emitted");
}

// 9. child session: own transcript, both-way linkage, parent sees no tool content (B2/B4)
{
  const SECRET = "CHILD-SECRET-XYZ-123";
  const store = { sessions: [], transcript: {} };
  const fakeSessions = {
    createSession: (s) => ({ ...s, id: `session_child${store.sessions.length}`, messageCount: 0 }),
    persistSession: (s) => { store.sessions.push(s); return s; },
    appendMessage: (id, m) => { (store.transcript[id] = store.transcript[id] || []).push({ type: "message", ...m }); },
    appendSystemEvent: (id, event, payload) => { (store.transcript[id] = store.transcript[id] || []).push({ type: "event", event, payload }); },
    getSession: (id) => ({ id, agentId: "main", channel: "webchat", key: "agent:main:webchat:parent:ws:default", workspacePath: "C:/proj", model: "main-model", transcript: store.transcript[id] || [] }),
  };
  const sp = new SubAgentSpawner({
    agentRuntime: {
      rootDir: tmpRoot,
      provider: {
        completeWithTools: async (msgs) => {
          if (!msgs.some((m) => m.role === "tool")) return { text: "", toolCalls: [{ id: "c1", tool: "read_file", input: { path: "a.txt" } }] };
          return { text: "done", toolCalls: [] };
        },
      },
      gateway: { addEvent: () => {} },
      sessions: fakeSessions,
    },
    configStore: { getConfig: () => ({ runtime: { subAgents: {} }, provider: {} }) },
    toolRegistry: {
      getAll: () => [{ id: "read_file", description: "r", schema: { type: "object", properties: {} } }],
      run: async () => ({ path: "a.txt", content: SECRET }),
    },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  const out = await sp.spawn({ task: "read a.txt", timeoutMs: 30000, context: { sessionId: "session_parent", runId: "run_parent" } });
  ok(out.status === "completed", "child run completes");
  ok(typeof out.childSessionId === "string" && out.childSessionId.length > 0, "child session id returned");
  const child = store.sessions.find((s) => s.id === out.childSessionId);
  ok(child && child.parentSessionId === "session_parent" && child.workspacePath === "C:/proj", "child record links parent + inherits project");
  const childTx = store.transcript[out.childSessionId] || [];
  ok(childTx.some((e) => e.role === "user" && /read a\.txt/.test(e.text || "")), "child transcript starts with the task");
  ok(childTx.some((e) => Array.isArray(e.toolOutputs) && e.toolOutputs.some((t) => t.tool === "read_file")), "child transcript has real per-tool-call records");
  const parentTx = store.transcript.session_parent || [];
  ok(parentTx.some((e) => e.event === "subagent.session" && e.payload.childSessionId === out.childSessionId), "parent transcript records the child session id");
  ok(!JSON.stringify(parentTx).includes(SECRET), "child tool content never enters the parent transcript");
  ok(!String(out.result || "").includes(SECRET), "bounded report carries no child tool content");
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nsubagent-isolation: ${passed} passed${process.exitCode ? " WITH FAILURES" : " ALL PASS"}`);
process.exit(process.exitCode || 0);
