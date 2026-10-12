// L3 end-to-end against the PACKAGED exe: prove a stream disconnect no longer
// kills a live run (R15). Source tests run `node server.js`; only this proves the
// SHIPPED artifact behaves. A deliberately slow mock provider is mandatory —
// without it the run dies instantly and the test would pass vacuously.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "dist", "windows-portable", "omniclaw-gateway.exe");
const dataDir = path.join(root, ".tmp-exe-e2e-data");
const PORT = 3211;
const MOCK_PORT = 3212;
const KEY_ENV = "OMNICLAW_TEST_MOCK_KEY";
const base = `http://127.0.0.1:${PORT}`;
const STREAM_MS = 20000;
const ABORT_AFTER_MS = 9000;

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`ok: ${name}`);
  else { failures += 1; console.error(`FAIL: ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMockProvider() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const tick = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`), 1500);
    const done = setTimeout(() => {
      clearInterval(tick);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " DONE" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, STREAM_MS);
    res.on("close", () => { clearInterval(tick); clearTimeout(done); });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

fs.rmSync(dataDir, { recursive: true, force: true });
const dataSub = path.join(dataDir, "data");
fs.mkdirSync(dataSub, { recursive: true });
fs.writeFileSync(path.join(dataSub, "config.json"), JSON.stringify({
  provider: {
    mode: "openai-compatible", baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    model: "mock-slow-model", apiKeyEnv: KEY_ENV, apiKeyProviderId: "mock-slow",
    custom: true, timeoutMs: 60000,
  },
  runtime: { omniLoop: { streaming: true } },
}, null, 2));

const mock = await startMockProvider();
const child = spawn(exe, [], {
  cwd: root,
  env: { ...process.env, OMNICLAW_DATA_DIR: dataDir, PORT: String(PORT), [KEY_ENV]: "sk-test-not-a-real-key" },
  stdio: "ignore",
  windowsHide: true,
});

try {
  console.log("step 1: packaged gateway answers /api/health");
  let up = false;
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) { up = true; break; } } catch { /* retry */ }
    await sleep(1000);
  }
  check("packaged gateway is serving", up);
  if (!up) process.exit(1);

  console.log(`step 2: run a model turn, then abort the stream after ${ABORT_AFTER_MS}ms`);
  const ctrl = new AbortController();
  const seen = [];
  const streaming = (async () => {
    const res = await fetch(`${base}/api/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "work slowly and think" }), signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      for (const line of dec.decode(value, { stream: true }).split("\n")) {
        if (!line.startsWith("data:")) continue;
        try { seen.push(JSON.parse(line.slice(5))); } catch { /* partial */ }
      }
    }
  })().catch(() => {});
  await sleep(ABORT_AFTER_MS);
  check("model was still streaming when we hung up", seen.length > 0);
  ctrl.abort();
  await streaming;
  await sleep(3000);

  console.log("step 3: wait past the provider's full stream window");
  // If disconnect still cancelled, the run dies at ~9s. If the fix holds it
  // runs to completion on its own. Same window the source test uses.
  await sleep(STREAM_MS - ABORT_AFTER_MS + 8000);

  console.log("step 4: disconnect must NOT have cancelled the run");
  // The runId comes from the stream we cut off — matching on it is what makes
  // this non-vacuous. /api/gateway is the snapshot; /api/events is the SSE feed.
  const runIds = new Set();
  for (const p of seen) {
    const rid = p?.record?.payload?.runId || p?.payload?.runId || p?.runId;
    if (rid) runIds.add(rid);
  }
  check("stream reported a runId before we hung up (anti-vacuity)", runIds.size > 0);
  const runId = [...runIds][0];

  const gw = await fetch(`${base}/api/gateway`).then((r) => r.json()).catch(() => ({}));
  const events = Array.isArray(gw.events) ? gw.events : [];
  const cancelRequested = events.some((e) => e?.event === "run.cancel_requested" && e?.payload?.runId === runId);
  check("no run.cancel_requested for our run after a bare disconnect", cancelRequested === false);
  const status = (gw.runs || []).find((r) => r.id === runId)?.status || null;
  check("the run finished on its own instead of dying as cancelled", status !== "cancelled", `status=${status}`);
  console.log(`      note: run=${runId} status=${status} cancels=${events.filter((e) => e?.event === "run.cancel_requested").length}`);

  console.log("step 5: the server stays healthy after the disconnect");
  check("gateway still serving after disconnect", (await fetch(`${base}/api/state`)).ok);
} finally {
  try { child.kill(); } catch { /* already gone */ }
  try { mock.close(); } catch { /* already gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* hygiene */ }
}

console.log(failures === 0 ? "\nPACKAGED E2E DISCONNECT: PASSED" : `\nPACKAGED E2E DISCONNECT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
