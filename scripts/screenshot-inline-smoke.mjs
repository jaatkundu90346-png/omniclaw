// Screenshot + reasoning replay regression smoke.
//
// BUGS COVERED:
//  1. Screenshots never rendered as images: the live `tool.screenshot` handler
//     pointed the <img> at `p.url` (the PAGE, which is HTML), and the persisted
//     screenshot was never re-rendered on reload at all. The servable URL is
//     `/preview/<screenshotRelPath>` (server.js serves files under the project root).
//  2. Persisted reasoning vanished on reload: the live `assistant.reasoning`
//     event is transient, so the model's thinking had to ride the report
//     (`modelToolLoop.reasoningDigest`) to survive a reload.
//
// THE TEST: mount the real web-next UI against a mocked server and assert BOTH
// screenshot paths produce an <img> whose src is `/preview/data/browser-screenshots/...`
// (live + replay), that a persisted reasoning digest replays as a Thinking row,
// and that NO <img> is ever pointed at the page URL.
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
const timer = setTimeout(() => { console.error(`TIMEOUT at ${step}`); process.exit(2); }, 24000);
const root = path.resolve("web-next");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
// 1x1 transparent PNG so /preview/* actually "loads" (the assertion is on src,
// not pixels, but a loaded image keeps the console clean).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const PAGE_URL = "https://example.com/account";
const REPLAY_SHOT = "data/browser-screenshots/shot_replay.png";
const LIVE_SHOT = "data/browser-screenshots/shot_live.png";
const NOW = new Date().toISOString();

const SESSION = {
  id: "sess_shot", label: "shot probe", agentId: "main",
  key: "main:default", channel: "webchat",
  createdAt: NOW, updatedAt: NOW, messages: [],
  transcript: [
    { type: "message", id: "m1", role: "user", text: "screenshot the login page", at: NOW },
    {
      type: "message", id: "m2", role: "assistant", text: "Here is the login page.", runId: "run_replay", at: NOW,
      toolOutputs: [
        { tool: "browser_screenshot", input: { url: PAGE_URL }, output: { success: true, screenshotRelPath: REPLAY_SHOT, url: PAGE_URL } },
      ],
    },
    {
      type: "message", id: "m3", role: "assistant", text: "Second answer.", runId: "run_replay2", at: NOW,
      toolOutputs: [],
      modelToolLoop: { reasoningDigest: "I should verify the login form first, then screenshot it." },
    },
  ],
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
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (packet) => { try { res.write(`data: ${JSON.stringify(packet)}\n\n`); } catch {} };
      send({ type: "start", sessionId: SESSION.id, status: "agent-loop" });
      send({ type: "event", record: { event: "tool.started", payload: { runId: "run_live", sessionId: SESSION.id, tool: "browser_screenshot", input: { url: PAGE_URL }, toolCallId: "call_live_1" } } });
      send({ type: "event", record: { event: "tool.screenshot", payload: { runId: "run_live", sessionId: SESSION.id, tool: "browser_screenshot", path: LIVE_SHOT, url: PAGE_URL, toolCallId: "call_live_1" } } });
      send({ type: "event", record: { event: "assistant.delta", payload: { runId: "run_live", text: "Done." } } });
      send({ type: "final", content: "Done.", metadata: {} });
      send({ type: "done", sessionId: SESSION.id });
      res.end();
      return;
    }
    // Serve any screenshot byte so /preview/* resolves to a real image.
    if (p.startsWith("/preview/")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
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

const imgSrcs = (page) => page.$$eval("img", (els) => els.map((e) => e.getAttribute("src") || ""));

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

  step = "load app + open thread";
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .composer", { timeout: 8000 });
  await page.evaluate(() => { window.location.hash = "#/t/sess_shot"; });
  await page.waitForTimeout(900);

  step = "assert REPLAY screenshot renders from /preview/";
  const replaySrcs = await imgSrcs(page);
  assert.ok(
    replaySrcs.some((s) => s.includes(`/preview/${REPLAY_SHOT}`)),
    `replay screenshot must render from /preview/${REPLAY_SHOT}; got: ${JSON.stringify(replaySrcs)}`,
  );
  assert.ok(
    !replaySrcs.some((s) => s === PAGE_URL),
    `no <img> may point at the PAGE url (${PAGE_URL}); got: ${JSON.stringify(replaySrcs)}`,
  );
  console.log(`ok: replay img src = /preview/${REPLAY_SHOT}`);

  step = "assert REPLAY reasoning replays as a Thinking row";
  const thinkText = await page.$eval(".step-thinking .s-de pre", (el) => el.textContent).catch(() => "");
  assert.ok(
    /verify the login form/.test(thinkText),
    `persisted reasoning must replay (modelToolLoop.reasoningDigest); got: ${JSON.stringify(thinkText)}`,
  );
  console.log("ok: replay reasoning row rendered");

  step = "send a message to drive the LIVE tool.screenshot event";
  await page.click("#app .composer textarea");
  await page.fill("#app .composer textarea", "take another screenshot");
  await page.keyboard.press("Enter");
  let liveSrcs = [];
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(150);
    liveSrcs = await imgSrcs(page);
    if (liveSrcs.some((s) => s.includes(`/preview/${LIVE_SHOT}`))) break;
  }

  step = "assert LIVE screenshot renders from /preview/";
  assert.ok(
    liveSrcs.some((s) => s.includes(`/preview/${LIVE_SHOT}`)),
    `live screenshot must render from /preview/${LIVE_SHOT}; got: ${JSON.stringify(liveSrcs)}`,
  );
  assert.ok(
    !liveSrcs.some((s) => s === PAGE_URL),
    `no <img> may point at the PAGE url (${PAGE_URL}); got: ${JSON.stringify(liveSrcs)}`,
  );
  console.log(`ok: live img src = /preview/${LIVE_SHOT}`);

  step = "verdict";
  assert.equal(errors.length, 0, `page errors: ${errors.join(" | ")}`);
  clearTimeout(timer);
  console.log("screenshot-inline: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  clearTimeout(timer);
  try { await browser?.close(); } catch {}
  try { await new Promise((r) => (server ? server.close(r) : r())); } catch {}
}
