// Regression: a client disconnect must NOT cancel a server-side run.
//
// Live 2026-09-27: a healthy 16-minute / 35-round NEXUS run was destroyed this
// way. The web UI's stream watchdog (sse.js IDLE_TIMEOUT_MS, then 90s) fired
// during a 5-minute `exec` — a normal healthy silence — called reader.cancel(),
// and the server's res "close" handler turned that DISPLAY timeout into a
// COMPUTE cancel. 50 tool calls lost, and `cancelled` wrote no resume handoff.
//
// The invariant under test: the UI is an observer. Run lifetime belongs to the
// loop's own bounded ceilings. Aborting the HTTP request must leave the run
// alive so the work can be reattached instead of destroyed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { startTestServer, stopTestServer, apiJson, REPO } from "./_helpers.mjs";

const PORT = 3251;
const MOCK_PORT = 3252;
const STOP_TEST_PORT = 3259; // must not collide with MOCK_PORT above
const DATA_DIR = path.join(REPO, ".tmp-test-data-disconnect");
const KEY_ENV = "OMNICLAW_TEST_MOCK_KEY";

// A deliberately SLOW OpenAI-compatible endpoint. The run stays in-flight for
// ~STREAM_MS, so we can hang up mid-run deterministically — no reliance on a
// real provider, no race, and no "it finished too fast to observe" flakiness.
// The window must comfortably exceed server boot + provider warmup, or the run
// has not emitted a runId yet and there is nothing to disconnect from.
const STREAM_MS = 20000;
const ABORT_AFTER_MS = 8000;
let mockHits = 0;

function startMockProvider() {
  const server = http.createServer((req, res) => {
    mockHits += 1;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const tick = setInterval(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`);
    }, 1500);
    const done = setTimeout(() => {
      clearInterval(tick);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " DONE" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, STREAM_MS);
    res.on("close", () => { clearInterval(tick); clearTimeout(done); });
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

const seedConfig = {
  provider: {
    mode: "openai-compatible",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    model: "mock-slow-model",
    apiKeyEnv: KEY_ENV,
    apiKeyProviderId: "mock-slow",
    custom: true,
    timeoutMs: 60000,
  },
  runtime: { omniLoop: { streaming: true } },
};

// Abort the SSE request mid-flight: the client goes away, the server must not.
async function streamThenDisconnect(base, body, abortAfterMs) {
  const ctrl = new AbortController();
  const seen = [];
  const done = (async () => {
    const res = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
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
  await new Promise((r) => setTimeout(r, abortAfterMs));
  ctrl.abort();
  await done;
  return seen;
}

test("aborting the chat stream does not cancel the run (disconnect != stop)", { timeout: 120000 }, async () => {
  const mock = await startMockProvider();
  const server = await startTestServer({
    port: PORT,
    dataDir: DATA_DIR,
    env: { [KEY_ENV]: "sk-test-not-a-real-key" },
    seedConfig,
  });
  try {
    // Hang up mid-stream, while the model is still generating.
    const packets = await streamThenDisconnect(
      server.base,
      { message: "Say DONE when ready.", agentId: "main" },
      ABORT_AFTER_MS,
    );

    const runIds = new Set();
    for (const p of packets) {
      // Envelope is {type:"event", record:{event, payload:{runId,...}}} — the
      // runId lives on record.payload, not the envelope.
      const rid = p?.record?.payload?.runId || p?.payload?.runId || p?.runId;
      if (rid) runIds.add(rid);
    }

    // Guard against a vacuous pass: if we never saw a run, the test proved
    // nothing and must fail loudly rather than quietly succeed.
    assert.ok(runIds.size > 0, "expected the stream to report a runId before disconnect");
    assert.ok(mockHits > 0, "mock provider was never called — provider wiring is broken, test is vacuous");

    const runId = [...runIds][0];

    // Wait past the provider's full stream window. If disconnect still cancelled,
    // the run dies at ~2s. If the fix holds, it runs to completion on its own.
    await new Promise((r) => setTimeout(r, STREAM_MS + 6000));

    // Strongest, non-vacuous proof: `agent.cancelRun()` emits a
    // `run.cancel_requested` gateway event as its very first action. If a client
    // disconnect caused a cancel, that event exists for this runId. If the fix
    // holds, disconnect produced NO such event. (Asserting on run.status via
    // tool-trace is vacuous — that endpoint doesn't return status.)
    let cancelRequested = false;
    let runStatus = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { data } = await apiJson(server.base, "GET", "/api/gateway");
      const events = data?.events || [];
      cancelRequested = events.some(
        (e) => e?.event === "run.cancel_requested" && e?.payload?.runId === runId,
      );
      runStatus = (data?.runs || []).find((r) => r.id === runId)?.status || null;
      if (cancelRequested) break;
      if (runStatus && runStatus !== "running" && runStatus !== "accepted") break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    assert.equal(
      cancelRequested,
      false,
      `a client disconnect triggered cancelRun() on run ${runId} — the UI must never own run lifetime`,
    );
    assert.notEqual(runStatus, "cancelled", `run ${runId} ended cancelled after a mere client disconnect`);
  } finally {
    stopTestServer(server.child);
    try { mock.close(); } catch { /* hygiene */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* hygiene */ }
  }
});

// The explicit stop route is the ONLY thing that may cancel a run. If removing
// the disconnect-cancel had broken user intent, this would catch it.
//
// Contract (agent.js cancelRun): cancellation is COOPERATIVE — it flags the run
// id and the loop stops at the next round/tool boundary. It deliberately does
// not require the run to already exist, so a well-formed id returns 200.
test("explicit POST /api/runs/:id/stop is still the cancel authority", { timeout: 90000 }, async () => {
  const server = await startTestServer({ port: STOP_TEST_PORT, dataDir: `${DATA_DIR}-2` });
  try {
    // A well-formed id requests cooperative cancellation. (There is no
    // reachable "empty runId" case: `/api/runs//stop` normalises to runId
    // "stop", so don't assert a 400 the route cannot actually produce.)
    const ok = await apiJson(server.base, "POST", "/api/runs/run_does_not_exist/stop", {});
    assert.equal(ok.status, 200);
    assert.equal(ok.data?.ok, true);
    assert.match(String(ok.data?.message || ""), /[Cc]ancel/);
  } finally {
    stopTestServer(server.child);
    try { fs.rmSync(`${DATA_DIR}-2`, { recursive: true, force: true }); } catch { /* hygiene */ }
  }
});
