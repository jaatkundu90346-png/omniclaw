// Smoke test: failed-command verdict surfaces STDOUT too (iteration 19).
// Gap: tsc / eslint / jest / vite print diagnostics to STDOUT (not stderr), but
// the verdict only surfaced stderr on failure — so a failing typecheck showed
// "❌ command FAILED (exit 1)" with no error detail, forcing the model to dig
// through the JSON body. Fix: on failure, pin the stdout tail in the verdict.
import { formatToolResultForModel } from "../src/core/omni-loop.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

// tsc-style failure: errors in STDOUT, stderr empty.
const tscOut = "src/app.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/app.ts(40,3): error TS2554: Expected 2 arguments, but got 1.\nFound 2 errors.";
let out = formatToolResultForModel(
  { status: "failed", command: "npx tsc --noEmit", exitCode: 1, stdout: tscOut, stderr: "" },
  10000,
);
check("failed command leads with ❌", out.startsWith("❌ command FAILED (exit 1)"), out.slice(0, 60));
check("verdict now surfaces stdout on failure", /stdout \(tail\):/.test(out), out);
check("actual TS errors visible in verdict region", out.includes("error TS2322") && out.includes("Found 2 errors"), out.slice(0, 300));

// Long stdout: only the tail is pinned (with a … marker), not the whole thing.
const longOut = "start-noise ".repeat(200) + "FINAL ERROR: build failed at module X";
out = formatToolResultForModel({ status: "failed", command: "npm run build", exitCode: 2, stdout: longOut, stderr: "" }, 10000);
const verdictLine = out.split("\n").find((l) => l.startsWith("stdout (tail):"));
check("long stdout is tail-capped in verdict (~<=950)", verdictLine && verdictLine.length <= 950, `len=${verdictLine && verdictLine.length}`);
check("tail keeps the END (the real error)", verdictLine && verdictLine.includes("FINAL ERROR: build failed"), verdictLine);
check("tail marks truncation with …", verdictLine && verdictLine.includes("…"), verdictLine);

// stderr AND stdout both present on failure → both surfaced.
out = formatToolResultForModel({ status: "failed", command: "x", exitCode: 1, stdout: "stdout diag here", stderr: "stderr diag here" }, 10000);
check("both stderr and stdout surfaced on failure", out.includes("stderr: stderr diag here") && out.includes("stdout (tail): stdout diag here"), out);

// SUCCESS path unchanged: no stdout-tail line, stdout stays in the body only.
out = formatToolResultForModel({ status: "completed", command: "node --version", exitCode: 0, stdout: "v24.15.0", stderr: "" }, 10000);
check("success verdict unchanged (no stdout-tail line)", out.startsWith("✅ command OK (exit 0)") && !/stdout \(tail\):/.test(out), out.slice(0, 60));

// Failure with empty stdout → no spurious stdout line.
out = formatToolResultForModel({ status: "failed", command: "mkdir x", exitCode: 1, stdout: "", stderr: "boom" }, 10000);
check("empty stdout on failure adds no stdout line", !/stdout \(tail\):/.test(out), out.slice(0, 80));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
