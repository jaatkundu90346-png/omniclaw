// Verifies the SHIPPED artifacts actually carry the Phase 1/2/3 fixes.
// Source tests are blind to packaging — this greps the real bundle + staged UI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  ["gateway bundle", "dist/sidecar/omniclaw-gateway.cjs", [
    "stream client disconnected",
    "res.on(\"close\", noteDetached)",
    "checkpointProgress",
  ]],
  ["packaged sse.js", "dist/windows-portable/web-next/js/sse.js", ["IDLE_TIMEOUT_MS = 960000"]],
  ["packaged thread.js", "dist/windows-portable/web-next/js/ui/thread.js", ["onDetach", "still working in the background"]],
];

let fail = 0;
for (const [label, rel, keys] of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`FAIL ${label}: missing ${rel}`);
    fail += 1;
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  for (const key of keys) {
    const ok = src.includes(key);
    if (!ok) fail += 1;
    console.log(`${ok ? "ok" : "FAIL"}: ${label} contains "${key}"`);
  }
}
console.log(fail === 0 ? "\nPACKAGED ARTIFACTS: PASSED" : `\nPACKAGED ARTIFACTS: ${fail} MISSING`);
process.exit(fail === 0 ? 0 : 1);
