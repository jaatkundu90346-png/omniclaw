// E2E: the AGENT LIVE VIEW over the real HTTP route, against a real server.
//
// The unit smoke (browser-live-view-smoke.mjs) drives the browser classes
// in-process. This proves the thing the USER depends on: a running OmniClaw
// serving /api/browser/agent-targets and /api/browser/agent-stream, and a
// client receiving real JPEG frames of the page the agent opened — over a real
// socket, through real SSE framing and the real backpressure path.
//
// R11: isolated data dir + port. No live instance is touched and no config or
// provider endpoint is called (only browser tools).
// Prints a progress line BEFORE each step, aborts every stream, and exits via
// process.exitCode (a hard process.exit() discards buffered stdout when piped,
// which makes a pass look like a silent hang).
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3199;
const DATA = "./.tmp-test-data/live-e2e";
const PAGE_PORT = 39622;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};
const step = (m) => console.log(`--- ${m}`);

// Generous ceiling: booting the server plus launching a real Chromium on a
// cold Windows box legitimately takes well over a minute on this machine.
const bail = setTimeout(() => { console.log("TIMEOUT at 300s"); process.exit(2); }, 300000);
bail.unref?.();

// Something visibly moving, so the screencast keeps producing frames instead
// of emitting one static frame and going quiet.
const PAGE = `<!doctype html><html><head><title>agent-live-e2e</title>
<style>body{margin:0;font:16px sans-serif}#box{width:120px;height:120px;background:#0af;
position:fixed;top:40px;left:20px}#tall{height:3000px}</style></head>
<body><h1>Agent live view E2E</h1><div id="box"></div>
<button id="go" onclick="document.getElementById('box').style.top='300px'">Go</button>
<input id="name"/><div id="tall"></div>
<script>let y=40;setInterval(()=>{y=(y+8)%400;document.getElementById('box').style.top=y+'px';},100);</script>
</body></html>`;

const pageServer = http.createServer((_q, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGE);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, r));
const pageUrl = `http://localhost:${PAGE_PORT}/`;

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const child = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    OMNICLAW_DATA_DIR: DATA,
    PORT: String(PORT),
    // Deterministic: does not depend on whether the user happens to have
    // Chrome's remote debugging on, so the Playwright path always runs.
    OMNICLAW_TEST_HEADLESS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverLog = "";
child.stdout.on("data", (c) => { serverLog += c; });
child.stderr.on("data", (c) => { serverLog += c; });

const base = `http://localhost:${PORT}`;

async function apiJson(method, p, body) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: text.slice(0, 200) }; }
}

/** Read an SSE stream until `want(seen)` is true or the deadline passes. */
async function readSse(url, want, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const seen = { ready: null, frames: 0, actions: 0, heartbeats: 0, sampleFrame: "", meta: null };
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { status: res.status, ...seen, body: (await res.text()).slice(0, 200) };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let satisfied = false;
    while (!satisfied) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5)); } catch { continue; }
        if (msg.type === "ready") seen.ready = msg;
        else if (msg.type === "frame") {
          seen.frames += 1;
          if (!seen.sampleFrame) { seen.sampleFrame = msg.data || ""; seen.meta = msg.metadata || null; }
        } else if (msg.type === "action") seen.actions += 1;
        else if (msg.type === "heartbeat") seen.heartbeats += 1;
        if (want(seen)) { satisfied = true; break; }
      }
    }
    try { await reader.cancel(); } catch { /* already closed */ }
  } catch (e) {
    if (String(e?.name) !== "AbortError") seen.error = String(e?.message || e);
  } finally {
    clearTimeout(timer);
  }
  return { status: 200, ...seen };
}

