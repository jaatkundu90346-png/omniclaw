// Long-task durability (live 2026-09-27, NEXUS runs run_1790492275263_vajwt0 +
// run_1790494001208_zu5eqo). Both died at `stopReason: "max_rounds"` with 1 of 7
// plan steps done, and the follow-up "retry" re-explored from scratch:
//  1. the round ceiling (18) is a SHORT-task budget — a committed multi-file
//     build must scale with the plan it inherited;
//  2. the durable resume handoff was only written on TOKEN budget exhaustion, so
//     a round-ceiling stop left nothing to resume from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OmniLoop, longTaskRoundBudget, longTaskTokenBudget,
  LONG_TASK_MAX_ROUNDS, LONG_TASK_MAX_TOKEN_BUDGET, ROUNDS_PER_PLAN_STEP, TOKENS_PER_PLAN_STEP, LONG_TASK_PLAN_THRESHOLD,
} from "../src/core/omni-loop.js";

// The REAL shipped defaults. config/default.json pins maxRounds/runTokenBudget,
// which is exactly what defeated the first two attempts — the fixture has to
// carry them or the test is lying about production.
const SHIPPED_DEFAULTS = JSON.parse(fs.readFileSync(new URL("../config/default.json", import.meta.url), "utf8"));

// ConfigStore.getConfig() is merge(defaults, userConfig) — a test stub that
// returns only one of the two is not modelling production.
function mergedConfig(userConfig = {}) {
  const out = JSON.parse(JSON.stringify(SHIPPED_DEFAULTS));
  for (const [section, values] of Object.entries(userConfig)) {
    if (values && typeof values === "object" && !Array.isArray(values)) {
      out[section] = { ...(out[section] || {}), ...values };
      for (const [key, value] of Object.entries(values)) {
        if (value && typeof value === "object" && !Array.isArray(value) && out[section][key] && typeof out[section][key] === "object") {
          out[section][key] = { ...out[section][key], ...value };
        }
      }
    } else {
      out[section] = values;
    }
  }
  return out;
}

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

console.log("step 1: the round ceiling scales with the plan it inherited");
{
  assert(longTaskRoundBudget({ baseRounds: 18, planSteps: 0 }) === 18, "no plan -> the short-task default (18)");
  assert(longTaskRoundBudget({ baseRounds: 18, planSteps: 2 }) === 18, "a 2-step plan keeps the default");
  // 7 steps = the exact NEXUS plan that died at 18.
  const scaled = longTaskRoundBudget({ baseRounds: 18, planSteps: 7 });
  assert(scaled > 18, `a 7-step plan gets more than 18 rounds (got ${scaled})`);
  assert(scaled === 18 + (7 - (LONG_TASK_PLAN_THRESHOLD - 1)) * ROUNDS_PER_PLAN_STEP, `scales by ${ROUNDS_PER_PLAN_STEP}/step (got ${scaled})`);
  assert(scaled >= 40, `enough room to write+verify 7 steps (got ${scaled})`);
  assert(longTaskRoundBudget({ baseRounds: 18, planSteps: 200 }) === LONG_TASK_MAX_ROUNDS, `a huge plan is capped at ${LONG_TASK_MAX_ROUNDS}`);
  assert(longTaskRoundBudget({ baseRounds: 40, planSteps: 0 }) === 40, "an explicit config base is respected");
  assert(longTaskRoundBudget({ baseRounds: 18, planSteps: 5 }) > longTaskRoundBudget({ baseRounds: 18, planSteps: 3 }), "more steps -> more rounds");
  assert(longTaskRoundBudget({ planSteps: undefined }) === 18, "missing plan is safe");
}

