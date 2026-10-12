// Smoke test: session-summary quality gate (iteration 14).
// Bug: a hiccuping compaction model (empty/refusal/tiny response, no throw)
// overwrote the accumulated good summary with garbage — silently wiping the
// session continuity the next resume depends on. Fix: reject empty/too-short/
// label-less summaries and keep the last good one.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { SummarizationEngine } = await import(pathToFileURL(path.join(ROOT, "src/core/summarization-engine.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const GOOD = "GOAL: ship OmniClaw improvements\nDONE: fixed memory dimension guard in src/core/semantic-memory.js\nSTATE: all smokes green\nNEXT: rebuild and deploy";
const GOOD2 = "GOAL: continue the loop\nDONE: added summary quality gate\nSTATE: verified\nNEXT: schedule iteration 15";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-sum-"));
const events = [];
const gateway = { addEvent: (type, data) => events.push({ type, data }) };
const configStore = { getConfig: () => ({ provider: {} }) };
const queue = [];
const provider = { complete: async () => ({ text: queue.shift() }) };
const engine = new SummarizationEngine(tmp, provider, gateway, configStore);

const messages = (n) => Array.from({ length: n }, (_, i) => ({ type: "message", role: i % 2 ? "assistant" : "user", text: `msg ${i}` }));
const session = { id: "sess-1" };
const readText = () => { const s = engine.readSummary("sess-1"); return s ? s.text : null; };

// ── 1. First good structured summary is written ─────────────────────────────
queue.push(GOOD);
await engine.summarizeSession(session, messages(5));
check("good summary written", readText() === GOOD, JSON.stringify(readText()));

// ── 2. Empty response does NOT overwrite the good summary ───────────────────
queue.push("");
const r2 = await engine.summarizeSession(session, messages(10));
check("empty response kept existing (returned)", r2 && r2.text === GOOD, JSON.stringify(r2 && r2.text));
check("empty response did NOT overwrite the file", readText() === GOOD, JSON.stringify(readText()));
check("rejection event emitted", events.some((e) => e.type === "session.summarization_rejected"), JSON.stringify(events.map((e) => e.type)));

// ── 3. Tiny / label-less response does NOT overwrite ────────────────────────
queue.push("ok done, looks fine");
await engine.summarizeSession(session, messages(14));
check("label-less response did NOT overwrite", readText() === GOOD, JSON.stringify(readText()));

// ── 4. A new GOOD structured summary DOES overwrite ─────────────────────────
queue.push(GOOD2);
await engine.summarizeSession(session, messages(18));
check("new good summary replaces old", readText() === GOOD2, JSON.stringify(readText()));

// ── 5. First-ever summary with a bad response writes nothing (returns null) ─
queue.push("");
const fresh = await engine.summarizeSession({ id: "sess-2" }, messages(5));
check("bad first summary returns null, no file", fresh === null && engine.readSummary("sess-2") === null, JSON.stringify(fresh));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
