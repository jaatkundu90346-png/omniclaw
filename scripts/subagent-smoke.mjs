// Smoke test for the 2026-07-02 sub-agent upgrade:
// 1. arg repair inside sub-agents (filepath -> path)
// 2. verdict-first / plain-rendered tool observations in the sub-agent transcript
// 3. text-drift tool-call recovery inside sub-agents
// 4. gateway lifecycle events (spawned/completed)
// 5. parallel fan-out: two delegate_task calls in one round run concurrently
import assert from "node:assert";
import { SubAgentSpawner } from "../src/core/sub-agent-spawner.js";
import { OmniLoop } from "../src/core/omni-loop.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };

const makeRegistry = (onRun) => ({
  getAll: () => [
    { id: "read_file", description: "read", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
    { id: "exec", description: "run", schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
  ],
  run: async (tool, input) => onRun(tool, input),
});

// ── 1+2. arg repair + verdict/plain observations ────────────────────────────
{
  const toolRuns = [];
  const events = [];
  let call = 0;
  const spawner = new SubAgentSpawner({
    agentRuntime: {
      rootDir: "C:/proj",
      gateway: { addEvent: (event, payload) => events.push({ event, payload }) },
      provider: {
        completeWithTools: async (messages) => {
          call += 1;
          if (call === 1) {
            // Weak-model shaped call: wrong key (filepath) — must be repaired.
            return { text: "", toolCalls: [{ id: "c1", tool: "read_file", input: { filepath: "src/app.js" } }] };
          }
          const toolMsg = messages.find((m) => m.role === "tool");
          assert.ok(toolMsg.content.startsWith("✅ read OK"), "sub-agent sees plain-rendered read verdict");
          assert.ok(toolMsg.content.includes("1\tconst a = 1;"), "sub-agent sees actual numbered code");
          return { text: "done: read src/app.js (2 lines).", toolCalls: [] };
        },
      },
    },
    configStore: { getConfig: () => ({ provider: {} }) },
    toolRegistry: makeRegistry((tool, input) => {
      toolRuns.push({ tool, input });
      return { path: input.path, numberedContent: "1\tconst a = 1;\n2\tconst b = 2;", totalLines: 2, truncated: false };
    }),
  });
  const result = await spawner.spawn({ task: "read src/app.js and report" });
  assert.equal(result.status, "completed", "sub-agent completed");
  assert.equal(toolRuns[0].input.path, "src/app.js", "filepath repaired to path");
  assert.equal(toolRuns[0].input.filepath, undefined, "alias key removed");
  ok("sub-agent repairs weak-model args (filepath -> path)");
  ok("sub-agent observations are verdict-first plain reads");

  // 4. gateway lifecycle events
  assert.ok(events.some((e) => e.event === "subagent.spawned"), "spawned event in gateway feed");
  const done = events.find((e) => e.event === "subagent.completed");
  assert.ok(done, "completed event in gateway feed");
  assert.ok(/sub-agent done in \d+s/.test(done.payload.message), "completed message human-readable");
  ok("sub-agent lifecycle visible in gateway activity feed");
}

// ── 3. text-drift recovery ──────────────────────────────────────────────────
{
  let call = 0;
  const toolRuns = [];
  const spawner = new SubAgentSpawner({
    agentRuntime: {
      rootDir: "C:/proj",
      provider: {
        completeWithTools: async () => {
          call += 1;
          if (call === 1) {
            // Model drifted out of native calling — wrote the call as JSON text.
            return { text: 'I will run it now: {"tool":"exec","args":{"command":"node --version"}}', toolCalls: [] };
          }
          return { text: "done: node v24.", toolCalls: [] };
        },
      },
    },
    configStore: { getConfig: () => ({ provider: {} }) },
    toolRegistry: makeRegistry((tool, input) => {
      toolRuns.push({ tool, input });
      return { status: "completed", exitCode: 0, command: input.command, stdout: "v24.15.0", stderr: "" };
    }),
  });
  const result = await spawner.spawn({ task: "check node version" });
  assert.equal(result.status, "completed");
  assert.equal(toolRuns.length, 1, "drifted call recovered and executed");
  assert.equal(toolRuns[0].input.command, "node --version");
  ok("sub-agent recovers text-mode tool calls");
}

// ── 5. parallel fan-out of delegate_task in the main loop ──────────────────
{
  const running = { now: 0, peak: 0 };
  const runtime = {
    config: { getConfig: () => ({ provider: {}, runtime: { omniLoop: { maxRounds: 4, providerRetries: 0, streaming: false, historyMessages: 0, maxParallelToolCalls: 4 } } }) },
    gateway: { addEvent: () => {}, emitTransient: () => {}, listRuns: () => [] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true, model: "stub" }),
      completeWithTools: (() => {
        let call = 0;
        return async () => {
          call += 1;
          if (call === 1) {
            return {
              text: "",
              toolCalls: [
                { id: "d1", tool: "delegate_task", input: { task: "build page A" } },
                { id: "d2", tool: "delegate_task", input: { task: "build page B" } },
              ],
            };
          }
          return { text: "dono sub-agents ka kaam ho gaya.", toolCalls: [] };
        };
      })(),
      complete: async () => ({ text: "" }),
    },
    tools: {
      run: async (tool) => {
        assert.equal(tool, "delegate_task");
        running.now += 1;
        running.peak = Math.max(running.peak, running.now);
        await new Promise((r) => setTimeout(r, 120));
        running.now -= 1;
        return { id: "sub-x", status: "completed", result: "done" };
      },
    },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "do pages banao parallel me",
    agent: { id: "main" }, profile: {}, session: { id: "s3" }, run: { id: "r3" },
    tools: [{ id: "delegate_task", description: "d", schema: { type: "object", required: ["task"], properties: { task: { type: "string" } } } }],
    contextBundle: {},
  });
  assert.equal(report.toolCallCount, 2, "both delegations executed");
  assert.equal(running.peak, 2, `delegations overlapped (peak ${running.peak})`);
  assert.ok(report.parallelToolBatches >= 1, "parallel batch recorded");
  ok("two delegate_task calls in one round run in PARALLEL");
}

