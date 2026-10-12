// E2E acceptance (Part A4/E): the exact failing task — "create a
// Mario-style platformer in a single HTML file in the selected project,
// then verify in a browser" — with "new window" selected.
// Drives the REAL harness tool path (selectWorkspace -> write_file relative
// -> read_file -> browser_open file:// -> evaluate play-state ->
// screenshot), the same tools the model uses. Model-side proof (no roots /
// tool / budget reasoning) comes from one-root-smoke + prompt-tools-smoke.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";

const NEW_WINDOW = "C:\\Users\\PATEL COMPUTERS\\Desktop\\new window";
let failures = 0;
const ok = (cond, label) => {
  if (!cond) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
};

console.log("step 1: harness on an isolated data dir (live config untouched)");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-e2e-mario-"));
for (const dir of ["config", "workspace"]) {
  const src = path.join(process.cwd(), dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(rootDir, dir), { recursive: true, force: true });
}
const agent = new OmniClawAgent({ rootDir });
const context = { agentId: "main", sessionId: "e2e-mario", runId: "e2e-mario" };
const runTool = (tool, input = {}) => agent.tools.run(tool, input, context);

try {
  console.log("step 2: select 'new window' — the selected project IS the root");
  const sel = agent.selectWorkspace(NEW_WINDOW);
  ok(sel.ok === true && agent.getWorkspaceRoot() === NEW_WINDOW, `workspace selected (${agent.getWorkspaceRoot()})`);

  console.log("step 3: plan -> write COMPLETE file (single write, no decomposition)");
  const plan = await runTool("update_plan", {
    steps: [
      { title: "Write complete playable mario.html", status: "in_progress", verification: "read_file shows full game + node-less static check" },
      { title: "Verify in browser (open, play-state, screenshot)", status: "pending", verification: "browser_open success + consoleErrors empty + score changes" },
    ],
  });
  ok(plan.saved === true, "2-step plan saved (small deliverable, not 4 steps)");

  const game = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Super Mario-Style Platformer</title>
<style>
  body { margin: 0; background: #5c94fc; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: Arial, sans-serif; }
  #wrap { text-align: center; }
  canvas { background: #5c94fc; border: 4px solid #000; display: block; margin: 0 auto; }
  #hud { color: #fff; font-weight: bold; margin-bottom: 6px; }
  #msg { color: #fff; min-height: 24px; font-weight: bold; }
</style>
</head>
<body>
<div id="wrap">
  <div id="hud">SCORE <span id="score">0</span> &nbsp; LIVES <span id="lives">3</span></div>
  <canvas id="game" width="640" height="360"></canvas>
  <div id="msg">Arrows / A,D to move — Space to jump. Grab coins, stomp goombas, reach the flag!</div>
</div>
<script>
window.GAME = { score: 0, lives: 3, over: false, won: false };
(function () {
  var cv = document.getElementById('game'), ctx = cv.getContext('2d');
  var scoreEl = document.getElementById('score'), livesEl = document.getElementById('lives'), msgEl = document.getElementById('msg');
  var G = 0.6, W = cv.width, H = cv.height;
  var keys = {};
  addEventListener('keydown', function (e) { keys[e.code] = true; if (['ArrowLeft','ArrowRight','ArrowUp','Space'].indexOf(e.code) >= 0) e.preventDefault(); });
  addEventListener('keyup', function (e) { keys[e.code] = false; });
  var plats = [
    { x: 0, y: 320, w: 640, h: 40 },
    { x: 120, y: 250, w: 100, h: 16 }, { x: 300, y: 210, w: 100, h: 16 },
    { x: 480, y: 250, w: 100, h: 16 }, { x: 220, y: 130, w: 90, h: 16 }
  ];
  var coins = [{ x: 150, y: 220 }, { x: 330, y: 180 }, { x: 510, y: 220 }, { x: 250, y: 100 }].map(function (c) { c.taken = false; return c; });
  var goombas = [{ x: 350, y: 304, w: 20, h: 16, vx: -0.7 }, { x: 520, y: 304, w: 20, h: 16, vx: 0.8 }];
  var flag = { x: 600, y: 240, w: 12, h: 80 };
  var p = { x: 30, y: 280, w: 22, h: 28, vx: 0, vy: 0, onGround: false };
  function hud() { scoreEl.textContent = window.GAME.score; livesEl.textContent = window.GAME.lives; }
  function die() {
    window.GAME.lives -= 1; hud();
    if (window.GAME.lives <= 0) { window.GAME.over = true; msgEl.textContent = 'GAME OVER — refresh to retry'; return; }
    p.x = 30; p.y = 280; p.vx = 0; p.vy = 0;
  }
  function step() {
    if (window.GAME.over || window.GAME.won) return;
    var L = keys.ArrowLeft || keys.KeyA, R = keys.ArrowRight || keys.KeyD, J = keys.Space || keys.ArrowUp || keys.KeyW;
    p.vx = (R ? 2.4 : 0) - (L ? 2.4 : 0);
    if (J && p.onGround) { p.vy = -11; p.onGround = false; }
    p.vy = Math.min(p.vy + G, 12);
    p.x = Math.max(0, Math.min(W - p.w, p.x + p.vx));
    p.y += p.vy; p.onGround = false;
    plats.forEach(function (q) {
      if (p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y) {
        if (p.vy >= 0 && p.y + p.h - p.vy <= q.y + 8) { p.y = q.y - p.h; p.vy = 0; p.onGround = true; }
      }
    });
    if (p.y > H) { die(); return; }
    coins.forEach(function (c) {
      if (!c.taken && Math.abs(p.x + p.w / 2 - c.x) < 18 && Math.abs(p.y + p.h / 2 - c.y) < 22) {
        c.taken = true; window.GAME.score += 100; hud();
      }
    });
    goombas.forEach(function (g) {
      g.x += g.vx;
      if (g.x < 0 || g.x + g.w > W) g.vx *= -1;
      if (p.x < g.x + g.w && p.x + p.w > g.x && p.y < g.y + g.h && p.y + p.h > g.y) {
        if (p.vy > 1 && p.y + p.h - g.y < 14) { g.x = -9999; window.GAME.score += 200; p.vy = -8; hud(); }
        else die();
      }
    });
    if (p.x + p.w >= flag.x && p.y + p.h >= flag.y) { window.GAME.won = true; msgEl.textContent = 'YOU WIN! Score ' + window.GAME.score; }
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#8b4513'; plats.forEach(function (q) { ctx.fillRect(q.x, q.y, q.w, q.h); });
    ctx.fillStyle = '#ffd700';
    coins.forEach(function (c) { if (!c.taken) { ctx.beginPath(); ctx.arc(c.x, c.y, 7, 0, 7); ctx.fill(); } });
    ctx.fillStyle = '#8b0000';
    goombas.forEach(function (g) { if (g.x > -100) ctx.fillRect(g.x, g.y, g.w, g.h); });
    ctx.fillStyle = '#008000'; ctx.fillRect(flag.x, flag.y, flag.w, flag.h);
    ctx.fillStyle = '#00ff00'; ctx.fillRect(flag.x, flag.y - 22, 34, 22);
    ctx.fillStyle = '#ff0000'; ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = '#fff'; ctx.fillRect(p.x + 4, p.y + 6, 5, 5); ctx.fillRect(p.x + 13, p.y + 6, 5, 5);
  }
  window.__step = step;
  (function loop() { step(); draw(); requestAnimationFrame(loop); })();
})();
</script>
</body>
</html>`;
  const write = await runTool("write_file", { path: "mario.html", content: game });
  ok(write && !write.error && !write.blocked, `write_file mario.html via relative path (${write.bytesWritten || "?"} bytes)`);
  const absPath = path.join(NEW_WINDOW, "mario.html");
  ok(fs.existsSync(absPath), `real file in correct folder: ${absPath}`);

  console.log("step 4: read back + ledger proves small-file full content");
  const read = await runTool("read_file", { path: "mario.html", limit: 8 });
  ok(read && String(read.content || "").includes("Super Mario-Style Platformer"), "read_file observes the written game");
  const tasks = await runTool("read_file", { path: "TASKS.md" });
  ok(tasks && String(tasks.content || "").length === 309, `TASKS.md is 309B via selected-project read (${String(tasks.content || "").length}B)`);
  const ledger = agent.buildEvidenceLedger({ id: "e2e-mario", workspacePath: NEW_WINDOW }, [
    { tool: "read_file", input: { path: "TASKS.md" }, output: { path: "TASKS.md", content: tasks.content, totalBytes: 309 } },
  ]);
  const key = agent.ledgerPathKey({ workspacePath: NEW_WINDOW }, "TASKS.md");
  ok(ledger && ledger.files[key] && ledger.files[key].content === String(tasks.content || ""), "ledger inlines FULL 309B content (no first-line guessing)");

  console.log("step 5: verify in the browser (open -> state -> play -> screenshot)");
  const fileUrl = pathToFileURL(absPath).href;
  const opened = await runTool("browser_open", { url: fileUrl, sessionId: "e2e-mario-browser" });
  ok(opened && opened.success === true, `browser_open file:// inside selected project (${opened.error || "success"})`);
  const state0 = await runTool("browser_evaluate", {
    sessionId: "e2e-mario-browser",
    script: "({ hasGame: typeof window.GAME !== 'undefined', score: window.GAME && window.GAME.score, canvas: !!document.querySelector('#game'), errors: (window.__errs || []).length })",
  });
  ok(state0 && state0.result && state0.result.hasGame === true && state0.result.canvas === true, `game booted in page (${JSON.stringify(state0.result)})`);
  // Play like a player: hold Right, then jump, then read real state.
  await runTool("browser_evaluate", {
    sessionId: "e2e-mario-browser",
    script: "window.__x0 = (function(){ var p = document.querySelector('#game'); return p ? 1 : 0; })(); 'ready'",
  });
  const play = await runTool("browser_evaluate", {
    sessionId: "e2e-mario-browser",
    script: "(function(){ function key(code, type){ document.dispatchEvent(new KeyboardEvent(type, {code: code, bubbles: true})); } key('ArrowRight','keydown'); for (var i=0;i<120;i++) window.__step(); key('Space','keydown'); for (var j=0;j<120;j++) window.__step(); key('Space','keyup'); key('ArrowRight','keyup'); return { score: window.GAME.score, over: window.GAME.over, won: window.GAME.won }; })()",
  });
  ok(play && play.result && typeof play.result.score === "number", `played 240 ticks via real input+step (${JSON.stringify(play.result)})`);
  const shot = await runTool("browser_screenshot", { sessionId: "e2e-mario-browser" });
  ok(shot && shot.success === true && shot.screenshotPath && fs.existsSync(shot.screenshotPath), `screenshot saved (${shot.screenshotPath || "missing"})`);
  const view = await runTool("browser_view", { sessionId: "e2e-mario-browser", format: "markdown" });
  ok(view && !view.error, "browser_view reads page text");
  const done = await runTool("update_plan", {
    steps: [
      { title: "Write complete playable mario.html", status: "completed", verification: "read_file shows full game" },
      { title: "Verify in browser (open, play-state, screenshot)", status: "completed", verification: "browser_open success + state read + screenshot" },
    ],
    note: "e2e mario done",
  });
  ok(done.saved === true, "plan completed together (same-artifact steps, one action each)");
  await runTool("browser_close", { sessionId: "e2e-mario-browser" }).catch(() => {});
  console.log(`\nE2E file: ${absPath}`);
  console.log(`E2E screenshot: ${(shot && shot.screenshotPath) || "(none)"}`);
} finally {
  agent.heartbeat?.stop?.();
  agent.scheduler?.stop?.();
  agent.autonomousDaemon?.stop?.();
  try { await agent.browserPlaywright?.close?.({ sessionId: "e2e-mario-browser" }); } catch { /* best effort */ }
}
console.log(failures ? `\ne2e-mario: ${failures} FAILURES` : "\ne2e-mario: ALL PASS");
process.exit(failures ? 1 : 0);
