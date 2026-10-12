// B1 step 5: /api/system/* routes (R11: :3201 isolated, spawns stubbed).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson, lanIp } from "./_helpers.mjs";

const PORT = 3201;
const DATA = "./.tmp-test-data/sys";
let ctx = null;

describe("system routes", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA, env: { OMNICLAW_TEST_NO_SPAWN: "1" } });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("reveal rejects traversal outside allowed roots", async () => {
    const evil = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hostname";
    const { status, data } = await apiJson(ctx.base, "POST", "/api/system/reveal", { path: evil });
    assert.equal(status, 403);
    assert.equal(data.code, "EPERM");
  });

  it("reveal stubs explorer with exact argv", async () => {
    const target = process.platform === "win32" ? "C:\\Temp" : "/tmp";
    const { status, data } = await apiJson(ctx.base, "POST", "/api/system/reveal", { path: target });
    if (process.platform !== "win32") {
      assert.equal(status, 400);
      return;
    }
    assert.equal(status, 200);
    assert.equal(data.stubbed, true);
    assert.equal(data.bin, "explorer.exe");
    assert.deepEqual(data.args, [`/select,${data.path}`]);
  });

  it("open default app stubs explorer", async () => {
    const target = process.platform === "win32" ? "C:\\Temp" : "/tmp";
    const { status, data } = await apiJson(ctx.base, "POST", "/api/system/open", { path: target });
    if (process.platform !== "win32") {
      assert.equal(status, 400);
      return;
    }
    assert.equal(status, 200);
    assert.equal(data.stubbed, true);
    assert.equal(data.bin, "explorer.exe");
    assert.deepEqual(data.args, [data.path]);
  });

  it("open rejects unknown app values", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/system/open", {
      path: "C:\\Temp", app: "notepad-evil",
    });
    if (process.platform !== "win32") {
      assert.equal(status, 400);
      return;
    }
    assert.equal(status, 400);
    assert.equal(data.code, "EINVAL");
  });

  it("open vscode without a binary is 404 ENOENT", async () => {
    const { status, data } = await apiJson(ctx.base, "POST", "/api/system/open", {
      path: "C:\\Temp", app: "vscode",
    });
    if (process.platform !== "win32") {
      assert.equal(status, 400);
      return;
    }
    // Either VS Code is installed (stubbed ok) or it is honestly 404.
    if (status === 404) {
      assert.equal(data.code, "ENOENT");
    } else {
      assert.equal(status, 200);
      assert.equal(data.stubbed, true);
    }
  });
});

describe("system routes loopback gate", () => {
  // Genuine non-loopback check: bind-all instance, connect via LAN IP so
  // remoteAddress is NOT loopback (x-forwarded-for is never trusted).
  let wan = null;
  const WAN_PORT = 3202;
  before(async function () {
    const ip = lanIp();
    if (!ip) {
      console.warn("no LAN IP — skipping non-loopback test");
      return this.skip();
    }
    wan = await startTestServer({
      port: WAN_PORT, dataDir: "./.tmp-test-data/sys-wan",
      host: "0.0.0.0", env: { OMNICLAW_TEST_NO_SPAWN: "1" },
    });
    wan.ip = ip;
  });

  after(() => {
    if (wan) stopTestServer(wan.child);
  });

  it("rejects non-loopback callers with EPERM", async () => {
    if (!wan) return;
    const r = await fetch(`http://${wan.ip}:${WAN_PORT}/api/system/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" },
      body: JSON.stringify({ path: "C:\\Temp" }),
    });
    assert.equal(r.status, 403);
    const data = await r.json();
    assert.equal(data.code, "EPERM");
  });

  it("still serves loopback on the same instance", async () => {
    if (!wan) return;
    const { status, data } = await apiJson(`http://localhost:${WAN_PORT}`, "GET", "/api/capabilities");
    assert.equal(status, 200);
    assert.equal(typeof data.version, "string");
  });
});
