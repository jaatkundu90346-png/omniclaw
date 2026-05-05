import { spawn } from "node:child_process";

const port = Number(process.env.SMOKE_PORT || 3260);
const timeoutMs = 15_000;

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server readiness timeout")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (text.includes(`http://localhost:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (code=${code ?? "unknown"})`));
    });
  });
}

async function run() {
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForReady(child);

    const authRes = await fetch(`http://localhost:${port}/api/auth/overview`);
    if (!authRes.ok) {
      throw new Error(`Auth overview failed with ${authRes.status}`);
    }
    const authData = await authRes.json();
    if (!authData?.overview?.gateway?.configured) {
      throw new Error("Gateway token not configured");
    }

    const providerRes = await fetch(`http://localhost:${port}/api/provider/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "openai" }),
    });
    if (!providerRes.ok) {
      throw new Error(`Provider test failed with ${providerRes.status}`);
    }
    const providerData = await providerRes.json();
    if (!providerData?.candidate?.mode) {
      throw new Error("Provider test response missing candidate mode");
    }

    console.log("Auth+Provider smoke test passed");
  } finally {
    child.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error("Auth+Provider smoke test failed:", error.message);
  process.exitCode = 1;
});
