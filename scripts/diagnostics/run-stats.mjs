// run-stats.mjs — READ-ONLY diagnostic. Reads data/gateway.json,
// data/sessions.json and data/sessions/transcripts/*.jsonl. Never writes to
// data/. Writes JSON + markdown tables to docs/diagnostics/ and prints text
// tables to stdout.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "docs", "diagnostics");
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const q = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const gateway = readJson(path.join(ROOT, "data", "gateway.json"));
const runs = (gateway.runs || []).slice(-50);
console.log(`runs analyzed: ${runs.length} of ${(gateway.runs || []).length} stored`);

// runId -> transcript modelToolLoop report + toolOutputs (transcripts embed them
// on assistant entries; gateway run records do NOT carry modelToolLoop).
const reports = new Map(); // runId -> {report, toolOutputs[]}
for (const r of runs) {
  const tpath = path.join(ROOT, "data", "sessions", "transcripts", `${r.sessionId}.jsonl`);
  if (!fs.existsSync(tpath)) continue;
  for (const line of fs.readFileSync(tpath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.runId !== r.id) continue;
    if (e.modelToolLoop && Object.keys(e.modelToolLoop).length) {
      reports.set(r.id, {
        report: e.modelToolLoop,
        toolOutputs: Array.isArray(e.toolOutputs) ? e.toolOutputs : [],
      });
    }
  }
  // also merge run-record toolOutputs (same shape: {tool,input,outputStatus,output})
  if (Array.isArray(r.toolOutputs) && r.toolOutputs.length && !reports.has(r.id)) {
    reports.set(r.id, { report: null, toolOutputs: r.toolOutputs });
  }
}
console.log(`runs with transcript/embedded report: ${reports.size}`);

// 1. stoppedReason distribution (gateway finalMetadata is authoritative)
const stopDist = {};
for (const r of runs) {
  const sr = (r.finalMetadata && r.finalMetadata.stopReason) || "NONE";
  stopDist[sr] = (stopDist[sr] || 0) + 1;
}
// 2. rounds / tool calls / failed
const rounds = [], tcalls = [], failed = [];
for (const r of runs) {
  const rep = reports.get(r.id);
  rounds.push(Number(rep?.report?.rounds ?? r.finalMetadata?.stepCount ?? 0) || 0);
  tcalls.push(Number(r.finalMetadata?.toolCallCount ?? rep?.toolOutputs?.length ?? 0) || 0);
  failed.push(Number(r.finalMetadata?.failedToolCount ?? 0) || 0);
}
// 3. failing tools + messages
const failByTool = new Map(); // tool -> {count, msgs: Map}
const isFail = (t) => {
  const st = t.outputStatus || {};
  const out = t.output || {};
  return Boolean(st.error ?? out.error ?? st.blocked ?? out.blocked ?? out.ok === false);
};
for (const r of runs) {
  const lists = [];
  const rep = reports.get(r.id);
  if (rep?.toolOutputs?.length) lists.push(rep.toolOutputs);
  else if (Array.isArray(r.toolOutputs)) lists.push(r.toolOutputs);
  for (const list of lists) {
    for (const t of list) {
      if (!isFail(t)) continue;
      const tool = String(t.tool || "?");
      const o = t.output;
      const raw = typeof o === "string" ? o : (o?.message || o?.reason || o?.error || t.outputStatus?.error || t.outputStatus?.reason || "");
      const msg = String(raw).slice(0, 160).replace(/\s+/g, " ");
      if (!failByTool.has(tool)) failByTool.set(tool, { count: 0, msgs: new Map() });
      const e = failByTool.get(tool);
      e.count += 1;
      e.msgs.set(msg, (e.msgs.get(msg) || 0) + 1);
    }
  }
}
// 4. compaction stages + next-2-rounds outcome
let compactRuns = 0, summaryRuns = 0, digestRuns = 0, overflowRuns = 0;
const compactFollowups = [];
for (const [, v] of reports) {
  const m = v.report;
  if (!m) continue;
  if ((m.transcriptCompactions || 0) > 0) compactRuns++;
  if ((m.transcriptSummaries || 0) > 0) summaryRuns++;
  if ((m.digestRounds || 0) > 0) digestRuns++;
  if ((m.contextOverflowRecoveries || 0) > 0) overflowRuns++;
  const details = Array.isArray(m.roundDetails) ? m.roundDetails : [];
  details.forEach((d, i) => {
    if (!/compact| summar|summar|digest|overflow|auto_compact/i.test(d.status || "")) return;
    const next = details.slice(i + 1, i + 3).map((x) => x.status).join(" | ");
    compactFollowups.push({ round: d.round, status: d.status, next });
  });
}
// 5. finish calls
let finishRuns = 0, finishCalls = 0;
for (const [, v] of reports) {
  const fs_ = (v.toolOutputs || []).filter(
    (t) => t.tool === "finish" && t.output && t.output.finished === true,
  );
  if (fs_.length) { finishRuns++; finishCalls += fs_.length; }
}
// 6. nudges by type
const NUDGE_FIELDS = ["spinNudges", "diagnoseNudges", "actionNudges", "verificationNudges",
  "reverifyNudges", "actNowNudges", "observationNudges", "buildVerifyNudges",
  "degenerateNudges", "regressionNudges", "budgetWarned", "lengthCutBlocks",
  "reasoningLengthCuts", "readBeforeEditBlocks", "staleFileBlocks", "editStrategySwitches"];
