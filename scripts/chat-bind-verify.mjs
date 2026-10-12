// Per-chat project bind verification (isolated ONLY: scratch data dir + :3213,
// scratch project folders under os.tmpdir). Never touches live :3147 data.
// R14: progress line BEFORE each step, AbortController on the SSE POST,
// child killed in finally, process.exit at end, 25s self-timeout.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "../tests/api/_helpers.mjs";

const PORT = 3213;
const DATA = "./.tmp-test-data/chat-bind";
let step = "startup";
let ctx = null;
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); try { ctx && stopTestServer(ctx.child); } catch {} process.exit(2); }, 25000);

function seedRepo(dir, branch, marker) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30000, windowsHide: true });
  git(["init"]);
  fs.writeFileSync(path.join(dir, marker), `${marker}\n`);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: marker }));
  git(["add", "."]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"]);
  git(["branch", "-M", branch]);
}

async function sendChat(base, body, waitMs = 3500) {
  // Session create persists server-side before inference; abort the hung
  // SSE stream after waitMs — the record survives the abort.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), waitMs);
  try {
    const r = await fetch(`${base}/api/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    await r.text().catch(() => {});
  } catch {} finally { clearTimeout(t); }
}

async function findSession(base, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await apiJson(base, "GET", "/api/sessions?limit=200");
    const hit = (r.data?.sessions || []).find((s) => s.label === label);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`session '${label}' never appeared`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function tool(base, name, input, sessionId) {
  // Tool-level failures come back HTTP 200 with {ok:false}/{blocked:true};
  // thrown confinement errors come back HTTP 400. Both shapes asserted below.
  const r = await apiJson(base, "POST", "/api/tools/run", {
    tool: name, input, ...(sessionId ? { sessionId } : {}),
  });
  return r; // {status, data}
}
function resultOf(r) {
  return r.data?.result || {};
}
function textOf(r) {
  return JSON.stringify(r.data || {});
}

try {
  console.log("step: seed scratch projects");
  step = "seed scratch projects";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatbind-"));
  const A = path.join(root, "projA");
  const B = path.join(root, "projB");
  seedRepo(A, "alpha", "markerA.txt");
  seedRepo(B, "beta", "markerB.txt");

  console.log("step: boot isolated server");
  step = "boot isolated server";
  ctx = await startTestServer({ port: PORT, dataDir: DATA });
  const base = ctx.base;

  console.log("step: select A, new chat binds A");
  step = "select A, new chat binds A";
  let r = await apiJson(base, "POST", "/api/workspace/select", { path: A });
  assert.equal(r.status, 200, "select A http");
  await sendChat(base, { label: "chatA", message: "hi", workspacePath: A });
  let chatA = await findSession(base, "chatA");
  assert.equal(chatA.workspacePath, A, "new chat stores request folder");
  const idA = chatA.id;

  console.log("step: prompt names the chat folder (unit)");
  step = "prompt names the chat folder (unit)";
  const { buildRuntimeWorkspaceManifest } = await import("../src/core/runtime-workspace.js");
  const { buildOmniClawSystemPrompt } = await import("../src/core/system-prompt.js");
  const manifest = buildRuntimeWorkspaceManifest({
    rootDir: root, sharedWorkspace: path.join(root, "ws"),
    agentWorkspace: path.join(root, "ws", "agents", "main"),
    projectDir: A, agent: {}, files: [],
  });
  assert.equal(manifest.defaultWorkingDirectory, A);
  assert.equal(manifest.selectedProject, A);
  assert.ok(manifest.agentWorkspace.endsWith(path.join("agents", "main")));
  const diet = buildOmniClawSystemPrompt({ workspaceContext: { promptV2diet: true, manifest, files: [], snapshot: "", manualsLine: "" } });
  const full = buildOmniClawSystemPrompt({ workspaceContext: { manifest, files: [] } });
  for (const [name, text] of [["diet", diet], ["full", full]]) {
    const i1 = text.indexOf(`Selected project: ${A}`);
    const i2 = text.indexOf(`Default working directory: ${A}`);
    const i3 = text.indexOf("Agent home (do not treat as the project):");
    assert.ok(i1 !== -1 && i2 !== -1 && i3 !== -1, `${name} has all three lines`);
    assert.ok(i1 < i2 && i2 < i3, `${name} order: project, cwd, home`);
  }

  console.log("step: tools confined to chat A");
  step = "tools confined to chat A";
  let g = resultOf(await tool(base, "git_status", { cwd: B }, idA));
  assert.equal(g.ok, false, "git cwd=B blocked");
  assert.ok(String(g.error || "").includes("outside the selected project"), `names root: ${g.error}`);
  assert.ok(String(g.error || "").includes(A), "error names chat root A");
  g = resultOf(await tool(base, "git_status", {}, idA));
  assert.equal(g.ok, true, "git default ok");
  assert.equal(g.branch, "alpha", "git runs in A");
  let rlf = await tool(base, "list_files", { path: B }, idA);
  assert.ok(/outside/.test(textOf(rlf)), `abs list outside blocked: ${textOf(rlf).slice(0, 160)}`);
  rlf = await tool(base, "read_file", { path: path.join(B, "markerB.txt") }, idA);
  assert.ok(/outside/i.test(textOf(rlf)), "abs read outside blocked");
  const rdA = resultOf(await tool(base, "read_file", { path: path.join(A, "markerA.txt") }, idA));
  assert.ok(String(rdA.content || "").includes("markerA.txt"), "abs read inside A works");

  console.log("step: switch global to B, old chat keeps A");
  step = "switch global to B, old chat keeps A";
  r = await apiJson(base, "POST", "/api/workspace/select", { path: B });
  assert.equal(r.status, 200, "select B http");
  await sendChat(base, { sessionId: idA, message: "again" });
  chatA = await findSession(base, "chatA");
  assert.equal(chatA.workspacePath, A, "record not restamped");
  const lf2 = resultOf(await tool(base, "list_files", { path: "." }, idA));
  const names = JSON.stringify(lf2.entries || lf2);
  assert.ok(names.includes("markerA.txt") && !names.includes("markerB.txt"), "old chat still lists A");
  g = resultOf(await tool(base, "git_status", {}, idA));
  assert.equal(g.branch, "alpha", "old chat git still in A");

  console.log("step: new chat after switch binds B");
  step = "new chat after switch binds B";
  await sendChat(base, { label: "chatB", message: "hi" });
  const chatB = await findSession(base, "chatB");
  assert.equal(chatB.workspacePath, B, "new chat takes current global");

  console.log("step: exec defaults to chat root");
  step = "exec defaults to chat root";
  const ex = resultOf(await tool(base, "exec", { command: "dir" }, idA));
  assert.ok(!ex.blocked || !ex.approvalId, `exec not approval-parked: ${JSON.stringify(ex).slice(0, 160)}`);
  assert.ok(String(ex.stdout || "").includes("markerA.txt"), "exec ran in A");

  console.log("step: resolveSession only fills null (unit)");
  step = "resolveSession only fills null (unit)";
  const { SessionStore } = await import("../src/core/session-store.js");
  const ssDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatbind-ss-"));
  const store = new SessionStore(ssDir);
  const created = store.resolveSession({ label: "t1", workspacePath: A });
  store.resolveSession({ sessionId: created.id, label: "t1", workspacePath: B });
  const after = store.findSession(store.read(), created.id);
  assert.equal(after.workspacePath, A, "stored path never overwritten");
  const created2 = store.resolveSession({ label: "t2", workspacePath: B });
  assert.equal(created2.workspacePath, B, "new session takes request path");

  console.log("PASS: bind, prompt, confinement, exec, null-only");
} catch (e) {
  console.error(`FAIL at step '${step}':`, e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try { ctx && stopTestServer(ctx.child); } catch {}
  process.exit(process.exitCode || 0);
}
