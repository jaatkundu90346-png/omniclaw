// Smoke test for the upgraded MCP client transport that makes Composio-style
// hosted MCP servers work: auth headers, Streamable-HTTP with SSE responses,
// mcp-session-id round-tripping, and tools/list + tools/call.
//
// Spins up a minimal in-process MCP server (no network deps) that:
//   • requires an Authorization header (rejects without it),
//   • answers tools/call with an SSE (text/event-stream) body,
//   • answers initialize/tools/list with plain JSON,
//   • hands back and expects an mcp-session-id header.
//
// Run: node scripts/mcp-composio-smoke.mjs

import http from "node:http";
import assert from "node:assert";
import { McpClient } from "../src/core/mcp-client.js";

const AUTH = "Bearer test-secret-123";
const SESSION = "sess-abc-789";

function rpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // Enforce auth like Composio does.
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" } }));
      return;
    }
    let msg = {};
    try { msg = JSON.parse(body); } catch {}
    const { id, method } = msg;

    if (method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": SESSION });
      res.end(JSON.stringify(rpc(id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock", version: "1" } })));
      return;
    }
    if (method === "notifications/initialized") {
      res.writeHead(202); res.end(); return;
    }
    if (method === "tools/list") {
      // Require the session id was echoed back.
      assert.equal(req.headers["mcp-session-id"], SESSION, "session id not echoed on tools/list");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(rpc(id, {
        tools: [{ name: "gmail_send", description: "Send an email", inputSchema: { type: "object", properties: { to: { type: "string" } } } }],
      })));
      return;
    }
    if (method === "tools/call") {
      // Answer as an SSE stream (the case the old client could not parse).
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const payload = JSON.stringify(rpc(id, { content: [{ type: "text", text: `sent to ${msg.params?.arguments?.to}` }], isError: false }));
      res.end(`event: message\ndata: ${payload}\n\n`);
      return;
    }
    res.writeHead(400); res.end();
  });
});

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;

  // 1) Without auth -> initialize must fail.
  const noAuth = new McpClient({ id: "composio", url, transport: "http" });
  let failed = false;
  try { await noAuth.connect(); } catch { failed = true; }
  assert.ok(failed, "expected connect to fail without auth header");
  console.log("✓ rejects connection without auth header");

  // 2) With bearer -> connects, lists tools.
  const client = new McpClient({ id: "composio", url, transport: "http", bearer: "test-secret-123" });
  await client.connect();
  assert.ok(client.connected, "client should be connected");
  assert.equal(client.sessionId, SESSION, "should capture mcp-session-id");
  assert.equal(client.tools.length, 1, "should list one tool");
  assert.equal(client.tools[0].id, "mcp_composio_gmail_send", "tool id should be namespaced");
  console.log("✓ connects with auth, captures session id, lists tools");

  // 3) tools/call over SSE -> parsed content.
  const result = await client.callTool("gmail_send", { to: "bro@omniclaw.dev" });
  assert.ok(Array.isArray(result.content), "result should have content array");
  assert.equal(result.content[0].text, "sent to bro@omniclaw.dev", "SSE content should be parsed");
  assert.equal(result.isError, false);
  console.log("✓ tools/call parses SSE response body");

  // 4) Header via ${ENV} placeholder expansion.
  process.env.SMOKE_KEY = "test-secret-123";
  const envClient = new McpClient({ id: "composio", url, transport: "http", headers: { Authorization: "Bearer ${SMOKE_KEY}" } });
  await envClient.connect();
  assert.ok(envClient.connected, "env-placeholder auth should connect");
  console.log("✓ expands ${ENV} placeholders in header values");

  client.disconnect();
  envClient.disconnect();
  server.close();
  console.log("\nALL MCP COMPOSIO SMOKE CHECKS PASSED");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  server.close();
  process.exit(1);
});
