// Smoke test: tool-result persistence (Hermes tool_result_storage parity) —
// when a tool result exceeds the char budget, the FULL output is saved to
// tmp/tool-results/<id>.txt and the truncation note carries the path, so the
// omitted middle is recoverable via read_file/search_text instead of lost.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatToolResultForModel } from "../src/core/omni-loop.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-result-persist-"));
const persistDir = path.join(tmpDir, "tool-results");

try {
  // Big result WITH persist ctx -> file written, path in the note.
  const bigLine = "needle-in-the-middle ".repeat(3);
  const big = `HEAD-${"a".repeat(6000)}\n${bigLine}\n${"z".repeat(6000)}-TAIL`;
  let out = formatToolResultForModel(big, 2000, "exec", { dir: persistDir, id: "run1-r2-call_abc" });
  ok(out.length < big.length, "big result was truncated");
  ok(out.includes("Full output saved to:"), "truncation note mentions the saved file");
  const savedPath = path.join(persistDir, "run1-r2-call_abc.txt");
  ok(fs.existsSync(savedPath), "full output file exists on disk");
  ok(fs.readFileSync(savedPath, "utf8") === big, "saved file holds the COMPLETE untruncated output");
  ok(out.includes(savedPath.replace(/\\/g, "/")), "note carries the forward-slash path the model can read_file");
  ok(out.includes("HEAD-") && out.includes("-TAIL"), "head and tail still shown inline");

  // Small result -> untouched, no file created.
  out = formatToolResultForModel("small result", 2000, "exec", { dir: persistDir, id: "run1-r2-call_small" });
  ok(out === "small result", "small result passes through unchanged");
  ok(!fs.existsSync(path.join(persistDir, "run1-r2-call_small.txt")), "no file written for small result");

  // No persist ctx (legacy callers) -> old behavior, no crash.
  out = formatToolResultForModel(big, 2000, "exec");
  ok(out.includes("Re-run the tool with narrower input"), "without persist ctx falls back to the old hint");

  // Unsafe id characters are sanitized (no path traversal via the call id).
  out = formatToolResultForModel(big, 2000, "exec", { dir: persistDir, id: "../../evil/../id" });
  ok(fs.readdirSync(persistDir).every((name) => fs.statSync(path.join(persistDir, name)).isFile()), "persist dir contains only flat files after traversal attempt");
  ok(!fs.existsSync(path.join(tmpDir, "evil")), "no traversal directory created outside tool-results");

  // Unwritable dir (path runs through an existing FILE) -> graceful fallback, no throw.
  fs.writeFileSync(path.join(tmpDir, "afile.txt"), "block", "utf8");
  out = formatToolResultForModel(big, 2000, "exec", { dir: path.join(tmpDir, "afile.txt", "nope"), id: "x" });
  ok(typeof out === "string" && out.includes("chars omitted"), "persist failure degrades gracefully to inline truncation");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
