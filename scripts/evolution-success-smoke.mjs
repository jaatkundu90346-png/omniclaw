// Smoke test: self-evolution + playbook success definition (iteration 9).
// Bug: success counted ONLY stoppedReason "model-final-ready", so every
// reasoning-model run ("model-final-from-reasoning") was mis-counted as a
// FAILURE — corrupting the evolution success metric AND playbook reinforcement.
// Fix: shared SUCCESS_STOP_REASONS covers both clean-completion reasons.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { HarnessEvolution, SUCCESS_STOP_REASONS } =
  await import(pathToFileURL(path.join(ROOT, "src/core/harness-evolution.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

// ── Shared constant covers both clean-completion reasons ────────────────────
check("SUCCESS_STOP_REASONS has model-final-ready", SUCCESS_STOP_REASONS.has("model-final-ready"));
check("SUCCESS_STOP_REASONS has model-final-from-reasoning", SUCCESS_STOP_REASONS.has("model-final-from-reasoning"));
check("failures NOT counted as success", !SUCCESS_STOP_REASONS.has("max_rounds") && !SUCCESS_STOP_REASONS.has("model-empty-final") && !SUCCESS_STOP_REASONS.has("stuck-no-progress"));

// ── recordRun writes success=true for a reasoning-model completion ──────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-evo-"));
const evo = new HarnessEvolution({ rootDir: tmp });

evo.recordRun({ finalReady: true, stoppedReason: "model-final-from-reasoning", rounds: 5, toolCallCount: 6, failedObservationCount: 0 }, { model: "reasoner-x", taskType: "coding" });
evo.recordRun({ finalReady: true, stoppedReason: "model-final-ready", rounds: 4, toolCallCount: 3, failedObservationCount: 0 }, { model: "gpt-x", taskType: "coding" });
evo.recordRun({ finalReady: true, stoppedReason: "max_rounds", rounds: 60, toolCallCount: 40, failedObservationCount: 5 }, { model: "weak-y", taskType: "coding" });

const entries = evo.loadEvidence({});
check("3 evidence runs recorded", entries.length === 3, String(entries.length));
const reasoningEntry = entries.find((e) => e.stoppedReason === "model-final-from-reasoning");
check("reasoning-model run counted as SUCCESS", reasoningEntry?.success === true, JSON.stringify(reasoningEntry));
const readyEntry = entries.find((e) => e.stoppedReason === "model-final-ready");
check("normal completion counted as success", readyEntry?.success === true, JSON.stringify(readyEntry));
const maxRoundsEntry = entries.find((e) => e.stoppedReason === "max_rounds");
check("max_rounds NOT success", maxRoundsEntry?.success === false, JSON.stringify(maxRoundsEntry));

// analyze() success rate reflects the fix: 2 of 3 = 0.667 (was 0.333 pre-fix).
const stats = evo.analyze(entries);
check("success rate = 2/3 (reasoning run no longer lost)", Math.abs(stats.successRate - 2 / 3) < 0.001, String(stats.successRate));

// A run that produced no final answer is never success even with a good reason.
evo.recordRun({ finalReady: false, stoppedReason: "model-final-from-reasoning", failedObservationCount: 0 }, { model: "x" });
const noFinal = evo.loadEvidence({}).slice(-1)[0];
check("no finalReady → not success", noFinal.success === false, JSON.stringify(noFinal));

// Too many failed observations disqualifies even a clean stop reason.
evo.recordRun({ finalReady: true, stoppedReason: "model-final-ready", failedObservationCount: 4 }, { model: "x" });
const manyFails = evo.loadEvidence({}).slice(-1)[0];
check("clean stop but 4 failed obs → not success", manyFails.success === false, JSON.stringify(manyFails));

// ── Source parity: omni-loop's playbook success uses the same set ───────────
const loopSrc = fs.readFileSync(path.join(ROOT, "src/core/omni-loop.js"), "utf8");
check("omni-loop imports SUCCESS_STOP_REASONS", /import \{[^}]*SUCCESS_STOP_REASONS[^}]*\} from "\.\/harness-evolution\.js"/.test(loopSrc));
check("omni-loop playbook success uses the shared set", /const success = SUCCESS_STOP_REASONS\.has/.test(loopSrc));
check("no lingering strict model-final-ready equality for success", !/success = report\.stoppedReason === "model-final-ready"/.test(loopSrc));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
