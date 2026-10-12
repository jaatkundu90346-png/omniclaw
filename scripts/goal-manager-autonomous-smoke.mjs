// Smoke test: GoalManager autonomous-execution correctness (iteration 20).
// Three real bugs on the autonomous (24h) path:
//  1. Missing addGoals() — daemon mode called it; it did not exist (crash).
//  2. Sub-goals never registered in goalHistory, so completeGoal/failGoal were
//     silent no-ops → getNextSubGoal returned the SAME sub-goal forever.
//  3. Date.now()-based ids collided when a goal matched multiple heuristics.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { GoalManager } = await import(pathToFileURL(path.join(ROOT, "src/core/goal-manager.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

// No provider → heuristic decomposition path.
const gm = new GoalManager({ provider: null, semanticMemory: null });

// ── 3. Multi-pattern goal → unique sub-goal ids (no collision) ──────────────
const root = gm.createRootGoal("research and build a tool");
const subGoals = await gm.decomposeGoal(root, {});
root.subGoals = subGoals; // mirror what autonomous-runtime does
check("multi-pattern goal produced sub-goals", subGoals.length >= 4, String(subGoals.length));
const ids = subGoals.map((g) => g.id);
check("all sub-goal ids unique (no Date.now collision)", new Set(ids).size === ids.length, JSON.stringify(ids));
check("root id distinct from sub-goal ids", !ids.includes(root.id), root.id);

// ── 2. completeGoal actually advances the loop ──────────────────────────────
const first = gm.getNextSubGoal();
check("getNextSubGoal returns a pending sub-goal", Boolean(first) && first.status === "pending", JSON.stringify(first && first.id));
gm.completeGoal(first.id, { ok: true });
check("completeGoal marked THAT sub-goal completed", first.status === "completed", first.status);
const second = gm.getNextSubGoal();
check("getNextSubGoal now returns a DIFFERENT sub-goal (loop advances)", Boolean(second) && second.id !== first.id, JSON.stringify(second && second.id));

// Drain the rest to confirm the loop terminates instead of looping forever.
let guard = 0;
let n;
while ((n = gm.getNextSubGoal()) && guard < 20) { gm.completeGoal(n.id, {}); guard += 1; }
check("all sub-goals eventually complete (no infinite same-goal loop)", gm.getNextSubGoal() === null, `remaining, guard=${guard}`);

// failGoal also works on a fresh sub-goal.
const gm2 = new GoalManager({ provider: null, semanticMemory: null });
const r2 = gm2.createRootGoal("build a website");
r2.subGoals = await gm2.decomposeGoal(r2, {});
const sg = gm2.getNextSubGoal();
gm2.failGoal(sg.id, "boom");
check("failGoal marks the sub-goal failed", sg.status === "failed" && sg.failureReason === "boom", JSON.stringify({ s: sg.status, r: sg.failureReason }));

// ── 1. addGoals exists, attaches to current goal, and is pickable ───────────
check("addGoals is a function", typeof gm2.addGoals === "function");
const added = gm2.addGoals([{ title: "new discovered goal", type: "monitor" }]);
check("addGoals returns normalized goals with ids", added.length === 1 && added[0].id && added[0].status === "pending", JSON.stringify(added[0]));
check("added goal attached to current goal's subGoals", r2.subGoals.some((g) => g.id === added[0].id), JSON.stringify(r2.subGoals.map((g) => g.id)));
// After failing sg above, the next pending should be the newly added goal.
const next = gm2.getNextSubGoal();
check("added goal is pickable + completable", Boolean(next) && (gm2.completeGoal(next.id, {}), next.status === "completed"), JSON.stringify(next && next.id));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
