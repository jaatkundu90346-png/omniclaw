import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.CHAT_SMOKE_PORT || 3267 + Math.floor(Math.random() * 400));
const timeoutMs = 45_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const smokeRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-chat-smoke-"));
const profilePath = path.join(smokeRootDir, "workspace", "agents", "main", "PROFILE.md");

function copySmokeRuntime() {
  for (const file of ["package.json", "package-lock.json", "server.js"]) {
    const source = path.join(rootDir, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(smokeRootDir, file));
    }
  }
  for (const dir of ["config", "public", "scripts", "src", "workspace", "plugins"]) {
    const source = path.join(rootDir, dir);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(smokeRootDir, dir), {
        recursive: true,
        force: true,
        filter: (sourcePath) => !sourcePath.includes(`${path.sep}node_modules${path.sep}`),
      });
    }
  }
}

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
  copySmokeRuntime();
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      OMNICLAW_DISABLE_USER_CONFIG: "1",
      OMNICLAW_ROOT_DIR: smokeRootDir,
    },
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

    const terminalRun = await postChat('run terminal command "Get-Date"', `chat-smoke-terminal-run-${suffix}`);
    assert(
      terminalRun.toolOutputs.some((item) => item.tool === "run_terminal_command"),
      "terminal command request should execute run_terminal_command.",
    );
    assert(
      terminalRun.toolOutputs.some((item) => item.output?.execution?.status === "completed" || item.output?.status === "completed"),
      "terminal command should complete through governed execution.",
    );
    assertToolSummaries(terminalRun.toolOutputs, "terminal command request");

    const computerList = await postChat("list computer folder home", `chat-smoke-computer-list-${suffix}`);
    assert(
      computerList.toolOutputs.some((item) => item.tool === "list_computer_directory"),
      "computer folder listing should execute list_computer_directory.",
    );
    assertToolSummaries(computerList.toolOutputs, "computer folder list request");

    const modelList = await postChat("fetch models", `chat-smoke-model-list-${suffix}`);
    assert(
      modelList.toolOutputs.some((item) => item.tool === "list_provider_models"),
      "model fetch request should execute list_provider_models.",
    );
    assertToolSummaries(modelList.toolOutputs, "provider model list request");

    const realTask = await postChat("real task strong bna tools aur skills product ready karo", `chat-smoke-real-task-${suffix}`);
    assert(
      realTask.toolOutputs.some((item) => item.tool === "real_task_health"),
      "real-task hardening request should execute real_task_health.",
    );
    assert(
      realTask.reply.includes("Real-task health"),
      "real-task hardening reply should summarize live tool health.",
    );
    const healthOutput = realTask.toolOutputs.find((item) => item.tool === "real_task_health")?.output || {};
    assert(
      healthOutput.tools?.limited > 0,
      "real-task health should report limited/placeholder tools instead of hiding product debt.",
    );
    assert(
      healthOutput.tools?.productReady < healthOutput.tools?.total,
      "real-task health should distinguish product-ready tools from cataloged compatibility tools.",
    );
    assert(
      healthOutput.score < 100,
      "real-task health score should not be perfect while placeholders remain.",
    );
    assertToolSummaries(realTask.toolOutputs, "real-task hardening request");

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

    const compression = await postChat("context compression status", `chat-smoke-context-compression-${suffix}`);
    assert(
      compression.toolOutputs.some((item) => item.tool === "context_compression_status"),
      "Context compression request should call context_compression_status.",
    );
    assert(compression.reply.includes("context compression status"), "Context compression reply should be grounded.");
    assertToolSummaries(compression.toolOutputs, "context compression request");

    const memoryStatus = await postChat("memory lifecycle session search status", `chat-smoke-memory-life-${suffix}`);
    assert(
      memoryStatus.toolOutputs.some((item) => item.tool === "memory_lifecycle_status"),
      "Memory lifecycle request should call memory_lifecycle_status.",
    );
    assert(memoryStatus.reply.includes("memory lifecycle status"), "Memory lifecycle reply should be grounded.");
    assertToolSummaries(memoryStatus.toolOutputs, "memory lifecycle request");

    const skillStatus = await postChat("skills system progressive disclosure status", `chat-smoke-skill-system-${suffix}`);
    assert(
      skillStatus.toolOutputs.some((item) => item.tool === "skill_system_status"),
      "Skill system request should call skill_system_status.",
    );
    assert(skillStatus.reply.includes("skill system status"), "Skill system reply should be grounded.");
    assertToolSummaries(skillStatus.toolOutputs, "skill system request");

    const gatewayStatus = await postChat("messaging gateway session routing status", `chat-smoke-msg-gateway-${suffix}`);
    assert(
      gatewayStatus.toolOutputs.some((item) => item.tool === "messaging_gateway_status"),
      "Messaging gateway request should call messaging_gateway_status.",
    );
    assert(gatewayStatus.reply.includes("messaging gateway status"), "Messaging gateway reply should be grounded.");
    assertToolSummaries(gatewayStatus.toolOutputs, "messaging gateway request");

    const terminalStatus = await postChat("terminal backends process registry approval gates", `chat-smoke-terminal-backends-${suffix}`);
    assert(
      terminalStatus.toolOutputs.some((item) => item.tool === "terminal_backends_status"),
      "Terminal backend request should call terminal_backends_status.",
    );
    assert(terminalStatus.reply.includes("terminal backends status"), "Terminal backend reply should be grounded.");
    assertToolSummaries(terminalStatus.toolOutputs, "terminal backend request");

    const modelStatus = await postChat("multi-provider model support credential pool smart failover", `chat-smoke-model-provider-${suffix}`);
    assert(
      modelStatus.toolOutputs.some((item) => item.tool === "model_provider_status"),
      "Model provider request should call model_provider_status.",
    );
    assert(modelStatus.reply.includes("multi-provider model status"), "Model provider reply should be grounded.");
    assertToolSummaries(modelStatus.toolOutputs, "model provider request");

    const delegationStatus = await postChat("subagent delegation isolation guarantees shared iteration budget", `chat-smoke-subagent-delegation-${suffix}`);
    assert(
      delegationStatus.toolOutputs.some((item) => item.tool === "subagent_delegation_status"),
      "Subagent delegation request should call subagent_delegation_status.",
    );
    assert(delegationStatus.reply.includes("subagent delegation status"), "Subagent delegation reply should be grounded.");
    assertToolSummaries(delegationStatus.toolOutputs, "subagent delegation request");

    const mcpStatus = await postChat("mcp integration model context protocol server aliases", `chat-smoke-mcp-${suffix}`);
    assert(
      mcpStatus.toolOutputs.some((item) => item.tool === "mcp_integration_status"),
      "MCP integration request should call mcp_integration_status.",
    );
    assert(mcpStatus.reply.includes("MCP integration status"), "MCP integration reply should be grounded.");
    assertToolSummaries(mcpStatus.toolOutputs, "mcp integration request");

    const cronStatus = await postChat("built-in cron scheduler cronjob unattended operation", `chat-smoke-cron-${suffix}`);
    assert(
      cronStatus.toolOutputs.some((item) => item.tool === "cron_scheduler_status"),
      "Cron scheduler request should call cron_scheduler_status.",
    );
    assert(cronStatus.reply.includes("cron scheduler status"), "Cron scheduler reply should be grounded.");
    assertToolSummaries(cronStatus.toolOutputs, "cron scheduler request");

    const learningArchitecture = await postChat(
      "trajectory generation RL training closed learning loop use cases design principles",
      `chat-smoke-learning-architecture-${suffix}`,
    );
    assert(
      learningArchitecture.toolOutputs.some((item) => item.tool === "trajectory_training_status"),
      "Learning architecture request should call trajectory_training_status.",
    );
    assert(
      learningArchitecture.toolOutputs.some((item) => item.tool === "closed_learning_loop_status"),
      "Learning architecture request should call closed_learning_loop_status.",
    );
    assert(
      learningArchitecture.toolOutputs.some((item) => item.tool === "hermes_use_cases_status"),
      "Learning architecture request should call hermes_use_cases_status.",
    );
    assert(
      learningArchitecture.toolOutputs.some((item) => item.tool === "design_principles_status"),
      "Learning architecture request should call design_principles_status.",
    );
    assertToolSummaries(learningArchitecture.toolOutputs, "learning architecture request");

    console.log("Chat agent smoke test passed");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(smokeRootDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error("Chat agent smoke test failed:", error.message);
  process.exitCode = 1;
});
