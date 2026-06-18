import { spawn } from "node:child_process";

const port = Number(process.env.SMOKE_PORT || 3257 + Math.floor(Math.random() * 400));
const timeoutMs = 15_000;

function waitForServerReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (text.includes(`http://localhost:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });

    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before readiness check (code=${code ?? "unknown"})`));
    });
  });
}

async function run() {
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServerReady(child);

    const response = await fetch(`http://localhost:${port}/api/health`);
    if (!response.ok) {
      throw new Error(`Health endpoint returned status ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error("Health endpoint payload is not ok");
    }

    const inspectorResponse = await fetch(`http://localhost:${port}/api/agents/main/inspector`);
    if (!inspectorResponse.ok) {
      throw new Error(`Agent inspector endpoint returned status ${inspectorResponse.status}`);
    }
    const inspectorPayload = await inspectorResponse.json();
    if (!inspectorPayload.inspector?.workspace || !inspectorPayload.inspector?.memory) {
      throw new Error("Agent inspector payload is missing workspace or memory.");
    }

    console.log("Health smoke test passed");
  } finally {
    child.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error("Health smoke test failed:", error.message);
  process.exitCode = 1;
});
