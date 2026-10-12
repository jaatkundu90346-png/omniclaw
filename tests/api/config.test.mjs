// B1 step 7: config whitelist — provider label + ui object (R11: :3204).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "./_helpers.mjs";

const PORT = 3204;
const DATA = "./.tmp-test-data/config";
let ctx = null;

describe("config whitelist", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("accepts provider label", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/config", {
      provider: { label: "test-label" },
    });
    assert.equal(r.status, 200);
    const cfg = await apiJson(ctx.base, "GET", "/api/config");
    assert.equal(cfg.data.config.provider.label, "test-label");
  });

  it("accepts a full ui object and reflects it", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/config", {
      ui: { theme: "light", fontSize: 14, showSystemSessions: true, panelWidth: 320 },
    });
    assert.equal(r.status, 200);
    const cfg = await apiJson(ctx.base, "GET", "/api/config");
    assert.deepEqual(cfg.data.config.ui, {
      theme: "light", fontSize: 14, showSystemSessions: true, panelWidth: 320,
    });
  });

  it("rejects unknown ui keys", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/config", { ui: { bogus: 1 } });
    assert.equal(r.status, 400);
  });

  it("rejects mistyped ui values", async () => {
    const bad1 = await apiJson(ctx.base, "POST", "/api/config", { ui: { theme: "neon" } });
    assert.equal(bad1.status, 400);
    const bad2 = await apiJson(ctx.base, "POST", "/api/config", { ui: { fontSize: 99 } });
    assert.equal(bad2.status, 400);
    const bad3 = await apiJson(ctx.base, "POST", "/api/config", { ui: { showSystemSessions: "yes" } });
    assert.equal(bad3.status, 400);
  });

  it("rejects providerProfiles through /api/config", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/config", {
      providerProfiles: { x: { evil: 1 } },
    });
    assert.equal(r.status, 400);
  });
});