console.log("step 1b: the TOKEN budget scales too (it is the second ceiling)");
{
  // Live 2026-09-27: after the round fix the run cleared the round wall and then
  // died at `budget-exhausted` after 15 rounds - the 600k default is spent in
  // ~15 rounds because every round re-sends the whole context.
  assert(longTaskTokenBudget({ baseBudget: 600000, planSteps: 0 }) === 600000, "no plan -> the 600k default");
  assert(longTaskTokenBudget({ baseBudget: 600000, planSteps: 2 }) === 600000, "a 2-step plan keeps the default");
  const scaled = longTaskTokenBudget({ baseBudget: 600000, planSteps: 4 });
  assert(scaled > 600000, `a 4-step plan gets more than 600k tokens (got ${scaled})`);
  assert(scaled === 600000 + 2 * TOKENS_PER_PLAN_STEP, `scales by ${TOKENS_PER_PLAN_STEP}/step (got ${scaled})`);
  // The live 7-step NEXUS plan saturates the 2M clamp.
  assert(longTaskTokenBudget({ baseBudget: 600000, planSteps: 7 }) === LONG_TASK_MAX_TOKEN_BUDGET, `a 7-step plan reaches the ${LONG_TASK_MAX_TOKEN_BUDGET} cap`);
  // 15 rounds burned the 600k default, so the scaled value must survive that.
  assert(scaled >= 600000 * 2, `at least double the short-task spend (got ${scaled})`);
  assert(longTaskTokenBudget({ baseBudget: 600000, planSteps: 50 }) === LONG_TASK_MAX_TOKEN_BUDGET, `capped at ${LONG_TASK_MAX_TOKEN_BUDGET}`);
  assert(longTaskTokenBudget({ baseBudget: 900000, planSteps: 0 }) === 900000, "an explicit config base is respected");
  assert(longTaskTokenBudget({ planSteps: null }) === 600000, "missing plan is safe");
}


