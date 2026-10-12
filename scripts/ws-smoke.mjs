const gatewayToken = process.env.OMNICLAW_GATEWAY_TOKEN || "";
const ws = new WebSocket("ws://localhost:3147/ws");
let passed = false;
const timeout = setTimeout(() => {
  console.error("WebSocket smoke timed out");
  ws.close();
  process.exit(1);
}, 10_000);

function send(obj) {
  ws.send(JSON.stringify(obj));
}

ws.addEventListener("open", () => {
  send({ type: "connect", role: "operator", gatewayToken });
});

ws.addEventListener("message", (event) => {
  const data = JSON.parse(String(event.data));
  console.log("IN", data);

  if (data.type === "pairing_required" || data.type === "device_token_required") {
    console.log("WS auth gate smoke passed");
    passed = true;
    ws.close();
    return;
  }

  if (data.type === "connected") {
    send({ type: "req", id: "1", method: "gateway.overview", params: {} });
    send({
      type: "req",
      id: "2",
      method: "agent.send",
      params: { message: 'run shell "dir"', label: "ws-smoke" },
    });
  }

  if (data.type === "res" && data.id === "1") {
    send({ type: "req", id: "3", method: "sessions.list", params: { limit: 5 } });
  }

  if (data.type === "res" && data.id === "3") {
    passed = true;
    ws.close();
  }
});

ws.addEventListener("close", () => {
  clearTimeout(timeout);
  console.log("WS closed");
  if (!passed) {
    console.error("WebSocket smoke closed before auth gate or RPC response");
    process.exit(1);
  }
});
