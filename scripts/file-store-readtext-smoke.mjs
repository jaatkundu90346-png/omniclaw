// Smoke test for FileStore.readText line-window correctness past the byte cap.
// Run: node scripts/file-store-readtext-smoke.mjs
import { FileStore } from "../src/core/file-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-readtext-"));
const store = new FileStore(root);

// 2000 lines, ~60 bytes each => ~120KB, well past the 64KB byte-preview cap.
const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}: ${"x".repeat(50)}`);
fs.writeFileSync(path.join(root, "big.txt"), lines.join("\n"), "utf8");

// Read a 3-line window starting at line 1500 — this sits PAST the first 64KB,
// which the old code sliced off (returning empty/wrong lines).
const res = store.readText("big.txt", 64 * 1024, { offset: 1500, limit: 3 });
assert(res.content.split("\n").length === 3, "returns exactly 3 lines");
assert(res.content.split("\n")[0] === "line 1500: " + "x".repeat(50), "first line is line 1500 (past byte cap)");
assert(res.content.split("\n")[2] === "line 1502: " + "x".repeat(50), "last line is line 1502");
assert(res.lineWindow && res.lineWindow.startLine === 1500 && res.lineWindow.totalLines === 2000, "lineWindow metadata correct");

// Numbered output uses the real base line number.
const numbered = store.readText("big.txt", 64 * 1024, { offset: 1500, limit: 2, lineNumbers: true });
assert(/^1500\t/.test(numbered.numberedContent), "numbered content starts at 1500");

// Plain (no offset/limit) read still byte-caps as before.
const plain = store.readText("big.txt", 1024);
assert(plain.bytesRead <= 1024 && plain.truncated === true, "plain read still honors byte cap + truncated flag");

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