console.log("step 2: the live loop applies the scaled ceiling + stamps a resume handoff");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "longrun-"));
  const runPlans = new Map();
  const sessionPlans = new Map();
  const events = [];
  const resumed = [];
  const runtime = {
    rootDir: tmpRoot,
    getWorkspaceRoot: () => tmpRoot,
    // Mirrors production: getConfig() = merge(shipped defaults, user config), and
    // the shipped defaults DO pin runtime.omniLoop.{maxRounds,runTokenBudget}.
    // readUserConfig() returns {} because the user has not overridden them.
    config: {
      getConfig: () => SHIPPED_DEFAULTS,
      readUserConfig: () => ({}),
    },
    gateway: { addEvent(type, payload) { events.push({ type, payload }); }, emitTransient() {} },
    sessions: {
      listSessions: () => [],
      getEvidenceLedger: () => null,
      getSession: () => ({ transcript: [] }),
      appendSystemEvent(sessionId, type, payload) { resumed.push({ sessionId, type, payload }); },
    },
    memory: { getLongTermMemory: () => [], getNotes: () => [], readMemoryIndex: () => "" },
    tools: {
      getAll: () => [{ id: "read_file", description: "r", modelCallable: true, schema: { type: "object", properties: {} } }],
      run: async () => ({ ok: true }),
      getRunPlan: (id) => runPlans.get(id) || null,
      setRunPlan: (id, plan) => runPlans.set(id, plan),
      getSessionPlan: (id) => sessionPlans.get(id) || null,
      setSessionPlan: (id, plan) => sessionPlans.set(id, plan),
      getRunToolsets: () => [], getSessionToolsets: () => [],
    },
    provider: {
      getInfo: () => ({ id: "recorder", model: "t", ready: true }),
      // Busy every round (a real tool call, no final text) so the run reaches the
      // round ceiling — exactly the live failure shape (1 of 7 steps done).
      completeWithTools: async () => {
        runtime.provider.n += 1;
        return { text: "", toolCalls: [{ id: `tc${runtime.provider.n}`, tool: "read_file", input: { path: `f${runtime.provider.n}.txt` } }] };
      },
      n: 0,
    },
    files: { rootDir: tmpRoot },
  };
  sessionPlans.set("s1", { steps: Array.from({ length: 7 }, (_, i) => ({ title: `step ${i + 1}`, status: i === 0 ? "completed" : "pending" })) });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "build the NEXUS website",
    intents: [],
    agent: { id: "main" },
    profile: { allowToolExecution: true },
    session: { id: "s1" },
    run: { id: "r1" },
    tools: runtime.tools.getAll(),
    contextBundle: { workspaceContext: { files: [], manifest: { selectedProject: tmpRoot, defaultWorkingDirectory: tmpRoot } } },
  });
  const report = res?.report || {};
  assert(report.stoppedReason === "max_rounds", `run hit the round ceiling as expected (got ${report.stoppedReason})`);
  // Both ceilings must have been scaled for the 7-step plan (18 -> 48, 600k -> 2M).
  assert(report.longTaskBudget?.planSteps === 7, `budget scaled for the inherited plan (got ${JSON.stringify(report.longTaskBudget)})`);
  assert(report.longTaskBudget?.maxRounds === 48, `48 rounds granted (got ${report.longTaskBudget?.maxRounds})`);
  assert(report.longTaskBudget?.runTokenBudget === LONG_TASK_MAX_TOKEN_BUDGET, `token budget scaled too (got ${report.longTaskBudget?.runTokenBudget})`);
  assert(report.maxRoundsHandoff === true, "a resume handoff was stamped at the round ceiling");
  assert(report.openStepsAtStop === 6, `open steps counted for the handoff (got ${report.openStepsAtStop})`);
  assert(resumed.some((e) => e.type === "run.resume"), "a durable run.resume event was written (survives restart)");
  assert(sessionPlans.get("s1")?.steps?.length === 7, "the session plan is still there for the next run");
  assert(events.some((e) => e.type === "omni_loop.max_rounds_handoff"), "max_rounds handoff event emitted");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("step 3: a plan-less run is untouched (no handoff, no inflation)");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shortrun-"));
  const events = [];
  const runtime = {
    rootDir: tmpRoot,
    getWorkspaceRoot: () => tmpRoot,
    config: { getConfig: () => SHIPPED_DEFAULTS, readUserConfig: () => ({}) },
    gateway: { addEvent(type, payload) { events.push({ type, payload }); }, emitTransient() {} },
    sessions: { listSessions: () => [], getEvidenceLedger: () => null, getSession: () => ({ transcript: [] }), appendSystemEvent() {} },
    memory: { getLongTermMemory: () => [], getNotes: () => [] },
    tools: {
      getAll: () => [{ id: "read_file", description: "r", modelCallable: true, schema: { type: "object", properties: {} } }],
      run: async () => ({ ok: true }),
      getRunPlan: () => null, setRunPlan: () => {}, getSessionPlan: () => null, setSessionPlan: () => {},
      getRunToolsets: () => [], getSessionToolsets: () => [],
    },
    provider: { getInfo: () => ({ id: "recorder", model: "t", ready: true }), completeWithTools: async () => ({ text: "hi", toolCalls: [] }) },
    files: { rootDir: tmpRoot },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "hello", intents: [], agent: { id: "main" }, profile: { allowToolExecution: true },
    session: { id: "s2" }, run: { id: "r2" }, tools: runtime.tools.getAll(), contextBundle: {},
  });
  assert(res?.report?.maxRoundsHandoff === undefined, "no plan -> no handoff stamped");
  assert(!events.some((e) => e.type === "omni_loop.max_rounds_handoff"), "no handoff event for a plan-less run");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("step 4: REGRESSION - plan only exists in the transcript (server was restarted)");
{
  // The live shape that defeated the first attempt: the session plan Map is
  // empty after a restart, so the plan materialises ONLY through the
  // transcript-resume fallback inside the inherit step. If the budget is
  // computed before that, planSteps is 0 and the run still dies at
  // `budget-exhausted` on the 600k default (live run_1790496116646_vr8ul5).
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-plan-"));
  const runPlans = new Map();
  const events = [];
  const transcript = [{
    type: "event",
    event: "run.resume",
    at: "2026-09-27T06:50:00.000Z",
    payload: {
      runId: "earlier-run",
      steps: Array.from({ length: 7 }, (_, i) => ({ title: `step ${i + 1}`, status: i === 0 ? "completed" : "pending" })),
    },
  }];
  const runtime = {
    rootDir: tmpRoot,
    getWorkspaceRoot: () => tmpRoot,
    config: { getConfig: () => SHIPPED_DEFAULTS, readUserConfig: () => ({}) },
    gateway: { addEvent(type, payload) { events.push({ type, payload }); }, emitTransient() {} },
    sessions: {
      listSessions: () => [],
      getEvidenceLedger: () => null,
      getSession: () => ({ transcript }),
      appendSystemEvent() {},
    },
    memory: { getLongTermMemory: () => [], getNotes: () => [] },
    tools: {
      getAll: () => [{ id: "read_file", description: "r", modelCallable: true, schema: { type: "object", properties: {} } }],
      run: async () => ({ ok: true }),
      getRunPlan: (id) => runPlans.get(id) || null,
      setRunPlan: (id, plan) => runPlans.set(id, plan),
      getSessionPlan: () => null,
      setSessionPlan: () => {},
      getRunToolsets: () => [], getSessionToolsets: () => [],
    },
    provider: {
      getInfo: () => ({ id: "recorder", model: "t", ready: true }),
      completeWithTools: async () => {
        runtime.provider.n += 1;
        return { text: "", toolCalls: [{ id: `x${runtime.provider.n}`, tool: "read_file", input: { path: `g${runtime.provider.n}.txt` } }] };
      },
      n: 0,
    },
    files: { rootDir: tmpRoot },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "continue", intents: [], agent: { id: "main" }, profile: { allowToolExecution: true },
    session: { id: "s9" }, run: { id: "r9" }, tools: runtime.tools.getAll(), contextBundle: {},
  });
  const report = res?.report || {};
  assert(report.planInherited === 6, `the 7-step plan was inherited from the transcript (got ${report.planInherited})`);
  assert(report.longTaskBudget?.planSteps === 7, `budget scaling SAW the inherited plan (got ${JSON.stringify(report.longTaskBudget)})`);
  assert(report.longTaskBudget?.runTokenBudget === LONG_TASK_MAX_TOKEN_BUDGET, `token budget scaled from the transcript plan (got ${report.longTaskBudget?.runTokenBudget})`);
  assert(report.longTaskBudget?.maxRounds === 48, `rounds scaled too (got ${report.longTaskBudget?.maxRounds})`);
  assert(events.some((e) => e.type === "omni_loop.long_task_budget"), "long_task_budget event emitted");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("step 5: an explicit USER override still wins over the scaling");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "userpin-"));
  const events = [];
  const runPlans = new Map();
  // The user deliberately pinned a 25-round budget in data/config.json.
  const userConfig = { runtime: { omniLoop: { maxRounds: 25, runTokenBudget: 700000 } } };
  const runtime = {
    rootDir: tmpRoot,
    getWorkspaceRoot: () => tmpRoot,
    config: {
      getConfig: () => mergedConfig(userConfig),
      readUserConfig: () => userConfig,
    },
    gateway: { addEvent(type, payload) { events.push({ type, payload }); }, emitTransient() {} },
    sessions: { listSessions: () => [], getEvidenceLedger: () => null, getSession: () => ({ transcript: [] }), appendSystemEvent() {} },
    memory: { getLongTermMemory: () => [], getNotes: () => [] },
    tools: {
      getAll: () => [{ id: "read_file", description: "r", modelCallable: true, schema: { type: "object", properties: {} } }],
      run: async () => ({ ok: true }),
      getRunPlan: (id) => runPlans.get(id) || null,
      setRunPlan: (id, plan) => runPlans.set(id, plan),
      getSessionPlan: () => ({ steps: Array.from({ length: 7 }, () => ({ title: "s", status: "pending" })) }),
      setSessionPlan: () => {},
      getRunToolsets: () => [], getSessionToolsets: () => [],
    },
    provider: {
      getInfo: () => ({ id: "recorder", model: "t", ready: true }),
      completeWithTools: async () => {
        runtime.provider.n += 1;
        return { text: "", toolCalls: [{ id: `y${runtime.provider.n}`, tool: "read_file", input: { path: `h${runtime.provider.n}.txt` } }] };
      },
      n: 0,
    },
    files: { rootDir: tmpRoot },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "continue", intents: [], agent: { id: "main" }, profile: { allowToolExecution: true },
    session: { id: "s5" }, run: { id: "r5" }, tools: runtime.tools.getAll(), contextBundle: {},
  });
  const report = res?.report || {};
  assert(report.longTaskBudget === undefined, "user-pinned maxRounds disables the scaling entirely");
  assert(!events.some((e) => e.type === "omni_loop.long_task_budget"), "no scaling event when the user pinned a value");
  assert(report.rounds === 25, `the user's own 25-round ceiling is the one that applies (got ${report.rounds})`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(failures ? `\nlong-task-durability: ${failures} FAILURES` : "\nlong-task-durability: ALL PASS");
process.exit(failures ? 1 : 0);
