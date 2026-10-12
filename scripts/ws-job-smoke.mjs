const gatewayToken = process.env.OMNICLAW_GATEWAY_TOKEN || "";
const ws = new WebSocket("ws://localhost:3147/ws");
let queuedJobId = "";
let passed = false;
const timeout = setTimeout(() => {
  console.error("WebSocket job smoke timed out");
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
    console.log("WS job auth gate smoke passed");
    passed = true;
    ws.close();
    return;
  }

  if (data.type === "connected") {
    send({ type: "req", id: "plugins", method: "plugins.list", params: {} });
    send({
      type: "req",
      id: "job",
      method: "jobs.enqueueTool",
      params: {
        tool: "plugin_echo",
        input: { message: "ws job" },
      },
    });
  }

  if (data.type === "res" && data.id === "job") {
    queuedJobId = data.payload.id;
  }

  if (data.type === "event" && data.event === "job.completed" && data.payload.jobId === queuedJobId) {
    send({ type: "req", id: "jobs", method: "jobs.list", params: { limit: 3 } });
  }

  if (data.type === "res" && data.id === "jobs") {
    passed = true;
    ws.close();
  }
});

ws.addEventListener("close", () => {
  clearTimeout(timeout);
  console.log("WS job smoke closed");
  if (!passed) {
    console.error("WebSocket job smoke closed before auth gate or job response");
    process.exit(1);
  }
});
