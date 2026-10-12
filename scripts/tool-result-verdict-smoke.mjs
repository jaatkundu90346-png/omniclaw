// Smoke test: tool results lead with an unambiguous pass/fail verdict so the
// model can never miss a terminal command's exit code / stderr.
import { formatToolResultForModel } from "../src/core/omni-loop.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

// Failed flat shell result -> leads with ❌ + exit + stderr.
let out = formatToolResultForModel(
  { status: "failed", command: "mkdir -p src/pages", exitCode: 1, stdout: "", stderr: "mkdir : A positional parameter cannot be found" },
  10000,
);
ok(out.startsWith("❌ command FAILED (exit 1)"), "failed command leads with ❌ exit 1");
ok(out.includes("mkdir -p src/pages"), "verdict includes the command");
ok(out.includes("stderr: mkdir : A positional"), "verdict surfaces stderr on failure");

// Successful command -> leads with ✅.
out = formatToolResultForModel({ status: "completed", command: "node --version", exitCode: 0, stdout: "v24.15.0", stderr: "" }, 10000);
ok(out.startsWith("✅ command OK (exit 0)"), "ok command leads with ✅ exit 0");

// Nested execution shape (registry wraps shell under .execution).
out = formatToolResultForModel({ command: "npm.cmd run build", execution: { status: "failed", exitCode: 2, stderr: "build error here" } }, 10000);
ok(out.startsWith("❌ command FAILED (exit 2)"), "nested execution failure detected");
ok(out.includes("stderr: build error here"), "nested stderr surfaced");

// timeout.
out = formatToolResultForModel({ status: "timeout", command: "sleep 999", exitCode: null, timedOut: true, stderr: "" }, 10000);
ok(out.startsWith("❌ command FAILED (timed out)"), "timeout reported as failure");

// Generic tool error / blocked.
out = formatToolResultForModel({ error: true, message: "Path is outside the allowed workspace." }, 10000);
ok(out.startsWith("❌ TOOL ERROR: Path is outside"), "generic tool error leads with ❌ TOOL ERROR");
out = formatToolResultForModel({ blocked: true, reason: "Permission disabled." }, 10000);
ok(out.startsWith("⛔ TOOL BLOCKED: Permission disabled"), "blocked tool leads with ⛔");

// Non-command success (e.g. read_file) -> no spurious verdict, body preserved.
out = formatToolResultForModel({ path: "a.txt", content: "hello" }, 10000);
ok(!out.startsWith("✅") && !out.startsWith("❌") && out.includes("hello"), "non-command result has no fake verdict");

// ok:false generic.
out = formatToolResultForModel({ ok: false, message: "could not parse" }, 10000);
ok(out.startsWith("❌ tool reported ok:false"), "ok:false surfaced");

// String passthrough.
ok(formatToolResultForModel("plain string", 10000) === "plain string", "string result passes through");

// Full structured body still present after the verdict.
out = formatToolResultForModel({ status: "failed", command: "x", exitCode: 1, stderr: "boom" }, 10000);
ok(out.includes('"exitCode":1'), "structured JSON body retained after verdict");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
