// 4B.2 managed browser routes (R11: :3208/:3209, R13).
// Chrome-if-present (headless via OMNICLAW_TEST_HEADLESS=1), else skip with a
// printed reason. Loopback-403 + EINVAL cases always run (no Chrome needed).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson, lanIp } from "./_helpers.mjs";

const PORT = 3208;
const DATA = "./.tmp-test-data/browser";
const NO_CHROME_ENV = {
  OMNICLAW_TEST_HEADLESS: "1",
  // Proven: Windows spawn cannot override ProgramFiles in the child, so the
  // only deterministic "no Chrome" is the launcher escape hatch.
  OMNICLAW_NO_BROWSER: "1",
};
let ctx = null;
let noChrome = null;

async function readSse(url, want, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { status: res.status, body: await res.text() };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const msg = JSON.parse(line.slice(5));
          if (want(msg)) {
            try { await reader.cancel(); } catch {}
            return { status: 200, msg };
          }
        } catch {}
      }
    }
    return { status: 200, msg: null };
  } catch (e) {
    return { status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

describe("managed browser without Chrome", () => {
  before(async () => {
    // Port isolation per instance (managed Chrome is per-machine; without
    // this a live managed port from another server pollutes assertions).
    ctx = await startTestServer({ port: PORT, dataDir: DATA, env: { OMNICLAW_TEST_HEADLESS: "1", OMNICLAW_BROWSER_PORT: "9231" } });
    noChrome = await startTestServer({
      port: PORT + 10, dataDir: "./.tmp-test-data/browser-nochrome", env: { ...NO_CHROME_ENV, OMNICLAW_BROWSER_PORT: "9231" },
    });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
    if (noChrome) stopTestServer(noChrome.child);
  });

  it("caps.browser advertises the managed surface", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/capabilities");
    assert.equal(status, 200);
    assert.deepEqual(data.browser, { managed: true, input: true, screencast: true });
  });

  it("status reports down cleanly with no browser", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/browser/status");
    assert.equal(status, 200);
    assert.equal(data.running, false);
    assert.equal(data.tabsCount, 0);
    assert.equal(typeof data.profileDir, "string");
  });

  it("launch without Chrome is 404 ENOENT with the env hint", async () => {
    const { status, data } = await apiJson(noChrome.base, "POST", "/api/browser/launch", {});
    assert.equal(status, 404);
    assert.equal(data.code, "ENOENT");
    assert.match(data.error, /Chrome not found/);
    assert.match(data.hint, /OMNICLAW_CHROME_PATH/);
  });

  it("tabs without Chrome is 503 EUNREACHABLE", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/browser/tabs");
    assert.equal(status, 503);
    assert.equal(data.code, "EUNREACHABLE");
  });

  it("input rejects unknown types with EINVAL (no Chrome needed)", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/browser/tabs/x/input", { type: "bogus" });
    assert.equal(status, 400);
    assert.equal(data.code, "EINVAL");
  });

  it("navigate requires url and rejects bad schemes (no Chrome needed)", async () => {
    const missing = await apiJson(ctx.base, "POST", "/api/browser/tabs/x/navigate", {});
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, "EINVAL");
    const bad = await apiJson(ctx.base, "POST", "/api/browser/tabs/x/navigate", { url: "file:///etc/passwd" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, "EINVAL");
    const js = await apiJson(ctx.base, "POST", "/api/browser/tabs", { url: "javascript:alert(1)" });
    assert.equal(js.status, 400);
    assert.equal(js.data.code, "EINVAL");
  });
});

describe("managed browser loopback gate", () => {
  let wan = null;
  const WAN_PORT = 3209;
  before(async function () {
    const ip = lanIp();
    if (!ip) {
      console.warn("no LAN IP — skipping non-loopback test");
      return this.skip();
    }
    wan = await startTestServer({ port: WAN_PORT, dataDir: "./.tmp-test-data/browser-wan", host: "0.0.0.0" });
    wan.ip = ip;
  });

  after(() => {
    if (wan) stopTestServer(wan.child);
  });

  it("rejects non-loopback callers with EPERM", async () => {
    if (!wan) return;
    for (const p of ["/api/browser/status", "/api/browser/tabs"]) {
      const r = await fetch(`http://${wan.ip}:${WAN_PORT}${p}`);
      assert.equal(r.status, 403);
      assert.equal((await r.json()).code, "EPERM");
    }
  });
});

