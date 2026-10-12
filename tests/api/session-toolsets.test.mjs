// T2.2 pins API + EOPERATOR gate + enable_toolset + layers view (R11: :3210).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "./_helpers.mjs";

const PORT = 3210;
const DATA = "./.tmp-test-data/toolsets";
let ctx = null;
let sid = "";

describe("session toolset pins + menuV2 gates", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
    const imp = await apiJson(ctx.base, "POST", "/api/sessions/import", {
      session: { label: "toolset-probe", agentId: "main", channel: "webchat" },
      transcript: [],
    });
    assert.equal(imp.status, 200);
    sid = imp.data.sessionId;
  });

  after(async () => {
    if (ctx) {
      try { await apiJson(ctx.base, "POST", "/api/config", { tools: { menuV2: false } }); } catch {}
      stopTestServer(ctx.child);
      ctx = null;
    }
  });

  it("rejects unknown toolset names with EINVAL", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", `/api/sessions/${sid}/toolsets`, { toolsets: ["nope"] });
    assert.equal(status, 400);
    assert.equal(data.code, "EINVAL");
  });

  it("rejects missing body with EINVAL", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", `/api/sessions/${sid}/toolsets`, {});
    assert.equal(status, 400);
    assert.equal(data.code, "EINVAL");
  });

  it("pins round-trip through the session record", async () => {
    const set = await apiJson(ctx.base, "POST", `/api/sessions/${sid}/toolsets`, { toolsets: ["browser", "computer"] });
    assert.equal(set.status, 200);
    assert.deepEqual(set.data.pinnedToolsets, ["browser", "computer"]);
    const got = await apiJson(ctx.base, "GET", `/api/sessions/${sid}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.data.session.pinnedToolsets, ["browser", "computer"]);
    const clear = await apiJson(ctx.base, "POST", `/api/sessions/${sid}/toolsets`, { toolsets: [] });
    assert.deepEqual(clear.data.pinnedToolsets, []);
  });

  it("404s unknown sessions", async () => {
    const { status } = await apiJson(ctx.base, "POST", "/api/sessions/does-not-exist/toolsets", { toolsets: ["browser"] });
    assert.equal(status, 400);
  });

  it("menuV2 flag flips on", async () => {
    const cfg = await apiJson(ctx.base, "POST", "/api/config", { tools: { menuV2: true } });
    assert.equal(cfg.status, 200);
  });

  it("blocks operator tools with EOPERATOR when menuV2 is on", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/tools/run", {
      tool: "update_runtime_settings", input: {},
    });
    assert.equal(status, 200);
    const out = data.result || {};
    assert.equal(out.blocked, true);
    assert.equal(out.code, "EOPERATOR");
    assert.match(out.reason, /operator action/);
  });

  it("leaves non-operator tools alone", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/tools/run", {
      tool: "time_now", input: {},
    });
    assert.equal(status, 200);
    assert.ok(!(data.result || {}).blocked || (data.result || {}).code !== "EOPERATOR");
  });

  it("enable_toolset records the run toolset and emits the event", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/tools/run", {
      tool: "enable_toolset", input: { name: "browser", reason: "probe" },
    });
    assert.equal(status, 200);
    assert.equal((data.result || {}).ok, true);
    const gw = await apiJson(ctx.base, "GET", "/api/gateway");
    const ev = (gw.data.events || []).find((e) => e.event === "toolset.enabled");
    assert.ok(ev, "toolset.enabled missing from gateway events");
    assert.equal(ev.payload.name, "browser");
  });

  it("layers view groups core/toolsets/operator", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/tools?view=layers");
    assert.equal(status, 200);
    // Codex-sized core: the always-on tools (16 + list_toolsets, which is
    // core so discovery is free — one tiny schema vs a wasted round;
    // git/progress/browser load via load_toolset).
    assert.ok(Array.isArray(data.core) && data.core.length === 17);
    assert.ok(data.core.some((t) => (t.id || t) === "list_toolsets"));
    assert.ok(data.toolsets.browser.tools.length > 30);
    assert.ok(data.toolsets.self.tools.length === 4);
    assert.ok(data.toolsets.forge.tools.length >= 8);
    assert.ok(data.operator.some((t) => t.id === "update_runtime_settings"));
    assert.ok(data.drop.some((t) => t.id === "kanban_show"));
    const caps = await apiJson(ctx.base, "GET", "/api/capabilities");
    assert.ok(Array.isArray(caps.data.toolsets) && caps.data.toolsets.some((t) => t.name === "browser"));
  });
});
