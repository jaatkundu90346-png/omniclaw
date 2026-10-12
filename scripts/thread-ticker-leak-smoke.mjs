// Thread-ticker leak regression smoke.
//
// THE BUG: every assistant turn owns a 1 Hz `turn.timer` (the "Working for ..."
// header ticker). It was cleared ONLY inside finishTurn(). Two paths drop a turn
// WITHOUT finishing it:
//   - destroy()  -> you navigate away mid-run (onAbort returns early on the
//                   `destroyed` guard, so finishTurn is never reached)
//   - clearView() -> the /clear-view slash command
// Once dropped, the turn left `turns`, so the interval could never be stopped
// again: it fired once a second forever, painting detached DOM. One leaked
// timer per abandoned run.
//
// THE TEST: serve the real web-next UI with a /api/chat/stream that NEVER
// ends (an endless SSE stream), so a run is genuinely "in flight". Instrument
// setInterval/clearInterval before any app code runs, start a run, then navigate
// away — which calls thread.destroy(). The live-interval count MUST return to
// its baseline.
//
// R14: marker before every step, hard wall clock, everything torn down in
// finally, process.exit at the end.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

let step = "startup";
let browser = null;
let server = null;
let ctl = null; // the AbortController for the never-ending stream
const timer = setTimeout(() => { console.error(`TIMEOUT at ${step}`); process.exit(2); }, 24000);
const root = path.resolve("web-next");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

// A session with no active run, so the thread mounts cleanly.
const SESSION = {
  id: "sess_leak", label: "leak probe", agentId: "main",
  key: "main:default", channel: "webchat", createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), messages: [],
};

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function serve() {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/api/chat/stream" && req.method === "POST") {
      // An endless SSE stream: the run never finishes, exactly like a long task.
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`data: ${JSON.stringify({ type: "start", sessionId: SESSION.id, status: "agent-loop" })}\n\n`);
      ctl = new AbortController();
      req.on("close", () => { try { ctl.abort(); } catch {} });
      // Push a heartbeat forever so the client watchdog never fires either.
      const beat = setInterval(() => {
        try { res.write(`data: ${JSON.stringify({ type: "heartbeat", ts: Date.now() })}\n\n`); } catch {}
      }, 250);
      ctl.signal.addEventListener("abort", () => clearInterval(beat));
      return;
    }
    if (p === "/api/sessions") return json(res, { sessions: [SESSION] });
    if (p.startsWith("/api/sessions/")) return json(res, SESSION);
    if (p === "/api/agents") return json(res, { agents: [{ id: "main", name: "Main Agent", default: true }] });
    if (p === "/api/health") return json(res, { ok: true, version: "probe", provider: { ready: true, model: "probe-model" } });
    if (p === "/api/status") return json(res, { ok: true });
    if (p === "/api/config") return json(res, { provider: { model: "probe-model", baseUrl: "https://probe.test/v1" }, runtime: {} });
    if (p === "/api/capabilities") return json(res, { fs: true, git: true, browser: { managed: true }, terminal: true });
    if (p === "/api/workspace") return json(res, { workspace: { activePath: "C:/probe", activeName: "probe", recents: [] } });
    if (p === "/api/events") { res.writeHead(200, { "Content-Type": "text/event-stream" }); return; }
    if (p.startsWith("/api/")) return json(res, {});

    // Static web-next assets.
    let file = p === "/" || p === "" ? "/index.html" : p;
    try {
      const buf = await readFile(path.join(root, file));
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

try {
  step = "serve static + mocked APIs";
  const port = await serve();
  const base = `http://127.0.0.1:${port}/`;
  console.log(`ok: server on ${base}`);

  step = "launch chromium";
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  // Instrument BEFORE any app script runs, so every interval the app creates is
  // tracked. `live` = created and never cleared.
  step = "instrument setInterval";
  await page.addInitScript(() => {
    const si = window.setInterval, ci = window.clearInterval;
    window.__live = new Set();
    window.setInterval = function () { const id = si.apply(window, arguments); window.__live.add(id); return id; };
    window.clearInterval = function (id) { window.__live.delete(id); return ci.apply(window, arguments); };
  });
  const liveCount = () => page.evaluate(() => window.__live.size);

  step = "load app";
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .composer", { timeout: 8000 });
  await page.waitForTimeout(700);
  const baseline = await liveCount();
  console.log(`ok: baseline live intervals = ${baseline} (app chrome only)`);

  step = "open a thread route";
  await page.evaluate(() => { window.location.hash = "#/t/sess_leak"; });
  await page.waitForTimeout(700);
  assert.ok(await page.$("#app .composer"), "composer should mount on a thread route");
  console.log("ok: thread route mounted");

  step = "start a never-ending run (creates a per-turn ticker)";
  const before = await liveCount();
  await page.click("#app .composer textarea");
  await page.fill("#app .composer textarea", "hello, keep running forever");
  await page.keyboard.press("Enter");
  // Wait for the turn + its 1 Hz ticker to appear.
  let during = before;
  for (let i = 0; i < 20 && during <= before; i += 1) {
    await page.waitForTimeout(150);
    during = await liveCount();
  }
  assert.ok(during > before,
    `the run should have started a ticker (before=${before}, during=${during})`);
  console.log(`ok: run started, live intervals ${before} -> ${during} (ticker is live)`);

  step = "navigate away mid-run (calls thread.destroy())";
  await page.evaluate(() => { window.location.hash = "#/tools"; });
  await page.waitForTimeout(1200);
  const after = await liveCount();
  console.log(`ok: after navigation live intervals = ${after}`);

  step = "verdict";
  // The per-turn ticker must be gone. NO slack: the run's ticker is the only
  // thing that should differ from the baseline, and a leaked one keeps the count
  // strictly above it. (A "+1" tolerance here made the test pass against the
  // un-fixed code, which is exactly the kind of test that proves nothing.)
  assert.ok(after <= baseline,
    `LEAK: navigation mid-run left ${after - baseline} orphaned interval(s) (baseline ${baseline})`);
  assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
  clearTimeout(timer);
  console.log("thread-ticker-leak: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  clearTimeout(timer);
  try { ctl?.abort(); } catch {}
  try { await browser?.close(); } catch {}
  try { await new Promise((r) => (server ? server.close(r) : r())); } catch {}
}