// The agent live-view routes (R13). These exist because the panel could only
// mirror a tab of the user's REAL Chrome, so any task run through the
// Playwright stack — the default — showed an empty box for its whole duration.
//
// The shape assertions (200 + array, 404 with a code, loopback gate) need no
// browser at all and always run. The end-to-end "a real frame arrives" case is
// covered by scripts/browser-live-view-smoke.mjs against the browser classes
// directly, because it needs a live Playwright Chromium in-process.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson, lanIp } from "./_helpers.mjs";

const PORT = 3213;
const DATA = "./.tmp-test-data/browser-agent-stream";
let ctx = null;

describe("agent live view routes", () => {
  before(async () => {
    ctx = await startTestServer({
      port: PORT,
      dataDir: DATA,
      env: { OMNICLAW_TEST_HEADLESS: "1", OMNICLAW_NO_BROWSER: "1" },
    });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("agent-targets is 200 with an array even when nothing is open", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/browser/agent-targets");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.targets), "targets must always be an array");
  });

  it("agent-stream is 404 ENOSESSION when the agent has no page", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/browser/agent-stream");
    assert.equal(status, 404);
    assert.equal(data.code, "ENOSESSION");
    assert.ok(data.hint, "a 404 here must tell the user what happens next");
  });

  it("agent-stream tolerates junk query params instead of throwing", async () => {
    // Params are validated and clamped; an oversized sessionId must not 500.
    const { status } = await apiJson(ctx.base, "GET", `/api/browser/agent-stream?sessionId=${"x".repeat(5000)}`);
    assert.equal(status, 404);
  });
});

describe("agent live view loopback gate", () => {
  let wan = null;
  const WAN_PORT = 3214;
  before(async function () {
    const ip = lanIp();
    if (!ip) {
      console.warn("no LAN IP — skipping non-loopback test");
      return this.skip();
    }
    wan = await startTestServer({ port: WAN_PORT, dataDir: "./.tmp-test-data/browser-agent-wan", host: "0.0.0.0" });
    wan.ip = ip;
  });

  after(() => {
    if (wan) stopTestServer(wan.child);
  });

  it("rejects non-loopback callers with EPERM", async () => {
    if (!wan) return;
    for (const p of ["/api/browser/agent-targets", "/api/browser/agent-stream"]) {
      const r = await fetch(`http://${wan.ip}:${WAN_PORT}${p}`);
      assert.equal(r.status, 403);
      assert.equal((await r.json()).code, "EPERM");
    }
  });
});
