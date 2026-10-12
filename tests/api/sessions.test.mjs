// B1 step 6: session workspace/model fields (R11: :3203 isolated, no model).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson } from "./_helpers.mjs";

const PORT = 3203;
const DATA = "./.tmp-test-data/sessions";
let ctx = null;

describe("session detail fields", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("imported sessions carry workspacePath/model/agentId", async () => {
    const imp = await apiJson(ctx.base, "POST", "/api/sessions/import", {
      session: {
        label: "meta-probe", agentId: "main", channel: "webchat",
        workspacePath: "C:\\Probe\\ws", model: "probe-model",
      },
      transcript: [],
    });
    assert.equal(imp.status, 200);
    const got = await apiJson(ctx.base, "GET", `/api/sessions/${imp.data.sessionId}`);
    assert.equal(got.status, 200);
    assert.equal(got.data.session.workspacePath, "C:\\Probe\\ws");
    assert.equal(got.data.session.model, "probe-model");
    assert.equal(got.data.session.agentId, "main");
    assert.ok("workspaceId" in got.data.session);
  });

  it("legacy sessions backfill workspacePath:null", async () => {
    const imp = await apiJson(ctx.base, "POST", "/api/sessions/import", {
      session: { label: "legacy-probe" },
      transcript: [],
    });
    assert.equal(imp.status, 200);
    const got = await apiJson(ctx.base, "GET", `/api/sessions/${imp.data.sessionId}`);
    assert.equal(got.status, 200);
    assert.equal(got.data.session.workspacePath, null);
    assert.equal(got.data.session.model, null);
  });

  it("list summaries include the four fields", async () => {
    const list = await apiJson(ctx.base, "GET", "/api/sessions?limit=10");
    assert.equal(list.status, 200);
    assert.ok(list.data.sessions.length > 0);
    for (const s of list.data.sessions) {
      assert.ok("workspacePath" in s, "summary missing workspacePath");
      assert.ok("workspaceId" in s, "summary missing workspaceId");
      assert.ok("model" in s, "summary missing model");
      assert.ok("agentId" in s, "summary missing agentId");
    }
  });

  it("workspace filter returns only that folder's sessions + totalMatched", async () => {
    const other = await apiJson(ctx.base, "POST", "/api/sessions/import", {
      session: {
        label: "other-ws", agentId: "main", channel: "webchat",
        workspacePath: "C:\\Other\\proj",
      },
      transcript: [],
    });
    assert.equal(other.status, 200);

    const filtered = await apiJson(ctx.base, "GET", `/api/sessions?limit=50&workspace=${encodeURIComponent("C:\\Probe\\ws")}`);
    assert.equal(filtered.status, 200);
    assert.ok(Array.isArray(filtered.data.sessions));
    assert.ok(filtered.data.sessions.length >= 1);
    for (const s of filtered.data.sessions) {
      const p = String(s.workspacePath || "").replace(/\\/g, "/").toLowerCase();
      assert.equal(p, "c:/probe/ws", `unexpected session in workspace filter: ${s.workspacePath}`);
    }
    assert.ok(filtered.data.workspace === "C:\\Probe\\ws");
    assert.ok(Number(filtered.data.totalMatched) >= filtered.data.sessions.length);

    const empty = await apiJson(ctx.base, "GET", `/api/sessions?limit=50&workspace=${encodeURIComponent("C:\\No\\Such\\Folder")}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.sessions.length, 0);
    assert.equal(empty.data.totalMatched, 0);
  });

  it("summary GET 404s by default; generate=1 on empty transcript returns 404 session or builds", async () => {
    const imp = await apiJson(ctx.base, "POST", "/api/sessions/import", {
      session: { label: "sum-probe", agentId: "main", channel: "webchat" },
      transcript: [],
    });
    assert.equal(imp.status, 200);
    const sid = imp.data.sessionId;

    const missing = await apiJson(ctx.base, "GET", `/api/sessions/${sid}/summary`);
    assert.equal(missing.status, 404);

    // Empty transcript → summarizer returns null → still 404 (honest).
    const gen = await apiJson(ctx.base, "GET", `/api/sessions/${sid}/summary?generate=1`);
    assert.ok(gen.status === 404 || gen.status === 200, `unexpected status ${gen.status}`);
    if (gen.status === 200) {
      assert.ok(gen.data.summary && typeof gen.data.summary.text === "string");
    }

    const noSession = await apiJson(ctx.base, "GET", "/api/sessions/session_missing_xyz/summary?generate=1");
    assert.equal(noSession.status, 404);
  });
});
