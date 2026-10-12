// Smoke test for McpClient newline-delimited JSON (NDJSON) stdio framing.
// Run: node scripts/mcp-ndjson-smoke.mjs
import { McpClient } from "../src/core/mcp-client.js";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}`); }
}

function newClient() {
  return new McpClient({ id: "test", command: "noop", transport: "stdio" });
}

// 1. A single complete NDJSON line resolves the matching pending request.
{
  const c = newClient();
  let resolved = null;
  c._pending.set(1, { resolve: (r) => { resolved = r; }, reject: () => {} });
  c._buffer = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n';
  c._processBuffer();
  ok(resolved && resolved.ok === true, "single NDJSON line resolves request");
  ok(c._pending.size === 0, "pending cleared after resolve");
}

// 2. Chunked delivery: a partial line then its completion.
{
  const c = newClient();
  let resolved = null;
  c._pending.set(2, { resolve: (r) => { resolved = r; }, reject: () => {} });
  c._buffer = '{"jsonrpc":"2.0","id":2,"resu';
  c._processBuffer();
  ok(resolved === null, "partial line does not resolve yet");
  c._buffer += 'lt":{"v":42}}\n';
  c._processBuffer();
  ok(resolved && resolved.v === 42, "completed chunk resolves request");
}

// 3. Multiple messages in one buffer.
{
  const c = newClient();
  const got = {};
  c._pending.set(3, { resolve: (r) => { got[3] = r; }, reject: () => {} });
  c._pending.set(4, { resolve: (r) => { got[4] = r; }, reject: () => {} });
  c._buffer = '{"jsonrpc":"2.0","id":3,"result":"a"}\n{"jsonrpc":"2.0","id":4,"result":"b"}\n';
  c._processBuffer();
  ok(got[3] === "a" && got[4] === "b", "two messages in one buffer both parsed");
}

// 4. Non-JSON banner line is ignored; following JSON still parses.
{
  const c = newClient();
  let resolved = null;
  c._pending.set(5, { resolve: (r) => { resolved = r; }, reject: () => {} });
  c._buffer = 'my-mcp-server v1.0 starting...\n{"jsonrpc":"2.0","id":5,"result":"ok"}\n';
  c._processBuffer();
  ok(resolved === "ok", "non-JSON banner ignored, JSON after it parsed");
}

// 5. id:0 is a valid request id (the `!= null` fix).
{
  const c = newClient();
  let resolved = null;
  c._pending.set(0, { resolve: (r) => { resolved = r; }, reject: () => {} });
  c._buffer = '{"jsonrpc":"2.0","id":0,"result":"zero"}\n';
  c._processBuffer();
  ok(resolved === "zero", "id 0 is handled (not treated as falsy)");
}

// 6. Error responses reject.
{
  const c = newClient();
  let rejected = null;
  c._pending.set(6, { resolve: () => {}, reject: (e) => { rejected = e; } });
  c._buffer = '{"jsonrpc":"2.0","id":6,"error":{"code":-32601,"message":"method not found"}}\n';
  c._processBuffer();
  ok(rejected && /method not found/.test(rejected.message), "error response rejects with message");
}

// 7. Notifications (method, no id) emit instead of throwing.
{
  const c = newClient();
  let note = null;
  c.on("notification", (m) => { note = m; });
  c._buffer = '{"jsonrpc":"2.0","method":"notifications/message","params":{"x":1}}\n';
  c._processBuffer();
  ok(note && note.method === "notifications/message", "server notification emitted");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
