// Smoke test for searchText ReDoS hardening + normal behavior.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { FileStore } from "../src/core/file-store.js";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-redos-"));
fs.writeFileSync(path.join(root, "a.txt"), "hello world\nfind ME here\nthird line\n");
// A pathological long line of 'a's that would hang (a+)+ if not guarded.
fs.writeFileSync(path.join(root, "big.txt"), "a".repeat(200000) + "\nneedle\n");
const store = new FileStore(root);

// Normal search works.
let r = store.searchText("find ME", { path: "." });
ok(r.ok && r.matchCount >= 1, "normal search finds a match");
ok(r.matches.some((m) => /find ME/.test(m.text)), "match text returned");

// Catastrophic nested-quantifier pattern is rejected, not run.
r = store.searchText("(a+)+$", { path: "." });
ok(!r.ok && /nested|backtrack|catastrophic/i.test(r.error), "(a+)+ rejected as ReDoS risk");
r = store.searchText("(.*)*x", { path: "." });
ok(!r.ok && /nested|backtrack|catastrophic/i.test(r.error), "(.*)*x rejected");

// A safe pattern that runs against the giant line completes quickly (line cap).
const t0 = Date.now();
r = store.searchText("needle", { path: ".", maxScanMs: 4000 });
const elapsed = Date.now() - t0;
ok(r.ok && r.matches.some((m) => m.text.includes("needle")), "finds needle past the giant line");
ok(elapsed < 4000, `giant-line scan stays fast (${elapsed}ms)`);

// Empty + invalid patterns handled.
ok(!store.searchText("", { path: "." }).ok, "empty pattern rejected");
ok(!store.searchText("(unclosed", { path: "." }).ok, "invalid regex rejected gracefully");

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
