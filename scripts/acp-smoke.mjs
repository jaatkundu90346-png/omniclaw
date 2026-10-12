import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-acp-"));
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
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "local-cli",
    defaultAgent: "fakeacp",
    allowedAgents: ["fakeacp", "codex"],
    agents: {
      fakeacp: {
        command: "definitely-missing-omniclaw-acp-smoke",
        args: ["run"],
      },
    },
  },
});

const allTools = agent.tools.getAll({ agentId: "main", modelCallableOnly: true }).map((tool) => tool.id);
for (const id of ["acp_doctor", "acp_install", "acp_spawn", "acp_status", "acp_sessions", "acp_cancel", "acp_close", "acp_set_option"]) {
  assert(allTools.includes(id), `${id} should be a model-callable ACP tool.`);
}

const doctor = await agent.tools.run("acp_doctor", { agentId: "fakeacp" }, { agentId: "main" });
assert(doctor.enabled === true, "ACP doctor should read enabled config.");
assert(doctor.targetAgent === "fakeacp", "ACP doctor should inspect the requested agent.");
assert(doctor.agentCommand.installed === false, "ACP doctor should report a missing harness command honestly.");
assert(doctor.ok === false, "ACP doctor should not claim readiness when the harness command is missing.");

const install = await agent.tools.run("acp_install", { agentId: "fakeacp" }, { agentId: "main" });
assert(Array.isArray(install.commands) && install.commands.length > 0, "ACP install should return deterministic setup commands.");

const blockedSpawn = await agent.tools.run("acp_spawn", {
  agentId: "fakeacp",
  task: "Reply with ACP-SMOKE",
}, {
  agentId: "main",
  sessionId: "session_acp_smoke",
  runId: "run_acp_smoke",
});
assert(blockedSpawn.blocked === true, "ACP spawn should block when the harness command is missing.");
assert(blockedSpawn.reason === "harness-command-not-found", "ACP spawn should return the concrete missing-command reason.");

const status = await agent.tools.run("acp_status", {}, { agentId: "main" });
assert(status.enabled === true && status.defaultAgent === "fakeacp", "ACP status should expose control-plane config.");

const chat = await agent.handleMessage("/acp doctor fakeacp", {
  label: "acp-smoke",
  agentId: "main",
  channel: "webchat",
});
assert(/ACP doctor/i.test(chat.reply), "Slash /acp doctor should produce a local ACP doctor reply.");
assert(!chat.providerDiagnostics, "Slash /acp doctor should not require a provider call.");

console.log("ACP smoke test passed");
process.exit(0);
