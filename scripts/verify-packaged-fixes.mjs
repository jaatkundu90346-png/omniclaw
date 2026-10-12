// Verifies the SHIPPED artifacts actually carry the Phase 1/2/3 fixes.
// Source tests are blind to packaging — this greps the real bundle + staged UI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The portable output dir follows OMNICLAW_PORTABLE_DIR, the same variable the
// build script honours. Hardcoding dist/windows-portable here made the gate
// check a directory the build may not have written to at all — so after a
// rebuild into a clean directory (the default one can be held by a stale Windows
// handle) the gate reported "MISSING" about files that were fine.
const portableDir = process.env.OMNICLAW_PORTABLE_DIR
  ? path.resolve(root, process.env.OMNICLAW_PORTABLE_DIR)
  : path.join(root, "dist", "windows-portable");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const targets = [
  ["gateway bundle", "dist/sidecar/omniclaw-gateway.cjs", [
    "stream client disconnected",
    "res.on(\"close\", noteDetached)",
    "checkpointProgress",
    // v1.0.0: the shipped gateway must carry the reasoning default, the config
    // route's operator gate, and native image attachment.
    "DEFAULT_REASONING_EFFORT",
    "REASONING_OFF",
    "operator: true",
    "buildUserMessage",
    "readableImageParts",
  ]],
  ["packaged sse.js", rel(path.join(portableDir, "web-next/js/sse.js")), ["IDLE_TIMEOUT_MS = 960000"]],
  ["packaged thread.js", rel(path.join(portableDir, "web-next/js/ui/thread.js")), ["onDetach", "still working in the background"]],
  // The v1.0.0 fixes. Source tests are blind to packaging: a bundle built from
  // yesterday's tree passes every source test and still ships the old behaviour.
  // These keys are the user-visible contract, so they must be greppable in the
  // SHIPPED files.
  ["packaged composer.js", rel(path.join(portableDir, "web-next/js/ui/composer.js")), [
    "model-pill effort-pill",
    "Reasoning effort",
  ]],
  ["packaged settings.js", rel(path.join(portableDir, "web-next/js/ui/settings.js")), [
    "Reasoning effort",
    "paintReasoning",
  ]],
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
