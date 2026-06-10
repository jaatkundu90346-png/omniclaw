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

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-harness-"));
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
  codingHarness: {
    enabled: true,
    defaultAgent: "fakeharness",
    allowedAgents: ["fakeharness", "echoharness", "codex", "omniclaw"],
    maxConcurrentSessions: 2,
    timeoutSeconds: 30,
    agents: {
      fakeharness: {
        command: process.execPath,
        args: [
          "-e",
          "console.log('HARNESS_OK'); console.log('OMNICLAW_HARNESS_RESULT_TEST=' + JSON.stringify({ summary: 'fake child completed', filesChanged: [], commandsRun: ['fakeharness'], verification: [], artifacts: [], blockers: [], nextSteps: [] }));",
        ],
        taskArg: "append",
        description: "Smoke-test Node harness.",
      },
      echoharness: {
        command: process.execPath,
        args: [
          "-e",
          "console.log(process.argv.slice(1).join(' '))",
        ],
        taskArg: "append",
        description: "Prompt echo harness used to guard against false marker parsing.",
      },
      codex: {
        command: "definitely-missing-codex-for-smoke",
        args: ["exec", "--skip-git-repo-check", "-"],
        taskArg: "stdin",
        fallbackAgents: ["omniclaw"],
        description: "Missing Codex CLI smoke profile with OmniClaw fallback.",
      },
    },
  },
});

const modelTools = agent.tools.getAll({ agentId: "main", modelCallableOnly: true }).map((tool) => tool.id);
for (const id of ["agent_harness_doctor", "agent_harness_spawn", "agent_harness_status"]) {
  assert(modelTools.includes(id), `${id} should be model-callable.`);
}

const doctor = await agent.tools.run("agent_harness_doctor", { agentId: "fakeharness" }, { agentId: "main" });
assert(doctor.ok === true, "Harness doctor should be ready for fakeharness.");
assert(doctor.command.installed === true, "Harness doctor should find the Node command.");

const missingCodexDoctor = await agent.tools.run("agent_harness_doctor", { agentId: "codex" }, { agentId: "main" });
assert(missingCodexDoctor.ok === true, "Harness doctor should stay ready when missing Codex has a built-in fallback.");
assert(missingCodexDoctor.command.installed === false, "Harness doctor should still report the requested missing CLI.");
assert(missingCodexDoctor.fallback?.available === true, "Harness doctor should expose fallback availability.");
assert(missingCodexDoctor.fallback.agentId === "omniclaw", "Harness doctor should prefer the built-in OmniClaw fallback.");

const spawned = await agent.tools.run("agent_harness_spawn", {
  agentId: "fakeharness",
  task: "build a tiny smoke artifact",
  mode: "run",
  label: "smoke-harness",
  outputMarker: "OMNICLAW_HARNESS_RESULT_TEST",
  verificationCommands: [
    `& ${JSON.stringify(process.execPath)} -e "console.log('VERIFY_OK')"`,
  ],
}, {
  agentId: "main",
  sessionId: "session_harness_smoke",
  runId: "run_harness_smoke",
});

assert(spawned.accepted === true, "Harness spawn should be accepted.");
assert(spawned.session.status === "completed", "Harness run should complete.");
assert(/HARNESS_OK/.test(spawned.session.stdoutPreview || spawned.execution.stdout || ""), "Harness stdout should be persisted.");
assert(spawned.session.taskSpec.outputContract.marker.startsWith("OMNICLAW_HARNESS_RESULT_"), "Harness marker should be unique per run.");
assert(spawned.session.resultJson?.summary === "fake child completed", "Harness should parse the child agent's unique result marker.");
assert(spawned.observation?.style === "nvidia-agent-harness-observation", "Harness should return a structured NVIDIA-style observation.");
assert(spawned.observation?.verified === true, "Harness verification command should pass and mark observation verified.");
assert(spawned.verification?.[0]?.ok === true, "Harness verification result should be persisted.");

const echoed = await agent.tools.run("agent_harness_spawn", {
  agentId: "echoharness",
  task: "echo the prompt but do not produce a result marker",
  mode: "run",
  label: "echo-harness",
}, {
  agentId: "main",
  sessionId: "session_harness_smoke",
  runId: "run_harness_echo_smoke",
});