describe("managed browser with real Chrome", () => {
  // Own server: the no-Chrome describe above stops its instance in after().
  let live = null;
  const LIVE_PORT = 3213;
  const liveApi = (method, p, body) => apiJson(`http://localhost:${LIVE_PORT}`, method, p, body);
  let launched = null;

  before(async () => {
    live = await startTestServer({ port: LIVE_PORT, dataDir: "./.tmp-test-data/browser-live", env: { OMNICLAW_TEST_HEADLESS: "1", OMNICLAW_BROWSER_PORT: "9232" } });
  });

  after(() => {
    if (live) stopTestServer(live.child);
  });

  it("launch starts (or reuses) the managed instance", async function () {
    const { status, data } = await liveApi("POST", "/api/browser/launch", {});
    if (status === 404 && data.code === "ENOENT") {
      console.warn("no Chrome on this machine — skipping live-browser tests (reason: Chrome not found)");
      return this.skip();
    }
    assert.equal(status, 200);
    assert.equal(data.running, true);
    assert.ok(Number(data.port) > 0);
    assert.ok(Array.isArray(data.tabs));
    assert.equal(typeof data.chromePath, "string");
    launched = data;
  });

  it("tabs list the managed tabs with B1 shape", async function () {
    if (!launched) return this.skip();
    const { status, data } = await liveApi( "GET", "/api/browser/tabs");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.tabs) && data.tabs.length > 0);
    for (const t of data.tabs) {
      assert.equal(typeof t.id, "string");
      assert.equal(typeof t.title, "string");
      assert.equal(typeof t.url, "string");
      assert.equal(typeof t.active, "boolean");
      assert.equal(t.favicon, null);
    }
  });

  it("create + navigate + back + reload + input round-trip", async function () {
    if (!launched) return this.skip();
    const created = await liveApi( "POST", "/api/browser/tabs", { url: "about:blank" });
    assert.equal(created.status, 200);
    const id = created.data.tab.id;
    assert.ok(id);
    try {
      const nav = await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/navigate`, { url: "about:blank" });
      assert.equal(nav.status, 200);
      assert.equal(nav.data.ok, true);
      for (const a of ["back", "forward", "reload"]) {
        const r = await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/${a}`, {});
        assert.equal(r.status, 200);
        assert.equal(r.data.ok, true);
      }
      const mouse = await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/input`, {
        type: "mouse", kind: "click", cssX: 10, cssY: 10, frameW: 100, frameH: 100,
      });
      assert.equal(mouse.status, 200);
      assert.equal(mouse.data.ok, true);
      const key = await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/input`, {
        type: "key", key: "Tab",
      });
      assert.equal(key.status, 200);
      assert.equal(key.data.ok, true);
      const wheel = await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/input`, {
        type: "wheel", deltaY: 100,
      });
      assert.equal(wheel.status, 200);
      assert.equal(wheel.data.ok, true);
      const act = await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/activate`, {});
      assert.equal(act.status, 200);
    } finally {
      await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/close`, {});
    }
  });

  it("stream opens with a ready envelope", async function () {
    if (!launched) return this.skip();
    const created = await liveApi( "POST", "/api/browser/tabs", { url: "about:blank" });
    assert.equal(created.status, 200);
    const id = created.data.tab.id;
    try {
      const got = await readSse(
        `http://localhost:3213/api/browser/tabs/${encodeURIComponent(id)}/stream`,
        (m) => m && (m.type === "ready" || m.jpegBase64),
      );
      assert.equal(got.status, 200);
      assert.ok(got.msg, "no stream envelope within timeout");
      if (got.msg.type === "ready") assert.equal(got.msg.tabId, id);
      else {
        assert.equal(got.msg.tabId, id);
        assert.ok(typeof got.msg.jpegBase64 === "string" && got.msg.jpegBase64.length > 0);
        assert.ok(got.msg.metadata && typeof got.msg.metadata.deviceWidth === "number");
      }
    } finally {
      await liveApi( "POST", `/api/browser/tabs/${encodeURIComponent(id)}/close`, {});
    }
  });
});
