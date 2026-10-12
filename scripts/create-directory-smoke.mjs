// Smoke test: folder creation works end-to-end through the tool registry,
// including the mkdir/make_directory aliases — the exact thing that was failing
// (model couldn't create a folder, spun, then timed out).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-mkdir-"));
for (const dir of ["config", "workspace"]) {
  const src = path.join(repoRoot, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(rootDir, dir), { recursive: true, force: true });
}

const agent = new OmniClawAgent({ rootDir });
const ctx = { agentId: "main", sessionId: "mkdir-smoke", runId: "mkdir-smoke" };
const run = (tool, input) => agent.tools.run(tool, input, ctx);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

try {
  // 1. create_directory makes a nested project folder.
  const r1 = await run("create_directory", { path: "airforce-site/src/components" });
  ok(!r1.error && !r1.blocked && r1.type === "directory", `create_directory works: ${JSON.stringify(r1).slice(0, 120)}`);
  ok(fs.existsSync(path.join(rootDir, "airforce-site/src/components")), "nested folder exists on disk");

  // 2. the mkdir alias routes to create_directory.
  const r2 = await run("mkdir", { path: "airforce-site/src/pages" });
  ok(!r2.error && !r2.blocked && r2.type === "directory", `mkdir alias works: ${JSON.stringify(r2).slice(0, 120)}`);
  ok(fs.existsSync(path.join(rootDir, "airforce-site/src/pages")), "mkdir-created folder exists");

  // 3. make_directory + create_folder aliases too.
  const r3 = await run("make_directory", { path: "airforce-site/public" });
  ok(!r3.error && fs.existsSync(path.join(rootDir, "airforce-site/public")), "make_directory alias works");
  const r4 = await run("create_folder", { path: "airforce-site/assets" });
  ok(!r4.error && fs.existsSync(path.join(rootDir, "airforce-site/assets")), "create_folder alias works");

  // 4. write_file still auto-creates parent dirs (no separate mkdir needed).
  const r5 = await run("write_file", { path: "airforce-site/src/App.jsx", content: "export default () => null;" });
  ok(!r5.error && fs.existsSync(path.join(rootDir, "airforce-site/src/App.jsx")), "write_file auto-creates parent dir");

  // 5. re-creating the same dir never ERRORS — the registry dedups the repeated
  // side-effect call (blocked), which is graceful (the folder already exists).
  const r6 = await run("create_directory", { path: "airforce-site/src/components" });
  ok(!r6.error && (r6.blocked === true || r6.alreadyExisted === true), "duplicate create_directory handled gracefully (dedup or alreadyExisted, never an error)");
} finally {
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
