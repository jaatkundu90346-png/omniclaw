// Phase 3 durability: per-round checkpoint (live 2026-09-27 follow-up to R15/R16).
//
// R16 guarantees every STOP writes a handoff. But a hard kill — OOM, laptop
// sleep, process crash, a force-closed exe — never reaches a stop path, so the
// run's plan dies with the process and the next "continue" restarts blind. The
// fix is to checkpoint WHILE the run is healthy.
//
// Asserts the checkpoint is taken mid-run, throttled by round count AND
// wall-clock, recorded in the session plan (what the next run inherits) and the
// transcript (the restart fallback), and never destructive to PROGRESS.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";

let failures = 0;
let checks = 0;
function check(name, cond) {
  checks += 1;
  if (cond) console.log(`ok: ${name}`);
  else { failures += 1; console.error(`FAIL: ${name}`); }
}

// Only the surface checkpointProgress actually touches.
function makeLoop({ runPlanSteps = [] } = {}) {
  const sessionPlans = new Map();
  const events = [];
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
  fs.writeFileSync(path.join(rootDir, "PROGRESS.md"), "# PROGRESS\n\nunchanged sentinel\n");
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = {
    rootDir,
    tools: {
      getRunPlan: () => ({ steps: runPlanSteps }),
      getSessionPlan: (id) => sessionPlans.get(id) || null,
      setSessionPlan: (id, plan) => sessionPlans.set(id, plan),
    },
    sessions: {
      appendSystemEvent: (sessionId, type, payload) => { events.push({ sessionId, type, payload }); },
    },
  };
  return { loop, sessionPlans, events, rootDir, run: { id: "run_ckpt" }, session: { id: "sess_ckpt" } };
}

const STEPS = [
  { title: "Build App.jsx", status: "completed" },
  { title: "Fix canvas wrapper", status: "pending" },
];

// 1. A checkpoint happens on a qualifying round and lands in session plan + transcript.
{
  const h = makeLoop({ runPlanSteps: STEPS });
  const report = {};
  const done = h.loop.checkpointProgress({
    run: h.run, session: h.session, message: "build the nexus lab",
    toolOutputs: [{ input: { path: "src/App.jsx" } }], report, round: 3,
    settings: { checkpointEveryRounds: 3, checkpointEveryMs: 0 },
  });
  check("checkpoint taken on a qualifying round", done === true);
  const plan = h.sessionPlans.get("sess_ckpt");
  check("session plan written for the next run", Boolean(plan && Array.isArray(plan.steps) && plan.steps.length === 2));
  check("session plan preserves open step", Boolean(plan?.steps?.some((s) => s.status === "pending")));
  check("session plan notes the round", /round 3/.test(String(plan?.note || "")));
  const ev = h.events.find((e) => e.type === "run.resume");
  check("transcript run.resume event appended", Boolean(ev));
  check("resume event marked as a checkpoint", ev?.payload?.checkpoint === true);
  check("resume event carries the round", ev?.payload?.round === 3);
  check("resume event lists files touched", (ev?.payload?.filesTouched || []).includes("src/App.jsx"));

  // 2. Round-count throttle.
  const h2 = makeLoop({ runPlanSteps: STEPS });
  const r2 = {};
  const skipped = h2.loop.checkpointProgress({ run: h2.run, session: h2.session, report: r2, round: 2, settings: { checkpointEveryRounds: 3, checkpointEveryMs: 0 } });
  check("non-qualifying round does not checkpoint", skipped === false);
  check("no session plan written on a skipped round", h2.sessionPlans.size === 0);

  // 3. Wall-clock throttle.
  const h3 = makeLoop({ runPlanSteps: STEPS });
  const r3 = {};
  h3.loop.checkpointProgress({ run: h3.run, session: h3.session, report: r3, round: 3, settings: { checkpointEveryRounds: 3, checkpointEveryMs: 60000 } });
  const tooSoon = h3.loop.checkpointProgress({ run: h3.run, session: h3.session, report: r3, round: 6, settings: { checkpointEveryRounds: 3, checkpointEveryMs: 60000 } });
  check("wall-clock throttle suppresses a rapid second checkpoint", tooSoon === false);
  check("throttled run still wrote exactly one session plan", h3.sessionPlans.size === 1);

  // 4. PROGRESS.md is the human stop-time log — a mid-run checkpoint must not spam it.
  const progress = fs.readFileSync(path.join(h.rootDir, "PROGRESS.md"), "utf8");
  check("PROGRESS.md untouched by checkpoint", /unchanged sentinel/.test(progress) && !/BUDGET HANDOFF/.test(progress));

  // 5. Degenerate inputs must not throw. A run with NO plan of its own is not
  //    checkpointed mid-run (synthesis stays a stop-time concern) — it must
  //    simply no-op without throwing.
  const h4 = makeLoop({ runPlanSteps: [] });
  let threw = false;
  let r4 = null;
  try { r4 = h4.loop.checkpointProgress({ run: h4.run, session: h4.session, report: {}, round: 3, toolOutputs: [{ input: { path: "a.js" } }], settings: { checkpointEveryRounds: 3, checkpointEveryMs: 0 } }); } catch { threw = true; }
  check("plan-less run does not throw", threw === false);
  check("plan-less run writes no session plan", h4.sessionPlans.size === 0);

  const h5 = makeLoop({ runPlanSteps: STEPS });
  let threw2 = false;
  try { h5.loop.checkpointProgress({ run: { id: "" }, session: { id: "" }, report: {}, round: 3, settings: { checkpointEveryRounds: 3, checkpointEveryMs: 0 } }); } catch { threw2 = true; }
  check("missing run/session ids does not throw", threw2 === false);
  check("missing session id writes no plan", h5.sessionPlans.size === 0);

  for (const d of [h.rootDir, h2.rootDir, h3.rootDir, h4.rootDir, h5.rootDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* hygiene */ }
  }
}

console.log(`\nCHECKPOINT DURABILITY: ${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
console.log("CHECKPOINT DURABILITY: PASSED");
