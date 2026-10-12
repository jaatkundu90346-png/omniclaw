// 4B.1: global approval surface backend (R11: :3206, R13).
// - caps.approvalToolTimeoutMs matches the tool-side 5-minute wait.
// - ask-mode exec creates a pending approval carrying sessionId/runId (here
//   empty: tools/run has no session context), summary, tool, command, expiresAt.
// - approval.requested is visible on GET /api/gateway events (= the same
//   fan-out that feeds GET /api/events SSE + chat-stream interesting filter).
// - GET /api/approvals?status=pending filters; resolve unblocks the tool call.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, apiJson, lanIp } from "./_helpers.mjs";

const PORT = 3206;
const DATA = "./.tmp-test-data/approvals";
let ctx = null;

describe("global approvals (4B.1)", () => {
  before(async () => {
    ctx = await startTestServer({ port: PORT, dataDir: DATA });
  });

  after(() => {
    if (ctx) stopTestServer(ctx.child);
  });

  it("caps exposes approvalToolTimeoutMs = 5 minutes", async () => {
    const { status, data } = await apiJson(ctx.base, "GET", "/api/capabilities");
    assert.equal(status, 200);
    assert.equal(data.approvalToolTimeoutMs, 5 * 60 * 1000);
  });

  it("ask-mode exec blocks on a pending approval, then runs after Allow", async () => {
    const cfg = await apiJson(ctx.base, "POST", "/api/config", {
      tools: { shellExecution: { approvalMode: "always" } },
    });
    assert.equal(cfg.status, 200);

    // Fire the tool call WITHOUT awaiting: it parks inside the approval wait.
    const runPromise = apiJson(ctx.base, "POST", "/api/tools/run", {
      tool: "exec",
      input: { command: "echo approval-probe-4b1" },
    });

    // The pending approval appears (poll: tool boot + permission checks first).
    let pending = null;
    for (let i = 0; i < 40 && !pending; i++) {
      const { data } = await apiJson(ctx.base, "GET", "/api/approvals?status=pending");
      pending = (data.approvals || []).find((a) => (a.summary || "").includes("approval-probe-4b1"));
      if (!pending) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(pending, "expected a pending approval for the probe command");
    assert.equal(pending.type, "shell-exec");
    assert.equal(pending.tool, "exec");
    assert.equal(pending.payload.command, "echo approval-probe-4b1");
    assert.ok("sessionId" in pending && "runId" in pending);
    // expiresAt ≈ createdAt + 30min TTL.
    const ttl = Date.parse(pending.expiresAt) - Date.parse(pending.createdAt);
    assert.ok(Math.abs(ttl - 30 * 60 * 1000) < 60 * 1000, `TTL off: ${ttl}`);

    // The enriched event is on the gateway event log (= /api/events fan-out).
    const gw = await apiJson(ctx.base, "GET", "/api/gateway");
    const ev = (gw.data.events || []).find(
      (e) => e.event === "approval.requested" && e.payload.approvalId === pending.id,
    );
    assert.ok(ev, "approval.requested missing from gateway events");
    assert.equal(ev.payload.summary, pending.summary);
    assert.equal(ev.payload.tool, "exec");
    assert.equal(ev.payload.command, "echo approval-probe-4b1");
    assert.equal(ev.payload.expiresAt, pending.expiresAt);

    // Allow from the (future) banner path unblocks the parked tool call.
    const res = await apiJson(ctx.base, "POST", "/api/approvals/resolve", {
      approvalId: pending.id, decision: "approved", note: "",
    });
    assert.equal(res.status, 200);
    const done = await runPromise;
    assert.equal(done.status, 200);
    const out = done.data.result || done.data.output || {};
    assert.match(JSON.stringify(out), /approval-probe-4b1/);

    // Default list still returns everything (additive ?status=).
    const all = await apiJson(ctx.base, "GET", "/api/approvals");
    assert.ok((all.data.approvals || []).some((a) => a.id === pending.id));

    // Restore ask-off (test dir is isolated, but leave it clean).
    await apiJson(ctx.base, "POST", "/api/config", {
      tools: { shellExecution: { approvalMode: "auto" } },
    });
  });

  it("tools/run passes sessionId/runId through to the approval (4B.1)", async () => {
    await apiJson(ctx.base, "POST", "/api/config", {
      tools: { shellExecution: { approvalMode: "always" } },
    });
    const runPromise = apiJson(ctx.base, "POST", "/api/tools/run", {
      tool: "exec",
      input: { command: "echo session-probe-4b1" },
      sessionId: "sess-probe-1",
      runId: "run-probe-1",
    });
    let pending = null;
    for (let i = 0; i < 40 && !pending; i++) {
      const { data } = await apiJson(ctx.base, "GET", "/api/approvals?status=pending");
      pending = (data.approvals || []).find((a) => (a.summary || "").includes("session-probe-4b1"));
      if (!pending) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(pending, "expected a pending approval for the session probe");
    assert.equal(pending.sessionId, "sess-probe-1");
    assert.equal(pending.runId, "run-probe-1");
    const deny = await apiJson(ctx.base, "POST", "/api/approvals/resolve", {
      approvalId: pending.id, decision: "denied", note: "",
    });
    assert.equal(deny.status, 200);
    const done = await runPromise;
    assert.equal(done.status, 200);
    assert.match(JSON.stringify(done.data), /blocked/);
    await apiJson(ctx.base, "POST", "/api/config", {
      tools: { shellExecution: { approvalMode: "auto" } },
    });
  });

  it("ask_user parks an open question, then answers via the API (Q1)", async () => {
    const runPromise = apiJson(ctx.base, "POST", "/api/tools/run", {
      tool: "ask_user",
      input: {
        question: "Probe color?",
        options: [{ label: "Dark", recommended: true }, { label: "Light" }],
      },
      sessionId: "sess-q1",
      runId: "run-q1",
    });
    let pending = null;
    for (let i = 0; i < 40 && !pending; i++) {
      const { data } = await apiJson(ctx.base, "GET", "/api/questions?status=pending");
      pending = (data.questions || []).find((q) => q.text === "Probe color?");
      if (!pending) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(pending, "expected an open question for the probe");
    assert.equal(pending.sessionId, "sess-q1");
    assert.equal(pending.runId, "run-q1");
    assert.equal(pending.options.length, 2);
    assert.ok(Date.parse(pending.expiresAt) > Date.now(), "expiresAt must be in the future");
    const ans = await apiJson(ctx.base, "POST", "/api/questions/answer", {
      questionId: pending.id, answer: "Dark",
    });
    assert.equal(ans.status, 200);
    assert.equal(ans.data.ok, true);
    const done = await runPromise;
    assert.equal(done.status, 200);
    assert.match(JSON.stringify(done.data), /"answered":true/);
    const after = await apiJson(ctx.base, "GET", "/api/questions?status=pending");
    assert.ok(!(after.data.questions || []).some((q) => q.id === pending.id), "answered question leaves the list");
  });
});

describe("questions route loopback gate (Q1)", () => {
  let wan = null;
  const WAN_PORT = 3207;
  before(async function () {
    const ip = lanIp();
    if (!ip) {
      console.warn("no LAN IP — skipping non-loopback test");
      return this.skip();
    }
    wan = await startTestServer({ port: WAN_PORT, dataDir: "./.tmp-test-data/questions-wan", host: "0.0.0.0" });
    wan.ip = ip;
  });

  after(() => {
    if (wan) stopTestServer(wan.child);
  });

  it("rejects non-loopback callers with EPERM", async () => {
    if (!wan) return;
    const r = await fetch(`http://${wan.ip}:${WAN_PORT}/api/questions?status=pending`);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "EPERM");
  });

  it("still serves loopback on the same instance", async () => {
    if (!wan) return;
    const { status, data } = await apiJson(`http://localhost:${WAN_PORT}`, "GET", "/api/questions?status=pending");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.questions));
  });
});
