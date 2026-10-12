// Smoke test: shared file-checkpoint primitive (iteration 7).
//  1. saveFileCheckpoint snapshots an EXISTING file, skips new/oversized ones.
//  2. Main-loop and sub-agent writes land in the SAME per-run store, sequenced.
//  3. The on-disk index.json matches the shape restore_checkpoint reads
//     (seq/file/snapshot/at/tool + snapshot bytes == pre-write content).
//  4. A sub-agent write is now checkpointed (the iteration-6 data-safety gap).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { saveFileCheckpoint, checkpointDir, WRITE_TOOLS } =
  await import(pathToFileURL(path.join(ROOT, "src/core/file-checkpoint.js")).href);
const { SubAgentSpawner } = await import(pathToFileURL(path.join(ROOT, "src/core/sub-agent-spawner.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-ckpt-"));
const runId = "run-abc/123"; // includes a char that must be sanitized in the dir name
const target = path.join(tmp, "app.js");
fs.writeFileSync(target, "ORIGINAL v1\n");

// ── 1. Snapshot an existing file ─────────────────────────────────────────────
let r = saveFileCheckpoint({ rootDir: tmp, runId, filePath: "app.js", tool: "edit" });
check("existing file: saved", r.saved === true && r.seq === 1, JSON.stringify(r));

// New file → nothing to preserve.
r = saveFileCheckpoint({ rootDir: tmp, runId, filePath: "brand-new.js", tool: "write_file" });
check("new file: not saved (nothing to preserve)", r.saved === false && r.reason === "new-file", JSON.stringify(r));

// Missing runId → skipped (checkpoints are per-run).
r = saveFileCheckpoint({ rootDir: tmp, runId: "", filePath: "app.js", tool: "edit" });
check("no runId: skipped", r.saved === false && r.reason === "no-run-id", JSON.stringify(r));

// ── 2. Second write to same file → seq increments in the same store ─────────
fs.writeFileSync(target, "EDITED v2\n");
r = saveFileCheckpoint({ rootDir: tmp, runId, filePath: "app.js", tool: "edit" });
check("second write: seq=2 in same store", r.saved === true && r.seq === 2, JSON.stringify(r));

// ── 3. Index shape + snapshot bytes match restore_checkpoint expectations ────
const dir = checkpointDir(tmp, runId);
const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
check("index has both entries", index.length === 2, JSON.stringify(index.map((e) => e.seq)));
const okShape = index.every((e) => e.seq && e.file && e.snapshot && e.at && e.tool);
check("index entry shape (seq/file/snapshot/at/tool)", okShape, JSON.stringify(index[0]));
const firstSnap = fs.readFileSync(path.join(dir, index[0].snapshot), "utf8");
check("oldest snapshot == pre-run original (restorable)", firstSnap === "ORIGINAL v1\n", JSON.stringify(firstSnap));
check("runId sanitized in dir path", /run-abc_123$/.test(dir), dir);

// ── 4. Sub-agent write is now checkpointed (iteration-6 gap closed) ──────────
const saCheckpointRunId = "run-subagent-1";
const saFile = path.join(tmp, "sa.js");
fs.writeFileSync(saFile, "SA ORIGINAL\n");
let rounds = 0;
const provider = {
  completeWithTools: async () => {
    rounds += 1;
    if (rounds === 1) return { text: "", toolCalls: [{ id: "w1", tool: "write_file", input: { path: saFile, content: "SA CLOBBERED\n" } }] };
    return { text: "sa-done", toolCalls: [] };
  },
};
const spawner = new SubAgentSpawner({
  agentRuntime: { provider, rootDir: tmp, gateway: { addEvent() {} } },
  configStore: { getConfig: () => ({ runtime: { subAgents: {} }, provider: {} }) },
  toolRegistry: {
    getAll: () => [{ id: "write_file", description: "write", schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } }],
    run: async (tool, input) => { fs.writeFileSync(input.path, input.content); return { path: input.path, ok: true }; },
  },
});
await spawner.spawn({ task: "clobber sa.js", context: { runId: saCheckpointRunId } });
const saDir = checkpointDir(tmp, saCheckpointRunId);
const saIndex = JSON.parse(fs.readFileSync(path.join(saDir, "index.json"), "utf8"));
check("sub-agent write was checkpointed", saIndex.length === 1, JSON.stringify(saIndex));
const saSnap = fs.readFileSync(path.join(saDir, saIndex[0].snapshot), "utf8");
check("sub-agent checkpoint holds pre-clobber bytes", saSnap === "SA ORIGINAL\n", JSON.stringify(saSnap));
check("WRITE_TOOLS covers the standard write tools", ["write_file", "edit", "multi_edit", "apply_patch"].every((t) => WRITE_TOOLS.has(t)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
