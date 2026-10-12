// Smoke test: heartbeat due-task clock (iteration 15).
// Bug: evaluateHeartbeatPrompt marked a task "run" at DUE-EVALUATION time, but
// executeDueTasks only runs the first 3 due tasks per tick and drops the whole
// batch when a prior run is in flight — so over-cap / dropped tasks were marked
// run yet never executed, silently skipped for a full interval. Fix: advance
// the clock in executeDueTasks, per task, only when actually consumed.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { Heartbeat } = await import(pathToFileURL(path.join(ROOT, "src/core/heartbeat.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

// HEARTBEAT.md with 5 named tasks (> the per-tick cap of 3).
const md = ["t1", "t2", "t3", "t4", "t5"]
  .map((n) => `- name: ${n}\n  interval: 30m\n  prompt: check ${n}`)
  .join("\n");

let handleCalls = [];
const makeAgent = () => ({
  config: { getConfig: () => ({ runtime: { heartbeat: {} } }) },
  loadWorkspaceContext: () => ({ files: [{ name: "HEARTBEAT.md", scope: "agent", content: md }] }),
  gateway: { addEvent() {} },
  handleMessage: async (msg, opts) => { handleCalls.push(opts?.label || "hb"); return { reply: "HEARTBEAT_OK" }; },
});

const hb = new Heartbeat({ agent: makeAgent(), intervalMs: 1800000 });

// ── 1. evaluate returns all 5 due WITHOUT marking any as run ────────────────
const now = Date.now();
const ev = hb.evaluateHeartbeatPrompt(now);
check("evaluate finds 5 due tasks", ev?.result?.dueTasks?.length === 5, JSON.stringify(ev?.result?.dueTasks?.map((t) => t.name)));
check("evaluate did NOT mark any task run (fix)", hb.taskRuns.size === 0, `taskRuns.size=${hb.taskRuns.size}`);

// ── 2. execute runs only first 3, marks only those 3 ────────────────────────
handleCalls = [];
await hb.executeDueTasks(ev.result.dueTasks, {});
check("only 3 tasks executed (per-tick cap)", handleCalls.length === 3, `calls=${handleCalls.length}`);
check("only 3 tasks marked run", hb.taskRuns.size === 3, `taskRuns.size=${hb.taskRuns.size}`);
check("t4 + t5 NOT marked (stay due)", !hb.taskRuns.has("t4") && !hb.taskRuns.has("t5"), JSON.stringify([...hb.taskRuns.keys()]));

// ── 3. Remaining tasks are still due next tick and get executed ─────────────
const ev2 = hb.evaluateHeartbeatPrompt(Date.now());
const dueNames = ev2.result.dueTasks.map((t) => t.name).sort();
check("next tick: t4 + t5 still due (not lost)", JSON.stringify(dueNames) === JSON.stringify(["t4", "t5"]), JSON.stringify(dueNames));
handleCalls = [];
await hb.executeDueTasks(ev2.result.dueTasks, {});
check("remaining 2 tasks now execute", handleCalls.length === 2, `calls=${handleCalls.length}`);
check("all 5 tasks eventually marked run", hb.taskRuns.size === 5, `taskRuns.size=${hb.taskRuns.size}`);

// ── 4. taskRunning guard: in-flight run drops the batch, marks nothing ──────
const hb2 = new Heartbeat({ agent: makeAgent(), intervalMs: 1800000 });
hb2.taskRunning = true; // simulate a prior heartbeat run still going
const ev3 = hb2.evaluateHeartbeatPrompt(Date.now());
handleCalls = [];
await hb2.executeDueTasks(ev3.result.dueTasks, {});
check("in-flight run executes nothing", handleCalls.length === 0, `calls=${handleCalls.length}`);
check("in-flight run marks nothing (tasks stay due)", hb2.taskRuns.size === 0, `taskRuns.size=${hb2.taskRuns.size}`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
