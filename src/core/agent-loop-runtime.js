export const AGENT_LOOP_STAGES = Object.freeze([
  "intake",
  "session_queue",
  "workspace_snapshot",
  "system_prompt",
  "context_assembly",
  "model_inference",
  "model_output_validation",
  "tool_execution",
  "tool_observation_store",
  "observation",
  "self_correction",
  "persistence",
  "final_render",
  "final",
  "memory_hooks",
]);

export function buildAgentLoopContract({
  session = {},
  run = {},
  agent = {},
  profile = {},
  workspaceContext = {},
  providerInfo = {},
} = {}) {
  return {
    runtime: "omniclaw-agent-loop",
    stages: AGENT_LOOP_STAGES,
    serializedSessionRun: true,
    actionContract: {
      plainTextIsNotAction: true,
      validActions: ["provider-native-tool-call", "json-tool-call", "runtime-plan-tool-step"],
      requiredJsonShape: "{ type: \"tool_call\", tool: string, args|input: object } or { type: \"final_answer\", finalReady: true }",
      repeatPolicy:
        "same safe read/search/fetch args reuse cached observation; same side-effect args are blocked unless changed or confirmed",
      finalRequiresEvidence:
        "real work must finish with tool observation, verification result, approval blocker, or explicit runtime blocker",
    },
    session: {
      id: session.id || "",
      key: session.key || "",
      agentId: session.agentId || agent.id || "main",
      queueDepth: Number(session.queueDepth || 0),
      activeRunId: session.activeRunId || "",
    },
    run: {
      id: run.id || "",
      status: run.status || "",
    },
    agent: {
      id: agent.id || "main",
      name: agent.name || agent.id || "main",
      profileId: profile.id || agent.profileId || "",
    },
    provider: {
      id: providerInfo.id || "",
      mode: providerInfo.mode || "",
      model: providerInfo.model || "",
      ready: providerInfo.ready !== false,
    },
    workspace: {
      agentId: workspaceContext.agentId || agent.id || "main",
      fileCount: Array.isArray(workspaceContext.files) ? workspaceContext.files.length : 0,
      manifest: workspaceContext.manifest || null,
    },
  };
}

export function emitAgentLoopStage(gateway, stage, payload = {}) {
  const normalized = String(stage || "").trim();
  if (!AGENT_LOOP_STAGES.includes(normalized)) {
    return null;
  }
  return gateway?.addEvent?.("agent.loop_stage", {
    stage: normalized,
    at: new Date().toISOString(),
    ...payload,
  }) || null;
}
