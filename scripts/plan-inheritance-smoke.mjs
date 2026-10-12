// Smoke test: plan-inheritance WIP=1 normalization (iteration 8).
// A step left in_progress by a dead/interrupted run must be reset to pending
// when the next run inherits the plan (nothing is running it), so WIP=1 is not
// pre-violated. The stored session plan must NOT be mutated (copy semantics).
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { normalizeInheritedPlan } = await import(pathToFileURL(path.join(ROOT, "src/core/omni-loop.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

const original = {
  note: "prev run",
  updatedAt: "2026-07-05T00:00:00Z",
  steps: [
    { title: "step A", status: "completed", verification: "test A" },
    { title: "step B", status: "in_progress", verification: "test B" },
    { title: "step C", status: "pending", verification: "test C" },
    { title: "step D", status: "in_progress", verification: "test D" }, // pathological double-active
  ],
};

const out = normalizeInheritedPlan(original);

// 1. in_progress steps reset to pending; others untouched.
check("step B (in_progress) → pending", out.steps[1].status === "pending", out.steps[1].status);
check("step D (in_progress) → pending", out.steps[3].status === "pending", out.steps[3].status);
check("completed step preserved", out.steps[0].status === "completed", out.steps[0].status);
check("pending step preserved", out.steps[2].status === "pending", out.steps[2].status);
check("WIP=1 valid after inherit (0 active)", out.steps.filter((s) => s.status === "in_progress").length === 0);

// 2. Titles/verification/meta preserved.
check("titles preserved", out.steps.map((s) => s.title).join(",") === "step A,step B,step C,step D", JSON.stringify(out.steps.map((s) => s.title)));
check("verification preserved", out.steps[1].verification === "test B", out.steps[1].verification);
check("note/meta preserved", out.note === "prev run" && out.updatedAt === "2026-07-05T00:00:00Z");

// 3. Original NOT mutated (copy semantics — shared session plan must survive).
check("original step B still in_progress (not mutated)", original.steps[1].status === "in_progress", original.steps[1].status);
check("returned object is a new reference", out !== original && out.steps !== original.steps);
check("returned step objects are copies", out.steps[1] !== original.steps[1]);

// 4. Edge cases: no crash on missing/empty.
check("null plan passthrough", normalizeInheritedPlan(null) === null);
check("no-steps plan passthrough", (() => { const p = { note: "x" }; return normalizeInheritedPlan(p) === p; })());
check("empty steps ok", normalizeInheritedPlan({ steps: [] }).steps.length === 0);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
