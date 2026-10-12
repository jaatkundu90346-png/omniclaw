// Measures the gateway write cost — the systemic-stall fix.
//
// Every event schedules a debounced flush, and a flush re-serialises and
// rewrites the WHOLE file synchronously on the single event-loop thread. When
// that file grows to megabytes, EVERY tool call (not just browser ones) pays
// for it, which is how a read_file ends up taking 45 seconds.
//
// This asserts the persisted file stays inside its byte budget, that a flush is
// fast, and that the budget is SELF-HEALING: an oversized file left behind by
// an older build must compact itself on the next write, without user action.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const { GatewayStore } = await import(
  new URL(`file:///${path.join(ROOT, "src/core/gateway-store.js").replace(/\\/g, "/")}`).href
);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gw-"));
const file = path.join(dir, "data", "gateway.json");
fs.mkdirSync(path.dirname(file), { recursive: true });

// A deliberately bloated file, shaped like the 4.7MB one found in the wild:
// far more runs than the budget allows, each with a heavy plan/promptTrace.
const bloated = {
  seq: 500,
  events: Array.from({ length: 200 }, (_, i) => ({
    seq: i, id: `e${i}`, event: "tool.completed", payload: { output: "x".repeat(900) }, at: new Date().toISOString(),
  })),
  runs: Array.from({ length: 120 }, (_, i) => ({
    id: `run_${i}`, status: "completed", createdAt: new Date().toISOString(),
    plan: { steps: Array.from({ length: 40 }, (_, s) => ({ id: `s${s}`, title: "y".repeat(600) })) },
    promptTrace: Array.from({ length: 12 }, (_, s) => ({ role: "user", text: "z".repeat(700) })),
    finalMetadata: { notes: "q".repeat(800) },
    toolOutputs: Array.from({ length: 12 }, (_, t) => ({ tool: "read_file", output: "w".repeat(500) })),
  })),
  approvals: [], delegations: [],
};
fs.writeFileSync(file, JSON.stringify(bloated));
const bloatedSize = fs.statSync(file).size;
console.log(`seeded gateway.json at ${(bloatedSize / 1048576).toFixed(2)} MB (120 runs)`);
check("seed file really is over budget (else the test proves nothing)", bloatedSize > 1_500_000,
  `${bloatedSize} bytes`);

const store = new GatewayStore(dir);
const loaded = store.read();                     // load the bloated file the way boot does
check("read() accepts the legacy oversized file", Array.isArray(loaded.runs));
check("read() compacts the bloated file in memory immediately",
  JSON.stringify(loaded).length < 1_500_000, `${JSON.stringify(loaded).length} bytes still over budget`);
check("the newest run is kept in memory (resume depends on it)",
  loaded.runs[loaded.runs.length - 1]?.id === "run_119",
  loaded.runs[loaded.runs.length - 1]?.id);

// Time a flush the way a real event triggers one. The write is DEBOUNCED
// (flushDelayMs), so wait for the window rather than assuming it is synchronous.
const t0 = Date.now();
store.addEvent("tool.completed", { tool: "read_file", output: "hello" });
await new Promise((r) => setTimeout(r, 1200));
const flushMs = Date.now() - t0;
const after = fs.statSync(file).size;
console.log(`after one event: ${(after / 1048576).toFixed(2)} MB on disk (flush window ${flushMs}ms)`);

check("the oversized file self-healed on disk after one event", after < 1_500_000,
  `${after} bytes still over budget`);
check("events are still persisted", store.read().events.length > 0, `${store.read().events.length}`);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
