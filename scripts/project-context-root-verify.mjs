// Project-context root regression (2026-09-23 live failure): with an EMPTY
// user folder selected, loadWorkspaceContext used to scan the APP dir
// (rootDir/cwd) for project docs — injecting OmniClaw's own AGENTS.md/
// SPRINT.md into the prompt, so the model tried to read feature_list.json /
// arch_rules.json in the user's empty folder and burned 33 rounds failing.
// Now project docs must come from the SELECTED folder only.
// R11: isolated data dir + own port, never touches live :3147 data.
// R14: progress line BEFORE each step, child killed in finally, exit at end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "../tests/api/_helpers.mjs";

const PORT = 3214;
const DATA = "./.tmp-test-data/proj-ctx-root";
let step = "startup";
let ctx = null;
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); try { ctx && stopTestServer(ctx.child); } catch {} process.exit(2); }, 25000);

try {
  console.log("step: make scratch folders (empty + with-AGENTS.md)");
  step = "scratch folders";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "projctx-"));
  const emptyDir = path.join(root, "empty-project");
  const docsDir = path.join(root, "docs-project");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "AGENTS.md"), "# my project rules\nUse pnpm.\n");

  console.log("step: boot isolated server");
  step = "boot isolated server";
  ctx = await startTestServer({ port: PORT, dataDir: DATA });

  console.log("step: select EMPTY folder -> no project-scope files, manifest names it");
  step = "empty folder selection";
  let r = await apiJson(ctx.base, "POST", "/api/workspace/select", { path: emptyDir });
  assert.equal(r.status, 200, "select empty folder http");
  let ins = await apiJson(ctx.base, "GET", "/api/agents/main/inspector");
  assert.equal(ins.status, 200, "inspector http");
  let files = ins.data?.inspector?.workspace?.files || [];
  let projectFiles = files.filter((f) => f.scope === "project");
  assert.equal(projectFiles.length, 0, `empty folder -> zero project docs (got: ${projectFiles.map((f) => f.name).join(",") || "none"})`);
  const manifest1 = ins.data?.inspector?.workspace?.manifest || {};
  assert.equal(path.resolve(manifest1.selectedProject || ""), path.resolve(emptyDir), "manifest names the selected empty folder");
  const repoLeak = files.filter((f) => String(f.path || "").toLowerCase().includes("2026-04-22-hlo"));
  assert.equal(repoLeak.filter((f) => f.scope === "project").length, 0, "no app-repo file leaks in as project scope");

  console.log("step: select folder WITH AGENTS.md -> it is picked up from THAT folder");
  step = "docs folder selection";
  r = await apiJson(ctx.base, "POST", "/api/workspace/select", { path: docsDir });
  assert.equal(r.status, 200, "select docs folder http");
  ins = await apiJson(ctx.base, "GET", "/api/agents/main/inspector");
  files = ins.data?.inspector?.workspace?.files || [];
  projectFiles = files.filter((f) => f.scope === "project");
  const projAgents = projectFiles.find((f) => String(f.name).toUpperCase() === "AGENTS.MD");
  assert.ok(projAgents, "project AGENTS.md found for docs folder");
  assert.ok(String(projAgents.path || "").startsWith(path.resolve(docsDir)), `project AGENTS.md comes from the selected folder (got ${projAgents.path})`);
  assert.ok(String(projAgents.contentPreview || "").includes("my project rules"), "content is the selected folder's file, not the app repo's");

  console.log("PASS: project context rooted at selected folder (empty = clean, docs = own)");
} catch (e) {
  console.error(`FAIL at step '${step}':`, e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { ctx && stopTestServer(ctx.child); } catch {}
  process.exit(process.exitCode || 0);
}
