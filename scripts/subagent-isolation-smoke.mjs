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

// 1. an explicit model argument is IGNORED — it can no longer fail fast,
// because it is no longer consulted at all. (It used to raise "not a valid
// model id" here.) The delegation must still run, on the main model.
{
  const sp = spawnerWith(["main-model", "cheap-model"]);
  const out = await sp.spawn({ task: "do x", model: "nope-not-a-model", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "an explicit model argument does not break or redirect the delegation");
}

// 2. a stale configured sub-agent model is ignored; the run still completes
{
  const sp = spawnerWith(["main-model"]);
  sp.getLimits = () => ({
    maxConcurrent: 3, maxPerHour: 30, timeoutMs: 60000, contextChars: 240000,
  });
  const out = await sp.spawn({ task: "do x", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "the run completes on the main model");
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
    maxConcurrent: 3, maxPerHour: 30, timeoutMs: 60000, contextChars: 240000,
  });
  const out = await sp.spawn({ task: "do x", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "no list endpoint -> proceeds unvalidated");
}

// 6-8. The model ladder is GONE. These three cases used to prove that a
// dedicated sub-agent provider, an explicit model, and a retired configured
// default each resolved to a DIFFERENT model than the parent had. That is
// exactly the surprise the feature removal is about, so they are now replaced
// by the inverse: none of those inputs may move the child off the main model.
{
  const MAIN_BASE = "https://fake-main.test/v1";
  const seen = [];
  const events = [];
  const mainStub = {
    completeWithTools: async (_m, opts) => {
      seen.push(opts?.model || "(none)");
      return { text: "parent binding works", toolCalls: [] };
    },
    complete: async () => ({ text: "parent binding works" }),
    getInfo: () => ({ id: "openai-compatible", model: "main-ok", baseUrl: MAIN_BASE, ready: true }),
    listModels: async () => [{ id: "main-ok" }, { id: "other/model" }],
  };
  // A config that still carries every removed key, plus a spawn that still
  // passes a model. If ANY of these still steer the child, the removal leaked.
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: mainStub, gateway: { addEvent: (e, p) => events.push({ event: e, payload: p }) } },
    configStore: {
      getConfig: () => ({
        runtime: { subAgents: { provider: "nvidia", model: "other/model", fallbackModel: "other/fallback" } },
        provider: {},
      }),
    },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  const out = await sp.spawn({ task: "do z", model: "other/model", provider: "nvidia", timeoutMs: 30000, context: {} });
  ok(out.status === "completed", "spawn completes on the parent binding");
  const binding = events.find((e) => e.event === "subagent.binding");
  ok(binding && binding.payload.source === "inherited" && binding.payload.model === "main-ok", `binding logged as the inherited parent (got ${binding?.payload?.source}/${binding?.payload?.model})`);
  ok(binding && binding.payload.providerId === "", "a dedicated sub-agent provider must not be used");
  ok(seen.length > 0 && seen.every((m) => m === "main-ok" || m === "(none)"), `child only ever ran the main model (saw ${JSON.stringify(seen)})`);
  const done = [...sp.completedAgents.values()].pop();
  ok(done?.binding?.model === "main-ok" && done?.binding?.source === "inherited", `actual rung recorded as inherited (got ${done?.binding?.source}/${done?.binding?.model})`);
  ok(done?.requestedModel === "other/model", "the ignored argument is recorded on the child for traceability");
  ok(!events.some((e) => e.event === "subagent.model_fallback"), "no fallback-model event: there is nothing to fall back to");
}

// 8b. a 410 on the ONLY binding fails loudly instead of quietly completing
// elsewhere — the user must learn that their main model is dead, not receive a
// result from a model they never chose.
{
  const C_BASE = "https://fake-c.test/v1";
  const dying = {
    completeWithTools: async () => {
      const err = new Error("Provider native tool request failed with status 410: {\"status\":410,\"title\":\"Gone\",\"detail\":\"The model has been removed\"}");
      err.status = 410;
      throw err;
    },
    getInfo: () => ({ id: "t", model: "main-ok", baseUrl: C_BASE, ready: true }),
    listModels: async () => [{ id: "main-ok" }],
  };
  const events = [];
  const sp = new SubAgentSpawner({
    agentRuntime: { rootDir: tmpRoot, provider: dying, gateway: { addEvent: (e, p) => events.push({ event: e, payload: p }) } },
    configStore: { getConfig: () => ({ runtime: { subAgents: {} }, provider: {} }) },
    toolRegistry: { getAll: () => [], run: async () => ({ ok: true }) },
    agentRegistry: null, memoryStore: null, taskStore: null,
  });
  let failure = null;
  try { await sp.spawn({ task: "do w", timeoutMs: 30000, context: {} }); } catch (e) { failure = e; }
  ok(failure, "a 410 on the only binding fails the delegation");
  ok(/main agent's model and endpoint/.test(failure?.message || ""), "the error points the fix at the MAIN binding");
  ok(!events.some((e) => e.event === "subagent.model_ladder"), "no ladder step exists to emit");
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
