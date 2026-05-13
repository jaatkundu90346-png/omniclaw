import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.CHAT_SMOKE_PORT || 3267 + Math.floor(Math.random() * 400));
const timeoutMs = 45_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const profilePath = path.join(rootDir, "workspace", "agents", "main", "PROFILE.md");

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

function assertToolSummaries(toolOutputs, label) {
  assert(Array.isArray(toolOutputs), `${label} should include toolOutputs array.`);
  for (const item of toolOutputs) {
    assert(item.toolSummary?.status, `${label} tool ${item.tool || "unknown"} should include toolSummary.status.`);
    assert(item.toolSummary?.summary, `${label} tool ${item.tool || "unknown"} should include toolSummary.summary.`);
  }
}

async function run() {
  const suffix = Date.now().toString(36);
  const originalProfile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : null;
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

    const profileSet = await postChat(`mera name SmokeUser${suffix} hai`, `chat-smoke-profile-${suffix}`);
    assert(profileSet.reply.includes(`SmokeUser${suffix}`), "Profile update should be reflected immediately.");
    const profileRecall = await postChat("mera name kya hai", `chat-smoke-profile-${suffix}`);
    assert(profileRecall.reply.includes(`SmokeUser${suffix}`), "Profile recall should survive the next message in the same lane.");

    const research = await postChat("research OpenClaw system prompt", `chat-smoke-research-${suffix}`);
    assert(
      research.toolOutputs.some((item) => item.tool === "web_research"),
      "research requests should execute the real web_research tool.",
    );
    assert(
      research.run?.status === "completed",
      "research request should finish instead of hanging after planning.",
    );
    assertToolSummaries(research.toolOutputs, "research request");

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
    assertToolSummaries(task.toolOutputs, "test request");

    const selfBuild = await postChat(
      "Codex plus OpenClaw combine karke OmniClaw self build plan",
      `chat-smoke-self-build-${suffix}`,
    );
    assert(
      selfBuild.toolOutputs.some((item) => item.tool === "self_build_plan"),
      "self-build request should call self_build_plan.",
    );
    assert(selfBuild.reply && selfBuild.reply.length > 0, "self-build reply should be non-empty.");
    assertToolSummaries(selfBuild.toolOutputs, "self-build request");

    const doctor = await postChat("/doctor", `chat-smoke-hermes-doctor-${suffix}`);
    assert(
      doctor.toolOutputs.some((item) => item.tool === "provider_status"),
      "/doctor should call provider_status.",
    );
    assert(
      doctor.toolOutputs.some((item) => item.tool === "computer_access_status"),
      "/doctor should call computer_access_status.",
    );
    assert(doctor.reply.includes("/doctor complete"), "/doctor should return a grounded doctor reply.");
    assertToolSummaries(doctor.toolOutputs, "hermes doctor request");

    const hermes = await postChat("hermes agent reference compare karo", `chat-smoke-hermes-ref-${suffix}`);
    assert(
      hermes.toolOutputs.some((item) => item.tool === "hermes_reference_status"),
      "Hermes reference requests should call hermes_reference_status.",
    );
    assert(hermes.reply.includes("Hermes reference mapping"), "Hermes reference reply should be grounded.");
    assertToolSummaries(hermes.toolOutputs, "hermes reference request");

    const hermesTools = await postChat("hermes tools copy status", `chat-smoke-hermes-tools-${suffix}`);
    assert(
      hermesTools.toolOutputs.some((item) => item.tool === "hermes_tool_catalog"),
      "Hermes tools request should call hermes_tool_catalog.",
    );
    assert(
      hermesTools.toolOutputs.some((item) => item.tool === "hermes_skill_scan"),
      "Hermes tools request should scan Hermes skills.",
    );
    assert(hermesTools.reply.includes("Hermes tool import status"), "Hermes tools reply should be grounded.");
    assertToolSummaries(hermesTools.toolOutputs, "hermes tools request");

    const promptAssembly = await postChat(
      "Hermes architecture system prompt assembly status",
      `chat-smoke-prompt-assembly-${suffix}`,
    );
    assert(
      promptAssembly.toolOutputs.some((item) => item.tool === "prompt_assembly_status"),
      "Prompt assembly requests should call prompt_assembly_status.",
    );
    assert(
      promptAssembly.reply.includes("prompt assembly status"),
      "Prompt assembly reply should be grounded.",
    );
    assertToolSummaries(promptAssembly.toolOutputs, "prompt assembly request");

    console.log("Chat agent smoke test passed");
  } finally {
    child.kill("SIGTERM");
    if (originalProfile == null) {
      fs.rmSync(profilePath, { force: true });
    } else {
      fs.writeFileSync(profilePath, originalProfile, "utf8");
    }
  }
}

run().catch((error) => {
  console.error("Chat agent smoke test failed:", error.message);
  process.exitCode = 1;
});