const nudgeTotals = {};
for (const f of NUDGE_FIELDS) nudgeTotals[f] = 0;
let nudgeRuns = 0;
for (const [, v] of reports) {
  const m = v.report;
  if (!m) continue;
  let any = false;
  for (const f of NUDGE_FIELDS) {
    const n = f === "budgetWarned" ? (m.budgetWarned ? 1 : 0) : Number(m[f] || 0);
    nudgeTotals[f] += n;
    if (n > 0) any = true;
  }
  if (any) nudgeRuns++;
}
// provider/model + recovery + reasoning aggregates
const provDist = {};
let recovered = 0, argRepairs = 0, reasonTotal = 0, reasonRuns = 0;
for (const r of runs) {
  const key = `${r.finalMetadata?.providerId || "?"}:${r.finalMetadata?.model || "?"}`;
  provDist[key] = (provDist[key] || 0) + 1;
  const m = reports.get(r.id)?.report;
  if (!m) continue;
  recovered += Number(m.recoveredToolCalls || 0);
  argRepairs += Number(m.toolArgRepairs || 0);
  if (Number(m.reasoningTokensTotal || 0) > 0) { reasonTotal += m.reasoningTokensTotal; reasonRuns++; }
}

const pct = (n) => `${n} (${Math.round((n / runs.length) * 100)}%)`;
let out = "";
out += `# run stats (last ${runs.length} runs)\n\n`;
out += `## stoppedReason\n${Object.entries(stopDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${pct(v)}`).join("\n")}\n\n`;
out += `## rounds/toolcalls/failed (median/p90/avg)\n- rounds: ${q(rounds, 0.5)}/${q(rounds, 0.9)}/${avg(rounds).toFixed(1)}\n- toolCalls: ${qcalls()}\n- failed: ${q(failed, 0.5)}/${q(failed, 0.9)}/${avg(failed).toFixed(1)}\n\n`;
function qcalls() { return `${q(tcalls, 0.5)}/${q(tcalls, 0.9)}/${avg(tcalls).toFixed(1)}`; }
out += `## top failing tools\n${[...failByTool.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15).map(([t, e]) => {
  const top = [...e.msgs.entries()].sort((a, b) => b[1] - a[1])[0];
  return `- ${t}: ${e.count} (${top ? `"${top[0].slice(0, 120)}" x${top[1]}` : "no message"})`;
}).join("\n") || "- (none)"}\n\n`;
out += `## compaction\n- runs w/ truncate-compaction: ${compactRuns}\n- runs w/ LLM summary: ${summaryRuns}\n- runs w/ digest: ${digestRuns}\n- runs w/ overflow-recovery: ${overflowRuns}\n- followups (round,status -> next 2):\n${compactFollowups.slice(0, 20).map((f) => `  - r${f.round} ${f.status} -> ${f.next || "(run end)"}`).join("\n") || "  - (none)"}\n\n`;
out += `## finish\n- runs ending via real finish call: ${finishRuns} (calls: ${finishCalls})\n- finish-tool stopReasons in gateway: ${(stopDist["finish-tool"] || 0)}\n\n`;
out += `## nudges (totals across ${reports.size} embedded reports; ${nudgeRuns} runs nudged)\n${Object.entries(nudgeTotals).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n`;
out += `## providers/models\n${Object.entries(provDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n`;
out += `## recovery/reasoning\n- text-mode recovered tool calls: ${recovered}\n- tool-arg repairs: ${argRepairs}\n- runs w/ reasoning tokens: ${reasonRuns}, total reasoning tokens: ${reasonTotal}\n`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "run-stats.md"), out);
fs.writeFileSync(path.join(OUT, "run-stats.json"), JSON.stringify({
  runs: runs.length, stopDist,
  rounds: { med: q(rounds, 0.5), p90: q(rounds, 0.9), avg: Number(avg(rounds).toFixed(2)) },
  toolCalls: { med: q(tcalls, 0.5), p90: q(tcalls, 0.9), avg: Number(avg(tcalls).toFixed(2)) },
  failed: { med: q(failed, 0.5), p90: q(failed, 0.9), avg: Number(avg(failed).toFixed(2)) },
  failingTools: [...failByTool.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15)
    .map(([tool, e]) => ({ tool, count: e.count, topMessages: [...e.msgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) })),
  compaction: { compactRuns, summaryRuns, digestRuns, overflowRuns, followups: compactFollowups.slice(0, 20) },
  finish: { finishRuns, finishCalls },
  nudges: nudgeTotals, nudgeRuns,
  providers: provDist, recovered, argRepairs, reasonRuns, reasonTotal,
}, null, 2));
console.log(out);