assert(echoed.accepted === true, "Echo harness spawn should be accepted.");
assert(echoed.session.resultJson === null, "Harness must not parse the prompt's marker contract as a child result.");
assert((echoed.observation?.artifacts || []).length === 0, "Harness should not scrape noisy artifact paths from raw prompt output.");

const builtinFallback = await agent.tools.run("agent_harness_spawn", {
  agentId: "codex",
  task: "Create data/generated/internal-harness-smoke.md with heading Internal Harness Smoke and one bullet saying built-in OmniClaw harness worked.",
  mode: "run",
  label: "builtin-fallback-harness",
  requiredArtifacts: ["data/generated/internal-harness-smoke.md"],
  verificationCommands: [
    `& ${JSON.stringify(process.execPath)} -e "const fs=require('fs'); const p='data/generated/internal-harness-smoke.md'; if(!fs.existsSync(p)) process.exit(1); const t=fs.readFileSync(p,'utf8'); if(!t.includes('Internal Harness Smoke')) process.exit(2); console.log('VERIFY_BUILTIN_OK')"`,
  ],
}, {
  agentId: "main",
  sessionId: "session_harness_smoke",
  runId: "run_builtin_fallback_smoke",
});

assert(builtinFallback.accepted === true, "Missing Codex CLI should fall back to built-in OmniClaw harness.");
assert(builtinFallback.session.agentId === "omniclaw", "Fallback session should record the built-in OmniClaw harness agent.");
assert(builtinFallback.session.fallbackFromAgentId === "codex", "Fallback session should preserve the requested missing agent.");
assert(builtinFallback.session.status === "completed", "Built-in fallback harness should complete the task.");
assert(builtinFallback.observation?.verified === true, "Built-in fallback harness should run verification.");
assert(builtinFallback.observation?.artifacts?.[0]?.exists === true, "Built-in fallback harness should persist artifact evidence.");

const status = await agent.tools.run("agent_harness_status", { sessionId: spawned.session.id }, { agentId: "main" });
assert(status.session?.id === spawned.session.id, "Harness status should return the requested session.");
assert(status.session.status === "completed", "Harness status should preserve completed status.");
assert(status.session.observation?.ok === true, "Harness status should include structured observation.");

const list = await agent.tools.run("agent_harness_sessions", { limit: 5 }, { agentId: "main" });
assert(Array.isArray(list.sessions) && list.sessions.length > 0, "Harness sessions should list stored sessions.");

const slashDoctor = await agent.codingHarness.handleSlashCommand("/harness doctor fakeharness", {
  agentId: "main",
  sessionId: "session_harness_smoke",
  runId: "run_harness_smoke",
});
assert(slashDoctor.reply.includes("Harness doctor"), "/harness doctor should return a slash reply.");
assert(slashDoctor.result.ok === true, "/harness doctor should use the real harness doctor path.");

const slashMcp = await agent.handleMcpSlashCommand("/mcp status", {
  agentId: "main",
  sessionId: "session_harness_smoke",
  runId: "run_harness_smoke",
});
assert(slashMcp.reply.includes("MCP status"), "/mcp status should return a slash reply.");

const skills = agent.skills.match("use harness and mcp for a complex codex repo task", { agentId: "main" });
assert(skills.some((skill) => skill.id === "coding-agent-harness"), "Coding harness skill should match harness/MCP/codex prompts.");

const contextBundle = agent.contextEngine.assemble({
  sessionId: "session_harness_smoke",
  message: "Use harness for repo work",
  profile: { id: "balanced" },
  harness: agent.codingHarness.status({ limit: 5 }),
  mcp: {
    configuredServers: Object.keys(agent.mcp?._config || {}),
    connected: agent.mcp.getStatus(),
    tools: agent.mcp.getAllTools(),
  },
});
assert(contextBundle.harness?.enabled === true, "Context bundle should include harness state.");
assert(contextBundle.contextManifest.ingredients.some((item) => item.id === "harness"), "Context manifest should list harness as an ingredient.");

console.log("Coding harness smoke test passed");
process.exit(0);
