// Smoke test: code_act checkpoint reuse + wall-timer leak (iteration 16).
//  1. saveCheckpointForPath now delegates to the shared file-checkpoint module
//     (no more hand-rolled duplicate) — an in-script write is snapshotted in the
//     SAME per-run store, in the shared index format restore_checkpoint reads.
//  2. runCodeAct clears its wall-clock setTimeout, so a fast-finishing script
//     leaves no timer hanging on the event loop.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const mod = await import(pathToFileURL(path.join(ROOT, "src/core/tool-registry.js")).href);
const ToolRegistry = mod.ToolRegistry || mod.default;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};
check("ToolRegistry export found", typeof ToolRegistry === "function");
if (typeof ToolRegistry !== "function") { console.log("\n1 CHECK(S) FAILED"); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-codeact-"));
fs.writeFileSync(path.join(tmp, "target.txt"), "ORIGINAL v1\n");

// Minimal `this` for the prototype methods: getRootDir + a run() that performs
// write_file (so the checkpoint-before-write sees a real existing file).
const fakeReg = {
  getRootDir: () => tmp,
  saveCheckpointForPath: ToolRegistry.prototype.saveCheckpointForPath,
  run: async (tool, input = {}) => {
    if (tool === "write_file" && input.path) {
      fs.writeFileSync(path.join(tmp, input.path), String(input.content ?? ""));
      return { ok: true, path: input.path };
    }
    return { ok: true };
  },
};

// ── 1. In-script write is checkpointed in the shared format ─────────────────
const timeoutCountFor = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const before = timeoutCountFor();

const script = 'await tools.write_file({ path: "target.txt", content: "EDITED v2\\n" }); return "done";';
const res = await ToolRegistry.prototype.runCodeAct.call(fakeReg, script, 60000, { runId: "run-xyz/1" });
check("code_act ran ok", res && res.ok === true && res.result === "done", JSON.stringify(res).slice(0, 150));
check("code_act made 1 tool call", res.toolCallCount === 1, JSON.stringify(res.toolCallsMade));

const ckptDir = path.join(tmp, "data", "checkpoints", "run-xyz_1"); // runId sanitized by shared module
const indexPath = path.join(ckptDir, "index.json");
check("shared checkpoint index created", fs.existsSync(indexPath), ckptDir);
if (fs.existsSync(indexPath)) {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  check("index has 1 entry with shared shape", index.length === 1 && index[0].seq && index[0].file && index[0].snapshot && index[0].at && index[0].tool, JSON.stringify(index[0]));
  const snap = fs.readFileSync(path.join(ckptDir, index[0].snapshot), "utf8");
  check("snapshot holds PRE-write content (restorable)", snap === "ORIGINAL v1\n", JSON.stringify(snap));
  check("tool tag records the in-script write tool", index[0].tool === "write_file", index[0].tool);
}

// ── 2. Wall-clock timer was cleared (no leak after a fast script) ───────────
// Allow a tick for any microtask settling, then confirm no net-new Timeout.
await new Promise((r) => setImmediate(r));
const after = timeoutCountFor();
check("no leaked wall-clock timer after fast script", after <= before, `before=${before} after=${after}`);

// ── 3. Syntax error path is clean (and also clears its timer) ───────────────
const bad = await ToolRegistry.prototype.runCodeAct.call(fakeReg, "this is (not valid js", 60000, { runId: "run-2" });
check("syntax error returns structured error", bad && bad.error === true && /syntax error/i.test(bad.message), JSON.stringify(bad).slice(0, 120));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
