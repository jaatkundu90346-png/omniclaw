import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";
import { AgentLoopController } from "../src/core/agent-loop-controller.js";
import { buildOmniClawSystemPrompt } from "../src/core/system-prompt.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-runtime-backend-"));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
for (const dir of ["config", "workspace", "plugins"]) {
  const source = path.join(repoRoot, dir);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(rootDir, dir), { recursive: true, force: true });
  }
}

const agent = new OmniClawAgent({ rootDir });
agent.config.updateUserConfig({
  runtime: {
    activeMemory: {
      enabled: true,
      agents: ["main"],
      allowedChatTypes: ["direct"],
      maxSummaryChars: 500,
    },
  },
  session: {
    identityLinks: {
      mankush: ["telegram:123", "discord:456"],
    },
  },
});

agent.memory.addNote("Mankush likes practical AI agents that actually run tools.", { agentId: "main" });
agent.memory.promoteMemory({
  title: "User preference",
  text: "The user prefers Codex/OpenClaw-style agents with visible tool execution and verification.",
  importance: "high",
  tags: ["user", "agent"],
  sourceRef: "runtime-backend-smoke",
  agentId: "main",
});

const session = agent.sessions.resolveSession({
  label: "main",
  agentId: "main",
  channel: "webchat",
});
const activeMemory = await agent.activeMemory.run({
  message: "What kind of agent do I like?",
  agentId: "main",
  session,
  runId: "run_smoke",
});

assert(["ok", "empty"].includes(activeMemory.status), "Active memory should complete without error.");
assert(activeMemory.promptSection.includes("<active_memory_plugin>"), "Active memory should build hidden prompt markup when memory exists.");
assert(activeMemory.summary.includes("agent"), "Active memory should include relevant memory summary.");

const docked = agent.sessions.dockSession(session.id, {
  sourceChannel: "telegram",
  sourceTo: "123",
  targetChannel: "discord",
  targetTo: "456",
  targetAccountId: "default",
});
assert(docked.ok === true, "Linked channel docking should succeed.");
assert(docked.route.channel === "discord", "Docking should persist target channel.");
assert(docked.route.to === "456", "Docking should persist target peer.");

const blocked = agent.sessions.dockSession(session.id, {
  sourceChannel: "telegram",
  sourceTo: "123",
  targetChannel: "slack",
  targetTo: "U999",
});
assert(blocked.ok === false && blocked.blocked === true, "Unlinked channel docking should be blocked.");

const registryTools = agent.tools.getAll({ agentId: "main", modelCallableOnly: true }).map((tool) => tool.id);
assert(registryTools.includes("channel_dock"), "channel_dock should be model-callable.");

const profileUpdate = agent.updateProfileFromMessage(
  "main",
  "mera name SmokeHuman hai main Jind Haryana se hu vibe coding pasand hai aur tera naam SmokeAgent hai",
);
assert(profileUpdate.updated === true, "Profile update should save durable profile facts.");
const userFile = fs.readFileSync(path.join(rootDir, "workspace", "agents", "main", "USER.md"), "utf8");
const identityFile = fs.readFileSync(path.join(rootDir, "workspace", "agents", "main", "IDENTITY.md"), "utf8");
assert(userFile.includes("SmokeHuman"), "USER.md should be synced from profile facts.");
assert(identityFile.includes("SmokeAgent"), "IDENTITY.md should be synced from assistant profile facts.");

const workspaceContext = agent.loadWorkspaceContext("main");
const systemPrompt = buildOmniClawSystemPrompt({
  agent: { id: "main", name: "SmokeAgent" },
  profile: { id: "balanced" },
  contextBundle: {
    workspaceContext,
    tools: [],
    skills: [],
    report: { usedChars: 0, maxChars: 22000, omittedItems: 0 },
  },
});
assert(systemPrompt.includes("## Agent/User Memory Snapshot"), "System prompt should include an explicit identity/user memory snapshot.");
assert(systemPrompt.includes("Active assistant identity: SmokeAgent"), "System prompt snapshot should expose assistant identity from MD files.");
assert(systemPrompt.includes("Known user name: SmokeHuman"), "System prompt snapshot should expose user identity from MD files.");

const typoIntents = agent.intentEngine.detect("kimi ai ka bara ma reaserach karo");
assert(typoIntents.includes("research"), "Intent engine should understand common research typo 'reaserach'.");

const loopEvents = [];
const loopController = new AgentLoopController({
  config: {},
  gateway: { addEvent: (event, payload) => loopEvents.push({ event, payload }) },
  run: { id: "run_loop_output" },
  session: { id: "session_loop_output" },
  agent: { id: "main" },
});
loopController.startStep({ phase: "runtime-plan", message: "Running a proof command." });
loopController.toolOutput({ tool: "run_terminal_command" }, { command: "Get-Date", stdout: "Monday", status: "completed" });
assert(
  loopEvents.some((item) => item.event === "tool.output" && item.payload.outputSummary?.includes("Get-Date")),
  "Tool output events should include readable outputSummary for the chat working log.",
);

console.log("Runtime backend smoke test passed");
process.exit(0);
