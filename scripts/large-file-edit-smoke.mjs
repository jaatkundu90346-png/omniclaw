// Smoke test: editing a file LARGER than the 64KB read preview must work and
// must NOT lose data. This is the exact bug behind the Fleet.jsx edit loop:
// the edit tool read only the first 64KB, so a find-text beyond that never
// matched (endless edit failures) and a match would write truncated content back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-bigedit-"));
for (const dir of ["config", "workspace"]) {
  const src = path.join(repoRoot, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(rootDir, dir), { recursive: true, force: true });
}

const agent = new OmniClawAgent({ rootDir });
const ctx = { agentId: "main", sessionId: "bigedit", runId: "bigedit" };
const run = (tool, input) => agent.tools.run(tool, input, ctx);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

try {
  // Build a ~120KB file: filler well past 64KB, then a UNIQUE marker near the END
  // (beyond the old 64KB cap), then a tail after it.
  const rel = "airforce-website/src/components/Fleet.jsx";
  const filler = "// line of code padding to push the file past the 64KB read cap\n".repeat(2000); // ~120KB
  const marker = "const FLEET = 'ORIGINAL_FLEET_VALUE_DEEP_IN_FILE';\n";
  const tail = "export default Fleet;\n// trailing content that must survive the edit\n";
  const original = filler + marker + tail;
  ok(Buffer.byteLength(original) > 64 * 1024, `test file is >64KB (${Buffer.byteLength(original)} bytes)`);
  await run("write_file", { path: rel, content: original });

  // Edit a find-text that lives BEYOND the first 64KB.
  const editRes = await run("edit", { path: rel, find: "ORIGINAL_FLEET_VALUE_DEEP_IN_FILE", replace: "PATCHED_FLEET_VALUE" });
  ok(editRes.edited === true && !editRes.error, `edit beyond 64KB succeeds: ${JSON.stringify({ edited: editRes.edited, error: editRes.error, msg: editRes.message }).slice(0, 160)}`);

  // Verify on disk: replacement applied AND the whole file preserved (no data loss).
  const after = fs.readFileSync(path.join(rootDir, rel), "utf8");
  ok(after.includes("PATCHED_FLEET_VALUE"), "replacement is present on disk");
  ok(!after.includes("ORIGINAL_FLEET_VALUE_DEEP_IN_FILE"), "original marker is gone");
  ok(after.includes("trailing content that must survive the edit"), "tail AFTER the edit point survived (no truncation/data loss)");
  ok(after.startsWith("// line of code padding"), "head of the file intact");
  ok(Buffer.byteLength(after) > 64 * 1024, `edited file is still full size (${Buffer.byteLength(after)} bytes), not truncated to 64KB`);

  // multi_edit on a >64KB file works too.
  const me = await run("multi_edit", { path: rel, edits: [{ find: "PATCHED_FLEET_VALUE", replace: "FINAL_FLEET_VALUE" }] });
  ok(me.edited === true && !me.error, "multi_edit beyond 64KB succeeds");
  const after2 = fs.readFileSync(path.join(rootDir, rel), "utf8");
  ok(after2.includes("FINAL_FLEET_VALUE") && after2.includes("trailing content that must survive"), "multi_edit preserved the full file");
} finally {
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