try {
  step("1. boot an isolated server");
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  check("server came up on the isolated port", up, serverLog.slice(-300));
  if (!up) throw new Error("server did not start");

  step("2. agent-targets is empty before the agent opens anything");
  let r = await apiJson("GET", "/api/browser/agent-targets");
  check("agent-targets is 200 with an array", r.status === 200 && Array.isArray(r.data?.targets),
    JSON.stringify(r.data).slice(0, 160));
  check("no targets yet", (r.data?.targets || []).length === 0, JSON.stringify(r.data?.targets));

  step("3. agent-stream 404s cleanly while there is nothing to watch");
  r = await apiJson("GET", "/api/browser/agent-stream");
  check("agent-stream is 404 ENOSESSION", r.status === 404 && r.data?.code === "ENOSESSION",
    JSON.stringify(r.data).slice(0, 160));

  step("4. the agent opens a page (real tool call, real Chromium)");
  r = await apiJson("POST", "/api/tools/run", { tool: "browser_open", input: { url: pageUrl } });
  check("browser_open succeeded over HTTP", r.data?.result?.success === true,
    JSON.stringify(r.data).slice(0, 250));

  step("5. agent-targets now lists the page the panel must follow");
  r = await apiJson("GET", "/api/browser/agent-targets");
  const targets = r.data?.targets || [];
  check("exactly one agent target", targets.length === 1, JSON.stringify(targets).slice(0, 200));
  check("target id is followable (pw: prefixed)", /^pw:/.test(targets[0]?.id || ""), targets[0]?.id);
  check("target reports the page url", (targets[0]?.url || "").includes(String(PAGE_PORT)), targets[0]?.url);
  // A Promise here once serialised to `{}` and rendered a literal "{}" as the
  // tab label in the panel, so the type is part of the contract.
  check("target title is a real string, not a serialised Promise",
    typeof targets[0]?.title === "string" && targets[0].title.length > 0,
    `type=${typeof targets[0]?.title} value=${JSON.stringify(targets[0]?.title)}`);
  check("target title matches the page", /agent-live-e2e/.test(targets[0]?.title || ""), targets[0]?.title);

  step("6. the panel's SSE stream delivers REAL frames (the whole point)");
  const live = await readSse(`${base}/api/browser/agent-stream`, (s) => s.frames >= 3, 25000);
  check("stream is 200", live.status === 200, JSON.stringify(live).slice(0, 200));
  check("ready identifies the agent connection", live.ready?.connection === "agent",
    JSON.stringify(live.ready).slice(0, 200));
  check("ready carries the followed tab id", /^pw:/.test(live.ready?.tabId || ""), live.ready?.tabId);
  check("received multiple real JPEG frames", live.frames >= 3, `frames=${live.frames}`);
  check("frame payload is real base64 JPEG", /^[A-Za-z0-9+/=]{1000,}$/.test(live.sampleFrame || ""),
    `len=${(live.sampleFrame || "").length}`);
  check("frame carries viewport metadata (cursor mapping needs it)",
    Number(live.meta?.deviceWidth) > 0 && Number(live.meta?.deviceHeight) > 0,
    JSON.stringify(live.meta));


  step("6b. a STATIC page still yields a frame (the blank-panel bug)");
  // Chrome only pushes screencast frames when the page REPAINTS. A page that
  // has finished loading and sits still produces nothing, so the panel showed an
  // empty box on exactly the ordinary pages a task starts from. Verified live
  // against a real static page (Hacker News) before this fallback existed.
  const b = await apiJson("POST", "/api/tools/run", { tool: "browser_navigate", input: { url: "about:blank" } });
  check("navigated to a page that will not repaint", !b.data?.result?.error, JSON.stringify(b.data).slice(0, 160));
  const first = await readSse(`${base}/api/browser/agent-stream`, (s) => s.frames >= 1, 8000);
  check("a still page still delivers a first frame", first.frames >= 1, `frames=${first.frames} in 8s`);
  check("that frame is real JPEG data", /^[A-Za-z0-9+/=]{500,}$/.test(first.sampleFrame || ""),
    `len=${(first.sampleFrame || "").length}`);

  // Back to the animated page for the remaining action checks.
  await apiJson("POST", "/api/tools/run", { tool: "browser_navigate", input: { url: pageUrl } });

  step("7. the agent's actions are broadcast to the panel");
  // Subscribe FIRST, then make the agent act, so an action must arrive live on
  // an OPEN stream — this is what draws the cursor / scroll cue.
  const ctrl = new AbortController();
  const actions = [];
  const streamDone = (async () => {
    try {
      const res = await fetch(`${base}/api/browser/agent-stream`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const m = JSON.parse(line.slice(5));
            if (m.type === "action") actions.push(m.action);
          } catch { /* partial */ }
        }
      }
    } catch { /* aborted */ }
  })();

  await new Promise((res) => setTimeout(res, 1500));   // let the stream attach
  await apiJson("POST", "/api/tools/run", { tool: "browser_snapshot", input: {} });
  await apiJson("POST", "/api/tools/run", { tool: "browser_scroll", input: { direction: "down", amount: 300 } });
  await new Promise((res) => setTimeout(res, 2500));
  ctrl.abort();
  await streamDone;

  check("a scroll action was broadcast to the panel", actions.some((a) => a.type === "scroll"),
    JSON.stringify(actions.map((a) => a.type)));
  const sc = actions.find((a) => a.type === "scroll");
  check("scroll action names its direction", sc?.direction === "down", JSON.stringify(sc));
  check("scroll action is attributed to the agent", sc?.actor === "agent", JSON.stringify(sc));
  check("scroll action carries the followable tab id", /^pw:/.test(sc?.tabId || ""), sc?.tabId);

  step("8. cleanup: closing the session empties the target list");
  await apiJson("POST", "/api/tools/run", { tool: "browser_close", input: {} });
  r = await apiJson("GET", "/api/browser/agent-targets");
  check("no targets after browser_close", (r.data?.targets || []).length === 0,
    JSON.stringify(r.data?.targets));
  r = await apiJson("GET", "/api/browser/agent-stream");
  check("agent-stream returns to a clean 404 once nothing is open",
    r.status === 404 && r.data?.code === "ENOSESSION", JSON.stringify(r.data).slice(0, 160));
} catch (error) {
  check("script completed without throwing", false, error?.stack || error?.message);
} finally {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 2000));
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  pageServer.close();
  clearTimeout(bail);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

