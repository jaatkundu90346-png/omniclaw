// D2/D4: model-test probe + registry persistence (R11: :3211, R13).
// All offline-safe: unreachable endpoints fail gracefully, no real calls.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "./_helpers.mjs";

const PORT = 3211;
const DATA = "./.tmp-test-data/subagent-models";
let ctx = null;

describe("provider model-test + registry", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
  });

  after(async () => {
    if (ctx) { stopTestServer(ctx.child); ctx = null; }
  });

  it("registry starts empty with the documented shape", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/models/registry");
    assert.equal(status, 200);
    assert.ok(data.models && typeof data.models === "object");
  });

  it("model-test rejects a missing model id with EINVAL", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/provider/model-test", {});
    assert.equal(status, 200);
    // Schema validation fails closed before the tool runs (blocked), or the
    // tool returns ok:false/code:EINVAL — either way no probe is attempted.
    assert.ok(data.ok === false || data.blocked === true, `rejected, got ${JSON.stringify(data).slice(0, 160)}`);
  });

  it("model-test rejects a missing endpoint with EINVAL", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/provider/model-test", { model: "x/y" });
    assert.equal(status, 200);
    assert.equal(data.ok, false);
    assert.equal(data.code, "EINVAL");
  });

  it("model-test fails gracefully on an unreachable endpoint", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/provider/model-test", {
      model: "dead/model", baseUrl: "http://127.0.0.1:9/v1",
    });
    assert.equal(status, 200);
    assert.equal(data.ok, false);
    assert.ok(data.error, "graceful error, not a throw");
  });

  it("failed probes persist to the registry", async () => {
    const { data } = await apiJson(ctx.base, "GET", "/api/models/registry");
    const key = "http://127.0.0.1:9/v1::dead/model";
    assert.ok(data.models[key], "probe observation persisted");
    assert.ok(data.models[key].lastTested, "probe timestamp recorded");
  });
});
