import { spawn } from "node:child_process";

const port = Number(process.env.CHAT_SMOKE_PORT || 3267 + Math.floor(Math.random() * 400));
const timeoutMs = 45_000;

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

async function postChat(message, label) {
  const response = await fetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      label,
      agentId: "main",
      channel: "webchat",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Chat ${label} returned status ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const suffix = Date.now().toString(36);
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), OMNICLAW_DISABLE_USER_CONFIG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServerReady(child);

    const greeting = await postChat("hlo", `chat-smoke-greeting-${suffix}`);
    assert(greeting.reply && greeting.reply.length > 0, "Greeting reply should be non-empty.");
    assert(!greeting.reply.includes("Detected intent"), "Greeting reply should not expose debug intent text.");
    assert(greeting.toolOutputs.length === 0, "Greeting should not run tools.");

    const apiSetup = await postChat("api key setup", `chat-smoke-api-${suffix}`);
    assert(apiSetup.reply.includes("API key"), "API setup reply should explain API keys.");

    const research = await postChat("research OpenClaw system prompt", `chat-smoke-research-${suffix}`);
    assert(
      research.toolOutputs.some((item) => item.tool === "web_research"),
      "research requests should execute the real web_research tool.",
    );
    assert(
      research.run?.status === "completed",
      "research request should finish instead of hanging after planning.",
    );

    const task = await postChat("test karo", `chat-smoke-test-${suffix}`);
    const commands = task.toolOutputs.map((item) => item.output?.command || "");
    assert(commands.includes("npm.cmd run build"), "test karo should run npm.cmd run build.");
    assert(commands.includes("npm.cmd run test"), "test karo should run npm.cmd run test.");
    assert(
      task.toolOutputs.some(
        (item) => item.output?.command === "npm.cmd run build" && item.output?.execution?.status === "completed",
      ),
      "test karo build command should complete.",
    );

    const selfBuild = await postChat(
      "Codex plus OpenClaw combine karke OmniClaw self build plan",
      `chat-smoke-self-build-${suffix}`,
    );
    assert(
      selfBuild.toolOutputs.some((item) => item.tool === "self_build_plan"),
      "self-build request should call self_build_plan.",
    );
    assert(selfBuild.reply && selfBuild.reply.length > 0, "self-build reply should be non-empty.");

    console.log("Chat agent smoke test passed");
  } finally {
    child.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error("Chat agent smoke test failed:", error.message);
  process.exitCode = 1;
});
