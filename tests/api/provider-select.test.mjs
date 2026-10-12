// Atomic provider selection: POST /api/provider/select commits
// connection+model as one verified operation (R11: :3211, scratch data dir).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "./_helpers.mjs";

const PORT = 3211;
const DATA = "./.tmp-test-data/provider-select";
let ctx = null;

describe("atomic provider selection", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("saves a keyless test profile", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/provider/profile/save", {
      name: "sel-test", baseUrl: "https://sel-test.example/v1", model: "sel-base-model",
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  it("commits profile+model atomically and persists", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/provider/select", {
      profileId: "sel-test", model: "test-model-x",
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.deepEqual(r.data.applied, { profileId: "sel-test", model: "test-model-x" });
    assert.equal(r.data.scope, "global");
    const cfg = await apiJson(ctx.base, "GET", "/api/config");
    assert.equal(cfg.data.config.provider.model, "test-model-x");
    assert.equal(cfg.data.config.provider.baseUrl, "https://sel-test.example/v1");
  });

  it("model-only select keeps the connection", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/provider/select", { model: "solo-model" });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    const cfg = await apiJson(ctx.base, "GET", "/api/config");
    assert.equal(cfg.data.config.provider.model, "solo-model");
    assert.equal(cfg.data.config.provider.baseUrl, "https://sel-test.example/v1");
  });

  it("rejects unknown profiles", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/provider/select", {
      profileId: "no-such-profile", model: "x",
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.ok, false);
  });

  it("blocks missing models via schema validation", async () => {
    const r = await apiJson(ctx.base, "POST", "/api/provider/select", { profileId: "sel-test" });
    // Tool-layer convention: schema failures are {blocked:true}, not throws.
    assert.equal(r.status, 200);
    assert.equal(r.data.blocked, true);
    assert.ok((r.data.errors || []).some((e) => /model/.test(e)));
  });
});