// ── 6. config-driven limits + rolling hour window (no lifetime cap) ────────
{
  const spawner = new SubAgentSpawner({
    agentRuntime: { rootDir: "C:/proj", provider: { completeWithTools: async () => ({ text: "done.", toolCalls: [] }) } },
    configStore: { getConfig: () => ({ provider: {}, runtime: { subAgents: { maxConcurrent: 2, maxPerHour: 5, model: "cheap/model-a", fallbackModel: "cheap/model-b" } } }) },
    toolRegistry: makeRegistry(() => ({ ok: true })),
  });
  const limits = spawner.getLimits();
  assert.equal(limits.maxConcurrent, 2, "maxConcurrent from config");
  assert.equal(limits.maxPerHour, 5, "maxPerHour from config");
  assert.equal(limits.defaultModel, "cheap/model-a", "default sub-agent model from config");
  // 25+ sequential spawns must NOT hit any lifetime cap (old maxTotal=20 bug)
  for (let i = 0; i < 4; i += 1) {
    const r = await spawner.spawn({ task: `task ${i}` });
    assert.equal(r.status, "completed", `spawn ${i} ok`);
  }
  assert.equal(spawner.getStatus().spawnedThisHour, 4, "rolling window counts spawns");
  // 5th spawn hits the per-hour budget with an actionable error
  await spawner.spawn({ task: "task 5" });
  let hourErr = "";
  try { await spawner.spawn({ task: "task 6" }); } catch (e) { hourErr = e.message; }
  assert.ok(/max 5\/hour/.test(hourErr) && /Settings/.test(hourErr), "per-hour budget error is actionable");
  // completed map pruned, spawn default model applied
  assert.ok(spawner.completedAgents.size <= 20, "completed map bounded");
  const anyDone = [...spawner.completedAgents.values()][0];
  assert.equal(anyDone.modelOverride, "cheap/model-a", "config default model used for spawns");
  ok("config-driven limits: rolling window, no lifetime cap, default model");
}

// ── 7. rate-limit → fallback model retry inside the sub-agent ──────────────
{
  let calls = 0;
  const models = [];
  const spawner = new SubAgentSpawner({
    agentRuntime: {
      rootDir: "C:/proj",
      gateway: { addEvent: () => {} },
      provider: {
        completeWithTools: async (_messages, opts) => {
          calls += 1;
          models.push(opts.model || "(main)");
          if (calls === 1) {
            const err = new Error("Provider native tool request failed with 429 rate limit exceeded");
            err.status = 429;
            throw err;
          }
          return { text: "done on fallback.", toolCalls: [] };
        },
      },
    },
    configStore: { getConfig: () => ({ provider: {}, runtime: { subAgents: { fallbackModel: "cheap/fallback-model" } } }) },
    toolRegistry: makeRegistry(() => ({ ok: true })),
  });
  const result = await spawner.spawn({ task: "research kar" });
  assert.equal(result.status, "completed", "delegation survives the rate limit");
  assert.equal(models[1], "cheap/fallback-model", "retried on the fallback model");
  assert.match(String(result.result), /^status: completed/m, "structured report carries completed status");
  assert.match(String(result.result), /done on fallback\./, "fallback result returned to parent (inside bounded report)");
  ok("sub-agent rate-limit -> automatic fallback-model retry");
}

// ── 8. settings endpoint sanitizes runtime.subAgents patch ─────────────────
{
  const { CustomizationEngine } = await import("../src/core/customization-engine.js");
  let written = null;
  const engine = new CustomizationEngine({
    configStore: { updateUserConfig: (patch) => { written = patch; return patch; }, getConfig: () => ({}) },
  });
  engine.updateRuntimeSettings({ runtime: { subAgents: { model: " m/x ", fallbackModel: "m/y", maxConcurrent: 99, maxPerHour: 9999, evilKey: "nope" } } });
  assert.equal(written.runtime.subAgents.model, "m/x", "model trimmed + saved");
  assert.equal(written.runtime.subAgents.maxConcurrent, 8, "maxConcurrent clamped to 8");
  assert.equal(written.runtime.subAgents.maxPerHour, 200, "maxPerHour clamped to 200");
  assert.equal(written.runtime.subAgents.evilKey, undefined, "unknown keys dropped");
  ok("settings endpoint sanitizes sub-agent config");
}

console.log(`\nsubagent-smoke: ${passed} checks passed, 0 failed`);
