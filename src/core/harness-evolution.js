/**
 * HarnessEvolution — the self-evolving harness loop (arXiv 2604.25850 pattern).
 *
 * Three pillars, all deterministic (no LLM on any path):
 *  1. EVIDENCE: every omni-loop run appends a compact record (which guards
 *     fired, success, rounds) to data/evolution/evidence.jsonl.
 *  2. PROPOSE: once per day, the highest-frequency failure signal maps to ONE
 *     bounded tunable change, recorded WITH a falsifiable prediction
 *     ("this signal's rate will drop ≥20% without hurting success").
 *  3. VERIFY: after enough post-change runs, the prediction is checked against
 *     reality — the change is KEPT if it held, REVERTED if it didn't.
 *
 * One experiment at a time, hard bounds on every tunable, full history — the
 * harness gets measurably better with use and can never wander off a cliff.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

// A run completed cleanly when the model produced a final answer — either as
// normal content (model-final-ready) OR entirely in the reasoning channel
// (model-final-from-reasoning, routine for reasoning models). BOTH are success.
// Counting only the former systematically marks every reasoning-model run as a
// failure, corrupting the evolution success metric (SUCCESS_GUARDBAND becomes
// noise) AND playbook reinforcement (a real success teaches the "failure"
// lesson). Shared so both subsystems agree on what "success" means.
export const SUCCESS_STOP_REASONS = new Set(["model-final-ready", "model-final-from-reasoning"]);

// Every parameter evolution may touch, with hard bounds and the failure
// signal it remedies. `step` moves toward remediation (usually "react sooner").
const TUNABLES = {
  diagnoseGatherRounds: { default: 2, min: 1, max: 4, signal: "diagnoseNudges", step: -1 },
  spinNudgeThreshold: { default: 4, min: 2, max: 6, signal: "spinNudges", step: -1 },
  editFailSwitchAt: { default: 2, min: 1, max: 4, signal: "editStrategySwitches", step: -1 },
  compactAtPercent: { default: 0.8, min: 0.5, max: 0.9, signal: "contextOverflowRecoveries", step: -0.1 },
};

const MIN_RUNS_TO_PROPOSE = 12; // evidence needed before proposing anything
const MIN_RUNS_TO_CONCLUDE = 15; // post-change runs needed to judge an experiment
const SIGNAL_RATE_FLOOR = 0.2; // only signals firing in ≥20% of runs justify a change
const IMPROVEMENT_FACTOR = 0.8; // kept only if signal rate drops to ≤80% of baseline
const SUCCESS_GUARDBAND = 0.05; // ...and success rate doesn't drop more than 5 points
const EVIDENCE_CAP = 500;

export class HarnessEvolution {
  constructor({ rootDir, gateway = null } = {}) {
    this.rootDir = rootDir || "";
    this.gateway = gateway;
  }

  evidencePath() {
    return path.join(this.rootDir, "data", "evolution", "evidence.jsonl");
  }

  statePath() {
    return path.join(this.rootDir, "data", "evolution", "state.json");
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath(), "utf8"));
    } catch (error) {
      // Missing state.json is the normal first-run case; a CORRUPT one silently
      // reset every learned tunable and the experiment history.
      if (error?.code !== "ENOENT") {
        console.warn("[memory] harness-evolution loadState: state.json unreadable:", error.message);
      }
      return { tunables: {}, activeExperiment: null, history: [], lastCycleAt: null };
    }
  }

  saveState(state) {
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
      // Atomic (temp + rename): a truncated state.json loses the evolution
      // history and the tunables it had already rolled out.
      atomicWriteFileSync(this.statePath(), JSON.stringify(state, null, 2));
    } catch (error) {
      console.warn("[memory] harness-evolution saveState:", error.message);
    }
  }

  // Effective tunable values = defaults overridden by evolution state
  // (including the currently-running experiment's trial value).
  getTunables() {
    const state = this.loadState();
    const out = {};
    for (const [name, spec] of Object.entries(TUNABLES)) {
      const value = state.tunables?.[name];
      out[name] = typeof value === "number" && Number.isFinite(value)
        ? Math.min(spec.max, Math.max(spec.min, value))
        : spec.default;
    }
    return out;
  }

  // ── 1. Evidence ────────────────────────────────────────────────────────────
  recordRun(report = {}, { model = "", taskType = "" } = {}) {
    try {
      if (!this.rootDir) return;
      const entry = {
        at: new Date().toISOString(),
        model: String(model).slice(0, 80),
        taskType: String(taskType || "").slice(0, 40),
        stoppedReason: String(report.stoppedReason || ""),
        rounds: Number(report.rounds || 0),
        toolCalls: Number(report.toolCallCount || 0),
        success: Boolean(
          report.finalReady &&
          SUCCESS_STOP_REASONS.has(String(report.stoppedReason || "")) &&
          Number(report.failedObservationCount || 0) < 3,
        ),
        signals: {
          diagnoseNudges: Number(report.diagnoseNudges || 0),
          reverifyNudges: Number(report.reverifyNudges || 0),
          spinNudges: Number(report.spinNudges || 0),
          actNowNudges: Number(report.actNowNudges || 0),
          verificationNudges: Number(report.verificationNudges || 0),
          editStrategySwitches: Number(report.editStrategySwitches || 0),
          staleFileBlocks: Number(report.staleFileBlocks || 0),
          contextOverflowRecoveries: Number(report.contextOverflowRecoveries || 0),
          lengthCutBlocks: Number(report.lengthCutBlocks || 0),
          reasoningLengthCuts: Number(report.reasoningLengthCuts || 0),
          degenerateNudges: Number(report.degenerateNudges || 0),
        },
      };
      fs.mkdirSync(path.dirname(this.evidencePath()), { recursive: true });
      fs.appendFileSync(this.evidencePath(), `${JSON.stringify(entry)}\n`);
      this.compactEvidenceIfNeeded();
    } catch { /* evidence is best-effort */ }
  }

  compactEvidenceIfNeeded() {
    try {
      const lines = fs.readFileSync(this.evidencePath(), "utf8").split("\n").filter(Boolean);
      if (lines.length > EVIDENCE_CAP * 1.5) {
        fs.writeFileSync(this.evidencePath(), `${lines.slice(-EVIDENCE_CAP).join("\n")}\n`);
      }
    } catch { /* best effort */ }
  }

  loadEvidence({ since = null, limit = EVIDENCE_CAP } = {}) {
    try {
      const lines = fs.readFileSync(this.evidencePath(), "utf8").split("\n").filter(Boolean).slice(-limit);
      const entries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (!since || String(entry.at || "") > since) entries.push(entry);
        } catch { /* skip corrupt line */ }
      }
      return entries;
    } catch {
      return [];
    }
  }

  // ── Analysis ────────────────────────────────────────────────────────────────
  analyze(entries = []) {
    const total = entries.length;
    const stats = { total, successRate: 0, signalRates: {} };
    if (total === 0) return stats;
    stats.successRate = entries.filter((e) => e.success).length / total;
    for (const key of Object.keys(entries[0]?.signals || {})) {
      stats.signalRates[key] = entries.filter((e) => Number(e.signals?.[key] || 0) > 0).length / total;
    }
    // Signals may be missing on old entries; ensure all tunable signals exist.
    for (const spec of Object.values(TUNABLES)) {
      if (!(spec.signal in stats.signalRates)) {
        stats.signalRates[spec.signal] = entries.filter((e) => Number(e.signals?.[spec.signal] || 0) > 0).length / total;
      }
    }
    return stats;
  }

  // ── 2 + 3. The evolution cycle (propose / verify) ───────────────────────────
  // Runs at most once per `cycleMs` (daily by default). Concludes the active
  // experiment when it has enough post-change evidence; otherwise proposes a
  // new one from the strongest failure signal.
  maybeEvolve({ cycleMs = 24 * 60 * 60 * 1000, minRunsToConclude = MIN_RUNS_TO_CONCLUDE, minRunsToPropose = MIN_RUNS_TO_PROPOSE } = {}) {
    try {
      if (!this.rootDir) return { acted: false, reason: "no-root" };
      const state = this.loadState();
      if (state.lastCycleAt && Date.now() - new Date(state.lastCycleAt).getTime() < cycleMs) {
        return { acted: false, reason: "cycle-not-due" };
      }
      state.lastCycleAt = new Date().toISOString();

      if (state.activeExperiment) {
        const result = this.concludeExperiment(state, minRunsToConclude);
        this.saveState(state);
        return result;
      }

      const result = this.proposeExperiment(state, minRunsToPropose);
      this.saveState(state);
      return result;
    } catch (err) {
      return { acted: false, reason: `error: ${String(err?.message || err).slice(0, 200)}` };
    }
  }

  proposeExperiment(state, minRuns = MIN_RUNS_TO_PROPOSE) {
    const entries = this.loadEvidence({ limit: 60 });
    if (entries.length < minRuns) {
      return { acted: false, reason: `not-enough-evidence (${entries.length}/${minRuns})` };
    }
    const stats = this.analyze(entries);
    // Strongest failure signal with headroom on its tunable wins.
    const candidates = Object.entries(TUNABLES)
      .map(([param, spec]) => ({
        param,
        spec,
        rate: stats.signalRates[spec.signal] || 0,
      }))
      .filter((c) => c.rate >= SIGNAL_RATE_FLOOR)
      .sort((a, b) => b.rate - a.rate);
    const current = this.getTunables();
    for (const candidate of candidates) {
      const from = current[candidate.param];
      const to = Math.round((from + candidate.spec.step) * 100) / 100;
      if (to < candidate.spec.min || to > candidate.spec.max) continue; // no headroom
      state.activeExperiment = {
        param: candidate.param,
        signal: candidate.spec.signal,
        from,
        to,
        baselineRate: Math.round(candidate.rate * 1000) / 1000,
        baselineSuccess: Math.round(stats.successRate * 1000) / 1000,
        prediction: `rate of ${candidate.spec.signal} drops to ≤${Math.round(candidate.rate * IMPROVEMENT_FACTOR * 100)}% of runs without hurting success rate`,
        startedAt: new Date().toISOString(),
      };
      state.tunables = { ...(state.tunables || {}), [candidate.param]: to };
      this.gateway?.addEvent?.("evolution.experiment_started", {
        ...state.activeExperiment,
        message: `harness evolution: trying ${candidate.param} ${from}→${to} (${candidate.spec.signal} fires in ${Math.round(candidate.rate * 100)}% of runs)`,
      });
      return { acted: true, action: "proposed", experiment: state.activeExperiment };
    }
    return { acted: false, reason: "no-qualifying-signal" };
  }

  concludeExperiment(state, minRuns = MIN_RUNS_TO_CONCLUDE) {
    const exp = state.activeExperiment;
    const after = this.loadEvidence({ since: exp.startedAt });
    if (after.length < minRuns) {
      return { acted: false, reason: `experiment-still-running (${after.length}/${minRuns} runs)` };
    }
    const stats = this.analyze(after);
    const newRate = stats.signalRates[exp.signal] || 0;
    const kept = newRate <= exp.baselineRate * IMPROVEMENT_FACTOR &&
      stats.successRate >= exp.baselineSuccess - SUCCESS_GUARDBAND;
    if (!kept) {
      // Prediction failed — revert the tunable to its pre-experiment value.
      state.tunables = { ...(state.tunables || {}), [exp.param]: exp.from };
    }
    const record = {
      ...exp,
      concludedAt: new Date().toISOString(),
      runsObserved: after.length,
      observedRate: Math.round(newRate * 1000) / 1000,
      observedSuccess: Math.round(stats.successRate * 1000) / 1000,
      outcome: kept ? "kept" : "reverted",
    };
    state.history = [...(state.history || []), record].slice(-50);
    state.activeExperiment = null;
    this.gateway?.addEvent?.("evolution.experiment_concluded", {
      ...record,
      message: `harness evolution: ${exp.param} ${exp.from}→${exp.to} ${record.outcome} (${exp.signal} ${Math.round(exp.baselineRate * 100)}%→${Math.round(newRate * 100)}%, success ${Math.round(exp.baselineSuccess * 100)}%→${Math.round(stats.successRate * 100)}%)`,
    });
    return { acted: true, action: record.outcome, record };
  }

  status() {
    const state = this.loadState();
    const entries = this.loadEvidence({ limit: 60 });
    return {
      tunables: this.getTunables(),
      activeExperiment: state.activeExperiment || null,
      history: (state.history || []).slice(-10),
      evidenceRuns: entries.length,
      recentStats: this.analyze(entries),
      lastCycleAt: state.lastCycleAt || null,
    };
  }
}
