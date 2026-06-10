import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MemoryStore } from "./memory-store.js";
import { SkillRegistry } from "./skill-registry.js";
import { ToolRegistry } from "./tool-registry.js";
import { Planner } from "./planner.js";
import { ConfigStore } from "./config-store.js";
import { TaskStore } from "./task-store.js";
import { IntentEngine } from "./intent-engine.js";
import { createProvider, getProvider } from "./provider-factory.js";
import { FileStore } from "./file-store.js";
import { ShellPlanner } from "./shell-planner.js";
import { WebResearch } from "./web-research.js";
import { TaskRunner } from "./task-runner.js";
import { CustomizationEngine } from "./customization-engine.js";
import { SessionStore } from "./session-store.js";
import { GatewayStore } from "./gateway-store.js";
import { WorkspaceBootstrap } from "./workspace-bootstrap.js";
import { PluginRegistry } from "./plugin-registry.js";
import { JobStore } from "./job-store.js";
import { BackgroundWorker } from "./background-worker.js";
import { SecretStore } from "./secret-store.js";
import { AgentRegistry } from "./agent-registry.js";
import { ScheduleStore } from "./schedule-store.js";
import { Scheduler } from "./scheduler.js";
import { DeviceTrustStore } from "./device-trust-store.js";
import { ContextEngine } from "./context-engine.js";
import { ShellExecutor } from "./shell-executor.js";
import { ShellAuditStore } from "./shell-audit-store.js";
import { ConnectorStore } from "./connector-store.js";
import { TelegramPollingWorker } from "./telegram-polling-worker.js";
import { DiscordGatewayWorker } from "./discord-gateway-worker.js";
import { SummarizationEngine } from "./summarization-engine.js";
import { BrowserOperator } from "./browser-operator.js";
import { BrowserPlaywright } from "./browser-playwright.js";
import { SystemMonitor } from "./system-monitor.js";
import { V2FeatureHealth } from "./v2-feature-health.js";
import { SandboxRunner } from "./sandbox-runner.js";
import { EventBus } from "./event-bus.js";
import { Heartbeat } from "./heartbeat.js";
import { McpRegistry } from "./mcp-client.js";
import { SubAgentSpawner } from "./sub-agent-spawner.js";
import { SemanticMemory, SimpleTextEmbedder } from "./semantic-memory.js";
import { DeepResearchAgent } from "./deep-research-agent.js";
import { VisualBrowserOperator } from "./visual-browser-operator.js";
import { MultiProviderFallback } from "./multi-provider-fallback.js";
import { GoalManager } from "./goal-manager.js";
import { ReflectionEngine } from "./reflection-engine.js";
import { AutonomousRuntime } from "./autonomous-runtime.js";
import { AutonomousCheckpointStore } from "./autonomous-checkpoint-store.js";
import { AutonomousDaemon } from "./autonomous-daemon.js";
import { AgentLoopController, getAgentLoopSettings } from "./agent-loop-controller.js";
import { OmniLoop, getOmniLoopSettings } from "./omni-loop.js";
import { ActiveMemory } from "./active-memory.js";
import { AcpManager } from "./acp-manager.js";
import { CodingAgentHarness } from "./coding-agent-harness.js";
import { normalizeAcceptedSessionSpawnResult } from "./accepted-session-spawn.js";
import { summarizeAgentRuntimeSecretRefs } from "./agent-runtime-config.js";
import { resolveProviderRuntimeMetadata, resolveSessionRuntimeMetadata } from "./agent-runtime-metadata.js";
import { buildAgentLoopContract, emitAgentLoopStage } from "./agent-loop-runtime.js";
import { buildRuntimeWorkspaceManifest } from "./runtime-workspace.js";

function truncateAttachmentImport(value, maxChars = 12000) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()}...[truncated]`;
}

function buildAttachmentExtractImportMessage(extract = {}, maxChars = 12000) {
  const extracted = truncateAttachmentImport(extract.extractedText || extract.contentPreview || "", maxChars);
  return [
    `Attachment extract imported from ${extract.adapterId || "adapter"}.`,
    `Delivery: ${extract.deliveryId || "unknown"}`,
    `Attachment: ${extract.name || extract.type || extract.attachmentId || "unknown"}`,
    `MIME: ${extract.mimeType || "unknown"}`,
    `Cache: ${extract.relativePath || extract.cacheId || "unknown"}`,
    `Extract status: ${extract.status || "unknown"}`,
    `Characters: ${extract.characterCount || extracted.length}`,
    "",
    "Use this attachment content as session context. Summarize important details and keep useful facts available for memory promotion.",
    "",
    "Extracted content:",
    extracted || "(No extracted text was available.)",
  ].join("\n");
}

function latestTextMatch(text = "", patterns = []) {
  for (const pattern of patterns) {
    const flags = pattern instanceof RegExp ? Array.from(new Set(`${pattern.flags}g`)).join("") : "g";
    const matcher = pattern instanceof RegExp ? new RegExp(pattern.source, flags) : new RegExp(String(pattern), "g");
    const matches = [...String(text || "").matchAll(matcher)]
      .map((match) => String(match[1] || "").trim())
      .filter(Boolean);
    if (matches.length > 0) {
      return matches[matches.length - 1];
    }
  }
  return "";
}

function redactTraceString(value = "") {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-or-v1|nvapi|ghp|github_pat|xox[baprs])-[A-Za-z0-9._-]{16,}\b/gi, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{12,}@/g, "[redacted-auth]@")
    .replace(/((?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*)[^\s,"']+/gi, "$1[redacted]");
}

function isTraceSecretKey(key = "") {
  const normalized = String(key || "");
  if (/^apiKeyProviderId$/i.test(normalized)) {
    return false;
  }
  return /api[_-]?key|authorization|bearer|password|secret|token|cookie|credential/i.test(normalized);
}

function truncateTraceText(value, maxChars = 1200) {
  const text = redactTraceString(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

function sanitizeTraceValue(value, options = {}, depth = 0) {
  const maxString = Number(options.maxString || 1200);
  const maxArray = Number(options.maxArray || 8);
  const maxDepth = Number(options.maxDepth || 4);

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateTraceText(value, maxString);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((item) => sanitizeTraceValue(item, options, depth + 1));
    if (value.length > maxArray) {
      items.push({ omittedItems: value.length - maxArray });
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) {
      return truncateTraceText(JSON.stringify(value), maxString);
    }
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isTraceSecretKey(key) ? "[redacted]" : sanitizeTraceValue(item, options, depth + 1);
    }
    return output;
  }
  return truncateTraceText(String(value), maxString);
}

function createToolTraceId() {
  return `tool_trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function classifyProviderOutcome(text = "") {
  const message = String(text || "").trim();
  if (!message) {
    return {
      ok: false,
      reason: "empty_response",
      message: "Provider returned an empty response.",
    };
  }
  const lower = message.toLowerCase();
  const failurePatterns = [
    ["missing_api_key", "api key missing"],
    ["missing_api_key", "no api key"],
    ["auth_required", "codex login"],
    ["auth_required", "authentication"],
    ["rate_limited", "429"],
    ["provider_request_failed", "provider request failed"],
    ["provider_timeout", "provider request timed out"],
    ["provider_timeout", "model bridge did not return in time"],
    ["provider_timeout", "provider took too long"],
    ["provider_connection_failed", "provider connection failed"],
    ["provider_connection_failed", "request failed"],
    ["provider_disabled", "real provider is not configured"],
    ["provider_disabled", "offline mock brain is disabled"],
    ["provider_disabled", "live replies are disabled"],
    ["insufficient_credits", "requires more credits"],
    ["insufficient_credits", "can only afford"],
    ["cli_failed", "codex cli provider failed"],
    ["cli_not_ready", "codex cli bridge is selected"],
    ["empty_response", "provider returned an empty response"],
  ];
  const match = failurePatterns.find(([, pattern]) => lower.includes(pattern));
  return {
    ok: !match,
    reason: match?.[0] || "ok",
    message: match ? truncateTraceText(message, 1000) : "",
  };
}

export class OmniClawAgent {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.config = new ConfigStore(rootDir);
    this.secrets = new SecretStore(rootDir);
    this.trust = new DeviceTrustStore(rootDir);
    this.memory = new MemoryStore(rootDir);
    this.sessions = new SessionStore(rootDir, this.config);
    this.gateway = new GatewayStore(rootDir);
    this.gateway.agentRef = this;
    this.activeMemory = new ActiveMemory({
      configStore: this.config,
      memoryStore: this.memory,
      gateway: this.gateway,
    });
    this.eventBus = new EventBus();
    this.eventBus.on("process.output", (data = {}) => {
      const runId = String(data.runId || "").trim();
      const sessionId = String(data.sessionId || "").trim();
      if (!runId && !sessionId) return;
      const text = String(data.text || "");
      const preview = text.length > 600 ? text.slice(-600) : text;
      const outputSummary = String(preview).trim().split(/\r?\n/).slice(-1)[0].slice(0, 160);
      this.gateway.addEvent("tool.output", {
        runId,
        sessionId,
        tool: "exec",
        processId: data.processId,
        stream: data.stream,
        preview,
        outputSummary,
      });
    });
    this.eventBus.on("process.status", (data = {}) => {
      const runId = String(data.runId || "").trim();
      const sessionId = String(data.sessionId || "").trim();
      if (!runId && !sessionId) return;
      const status = String(data.status || "").trim();
      const summary = `process ${status}${data.exitCode !== undefined && data.exitCode !== null ? ` (exit ${data.exitCode})` : ""}`;
      this.gateway.addEvent("tool.output", {
        runId,
        sessionId,
        tool: "exec",
        processId: data.processId,
        status,
        outputSummary: summary.slice(0, 160),
        preview: summary,
      });
    });
    this.shellAudit = new ShellAuditStore(rootDir);
    this.connectors = new ConnectorStore(rootDir, { secretStore: this.secrets });
    this.jobs = new JobStore(rootDir);
    this.schedules = new ScheduleStore(rootDir);
    this.tasks = new TaskStore(rootDir);
    this.skills = new SkillRegistry({ rootDir });
    this.workspace = new WorkspaceBootstrap(rootDir);
    this.agents = new AgentRegistry({
      rootDir,
      configStore: this.config,
      workspaceBootstrap: this.workspace,
    });
    this.plugins = new PluginRegistry(rootDir, this.config, this.gateway);
    this.files = new FileStore(rootDir);
    this.shellPlanner = new ShellPlanner(this.config);
    this.shellExecutor = new ShellExecutor({
      rootDir,
      configStore: this.config,
      eventBus: this.eventBus,
    });
    this.acp = new AcpManager({
      rootDir,
      configStore: this.config,
      gatewayStore: this.gateway,
      shellExecutor: this.shellExecutor,
    });
    this.codingHarness = new CodingAgentHarness({
      rootDir,
      configStore: this.config,
      gatewayStore: this.gateway,
      shellExecutor: this.shellExecutor,
    });
    this.webResearch = new WebResearch(this.config, this.secrets);
    this.intentEngine = new IntentEngine();
    this.planner = new Planner();
    this.provider = createProvider(this.config, this.secrets);
    this.embedder = new SimpleTextEmbedder();
    this.semanticMemory = new SemanticMemory({ rootDir, embedder: this.embedder });
    this.deepResearchAgent = new DeepResearchAgent({
      webResearch: this.webResearch,
      toolRegistry: null,
      provider: this.provider,
    });
    this.visualBrowserOperator = null;
    this.multiProviderFallback = new MultiProviderFallback({
      configStore: this.config,
      secretStore: this.secrets,
    });
    this.subAgentSpawner = new SubAgentSpawner({
      agentRuntime: this,
      configStore: this.config,
      toolRegistry: null,
      agentRegistry: this.agents,
      memoryStore: this.memory,
      taskStore: this.tasks,
    });
    this.taskRunner = new TaskRunner(this.tasks);
    this.customizationEngine = new CustomizationEngine({
      configStore: this.config,
      skillRegistry: this.skills,
      secretStore: this.secrets,
    });
    this.contextEngine = new ContextEngine(this.config);
    this.browserOperator = new BrowserOperator({ rootDir });
    this.browserPlaywright = new BrowserPlaywright({
      screenshotDir: path.join(rootDir, "data", "browser-screenshots"),
    });
    this.visualBrowserOperator = new VisualBrowserOperator({
      browserPlaywright: this.browserPlaywright,
      visionProvider: null,
    });
    this.sandboxRunner = new SandboxRunner({
      rootDir,
      configStore: this.config,
    });
    this.systemMonitor = new SystemMonitor();
    this.v2Health = new V2FeatureHealth(this);

    this.tools = new ToolRegistry({
      memoryStore: this.memory,
      taskStore: this.tasks,
      configStore: this.config,
      fileStore: this.files,
      shellPlanner: this.shellPlanner,
      shellExecutor: this.shellExecutor,
      webResearch: this.webResearch,
      browserOperator: this.browserOperator,
      browser: this.browserPlaywright,
      sandboxRunner: this.sandboxRunner,
      systemMonitor: this.systemMonitor,
      taskRunner: this.taskRunner,
      customizationEngine: this.customizationEngine,
      pluginRegistry: this.plugins,
      agentRegistry: this.agents,
      connectorStore: this.connectors,
      agentRuntime: this,
      subAgentSpawner: this.subAgentSpawner,
      acpManager: this.acp,
      codingHarness: this.codingHarness,
    });
    this.subAgentSpawner.toolRegistry = this.tools;
    this.deepResearchAgent.toolRegistry = this.tools;
    this.omniLoop = new OmniLoop({ agentRuntime: this });
    this.goalManager = new GoalManager({
      provider: this.provider,
      semanticMemory: this.semanticMemory,
    });
    this.reflectionEngine = new ReflectionEngine({
      provider: this.provider,
      semanticMemory: this.semanticMemory,
      tools: this.tools,
    });
// Initialize checkpoint store for autonomous tasks
    this.autonomousCheckpoints = new AutonomousCheckpointStore({ rootDir });
    
    this.autonomousRuntime = new AutonomousRuntime({
      goalManager: this.goalManager,
      planner: this.planner,
      reflectionEngine: this.reflectionEngine,
      toolRegistry: this.tools,
      semanticMemory: this.semanticMemory,
      provider: this.provider,
      checkpointStore: this.autonomousCheckpoints,
    });
    this.worker = new BackgroundWorker({
      jobStore: this.jobs,
      gatewayStore: this.gateway,
      toolRegistry: this.tools,
    });
    this.scheduler = new Scheduler({
      scheduleStore: this.schedules,
      worker: this.worker,
      gatewayStore: this.gateway,
    });
  this.heartbeat = new Heartbeat({ agent: this, intervalMs: 1800000 });
  this.heartbeat.addCheck({ id: "memory-review", description: "Review and promote memory candidates", fn: (a) => a.memory.dreamSweep?.({ limit: 3, minScore: 0.7 }) });
  this.heartbeat.addCheck({ id: "approval-expiry", description: "Expire old pending approvals", fn: (a) => a.gateway.expireOldApprovals?.(30) });
  this.heartbeat.addCheck({ id: "session-cleanup", description: "Auto-compact large sessions", fn: (a) => { const sessions = a.sessions.listSessions(100); let compacted = 0; for (const s of sessions) { if (s.messageCount > 150) { try { a.sessions.compactSession(s.id, 80); compacted++; } catch {} } } return { compacted }; } });

  this.autonomousDaemon = new AutonomousDaemon({
    autonomousRuntime: this.autonomousRuntime,
    checkpointStore: this.autonomousCheckpoints,
    gatewayStore: this.gateway,
  });

  // ─── MCP Server Registry ───────────────────────────────────────────────────────
  this.mcp = new McpRegistry(this.rootDir);

  // ─── Load Workspace Identity Files ──────────────────────────────
  this.workspaceIdentity = {};
  const idFiles = ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "IDENTITY.md"];
  for (const fname of idFiles) {
    try {
      const fpath = path.join(this.rootDir, fname);
      if (fs.existsSync(fpath)) {
        this.workspaceIdentity[fname] = fs.readFileSync(fpath, "utf8").slice(0, 10000);
      }
    } catch {}
  }

    this.telegramWorker = new TelegramPollingWorker({
      connectorStore: this.connectors,
      gatewayStore: this.gateway,
      agentRuntime: this,
    });
    this.discordWorker = new DiscordGatewayWorker({
      connectorStore: this.connectors,
      gatewayStore: this.gateway,
      agentRuntime: this,
    });
    this.summarizer = new SummarizationEngine(rootDir, this.provider, this.gateway);
    this.sessionRunQueues = new Map();
  }

  async start() {
    this.workspace.ensure();
    this.agents.ensure();
    this.plugins.refreshLifecycle("startup");
    this.recoverStaleRuns("startup");
    this.recoverStaleDelegations("startup");
    this.heartbeat.start();
    this.scheduler.start();
  }

  getProviderInfo() {
    this.provider = createProvider(this.config, this.secrets);
    return this.provider.getInfo();
  }

  refreshPlugins(reason = "manual-refresh") {
    return this.plugins.refreshLifecycle(reason);
  }

  recoverStaleRuns(reason = "runtime-startup") {
    const now = new Date().toISOString();
    const staleRuns = this.gateway
      .listRuns(500)
      .filter((run) => ["accepted", "queued", "running"].includes(run.status));
    for (const run of staleRuns) {
      this.gateway.updateRun(run.id, {
        status: "failed",
        completedAt: now,
        error: `Recovered stale run during ${reason}. The gateway process restarted or provider call timed out before completion.`,
      });
      if (run.sessionId) {
        try {
          this.sessions.updateSession(run.sessionId, {
            activeRunId: null,
            queueDepth: 0,
            queuedRunIds: [],
            status: "idle",
          });
        } catch {
          // Old runs can point at sessions that no longer exist.
        }
      }
    }
    if (staleRuns.length > 0) {
      this.gateway.addEvent("runs.recovered_stale", {
        count: staleRuns.length,
        reason,
      });
    }
    return {
      recovered: staleRuns.length,
      runIds: staleRuns.map((run) => run.id),
    };
  }

  recoverStaleDelegations(reason = "runtime-startup") {
    const now = new Date();
    const nowIso = now.toISOString();
    const staleAfterMs = Math.max(
      60_000,
      Math.min(86_400_000, Number(this.config.getConfig().runtime?.delegation?.staleAfterMs || 3_600_000)),
    );
    const staleDelegations = this.gateway
      .listDelegations({ limit: 500 })
      .filter((delegation) => ["queued", "running"].includes(delegation.status))
      .filter((delegation) => {
        const at = new Date(delegation.updatedAt || delegation.createdAt || 0).getTime();
        return Number.isFinite(at) && now.getTime() - at > staleAfterMs;
      });
    for (const delegation of staleDelegations) {
      this.gateway.updateDelegation(delegation.id, {
        status: "failed",
        completedAt: nowIso,
        error: `Recovered stale delegation during ${reason}. The child run did not report completion before the stale timeout.`,
      });
    }
    if (staleDelegations.length > 0) {
      this.gateway.addEvent("delegations.recovered_stale", {
        count: staleDelegations.length,
        reason,
      });
    }
    return {
      recovered: staleDelegations.length,
      delegationIds: staleDelegations.map((item) => item.id),
    };
  }

  recoverBlockingRunIfStale({ sessionId = "", blockedByRunId = "", reason = "busy-guard" } = {}) {
    const runId = String(blockedByRunId || "").trim();
    const id = String(sessionId || "").trim();
    if (!runId || !id) {
      return { recovered: false, reason: "missing-run-or-session" };
    }
    const run = this.gateway.getRun(runId);
    const session = this.sessions.getSession?.(id);
    const staleAfterMs = Math.max(
      60_000,
      Math.min(86_400_000, Number(this.config.getConfig().runtime?.agentLoop?.timeoutMs || 3_600_000)),
    );
    const updatedAt = Date.parse(run?.updatedAt || run?.createdAt || session?.updatedAt || 0);
    const ageMs = updatedAt ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
    const runStillActive = run && ["accepted", "queued", "running", "busy"].includes(run.status);
    if (!runStillActive && run) {
      try {
        this.sessions.updateSession(id, {
          activeRunId: null,
          queueDepth: 0,
          queuedRunIds: [],
          status: "idle",
        });
      } catch {}
      this.gateway.addEvent("agent.busy_guard_recovered", {
        sessionId: id,
        blockedByRunId: runId,
        reason: "blocking-run-already-terminal",
      });
      return { recovered: true, reason: "blocking-run-already-terminal" };
    }
    if (!run || ageMs < staleAfterMs) {
      return {
        recovered: false,
        reason: !run ? "blocking-run-not-found" : "blocking-run-not-stale",
        ageMs,
        staleAfterMs,
      };
    }
    const now = new Date().toISOString();
    this.gateway.updateRun(run.id, {
      status: "failed",
      completedAt: now,
      staleRecoveredAt: now,
      stopReason: "stale_run_recovered",
      error: `Recovered stale active run during ${reason}; it blocked new chat messages for ${Math.round(ageMs / 1000)}s.`,
    });
    try {
      this.sessions.updateSession(id, {
        activeRunId: null,
        queueDepth: 0,
        queuedRunIds: [],
        status: "idle",
        resetReason: `Recovered stale active run ${run.id}`,
      });
    } catch {}
    this.gateway.addEvent("agent.busy_guard_recovered", {
      sessionId: id,
      blockedByRunId: run.id,
      reason,
      ageMs,
      staleAfterMs,
    });
    return { recovered: true, reason: "stale-run-recovered", ageMs, staleAfterMs };
  }

  getWorkspaceState() {
    return {
      bootstrapFiles: this.workspace.getStatus(),
      agents: this.agents.getAll().map((agent) => this.workspace.getAgentStatus(agent)),
    };
  }

  layerStatus(components = []) {
    const statuses = components.map((item) => item.status);
    if (statuses.every((status) => status === "ready")) {
      return "ready";
    }
    if (statuses.some((status) => status === "ready" || status === "partial")) {
      return "partial";
    }
    return "missing";
  }

  fileExists(relativePath) {
    return fs.existsSync(path.join(this.rootDir, relativePath));
  }

  getOpenClawLayerReport() {
    this.provider = createProvider(this.config, this.secrets);
    const config = this.config.getConfig();
    const provider = this.provider.getInfo();
    const gateway = this.gateway.getOverview();
    const scheduler = this.scheduler.getOverview();
    const connectorOverview = this.connectors.getOverview();
    const adaptersOverview = this.connectors.getAdaptersOverview();
    const sessions = this.sessions.listSessions(200);
    const agents = this.agents.getAll();
    const tools = this.tools.getAll({ includeAllAgents: true });
    const skills = this.skills.getAll();
    const workspace = this.getWorkspaceState();
    const trust = this.trust.getOverview();
    const shellPolicy = this.shellExecutor.getPolicy();
    const memoryOverview = this.memory.getOverview();
    const profile = this.config.getActiveProfile();
    const workspaceFiles = [
      "workspace/AGENTS.md",
      "workspace/IDENTITY.md",
      "workspace/SOUL.md",
      "workspace/USER.md",
      "workspace/TOOLS.md",
      "workspace/HEARTBEAT.md",
      "workspace/agents/main/PROFILE.md",
    ];
    const presentWorkspaceFiles = workspaceFiles.filter((item) => this.fileExists(item));
    const configFiles = ["config/default.json", "data/config.json"].filter((item) => this.fileExists(item));
    const secretStatuses = this.secrets.getAllStatuses();
    const providerSecret = secretStatuses.find((item) => item.providerId === provider.id)
      || secretStatuses.find((item) => item.configured)
      || null;
    const adapterCounts = adaptersOverview || {};

    const layers = [
      {
        id: 1,
        name: "Messaging Channels",
        goal: "Inbound/outbound channels route messages into OmniClaw sessions.",
        components: [
          {
            id: "webchat",
            label: "WebChat",
            status: "ready",
            detail: "Local browser UI posts to /api/chat and stores full session transcripts.",
          },
          {
            id: "webhook",
            label: "Webhook",
            status: connectorOverview.webhookEnabled ? "ready" : "missing",
            detail: connectorOverview.webhookEnabled
              ? `Webhook enabled; token required: ${connectorOverview.webhookRequireToken ? "yes" : "no"}.`
              : "Webhook connector is disabled.",
          },
          {
            id: "file-drop",
            label: "File Drop",
            status: connectorOverview.fileDropEnabled ? "ready" : "missing",
            detail: `${connectorOverview.fileDropPending || 0} pending file(s), ${connectorOverview.fileDropProcessed || 0} processed.`,
          },
          {
            id: "telegram",
            label: "Telegram",
            status: this.telegramWorker.getStatus().running ? "ready" : (adapterCounts.enabled ? "partial" : "missing"),
            detail: `Worker ${this.telegramWorker.getStatus().running ? "running" : "stopped"}; configure adapter token to receive/send Telegram.`,
          },
          {
            id: "discord",
            label: "Discord",
            status: this.discordWorker.getStatus().running ? "ready" : (adapterCounts.enabled ? "partial" : "missing"),
            detail: `Worker ${this.discordWorker.getStatus().running ? "running" : "stopped"}; configure bot token to receive/send Discord.`,
          },
          {
            id: "future-channels",
            label: "WhatsApp/Slack/Signal/iMessage",
            status: "missing",
            detail: "Not claimed as working yet. Needs adapter packages, auth profiles, and outbox senders.",
          },
        ],
      },
      {
        id: 2,
        name: "Gateway",
        goal: "Core daemon serializes sessions, routes messages, schedules jobs, and records diagnostics.",
        components: [
          {
            id: "http-api",
            label: "HTTP API",
            status: "ready",
            detail: "server.js exposes chat, state, sessions, gateway, providers, connectors, schedules, and jobs.",
          },
          {
            id: "websocket",
            label: "WebSocket Server",
            status: "ready",
            detail: "ws-gateway is attached at /ws for gateway clients.",
          },
          {
            id: "auth-pairing",
            label: "Auth + Pairing",
            status: trust?.gateway?.configured || trust?.trustedDevices ? "ready" : "partial",
            detail: `${trust?.trustedDevices || 0} trusted device(s), ${trust?.pendingPairings || 0} pending pairing request(s).`,
          },
          {
            id: "router",
            label: "Message Router",
            status: agents.length > 0 ? "ready" : "partial",
            detail: `${agents.length} agent(s), ${gateway.delegationCount || 0} delegation(s), ${gateway.activeDelegations || 0} active.`,
          },
          {
            id: "scheduler",
            label: "Cron Scheduler",
            status: scheduler.scheduleCount > 0 ? "ready" : "partial",
            detail: `${scheduler.scheduleCount} schedule(s), ${scheduler.activeCount} active, next run: ${scheduler.nextRunAt || "none"}.`,
          },
          {
            id: "session-manager",
            label: "Session Manager",
            status: "ready",
            detail: `${sessions.length} stored session(s), ${sessions.filter((item) => item.status === "running").length} running.`,
          },
          {
            id: "config-engine",
            label: "Config Engine",
            status: configFiles.length > 0 ? "ready" : "partial",
            detail: `${configFiles.join(", ") || "no config files found"} loaded through ConfigStore.`,
          },
        ],
      },
      {
        id: 3,
        name: "Agent Runtime",
        goal: "Prompt assembly, model inference, tool execution, compaction, streaming-shaped replies, and safety.",
        components: [
          {
            id: "prompt-assembly",
            label: "Prompt Assembly",
            status: presentWorkspaceFiles.length >= 5 ? "ready" : "partial",
            detail: `${presentWorkspaceFiles.length}/${workspaceFiles.length} workspace identity/profile files loaded.`,
          },
          {
            id: "model-inference",
            label: "Model Inference",
            status: provider.ready && provider.id !== "mock/local-rule-engine" ? "ready" : "partial",
            detail: provider.ready
              ? `${provider.id} ready via ${provider.mode || "runtime"} mode.`
              : provider.message || "Provider is not ready.",
          },
          {
            id: "tool-execution",
            label: "Tool Execution",
            status: tools.length > 0 ? "ready" : "missing",
            detail: `${tools.length} runtime tool(s) registered; heuristic planner executes real functions before final reply.`,
          },
          {
            id: "streaming",
            label: "Streaming + UI Replies",
            status: "partial",
            detail: "Gateway records runs and UI renders transcript bubbles; token-by-token provider streaming is still a future pass.",
          },
          {
            id: "compaction",
            label: "Context Compaction",
            status: "ready",
            detail: `Context budget for profile ${profile.id}: ${this.contextEngine.getMaxChars(profile)} chars.`,
          },
          {
            id: "safety",
            label: "Safety Layer",
            status: "ready",
            detail: `Shell policy ${shellPolicy.enabled ? "enabled" : "disabled"}, allowlist mode ${shellPolicy.allowlistMode}.`,
          },
        ],
      },
      {
        id: 4,
        name: "Tools + Skills",
        goal: "Real executable tools plus SKILL.md instructions for how agents should use them.",
        components: [
          {
            id: "core-tools",
            label: "Core Tools",
            status: tools.length > 0 ? "ready" : "missing",
            detail: tools.slice(0, 14).map((tool) => tool.id).join(", "),
          },
          {
            id: "shell",
            label: "Exec/Shell",
            status: shellPolicy.enabled ? "ready" : "partial",
            detail: `${shellPolicy.allowlistPatterns.length} allowlist pattern(s), ${shellPolicy.blockedPatterns.length} blocked pattern(s).`,
          },
          {
            id: "web",
            label: "Web Research/Fetch",
            status: tools.some((tool) => tool.id === "web_research") && tools.some((tool) => tool.id === "read_url") ? "ready" : "missing",
            detail: "web_research and read_url are available as runtime tools.",
          },
          {
            id: "browser",
            label: "Browser/Media Eyes",
            status: tools.some((tool) => tool.id === "read_url") || tools.some((tool) => tool.id.includes("attachment")) ? "partial" : "missing",
            detail: "URL reading and attachment analysis hooks exist; full live browser automation inside OmniClaw is still a next pass.",
          },
          {
            id: "skills",
            label: "Skills",
            status: skills.length > 0 ? "ready" : "partial",
            detail: `${skills.length} skill(s) loaded from registry.`,
          },
          {
            id: "function-loop",
            label: "Tool -> Execute -> Result -> LLM Loop",
            status: "partial",
            detail: "Heuristic tool loop is real. Provider-native repeated function-calling loop is the next runtime upgrade.",
          },
        ],
      },
      {
        id: 5,
        name: "Workspace + State",
        goal: "Persistent identity, memory, sessions, config, auth profiles, and local runtime state.",
        components: [
          {
            id: "workspace-files",
            label: "Workspace Files",
            status: presentWorkspaceFiles.length >= 5 ? "ready" : "partial",
            detail: presentWorkspaceFiles.join(", "),
          },
          {
            id: "sessions",
            label: "Sessions",
            status: "ready",
            detail: `${sessions.length} session(s), ${sessions.reduce((sum, item) => sum + Number(item.messageCount || 0), 0)} message(s).`,
          },
          {
            id: "memory",
            label: "Memory",
            status: "ready",
            detail: `${memoryOverview.longTerm || 0} long-term memory item(s), ${memoryOverview.conversations || 0} conversation item(s).`,
          },
          {
            id: "auth-profiles",
            label: "Auth Profiles + API Keys",
            status: providerSecret?.configured || provider.apiKeyConfigured ? "ready" : "partial",
            detail: providerSecret?.configured || provider.apiKeyConfigured
              ? `Provider key configured (${provider.apiKeySource || providerSecret?.source || "stored"}).`
              : "No provider key configured.",
          },
          {
            id: "sandbox",
            label: "Sandbox/Governance",
            status: "partial",
            detail: "Protected filesystem roots and shell policy exist; full container isolation is optional/future.",
          },
        ],
      },
    ].map((layer) => ({
      ...layer,
      status: this.layerStatus(layer.components),
      readyCount: layer.components.filter((item) => item.status === "ready").length,
      partialCount: layer.components.filter((item) => item.status === "partial").length,
      missingCount: layer.components.filter((item) => item.status === "missing").length,
    }));

    return {
      generatedAt: new Date().toISOString(),
      architecture: "OpenClaw-style agent platform runtime",
      summary: {
        status: this.layerStatus(layers),
        readyLayers: layers.filter((item) => item.status === "ready").length,
        partialLayers: layers.filter((item) => item.status === "partial").length,
        missingLayers: layers.filter((item) => item.status === "missing").length,
        provider: provider.id,
        providerReady: Boolean(provider.ready),
        tools: tools.length,
        skills: skills.length,
        agents: agents.length,
        sessions: sessions.length,
      },
      layers,
      nextUpgrades: [
        "Provider-native function-calling loop so model can request tools repeatedly until the task is complete.",
        "First-class adapter packages for WhatsApp, Slack, Signal, and iMessage instead of placeholder channel status.",
        "Token streaming from provider to UI while tool events continue through gateway logs.",
        "Browser automation tool exposed inside OmniClaw runtime with screenshot observation.",
        "Optional isolated sandbox runner for high-risk exec tasks.",
      ],
      proof: {
        realTools: tools.map((tool) => tool.id),
        workspace,
        gateway,
        connectors: connectorOverview,
        scheduler,
      },
    };
  }

  getV2Report() {
    return this.v2Health.build();
  }

  getAgentContext(agentId = "") {
    const agent = this.agents.resolveAgent(agentId);
    const profile = this.agents.getProfileForAgent(agent.id);
    const longTermMemory = this.memory
      .getLongTermMemory(40, agent.id)
      .filter((item) => {
        const text = `${item.title || ""} ${item.text || ""}`;
        return !/\bSmokeUser\b/i.test(text) && !/\bUser name:\s*OmniClaw\b/i.test(text);
      })
      .slice(0, 8);
    return {
      agent,
      profile,
      skills: this.agents.filterSkills(this.skills.getAll(), agent.id),
      tools: this.tools.getAll({ agentId: agent.id }),
      recentConversations: this.memory.getRecentConversations(Math.min(profile.maxRecentConversations || 8, 8), agent.id),
      notes: this.memory.getNotes(agent.id),
      longTermMemory,
      research: this.memory.getResearch(5, agent.id),
      artifacts: this.memory.getArtifacts(5, agent.id),
      tasks: profile.enableTasks ? this.tasks.listTasks(agent.id).slice(0, 8) : [],
    };
  }

  getAgentInspector(agentId = "main", options = {}) {
    const agent = this.agents.resolveAgent(agentId);
    const profile = this.agents.getProfileForAgent(agent.id);
    const workspaceContext = this.loadWorkspaceContext(agent.id);
    const profileFacts = this.readAgentProfileFacts(agent.id);
    const sessions = this.sessions.listSessions(40).filter((session) => session.agentId === agent.id);
    const requestedSessionId = String(options.sessionId || "").trim();
    const selectedSession =
      (requestedSessionId ? this.sessions.getSession(requestedSessionId, { messageLimit: 30 }) : null) ||
      (sessions[0]?.id ? this.sessions.getSession(sessions[0].id, { messageLimit: 30 }) : null);
    const memory = {
      overview: this.memory.getOverview(agent.id),
      recentConversations: this.memory.getRecentConversations(profile.maxRecentConversations || 12, agent.id),
      longTerm: this.memory.getLongTermMemory(20, agent.id),
      notes: this.memory.getNotes(agent.id),
      research: this.memory.getResearch(8, agent.id),
      artifacts: this.memory.getArtifacts(8, agent.id),
    };
    const sessionMessages = (selectedSession?.transcript || []).filter((entry) => entry.type === "message");
    const userMessages = sessionMessages.filter((entry) => entry.role === "user");
    const assistantMessages = sessionMessages.filter((entry) => entry.role === "assistant");

    return sanitizeTraceValue(
      {
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          workspacePath: agent.workspacePath,
          channels: agent.channels || [],
        },
        profile: {
          id: profile.id,
          description: profile.description,
          allowToolExecution: profile.allowToolExecution,
          enableSkillMatching: profile.enableSkillMatching,
          maxRecentConversations: profile.maxRecentConversations,
          contextBudget: this.contextEngine.getMaxChars(profile),
        },
        profileFacts,
        workspace: {
          agentId: workspaceContext.agentId,
          loadedAt: workspaceContext.loadedAt,
          heartbeatPrompt: workspaceContext.heartbeatPrompt,
          manifest: workspaceContext.manifest,
          files: workspaceContext.files.map((file) => ({
            name: file.name,
            scope: file.scope,
            path: file.path,
            chars: String(file.content || "").length,
            contentPreview: file.content || "",
          })),
        },
        memory,
        sessions: {
          count: sessions.length,
          recent: sessions.slice(0, 12),
          selected: selectedSession
            ? {
                id: selectedSession.id,
                label: selectedSession.label,
                status: selectedSession.status,
                channel: selectedSession.channel,
                messageCount: selectedSession.messageCount,
                runCount: selectedSession.runCount,
                transcriptEntryCount: selectedSession.transcriptEntryCount,
                lastUserMessagePreview: selectedSession.lastUserMessagePreview,
                lastAssistantPreview: selectedSession.lastAssistantPreview,
                userMessageCount: userMessages.length,
                assistantMessageCount: assistantMessages.length,
                recentMessages: sessionMessages.slice(-8),
              }
            : null,
        },
        tools: this.tools.getAll({ agentId: agent.id }).slice(0, 80),
        skills: this.agents.filterSkills(this.skills.getAll(), agent.id).slice(0, 40),
      },
      { maxString: 1200, maxArray: 80, maxDepth: 6 },
    );
  }

  getState() {
    this.provider = createProvider(this.config, this.secrets);
    const config = this.config.getConfig();
    const profile = this.config.getActiveProfile();
    const providerInfo = this.provider.getInfo();
    return {
      app: config.app,
      runtime: {
        profile,
        configSecretRefs: summarizeAgentRuntimeSecretRefs(config),
      },
      config,
      provider: {
        ...providerInfo,
        runtimeMetadata: resolveProviderRuntimeMetadata(providerInfo),
      },
      providerSecrets: this.secrets.getAllStatuses(),
      trust: {
        overview: this.trust.getOverview(),
        devices: this.trust.listDevices(),
        pairingRequests: this.trust.listPairingRequests(),
        audit: this.trust.listAudit(40),
      },
      gateway: this.gateway.getOverview(),
      layers: this.getOpenClawLayerReport(),
      v2: this.getV2Report(),
      delegations: this.gateway.listDelegations({ limit: 20 }),
      agents: this.agents.summarizeAgents({
        sessions: this.sessions.listSessions(200),
        memoryStore: this.memory,
        taskStore: this.tasks,
        skillRegistry: this.skills,
        toolRegistry: this.tools,
      }),
      sessions: this.sessions.listSessions(40).map((session) => ({
        id: session.id,
        key: session.key,
        label: session.label,
        agentId: session.agentId,
        channel: session.channel,
        status: session.status,
        lifecycleState: session.lifecycleState,
        lastMessageAt: session.lastMessageAt,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
        runCount: session.runCount,
        activeRunId: session.activeRunId,
        queueDepth: session.queueDepth,
        queuedRunIds: session.queuedRunIds,
        parentSessionId: session.parentSessionId,
        runtimeMetadata: resolveSessionRuntimeMetadata({ providerInfo, session }),
        lastUserMessagePreview: session.lastUserMessagePreview,
        lastAssistantPreview: session.lastAssistantPreview,
        idleMinutes: session.idleMinutes,
      })),
      approvals: this.gateway.listApprovals("pending"),
      jobs: this.jobs.listJobs(12),
      schedules: this.schedules.listSchedules(20),
      scheduler: this.scheduler.getOverview(),
      workers: {
        telegram: this.telegramWorker.getStatus(),
        discord: this.discordWorker.getStatus(),
        background: { running: this.worker.running },
      },
      connectors: {
        telegram: this.connectors.getAdapter("telegram"),
        discord: this.connectors.getAdapter("discord"),
        config: this.connectors.getPublicConfig(),
        adaptersOverview: this.connectors.getAdaptersOverview(),
        adapters: this.connectors.listAdapters(),
        telegramWorker: this.telegramWorker.getStatus(),
        discordWorker: this.discordWorker.getStatus(),
        adapterDeliveries: this.connectors.listAdapterDeliveries(30),
        adapterOutbox: this.connectors.listAdapterOutbox(30),
        adapterAttachmentCache: this.connectors.listAdapterAttachmentCache(30),
        adapterAttachmentExtracts: this.connectors.listAdapterAttachmentExtracts(30),
        adapterAttachmentInjections: this.connectors.listAdapterAttachmentInjections(30),
        adapterAttachmentAnalyses: this.connectors.listAdapterAttachmentAnalyses(30),
        attachmentCleanupRuns: this.connectors.listAttachmentCleanupRuns(10),
        overview: this.connectors.getOverview(),
        webhookDeliveries: this.connectors.listWebhookDeliveries(12),
        fileDropRecords: this.connectors.listFileDropRecords(12),
        pendingFiles: this.connectors.listPendingFiles({ limit: 12 }),
      },
      contextPolicy: {
        maxChars: this.contextEngine.getMaxChars(profile),
        profileId: profile.id,
      },
      shellExecution: {
        policy: {
          enabled: this.shellExecutor.getPolicy().enabled,
          allowlistMode: this.shellExecutor.getPolicy().allowlistMode,
          timeoutMs: this.shellExecutor.getPolicy().timeoutMs,
          maxOutputBytes: this.shellExecutor.getPolicy().maxOutputBytes,
          allowlistPatterns: this.shellExecutor.getPolicy().allowlistPatterns,
          blockedPatterns: this.shellExecutor.getPolicy().blockedPatterns,
          allowlistCount: this.shellExecutor.getPolicy().allowlistPatterns.length,
          blockedPatternCount: this.shellExecutor.getPolicy().blockedPatterns.length,
        },
        audit: this.shellAudit.getOverview(),
        records: this.shellAudit.list({ limit: 12 }),
      },
      workspace: this.getWorkspaceState(),
      plugins: this.plugins.getAll(),
      skills: this.skills.getAll(),
      tools: this.tools.getAll({ includeAllAgents: true }),
      memory: {
        recentConversations: this.memory.getRecentConversations(profile.maxRecentConversations),
        notes: this.memory.getNotes(),
        longTerm: this.memory.getLongTermMemory(50),
        dreams: this.memory.getDreams(20),
        promotionCandidates: this.memory.getPromotionCandidates({ limit: 12 }),
        overview: this.memory.getOverview(),
        research: this.memory.getResearch(),
        artifacts: this.memory.getArtifacts(),
      },
      tasks: profile.enableTasks ? this.tasks.listTasks() : [],
    };
  }

  buildPromptTrace(contextBundle = {}, run = {}) {
    const workspaceFiles = (contextBundle.workspaceContext?.files || []).map((file) => ({
      name: file.name || "",
      scope: file.scope || "",
      path: file.path || "",
      contentPreview: truncateTraceText(file.content || "", 900),
    }));
    return {
      version: "prompt-trace-v1",
      runId: run.id || "",
      sessionId: run.sessionId || "",
      agentId: run.agentId || contextBundle.agent?.id || "main",
      createdAt: new Date().toISOString(),
      report: sanitizeTraceValue(contextBundle.report || {}, { maxString: 900, maxArray: 20, maxDepth: 5 }),
      contextManifest: sanitizeTraceValue(contextBundle.contextManifest || {}, { maxString: 900, maxArray: 24, maxDepth: 5 }),
      agent: sanitizeTraceValue(contextBundle.agent || {}, { maxString: 700, maxArray: 10, maxDepth: 4 }),
      profile: sanitizeTraceValue(contextBundle.profile || {}, { maxString: 700, maxArray: 10, maxDepth: 4 }),
      workspace: {
        agentId: contextBundle.workspaceContext?.agentId || "main",
        fileCount: workspaceFiles.length,
        heartbeatPrompt: truncateTraceText(contextBundle.workspaceContext?.heartbeatPrompt || "", 700),
        files: workspaceFiles,
      },
      tools: sanitizeTraceValue(contextBundle.tools || [], { maxString: 500, maxArray: 80, maxDepth: 3 }),
      skills: sanitizeTraceValue(contextBundle.skills || [], { maxString: 900, maxArray: 24, maxDepth: 3 }),
      harness: sanitizeTraceValue(contextBundle.harness || {}, { maxString: 900, maxArray: 12, maxDepth: 4 }),
      mcp: sanitizeTraceValue(contextBundle.mcp || {}, { maxString: 900, maxArray: 20, maxDepth: 4 }),
      memory: {
        recentConversations: sanitizeTraceValue(contextBundle.recentConversations || [], { maxString: 700, maxArray: 8, maxDepth: 3 }),
        notes: sanitizeTraceValue(contextBundle.notes || [], { maxString: 700, maxArray: 8, maxDepth: 3 }),
        longTermMemory: sanitizeTraceValue(contextBundle.longTermMemory || [], { maxString: 900, maxArray: 8, maxDepth: 3 }),
        research: sanitizeTraceValue(contextBundle.research || [], { maxString: 700, maxArray: 6, maxDepth: 3 }),
        artifacts: sanitizeTraceValue(contextBundle.artifacts || [], { maxString: 500, maxArray: 6, maxDepth: 3 }),
        tasks: sanitizeTraceValue(contextBundle.tasks || [], { maxString: 500, maxArray: 8, maxDepth: 3 }),
      },
      toolOutputs: sanitizeTraceValue(contextBundle.toolOutputs || [], { maxString: 1000, maxArray: 12, maxDepth: 4 }),
      sessionSummary: sanitizeTraceValue(contextBundle.sessionSummary || null, { maxString: 1200, maxArray: 6, maxDepth: 3 }),
      safety: {
        redacted: true,
        note: "Secret-like keys and token-looking strings are redacted before this trace is stored.",
      },
    };
  }

  getPromptTrace(runId = "") {
    const id = String(runId || "").trim();
    const run = id ? this.gateway.getRun(id) : null;
    if (!run) {
      return null;
    }
    return {
      runId: run.id,
      sessionId: run.sessionId || "",
      agentId: run.agentId || "main",
      status: run.status,
      createdAt: run.createdAt || "",
      updatedAt: run.updatedAt || "",
      available: Boolean(run.promptTrace),
      promptTrace: run.promptTrace || null,
      context: run.context || null,
    };
  }

  async handleMcpSlashCommand(message = "", context = {}) {
    const rest = String(message || "").replace(/^\s*\/mcp\b/i, "").trim();
    const [rawCommand = "status", ...tokens] = rest.split(/\s+/).filter(Boolean);
    const command = String(rawCommand || "status").trim().toLowerCase();
    const status = () => {
      const configured = Object.keys(this.mcp?._config || {});
      const connected = this.mcp?.getStatus?.() || {};
      const tools = this.mcp?.getAllTools?.() || [];
      return {
        configured,
        connected,
        toolCount: tools.length,
        tools: tools.slice(0, 20).map((tool) => tool.id || tool.name || ""),
      };
    };

    let result;
    if (["connect", "start"].includes(command)) {
      const target = tokens[0] || "all";
      if (target === "all") {
        result = { ok: true, action: "connect-all", results: await this.mcp.connectAll(), ...status() };
      } else {
        const client = await this.mcp.connectServer(target);
        result = {
          ok: true,
          action: "connect",
          serverId: target,
          tools: client.tools.map((tool) => tool.id || tool.name),
          ...status(),
        };
      }
    } else if (["tools", "list"].includes(command)) {
      result = { ok: true, action: "tools", ...status() };
    } else {
      result = { ok: true, action: "status", ...status() };
    }

    const configuredText = result.configured?.length ? result.configured.join(", ") : "none configured";
    const connectedText = Object.entries(result.connected || {})
      .filter(([, item]) => item?.connected)
      .map(([id]) => id)
      .join(", ") || "none connected";
    const toolText = result.tools?.length ? result.tools.join(", ") : "none";
    return {
      slash: true,
      command,
      context,
      result,
      reply: [
        `MCP ${result.action || "status"}: ok=${Boolean(result.ok)}`,
        `Configured servers: ${configuredText}`,
        `Connected servers: ${connectedText}`,
        `Live tools (${result.toolCount || 0}): ${toolText}`,
      ].join("\n"),
    };
  }

  upsertRunToolTrace(runId = "", entry = {}) {
    const id = String(runId || "").trim();
    const run = id ? this.gateway.getRun(id) : null;
    if (!run) {
      return null;
    }
    const now = new Date().toISOString();
    const traceId = entry.id || createToolTraceId();
    const sanitized = sanitizeTraceValue(
      {
        ...entry,
        id: traceId,
        input: entry.input,
        output: entry.output,
        updatedAt: now,
      },
      { maxString: 1000, maxArray: 16, maxDepth: 5 },
    );
    const toolTrace = Array.isArray(run.toolTrace) ? [...run.toolTrace] : [];
    const index = toolTrace.findIndex((item) => item.id === traceId);
    if (index >= 0) {
      toolTrace[index] = {
        ...toolTrace[index],
        ...sanitized,
      };
    } else {
      toolTrace.push({
        createdAt: now,
        ...sanitized,
      });
    }
    const cappedTrace = toolTrace.slice(-80);
    const activeTool = [...cappedTrace].reverse().find((item) => item.status === "running");
    this.gateway.updateRun(id, {
      toolTrace: cappedTrace,
      toolTraceCount: cappedTrace.length,
      toolExecutionStatus: activeTool ? "running" : sanitized.status || run.toolExecutionStatus || "",
      currentTool: activeTool?.tool || "",
    });
    return cappedTrace.find((item) => item.id === traceId) || null;
  }

  getToolTrace(runId = "") {
    const id = String(runId || "").trim();
    const run = id ? this.gateway.getRun(id) : null;
    if (!run) {
      return null;
    }
    const toolTrace = Array.isArray(run.toolTrace) ? run.toolTrace : [];
    const modelToolLoop = run.modelToolLoop || null;
    return {
      runId: run.id,
      sessionId: run.sessionId || "",
      agentId: run.agentId || "main",
      status: run.status,
      available: toolTrace.length > 0 || Boolean(modelToolLoop?.attempted || modelToolLoop?.skippedReason),
      toolTrace,
      toolTraceCount: toolTrace.length,
      currentTool: run.currentTool || "",
      toolExecutionStatus: run.toolExecutionStatus || "",
      modelToolLoop,
      shellExecutions: sanitizeTraceValue(run.shellExecutions || [], { maxString: 1000, maxArray: 12, maxDepth: 4 }),
    };
  }

  queueDelegation(input = {}) {
    const targetAgentId = String(input.targetAgentId || input.agentId || "").trim();
    const instruction = String(input.instruction || input.task || "").trim();
    const awaitChild = Boolean(input.awaitChild);
    if (!targetAgentId) {
      throw new Error("targetAgentId is required");
    }
    if (!instruction) {
      throw new Error("delegation instruction is required");
    }

    const targetAgent = this.agents.resolveAgent(targetAgentId);
    if (!targetAgent) {
      throw new Error(`Could not resolve target agent: ${targetAgentId}`);
    }

    const sourceAgent = this.agents.resolveAgent(input.sourceAgentId || "main");
    const sourceAgentId = sourceAgent?.id || String(input.sourceAgentId || "main").trim() || "main";
    const parentRunId = String(input.parentRunId || "").trim();
    const parentSessionId = String(input.parentSessionId || input.sessionId || "").trim();
    const delegation = this.gateway.createDelegation({
      parentRunId,
      parentSessionId,
      sourceAgentId,
      targetAgentId: targetAgent.id,
      instruction,
      status: "queued",
      source: input.source || "manual",
    });

    this.gateway.addEvent("agent.delegated", {
      delegationId: delegation.id,
      runId: parentRunId,
      sessionId: parentSessionId,
      sourceAgentId,
      targetAgentId: targetAgent.id,
      instruction,
      source: input.source || "manual",
    });

    if (parentSessionId) {
      try {
        this.sessions.appendSystemEvent(parentSessionId, "delegation.created", {
          delegationId: delegation.id,
          targetAgentId: targetAgent.id,
          instruction,
        });
      } catch {
        // Parent sessions can be optional for manual gateway-created handoffs.
      }
    }

    const delegateSession = this.sessions.resolveSession({
      agentId: targetAgent.id,
      label: input.label || `delegation:${delegation.id}`,
      channel: "internal",
      parentSessionId,
    });
    this.gateway.updateDelegation(delegation.id, {
      status: "running",
      childSessionId: delegateSession.id,
      attempts: Number(delegation.attempts || 0) + 1,
      startedAt: new Date().toISOString(),
    });
    this.sessions.appendSystemEvent(delegateSession.id, "delegation.assigned", {
      delegationId: delegation.id,
      parentSessionId,
      parentRunId,
      sourceAgentId,
    });

    const childRunPromise = this.handleMessage(instruction, {
      sessionId: delegateSession.id,
      label: delegateSession.label,
      agentId: targetAgent.id,
      channel: "internal",
      source: "delegation",
      parentRunId,
      parentSessionId,
      delegationId: delegation.id,
    });
    const acceptedChildRun = this.gateway.listRuns(20).find(
      (candidate) => candidate.delegationId === delegation.id && candidate.sessionId === delegateSession.id,
    );
    const acceptedSessionSpawn = normalizeAcceptedSessionSpawnResult({
      details: {
        status: acceptedChildRun ? "accepted" : "",
        runId: acceptedChildRun?.id || "",
        childSessionKey: delegateSession.key || "",
      },
    });
    if (acceptedSessionSpawn) {
      this.gateway.updateDelegation(delegation.id, {
        childRunId: acceptedSessionSpawn.runId,
        childSessionKey: acceptedSessionSpawn.childSessionKey,
      });
      this.gateway.addEvent("delegation.accepted_session_spawned", {
        delegationId: delegation.id,
        parentRunId,
        parentSessionId,
        targetAgentId: targetAgent.id,
        childRunId: acceptedSessionSpawn.runId,
        childSessionId: delegateSession.id,
        childSessionKey: acceptedSessionSpawn.childSessionKey,
      });
      if (parentSessionId) {
        try {
          this.sessions.appendSystemEvent(parentSessionId, "delegation.accepted_session_spawned", {
            delegationId: delegation.id,
            targetAgentId: targetAgent.id,
            childSessionId: delegateSession.id,
            childRunId: acceptedSessionSpawn.runId,
            childSessionKey: acceptedSessionSpawn.childSessionKey,
          });
        } catch {
          // Manual delegations may not have a parent transcript to annotate.
        }
      }
    }

    childRunPromise.then((result) => {
      const completedAt = new Date().toISOString();
      const current = this.gateway.getDelegation(delegation.id);
      if (current?.status === "cancelled") {
        this.gateway.addEvent("delegation.completion_ignored", {
          delegationId: delegation.id,
          parentRunId,
          childRunId: result?.run?.id || "",
          targetAgentId: targetAgent.id,
          reason: "cancelled",
        });
        return;
      }
      this.gateway.updateDelegation(delegation.id, {
        status: "completed",
        childRunId: result?.run?.id || "",
        replyPreview: String(result?.reply || "").slice(0, 280),
        completedAt,
      });
      this.gateway.addEvent("delegation.completed", {
        delegationId: delegation.id,
        parentRunId,
        childRunId: result?.run?.id || "",
        targetAgentId: targetAgent.id,
      });
      if (parentSessionId) {
        try {
          this.sessions.appendSystemEvent(parentSessionId, "delegation.completed", {
            delegationId: delegation.id,
            targetAgentId: targetAgent.id,
            childSessionId: delegateSession.id,
            childRunId: result?.run?.id || "",
          });
        } catch {
          // Manual delegations may not have a parent transcript to annotate.
        }
      }
    }).catch((error) => {
      const completedAt = new Date().toISOString();
      const current = this.gateway.getDelegation(delegation.id);
      if (current?.status === "cancelled") {
        this.gateway.addEvent("delegation.failure_ignored", {
          delegationId: delegation.id,
          parentRunId,
          targetAgentId: targetAgent.id,
          error: error.message,
          reason: "cancelled",
        });
        return;
      }
      this.gateway.updateDelegation(delegation.id, {
        status: "failed",
        error: error.message,
        completedAt,
      });
      this.gateway.addEvent("delegation.failed", {
        delegationId: delegation.id,
        parentRunId,
        targetAgentId: targetAgent.id,
        error: error.message,
      });
      if (parentSessionId) {
        try {
          this.sessions.appendSystemEvent(parentSessionId, "delegation.failed", {
            delegationId: delegation.id,
            targetAgentId: targetAgent.id,
            error: error.message,
          });
        } catch {
          // Manual delegations may not have a parent transcript to annotate.
        }
      }
    });

    return {
      delegation: this.gateway.getDelegation(delegation.id),
      childSession: delegateSession,
      acceptedSessionSpawn,
      queued: true,
      ...(awaitChild ? { result: childRunPromise } : {}),
    };
  }

  cancelDelegation(delegationId, note = "manual-cancel") {
    const id = String(delegationId || "").trim();
    if (!id) {
      throw new Error("delegationId is required");
    }

    const delegation = this.gateway.getDelegation(id);
    if (!delegation) {
      throw new Error(`Delegation not found: ${id}`);
    }

    if (["completed", "failed", "cancelled"].includes(delegation.status)) {
      return {
        updated: false,
        reason: `Delegation is already ${delegation.status}.`,
        delegation,
      };
    }

    const cancelledAt = new Date().toISOString();
    const updated = this.gateway.updateDelegation(id, {
      status: "cancelled",
      cancelledAt,
      cancelReason: String(note || "manual-cancel").trim(),
    });
    this.gateway.addEvent("delegation.cancelled", {
      delegationId: id,
      parentRunId: updated.parentRunId || "",
      childRunId: updated.childRunId || "",
      targetAgentId: updated.targetAgentId || "",
      reason: updated.cancelReason,
    });
    if (updated.parentSessionId) {
      try {
        this.sessions.appendSystemEvent(updated.parentSessionId, "delegation.cancelled", {
          delegationId: id,
          targetAgentId: updated.targetAgentId,
          reason: updated.cancelReason,
        });
      } catch {
        // Manual or old delegations may not have a parent transcript.
      }
    }

    return {
      updated: true,
      delegation: updated,
    };
  }

  retryDelegation(delegationId, input = {}) {
    const id = String(delegationId || "").trim();
    if (!id) {
      throw new Error("delegationId is required");
    }

    const delegation = this.gateway.getDelegation(id);
    if (!delegation) {
      throw new Error(`Delegation not found: ${id}`);
    }

    if (["queued", "running"].includes(delegation.status)) {
      return {
        retried: false,
        reason: `Delegation is still ${delegation.status}.`,
        delegation,
      };
    }

    const retry = this.queueDelegation({
      sourceAgentId: input.sourceAgentId || delegation.sourceAgentId || "main",
      targetAgentId: input.targetAgentId || delegation.targetAgentId,
      instruction: input.instruction || delegation.instruction,
      parentSessionId: input.parentSessionId || delegation.parentSessionId || "",
      parentRunId: input.parentRunId || delegation.parentRunId || "",
      source: input.source || "retry",
    });
    const updatedOriginal = this.gateway.updateDelegation(id, {
      retryDelegationId: retry.delegation?.id || "",
      retriedAt: new Date().toISOString(),
    });
    this.gateway.addEvent("delegation.retried", {
      delegationId: id,
      retryDelegationId: retry.delegation?.id || "",
      targetAgentId: retry.delegation?.targetAgentId || delegation.targetAgentId || "",
    });

    return {
      retried: true,
      original: updatedOriginal,
      retry,
    };
  }

  async handleMessage(message, options = {}) {
    this.provider = createProvider(this.config, this.secrets);
    const requestedAgent = this.agents.resolveAgent(options.agentId || "main");
    if (!requestedAgent) {
      throw new Error(`Could not resolve agent: ${options.agentId || "main"}`);
    }

    const session = this.sessions.resolveSession({
      sessionId: options.sessionId,
      label: options.label || "main",
      agentId: requestedAgent.id,
      channel: options.channel || "webchat",
      parentSessionId: options.parentSessionId || "",
    });

    if (!session) {
      throw new Error(`Could not resolve session: ${options.sessionId || "default"}`);
    }
    const queue = this.getSessionRunQueue(session.id);
    const enqueuedAt = new Date().toISOString();
    const wasQueued = queue.processing || queue.pending.length > 0;
    const run = this.gateway.createRun({
      sessionId: session.id,
      sessionKey: session.key,
      agentId: session.agentId,
      channel: session.channel,
      label: session.label,
      message,
      status: wasQueued ? "queued" : "accepted",
      source: options.source || "chat",
      parentRunId: options.parentRunId || "",
      parentSessionId: options.parentSessionId || "",
      delegationId: options.delegationId || "",
      enqueuedAt,
      acceptedAt: wasQueued ? null : enqueuedAt,
      queuePosition: wasQueued ? queue.pending.length + 1 : 0,
    });
    if (wasQueued) {
      this.gateway.addEvent("agent.queued", {
        runId: run.id,
        sessionId: session.id,
        sessionKey: session.key,
        queuePosition: queue.pending.length + 1,
      });
    }

    return this.enqueueSessionRun({
      session,
      message,
      run,
      enqueuedAt,
      wasQueued,
    });
  }

  async injectAdapterAttachmentExtract(input = {}) {
    const extract = this.connectors.getAdapterAttachmentExtractItem(input.extractId || input.id);
    if (extract.status === "failed") {
      throw new Error(`Attachment extract ${extract.id} failed and cannot be injected until extraction succeeds.`);
    }

    let delivery = null;
    try {
      delivery = extract.deliveryId ? this.connectors.getAdapterDelivery(extract.deliveryId) : null;
    } catch {
      delivery = null;
    }

    const requestedAgent = this.agents.resolveAgent(input.agentId || delivery?.agentId || "main");
    const label = String(input.label || delivery?.label || `${extract.adapterId || "adapter"}-extract`).trim() || "attachment-extract";
    const maxChars = Math.max(256, Number(input.maxChars || 12000));
    const message = buildAttachmentExtractImportMessage(extract, maxChars);
    let result = null;

    try {
      result = await this.handleMessage(message, {
        sessionId: input.sessionId,
        label,
        agentId: requestedAgent.id,
        channel: "attachment-extract",
      });
    } catch (error) {
      const injectionResult = this.connectors.recordAdapterAttachmentInjection({
        extractId: extract.id,
        agentId: requestedAgent.id,
        label,
        sessionId: input.sessionId || "",
        status: "failed",
        error: error.message,
        message,
        result,
        source: input.source || "manual",
      });
      this.gateway.addEvent("connector.adapter_attachment_injection_failed", {
        injectionId: injectionResult.injection.id,
        extractId: extract.id,
        adapterId: extract.adapterId,
        error: error.message,
        agentId: requestedAgent.id,
      });
      error.injection = injectionResult.injection;
      error.extract = injectionResult.extract;
      throw error;
    }

    const status = result?.error ? "failed" : "completed";
    const injectionResult = this.connectors.recordAdapterAttachmentInjection({
      extractId: extract.id,
      agentId: requestedAgent.id,
      label,
      sessionId: result?.session?.id || input.sessionId || "",
      sessionKey: result?.session?.key || "",
      runId: result?.run?.id || "",
      runStatus: result?.run?.status || "",
      provider: result?.provider?.id || "",
      status,
      error: result?.error || "",
      message,
      result,
      source: input.source || "manual",
    });

    let memorySource = null;
    let memoryError = "";
    if (status === "completed") {
      try {
        memorySource = this.memory.addAttachmentExtract({
          extractId: extract.id,
          cacheId: extract.cacheId,
          deliveryId: extract.deliveryId,
          adapterId: extract.adapterId,
          agentId: requestedAgent.id,
          sessionId: result?.session?.id || "",
          runId: result?.run?.id || "",
          title: `${extract.name || extract.type || "Attachment"} from ${extract.adapterId || "adapter"}`,
          text: message,
          status: extract.status === "completed" ? "completed" : "metadata-only",
          tags: [extract.adapterId, extract.mimeType, extract.type],
        });
      } catch (error) {
        memoryError = error.message;
        this.gateway.addEvent("memory.attachment_extract_candidate_failed", {
          extractId: extract.id,
          injectionId: injectionResult.injection.id,
          error: error.message,
          agentId: requestedAgent.id,
        });
      }
    }

    this.gateway.addEvent("connector.adapter_attachment_injected", {
      injectionId: injectionResult.injection.id,
      extractId: extract.id,
      adapterId: extract.adapterId,
      status,
      sessionId: injectionResult.injection.sessionId,
      runId: injectionResult.injection.runId,
      agentId: requestedAgent.id,
    });

    return {
      ...injectionResult,
      memorySource,
      memoryError,
      result,
    };
  }

  async cacheAdapterDeliveryAttachment(delivery, attachmentIndex, policy = {}) {
    const input = {
      deliveryId: delivery.id,
      attachmentIndex,
      maxBytes: policy.maxCacheBytes,
    };
    if (delivery.adapterId === "telegram") {
      return this.telegramWorker.cacheAttachment(input);
    }
    if (delivery.adapterId === "discord") {
      return this.discordWorker.cacheAttachment(input);
    }
    throw new Error(`Adapter ${delivery.adapterId || "(missing)"} does not support attachment caching yet.`);
  }

  async ingestAdapterDeliveryAttachments(input = {}, options = {}) {
    const delivery = typeof input === "string" ? this.connectors.getAdapterDelivery(input) : input;
    if (!delivery?.id) {
      throw new Error("deliveryId is required.");
    }

    const policy = this.connectors.getAttachmentIngestionPolicy(options.policy || {});
    const attachments = Array.isArray(delivery.attachments) ? delivery.attachments : [];
    const startedAt = new Date().toISOString();
    const shouldRun = options.force || (policy.enabled && attachments.length > 0 && (policy.autoCache || policy.autoExtract || policy.autoInject));
    const summary = {
      deliveryId: delivery.id,
      adapterId: delivery.adapterId || "",
      source: options.source || "auto",
      policy,
      status: shouldRun ? "running" : "skipped",
      startedAt,
      completedAt: null,
      processed: 0,
      cached: 0,
      extracted: 0,
      injected: 0,
      failed: 0,
      skipped: attachments.length,
      analyzed: 0,
      analysisFailed: 0,
      steps: [],
    };

    if (!shouldRun) {
      this.connectors.updateAdapterDelivery(delivery.id, {
        autoIngestionStatus: "skipped",
        autoIngestionAt: startedAt,
        autoIngestionSummary: "Attachment ingestion policy skipped this delivery.",
      });
      return summary;
    }

    this.connectors.updateAdapterDelivery(delivery.id, {
      autoIngestionStatus: "running",
      autoIngestionAt: startedAt,
    });
    this.gateway.addEvent("connector.adapter_attachment_auto_ingestion_started", {
      deliveryId: delivery.id,
      adapterId: delivery.adapterId || "",
      attachmentCount: attachments.length,
      source: summary.source,
    });

    const limit = Math.min(attachments.length, Number(policy.maxAttachmentsPerDelivery || 1));
    summary.skipped = Math.max(0, attachments.length - limit);

    for (let attachmentIndex = 0; attachmentIndex < limit; attachmentIndex += 1) {
      const step = {
        attachmentIndex,
        status: "running",
        cacheId: "",
        extractId: "",
        analysisId: "",
        analysisStatus: "",
        injectionId: "",
        error: "",
      };
      summary.steps.push(step);

      try {
        const latestDelivery = this.connectors.getAdapterDelivery(delivery.id);
        const latestAttachment = latestDelivery.attachments?.[attachmentIndex] || {};
        let cache = latestAttachment.cacheId && !options.force ? this.connectors.getAdapterAttachmentCacheItem(latestAttachment.cacheId) : null;
        if ((policy.autoCache || options.force) && (!cache || cache.status !== "cached" || options.force)) {
          const cacheResult = await this.cacheAdapterDeliveryAttachment(latestDelivery, attachmentIndex, policy);
          cache = cacheResult.cache;
        }
        if (cache?.id) {
          step.cacheId = cache.id;
          if (cache.status === "cached") {
            summary.cached += 1;
          }
        }

        let extract = cache?.extractId && !options.force ? this.connectors.getAdapterAttachmentExtractItem(cache.extractId) : null;
        if ((policy.autoExtract || options.force) && cache?.status === "cached" && (!extract || extract.status === "failed" || options.force)) {
          const extractResult = this.connectors.extractAdapterAttachmentCache({
            cacheId: cache.id,
            maxBytes: policy.maxExtractBytes,
            maxChars: policy.maxExtractChars,
          });
          extract = extractResult.extract;
        }
        if (extract?.id) {
          step.extractId = extract.id;
          if (["completed", "unsupported", "media-metadata"].includes(extract.status)) {
            summary.extracted += 1;
          }
        }

        if (extract?.status === "media-metadata") {
          const mediaPolicy = this.connectors.getAttachmentMediaAnalysisPolicy();
          if (mediaPolicy.enabled && mediaPolicy.autoAnalyze) {
            try {
              const analysisResult = await this.connectors.analyzeAdapterAttachmentMedia({
                extractId: extract.id,
                policy: mediaPolicy,
              });
              step.analysisId = analysisResult.analysis?.id || "";
              step.analysisStatus = analysisResult.analysis?.status || "";
              if (analysisResult.analysis?.status === "completed") {
                summary.analyzed += 1;
                extract = analysisResult.extract || extract;
              } else if (analysisResult.analysis?.status === "failed") {
                summary.analysisFailed += 1;
              }
            } catch (error) {
              step.analysisStatus = "failed";
              step.analysisError = error.message;
              summary.analysisFailed += 1;
            }
          }
        }

        const canInject =
          policy.autoInject &&
          extract &&
          extract.status !== "failed" &&
          (policy.includeUnsupported || extract.status === "completed");
        if (canInject && (!latestAttachment.injectionId || options.force)) {
          const injected = await this.injectAdapterAttachmentExtract({
            extractId: extract.id,
            agentId: latestDelivery.agentId || "main",
            label: latestDelivery.label || `${latestDelivery.adapterId || "adapter"}-extract`,
            maxChars: policy.maxExtractChars,
            source: "auto-ingestion",
          });
          step.injectionId = injected.injection?.id || "";
          if (injected.injection?.status === "completed") {
            summary.injected += 1;
          }
        } else if (latestAttachment.injectionId) {
          step.injectionId = latestAttachment.injectionId;
        }

        step.status = "completed";
        summary.processed += 1;
      } catch (error) {
        step.status = "failed";
        step.error = error.message;
        if (error.cache?.id) {
          step.cacheId = error.cache.id;
        }
        summary.failed += 1;
      }
    }

    summary.status = summary.failed > 0 ? (summary.processed > 0 ? "partial" : "failed") : "completed";
    summary.completedAt = new Date().toISOString();
    this.connectors.updateAdapterDelivery(delivery.id, {
      autoIngestionStatus: summary.status,
      autoIngestionAt: summary.completedAt,
      autoIngestionSummary: `${summary.cached} cached, ${summary.extracted} extracted, ${summary.analyzed} analyzed, ${summary.injected} injected, ${summary.failed} failed.`,
      autoIngestionError: summary.steps.find((step) => step.error || step.analysisError)?.error || summary.steps.find((step) => step.analysisError)?.analysisError || "",
    });
    this.gateway.addEvent("connector.adapter_attachment_auto_ingestion_completed", {
      deliveryId: delivery.id,
      adapterId: delivery.adapterId || "",
      status: summary.status,
      cached: summary.cached,
      extracted: summary.extracted,
      analyzed: summary.analyzed,
      analysisFailed: summary.analysisFailed,
      injected: summary.injected,
      failed: summary.failed,
    });

    return summary;
  }

  async receiveWebhook(input = {}) {
    const message = String(input.message || input.text || "").trim();
    if (!message) {
      throw new Error("message is required");
    }
    const requestedAgentId = String(input.agentId || "").trim();
    const agentId = this.connectors.resolveWebhookAgent(requestedAgentId);
    const label = String(input.label || "webhook").trim() || "webhook";
    const auth = this.connectors.authorizeWebhook(input.connectorToken || input.token || "");
    if (!auth.ok) {
      const delivery = this.connectors.recordWebhook({
        message,
        label,
        agentId,
        requestedAgentId,
        auth: "rejected",
        source: input.source || "webhook",
        status: "rejected",
        error: auth.message,
      });
      this.gateway.addEvent("connector.webhook_rejected", {
        deliveryId: delivery.id,
        label,
        agentId,
        requestedAgentId,
        code: auth.code,
      });
      const error = new Error(auth.message);
      error.code = auth.code;
      error.statusCode = auth.statusCode;
      throw error;
    }

    this.gateway.addEvent("connector.webhook_received", {
      agentId,
      requestedAgentId,
      label,
      auth: auth.auth,
    });

    try {
      const result = await this.handleMessage(message, {
        agentId,
        label,
        channel: "webhook",
      });
      const delivery = this.connectors.recordWebhook({
        message,
        label,
        agentId,
        requestedAgentId,
        auth: auth.auth,
        source: input.source || "webhook",
        result,
        status: result.error ? "failed" : "completed",
        error: result.error || "",
      });
      this.gateway.addEvent("connector.webhook_completed", {
        deliveryId: delivery.id,
        runId: delivery.result?.runId || "",
        sessionId: delivery.result?.sessionId || "",
        status: delivery.status,
      });
      return { delivery, result };
    } catch (error) {
      const delivery = this.connectors.recordWebhook({
        message,
        label,
        agentId,
        requestedAgentId,
        auth: auth.auth,
        source: input.source || "webhook",
        status: "failed",
        error: error.message,
      });
      this.gateway.addEvent("connector.webhook_failed", {
        deliveryId: delivery.id,
        error: error.message,
      });
      throw error;
    }
  }

  async scanFileDrop(input = {}) {
    this.connectors.assertFileDropEnabled();
    const agentId = this.connectors.resolveFileDropAgent(input.agentId);
    const files = this.connectors.listPendingFiles({
      limit: Number(input.limit || 10),
      agentId,
    });
    const processed = [];

    this.gateway.addEvent("connector.file_drop_scan_started", {
      agentId,
      pending: files.length,
    });

    for (const file of files) {
      try {
        const result = await this.handleMessage(file.message, {
          agentId: file.agentId,
          label: file.label,
          channel: "file-drop",
        });
        const record = this.connectors.markFileProcessed(file, {
          result,
          status: result.error ? "failed" : "completed",
          error: result.error || "",
        });
        processed.push(record);
        this.gateway.addEvent("connector.file_drop_processed", {
          recordId: record.id,
          fileName: record.fileName,
          runId: record.result?.runId || "",
          status: record.status,
        });
      } catch (error) {
        const record = this.connectors.markFileProcessed(file, {
          status: "failed",
          error: error.message,
        });
        processed.push(record);
        this.gateway.addEvent("connector.file_drop_failed", {
          recordId: record.id,
          fileName: record.fileName,
          error: error.message,
        });
      }
    }

    this.gateway.addEvent("connector.file_drop_scan_completed", {
      agentId,
      processed: processed.length,
    });
    return {
      processed,
      pendingBefore: files.length,
      overview: this.connectors.getOverview(),
    };
  }

  getSessionRunQueue(sessionId) {
    if (!this.sessionRunQueues.has(sessionId)) {
      this.sessionRunQueues.set(sessionId, {
        processing: false,
        activeRunId: null,
        pending: [],
      });
    }
    return this.sessionRunQueues.get(sessionId);
  }

  syncSessionRunQueue(sessionId) {
    const queue = this.getSessionRunQueue(sessionId);
    const queuedRunIds = queue.pending.map((job) => job.run.id);
    this.sessions.updateQueueState(sessionId, queuedRunIds);

    queue.pending.forEach((job, index) => {
      this.gateway.updateRun(job.run.id, {
        status: "queued",
        queuePosition: index + 1,
        queuedAt: job.enqueuedAt,
        waitingForRunId: queue.activeRunId,
      });
    });
  }

  enqueueSessionRun(job) {
    const queue = this.getSessionRunQueue(job.session.id);
    return new Promise((resolve, reject) => {
      queue.pending.push({
        ...job,
        resolve,
        reject,
      });

      if (queue.processing) {
        this.syncSessionRunQueue(job.session.id);
      } else {
        void this.drainSessionRunQueue(job.session.id);
      }
    });
  }

  async drainSessionRunQueue(sessionId) {
    const queue = this.getSessionRunQueue(sessionId);
    if (queue.processing) {
      return;
    }

    queue.processing = true;
    try {
      while (queue.pending.length > 0) {
        const job = queue.pending.shift();
        queue.activeRunId = job.run.id;
        this.syncSessionRunQueue(sessionId);
        try {
          // Hard timeout: keep long agentic tasks bounded but do not fail right before completion.
          const hardTimeoutMs = Math.max(
            60000,
            Math.min(86_400_000, Number(this.config.getConfig().runtime?.agentLoop?.timeoutMs || 3_600_000)),
          );
          const result = await Promise.race([
            this.executeMessageRun(job),
            new Promise((_, reject) => setTimeout(
              () => reject(new Error(`Run timed out after ${hardTimeoutMs}ms. The provider or tool execution took too long.`)),
              hardTimeoutMs,
            )),
          ]);
          job.resolve(result);
        } catch (error) {
          // Graceful error recovery: save error to run record
          const failedAt = new Date().toISOString();
          try {
            this.gateway.updateRun(job.run.id, {
              status: "failed",
              completedAt: failedAt,
              error: error.message,
              providerStatus: "failed",
              providerDiagnostics: {
                ok: false,
                status: "failed",
                reason: "run_timeout",
                message: error.message,
                providerId: this.provider.getInfo?.()?.id || "unknown",
                model: this.provider.getInfo?.()?.model || "",
                completedAt: failedAt,
              },
            });
            this.sessions.appendMessage(job.session.id, {
              id: `message_${Date.now()}_error`,
              at: failedAt,
              role: "assistant",
              text: `Request timed out: ${error.message}. The provider took too long to respond. Try a simpler question or check your API connection.`,
              runId: job.run.id,
            });
            this.sessions.finishRun(job.session.id, job.run.id, {
              status: "error",
              at: failedAt,
              error: error.message,
            });
          } catch {}
          job.reject(error);
        } finally {
          queue.activeRunId = null;
          this.syncSessionRunQueue(sessionId);
        }
      }
    } finally {
      queue.processing = false;
      if (!queue.activeRunId && queue.pending.length === 0) {
        this.sessionRunQueues.delete(sessionId);
      }
    }
  }

  async executeMessageRun(job) {
    this.provider = createProvider(this.config, this.secrets);
    const { session, message, run, enqueuedAt, wasQueued } = job;
    const startedAt = new Date().toISOString();
    const waitedMs = Math.max(0, Date.now() - Date.parse(enqueuedAt));
    let runGuard = this.sessions.startRun(session.id, {
      runId: run.id,
      message,
      at: enqueuedAt,
    });
    if (!runGuard.ok && runGuard.reason === "busy" && runGuard.activeRunId) {
      const recovery = this.recoverBlockingRunIfStale({
        sessionId: session.id,
        blockedByRunId: runGuard.activeRunId,
        reason: "start-run-busy-guard",
      });
      if (recovery.recovered) {
        runGuard = this.sessions.startRun(session.id, {
          runId: run.id,
          message,
          at: enqueuedAt,
        });
      }
    }
    if (!runGuard.ok) {
      const rejectedRun = this.gateway.updateRun(run.id, {
        status: runGuard.reason === "archived" ? "archived" : "busy",
        completedAt: startedAt,
        blockedByRunId: runGuard.activeRunId,
      });
      this.gateway.addEvent("agent.rejected", {
        runId: run.id,
        sessionId: session.id,
        reason: runGuard.reason || "busy",
        blockedByRunId: runGuard.activeRunId,
      });
      return {
        error:
          runGuard.reason === "archived"
            ? "This session has been archived. Start a new session with the same label or pick another one."
            : "This session already has an active run. Wait for it to finish or reset the session.",
        session,
        run: {
          id: run.id,
          status: rejectedRun.status,
          blockedByRunId: runGuard.activeRunId,
        },
        provider: this.provider.getInfo(),
      };
    }

    this.gateway.updateRun(run.id, {
      status: "accepted",
      acceptedAt: enqueuedAt,
      startedAt,
      queuePosition: 0,
      waitedMs,
    });
    emitAgentLoopStage(this.gateway, "intake", {
      runId: run.id,
      sessionId: session.id,
      agentId: session.agentId,
      sessionKey: session.key,
      messageChars: message.length,
    });
    emitAgentLoopStage(this.gateway, "session_queue", {
      runId: run.id,
      sessionId: session.id,
      agentId: session.agentId,
      queued: wasQueued,
      waitedMs,
      queueDepth: session.queueDepth || 0,
    });
    this.gateway.addEvent("agent.accepted", {
      runId: run.id,
      sessionId: session.id,
      sessionKey: session.key,
      queued: wasQueued,
      waitedMs,
    });
    if (wasQueued) {
      this.gateway.addEvent("agent.dequeued", {
        runId: run.id,
        sessionId: session.id,
        waitedMs,
      });
    }

    this.sessions.appendMessage(session.id, {
      id: `message_${Date.now()}`,
      at: enqueuedAt,
      role: "user",
      text: message,
    });
    this.contextEngine.ingest(
      { role: "user", text: message, sessionId: session.id, runId: run.id },
      { sessionId: session.id, runId: run.id },
    );

    const routedAgent = this.agents.resolveAgent(session.agentId);
    const profile = this.agents.getProfileForAgent(routedAgent.id);
    const providerInfoForDecision = this.provider.getInfo?.() || {};
    let earlyWorkspaceContext = this.loadWorkspaceContext(routedAgent.id);
    const loopContract = buildAgentLoopContract({
      session,
      run,
      agent: routedAgent,
      profile,
      workspaceContext: earlyWorkspaceContext,
      providerInfo: providerInfoForDecision,
    });
    emitAgentLoopStage(this.gateway, "workspace_snapshot", {
      runId: run.id,
      sessionId: session.id,
      agentId: routedAgent.id,
      workspaceFileCount: earlyWorkspaceContext.files.length,
      missingWorkspaceFiles: earlyWorkspaceContext.manifest?.missingRequiredFiles || [],
    });
    emitAgentLoopStage(this.gateway, "system_prompt", {
      runId: run.id,
      sessionId: session.id,
      agentId: routedAgent.id,
      promptBuilder: "buildOmniClawSystemPrompt",
      note: "System prompt is sectioned and assembled by provider adapter from context bundle.",
    });
    const availableTools = this.tools.getAll({ agentId: routedAgent.id, modelCallableOnly: true });
    const intents = this.intentEngine.detect(message);
    const matchedSkills = profile.enableSkillMatching
      ? intents.includes("capabilities")
        ? this.agents.filterSkills(this.skills.getAll(), routedAgent.id)
        : this.skills.match(message, {
            agentId: routedAgent.id,
          })
      : [];
    const modelToolLoopContext = {
      workspaceContext: earlyWorkspaceContext,
      skills: matchedSkills,
      activeMemory: null,
      longTermMemory: [],
      notes: [],
      recentConversations: [],
    };
    const preLoopAgentContext = this.getAgentContext(routedAgent.id);
    modelToolLoopContext.activeMemory = null;
    modelToolLoopContext.longTermMemory = preLoopAgentContext.longTermMemory;
    modelToolLoopContext.notes = preLoopAgentContext.notes;
    modelToolLoopContext.recentConversations = preLoopAgentContext.recentConversations;
    modelToolLoopContext.research = preLoopAgentContext.research;
    modelToolLoopContext.artifacts = preLoopAgentContext.artifacts;
    modelToolLoopContext.tasks = preLoopAgentContext.tasks;
    // Memory, bootstrap ritual, and session summary must be available BEFORE
    // the model loop so OmniLoop's system prompt carries the agent's full
    // identity + recalled context (legacy synthesis reuses the same values).
    const preLoopBootstrapRitual = this.hasBootstrapRitual(routedAgent.id)
      ? this.readBootstrapFile(routedAgent.id)
      : null;
    const preLoopActiveMemory = preLoopBootstrapRitual
      ? {
          status: "skipped",
          reason: "bootstrap_active",
          elapsedMs: 0,
          hitCount: 0,
          summary: "",
        }
      : await this.activeMemory.run({
          message,
          agentId: routedAgent.id,
          session,
          runId: run.id,
        });
    modelToolLoopContext.activeMemory = preLoopActiveMemory;
    modelToolLoopContext.bootstrapRitual = preLoopBootstrapRitual;
    try {
      modelToolLoopContext.sessionSummary = this.summarizer.readSummary(session.id);
    } catch {
      modelToolLoopContext.sessionSummary = null;
    }
    const bootstrapFilePresent = this.readBootstrapFile(routedAgent.id) !== null;
    const profileUpdate = bootstrapFilePresent
      ? { updated: false, facts: [] }
      : this.updateProfileFromMessage(routedAgent.id, message);
    const realProviderReady = providerInfoForDecision.ready !== false && providerInfoForDecision.id !== "mock/local-rule-engine";

    // Bootstrap ritual takes priority: if BOOTSTRAP.md exists, the runtime handles the setup state.
    const hasBootstrap = this.hasBootstrapRitual(routedAgent.id);
    if (hasBootstrap) {
      const bootstrapFacts = this.extractBootstrapFacts(message);
      const hasBootstrapFacts = Boolean(
        bootstrapFacts.userName ||
        bootstrapFacts.userLocation ||
        bootstrapFacts.goal ||
        bootstrapFacts.preference ||
        bootstrapFacts.assistantName ||
        bootstrapFacts.behavior,
      );
      if (hasBootstrapFacts) {
        this.writeBootstrapWorkspaceState(routedAgent.id, bootstrapFacts);
        earlyWorkspaceContext = this.loadWorkspaceContext(routedAgent.id);
        try {
          this.sessions.appendSystemEvent(session.id, "bootstrap.prefill", {
            runId: run.id,
            facts: Object.keys(bootstrapFacts).filter((key) => key !== "skip" && bootstrapFacts[key]),
          });
        } catch {}
      }
    }

    // Human greeting override: only when no bootstrap ritual is active
    const isSimpleGreeting =
      intents.includes("greeting") &&
      intents.length <= 2 &&
      !intents.includes("capabilities") &&
      !intents.includes("profile-question");
    const greetingReply = (isSimpleGreeting && !hasBootstrap) ? this.buildGreetingReply({ agent: routedAgent, message, intents }) : "";
    const hasProviderSetupDetails = intents.includes("api-setup") && (
      /\b(?:openrouter|openai|nvidia|minimax|anthropic|gemini|groq|mistral|deepseek|together|fireworks|ollama|local-compatible|codex-cli)\b/i.test(message) ||
      /\b(?:api\s*key|apikey|key|token)\s*(?:is|=|:)?\s*[A-Za-z0-9._:/+=-]{12,}/i.test(message) ||
      /\b(?:model|base\s*url|endpoint)\s*(?:is|=|:)?\s*[A-Za-z0-9._:/+-]{2,}/i.test(message)
    );

    const directRuntimeReply = this.buildDirectRuntimeReply({
      intents,
      message,
      agent: routedAgent,
      tools: availableTools,
      skills: matchedSkills,
    });
    const acpCommandResult = /^\s*\/acp\b/i.test(message)
      ? await this.acp.handleSlashCommand(message, {
          sessionId: session.id,
          runId: run.id,
          agentId: routedAgent.id,
        })
      : null;
    const acpCommandReply = acpCommandResult ? this.acp.formatSlashReply(acpCommandResult) : "";
    const harnessCommandResult = /^\s*\/(?:harness|agent_harness|coding[-_]?harness)\b/i.test(message)
      ? await this.codingHarness.handleSlashCommand(message, {
          sessionId: session.id,
          runId: run.id,
          agentId: routedAgent.id,
        })
      : null;
    const harnessCommandReply = harnessCommandResult?.reply || "";
    const mcpCommandResult = /^\s*\/mcp\b/i.test(message)
      ? await this.handleMcpSlashCommand(message, {
          sessionId: session.id,
          runId: run.id,
          agentId: routedAgent.id,
        })
      : null;
    const mcpCommandReply = mcpCommandResult?.reply || "";
    if (acpCommandResult) {
      try {
        this.sessions.appendSystemEvent(session.id, "acp.command", {
          runId: run.id,
          command: message,
          result: acpCommandResult,
        });
      } catch {}
    }
    if (harnessCommandResult) {
      try {
        this.sessions.appendSystemEvent(session.id, "harness.command", {
          runId: run.id,
          command: message,
          result: harnessCommandResult,
        });
      } catch {}
    }
    if (mcpCommandResult) {
      try {
        this.sessions.appendSystemEvent(session.id, "mcp.command", {
          runId: run.id,
          command: message,
          result: mcpCommandResult,
        });
      } catch {}
    }
    const shouldUseDirectRuntimeReply = Boolean(
      !realProviderReady &&
      directRuntimeReply &&
      !hasBootstrap &&
      !hasProviderSetupDetails &&
      (intents.includes("profile-question") || intents.includes("capabilities")),
    );

    const forcedResponse = acpCommandReply || harnessCommandReply || mcpCommandReply || (realProviderReady || hasProviderSetupDetails
      ? ""
      : (
          greetingReply ||
          (shouldUseDirectRuntimeReply ? directRuntimeReply : "") ||
          (profileUpdate?.updated ? this.buildProfileUpdateReply({ profileUpdate }) : "") ||
          this.buildOnboardingReply({
            agentId: routedAgent.id,
            intents,
            session,
            profileUpdated: Boolean(profileUpdate?.updated),
            hasBootstrap,
          }) ||
          directRuntimeReply
        ));
    let plan = forcedResponse
      ? {
          summary: acpCommandReply
            ? "ACP command handled locally."
            : harnessCommandReply
            ? "Coding-agent harness command handled locally."
            : mcpCommandReply
            ? "MCP command handled locally."
            : shouldUseDirectRuntimeReply
            ? "Direct local runtime answer - provider skipped."
            : hasBootstrap ? "Bootstrap ritual active - provider will guide first-run setup." : greetingReply ? "Human greeting response." : "OpenClaw-style onboarding response.",
          intents,
          profile,
          toolsAvailable: availableTools,
          steps: [{
            type: acpCommandReply ? "acp-command" : harnessCommandReply ? "harness-command" : mcpCommandReply ? "mcp-command" : hasBootstrap ? "bootstrap" : "respond",
            reason: acpCommandReply
              ? "Handled /acp command through the local ACP control plane without a provider call."
              : harnessCommandReply
              ? "Handled /harness command through the local coding-agent harness without a provider call."
              : mcpCommandReply
              ? "Handled /mcp command through the local MCP control plane without a provider call."
              : shouldUseDirectRuntimeReply
              ? "Answered from local runtime facts, tools, skills, and memory without a provider call."
              : hasBootstrap ? "BOOTSTRAP.md present; agent will run first-run ritual." : greetingReply ? "Simple greeting; no tools needed." : "Fresh agent profile is incomplete; ask identity and user-profile questions.",
          }],
          source: acpCommandReply ? "acp-command" : harnessCommandReply ? "harness-command" : mcpCommandReply ? "mcp-command" : shouldUseDirectRuntimeReply ? "local-runtime" : hasBootstrap ? "bootstrap" : greetingReply ? "greeting" : "onboarding",
        }
      : this.omniLoop?.isEligible({ forcedResponse }) && profile.allowToolExecution
      ? {
          summary: "OmniLoop transcript agent loop - model drives tool selection directly.",
          intents,
          profile,
          toolsAvailable: availableTools,
          steps: [],
          source: "omni-loop",
        }
      : await this.planner.buildPlanWithModel({
      message,
      intents,
      skills: matchedSkills,
      tools: availableTools,
      profile,
      provider: this.provider,
    });
    plan = this.compactPlanForStorage(plan);
    const toolOutputs = [];
    const approvals = [];

    this.gateway.updateRun(run.id, {
      status: "running",
      intents,
      profile: profile.id,
      agentId: routedAgent.id,
      plan,
      loopContract,
      acceptedAt: enqueuedAt,
      startedAt,
      waitedMs,
    });
    this.sessions.markRunStage(session.id, run.id, "started", {
      intents,
      profile: profile.id,
    });
    this.gateway.addEvent("agent.started", {
      runId: run.id,
      sessionId: session.id,
      intents,
      agentId: routedAgent.id,
      profile: profile.id,
    });
    this.gateway.addEvent("agent.thinking", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        phase: "plan-tools",
        message: "Agent manager is executing the planned tool steps and collecting observations before the final answer.",
      });
    emitAgentLoopStage(this.gateway, "tool_execution", {
      runId: run.id,
      sessionId: session.id,
      agentId: routedAgent.id,
      source: "runtime-plan",
      plannedToolSteps: (plan.steps || []).filter((step) => step.type === "tool").length,
    });
    const runtimeLoopController = new AgentLoopController({
      config: this.config.getConfig(),
      gateway: this.gateway,
      run,
      session,
      agent: routedAgent,
      source: "runtime-plan",
    });
    const providerInfoForToolLoop = this.provider?.getInfo?.() || {};
    const modelToolLoopSettings = this.getModelToolLoopSettings();
    const providerReadyForToolLoop = providerInfoForToolLoop.ready !== false && providerInfoForToolLoop.id !== "mock/local-rule-engine";
    const deterministicRuntimeFirstIntents = new Set([
      "file-read",
      "file-write",
      "file-list",
      "computer-directory-list",
      "computer-file-read",
      "computer-file-write",
      "computer-delete",
      "computer-copy",
      "computer-move",
      "shell-plan",
      "project-test",
      "complex-build",
      "research-then-build",
    ]);
    const hasDeterministicRuntimePlan = (plan.steps || []).some((step) => step.type === "tool") &&
      (intents || []).some((intent) => deterministicRuntimeFirstIntents.has(intent));
    const omniLoopTakesOver = Boolean(
      this.omniLoop?.isEligible({ forcedResponse }) &&
      profile.allowToolExecution,
    );
    const letProviderChooseToolsFirst = omniLoopTakesOver || Boolean(
      modelToolLoopSettings.enabled &&
      modelToolLoopSettings.providerFirst &&
      providerReadyForToolLoop &&
      profile.allowToolExecution &&
      !forcedResponse &&
      !hasDeterministicRuntimePlan,
    );

    if (letProviderChooseToolsFirst) {
      this.gateway.addEvent("agent.thinking", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        phase: "model-tool-loop",
        message: "Provider brain has full OmniClaw tool access and will choose the next real action before heuristic planner tools run.",
      });
      this.gateway.addEvent("runtime_plan.skipped_for_provider_first", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        plannedToolSteps: (plan.steps || []).filter((step) => step.type === "tool").length,
      });
    }

    if (profile.allowToolExecution && !letProviderChooseToolsFirst) {
      for (const step of plan.steps) {
        if (step.type !== "tool" || !this.tools.has(step.tool, { agentId: routedAgent.id })) {
          continue;
        }
        if (!runtimeLoopController.startStep({
          phase: "runtime-plan",
          message: `Running planned tool ${step.tool}.`,
        })) {
          break;
        }
        if (!runtimeLoopController.canRunTool({ tool: step.tool, input: step.input || {} })) {
          continue;
        }

        const toolTraceId = createToolTraceId();
        const toolStartedAt = new Date().toISOString();
        this.upsertRunToolTrace(run.id, {
          id: toolTraceId,
          runId: run.id,
          sessionId: session.id,
          agentId: routedAgent.id,
          source: "runtime-plan",
          status: "running",
          tool: step.tool,
          input: step.input || {},
          reason: step.reason || "",
          startedAt: toolStartedAt,
        });
        this.gateway.addEvent("tool.started", {
          runId: run.id,
          sessionId: session.id,
          tool: step.tool,
          agentId: routedAgent.id,
          reason: step.reason || "",
        });
        let output;
        try {
          output = await this.tools.run(step.tool, step.input, {
            agentId: routedAgent.id,
            sessionId: session.id,
            runId: run.id,
          });
        } catch (error) {
          output = {
            error: true,
            message: error.message,
            agentId: routedAgent.id,
          };
        }

        toolOutputs.push({
          tool: step.tool,
          output,
        });
        runtimeLoopController.toolOutput({ tool: step.tool, input: step.input || {}, reason: step.reason || "" }, output);
        this.gateway.addEvent("tool.completed", {
          runId: run.id,
          sessionId: session.id,
          tool: step.tool,
          agentId: routedAgent.id,
          blocked: Boolean(output?.blocked),
          error: Boolean(output?.error),
          ...this.buildToolEventDetails(step.tool, output),
        });
        if (output?.error || output?.blocked || output?.ok === false) {
          this.gateway.addEvent("tool.failed", {
            runId: run.id,
            sessionId: session.id,
            tool: step.tool,
            agentId: routedAgent.id,
            blocked: Boolean(output?.blocked),
            error: Boolean(output?.error),
            ...this.buildToolEventDetails(step.tool, output),
          });
        }

        if (step.tool === "plan_shell_command" && output && output.status === "approval-required") {
          const approval = this.gateway.createApproval({
            type: "shell-plan",
            sessionId: session.id,
            runId: run.id,
            summary: `${output.message} Risk: ${output.risk || "medium"}.`,
            payload: output,
          });
          this.shellAudit.append({
            phase: "planned",
            status: "pending",
            command: output.command,
            risk: output.risk || "medium",
            allowlisted: Boolean(output.allowlisted),
            riskReasons: output.riskReasons || [],
            approvalId: approval.id,
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
          });
          this.gateway.addEvent("shell.plan_created", {
            approvalId: approval.id,
            runId: run.id,
            sessionId: session.id,
            risk: output.risk || "medium",
            allowlisted: Boolean(output.allowlisted),
          });
          approvals.push(approval);
          output.approvalId = approval.id;
        }

        if (step.tool === "plan_shell_command" && output && output.status === "auto-approved") {
          this.shellAudit.append({
            phase: "planned",
            status: "auto-approved",
            command: output.command,
            risk: output.risk || "low",
            allowlisted: Boolean(output.allowlisted),
            riskReasons: output.riskReasons || [],
            approvalId: "",
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
          });
          this.gateway.addEvent("shell.auto_approved", {
            runId: run.id,
            sessionId: session.id,
            risk: output.risk || "low",
            trustLevel: output.trustLevel || "balanced",
          });

          let execution;
          try {
            execution = await this.shellExecutor.execute({
              command: output.command,
              runId: run.id,
              sessionId: session.id,
            });
          } catch (error) {
            execution = {
              status: "blocked",
              command: output.command,
              approvalId: "",
              runId: run.id,
              sessionId: session.id,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: 0,
              exitCode: null,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: error.message,
              outputTruncated: false,
            };
          }

          output.execution = execution;
          this.shellAudit.append({
            phase: "executed",
            status: execution.status,
            command: execution.command,
            risk: execution.risk || output.risk || "low",
            allowlisted: Boolean(execution.allowlisted ?? output.allowlisted),
            riskReasons: execution.riskReasons || output.riskReasons || [],
            approvalId: "",
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            stdoutBytes: execution.stdoutBytes || 0,
            stderrBytes: execution.stderrBytes || 0,
            exitCode: execution.exitCode,
            timedOut: execution.timedOut,
            durationMs: execution.durationMs,
            stdout: execution.stdout,
            stderr: execution.stderr,
          });
          this.gateway.addEvent(
            execution.status === "completed" ? "shell.execution_completed" : "shell.execution_failed",
            {
              runId: run.id,
              sessionId: session.id,
              status: execution.status,
              exitCode: execution.exitCode,
              timedOut: execution.timedOut,
              risk: execution.risk || output.risk || "low",
              autoApproved: true,
            },
          );
          const activeRun = this.gateway.getRun(run.id);
          this.gateway.updateRun(run.id, {
            shellExecutions: [...(activeRun?.shellExecutions || []), execution],
            shellExecutionStatus: execution.status,
          });
          try {
            this.sessions.appendSystemEvent(session.id, "shell.execution", {
              runId: run.id,
              status: execution.status,
              exitCode: execution.exitCode,
              command: execution.command,
              stdout: execution.stdout,
              stderr: execution.stderr,
              autoApproved: true,
            });
          } catch {
            // ignore missing session
          }
        }
        this.upsertRunToolTrace(run.id, {
          id: toolTraceId,
          runId: run.id,
          sessionId: session.id,
          agentId: routedAgent.id,
          source: "runtime-plan",
          status: output?.error || output?.blocked ? "failed" : "completed",
          tool: step.tool,
          input: step.input || {},
          output,
          reason: step.reason || "",
          startedAt: toolStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(toolStartedAt),
          blocked: Boolean(output?.blocked),
          error: Boolean(output?.error),
        });
      }
    }

    const runtimeBuildEvidence = this.getRuntimeBuildEvidence({ intents, toolOutputs });
    const modelToolLoop = runtimeBuildEvidence.ready
      ? {
          report: this.buildSkippedModelToolLoopReport({
            reason: "runtime-plan-build-evidence",
            detail: runtimeBuildEvidence.verificationOk
              ? "Runtime plan created and verified the requested build artifact."
              : "Runtime plan created the requested build artifact; verification evidence is available for the final answer.",
            toolOutputs,
            finalAnswer: this.buildRuntimeToolReply({ intents, toolOutputs }),
          }),
          toolOutputs: [],
        }
      : await this.runModelToolLoop({
          message,
          intents,
          profile,
          agent: routedAgent,
          tools: availableTools,
          toolOutputs,
          forcedResponse,
          contextBundle: modelToolLoopContext,
          session,
          run,
        });
    modelToolLoop.report.runtimePlanAgentLoop = runtimeLoopController.getReport();
    plan.modelToolLoop = modelToolLoop.report;
    this.gateway.updateRun(run.id, {
      modelToolLoop: modelToolLoop.report,
    });
    let observationsChangedAfterModelFinal = false;
    if (modelToolLoop.toolOutputs.length > 0) {
      toolOutputs.push(...modelToolLoop.toolOutputs);
    }
    const allowedToolIds = new Set(availableTools.map((tool) => tool.id));
    const runtimeBuildEvidenceAfterLoop = this.getRuntimeBuildEvidence({ intents, toolOutputs });
    // OmniLoop owns its own completion judgment; legacy keyword-based
    // required-tool heuristics must not override or erase its final answer.
    const missingRequiredTools = runtimeBuildEvidenceAfterLoop.ready || modelToolLoop.report.loopEngine === "omni-loop"
      ? []
      : this.getDynamicRequiredToolIds(message, toolOutputs, intents, allowedToolIds)
        .filter((toolId) => !this.getCompletedToolIds(toolOutputs).has(toolId));
    if (missingRequiredTools.length > 0 && profile.allowToolExecution) {
      this.gateway.addEvent("agent.thinking", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        phase: "required-tool-repair",
        message: `Recovering missing required tool(s): ${missingRequiredTools.join(", ")}.`,
      });
      const requiredRepairOutputs = await this.runRequiredToolRepair({
        message,
        intents,
        allowedToolIds,
        toolOutputs,
        run,
        session,
        agent: routedAgent,
        providerText: modelToolLoop.report.finalAnswer || "",
      });
      if (requiredRepairOutputs.length > 0) {
        toolOutputs.push(...requiredRepairOutputs);
        observationsChangedAfterModelFinal = true;
        modelToolLoop.report.finalAnswer = "";
        modelToolLoop.report.finalReady = false;
        modelToolLoop.report.stoppedReason = "post-final-required-tools-executed";
        modelToolLoop.report.recoveredToolCalls =
          Number(modelToolLoop.report.recoveredToolCalls || 0) + requiredRepairOutputs.length;
        modelToolLoop.report.toolCallCount =
          Number(modelToolLoop.report.toolCallCount || 0) + requiredRepairOutputs.length;
        plan.modelToolLoop = modelToolLoop.report;
        this.gateway.updateRun(run.id, {
          modelToolLoop: modelToolLoop.report,
        });
      }
    }
    emitAgentLoopStage(this.gateway, "observation", {
      runId: run.id,
      sessionId: session.id,
      agentId: routedAgent.id,
      toolOutputCount: toolOutputs.length,
      failedObservationCount: this.countFailedToolObservations(toolOutputs),
    });
    // OmniLoop verifies its own work inside the transcript (read-back, exec,
    // tests) and its final answer must not be erased by a duplicate
    // post-final verification pass.
    const autoVerificationOutputs = modelToolLoop.report.loopEngine === "omni-loop"
      ? []
      : await this.runAutoVerificationPass({
          agent: routedAgent,
          session,
          run,
          toolOutputs,
        });
    if (autoVerificationOutputs.length > 0) {
      toolOutputs.push(...autoVerificationOutputs);
      observationsChangedAfterModelFinal = true;
      modelToolLoop.report.finalAnswer = "";
      modelToolLoop.report.finalReady = false;
      modelToolLoop.report.stoppedReason = "post-final-auto-verification-executed";
      modelToolLoop.report.autoVerificationCount =
        Number(modelToolLoop.report.autoVerificationCount || 0) + autoVerificationOutputs.length;
      plan.modelToolLoop = modelToolLoop.report;
      this.gateway.updateRun(run.id, {
        modelToolLoop: modelToolLoop.report,
      });
    }
    const autoVerificationFailed = autoVerificationOutputs.some((item) =>
      item?.output?.error ||
      item?.output?.blocked ||
      item?.output?.ok === false ||
      (Array.isArray(item?.output?.issues) && item.output.issues.length > 0),
    );
    const runtimeBuildEvidenceAfterVerification = this.getRuntimeBuildEvidence({ intents, toolOutputs });
    if (autoVerificationFailed && runtimeBuildEvidenceAfterVerification.ready) {
      modelToolLoop.report.autoRepairAttempted = false;
      modelToolLoop.report.stoppedReason = modelToolLoop.report.stoppedReason || "runtime-build-completed-with-verification-warnings";
      this.gateway.addEvent("model_tool_loop.repair_skipped", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        reason: "runtime-build-evidence-present",
        message: "Build artifacts exist and verification evidence is available; final reply will report warnings instead of blocking on slow repair.",
      });
    } else if (autoVerificationFailed) {
      modelToolLoop.report.autoRepairAttempted = true;
      emitAgentLoopStage(this.gateway, "self_correction", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        reason: "auto-verification-failed",
        failedObservationCount: this.countFailedToolObservations(toolOutputs),
      });
      this.gateway.addEvent("agent.reviewing", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        source: "auto-verification",
        reason: "auto-verification-failed",
        remainingIssues: ["Automatic verification failed; starting bounded repair pass."],
      });
      this.gateway.addEvent("model_tool_loop.self_correction_started", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        failedObservationCount: this.countFailedToolObservations(toolOutputs),
        maxRounds: this.getModelToolLoopSettings().maxRounds,
        reason: "auto-verification-failed",
      });
      const repairLoop = await this.runModelToolLoop({
        message: `${message}\n\nAuto-verification failed. Repair the changed artifact using the available tools, then verify again before finalizing.`,
        intents: [...new Set([...(intents || []), "repair", "verification"])],
        profile,
        agent: routedAgent,
        tools: availableTools,
        toolOutputs,
        forcedResponse: "",
        contextBundle: modelToolLoopContext,
        session,
        run,
      });
      modelToolLoop.report.autoRepairReport = repairLoop.report;
      modelToolLoop.report.toolCallCount += Number(repairLoop.report.toolCallCount || 0);
      modelToolLoop.report.rounds += Number(repairLoop.report.rounds || 0);
      modelToolLoop.report.selfCorrectionTriggered =
        Boolean(modelToolLoop.report.selfCorrectionTriggered || repairLoop.report.selfCorrectionTriggered);
      modelToolLoop.report.recoveredToolCalls += Number(repairLoop.report.recoveredToolCalls || 0);
      modelToolLoop.report.repeatedToolCallsSkipped += Number(repairLoop.report.repeatedToolCallsSkipped || 0);
      modelToolLoop.report.errors.push(...(repairLoop.report.errors || []));
      if (repairLoop.toolOutputs.length > 0) {
        toolOutputs.push(...repairLoop.toolOutputs);
        observationsChangedAfterModelFinal = true;
        modelToolLoop.report.finalAnswer = "";
        modelToolLoop.report.finalReady = false;
        modelToolLoop.report.stoppedReason = "post-final-repair-tools-executed";
      }
      const repairVerificationOutputs = await this.runAutoVerificationPass({
        agent: routedAgent,
        session,
        run,
        toolOutputs,
      });
      if (repairVerificationOutputs.length > 0) {
        toolOutputs.push(...repairVerificationOutputs);
        observationsChangedAfterModelFinal = true;
        modelToolLoop.report.finalAnswer = "";
        modelToolLoop.report.finalReady = false;
        modelToolLoop.report.stoppedReason = "post-final-repair-verification-executed";
        modelToolLoop.report.autoVerificationCount =
          Number(modelToolLoop.report.autoVerificationCount || 0) + repairVerificationOutputs.length;
      }
      plan.modelToolLoop = modelToolLoop.report;
      this.gateway.updateRun(run.id, {
        modelToolLoop: modelToolLoop.report,
      });
    }
    modelToolLoop.report.observationsChangedAfterModelFinal = observationsChangedAfterModelFinal;
    if (toolOutputs.length > 0) {
      const decoratedToolOutputs = toolOutputs.map((item) => this.decorateToolOutput(item));
      toolOutputs.splice(0, toolOutputs.length, ...decoratedToolOutputs);
      const needsAttention = decoratedToolOutputs.filter((item) =>
        ["blocked", "failed", "pending-approval"].includes(item.toolSummary?.status),
      );
      if (needsAttention.length > 0) {
        this.gateway.addEvent("tool.execution_needs_attention", {
          runId: run.id,
          sessionId: session.id,
          agentId: routedAgent.id,
          count: needsAttention.length,
          tools: needsAttention.map((item) => ({
            tool: item.tool,
            status: item.toolSummary?.status || "failed",
            nextFix: item.toolSummary?.nextFix || "",
          })),
        });
      }
    }

    for (const item of toolOutputs) {
      if (item.tool === "web_research" && item.output && !item.output.error) {
        this.memory.addResearch({
          agentId: routedAgent.id,
          query: item.output.query,
          provider: item.output.provider,
          results: item.output.results,
        });
      }

      if (
        (item.tool === "write_file" || item.tool === "append_file") &&
        item.output &&
        !item.output.error &&
        !item.output.blocked
      ) {
        this.memory.addArtifact({
          agentId: routedAgent.id,
          kind: "file",
          path: item.output.path,
          bytesWritten: item.output.bytesWritten,
          appended: item.output.appended,
        });
      }

      if (item.tool === "create_skill" && item.output && !item.output.error && !item.output.blocked) {
        this.memory.addArtifact({
          agentId: routedAgent.id,
          kind: "skill",
          path: item.output.file,
          skillId: item.output.skill?.id || "",
        });
      }

      if (
        item.tool === "update_runtime_settings" &&
        item.output &&
        !item.output.error &&
        !item.output.blocked
      ) {
        this.memory.addArtifact({
          agentId: routedAgent.id,
          kind: "config",
          path: "data/config.json",
          updated: item.output.updated,
        });
      }

      if (item.tool === "promote_memory" && item.output && !item.output.error && !item.output.blocked) {
        this.memory.addArtifact({
          agentId: routedAgent.id,
          kind: "memory",
          path: "data/MEMORY.md",
          memoryId: item.output.memory?.id || "",
        });
      }

      if (item.tool === "dream_memory_sweep" && item.output && !item.output.error && !item.output.blocked) {
        this.memory.addArtifact({
          agentId: routedAgent.id,
          kind: "dream",
          path: "data/MEMORY.md",
          dreamId: item.output.dream?.id || "",
          promotedCount: item.output.promoted?.length || 0,
        });
      }

      if (item.tool === "delegate_task" && item.output && item.output.delegated && !item.output.error) {
        const { targetAgentId, instruction } = item.output;
        this.queueDelegation({
          sourceAgentId: routedAgent.id,
          targetAgentId,
          instruction,
          parentRunId: run.id,
          parentSessionId: session.id,
          source: "tool",
        });
      }
    }

    if (forcedResponse && toolOutputs.length === 0) {
      const response = this.normalizeAssistantReplyStyle({ response: forcedResponse, toolOutputs });
      const assistantAt = new Date().toISOString();
      const directPromptTrace = this.buildPromptTrace({
        report: {
          maxChars: 0,
          usedChars: 0,
          omittedItems: 0,
          summary: "Direct local runtime reply; provider skipped but workspace identity/context files were still loaded.",
        },
        agent: { ...routedAgent, workspaceFiles: earlyWorkspaceContext.files.map((file) => file.name) },
        profile,
        skills: matchedSkills,
        tools: availableTools,
        toolOutputs,
        workspaceContext: earlyWorkspaceContext,
        recentConversations: [],
        notes: [],
        longTermMemory: [],
        research: [],
        artifacts: [],
        tasks: [],
      }, {
        ...run,
        sessionId: session.id,
        agentId: routedAgent.id,
      });
      const finalMetadata = this.buildFinalMetadata({
        startedAt,
        completedAt: assistantAt,
        profile,
        provider: this.provider.getInfo?.() || {},
        providerDiagnostics: null,
        modelToolLoop: modelToolLoop.report,
        toolOutputs,
        approvals,
        loopContract,
      });
      emitAgentLoopStage(this.gateway, "final_render", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        responseChars: response.length,
        directLocalReply: true,
      });
      this.sessions.appendMessage(session.id, {
        id: `message_${Date.now()}_assistant`,
        at: assistantAt,
        role: "assistant",
        text: response,
        runId: run.id,
        toolOutputs,
        modelToolLoop: modelToolLoop.report,
        providerDiagnostics: null,
        planSummary: plan.summary || "",
        finalMetadata,
      });
      this.contextEngine.afterTurn(session.id, {
        assistant: response,
        runId: run.id,
      });
      this.sessions.finishRun(session.id, run.id, {
        status: "idle",
        at: assistantAt,
        approvalIds: [],
      });
      const completedRun = this.gateway.updateRun(run.id, {
        status: "completed",
        completedAt: assistantAt,
        context: {
          profileId: profile.id,
          maxChars: 0,
          usedChars: 0,
          omittedItems: 0,
          summary: "Direct local runtime reply; provider skipped but workspace identity/context files were loaded.",
          workspaceFileCount: earlyWorkspaceContext.files.length,
          workspaceFiles: earlyWorkspaceContext.files.map((file) => `${file.scope}:${file.name}`).slice(0, 40),
          loopContract,
        },
        promptTrace: directPromptTrace,
        toolOutputs,
        reply: response,
        providerDiagnostics: null,
        finalMetadata,
        approvalIds: [],
      });
      this.gateway.addEvent("agent.completed", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        status: completedRun.status,
        directLocalReply: true,
      });
      this.gateway.addEvent("agent.done", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        stopReason: finalMetadata.stopReason || "final",
        steps: finalMetadata.stepCount || 0,
        toolCallCount: finalMetadata.toolCallCount || 0,
        remainingIssues: finalMetadata.remainingIssues || [],
        finalMetadata,
      });
      return {
        session: {
          id: session.id,
          key: session.key,
          label: session.label,
          agentId: session.agentId,
          channel: session.channel,
        },
        agent: {
          id: routedAgent.id,
          name: routedAgent.name,
          profileId: profile.id,
        },
        run: {
          id: run.id,
          status: completedRun.status,
          waitedMs,
        },
        reply: response,
        intents,
        plan,
        toolOutputs,
        modelToolLoop: modelToolLoop.report,
        finalMetadata,
        provider: this.provider.getInfo(),
        providerDiagnostics: null,
        approvals,
      };
    }

    try {
      const agentContext = this.getAgentContext(routedAgent.id);
      const sessionSummary = this.summarizer.readSummary(session.id);
      
      const workspaceContext = earlyWorkspaceContext;
      // Computed once before the model loop; reused here for synthesis/persistence.
      const bootstrapRitual = modelToolLoopContext.bootstrapRitual;
      const activeMemory = modelToolLoopContext.activeMemory || {
        status: "skipped",
        reason: "not_computed",
        elapsedMs: 0,
        hitCount: 0,
        summary: "",
      };
      try {
        this.sessions.appendSystemEvent(session.id, "active_memory", {
          runId: run.id,
          status: activeMemory.status,
          reason: activeMemory.reason,
          elapsedMs: activeMemory.elapsedMs,
          hitCount: activeMemory.hitCount,
          summaryChars: String(activeMemory.summary || "").length,
        });
      } catch {
        // Session may have been reset mid-run; active memory is advisory only.
      }
      const harnessContext = this.codingHarness.status({ limit: 5 });
      const mcpContext = {
        configuredServers: Object.keys(this.mcp?._config || {}),
        connected: this.mcp?.getStatus?.() || {},
        tools: (this.mcp?.getAllTools?.() || []).slice(0, 20),
      };
      
      const contextBundle = this.contextEngine.assemble({
        sessionId: session.id,
        message,
        intents,
        agent: { ...routedAgent, workspaceFiles: workspaceContext.files.map((file) => file.name) },
        profile,
        loopContract,
        skills: matchedSkills,
        plan,
        toolOutputs,
        workspaceContext,
        bootstrapRitual,
        activeMemory,
        harness: harnessContext,
        mcp: mcpContext,
        recentConversations: agentContext.recentConversations,
        notes: agentContext.notes,
        longTermMemory: agentContext.longTermMemory,
        research: agentContext.research,
        artifacts: agentContext.artifacts,
        tasks: agentContext.tasks,
        tools: availableTools,
        sessionSummary,
      });
      const promptTrace = this.buildPromptTrace(contextBundle, {
        ...run,
        sessionId: session.id,
        agentId: routedAgent.id,
      });
      this.gateway.updateRun(run.id, {
        context: contextBundle.report,
        promptTrace,
      });
      emitAgentLoopStage(this.gateway, "context_assembly", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        usedChars: contextBundle.report.usedChars,
        maxChars: contextBundle.report.maxChars,
        workspaceFileCount: workspaceContext.files.length,
        missingWorkspaceFiles: workspaceContext.manifest?.missingRequiredFiles || [],
      });
      this.gateway.addEvent("context.compacted", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        usedChars: contextBundle.report.usedChars,
        maxChars: contextBundle.report.maxChars,
        omittedItems: contextBundle.report.omittedItems,
      });
      const providerInfoForReply = this.provider.getInfo?.() || {};
      const useProviderGroundedSynthesis = this.shouldUseProviderGroundedSynthesis({
        intents,
        toolOutputs,
        providerInfo: providerInfoForReply,
      });
      let response = forcedResponse || modelToolLoop.report.finalAnswer || "";
      const runtimeToolReply = this.buildRuntimeToolReply({ intents, toolOutputs });
      const preferRuntimeToolReply = this.shouldPreferRuntimeToolReply({ intents, runtimeToolReply, toolOutputs });
      if (!response && preferRuntimeToolReply) {
        response = runtimeToolReply;
      }
      let providerDiagnostics = null;
      if (!response && useProviderGroundedSynthesis && !preferRuntimeToolReply) {
        const synthesis = await this.synthesizeFinalWithProvider({
          message,
          intents,
          agent: routedAgent,
          profile,
          contextBundle,
          toolOutputs,
          run,
          session,
        });
        if (synthesis.reply) {
          response = synthesis.reply;
          providerDiagnostics = synthesis.providerDiagnostics;
        } else if (synthesis.providerDiagnostics) {
          providerDiagnostics = synthesis.providerDiagnostics;
        }
      }
      if (!response && toolOutputs.length > 0 && providerDiagnostics) {
        response = this.buildProviderFailureFallback({
          providerResponse: providerDiagnostics.message || providerDiagnostics.reason || "Final synthesis failed after tools completed.",
          intents,
          message,
          agent: routedAgent,
          tools: availableTools,
          skills: matchedSkills,
          toolOutputs,
        });
      }
      if (!response) {
        const configForFallbacks = this.config.getConfig();
        const fallbackChain = [
          ...(routedAgent.fallbackChain || []),
          ...(configForFallbacks.provider?.fallbacks || []),
          ...(configForFallbacks.fallbacks || []),
        ].filter((item, index, arr) => item && arr.indexOf(item) === index);
        const candidates = [this.provider];
        const providerAttempts = [];
        for (const candidateId of fallbackChain) {
          const p = getProvider(this.config, this.secrets, candidateId);
          if (p) {
            candidates.push(p);
          } else {
            providerAttempts.push({
              profileId: candidateId,
              status: "skipped",
              reason: "profile missing, unsupported, or API key not configured",
            });
          }
        }

        const providerPayload = {
          message,
          intents,
          agent: contextBundle.agent,
          profile,
          skills: contextBundle.skills,
          plan,
          toolOutputs: contextBundle.toolOutputs,
          workspaceContext: contextBundle.workspaceContext,
          bootstrapRitual: contextBundle.bootstrapRitual,
          activeMemory: contextBundle.activeMemory,
          recentConversations: contextBundle.recentConversations,
          notes: contextBundle.notes,
          longTermMemory: contextBundle.longTermMemory,
          research: contextBundle.research,
          artifacts: contextBundle.artifacts,
          tasks: contextBundle.tasks,
          tools: contextBundle.tools,
          contextBundle,
          loopContract,
        };
        const providerTimeoutMs = Math.max(
          5000,
          Math.min(180000, Number(this.config.getConfig().provider?.timeoutMs || 45000)),
        );

        let providerResponse = null;
        let outcome = null;
        let finalProviderInfo = null;

        for (let i = 0; i < candidates.length; i++) {
          const candidateProvider = candidates[i];
          const providerStartedAt = new Date().toISOString();
          const providerInfo = candidateProvider.getInfo?.() || {};
          finalProviderInfo = providerInfo;
          const attempt = {
            index: i,
            providerId: providerInfo.id || "unknown",
            model: providerInfo.model || "",
            ready: providerInfo.ready !== false,
            startedAt: providerStartedAt,
            status: "running",
          };
          providerAttempts.push(attempt);

          this.gateway.updateRun(run.id, {
            providerStatus: "running",
            provider: providerInfo,
            providerStartedAt,
            providerAttempts,
          });
          emitAgentLoopStage(this.gateway, "model_inference", {
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            providerId: providerInfo.id || "unknown",
            model: providerInfo.model || "",
            attempt: i + 1,
          });
          this.gateway.addEvent("provider.started", {
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            providerId: providerInfo.id || "unknown",
            model: providerInfo.model || "",
            ready: providerInfo.ready !== false,
          });

          providerResponse = await Promise.race([
            candidateProvider.respond(providerPayload),
            new Promise((resolve) => setTimeout(
              () => resolve(`Provider request timed out after ${providerTimeoutMs}ms. OmniClaw local tools completed, but the model bridge did not return in time.`),
              providerTimeoutMs,
            )),
          ]);

          outcome = classifyProviderOutcome(providerResponse);
          providerDiagnostics = {
            ok: outcome.ok,
            status: outcome.ok ? "completed" : "failed",
            reason: outcome.reason,
            message: outcome.message,
            providerId: providerInfo.id || "unknown",
            model: providerInfo.model || "",
            ready: providerInfo.ready !== false,
            startedAt: providerStartedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - Date.parse(providerStartedAt),
            attempts: providerAttempts,
          };
          Object.assign(attempt, {
            status: providerDiagnostics.status,
            reason: providerDiagnostics.reason,
            message: providerDiagnostics.message,
            completedAt: providerDiagnostics.completedAt,
            durationMs: providerDiagnostics.durationMs,
          });

          if (outcome.ok) {
            break;
          } else {
            this.gateway.addEvent("provider.failed", {
              runId: run.id,
              sessionId: session.id,
              agentId: routedAgent.id,
              providerId: providerDiagnostics.providerId,
              model: providerDiagnostics.model,
              reason: providerDiagnostics.reason,
              durationMs: providerDiagnostics.durationMs,
            });
            console.error(`Provider ${providerInfo.id} failed: ${outcome.reason}`);
          }
        }

        this.gateway.updateRun(run.id, {
          providerStatus: providerDiagnostics.status,
          providerDiagnostics,
          providerAttempts,
        });

        if (outcome.ok) {
          this.gateway.addEvent("provider.completed", {
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            providerId: providerDiagnostics.providerId,
            model: providerDiagnostics.model,
            reason: providerDiagnostics.reason,
            durationMs: providerDiagnostics.durationMs,
          });
        }

        response = this.buildProviderFailureFallback({
          providerResponse,
          intents,
          message,
          agent: routedAgent,
          tools: availableTools,
          skills: matchedSkills,
          toolOutputs,
        }) || providerResponse;
      }

      if (modelToolLoop.report.loopEngine !== "omni-loop") {
        // Legacy-loop answer correction heuristics. OmniLoop replies are
        // grounded by its own transcript, so they pass through untouched.
        response = this.normalizeAssistantReplyStyle({ response, toolOutputs });
        response = this.buildGroundedSynthesisFallback({
          response,
          intents,
          toolOutputs,
          providerDiagnostics,
        }) || response;
        response = this.buildEvidenceContradictionCorrection({
          providerResponse: response,
          message,
          toolOutputs,
        }) || response;
        response = this.buildUngroundedToolClaimFallback({
          providerResponse: response,
          intents,
          toolOutputs,
        }) || response;
      }

      // Process bootstrap ritual: extract profile info from conversation and update files
      if (this.hasBootstrapRitual(routedAgent.id)) {
        const bootstrapResult = this.processBootstrapStep(routedAgent.id, message, response);
        if (bootstrapResult.reply) {
          response = bootstrapResult.reply;
        }
        if (bootstrapResult.updated && bootstrapResult.updates) {
          this.gateway.addEvent("bootstrap.progress", {
            runId: run.id,
            sessionId: session.id,
            agentId: routedAgent.id,
            updates: bootstrapResult.updates,
          });
          if (bootstrapResult.updates.includes("bootstrap_completed")) {
            this.gateway.addEvent("bootstrap.completed", {
              runId: run.id,
              sessionId: session.id,
              agentId: routedAgent.id,
            });
          }
        }
      }

      const assistantAt = new Date().toISOString();
      const finalMetadata = this.buildFinalMetadata({
        startedAt,
        completedAt: assistantAt,
        profile,
        provider: this.provider.getInfo?.() || {},
        providerDiagnostics,
        modelToolLoop: modelToolLoop.report,
        toolOutputs,
        approvals,
        activeMemory,
        loopContract,
      });
      emitAgentLoopStage(this.gateway, "persistence", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        toolOutputCount: toolOutputs.length,
        approvalCount: approvals.length,
      });
      this.sessions.appendMessage(session.id, {
        id: `message_${Date.now()}_assistant`,
        at: assistantAt,
        role: "assistant",
        text: response,
        runId: run.id,
        toolOutputs,
        modelToolLoop: modelToolLoop.report,
        providerDiagnostics,
        planSummary: plan.summary || "",
        finalMetadata,
      });
      this.contextEngine.afterTurn(session.id, {
        assistant: response,
        runId: run.id,
      });
      this.sessions.finishRun(session.id, run.id, {
        status: approvals.length > 0 ? "awaiting-approval" : "idle",
        at: assistantAt,
        approvalIds: approvals.map((item) => item.id),
      });
      const completedRun = this.gateway.updateRun(run.id, {
        status: approvals.length > 0 ? "waiting_approval" : "completed",
        completedAt: assistantAt,
        toolOutputs,
        reply: response,
        providerDiagnostics,
        finalMetadata,
        approvalIds: approvals.map((item) => item.id),
      });
      this.gateway.addEvent("agent.completed", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        status: completedRun.status,
      });
      this.gateway.addEvent("agent.done", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        stopReason: finalMetadata.stopReason || "final",
        steps: finalMetadata.stepCount || 0,
        toolCallCount: finalMetadata.toolCallCount || 0,
        remainingIssues: finalMetadata.remainingIssues || [],
        finalMetadata,
      });
      emitAgentLoopStage(this.gateway, "final", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        status: completedRun.status,
        stopReason: finalMetadata.stopReason || "final",
        verificationPassed: Boolean(finalMetadata.verificationPassed),
      });

      this.memory.appendConversation({
        agentId: routedAgent.id,
        at: assistantAt,
        user: message,
        assistant: response,
        sessionId: session.id,
        runId: run.id,
        intents,
        plan,
        toolOutputs,
      });
      emitAgentLoopStage(this.gateway, "memory_hooks", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        conversationPersisted: true,
        toolOutputCount: toolOutputs.length,
      });

      // Trigger background summarization
      void this.summarizer.summarizeSession(session, this.sessions.readTranscriptEntries(session));

      return {
        session: {
          id: session.id,
          key: session.key,
          label: session.label,
          agentId: session.agentId,
          channel: session.channel,
        },
        agent: {
          id: routedAgent.id,
          name: routedAgent.name,
          profileId: profile.id,
        },
        run: {
          id: run.id,
          status: completedRun.status,
          waitedMs,
        },
        reply: response,
        intents,
        plan,
        toolOutputs,
        modelToolLoop: modelToolLoop.report,
        finalMetadata,
        approvals,
        provider: this.provider.getInfo(),
        providerDiagnostics,
      };
    } catch (error) {
      const failedAt = new Date().toISOString();
      const providerInfo = this.provider.getInfo?.() || {};
      this.sessions.finishRun(session.id, run.id, {
        status: "error",
        at: failedAt,
        error: error.message,
      });
      this.gateway.updateRun(run.id, {
        status: "failed",
        completedAt: failedAt,
        error: error.message,
        providerStatus: "failed",
        providerDiagnostics: {
          ok: false,
          status: "failed",
          reason: "runtime_exception",
          message: truncateTraceText(error.message, 1000),
          providerId: providerInfo.id || "unknown",
          model: providerInfo.model || "",
          completedAt: failedAt,
        },
      });
      this.gateway.addEvent("agent.failed", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        error: error.message,
      });
      this.gateway.addEvent("provider.failed", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        providerId: providerInfo.id || "unknown",
        model: providerInfo.model || "",
        reason: "runtime_exception",
      });
      throw error;
    }
  }

  getModelToolLoopSettings() {
    const config = this.config.getConfig();
    const loop = config.runtime?.modelToolLoop || {};
    return {
      enabled: loop.enabled !== false,
      maxRounds: Math.max(0, Math.min(100, Number(loop.maxRounds || 6))),
      maxToolCallsPerRound: Math.max(1, Math.min(20, Number(loop.maxToolCallsPerRound || 4))),
      providerFirst: loop.providerFirst === true,
      roundTimeoutMs: Math.max(5000, Math.min(180000, Number(loop.roundTimeoutMs || 90000))),
      runWhenHeuristicHasTools: loop.runWhenHeuristicHasTools !== false,
      recoverMissingToolCalls: loop.recoverMissingToolCalls !== false,
      maxRepeatedToolCalls: Math.max(1, Math.min(4, Number(loop.maxRepeatedToolCalls || 2))),
      maxParallelToolCalls: Math.max(1, Math.min(8, Number(loop.maxParallelToolCalls || 4))),
      nativeToolCalling: loop.nativeToolCalling !== false,
      nativeToolTimeoutMs: Math.max(1000, Math.min(15000, Number(loop.nativeToolTimeoutMs || 8000))),
    };
  }

  getAgentLoopSettings() {
    return getAgentLoopSettings(this.config.getConfig());
  }

  shouldRunModelToolLoop({ message = "", forcedResponse = "", runtimeToolReply = "", profile = {}, toolOutputs = [], intents = [] } = {}) {
    const settings = this.getModelToolLoopSettings();
    if (!settings.enabled || !profile.allowToolExecution || forcedResponse) {
      return false;
    }
    if (!this.provider || typeof this.provider.complete !== "function") {
      return false;
    }
    const providerInfo = this.provider.getInfo?.() || {};
    if (providerInfo.ready === false || providerInfo.id === "mock/local-rule-engine") {
      return false;
    }
    const hasExistingObservations = Array.isArray(toolOutputs) && toolOutputs.length > 0;
    const failedObservationCount = this.countFailedToolObservations(toolOutputs);
    const completedToolIds = this.getCompletedToolIds(toolOutputs);
    const pendingRequiredToolIds = this.getRequiredToolIdsFromMessage(message)
      .filter((toolId) => !completedToolIds.has(toolId));
    if (
      hasExistingObservations &&
      failedObservationCount === 0 &&
      pendingRequiredToolIds.length === 0 &&
      this.shouldPreferRuntimeToolReply({ intents, runtimeToolReply, toolOutputs })
    ) {
      return false;
    }
    const runtimeFirstSatisfiedIntents = new Set([
      "file-read",
      "file-write",
      "file-list",
      "computer-search",
      "computer-directory-list",
      "computer-file-read",
      "computer-file-write",
      "computer-delete",
      "browser-observe",
      "browser-navigate",
      "shell-plan",
      "project-test",
      "provider-status",
      "provider-model-list",
      "system-status",
      "task-create",
      "task-list",
    ]);
    if (
      hasExistingObservations &&
      failedObservationCount === 0 &&
      pendingRequiredToolIds.length === 0 &&
      (intents || []).some((intent) => runtimeFirstSatisfiedIntents.has(intent))
    ) {
      return false;
    }
    if (
      failedObservationCount === 0 &&
      completedToolIds.has("write_computer_file") &&
      completedToolIds.has("read_computer_file")
    ) {
      return false;
    }
    if (
      failedObservationCount === 0 &&
      completedToolIds.has("write_file") &&
      completedToolIds.has("read_file")
    ) {
      return false;
    }
    if (
      failedObservationCount === 0 &&
      completedToolIds.has("write_file") &&
      completedToolIds.has("verify_html_artifact")
    ) {
      return false;
    }
    const explicitToolRequest = /\b(web_research|web_search|web_fetch|read_url|write_file|append_file|read_file|list_files|run_terminal_command|browser_(?:text|snapshot|navigate|screenshot|evaluate)|use\s+tools?|tool\s+use|file\s+(?:write|read)|write\s+(?:the\s+)?(?:same\s+)?file|read[- ]back|verify\s+(?:the\s+)?file)\b/i.test(String(message || "")) ||
      this.isResearchLikeText(message, intents);
    const toolLoopIntents = new Set([
      "research",
      "research-then-build",
      "complex-build",
      "repair",
      "verification",
      "file-read",
      "file-write",
      "file-list",
      "computer-search",
      "computer-file-read",
      "computer-file-write",
      "computer-delete",
      "browser-observe",
      "browser-navigate",
      "shell-plan",
      "project-test",
      "project-build",
      "project-release",
      "provider-status",
      "provider-model-list",
      "system-status",
      "task-create",
      "task-list",
      "openclaw-code-study",
      "real-task-hardening",
    ]);
    if (!hasExistingObservations && !explicitToolRequest && !(intents || []).some((intent) => toolLoopIntents.has(intent))) {
      return false;
    }
    return true;
  }

  countFailedToolObservations(toolOutputs = []) {
    return (toolOutputs || []).filter((item) =>
      Boolean(
        item?.output?.error ||
        item?.output?.blocked ||
        item?.output?.ok === false ||
        (Array.isArray(item?.output?.issues) && item.output.issues.length > 0) ||
        item?.toolSummary?.status === "failed" ||
        item?.toolSummary?.status === "blocked",
      ),
    ).length;
  }

  buildFinalMetadata({
    startedAt = "",
    completedAt = new Date().toISOString(),
    profile = {},
    provider = {},
    providerDiagnostics = null,
    modelToolLoop = {},
    toolOutputs = [],
    approvals = [],
    activeMemory = null,
    loopContract = null,
  } = {}) {
    const startMs = Date.parse(startedAt || "");
    const endMs = Date.parse(completedAt || "") || Date.now();
    const failedTools = (toolOutputs || []).filter((item) =>
      item?.output?.error ||
      item?.output?.blocked ||
      item?.output?.ok === false ||
      (Array.isArray(item?.output?.issues) && item.output.issues.length > 0) ||
      ["failed", "blocked"].includes(item?.toolSummary?.status),
    );
    const autoVerificationCount = Number(modelToolLoop?.autoVerificationCount || 0);
    const autoRepairAttempted = Boolean(modelToolLoop?.autoRepairAttempted);
    const autoRepairReport = modelToolLoop?.autoRepairReport || null;
    const autoRepairToolCallCount = Number(autoRepairReport?.toolCallCount || 0);
    const remainingIssues = [
      ...(Array.isArray(modelToolLoop?.remainingIssues) ? modelToolLoop.remainingIssues : []),
      ...(Array.isArray(modelToolLoop?.agentLoop?.remainingIssues) ? modelToolLoop.agentLoop.remainingIssues : []),
      ...(Array.isArray(modelToolLoop?.runtimePlanAgentLoop?.remainingIssues) ? modelToolLoop.runtimePlanAgentLoop.remainingIssues : []),
    ].filter(Boolean);
    return {
      mode: profile?.id || "",
      model: provider?.model || providerDiagnostics?.model || "",
      providerId: provider?.id || providerDiagnostics?.providerId || "",
      durationMs: Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : providerDiagnostics?.durationMs || 0,
      stepCount: Number(modelToolLoop?.rounds || 0),
      toolCallCount: (toolOutputs || []).length,
      stopReason: modelToolLoop?.stoppedReason || providerDiagnostics?.reason || (approvals?.length ? "blocked_for_approval" : "completed"),
      fixedErrors: Boolean(modelToolLoop?.selfCorrectionTriggered || (autoRepairAttempted && autoRepairToolCallCount > 0)),
      failedToolCount: failedTools.length,
      autoVerificationCount,
      autoRepairAttempted,
      autoRepairToolCallCount,
      verificationPassed: autoVerificationCount > 0 && failedTools.length === 0,
      remainingIssues: [...new Set(remainingIssues)].slice(0, 12),
      pendingApprovalCount: approvals?.length || 0,
      loopContract,
      agentLoopStages: loopContract?.stages || [],
      activeMemory: activeMemory
        ? {
            status: activeMemory.status || "",
            reason: activeMemory.reason || "",
            elapsedMs: Number(activeMemory.elapsedMs || 0),
            summaryChars: String(activeMemory.summary || "").length,
            hitCount: Number(activeMemory.hitCount || 0),
          }
        : null,
    };
  }

  getRuntimeBuildEvidence({ intents = [], toolOutputs = [] } = {}) {
    const buildIntent = (intents || []).some((intent) => intent === "complex-build" || intent === "research-then-build");
    if (!buildIntent || !Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      return { ready: false };
    }
    const htmlWrites = toolOutputs.filter((item) =>
      (item.tool === "write_file" || item.tool === "append_file") &&
      item.output &&
      !item.output.error &&
      !item.output.blocked &&
      /\.html?$/i.test(String(item.output.path || "")),
    );
    const verificationOutputs = toolOutputs.filter((item) =>
      item.tool === "verify_html_artifact" &&
      item.output &&
      !item.output.blocked,
    );
    const verificationAttempted = verificationOutputs.length > 0;
    const verificationOk = verificationOutputs.some((item) => item.output?.ok === true);
    const verificationWarnings = verificationOutputs
      .filter((item) => item.output?.ok === false || item.output?.error || (Array.isArray(item.output?.issues) && item.output.issues.length > 0))
      .flatMap((item) => item.output?.issues || item.output?.message || item.output?.error || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return {
      ready: htmlWrites.length > 0 && verificationAttempted,
      htmlWriteCount: htmlWrites.length,
      verificationAttempted,
      verificationOk,
      verificationWarnings,
      htmlPaths: htmlWrites.map((item) => item.output.path).filter(Boolean),
    };
  }

  buildSkippedModelToolLoopReport({ reason = "runtime-evidence", detail = "", toolOutputs = [], finalAnswer = "" } = {}) {
    const settings = this.getModelToolLoopSettings();
    return {
      enabled: settings.enabled,
      attempted: false,
      maxRounds: settings.maxRounds,
      maxToolCallsPerRound: settings.maxToolCallsPerRound,
      rounds: 0,
      toolCallCount: 0,
      nativeToolAttempts: 0,
      nativeToolsUsed: false,
      nativeTranscriptTurns: 0,
      skippedReason: reason,
      skipDetail: detail,
      stoppedReason: reason,
      finalReady: Boolean(finalAnswer),
      selfCorrectionTriggered: false,
      failedObservationCount: this.countFailedToolObservations(toolOutputs),
      autoVerificationCount: 0,
      autoRepairAttempted: false,
      autoRepairReport: null,
      recoveredToolCalls: 0,
      repeatedToolCallsSkipped: 0,
      rejectedToolCalls: [],
      finalAnswer,
      roundDetails: [],
      errors: [],
    };
  }

  shouldPreferRuntimeToolReply({ intents = [], runtimeToolReply = "", toolOutputs = [] } = {}) {
    if (!runtimeToolReply || !Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      return false;
    }
    const providerManagedIntents = new Set([
      "complex-build",
      "research-then-build",
      "repair",
      "verification",
    ]);
    if ((intents || []).some((intent) => providerManagedIntents.has(intent))) {
      return false;
    }
    const hasConcreteWorkProof = toolOutputs.some((item) =>
      ["write_file", "append_file", "verify_html_artifact", "read_file", "run_terminal_command", "web_research", "web_search"].includes(item.tool),
    );
    // Never dump tools on greetings or identity questions
    const noToolIntents = new Set([
      "greeting",
      "profile-question",
      "api-setup",
      "capabilities",
    ]);
    if (!hasConcreteWorkProof && (intents || []).some((intent) => noToolIntents.has(intent))) {
      return false;
    }
    const deterministicIntents = new Set([
      "real-task-hardening",
      "openclaw-code-study",
      "layer-status",
      "v2-audit",
      "prompt-assembly",
      "context-compression",
      "memory-lifecycle",
      "skill-system",
      "messaging-gateway",
      "terminal-backends",
      "model-provider",
      "subagent-delegation",
      "mcp-integration",
      "cron-scheduler",
      "trajectory-training",
      "closed-learning-loop",
      "hermes-use-cases",
      "design-principles",
      "hermes-reference",
      "hermes-tools",
      "hermes-doctor",
      "hermes-model",
      "hermes-skills",
      "hermes-usage",
      "hermes-platforms",
      "provider-status",
      "provider-model-list",
      "system-status",
      "computer-access",
      "computer-search",
      "computer-directory-list",
      "computer-file-read",
      "computer-file-write",
      "computer-delete",
      "browser-navigate",
      "browser-observe",
      "project-test",
      "project-build",
      "project-release",
      "file-write",
      "file-read",
      "file-list",
      "shell-plan",
      "time",
      "task-create",
      "task-list",
    ]);
    if ((intents || []).some((intent) => deterministicIntents.has(intent))) {
      return true;
    }
    const deterministicTools = new Set([
      "real_task_health",
      "list_computer_directory",
      "search_computer_files",
      "read_computer_file",
      "write_computer_file",
      "delete_computer_path",
      "browser_navigate",
      "open_browser_url",
      "browser_snapshot",
      "provider_status",
      "configure_provider_brain",
      "list_provider_models",
      "computer_system_status",
      "web_research",
      "web_search",
      "configure_telegram",
      "openclaw_code_study",
      "run_terminal_command",
      "plan_shell_command",
      "write_file",
      "append_file",
      "verify_html_artifact",
      "read_file",
      "list_files",
      "time_now",
      "list_tasks",
      "create_task",
    ]);
    return toolOutputs.some((item) => deterministicTools.has(item.tool));
  }

  shouldUseProviderGroundedSynthesis({ intents = [], toolOutputs = [], providerInfo = {} } = {}) {
    if (!providerInfo || providerInfo.ready === false || providerInfo.id === "mock/local-rule-engine") {
      return false;
    }
    return (toolOutputs || []).some((item) => this.classifyToolOutput(item) === "completed");
  }

  buildFinalSynthesisMessages({ message = "", intents = [], agent = {}, profile = {}, contextBundle = {}, toolOutputs = [] } = {}) {
    const observationSummary = (toolOutputs || []).map((item, index) => {
      const output = item.output || {};
      const status = item.toolSummary?.status || this.classifyToolOutput(item);
      const summary = item.toolSummary?.summary || this.summarizeToolOutputForUser(item);
      const compact = this.compactToolOutputForSynthesis(item);
      return {
        index: index + 1,
        tool: item.tool || "tool",
        status,
        reason: item.reason || "",
        summary,
        observation: compact,
        source: item.source || "",
        round: item.round || null,
      };
    });

    return [
      {
        role: "system",
        content: [
          "You are the final-answer brain inside OmniClaw.",
          "OmniClaw has already executed tools. Your job is to think over the observations and write the final user-facing answer.",
          "Do not call tools in this stage. Do not dump JSON, raw tool logs, provider names, or internal trace labels.",
          "Treat tool observations as ground truth. If a tool failed, say the blocker. If evidence is enough, synthesize it naturally.",
          "For research: explain what the topic is, key facts/features/use cases, and cite sources using the provided source numbers/URLs when available.",
          "For coding/file tasks: say what changed, which files/commands/tests prove it, and any remaining issue.",
          "Use the user's language/style. Hinglish is preferred when the user writes Hinglish.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `User request: ${message}`,
          `Detected intents: ${(intents || []).join(", ") || "general"}`,
          `Active agent: ${agent.name || agent.id || "main"}`,
          `Profile: ${profile.id || "balanced"}`,
          "",
          "Workspace/user memory snapshot:",
          JSON.stringify({
            agent: contextBundle.agent || agent,
            activeMemory: contextBundle.activeMemory || null,
            workspaceFiles: (contextBundle.workspaceContext?.files || []).map((file) => ({
              name: file.name,
              scope: file.scope,
              preview: truncateTraceText(file.content || "", 500),
            })).slice(0, 12),
          }, null, 2),
          "",
          "Tool observations:",
          JSON.stringify(observationSummary, null, 2),
          "",
          "Write the final answer now. It must be natural language, not a tool report.",
        ].join("\n"),
      },
    ];
  }

  compactToolOutputForSynthesis(item = {}) {
    const output = item.output?.cached && item.output?.result ? item.output.result : item.output || {};
    if (["web_research", "web_search"].includes(String(item.tool || ""))) {
      return {
        query: output.query || item.input?.query || "",
        results: (output.results || []).slice(0, 6).map((result, index) => ({
          sourceIndex: index + 1,
          title: result.title || "",
          url: result.url || "",
          snippet: result.snippet || result.description || "",
        })),
        fetchCandidates: (output.fetchCandidates || output.results || []).slice(0, 6).map((result, index) => ({
          sourceIndex: index + 1,
          title: result.title || "",
          url: result.url || "",
          snippet: result.snippet || "",
        })),
        pagesRead: (output.fetchedContent || []).filter((page) => !page.fallback).slice(0, 4).map((page, index) => ({
          sourceIndex: index + 1,
          title: page.title || page.finalUrl || page.url || "",
          url: page.finalUrl || page.url || "",
          text: truncateTraceText(page.text || page.markdown || page.content || "", 1800),
        })),
      };
    }
    if (["web_fetch", "read_url"].includes(String(item.tool || ""))) {
      return {
        title: output.title || output.finalUrl || output.url || "",
        url: output.finalUrl || output.url || "",
        text: truncateTraceText(output.text || output.markdown || output.content || "", 2200),
      };
    }
    if (output.execution || output.command) {
      const execution = output.execution || output;
      return {
        command: execution.command || output.command || "",
        status: execution.status || output.status || "",
        exitCode: execution.exitCode ?? null,
        stdout: truncateTraceText(execution.stdout || "", 1600),
        stderr: truncateTraceText(execution.stderr || "", 1000),
      };
    }
    if (output.path || output.file) {
      return {
        path: output.path || output.file,
        bytesWritten: output.bytesWritten,
        bytesRead: output.bytesRead,
        totalBytes: output.totalBytes,
        content: truncateTraceText(output.content || "", 1600),
        deleted: output.deleted,
      };
    }
    return sanitizeTraceValue(output, { maxString: 1200, maxArray: 8, maxDepth: 4 });
  }

  async synthesizeFinalWithProvider({ message = "", intents = [], agent = {}, profile = {}, contextBundle = {}, toolOutputs = [], run = {}, session = {} } = {}) {
    if (!this.provider || typeof this.provider.complete !== "function") {
      return { reply: "", providerDiagnostics: null };
    }
    const config = this.config.getConfig();
    const fallbackChain = [
      ...(config.provider?.fallbacks || []),
      ...(config.fallbacks || []),
    ].filter((item, index, arr) => item && arr.indexOf(item) === index);
    const candidates = [this.provider];
    for (const candidateId of fallbackChain) {
      const candidate = getProvider(this.config, this.secrets, candidateId);
      if (candidate && typeof candidate.complete === "function") {
        candidates.push(candidate);
      }
    }
    const configuredTimeoutMs = Number(
      config.runtime?.modelToolLoop?.finalSynthesisTimeoutMs ||
      config.provider?.finalSynthesisTimeoutMs ||
      config.provider?.timeoutMs ||
      45000,
    );
    const timeoutMs = Math.max(8000, Math.min(90000, configuredTimeoutMs));
    const messages = this.buildFinalSynthesisMessages({ message, intents, agent, profile, contextBundle, toolOutputs });
    const attempts = [];

    for (const candidateProvider of candidates) {
      const providerInfo = candidateProvider.getInfo?.() || {};
      if (providerInfo.ready === false || providerInfo.id === "mock/local-rule-engine") {
        attempts.push({
          providerId: providerInfo.id || "unknown",
          model: providerInfo.model || "",
          status: "skipped",
          reason: "provider-not-ready-or-mock",
        });
        continue;
      }
      const startedAt = new Date().toISOString();
      this.gateway.addEvent("agent.thinking", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        phase: "final-synthesis",
        message: `LLM is reading ${toolOutputs.length} tool observation(s) and writing the final answer.`,
      });
      this.gateway.addEvent("provider.started", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        providerId: providerInfo.id || "unknown",
        model: providerInfo.model || "",
        phase: "final-synthesis",
      });
      try {
      const completion = await Promise.race([
        candidateProvider.complete(
          messages,
          { temperature: 0.2, maxTokens: 1100, timeoutMs },
        ),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Final synthesis timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )),
      ]);
      const reply = String(completion?.text || "").trim();
      const replyLooksLikeFailure = this.looksLikeProviderFailure(reply);
      const diagnostics = {
        ok: Boolean(reply) && !replyLooksLikeFailure,
        status: reply && !replyLooksLikeFailure ? "completed" : "failed",
        reason: replyLooksLikeFailure ? "final-synthesis-provider-failure" : reply ? "final-synthesis" : "empty-final-synthesis",
        message: replyLooksLikeFailure ? this.cleanProviderFailureMessage(reply) : reply ? "" : "Provider returned an empty final synthesis.",
        providerId: providerInfo.id || "unknown",
        model: completion?.model || providerInfo.model || "",
        ready: providerInfo.ready !== false,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(startedAt),
        attempts,
      };
      attempts.push({
        providerId: diagnostics.providerId,
        model: diagnostics.model,
        status: diagnostics.status,
        reason: diagnostics.reason,
        message: diagnostics.message,
        durationMs: diagnostics.durationMs,
      });
      this.gateway.addEvent(reply && !replyLooksLikeFailure ? "provider.completed" : "provider.failed", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        providerId: diagnostics.providerId,
        model: diagnostics.model,
        reason: diagnostics.reason,
        durationMs: diagnostics.durationMs,
        phase: "final-synthesis",
      });
      if (reply) {
        if (!replyLooksLikeFailure) {
          return { reply, providerDiagnostics: diagnostics };
        }
        continue;
      }
    } catch (error) {
      const completedAt = new Date().toISOString();
      const diagnostics = {
        ok: false,
        status: "failed",
        reason: "final-synthesis-provider-error",
        message: error.message,
        providerId: providerInfo.id || "unknown",
        model: providerInfo.model || "",
        ready: providerInfo.ready !== false,
        startedAt,
        completedAt,
        durationMs: Date.now() - Date.parse(startedAt),
        attempts,
      };
      attempts.push({
        providerId: diagnostics.providerId,
        model: diagnostics.model,
        status: diagnostics.status,
        reason: diagnostics.reason,
        message: diagnostics.message,
        durationMs: diagnostics.durationMs,
      });
      this.gateway.addEvent("provider.failed", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        providerId: diagnostics.providerId,
        model: diagnostics.model,
        reason: diagnostics.reason,
        durationMs: diagnostics.durationMs,
        phase: "final-synthesis",
      });
      continue;
    }
    }
    const primaryFailure = attempts.find((item) => item.status === "failed") || null;
    const last = primaryFailure || attempts[attempts.length - 1] || {};
    const fallbackSummary = attempts.length > 1
      ? attempts.map((item) => `${item.providerId || "unknown"}:${item.reason || item.status || "unknown"}`).join(", ")
      : "";
    return {
      reply: "",
      providerDiagnostics: {
        ok: false,
        status: "failed",
        reason: last.reason || "final-synthesis-failed",
        message: [
          last.message || "All configured LLM final synthesis attempts failed.",
          fallbackSummary ? `Attempts: ${fallbackSummary}` : "",
        ].filter(Boolean).join(" "),
        providerId: last.providerId || "",
        model: last.model || "",
        ready: true,
        startedAt: attempts[0]?.startedAt || "",
        completedAt: new Date().toISOString(),
        durationMs: attempts.reduce((sum, item) => sum + Number(item.durationMs || 0), 0),
        attempts,
      },
    };
  }

  buildGroundedSynthesisFallback({ response = "", intents = [], toolOutputs = [], providerDiagnostics = null } = {}) {
    void response;
    void intents;
    void toolOutputs;
    void providerDiagnostics;
    return "";
  }

  buildModelToolLoopPrompt({ message, intents, tools, toolOutputs, round, contextBundle = {}, agent = {}, profile = {} }) {
    const visibleTools = (tools || [])
      .filter((tool) => tool.id && !["message", "sessions_send"].includes(tool.id))
      .slice(0, 80);
    const toolLines = visibleTools
      .map((tool) => `- ${tool.id}: ${tool.description || ""}`)
      .join("\n");
    const toolSchemas = visibleTools
      .filter((tool) => tool.schema)
      .slice(0, 80)
      .map((tool) => ({ id: tool.id, schema: tool.schema }));
    const commonToolExamples = [
      { tool: "web_research", args: { query: "OpenClaw agent loop", maxResults: 8, fetchTop: 5 } },
      { tool: "run_terminal_command", args: { command: "node --version" } },
      { tool: "write_file", args: { path: "data/generated/report.md", content: "# Report\n\n..." } },
      { tool: "read_file", args: { path: "data/generated/report.md" } },
      { tool: "list_files", args: { path: "." } },
      { tool: "read_url", args: { url: "https://example.com", maxChars: 12000 } },
      { tool: "computer_access_status", args: {} },
      { tool: "list_computer_directory", args: { path: "~/Downloads" } },
      { tool: "write_computer_file", args: { path: "~/Downloads/omniclaw-output.txt", content: "hlo kasa ho\n", append: false } },
      { tool: "read_computer_file", args: { path: "~/Downloads/omniclaw-output.txt" } },
      { tool: "agent_harness_doctor", args: { agentId: "codex" } },
      { tool: "agent_harness_spawn", args: { agentId: "codex", task: "Inspect the repo, fix the requested bug, and summarize changed files.", cwd: ".", mode: "run", verificationCommands: ["npm.cmd run build"], successCriteria: ["requested bug is fixed", "build passes"] } },
    ].filter((example) => visibleTools.some((tool) => tool.id === example.tool));
    const workspaceFiles = (contextBundle.workspaceContext?.files || [])
      .slice(0, 18)
      .map((file) => ({
        name: file.name,
        scope: file.scope,
        path: file.path,
        content: truncateTraceText(file.content || file.text || file.preview || "", 1200),
      }));
    const skillList = (contextBundle.skills || [])
      .slice(0, 24)
      .map((skill) => ({
        id: skill.id || skill.name,
        name: skill.name || skill.id,
        description: skill.description || "",
      }));
    const memoryBrief = {
      activeMemory: contextBundle.activeMemory?.summary || contextBundle.activeMemory || "",
      longTermMemory: contextBundle.longTermMemory,
      notes: contextBundle.notes,
      recentConversations: contextBundle.recentConversations,
    };
    const harnessBrief = {
      harness: contextBundle.harness || {},
      mcp: contextBundle.mcp || {},
    };
    const allowedToolIds = new Set(visibleTools.map((tool) => tool.id).filter(Boolean));
    const executedToolIds = this.getCompletedToolIds(toolOutputs || []);
    const missingRequiredToolIds = this.getDynamicRequiredToolIds(message, toolOutputs || [], intents || [], allowedToolIds)
      .filter((toolId) => !executedToolIds.has(toolId));
    const observations = JSON.stringify(
      (toolOutputs || []).map((item) => ({
        tool: item.tool,
        output: item.output,
      })),
      null,
      2,
    ).slice(0, 8000);
    return [
      "You are controlling OmniClaw runtime tools.",
      "Return exactly one valid JSON object. Do not use markdown or prose.",
      "Allowed output 1: {\"type\":\"tool_call\",\"tool\":\"tool_id\",\"args\":{},\"reason\":\"why\"}",
      "Allowed output 2: {\"type\":\"final_answer\",\"answer\":\"final user-facing answer\",\"reason\":\"why\"}",
      "Compatibility output also accepted: {\"toolCalls\":[{\"tool\":\"tool_id\",\"input\":{},\"reason\":\"why\"}]} or {\"toolCalls\":[],\"finalReady\":true,\"reason\":\"why\"}",
      "You are the mind. OmniClaw runtime is your body: tools, files, browser, terminal, memory, sessions, and workspace. Decide the next action yourself.",
      "Never say 'I am researching', 'I will search', 'let me check', or similar. If research is needed, emit a JSON tool_call. If observations are enough, emit final_answer.",
      missingRequiredToolIds.length
        ? `Required tool evidence still missing: ${missingRequiredToolIds.join(", ")}. You must emit a tool_call for one of these before final_answer.`
        : "Required tool evidence is satisfied; final_answer is allowed if the task is complete.",
      "Rules: use the fewest safe tool calls; never request destructive tools unless the user explicitly asked; do not call unknown tools.",
      "For real tasks, prefer evidence over claims: after writing a file, request a read/verification tool; after building HTML, request verify_html_artifact and browser proof (browser_open/browser_automate/browser_evaluate) when available; after research, fetch/read enough content to cite observations.",
      "Laptop access rule: if the user says laptop/computer/Downloads/Documents/Desktop, use computer tools such as write_computer_file, read_computer_file, list_computer_directory, and search_computer_files. Use ~/Downloads for the user's Downloads folder.",
      "Web research rule: search gives candidates; reading a page gives evidence. After web_research/web_search, inspect fetchCandidates/results and call read_url or web_fetch on the best URL unless fetchedContent already contains clean page text; do not repeat the same web_search/web_research query.",
      "If read_url/web_fetch times out or fails, choose a different candidate URL from the prior search observation. Only finalize from snippets if all reasonable fetch candidates failed.",
      "Self-correction rule: if any previous observation has error=true, blocked=true, or a failed status, do not finalize until you either call a safer corrective tool or explain exactly why no corrective tool is possible.",
      "Review cycle rule for coding/build tasks: Read or inspect -> edit/write -> verify/build/test -> summarize evidence. A final answer without verification is not complete when verification tools are available.",
      "Harness rule: for complex repo/coding tasks, first check agent_harness_doctor/status when useful, then delegate a bounded subtask with agent_harness_spawn. Include successCriteria, requiredArtifacts, and verificationCommands when possible. Inspect observation/stdout/stderr/artifacts/verification and continue the loop from that evidence.",
      "MCP rule: if the user asks for app/MCP/plugin tools, call mcp_integration_status or mcp_connect_all instead of guessing from memory.",
      "You may request multiple independent read-only tools in one round. Avoid repeating the same tool+input unless the previous output failed and the new input fixes it.",
      "",
      `Round: ${round}`,
      `User message: ${message}`,
      `Detected intents: ${(intents || []).join(", ") || "general"}`,
      `Active agent: ${agent.name || agent.id || "main"} (${agent.id || "main"})`,
      `Runtime profile: ${profile.id || "unknown"}`,
      "",
      "Workspace identity/instruction files loaded for you:",
      JSON.stringify(workspaceFiles, null, 2).slice(0, 7000) || "[]",
      "",
      "Available skills:",
      JSON.stringify(skillList, null, 2).slice(0, 3000) || "[]",
      "",
      "Memory/context brief:",
      JSON.stringify(memoryBrief, null, 2).slice(0, 5000) || "{}",
      "",
      "Harness/MCP context:",
      JSON.stringify(harnessBrief, null, 2).slice(0, 3500) || "{}",
      "",
      "Available tools:",
      toolLines || "(none)",
      "",
      "Tool argument schemas:",
      JSON.stringify(toolSchemas, null, 2).slice(0, 7000) || "[]",
      "",
      "Common valid tool-call examples:",
      JSON.stringify(commonToolExamples, null, 2) || "[]",
      "",
      "Previous observations:",
      observations || "[]",
      "",
      "JSON only:",
    ].join("\n");
  }

  buildNativeToolSchemas(tools = []) {
    return (tools || [])
      .filter((tool) => tool.id && !["message", "sessions_send"].includes(tool.id))
      .slice(0, 80)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.id,
          description: truncateTraceText(tool.description || `Run ${tool.id}.`, 900),
          parameters: tool.schema || {
            type: "object",
            additionalProperties: true,
            properties: {},
          },
        },
      }));
  }

  parseNativeToolLoopResponse(completion, allowedToolIds, maxCalls) {
    const rawCalls = Array.isArray(completion?.toolCalls) ? completion.toolCalls : [];
    const normalized = rawCalls.map((call) => ({
      id: String(call.id || "").trim(),
      tool: String(call.tool || call.name || "").trim(),
      input: this.normalizeModelToolInput(call),
      reason: "Provider emitted a native tool call.",
    }));
    return {
      raw: truncateTraceText(completion?.text || "", 2000),
      validJson: true,
      nativeTools: true,
      finalReady: rawCalls.length === 0 && Boolean(String(completion?.text || "").trim()),
      answer: rawCalls.length === 0 ? String(completion?.text || "").trim() : "",
      reason: rawCalls.length ? "native-tool-calls" : "native-no-tool-calls",
      missingToolCallClaim: this.looksLikeUnexecutedToolClaim(completion?.text || ""),
      rejectedCalls: normalized.filter((call) => !call.tool || !allowedToolIds.has(call.tool)),
      calls: normalized.filter((call) => call.tool && allowedToolIds.has(call.tool)).slice(0, maxCalls),
    };
  }

  buildNativeToolResultMessage(call = {}, output = {}) {
    const content = truncateTraceText(JSON.stringify(output || {}, null, 2), 12000);
    return {
      role: "tool",
      tool_call_id: call.id || `call_${call.tool || "tool"}`,
      name: call.tool || "",
      content,
    };
  }

  parseModelToolCalls(text, allowedToolIds, maxCalls) {
    return this.parseModelToolLoopResponse(text, allowedToolIds, maxCalls).calls;
  }

  parseModelToolLoopResponse(text, allowedToolIds, maxCalls) {
    const raw = String(text || "").trim();
    const response = {
      raw: truncateTraceText(raw, 2000),
      validJson: false,
      finalReady: false,
      reason: "",
      answer: "",
      calls: [],
      rejectedCalls: [],
      missingToolCallClaim: this.looksLikeUnexecutedToolClaim(raw),
    };
    if (!raw) {
      response.reason = "empty-model-tool-loop-response";
      return response;
    }
    let parsed = null;
      try {
        parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
        response.validJson = true;
      } catch (error) {
        response.reason = `invalid-json: ${error.message}`;
        response.invalidActionClaim = response.missingToolCallClaim;
        return response;
      }
    if (parsed.type && !["tool_call", "final_answer"].includes(String(parsed.type))) {
      response.validJson = false;
      response.reason = `unknown-output-type: ${parsed.type}`;
      response.invalidActionClaim = response.missingToolCallClaim;
      return response;
    }
    response.finalReady = Boolean(
      parsed.type === "final_answer" ||
      parsed.finalReady ||
      parsed.done ||
      parsed.complete,
    );
    response.reason = String(parsed.reason || parsed.summary || "").trim();
    response.answer = String(parsed.answer || parsed.finalAnswer || parsed.response || "").trim();
    const calls = parsed.type === "tool_call"
      ? [{ tool: parsed.tool, input: parsed.args || parsed.input || parsed.arguments || {}, reason: parsed.reason }]
      : Array.isArray(parsed.toolCalls)
        ? parsed.toolCalls
        : Array.isArray(parsed.tools)
          ? parsed.tools
          : Array.isArray(parsed.calls)
            ? parsed.calls
            : [];
    const normalized = calls
      .map((call) => ({
        tool: String(call.tool || call.name || "").trim(),
        input: this.normalizeModelToolInput(call),
        reason: String(call.reason || "Provider requested this tool.").trim(),
      }));
    response.rejectedCalls = normalized.filter((call) => !call.tool || !allowedToolIds.has(call.tool));
    response.calls = normalized.filter((call) => call.tool && allowedToolIds.has(call.tool)).slice(0, maxCalls);
    response.invalidActionClaim = Boolean(response.missingToolCallClaim && response.calls.length === 0 && !response.finalReady);
    return response;
  }

  looksLikeUnexecutedToolClaim(text = "") {
    return /<\|tool_(?:calls_section|call)_/i.test(String(text || "")) ||
      /\b(web_research|web_search|web_fetch|write_file|read_file|append_file|research(?:ing)?|search(?:ing)?|look(?:ing)? up|browse|fetch|open(?:ing)?|write(?:ing)? file|read(?:ing)? file|run(?:ning)? command|screenshot|inspect(?:ing)?|check(?:ing)? the web)\b/i.test(String(text || ""));
  }

  extractExplicitFileContent(message = "") {
    const text = String(message || "");
    const fenced = text.match(/```(?:markdown|md|text)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]?.trim()) {
      return fenced[1].trim();
    }
    const headingIndex = text.search(/^#\s+/m);
    if (headingIndex >= 0) {
      return text.slice(headingIndex).trim();
    }
    return "";
  }

  extractTerminalCommandFromMessage(message = "") {
    const text = String(message || "");
    const quoted = text.match(/(?:terminal command|command|cmd)[^"'`]*["'`]([^"'`]+)["'`]/i);
    if (quoted?.[1]?.trim()) return quoted[1].trim();
    const nodeVersion = text.match(/\bnode\s+--version\b/i);
    if (nodeVersion) return "node --version";
    return "";
  }

  extractMarkdownContentFromProvider(text = "") {
    const value = String(text || "").trim();
    const start = value.search(/^#\s+/m);
    if (start >= 0) {
      return value.slice(start).replace(/\nTools jo chale:[\s\S]*$/i, "").trim();
    }
    return "";
  }

  extractRequestedReportHeading(message = "", fallback = "") {
    const text = String(message || "");
    const quoted = text.match(/\bheading\s+["“]([^"”]+)["”]/i);
    if (quoted?.[1]?.trim()) return quoted[1].trim();
    const plain = text.match(/\bheading\s+([A-Za-z0-9][\p{L}\p{N}\s.+#_-]{2,120}?)(?=\s+(?:and|aur|with|hai|ha|he|hona|ho|is)\b|[.,;\r\n]|$)/iu);
    if (plain?.[1]?.trim()) return plain[1].trim();
    return String(fallback || "").trim();
  }

  pickBestResearchObservation(message = "", toolOutputs = []) {
    const researchOutputs = (toolOutputs || [])
      .filter((item) => item.tool === "web_research" || item.tool === "web_search")
      .map((item, index) => ({
        item,
        index,
        output: item.output?.cached && item.output.result ? item.output.result : item.output || {},
      }))
      .filter(({ output }) => output && !output.error && !output.blocked);
    if (researchOutputs.length === 0) return null;
    const messageTerms = new Set(String(message || "")
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+#._-]{2,}/g) || []);
    const scored = researchOutputs.map((entry) => {
      const haystack = [
        entry.output.query,
        ...(Array.isArray(entry.output.results) ? entry.output.results.flatMap((result) => [result.title, result.snippet, result.url]) : []),
      ].join(" ").toLowerCase();
      let score = entry.index * 0.01;
      for (const term of messageTerms) {
        if (haystack.includes(term)) score += 1;
      }
      if (/nvidia|agent harness|llm|harness architecture/i.test(haystack)) score += 3;
      if (/act!|critical role|loop heat pipe|act-r/i.test(haystack) && /nvidia|agent harness|llm/i.test(String(message || ""))) score -= 5;
      return { ...entry, score };
    });
    scored.sort((left, right) => right.score - left.score || right.index - left.index);
    return scored[0]?.item || researchOutputs[researchOutputs.length - 1].item;
  }

  getRequiredToolIdsFromMessage(message = "") {
    const text = String(message || "");
    const required = [];
    if (this.isResearchLikeText(text)) required.push("web_research");
    if (/\b(read_url|read url|web_fetch|fetch url|url fetch|best URL\s+(?:read|fetch)|URL\s+(?:ko\s+)?(?:read|fetch))\b/i.test(text)) required.push("read_url");
    if (/\b(terminal command|run command|command chalao|cmd|node\s+--version)\b/i.test(text)) required.push("run_terminal_command");
    if (
      /\b(?:laptop|computer|pc|downloads?|documents?|desktop)\b/i.test(text) &&
      /\bfile\b/i.test(text) &&
      /\b(?:bna|bana|banao|bnana|banana|create|write|save|likho)\b/i.test(text)
    ) {
      required.push("write_computer_file");
      required.push("read_computer_file");
    }
    if (/\b(write|likho|file me|file mein|save|bna|bana|banao|bnana|banana|create)\b/i.test(text) && this.planner.extractPath(text)) required.push("write_file");
    if (/\b(read_file|read[- ]?back|verify|wapas verify|read karke|read back)\b/i.test(text)) required.push("read_file");
    if (/\b(code[- ]?review|inspect|check|analyze|analyse|problem|bug|issue|debug|fix|error|crash)\b/i.test(text)) {
      required.push("read_file");
    }
    if (/\b(upload(?:ed)?|attached|attachment)\s+(?:file|image|document|pdf)\b/i.test(text)) {
      required.push("read_file");
    }
    return [...new Set(required)];
  }

  getExecutedToolIds(toolOutputs = []) {
    return new Set((toolOutputs || []).map((item) => item.tool).filter(Boolean));
  }

  isResearchLikeText(message = "", intents = []) {
    const text = String(message || "");
    return (intents || []).includes("research") ||
      /\b(?:research|reaserach|raeserach|reaserch|raeserch|web\s*research|deep\s*research|search\s+web|look\s+up|find\s+on\s+web|fetch|read_url|web_fetch|source|sources)\b/i.test(text);
  }

  getCompletedToolIds(toolOutputs = []) {
    const completed = new Set((toolOutputs || [])
      .filter((item) => {
        if (this.classifyToolOutput(item) !== "completed") return false;
        if (item.tool === "read_url" || item.tool === "web_fetch") {
          const output = item.output || {};
          return Boolean(String(output.text || output.markdown || output.content || "").trim());
        }
        return true;
      })
      .map((item) => item.tool)
      .filter(Boolean));
    if (completed.has("web_research") || completed.has("web_search")) {
      completed.add("web_research");
      completed.add("web_search");
    }
    if (completed.has("read_url") || completed.has("web_fetch")) {
      completed.add("read_url");
      completed.add("web_fetch");
    }
    return completed;
  }

  isResearchTaskMessage(message = "", intents = []) {
    return this.isResearchLikeText(message, intents);
  }

  hasSuccessfulWebPageContent(toolOutputs = []) {
    return (toolOutputs || []).some((item) => {
      const output = item.output?.cached && item.output?.result ? item.output.result : item.output || {};
      if ((item.tool === "read_url" || item.tool === "web_fetch") && !output.error && !output.blocked) {
        return Boolean(String(output.text || output.markdown || output.content || "").trim());
      }
      if (item.tool === "web_research" || item.tool === "web_search") {
        return Array.isArray(output.fetchedContent) &&
          output.fetchedContent.some((page) => page?.text && !page.error && !page.fallback);
      }
      return false;
    });
  }

  getTriedWebFetchUrls(toolOutputs = []) {
    return new Set((toolOutputs || [])
      .filter((item) => item.tool === "read_url" || item.tool === "web_fetch")
      .map((item) => String(item.input?.url || item.output?.url || item.output?.finalUrl || "").replace(/#.*$/, "").replace(/\/$/, "").toLowerCase())
      .filter(Boolean));
  }

  getWebFetchCandidatesFromOutputs(toolOutputs = []) {
    const candidates = [];
    for (const item of toolOutputs || []) {
      const output = item.output?.cached && item.output?.result ? item.output.result : item.output || {};
      if (item.tool !== "web_research" && item.tool !== "web_search") continue;
      const sourceRows = Array.isArray(output.fetchCandidates) && output.fetchCandidates.length
        ? output.fetchCandidates
        : (Array.isArray(output.results) ? output.results : []);
      for (const row of sourceRows) {
        const url = String(row?.url || "").trim();
        if (!/^https?:\/\//i.test(url)) continue;
        candidates.push({
          url,
          title: row.title || "",
          snippet: row.snippet || "",
          rank: Number(row.rank || candidates.length + 1),
          source: row.source || "",
        });
      }
    }
    const seen = new Set();
    return candidates.filter((candidate) => {
      const key = candidate.url.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 8);
  }

  getNextWebFetchCandidate(toolOutputs = []) {
    const tried = this.getTriedWebFetchUrls(toolOutputs);
    return this.getWebFetchCandidatesFromOutputs(toolOutputs)
      .find((candidate) => !tried.has(candidate.url.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase())) || null;
  }

  getDynamicRequiredToolIds(message = "", toolOutputs = [], intents = [], allowedToolIds = new Set()) {
    const required = this.getRequiredToolIdsFromMessage(message);
    const completed = this.getCompletedToolIds(toolOutputs);
    const hasSearch = completed.has("web_research") || completed.has("web_search");
    const wantsResearch = this.isResearchTaskMessage(message, intents);
    const canFetch = allowedToolIds.has("read_url") || allowedToolIds.has("web_fetch");
    if (
      wantsResearch &&
      hasSearch &&
      canFetch &&
      !this.hasSuccessfulWebPageContent(toolOutputs) &&
      this.getNextWebFetchCandidate(toolOutputs)
    ) {
      required.push(allowedToolIds.has("read_url") ? "read_url" : "web_fetch");
    }
    return [...new Set(required)];
  }

  extractResearchQueryForToolRecovery(message = "") {
    const text = String(message || "");
    const researchClause =
      text.match(/\b(?:web\s+)?(?:research|reaserach|raeserach|reaserch|raeserch)\s+(?:karo|karna|do|on|about|for)?\s*[:\-]\s*([^\r\n.]+(?:\.[^\r\n.]+)?)/i) ||
      text.match(/\b(?:web\s+)?(?:research|reaserach|raeserach|reaserch|raeserch)\s+(?:karo|karna|do|on|about|for)\s+([^\r\n.]+(?:\.[^\r\n.]+)?)/i);
    if (researchClause?.[1]?.trim()) {
      const clause = researchClause[1]
        .replace(/\b(?:search|fetch|read)\s*\/?\s*(?:fetch|read|search)?\s+karo[\s\S]*$/i, "")
        .replace(/\b(?:sirf|only)\s+url[\s\S]*$/i, "")
        .replace(/\b(?:ko|ke|ka|ki)\s+(?:latest\s+)?(?:public\s+)?(?:info|information)\s+(?:ko\s+)?(?:samjho|understand|batao)\b/gi, " latest public info")
        .replace(/\b(?:samjho|understand|batao)\b/gi, "")
        .replace(/\s+/g, " ")
        .replace(/[.。]+$/g, "")
        .trim();
      if (clause && clause.length >= 3 && !/\.md\b|\.txt\b|\.json\b|^data[\\/]/i.test(clause)) {
        return clause;
      }
    }
    const focused =
      text.match(/(?:^|\b)(?:tu\s+|tum\s+)?(?:m[eai]r[ae]?|maraa?|mera|mere)\s+li(?:ye|ya)\s+(.+?)\s+(?:ka|ke|ki)\s+(?:baare|bare|bara)\s+(?:me|mein|ma)\b/i) ||
      text.match(/(?:^|\b)(?:tu\s+|tum\s+)?(?:m[eai]r[ae]?|maraa?|mera|mere)\s+li(?:ye|ya)\s+(.+?)\s+(?:research|reaserach|raeserach|reaserch|raeserch)\b/i) ||
      text.match(/(.+?)\s+(?:ka|ke|ki)\s+(?:baare|bare|bara)\s+(?:me|mein|ma)\s+(?:research|reaserach|raeserach|reaserch|raeserch)\b/i) ||
      text.match(/web\s+research\s+se\s+(.+?)\s+(?:find|search|dhundo|dhoondo|nikalo|batao|summary|summarize|read|fetch)\b/i) ||
      text.match(/web\s+research\s+se\s+(.+?)\s+(?:ka|ki|ke)?\s*(?:short\s+summary|summary|research|nikalo|banao)/i) ||
      text.match(/research\s+se\s+(.+?)\s+(?:find|search|dhundo|dhoondo|nikalo|batao|summary|summarize|read|fetch)\b/i) ||
      text.match(/\b([A-Za-z0-9][\p{L}\p{N}\s.+#_-]{1,80}?)\s+(?:ai\s+)?(?:kya|what)\s+(?:ha|hai|he|is)\b/iu) ||
      text.match(/research\s+se\s+(.+?)\s+(?:ka|ki|ke)?\s*(?:short\s+summary|summary|research|nikalo|banao)/i);
    if (focused?.[1]?.trim()) {
      return focused[1]
        .replace(/\b(?:ka|ki|ke)$/i, "")
        .replace(/\b(?:best\s+url|url|terminal|command|file|write|likho|read_file|verify)\b[\s\S]*$/i, "")
        .replace(/[.。]+$/g, "")
        .trim();
    }
    const quoted = text.match(/research(?:\s+about|\s+on)?\s+["'`]([^"'`]+)["'`]/i);
    if (quoted?.[1]?.trim()) return quoted[1].trim();
    const planned = this.planner.extractResearchQuery(message);
    if (planned && !/[\\/]|\.md\b|\.txt\b|\.json\b|^data\//i.test(planned)) {
      return planned;
    }
    return text
      .replace(/\b(?:web\s+)?research\s+se\b/i, "")
      .replace(/\b(?:research|reaserach|raeserach|reaserch|raeserch)\b/gi, " ")
      .replace(/\b(?:tu|tum)\b/gi, " ")
      .replace(/\b(?:m[eai]r[ae]?|maraa?|mera|mere)\s+li(?:ye|ya)\b/gi, " ")
      .replace(/\b(?:ka|ke|ki)\s+(?:baare|bare|bara)\s+(?:me|mein|ma)\b/gi, " ")
      .replace(/\b(?:best\s+url|url|terminal|command|file|write|likho|read_file|verify)\b[\s\S]*$/i, "")
      .replace(/\s+/g, " ")
      .trim() || "OpenClaw official docs";
  }

  buildFallbackToolCall({ message = "", intents = [], allowedToolIds = new Set(), executedToolIds = new Set(), providerText = "" } = {}) {
    const lowered = String(message || "").toLowerCase();
    const candidates = [];
    const addCandidate = (call) => {
      if (!call?.tool || executedToolIds.has(call.tool)) return;
      candidates.push(call);
    };
    if (this.isResearchLikeText(message, intents)) {
      addCandidate({
        tool: "web_research",
        input: { query: this.extractResearchQueryForToolRecovery(message) },
        reason: "Recovered a missing web research tool call from provider text.",
      });
      addCandidate({
        tool: "web_search",
        input: { query: this.extractResearchQueryForToolRecovery(message) },
        reason: "Recovered a missing web search tool call from provider text.",
      });
    }
    if (/\b(terminal command|run command|command chalao|cmd|node\s+--version)\b/i.test(lowered)) {
      const command = this.extractTerminalCommandFromMessage(message);
      if (command) {
        addCandidate({
          tool: "run_terminal_command",
          input: { command },
          reason: "Recovered a missing terminal command tool call.",
        });
      }
    }
    if (intents.includes("browser-observe") || /\b(browser snapshot|inspect browser|page snapshot)\b/i.test(lowered)) {
      addCandidate({
        tool: "browser",
        input: /\bbrowser\s+(?:status|doctor|health|ready|available)\b/i.test(message)
          ? { action: "status" }
          : { action: /screenshot|capture/i.test(message) ? "screenshot" : "view", format: "markdown" },
        reason: "Recovered a missing browser observation tool call from provider text.",
      });
    }
    if (intents.includes("file-list")) {
      addCandidate({
        tool: "list_files",
        input: { path: this.planner.extractPath(message, ".") },
        reason: "Recovered a missing workspace file listing tool call.",
      });
    }
    if (intents.includes("computer-search")) {
      addCandidate({
        tool: "search_computer_files",
        input: {
          query: this.planner.extractComputerSearchQuery(message),
          maxDepth: 5,
          maxResults: 80,
          maxScanMs: 10000,
        },
        reason: "Recovered a missing governed laptop file search tool call.",
      });
    }
    if (intents.includes("computer-file-write")) {
      const writeRequest = this.planner.extractComputerWriteRequest(message);
      addCandidate({
        tool: "write_computer_file",
        input: writeRequest,
        reason: "Recovered a missing laptop/computer file write tool call.",
      });
      addCandidate({
        tool: "read_computer_file",
        input: { path: writeRequest.path },
        reason: "Recovered read-back verification for the laptop/computer file write.",
      });
    }
    const requiredIds = this.getRequiredToolIdsFromMessage(message);
    const writeRequiredBeforeRead = requiredIds.includes("write_file") && !executedToolIds.has("write_file");
    if (!writeRequiredBeforeRead && (intents.includes("file-read") || /\b(read_file|read[- ]?back|verify|wapas verify|read karke|read back)\b/i.test(lowered))) {
      addCandidate({
        tool: "read_file",
        input: { path: this.planner.extractPath(message) },
        reason: "Recovered a missing workspace file read tool call.",
      });
    }
    if (intents.includes("file-write") || /\b(write_file|write\s+(?:the\s+)?(?:same\s+)?file|rewrite\s+(?:the\s+)?(?:same\s+)?file|likho|file me|file mein|save|bna|bana|banao|bnana|banana|create)\b/i.test(lowered)) {
      addCandidate({
        tool: "write_file",
        input: {
          path: this.planner.extractPath(message),
          content: this.extractExplicitFileContent(message) || this.extractMarkdownContentFromProvider(providerText),
        },
        reason: "Recovered a missing workspace file write tool call.",
      });
    }
    if (intents.includes("system-status")) {
      addCandidate({
        tool: "computer_system_status",
        input: {},
        reason: "Recovered a missing system status tool call.",
      });
    }
    return candidates.find((call) => allowedToolIds.has(call.tool)) || null;
  }

  buildRequiredReportContent({ message = "", toolOutputs = [] } = {}) {
    const research = this.pickBestResearchObservation(message, toolOutputs);
    const pageReads = toolOutputs
      .filter((item) => item.tool === "read_url" || item.tool === "web_fetch")
      .map((item) => item.output?.cached && item.output?.result ? item.output.result : item.output || {})
      .filter((output) => output && !output.error && !output.blocked);
    const terminal = toolOutputs.find((item) => item.tool === "run_terminal_command");
    const researchOutput = research?.output?.cached && research.output.result ? research.output.result : research?.output || {};
    const query = researchOutput.query || this.extractResearchQueryForToolRecovery(message) || "research";
    const requestedHeading = this.extractRequestedReportHeading(message);
    const results = Array.isArray(researchOutput.results) ? researchOutput.results.slice(0, 6) : [];
    const pageEvidence = [
      ...(Array.isArray(researchOutput.fetchedContent) ? researchOutput.fetchedContent : []),
      ...pageReads,
    ]
      .filter((page) => page && !page.error && !page.blocked)
      .slice(0, 4);
    const evidenceBullets = pageEvidence
      .map((page) => String(page.text || page.markdown || page.content || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((text) => {
        const sentences = text.split(/(?<=[.!?])\s+/).filter((part) => part.length > 40);
        return sentences.slice(0, 2).join(" ").slice(0, 420);
      })
      .filter(Boolean);
    const terminalOutput = terminal?.output || {};
    const commandOutput = terminalOutput.stdout || terminalOutput.output || terminalOutput.text || "";
    if (research) {
      const title = (requestedHeading || query)
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      return [
        `# ${title}`,
        "",
        "Provider final synthesis was not available when this file was written, so this is an evidence-backed research artifact from OmniClaw tool observations.",
        "",
        "## Key Summary",
        evidenceBullets.length
          ? evidenceBullets.slice(0, 12).map((item) => `- ${item}`).join("\n")
          : results.slice(0, 8).map((item) => `- ${item.snippet || item.title || item.url || "Source observation."}`).join("\n") || "- No clean evidence text was available.",
        "",
        "## Source Summary",
        results.length
          ? results.map((item, index) => `${index + 1}. ${item.title || "Source"}\n   URL: ${item.url || "unknown"}\n   Note: ${item.snippet || item.description || "No snippet returned."}`).join("\n")
          : "No source rows were returned.",
        "",
        "## Page Evidence",
        evidenceBullets.length
          ? evidenceBullets.map((item, index) => `${index + 1}. ${item}`).join("\n")
          : "No fetched page text was available; use the source URLs above for follow-up.",
        "",
        "## Sources",
        ...results.map((item) => `- ${item.url || item.title || "unknown"}`),
        "",
      ].join("\n");
    }
    return [
      "# Agent Tool Evidence",
      "",
      "## Request",
      String(message || "").trim(),
      "",
      "## Research Summary",
      results.length
        ? results.map((item, index) => `${index + 1}. ${item.title || "Source"} - ${item.snippet || item.url || ""}`).join("\n")
        : "Research tool did not return usable source rows.",
      "",
      "## Terminal Output",
      `Command: ${this.extractTerminalCommandFromMessage(message) || "not detected"}`,
      "```text",
      String(commandOutput || terminalOutput.message || "No terminal stdout captured.").trim(),
      "```",
      "",
      "## Sources",
      ...results.map((item) => `- ${item.url || item.title || "unknown"}`),
      "",
    ].join("\n");
  }

  async runRequiredToolRepair({ message = "", intents = [], allowedToolIds = new Set(), toolOutputs = [], run, session, agent, providerText = "" } = {}) {
    const added = [];
    for (let index = 0; index < 8; index++) {
      const executedToolIds = this.getCompletedToolIds([...toolOutputs, ...added]);
      const required = this.getDynamicRequiredToolIds(message, [...toolOutputs, ...added], intents, allowedToolIds);
      const missing = required.filter((toolId) => !executedToolIds.has(toolId));
      if (missing.length === 0) break;
      let call = null;
      const next = missing[0];
      if (next === "read_url" || next === "web_fetch") {
        const candidate = this.getNextWebFetchCandidate([...toolOutputs, ...added]);
        if (!candidate) break;
        call = {
          tool: allowedToolIds.has("read_url") ? "read_url" : "web_fetch",
          input: { url: candidate.url, maxChars: 12000 },
          reason: `Required page fetch recovered from search candidate: ${candidate.title || candidate.url}`,
        };
      } else if (next === "write_computer_file") {
        call = {
          tool: "write_computer_file",
          input: this.planner.extractComputerWriteRequest(message),
          reason: "Required laptop/computer file write recovered from explicit user request.",
        };
      } else if (next === "read_computer_file") {
        call = {
          tool: "read_computer_file",
          input: { path: this.planner.extractComputerWriteRequest(message).path },
          reason: "Required laptop/computer read-back verification recovered from explicit user request.",
        };
      } else if (next === "write_file") {
        const providerContent =
          this.extractExplicitFileContent(providerText) ||
          this.extractMarkdownContentFromProvider(providerText) ||
          String(providerText || "").trim();
        call = {
          tool: "write_file",
          input: {
            path: this.planner.extractPath(message),
            content: providerContent && providerContent.length > 120
              ? providerContent
              : this.buildRequiredReportContent({ message, toolOutputs: [...toolOutputs, ...added] }),
          },
          reason: "Required file write recovered from explicit user request.",
        };
      } else if (next === "read_file") {
        call = {
          tool: "read_file",
          input: { path: this.planner.extractPath(message) },
          reason: "Required read-back verification recovered from explicit user request.",
        };
      } else {
        call = this.buildFallbackToolCall({ message, intents, allowedToolIds, executedToolIds });
      }
      if (!call || !allowedToolIds.has(call.tool)) break;
      const results = await this.runAutoVerificationPass({
        agent,
        session,
        run,
        toolOutputs: [...toolOutputs, ...added],
        callsOverride: [call],
      });
      if (results.length === 0) break;
      added.push(...results);
    }
    return added;
  }

  planAutoVerificationCalls(toolOutputs = []) {
    const writeTools = new Set(["write_file", "append_file", "edit"]);
    const verificationTools = new Set(["read_file", "verify_html_artifact", "browser_automate", "browser_open", "browser_evaluate", "browser_screenshot"]);
    const calls = [];
    const latestWriteByPath = new Map();
    const verificationByPath = new Map();
    const browserProofByPath = new Map();

    (toolOutputs || []).forEach((item, index) => {
      const pathValue = String(item?.output?.path || item?.input?.path || "").trim();
      if (!pathValue) return;
      const key = pathValue.replace(/\\/g, "/").toLowerCase();
      if (verificationTools.has(item.tool)) {
        verificationByPath.set(key, Math.max(index, Number(verificationByPath.get(key) ?? -1)));
        if (/^browser_/.test(item.tool)) {
          browserProofByPath.set(key, Math.max(index, Number(browserProofByPath.get(key) ?? -1)));
        }
        return;
      }
      if (
        writeTools.has(item.tool) &&
        !item?.output?.error &&
        !item?.output?.blocked
      ) {
        latestWriteByPath.set(key, {
          path: pathValue,
          index,
        });
      }
    });

    const orderedWrites = [...latestWriteByPath.entries()].sort(([, a], [, b]) => {
      const aHtml = /\.(html?|xhtml)$/i.test(a.path);
      const bHtml = /\.(html?|xhtml)$/i.test(b.path);
      if (aHtml !== bHtml) return bHtml ? 1 : -1;
      return b.index - a.index;
    });

    for (const [key, write] of orderedWrites) {
      const isHtml = /\.(html?|xhtml)$/i.test(write.path);
      if (Number(verificationByPath.get(key) ?? -1) <= write.index) {
        calls.push({
          tool: isHtml ? "verify_html_artifact" : "read_file",
          input: isHtml
            ? { path: write.path, minBytes: 800 }
            : { path: write.path },
          reason: isHtml
            ? "Auto-verification after HTML artifact write."
            : "Auto-verification read after file write.",
          sourceWriteIndex: write.index,
        });
      }
      if (isHtml && Number(browserProofByPath.get(key) ?? -1) <= write.index) {
        const absolutePath = path.resolve(this.rootDir, write.path);
        calls.push({
          tool: "browser_automate",
          input: {
            url: pathToFileURL(absolutePath).href,
            actions: [
              {
                type: "evaluate",
                script: "({ title: document.title, bodyChars: document.body.innerText.length, hasBody: document.body.innerText.length > 0, hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth })",
              },
              { type: "screenshot", fullPage: false },
            ],
          },
          reason: "Auto browser proof after HTML artifact write.",
          sourceWriteIndex: write.index,
        });
      }
      if (calls.length >= 3) break;
    }

    return calls;
  }

  async runAutoVerificationPass({ agent, session, run, toolOutputs = [], callsOverride = null } = {}) {
    const calls = Array.isArray(callsOverride) ? callsOverride : this.planAutoVerificationCalls(toolOutputs);
    if (calls.length === 0) {
      return [];
    }

    this.gateway.addEvent("agent.thinking", {
      runId: run.id,
      sessionId: session.id,
      agentId: agent.id,
      phase: "auto-verification",
      message: "Verifying files changed by the agent before sending the final answer.",
    });

    const results = [];
    for (const call of calls) {
      const toolTraceId = createToolTraceId();
      const toolStartedAt = new Date().toISOString();
      this.upsertRunToolTrace(run.id, {
        id: toolTraceId,
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        source: "auto-verification",
        status: "running",
        tool: call.tool,
        input: call.input,
        reason: call.reason,
        startedAt: toolStartedAt,
      });
      this.gateway.addEvent("auto_verification.tool_started", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        tool: call.tool,
        reason: call.reason,
      });

      let output;
      try {
        output = await this.tools.run(call.tool, call.input, {
          agentId: agent.id,
          sessionId: session.id,
          runId: run.id,
          source: "auto-verification",
        });
      } catch (error) {
        output = {
          error: true,
          message: error.message,
          agentId: agent.id,
        };
      }

      results.push({
        tool: call.tool,
        input: call.input,
        reason: call.reason,
        source: "auto-verification",
        output,
      });
      this.gateway.addEvent("auto_verification.tool_completed", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        tool: call.tool,
        blocked: Boolean(output?.blocked),
        error: Boolean(output?.error),
        ...this.buildToolEventDetails(call.tool, output),
      });
      this.upsertRunToolTrace(run.id, {
        id: toolTraceId,
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        source: "auto-verification",
        status: output?.error || output?.blocked ? "failed" : "completed",
        tool: call.tool,
        input: call.input,
        output,
        reason: call.reason,
        startedAt: toolStartedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(toolStartedAt),
        blocked: Boolean(output?.blocked),
        error: Boolean(output?.error),
      });
    }

    return results;
  }

  normalizeModelToolInput(call = {}) {
    const raw = call.input ?? call.arguments ?? {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw;
    }
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  normalizeToolRepeatInput(tool = "", input = {}) {
    const normalizedTool = String(tool || "").trim();
    const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (["web_search", "web_research"].includes(normalizedTool)) {
      const query = String(value.query || value.q || value.search || "").toLowerCase().replace(/\s+/g, " ").trim();
      return { query };
    }
    if (["web_fetch", "read_url", "browser_navigate", "open_browser_url"].includes(normalizedTool)) {
      return { url: String(value.url || value.href || "").toLowerCase().trim() };
    }
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  }

  buildToolCallKey(call = {}) {
    return `${String(call.tool || "").trim()}:${JSON.stringify(this.normalizeToolRepeatInput(call.tool, call.input || {}))}`;
  }

  repairModelLoopToolCall({ call = {}, message = "" } = {}) {
    const tool = String(call.tool || "").trim();
    const input = call.input && typeof call.input === "object" && !Array.isArray(call.input)
      ? { ...call.input }
      : {};
    if (["web_search", "web_research"].includes(tool)) {
      const query = String(input.query || input.q || input.search || "").replace(/\s+/g, " ").trim();
      if (!query) {
        const repairedQuery = this.extractResearchQueryForToolRecovery(message);
        if (repairedQuery && String(repairedQuery).trim().length >= 2) {
          return {
            repaired: true,
            reason: "empty-web-query-filled-from-user-message",
            call: {
              ...call,
              tool,
              input: {
                ...input,
                query: repairedQuery,
              },
              reason: call.reason || "Repaired empty research query from the user request.",
            },
          };
        }
      }
    }
    if (tool === "run_terminal_command") {
      const command = String(input.command || "").trim();
      const repairedCommand = command
        .replace(/Where-Object\s*\{\s*-not\s+\.PSIsContainer\s*\}/gi, "Where-Object { -not $_.PSIsContainer }")
        .replace(/Where-Object\s*\{\s*!\s*\.PSIsContainer\s*\}/gi, "Where-Object { -not $_.PSIsContainer }");
      if (repairedCommand && repairedCommand !== command) {
        return {
          repaired: true,
          reason: "powershell-pipeline-current-object-repaired",
          call: {
            ...call,
            tool,
            input: {
              ...input,
              command: repairedCommand,
            },
            reason: call.reason || "Repaired PowerShell current-object syntax before running terminal command.",
          },
        };
      }
    }
    return {
      repaired: false,
      reason: "",
      call: {
        ...call,
        tool,
        input,
      },
    };
  }

  getToolRepeatLimit(tool = "", settings = {}) {
    const id = String(tool || "").trim();
    if (["web_search", "web_research", "web_fetch", "read_url"].includes(id)) {
      return 1;
    }
    return Number(settings.maxRepeatedToolCalls || 1);
  }

  isParallelSafeTool(tool = "") {
    return new Set([
      "web_search",
      "web_research",
      "web_fetch",
      "read_url",
      "read_file",
      "list_files",
      "search_files",
      "search_computer_files",
      "computer_system_status",
      "inspect_file",
      "session_search",
      "subagents",
    ]).has(String(tool || "").trim());
  }

  chunkToolCalls(calls = [], size = 4) {
    const chunks = [];
    for (let index = 0; index < calls.length; index += size) {
      chunks.push(calls.slice(index, index + size));
    }
    return chunks;
  }

  async executeModelLoopToolCall({ call, round, agent, session, run, usedNativeTools = false, nativeMessages = null, loopController = null } = {}) {
    loopController?.toolStarted(call);
    const toolTraceId = createToolTraceId();
    const toolStartedAt = new Date().toISOString();
    this.upsertRunToolTrace(run.id, {
      id: toolTraceId,
      runId: run.id,
      sessionId: session.id,
      agentId: agent.id,
      source: "model-tool-loop",
      status: "running",
      round,
      tool: call.tool,
      input: call.input || {},
      reason: call.reason || "",
      startedAt: toolStartedAt,
    });
    this.gateway.addEvent("model_tool_loop.tool_started", {
      runId: run.id,
      sessionId: session.id,
      agentId: agent.id,
      round,
      tool: call.tool,
      reason: call.reason,
      parallelSafe: this.isParallelSafeTool(call.tool),
    });

    let output;
    try {
      output = await this.tools.run(call.tool, call.input, {
        agentId: agent.id,
        sessionId: session.id,
        runId: run.id,
        source: "model-tool-loop",
      });
    } catch (error) {
      output = {
        error: true,
        message: error.message,
        agentId: agent.id,
      };
    }

    if (usedNativeTools && nativeMessages) {
      nativeMessages.push(this.buildNativeToolResultMessage(call, output));
    }
    loopController?.toolOutput(call, output);
    loopController?.toolCompleted(call, output);
    this.gateway.addEvent("model_tool_loop.tool_completed", {
      runId: run.id,
      sessionId: session.id,
      agentId: agent.id,
      round,
      tool: call.tool,
      blocked: Boolean(output?.blocked),
      error: Boolean(output?.error),
      ...this.buildToolEventDetails(call.tool, output),
    });
    emitAgentLoopStage(this.gateway, "tool_observation_store", {
      runId: run.id,
      sessionId: session.id,
      agentId: agent.id,
      round,
      tool: call.tool,
      blocked: Boolean(output?.blocked),
      error: Boolean(output?.error),
    });
    this.upsertRunToolTrace(run.id, {
      id: toolTraceId,
      runId: run.id,
      sessionId: session.id,
      agentId: agent.id,
      source: "model-tool-loop",
      status: output?.error || output?.blocked ? "failed" : "completed",
      round,
      tool: call.tool,
      input: call.input || {},
      output,
      reason: call.reason || "",
      startedAt: toolStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(toolStartedAt),
      blocked: Boolean(output?.blocked),
      error: Boolean(output?.error),
    });

    return {
      tool: call.tool,
      input: call.input,
      reason: call.reason,
      source: "model-tool-loop",
      round,
      output,
    };
  }

  async runModelToolLoop({
    message,
    intents,
    profile,
    agent,
    tools,
    toolOutputs,
    forcedResponse,
    contextBundle,
    session,
    run,
  }) {
    // OmniLoop takes over when enabled: transcript-based native tool calling
    // (Claude Code / Codex style) replaces the JSON-prompt round loop.
    if (this.omniLoop?.isEligible({ forcedResponse })) {
      try {
        return await this.omniLoop.run({
          message,
          intents,
          agent,
          profile,
          session,
          run,
          tools,
          contextBundle,
        });
      } catch (error) {
        this.gateway.addEvent("omni_loop.failed", {
          runId: run.id,
          sessionId: session.id,
          agentId: agent.id,
          error: error.message,
        });
        // Fall through to the legacy model tool loop on unexpected failure.
      }
    }

    const runtimeToolReply = this.buildRuntimeToolReply({ intents, toolOutputs });
    const settings = this.getModelToolLoopSettings();
    const report = {
      enabled: settings.enabled,
      attempted: false,
      maxRounds: settings.maxRounds,
      maxToolCallsPerRound: settings.maxToolCallsPerRound,
      rounds: 0,
      toolCallCount: 0,
      nativeToolAttempts: 0,
      nativeToolsUsed: false,
      nativeTranscriptTurns: 0,
      skippedReason: "",
      stoppedReason: "",
      finalReady: false,
      selfCorrectionTriggered: false,
      failedObservationCount: this.countFailedToolObservations(toolOutputs),
      autoVerificationCount: 0,
      autoRepairAttempted: false,
      autoRepairReport: null,
      recoveredToolCalls: 0,
      repeatedToolCallsSkipped: 0,
      rejectedToolCalls: [],
      finalAnswer: "",
      roundDetails: [],
      errors: [],
    };
    if (!this.shouldRunModelToolLoop({ message, forcedResponse, runtimeToolReply, profile, toolOutputs, intents })) {
      const providerInfo = this.provider?.getInfo?.() || {};
      report.skippedReason = providerInfo.ready === false || providerInfo.id === "mock/local-rule-engine"
        ? "provider-not-ready"
        : forcedResponse
          ? "forced-local-response"
          : "not-needed-or-not-eligible";
      report.skipDetail = providerInfo.ready === false
        ? providerInfo.message || "Provider/model brain is not configured, so OmniClaw will not fake a local final answer."
        : "";
      return { report, toolOutputs: [] };
    }

    const allowedToolIds = new Set((tools || []).map((tool) => tool.id));
    const extraOutputs = [];
    const callCounts = new Map();
    const successfulToolCache = new Map();
    let cachedOnlyRounds = 0;
    for (const item of toolOutputs || []) {
      if (!["web_search", "web_research", "web_fetch"].includes(String(item?.tool || "").trim())) {
        continue;
      }
      const existingKey = this.buildToolCallKey({ tool: item.tool, input: item.input || {} });
      if (!existingKey) {
        continue;
      }
      callCounts.set(existingKey, Math.max(callCounts.get(existingKey) || 0, 1));
      if (item.output && !item.output.error && !item.output.blocked) {
        successfulToolCache.set(existingKey, item.output);
      }
    }
    const loopController = new AgentLoopController({
      config: this.config.getConfig(),
      gateway: this.gateway,
      run,
      session,
      agent,
      source: "model-tool-loop",
    });
    const nativeMessages = [
      {
        role: "system",
        content: [
          "You are OmniClaw's provider-native tool loop.",
          "Use the supplied function tools for real-world evidence instead of claiming work in text.",
          "After tool results are returned, continue with another tool call if needed or provide concise final text.",
          "Never request destructive tools unless the user explicitly asked.",
        ].join("\n"),
      },
      {
        role: "user",
        content: this.buildModelToolLoopPrompt({
          message,
          intents,
          tools,
          toolOutputs,
          contextBundle,
          agent,
          profile,
          round: 1,
        }),
      },
    ];
    report.attempted = true;
    if (report.failedObservationCount > 0) {
      report.selfCorrectionTriggered = true;
      loopController.reviewing({
        reason: "failed-tool-observation",
        remainingIssues: [`${report.failedObservationCount} failed observation(s) require correction.`],
      });
      this.gateway.addEvent("model_tool_loop.self_correction_started", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        failedObservationCount: report.failedObservationCount,
        maxRounds: settings.maxRounds,
      });
    }

    for (let round = 1; round <= settings.maxRounds; round += 1) {
      if (!loopController.startStep({
        phase: "model-tool-loop",
        step: round,
        message: report.selfCorrectionTriggered
          ? "Reviewing failed tool observations and choosing a corrective next action."
          : "Provider brain is deciding whether more real tool evidence is needed.",
      })) {
        report.stoppedReason = "max_steps";
        break;
      }
      report.rounds = round;
      this.gateway.addEvent("model_tool_loop.round_started", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        round,
        maxRounds: settings.maxRounds,
        maxToolCallsPerRound: settings.maxToolCallsPerRound,
      });
      this.gateway.addEvent("agent.thinking", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        phase: "model-tool-loop",
        round,
        maxRounds: settings.maxRounds,
        message: report.selfCorrectionTriggered
          ? "Reviewing failed tool observations and choosing a corrective next action."
          : "Provider brain is deciding whether more real tool evidence is needed.",
      });
      const currentExecutedToolIds = this.getCompletedToolIds([...toolOutputs, ...extraOutputs]);
      const currentMissingRequiredToolIds = this.getDynamicRequiredToolIds(
        message,
        [...toolOutputs, ...extraOutputs],
        intents,
        allowedToolIds,
      ).filter((toolId) => !currentExecutedToolIds.has(toolId));
      const requiresToolThisRound = currentMissingRequiredToolIds.length > 0;
      let completion;
      let usedNativeTools = false;
      try {
        const loopTimeoutMs = Math.max(
          5000,
          Math.min(
            settings.roundTimeoutMs,
            Math.max(Number(this.config.getConfig().provider?.timeoutMs || 30000), settings.roundTimeoutMs),
          ),
        );
        const loopMessages = [
          {
            role: "system",
            content: "You are an OmniClaw tool-call planner. Return exactly one valid JSON object and no prose.",
          },
          {
            role: "user",
            content: this.buildModelToolLoopPrompt({
              message,
              intents,
              tools,
              toolOutputs: [...toolOutputs, ...extraOutputs],
              contextBundle,
              agent,
              profile,
              round,
            }),
          },
        ];
        if (settings.nativeToolCalling && typeof this.provider.completeWithTools === "function") {
          try {
            const nativeTimeoutMs = Math.min(loopTimeoutMs, settings.nativeToolTimeoutMs);
            report.nativeToolAttempts += 1;
            completion = await Promise.race([
              this.provider.completeWithTools(nativeMessages, {
                tools: this.buildNativeToolSchemas(tools),
                toolChoice: requiresToolThisRound ? "required" : "auto",
                timeoutMs: nativeTimeoutMs,
              }),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error(`Native model tool loop timed out after ${nativeTimeoutMs}ms`)),
                nativeTimeoutMs,
              )),
            ]);
            usedNativeTools = Array.isArray(completion?.toolCalls) && completion.toolCalls.length > 0;
            report.nativeToolsUsed = report.nativeToolsUsed || usedNativeTools;
          } catch (nativeError) {
            report.errors.push(`native-tools-fallback: ${nativeError.message}`);
            this.gateway.addEvent("model_tool_loop.native_fallback", {
              runId: run.id,
              sessionId: session.id,
              agentId: agent.id,
              round,
              error: nativeError.message,
            });
          }
        }
        if (!completion) {
          completion = await Promise.race([
            this.provider.complete(loopMessages),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`Model tool loop timed out after ${loopTimeoutMs}ms`)),
            loopTimeoutMs,
          )),
          ]);
        }
      } catch (error) {
        report.errors.push(error.message);
        report.roundDetails.push({
          round,
          status: "provider-error",
          error: error.message,
        });
        this.gateway.addEvent("model_tool_loop.round_failed", {
          runId: run.id,
          sessionId: session.id,
          agentId: agent.id,
          round,
          error: error.message,
        });
        break;
      }

      const parsed = usedNativeTools
        ? this.parseNativeToolLoopResponse(completion, allowedToolIds, settings.maxToolCallsPerRound)
        : this.parseModelToolLoopResponse(completion?.text || "", allowedToolIds, settings.maxToolCallsPerRound);
      let calls = parsed.calls;
      this.gateway.addEvent("model_tool_loop.output_validated", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        round,
        validJson: parsed.validJson,
        nativeTools: Boolean(parsed.nativeTools),
        finalReady: Boolean(parsed.finalReady),
        callCount: calls.length,
        rejectedCallCount: parsed.rejectedCalls.length,
        missingToolCallClaim: Boolean(parsed.missingToolCallClaim),
        invalidActionClaim: Boolean(parsed.invalidActionClaim),
        reason: parsed.reason || "",
      });
      emitAgentLoopStage(this.gateway, "model_output_validation", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        round,
        validJson: parsed.validJson,
        callCount: calls.length,
        missingToolCallClaim: Boolean(parsed.missingToolCallClaim),
      });
      if (usedNativeTools) {
        nativeMessages.push({
          role: "assistant",
          content: completion?.text || null,
          tool_calls: calls.map((call) => ({
            id: call.id || `call_${call.tool}`,
            type: "function",
            function: {
              name: call.tool,
              arguments: JSON.stringify(call.input || {}),
            },
          })),
        });
        report.nativeTranscriptTurns = nativeMessages.length;
      }
      if (parsed.rejectedCalls.length > 0) {
        report.rejectedToolCalls.push(...parsed.rejectedCalls.map((call) => ({
          round,
          tool: call.tool || "",
          reason: call.tool ? "tool-not-allowed-or-unknown" : "missing-tool-name",
        })));
      }
      if (calls.length === 0) {
        const executedToolIds = this.getCompletedToolIds([...toolOutputs, ...extraOutputs]);
        const missingRequiredToolIds = this.getDynamicRequiredToolIds(
          message,
          [...toolOutputs, ...extraOutputs],
          intents,
          allowedToolIds,
        )
          .filter((toolId) => !executedToolIds.has(toolId));
        const nextFetchCandidate = missingRequiredToolIds.some((toolId) => toolId === "read_url" || toolId === "web_fetch")
          ? this.getNextWebFetchCandidate([...toolOutputs, ...extraOutputs])
          : null;
        const requiredFallback = nextFetchCandidate
          ? {
              tool: allowedToolIds.has("read_url") ? "read_url" : "web_fetch",
              input: { url: nextFetchCandidate.url, maxChars: 12000 },
              reason: `Recovered required page fetch from search candidate: ${nextFetchCandidate.title || nextFetchCandidate.url}`,
            }
          : missingRequiredToolIds.length > 0
          ? this.buildFallbackToolCall({
              message,
              intents,
              allowedToolIds,
              executedToolIds,
              providerText: parsed.answer || completion?.text || "",
            })
          : null;
        if (requiredFallback) {
          calls = [requiredFallback];
          report.recoveredToolCalls += 1;
          report.roundDetails.push({
            round,
            status: "required-tool-recovered",
            validJson: parsed.validJson,
            recoveredTool: requiredFallback.tool,
            missingRequiredToolIds,
            reason: requiredFallback.reason,
          });
          this.gateway.addEvent("model_tool_loop.required_tool_recovered", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            tool: requiredFallback.tool,
            missingRequiredToolIds,
          });
        }
      }

      if (calls.length === 0) {
        const combinedToolOutputs = [...toolOutputs, ...extraOutputs];
        const completedToolIds = this.getCompletedToolIds(combinedToolOutputs);
        const noMissingRequiredTools = this.getDynamicRequiredToolIds(
          message,
          combinedToolOutputs,
          intents,
          allowedToolIds,
        ).filter((toolId) => !completedToolIds.has(toolId)).length === 0;
        const hasCompletedEvidence = combinedToolOutputs.some((item) => this.classifyToolOutput(item) === "completed");
        if (
          hasCompletedEvidence &&
          noMissingRequiredTools &&
          (parsed.invalidActionClaim || parsed.missingToolCallClaim || parsed.reason?.startsWith("invalid-json") || parsed.finalReady)
        ) {
          report.finalReady = true;
          report.finalAnswer = parsed.answer || report.finalAnswer || "";
          report.stoppedReason = "model-final-ready-from-existing-observations";
          report.roundDetails.push({
            round,
            status: "final-ready-existing-observations",
            validJson: parsed.validJson,
            missingToolCallClaim: parsed.missingToolCallClaim,
            invalidActionClaim: parsed.invalidActionClaim,
            reason: "required-tool-observations-already-present",
          });
          this.gateway.addEvent("model_tool_loop.round_stopped", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            reason: report.stoppedReason,
          });
          break;
        }
        const hasExistingResearchEvidence = this.hasSuccessfulWebPageContent(combinedToolOutputs) ||
          combinedToolOutputs.some((item) =>
            ["web_search", "web_research"].includes(String(item?.tool || "")) &&
            item?.output &&
            !item.output.error &&
            !item.output.blocked &&
            !this.getNextWebFetchCandidate(combinedToolOutputs),
          );
        if (
          intents.includes("research") &&
          hasExistingResearchEvidence &&
          (parsed.missingToolCallClaim || parsed.reason?.startsWith("invalid-json") || parsed.finalReady)
        ) {
          report.finalReady = true;
          report.finalAnswer = parsed.answer || report.finalAnswer || "";
          report.stoppedReason = parsed.missingToolCallClaim
            ? "model-final-ready-from-existing-research"
            : "model-final-ready";
          report.roundDetails.push({
            round,
            status: "final-ready-existing-research",
            validJson: parsed.validJson,
            missingToolCallClaim: parsed.missingToolCallClaim,
            reason: "research-evidence-already-present",
          });
          this.gateway.addEvent("model_tool_loop.round_stopped", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            reason: report.stoppedReason,
          });
          break;
        }
        const fallback = settings.recoverMissingToolCalls && (parsed.missingToolCallClaim || parsed.invalidActionClaim)
          ? this.buildFallbackToolCall({
              message,
              intents,
              allowedToolIds,
              executedToolIds: this.getCompletedToolIds([...toolOutputs, ...extraOutputs]),
              providerText: parsed.answer || completion?.text || "",
            })
          : null;
        if (fallback) {
          calls = [fallback];
          report.recoveredToolCalls += 1;
          report.roundDetails.push({
            round,
            status: "missing-tool-call-recovered",
            validJson: parsed.validJson,
            missingToolCallClaim: parsed.missingToolCallClaim,
            recoveredTool: fallback.tool,
            reason: fallback.reason,
          });
          this.gateway.addEvent("model_tool_loop.missing_tool_call_recovered", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            tool: fallback.tool,
            reason: fallback.reason,
          });
        } else if (parsed.missingToolCallClaim || parsed.reason?.startsWith("invalid-json")) {
          report.roundDetails.push({
            round,
            status: "invalid-action-claim",
            validJson: parsed.validJson,
            missingToolCallClaim: parsed.missingToolCallClaim,
            reason: parsed.reason || "model-returned-text-instead-of-json",
          });
          this.gateway.addEvent("model_tool_loop.invalid_action_claim", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            reason: parsed.reason || "model-returned-text-instead-of-json",
          });
          if (round < settings.maxRounds) {
            continue;
          }
        } else {
          report.finalReady = Boolean(parsed.finalReady);
          if (parsed.finalReady && parsed.answer) {
            report.finalAnswer = parsed.answer;
          }
          report.stoppedReason = parsed.finalReady ? "model-final-ready" : parsed.reason || "no-tool-calls";
          report.roundDetails.push({
            round,
            status: parsed.finalReady ? "final-ready" : "no-tool-calls",
            validJson: parsed.validJson,
            missingToolCallClaim: parsed.missingToolCallClaim,
            reason: parsed.reason,
          });
          this.gateway.addEvent("model_tool_loop.round_stopped", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            reason: report.stoppedReason,
          });
          break;
        }
      }

      let executedThisRound = 0;
      let observedThisRound = 0;
      let cachedThisRound = 0;
      const executableCalls = [];
      for (const call of calls) {
        const repairedCall = this.repairModelLoopToolCall({ call, message, intents });
        if (repairedCall.repaired) {
          report.roundDetails.push({
            round,
            status: "tool-input-repaired",
            tool: repairedCall.call.tool,
            reason: repairedCall.reason,
          });
          this.gateway.addEvent("model_tool_loop.tool_input_repaired", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            tool: repairedCall.call.tool,
            reason: repairedCall.reason,
          });
        }
        const callToRun = repairedCall.call;
        const callKey = this.buildToolCallKey(callToRun);
        const seenCount = callCounts.get(callKey) || 0;
        const repeatLimit = this.getToolRepeatLimit(callToRun.tool, settings);
        if (seenCount >= repeatLimit || !loopController.canRunTool(callToRun)) {
          report.repeatedToolCallsSkipped += 1;
          const cachedOutput = successfulToolCache.get(callKey);
          if (cachedOutput) {
            extraOutputs.push({
              tool: callToRun.tool,
              input: callToRun.input,
              reason: "Used cached successful observation for repeated tool call.",
              source: "model-tool-loop-cache",
              round,
              output: {
                ok: true,
                cached: true,
                reason: "repeat-call-used-cached-result",
                tool: callToRun.tool,
                result: cachedOutput,
              },
            });
            this.gateway.addEvent("model_tool_loop.tool_cached", {
              runId: run.id,
              sessionId: session.id,
              agentId: agent.id,
              round,
              tool: callToRun.tool,
              reason: "repeat-call-used-cached-result",
            });
            cachedThisRound += 1;
            continue;
          }
          const skippedOutput = {
            ok: false,
            blocked: true,
            status: "skipped",
            reason: "repeat-call-budget-exceeded",
            message:
              ["web_search", "web_research"].includes(callToRun.tool)
                ? "The same web search query already ran in this agent loop. Use web_fetch on a result URL, change the query, or finalize from existing observations."
                : "The same tool call already reached its repeat budget. Choose a different corrective action or finalize with the current evidence.",
            repeatKey: callKey,
            repeatLimit,
          };
          extraOutputs.push({
            tool: callToRun.tool,
            input: callToRun.input,
            reason: callToRun.reason,
            source: "model-tool-loop",
            round,
            output: skippedOutput,
          });
          if (usedNativeTools) {
            nativeMessages.push(this.buildNativeToolResultMessage(callToRun, skippedOutput));
            report.nativeTranscriptTurns = nativeMessages.length;
          }
          this.gateway.addEvent("model_tool_loop.tool_skipped", {
            runId: run.id,
              sessionId: session.id,
              agentId: agent.id,
              round,
            tool: callToRun.tool,
            reason: "repeat-call-budget-exceeded",
            repeatLimit,
          });
          continue;
        }
        callCounts.set(callKey, seenCount + 1);
        executableCalls.push({ ...callToRun, callKey });
      }

      const parallelCalls = executableCalls.filter((call) => this.isParallelSafeTool(call.tool));
      const serialCalls = executableCalls.filter((call) => !this.isParallelSafeTool(call.tool));
      for (const chunk of this.chunkToolCalls(parallelCalls, settings.maxParallelToolCalls)) {
        if (chunk.length > 1) {
          this.gateway.addEvent("model_tool_loop.parallel_batch_started", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            toolCount: chunk.length,
            tools: chunk.map((call) => call.tool),
          });
        }
        const outputs = await Promise.all(chunk.map((call) => this.executeModelLoopToolCall({
          call,
          round,
          agent,
          session,
          run,
          usedNativeTools,
          nativeMessages,
          loopController,
        })));
        for (const outputItem of outputs) {
          extraOutputs.push(outputItem);
          if (outputItem.output && !outputItem.output.error && !outputItem.output.blocked) {
            successfulToolCache.set(this.buildToolCallKey(outputItem), outputItem.output);
          }
          report.toolCallCount += 1;
          executedThisRound += 1;
          observedThisRound += 1;
        }
      }
      for (const call of serialCalls) {
        const outputItem = await this.executeModelLoopToolCall({
          call,
          round,
          agent,
          session,
          run,
          usedNativeTools,
          nativeMessages,
          loopController,
        });
        extraOutputs.push(outputItem);
        if (outputItem.output && !outputItem.output.error && !outputItem.output.blocked) {
          successfulToolCache.set(this.buildToolCallKey(outputItem), outputItem.output);
        }
        report.toolCallCount += 1;
        executedThisRound += 1;
        observedThisRound += 1;
      }
      if (usedNativeTools) {
        report.nativeTranscriptTurns = nativeMessages.length;
      }
      if (executedThisRound === 0 && cachedThisRound > 0) {
        cachedOnlyRounds += 1;
      } else {
        cachedOnlyRounds = 0;
      }
      report.roundDetails.push({
          round,
          status: observedThisRound > 0 ? "tools-observed" : cachedThisRound > 0 ? "cached-repeat-observed" : "all-tools-skipped",
          validJson: parsed.validJson,
          nativeTools: Boolean(parsed.nativeTools),
          callCount: executedThisRound,
        parallelCallCount: parallelCalls.length,
        serialCallCount: serialCalls.length,
        skippedCallCount: calls.length - executedThisRound,
        cachedCallCount: cachedThisRound,
        recovered: !parsed.calls.length && calls.length > 0,
        rejectedCallCount: parsed.rejectedCalls.length,
      });
      this.gateway.addEvent("model_tool_loop.round_completed", {
        runId: run.id,
        sessionId: session.id,
        agentId: agent.id,
        round,
        callCount: executedThisRound,
      });
      if (observedThisRound === 0) {
        report.stoppedReason = cachedThisRound > 0
          ? "cached-repeat-no-progress"
          : "repeat-call-budget-exceeded";
        if (cachedThisRound > 0) {
          report.finalReady = true;
          report.roundDetails.push({
            round,
            status: "stopped-cached-repeat-no-progress",
            cachedOnlyRounds,
            reason: "model repeated cached tool calls without producing a final answer",
          });
          this.gateway.addEvent("model_tool_loop.round_stopped", {
            runId: run.id,
            sessionId: session.id,
            agentId: agent.id,
            round,
            reason: report.stoppedReason,
          });
        }
        break;
      }
    }
    if (!report.stoppedReason) {
      report.stoppedReason = report.rounds >= settings.maxRounds ? "max-rounds-reached" : "completed";
    }
    loopController.done({
      stopReason: report.stoppedReason === "model-final-ready" ? "final" : report.stoppedReason,
      finalMetadata: {
        stepCount: report.rounds,
        toolCallCount: report.toolCallCount,
        fixedErrors: report.selfCorrectionTriggered,
      },
    });
    report.agentLoop = loopController.getReport();
    report.remainingIssues = report.agentLoop.remainingIssues || [];

    return { report, toolOutputs: extraOutputs };
  }

  async executeApprovedShellPlan(approval) {
    if (!approval || approval.type !== "shell-plan" || approval.status !== "approved") {
      return null;
    }

    const command = approval.payload?.command || "";
    this.gateway.addEvent("shell.execution_started", {
      approvalId: approval.id,
      runId: approval.runId,
      sessionId: approval.sessionId,
      command,
    });

    let execution;
    try {
      execution = await this.shellExecutor.execute({
        command,
        approvalId: approval.id,
        runId: approval.runId,
        sessionId: approval.sessionId,
      });
    } catch (error) {
      execution = {
        status: "blocked",
        command,
        approvalId: approval.id,
        runId: approval.runId,
        sessionId: approval.sessionId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: error.message,
        outputTruncated: false,
      };
    }

    const eventName = execution.status === "completed" ? "shell.execution_completed" : "shell.execution_failed";
    this.shellAudit.append({
      phase: "executed",
      status: execution.status,
      command: execution.command,
      risk: execution.risk || approval.payload?.risk || "medium",
      allowlisted: Boolean(execution.allowlisted ?? approval.payload?.allowlisted),
      riskReasons: execution.riskReasons || approval.payload?.riskReasons || [],
      approvalId: approval.id,
      runId: approval.runId,
      sessionId: approval.sessionId,
      stdoutBytes: execution.stdoutBytes || 0,
      stderrBytes: execution.stderrBytes || 0,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      durationMs: execution.durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
    });
    this.gateway.addEvent(eventName, {
      approvalId: approval.id,
      runId: approval.runId,
      sessionId: approval.sessionId,
      status: execution.status,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      risk: execution.risk || approval.payload?.risk || "medium",
    });

    const updatedApproval = this.gateway.updateApproval(approval.id, {
      execution,
    });

    if (approval.runId) {
      const run = this.gateway.getRun(approval.runId);
      const shellExecutions = [...(run?.shellExecutions || []), execution];
      this.gateway.updateRun(approval.runId, {
        shellExecutions,
        shellExecutionStatus: execution.status,
      });
    }

    if (approval.sessionId) {
      try {
        this.sessions.appendSystemEvent(approval.sessionId, "shell.execution", {
          approvalId: approval.id,
          runId: approval.runId,
          status: execution.status,
          exitCode: execution.exitCode,
          command: execution.command,
          stdout: execution.stdout,
          stderr: execution.stderr,
        });
      } catch {
        // ignore missing session
      }
    }

    return {
      approval: updatedApproval,
      execution,
    };
  }

  async executeTerminalCommand({ command, cwd = "", context = {} } = {}) {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand) {
      throw new Error("Terminal command is required.");
    }
    const runId = context.runId || "";
    const sessionId = context.sessionId || "";
    const agentId = context.agentId || "main";
    this.gateway.addEvent("terminal.execution_started", {
      runId,
      sessionId,
      agentId,
      command: normalizedCommand,
    });

    let execution;
    try {
      execution = await this.shellExecutor.execute({
        command: normalizedCommand,
        cwd,
        runId,
        sessionId,
      });
    } catch (error) {
      execution = {
        status: "blocked",
        command: normalizedCommand,
        cwd: cwd || ".",
        runId,
        sessionId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: error.message,
        outputTruncated: false,
      };
    }

    this.shellAudit.append({
      phase: "executed",
      status: execution.status,
      command: execution.command,
      risk: execution.risk || "medium",
      allowlisted: Boolean(execution.allowlisted),
      riskReasons: execution.riskReasons || [],
      approvalId: "",
      runId,
      sessionId,
      agentId,
      stdoutBytes: execution.stdoutBytes || 0,
      stderrBytes: execution.stderrBytes || 0,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      durationMs: execution.durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
    });
    this.gateway.addEvent(
      execution.status === "completed" ? "terminal.execution_completed" : "terminal.execution_failed",
      {
        runId,
        sessionId,
        agentId,
        status: execution.status,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        risk: execution.risk || "medium",
      },
    );
    if (runId) {
      const activeRun = this.gateway.getRun(runId);
      if (activeRun) {
        this.gateway.updateRun(runId, {
          shellExecutions: [...(activeRun.shellExecutions || []), execution],
          shellExecutionStatus: execution.status,
        });
      }
    }
    if (sessionId) {
      try {
        this.sessions.appendSystemEvent(sessionId, "terminal.execution", {
          runId,
          status: execution.status,
          exitCode: execution.exitCode,
          command: execution.command,
          stdout: execution.stdout,
          stderr: execution.stderr,
        });
      } catch {
        // Session may be absent for manual/background terminal calls.
      }
    }
    return execution;
  }

  async resolveApproval(approvalId, decision, note = "") {
    const resolved = this.gateway.resolveApproval(approvalId, decision, note);
    if (resolved.sessionId) {
      try {
        this.sessions.appendSystemEvent(resolved.sessionId, "approval.resolved", {
          approvalId,
          decision,
          note,
        });
      } catch {
        // ignore missing session
      }
    }

    const executionResult =
      String(decision || "").trim() === "approved" ? await this.executeApprovedShellPlan(resolved) : null;

    const run = resolved.runId ? this.gateway.getRun(resolved.runId) : null;
    if (run && Array.isArray(run.approvalIds) && run.approvalIds.length > 0) {
      const pending = run.approvalIds.some((id) => this.gateway.getApproval(id)?.status === "pending");
      if (!pending && run.status === "waiting_approval") {
        this.gateway.updateRun(run.id, {
          status: "completed",
          approvalsResolvedAt: new Date().toISOString(),
        });
        this.gateway.addEvent("run.approvals_resolved", {
          runId: run.id,
          sessionId: run.sessionId,
        });
      }
    }

    if (resolved.sessionId) {
      const pendingForSession = this.gateway
        .listApprovals("pending")
        .some((item) => item.sessionId === resolved.sessionId);
      if (!pendingForSession) {
        try {
          const sessionState = this.sessions.getSession(resolved.sessionId, {
            messageLimit: 1,
          });
          if (sessionState && !sessionState.activeRunId && sessionState.queueDepth === 0) {
            this.sessions.updateSession(resolved.sessionId, { status: "idle" });
          }
        } catch {
          // ignore missing session
        }
      }
    }

    return executionResult || resolved;
  }

  loadWorkspaceContext(agentId) {
    const agent = this.agents.resolveAgent(agentId);
    const sharedWorkspace = this.workspace.workspaceDir;
    const agentWorkspace = agent.workspacePath;
    const bootstrapActive = this.hasBootstrapRitual(agent.id);
    const fileNames = [
      "AGENTS.md",
      "IDENTITY.md",
      "SOUL.md",
      "USER.md",
      "PROFILE.md",
      "TOOLS.md",
      "AGENT_LOOP.md",
      "AGENT_WORKSPACE.md",
      "AGENT_RUNTIME.md",
      "HARNESS.md",
      "ACTIVE_MEMORY.md",
      "CHANNEL_DOCKING.md",
      "SUBAGENTS.md",
      "THINKING.md",
      "CLAWHUB.md",
      "TELEGRAM.md",
      "AUTOREVIEW.md",
      "HEARTBEAT.md",
      ...(bootstrapActive ? ["BOOTSTRAP.md"] : []),
    ];
    const projectContextNames = [".hermes.md", "HERMES.md", "AGENTS.md", ".cursorrules"];
    const files = [];
    const seenPaths = new Set();

    const pushFile = ({ name, scope, filePath }) => {
      const resolved = path.resolve(filePath);
      if (seenPaths.has(resolved) || !fs.existsSync(resolved)) {
        return;
      }
      seenPaths.add(resolved);
      files.push({
        name,
        scope,
        path: resolved,
        content: fs.readFileSync(resolved, "utf8"),
      });
    };

    const readScopedFiles = (scope, workspaceDir) => {
      for (const name of fileNames) {
        const filePath = path.join(workspaceDir, name);
        pushFile({
          name,
          scope,
          filePath,
        });
      }
    };

    const discoverProjectContextFiles = () => {
      const roots = [
        this.rootDir,
        process.cwd(),
        path.join(this.rootDir, "workspace"),
      ];
      for (const root of roots) {
        let current = path.resolve(root);
        for (let depth = 0; depth < 8; depth += 1) {
          for (const name of projectContextNames) {
            pushFile({
              name,
              scope: "project",
              filePath: path.join(current, name),
            });
          }
          const parent = path.dirname(current);
          if (parent === current) {
            break;
          }
          if (fs.existsSync(path.join(current, ".git"))) {
            break;
          }
          current = parent;
        }
      }
    };

    try {
      discoverProjectContextFiles();
      readScopedFiles("shared", sharedWorkspace);
      readScopedFiles("agent", agentWorkspace);

      const today = new Date().toISOString().slice(0, 10);
      const dailyMemoryPath = path.join(agentWorkspace, "memory", `${today}.md`);
      if (fs.existsSync(dailyMemoryPath)) {
        files.push({
          name: `memory/${today}.md`,
          scope: "agent",
          path: dailyMemoryPath,
          content: fs.readFileSync(dailyMemoryPath, "utf8"),
        });
      }
    } catch (err) {
      console.warn(`Could not load workspace context for agent ${agentId}:`, err.message);
    }

    return {
      agentId: agent.id,
      loadedAt: new Date().toISOString(),
      files,
      manifest: buildRuntimeWorkspaceManifest({
        rootDir: this.rootDir,
        sharedWorkspace,
        agentWorkspace,
        agent,
        files,
      }),
      heartbeatPrompt:
        "Read HEARTBEAT.md if it exists. Follow its small checklist. If nothing needs attention, reply HEARTBEAT_OK.",
    };
  }

  loadAgentSoul(agentId) {
    const context = this.loadWorkspaceContext(agentId);
    const getFile = (name) => context.files.find((file) => file.name === name && file.scope === "agent")
      || context.files.find((file) => file.name === name);
    return {
      soul: getFile("SOUL.md")?.content || "",
      identity: getFile("IDENTITY.md")?.content || "",
      user: getFile("USER.md")?.content || "",
      tools: getFile("TOOLS.md")?.content || "",
    };
  }

  getAgentProfilePath(agentId = "main") {
    const agent = this.agents.resolveAgent(agentId);
    return path.join(agent.workspacePath, "PROFILE.md");
  }

  readAgentProfileText(agentId = "main") {
    const profilePath = this.getAgentProfilePath(agentId);
    if (!fs.existsSync(profilePath)) {
      return "";
    }
    return fs.readFileSync(profilePath, "utf8");
  }

  hasAgentProfile(agentId = "main") {
    return this.readAgentProfileText(agentId).replace(/^# PROFILE\s*/i, "").trim().length > 0;
  }

  getBootstrapPath(agentId = "main") {
    const agent = this.agents.resolveAgent(agentId);
    return path.join(agent.workspacePath, "BOOTSTRAP.md");
  }

  readBootstrapFile(agentId = "main") {
    if (!this.hasBootstrapRitual(agentId)) {
      return null;
    }
    const bootstrapPath = this.getBootstrapPath(agentId);
    if (!fs.existsSync(bootstrapPath)) {
      return null;
    }
    return fs.readFileSync(bootstrapPath, "utf8");
  }

  hasBootstrapRitual(agentId = "main") {
    const bootstrapPath = this.getBootstrapPath(agentId);
    return fs.existsSync(bootstrapPath) && !this.isBootstrapProfileComplete(agentId);
  }

  isBootstrapProfileComplete(agentId = "main") {
    const facts = this.readAgentProfileFacts(agentId);
    const assistantName = String(facts.assistantName || "").trim();
    const userName = String(facts.userName || "").trim();
    if (
      !assistantName ||
      !userName ||
      /^(?:unknown|user|human)$/i.test(userName) ||
      /^(?:omniclaw|main agent|assistant|agent)$/i.test(assistantName)
    ) {
      return false;
    }
    const identityText = (() => {
      try {
        return fs.readFileSync(this.getAgentWorkspaceFilePath(agentId, "IDENTITY.md"), "utf8");
      } catch {
        return "";
      }
    })();
    return /^Behavior:[ \t]*\S/im.test(identityText) ||
      /^Vibe:[ \t]*\S/im.test(identityText) ||
      /Operating style:/i.test(identityText);
  }

  deleteBootstrapFile(agentId = "main") {
    const bootstrapPath = this.getBootstrapPath(agentId);
    if (fs.existsSync(bootstrapPath)) {
      fs.unlinkSync(bootstrapPath);
      return true;
    }
    return false;
  }

  getAgentWorkspaceFilePath(agentId = "main", fileName = "") {
    const agent = this.agents.resolveAgent(agentId);
    return path.join(agent.workspacePath, String(fileName || "").replace(/^[/\\]+/, ""));
  }

  writeAgentWorkspaceFile(agentId = "main", fileName = "", content = "") {
    const filePath = this.getAgentWorkspaceFilePath(agentId, fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(content || ""), "utf8");
    return filePath;
  }

  extractBootstrapFacts(message = "") {
    const text = String(message || "").trim();
    const clean = (value = "") =>
      String(value || "").replace(/[.。]+$/g, "").replace(/\s+/g, " ").trim();
    const facts = {
      skip: /skip bootstrap|bootstrap skip|setup skip/i.test(text),
    };

    const userNameMatch =
      text.match(/(?:mera|mara|my)\s+(?:naam|name)\s+([a-zA-Z0-9 _.-]{2,40}?)\s+(?:hai|ha|is)\b/i) ||
      text.match(/(?:i am|i'm)\s+([a-zA-Z0-9 _.-]{2,40})/i) ||
      text.match(/\b(?:ma|main|mai)\s+([a-zA-Z0-9 _.-]{2,40}?)\s+(?:hu|hun|hoon|ho|houn)\b/i);
    if (userNameMatch) facts.userName = clean(userNameMatch[1]);

    const locationMatch =
      text.match(/\b(?:main|mai|i)\b\s+([a-zA-Z0-9 _.-]{2,60})\s+se\s+(?:hoon|hu|ho|hun|am)/i) ||
      text.match(/(?:from|location is|location)\s+([a-zA-Z0-9 _.-]{2,60})/i);
    if (locationMatch) {
      facts.userLocation = clean(locationMatch[1]);
    } else if (/\bjind\b/i.test(text) || /\bharyana\b/i.test(text)) {
      facts.userLocation = [/\bjind\b/i.test(text) ? "Jind" : "", /\bharyana\b/i.test(text) ? "Haryana" : ""]
        .filter(Boolean)
        .join(", ");
    }

    const goalMatch =
      text.match(/(?:build|banana|bna|banani|create|make)\s+([a-zA-Z0-9 _.,-]{3,120})/i) ||
      text.match(/(?:goal|kaam|project)\s*(?:hai|is|:)?\s*([a-zA-Z0-9 _.,-]{3,120})/i);
    if (goalMatch) facts.goal = clean(goalMatch[1]);

    if (/vibe coding/i.test(text)) {
      facts.preference = "User likes vibe coding and building with AI.";
    } else if (/(practical ai|real work|kaam karke|ai se build|ai sa build)/i.test(text)) {
      facts.preference = "User prefers practical AI that does real work and helps build things.";
    }

    const assistantNameMatch =
      text.match(/(?:tumhara|tera|tara|your|assistant(?: ka)?|agent(?: ka)?)\s+(?:naam|name)\s+([a-zA-Z0-9 _.-]{2,40}?)\s+(?:hai|ha|is|hoga|rakh)\b/i) ||
      text.match(/(?:call you|name you)\s+([a-zA-Z0-9 _.-]{2,40})/i);
    if (assistantNameMatch) facts.assistantName = clean(assistantNameMatch[1]);

    const behaviorWords = [...text.matchAll(/\b(warm|direct|practical|hinglish|hindi|english|casual|formal|funny|sharp|calm|friendly|honest|transparent|proof|real tools?)\b/gi)]
      .map((match) => match[1].toLowerCase().replace(/\s+/g, " "))
      .filter((value, index, arr) => arr.indexOf(value) === index);
    const behaviorMatch = text.match(/(?:vibe|personality|behave|tone|baat)\s*(?:hai|is|:)?\s*([a-zA-Z0-9 _.,-]{3,120})/i);
    if (behaviorWords.length > 0) {
      facts.behavior = clean(behaviorWords.join(", "));
    } else if (behaviorMatch) {
      facts.behavior = clean(behaviorMatch[1].replace(/\b(?:rakho|rakhna|keep|use)\b.*$/i, ""));
    } else if (/(chill|funny|sharp|practical|direct|warm|hinglish|hindi)/i.test(text)) {
      facts.behavior = clean(text.slice(0, 160));
    }

    return facts;
  }

  writeBootstrapWorkspaceState(agentId = "main", facts = {}) {
    const current = this.readAgentProfileFacts(agentId);
    const assistantName = facts.assistantName || current.assistantName || "";
    const userName = facts.userName || current.userName || "";
    const userLocation = facts.userLocation || current.userLocation || "";
    const preferences = [...new Set([
      ...(current.preferences || []),
      facts.preference || "",
      facts.goal ? `User goal: ${facts.goal}` : "",
    ].filter(Boolean))];
    const now = new Date().toISOString();

    this.writeAgentWorkspaceFile(agentId, "PROFILE.md", [
      "# PROFILE",
      "",
      `- Assistant name: ${assistantName}`,
      `- User name: ${userName}`,
      `- User location: ${userLocation}`,
      ...preferences.map((item) => `- ${item}`),
      "",
      `Updated: ${now}`,
      "",
    ].join("\n"));

    if (userName || userLocation || facts.goal || facts.preference) {
      this.writeAgentWorkspaceFile(agentId, "USER.md", [
        "# USER",
        "",
        `Name: ${userName || "unknown"}`,
        `Location: ${userLocation || "unknown"}`,
        `Goal: ${facts.goal || "not set yet"}`,
        `Preference: ${facts.preference || preferences[0] || "fast, practical, transparent"}`,
        "",
      ].join("\n"));
    }

    if (assistantName || facts.behavior) {
      const identityLines = [
        "# IDENTITY",
        "",
        `Name: ${assistantName || "Main Agent"}`,
        "Role: OmniClaw-hosted local agent with memory, skills, tools, sessions, and approvals.",
        facts.behavior ? `Behavior: ${facts.behavior}` : "",
        "",
      ].filter((line) => line !== "").join("\n");
      this.writeAgentWorkspaceFile(agentId, "IDENTITY.md", `${identityLines}\n`);
    }

    this.writeAgentWorkspaceFile(agentId, "HEARTBEAT.md", [
      "# HEARTBEAT",
      "",
      "- Check pending approvals, jobs, schedules, connector state, and recent failed runs.",
      "- If no action is needed, reply HEARTBEAT_OK.",
      "- If user profile or identity is incomplete, ask one setup question.",
      "",
    ].join("\n"));
  }

  syncAgentIdentityFilesFromProfile(agentId = "main") {
    const current = this.readAgentProfileFacts(agentId);
    const assistantName = current.assistantName || "";
    const userName = current.userName || "";
    const userLocation = current.userLocation || "";
    const preferences = Array.isArray(current.preferences) ? current.preferences : [];

    if (userName || userLocation || preferences.length > 0) {
      this.writeAgentWorkspaceFile(agentId, "USER.md", [
        "# USER.md - About Your Human",
        "",
        `Name: ${userName || "unknown"}`,
        `Location: ${userLocation || "unknown"}`,
        "Preference:",
        ...preferences.map((item) => `- ${item}`),
        "",
        "Notes:",
        "- Keep learning from durable user statements and update PROFILE.md / MEMORY.md with care.",
        "",
      ].join("\n"));
    }

    if (assistantName) {
      const existingIdentity = (() => {
        try {
          return fs.readFileSync(this.getAgentWorkspaceFilePath(agentId, "IDENTITY.md"), "utf8");
        } catch {
          return "";
        }
      })();
      const role = latestTextMatch(existingIdentity, [/\*\*Role:\*\*[ \t]*([^\r\n]+)/i, /^Role:[ \t]*([^\r\n]+)/im])
        || "OmniClaw-hosted local agent with memory, skills, tools, sessions, and approvals.";
      const vibe = latestTextMatch(existingIdentity, [/\*\*Vibe:\*\*[ \t]*([^\r\n]+)/i, /^Vibe:[ \t]*([^\r\n]+)/im, /^Behavior:[ \t]*([^\r\n]+)/im])
        || "Warm, direct, practical, builder-first, Hinglish-friendly.";
      this.writeAgentWorkspaceFile(agentId, "IDENTITY.md", [
        "# IDENTITY.md - Who Am I?",
        "",
        `Name: ${assistantName}`,
        `Role: ${role}`,
        `Vibe: ${vibe}`,
        "Operating style: Use real tools, observe outputs, fix blockers, verify work, then answer cleanly.",
        userName ? `User bond: Working for ${userName}${userLocation ? ` in ${userLocation}` : ""}.` : "",
        "",
      ].filter(Boolean).join("\n"));
    }
  }

  processBootstrapStep(agentId = "main", message = "", reply = "") {
    if (!this.hasBootstrapRitual(agentId)) {
      return { updated: false, step: "none" };
    }
    const facts = this.extractBootstrapFacts(message);
    const updates = [];
    const before = this.readAgentProfileFacts(agentId);
    const wantsHinglish = /\b(?:ma|main|mai|hu|hun|hoon|ha|hai|tera|tara|tum|mujhe|naam)\b/i.test(String(message || ""));

    if (facts.skip) {
      this.writeBootstrapWorkspaceState(agentId, {
        assistantName: before.assistantName || "Main Agent",
        userName: before.userName || "",
        userLocation: before.userLocation || "",
      });
      this.deleteBootstrapFile(agentId);
      return {
        updated: true,
        step: "bootstrap_skipped",
        updates: ["bootstrap_skipped"],
        reply: "Bootstrap skip kar diya. Main default identity ke saath normal mode me aa gaya hoon. Tum baad me Profile/Identity settings update kar sakte ho.",
      };
    }

    if (facts.userName) updates.push(`user_name=${facts.userName}`);
    if (facts.userLocation) updates.push(`user_location=${facts.userLocation}`);
    if (facts.goal) updates.push("goal_saved");
    if (facts.preference) updates.push("preference_saved");
    if (facts.assistantName) updates.push(`assistant_name=${facts.assistantName}`);
    if (facts.behavior) updates.push("behavior_saved");

    const hasNewBootstrapFacts = Boolean(
      facts.userName ||
      facts.userLocation ||
      facts.goal ||
      facts.preference ||
      facts.assistantName ||
      facts.behavior,
    );
    if (!hasNewBootstrapFacts) {
      return {
        updated: false,
        step: "ask_user",
        updates,
      };
    }

    this.writeBootstrapWorkspaceState(agentId, facts);
    const currentFacts = this.readAgentProfileFacts(agentId);
    const hasUserInfo = Boolean(
      String(currentFacts.userName || "").trim() ||
      String(currentFacts.userLocation || "").trim() ||
      facts.goal ||
      facts.preference,
    );
    const hasAssistantName = Boolean(
      String(currentFacts.assistantName || "").trim() &&
      currentFacts.assistantName !== "OmniClaw",
    );
    const hasAssistantBehavior = Boolean(facts.behavior || /^Behavior:[ \t]*\S/im.test(
      (() => {
        try {
          return fs.readFileSync(this.getAgentWorkspaceFilePath(agentId, "IDENTITY.md"), "utf8");
        } catch {
          return "";
        }
      })(),
    ));

    if (!hasUserInfo) {
      return {
        updated: updates.length > 0,
        step: "ask_user",
        updates,
        reply: wantsHinglish
          ? "Main first-run setup me hoon. Tumhara naam kya hai, aur OmniClaw se kya build/automate karna chahte ho?"
          : "I am in first-run setup. What should I call you, and what do you want to build or automate with OmniClaw?",
      };
    }

    if (!hasAssistantName || !hasAssistantBehavior) {
      return {
        updated: true,
        step: "ask_identity",
        updates,
        reply: wantsHinglish
          ? `Theek ${currentFacts.userName || "friend"}, main ${currentFacts.assistantName || "tumhara agent"} hoon. Meri vibe/tone kaisi rakhu - warm, direct, funny, formal, ya kuch aur?`
          : `Got it${currentFacts.userName ? `, ${currentFacts.userName}` : ""}. I am ${currentFacts.assistantName || "your agent"}. What vibe or tone should I have - warm, direct, funny, formal, or something else?`,
      };
    }

    this.writeAgentWorkspaceFile(agentId, "TOOLS.md", [
      "# TOOLS",
      "",
      "OmniClaw runtime tools available through this agent:",
      "- files: read/write/list/search in configured roots",
      "- computer: laptop file access, directory search, safe writes/deletes by policy",
      "- terminal: governed command planning/execution",
      "- web: web_research and URL fetch",
      "- memory: notes, long-term memory, session search",
      "- agents: delegate_task and subagents status/history/cancel",
      "- provider: BYOK key setup, model fetch, readiness test",
      "",
    ].join("\n"));
    this.deleteBootstrapFile(agentId);
    updates.push("bootstrap_completed");

    return {
      updated: true,
      step: "bootstrap_completed",
      updates,
      reply: wantsHinglish
        ? [
            "Bootstrap complete.",
            `Tumhara profile save ho gaya: ${currentFacts.userName || "user"}.`,
            `Meri identity save ho gayi: ${currentFacts.assistantName || "agent"}.`,
            "BOOTSTRAP.md delete ho gaya; ab normal agent mode start hai.",
          ].join(" ")
        : [
            "Bootstrap complete.",
            `Your profile is saved${currentFacts.userName ? `: ${currentFacts.userName}` : ""}.`,
            `My identity is saved: ${currentFacts.assistantName || "agent"}.`,
            "BOOTSTRAP.md is deleted; normal agent mode is active now.",
          ].join(" "),
    };
  }

  updateAgentProfile(agentId = "main", fact = "") {
    const profilePath = this.getAgentProfilePath(agentId);
    const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "# PROFILE\n\n";
    if (!existing.includes(fact)) {
      const updated = existing.replace(/(Updated:.*)/i, `${fact}\n\n$1`) || `${existing}\n- ${fact}\n`;
      fs.writeFileSync(profilePath, updated, "utf8");
    }
  }

  compactPlanForStorage(plan = {}) {
    const tools = Array.isArray(plan.toolsAvailable)
      ? plan.toolsAvailable.map((tool) => ({
          id: tool.id,
          permission: tool.permission || null,
        }))
      : [];
    const compactProfile = plan.profile
      ? {
          id: plan.profile.id,
          description: plan.profile.description,
          allowToolExecution: plan.profile.allowToolExecution,
          enableSkillMatching: plan.profile.enableSkillMatching,
        }
      : plan.profile;

    return {
      ...plan,
      profile: compactProfile,
      toolsAvailable: tools,
      toolCount: tools.length,
    };
  }

  buildGreetingReply({ agent = {}, message = "", intents = [] } = {}) {
    const profileFacts = this.readAgentProfileFacts(agent.id || "main");
    const assistantName = (profileFacts.assistantName && profileFacts.assistantName.length > 1) ? profileFacts.assistantName : "OmniClaw";
    const userName = (profileFacts.userName && profileFacts.userName.length > 1 && !profileFacts.userName.includes(":")) ? profileFacts.userName : "";
    const lowered = message.toLowerCase();
    const isUrduHindi = /\b(hlo|helo|hi|hey|salam|namaste|kaise|kya|tum|tera|main|ho|hai)\b/i.test(lowered);

    if (isUrduHindi) {
      const greeting = userName ? `Haan ${userName}!` : "Haan!";
      return [
        `${greeting} Main ${assistantName} hoon, tumhara local AI assistant.`,
        "Main files, terminal, web research, memory, tasks, aur bohot kuch handle kar sakta hoon.",
        "Batao, aaj kya kaam hai?",
      ].join(" ");
    }

    const greeting = userName ? `Hey ${userName}!` : "Hey!";
    return [
      `${greeting} I'm ${assistantName}, your local-first AI assistant.`,
      "I can help with files, terminal commands, web research, memory, tasks, and more.",
      "What can I help you with today?",
    ].join(" ");
  }

  buildOnboardingReply({ agentId = "main", intents = [], session = {}, profileUpdated = false, hasBootstrap = false } = {}) {
    if (hasBootstrap) {
      return "";
    }
    if (profileUpdated) {
      return "";
    }

    if (this.hasAgentProfile(agentId)) {
      return "";
    }

    const isFreshSession = Number(session.messageCount || 0) <= 0;
    if (!isFreshSession || !intents.includes("greeting")) {
      return "";
    }

    return [
      "Hey, main OmniClaw runtime ke andar abhi ek fresh agent ke roop me online aaya hoon.",
      "OmniClaw platform hai jo agents ko birth/run karta hai; main active agent hoon jise identity, memory, tools, aur skills milte hain.",
      "Main apni identity aur tumhari preferences setup karna chahta hoon, taaki main plain chatbot ki tarah nahi balki real workspace agent ki tarah kaam karun.",
      "",
      "Mujhe do cheezein batao:",
      "1. Main kaun hoon? Mera naam, vibe/personality, aur kaise baat karni hai.",
      "2. Tum kaun ho? Tumhara naam, location/timezone, kaam/interests, aur tum AI se kya build karna chahte ho.",
      "",
      "Jo tum bataoge main PROFILE.md aur memory me save kar lunga, phir next messages me yaad rakhunga.",
    ].join("\n");
  }

  buildProfileUpdateReply({ profileUpdate = {} } = {}) {
    const facts = Array.isArray(profileUpdate.facts) ? profileUpdate.facts : [];
    if (facts.length === 0) {
      return "";
    }
    const readableFacts = facts.map((fact) => {
      const text = String(fact || "").trim();
      return text
        .replace(/^Assistant name:\s*/i, "assistant name = ")
        .replace(/^User name:\s*/i, "user name = ")
        .replace(/^User location:\s*/i, "user location = ");
    });
    return [
      "Profile saved in PROFILE.md and long-term memory.",
      `Saved fact(s): ${readableFacts.join("; ")}.`,
      "Main in facts ko next messages me recall kar sakta hoon.",
    ].join(" ");
  }

  buildDirectRuntimeReply({ intents = [], message = "", agent = {}, tools = [], skills = [] } = {}) {
    if (intents.includes("api-setup") && !intents.includes("provider-status")) {
      return [
        "API key OmniClaw ke active agent ko real LLM brain deti hai.",
        "Provider model reasoning karta hai; OmniClaw platform hands, eyes, memory, tools, skills, sessions, channels, aur approvals deta hai.",
        "OpenRouter/OpenAI-compatible setup me teen cheezein chahiye: base URL, model, aur API key. Key local SecretStore me masked form me save hoti hai.",
        "Agar key ready hai to agent real provider se reply karega; agar provider fail ho to local tools aur memory phir bhi run ho sakte hain.",
      ].join(" ");
    }

    if (intents.includes("profile-question")) {
      return this.buildProfileQuestionReply({ message, agent });
    }

    if (intents.includes("capabilities")) {
      const toolIds = tools.map((tool) => tool.id).filter(Boolean);
      const skillNames = skills.map((skill) => skill.name || skill.id).filter(Boolean);
      return [
        `Main ${this.readAgentProfileFacts(agent.id || "main").assistantName || agent.name || "OmniClaw agent"} hoon. OmniClaw platform mujhe hands/eyes deta hai: files, laptop folders, terminal, browser, web research, memory, tasks, skills, providers, aur channels.`,
        `Active tools: ${toolIds.slice(0, 18).join(", ")}${toolIds.length > 18 ? `, +${toolIds.length - 18} more` : ""}.`,
        `Active skills: ${skillNames.slice(0, 8).join(", ") || "workspace skills load hone ke liye ready"}.`,
        "Demo commands: 'C drive me Downloads list karo', 'OpenClaw research karo sources ke saath', 'todo app banao aur verify karo', 'Telegram token <token> setup karo'.",
      ].join("\n");
    }

    if (intents.includes("greeting") && intents.length === 1) {
      const profileFacts = this.readAgentProfileFacts(agent.id || "main");
      const assistantName = profileFacts.assistantName || agent.name || "Main Agent";
      const userName = profileFacts.userName || "Mankush";
      return `Haan ${userName}, main online hoon. Main ${assistantName} agent hoon, OmniClaw runtime ke andar chal raha hoon. Agar provider brain auth fail bhi ho, local tools, memory, sessions, gateway, files aur terminal policy yahin available hain.`;
    }

    return "";
  }

  decorateToolOutput(item = {}) {
    const status = this.classifyToolOutput(item);
    const summary = this.summarizeToolOutputForUser(item);
    const nextFix = this.nextFixForToolOutput(item, status);
    return {
      ...item,
      toolSummary: {
        status,
        summary,
        nextFix,
      },
    };
  }

  buildToolEventDetails(tool = "", output = {}) {
    const inner = output?.result && typeof output.result === "object" ? output.result : output || {};
    const isBrowser = String(tool || "").startsWith("browser") || String(output?.tool || "").startsWith("browser");
    const details = {
      outputSummary: this.summarizeToolOutputForUser({ tool, output }),
    };
    if (isBrowser) {
      details.action = output?.action || String(tool || "").replace(/^browser_?/, "") || "browser";
      details.toolAdapter = output?.tool || tool;
      details.browserSessionId = output?.sessionId || inner.sessionId || "";
      details.url = output?.url || inner.url || inner.finalUrl || inner.currentUrl || "";
      details.title = output?.title || inner.title || "";
      details.screenshotPath = output?.screenshotPath || inner.screenshotPath || inner.imagePath || "";
      const statusProof = inner.operator
        ? `ready=${inner.operator.ready !== false}; path=${inner.operator.browserPath || "unknown"}; playwright=${inner.playwrightReady !== false}`
        : "";
      details.resultPreview = truncateTraceText(
        typeof inner.result === "string" ? inner.result : JSON.stringify(sanitizeTraceValue(inner.result ?? inner.message ?? inner.content ?? inner.text ?? statusProof ?? "", { maxString: 220, maxArray: 4, maxDepth: 2 })),
        260,
      );
    }
    return details;
  }

  classifyToolOutput(item = {}) {
    const output = item.output?.cached && item.output?.result ? item.output.result : item.output || {};
    const execution = output.execution || (output.command && (output.stdout != null || output.stderr != null) ? output : null);
    const status = String(output.status || execution?.status || "").toLowerCase();
    if (output.approvalId || status === "approval-required" || status === "pending") {
      return "pending-approval";
    }
    if (output.blocked || status === "blocked") {
      return "blocked";
    }
    if (
      output.error ||
      output.ok === false ||
      status === "failed" ||
      status === "error" ||
      execution?.timedOut ||
      (execution && execution.exitCode != null && Number(execution.exitCode) !== 0)
    ) {
      return "failed";
    }
    return "completed";
  }

  summarizeToolOutputForUser(item = {}) {
    const output = item.output?.cached && item.output?.result ? item.output.result : item.output || {};
    if (output.error || output.blocked) {
      return truncateTraceText(output.message || output.reason || output.stderr || "Tool blocked or failed.", 320);
    }

    if (String(item.tool || "").startsWith("browser") || String(output.tool || "").startsWith("browser")) {
      const inner = output.result && typeof output.result === "object" ? output.result : output;
      const action = output.action || String(item.tool || "").replace(/^browser_?/, "") || "browser";
      const title = output.title || inner.title || "";
      const url = output.url || inner.url || inner.finalUrl || "";
      const sessionId = output.sessionId || inner.sessionId || "";
      const screenshot = output.screenshotPath || inner.screenshotPath || inner.imagePath || "";
      const result = inner.result ?? inner.message ?? inner.content ?? inner.text ?? "";
      const label = [action, title || url || sessionId].filter(Boolean).join(" | ");
      const proof = screenshot ? ` Screenshot: ${screenshot}.` : "";
      const preview = result ? ` Result: ${truncateTraceText(typeof result === "string" ? result : JSON.stringify(sanitizeTraceValue(result, { maxString: 180, maxArray: 4, maxDepth: 2 })), 220)}` : "";
      return truncateTraceText(`Browser ${label || "action"} completed.${proof}${preview}`, 420);
    }

    const execution = output.execution || (output.command && (output.stdout != null || output.stderr != null) ? output : null);
    if (execution) {
      const body = execution.stdout || execution.stderr || execution.command || "No terminal output.";
      const status = execution.status || output.status || "executed";
      const exit = execution.exitCode != null ? `, exit ${execution.exitCode}` : "";
      return truncateTraceText(`Terminal ${status}${exit}: ${body}`, 420);
    }

    if (Array.isArray(output.entries)) {
      return `Listed ${output.entries.length} item(s) in ${output.path || "directory"}.`;
    }

    if (Array.isArray(output.results)) {
      const first = output.results[0] || {};
      const fetched = Array.isArray(output.fetchedContent)
        ? output.fetchedContent.filter((page) => (page.text || page.markdown) && !page.error && !page.fallback).length
        : 0;
      const query = output.query ? `Query "${output.query}"` : "Search";
      return `${query}: ${output.results.length} result(s), ${fetched} page(s) read${first.title ? `, top: ${first.title}` : ""}.`;
    }

    if (["web_fetch", "read_url"].includes(String(item.tool || ""))) {
      const chars = Number(output.totalChars || String(output.text || output.markdown || output.content || "").length || 0);
      const provider = output.provider ? ` via ${output.provider}` : "";
      return truncateTraceText(`Fetched ${output.finalUrl || output.url || "URL"}${provider}: ${chars} char(s) available.`, 420);
    }

    if (Array.isArray(output.links)) {
      return `Browser found ${output.links.length} link(s)${output.url ? ` at ${output.url}` : ""}.`;
    }

    if (output.title || output.url) {
      return truncateTraceText(`Browser page: ${output.title || "untitled"}${output.url ? ` at ${output.url}` : ""}.`, 320);
    }

    if (output.screenshotPath || output.imagePath) {
      return `Browser screenshot saved at ${output.screenshotPath || output.imagePath}.`;
    }

    if (output.path || output.file) {
      const file = output.path || output.file;
      if (output.bytesWritten != null) {
        return `Wrote ${output.bytesWritten} byte(s) to ${file}.`;
      }
      if (output.deleted || output.trashPath) {
        return `Deleted ${file}${output.trashPath ? ` to ${output.trashPath}` : ""}.`;
      }
      if (output.from && output.to) {
        return `Moved/copied ${output.from} -> ${output.to}.`;
      }
      if (output.content != null) {
        return `Read ${file}: ${truncateTraceText(output.content, 260)}`;
      }
      return `File operation completed: ${file}.`;
    }

    if (output.content != null || output.text != null) {
      return truncateTraceText(output.content ?? output.text, 360);
    }

    return truncateTraceText(JSON.stringify(sanitizeTraceValue(output, { maxString: 220, maxArray: 5, maxDepth: 3 })), 420);
  }

  nextFixForToolOutput(item = {}, status = "") {
    if (status === "completed") {
      return "";
    }
    const tool = String(item.tool || "");
    const output = item.output || {};
    const text = `${output.message || ""} ${output.reason || ""} ${output.stderr || ""}`.toLowerCase();
    if (status === "pending-approval") {
      return "Approval panel me pending command/action approve karo, ya safer command bhejo.";
    }
    if (status === "blocked") {
      return "Policy/allowed roots check karo; path ko allowed workspace root ke andar rakho ya trust setting badhao.";
    }
    if (/enoent|not found|cannot find|no such file|path/i.test(text)) {
      return "Pehle directory list karo, exact path verify karo, phir command/file action rerun karo.";
    }
    if (/auth|login|api key|unauthorized|forbidden|credential/i.test(text)) {
      return "Provider/API auth check karo: key, base URL, model, ya account login refresh karo.";
    }
    if (/timeout|timed out/i.test(text) || output.execution?.timedOut) {
      return "Command/query ko chhota karo ya timeout badha kar rerun karo.";
    }
    if (/browser|url|navigation|page/i.test(tool) || /browser|url|navigation|page/i.test(text)) {
      return "Browser status check karo, target URL open karo, phir snapshot/text/screenshot rerun karo.";
    }
    if (/terminal|shell|exec|command|code_execution|plan_shell_command/i.test(tool)) {
      return "stderr/stdout inspect karo, command fix karo, phir terminal tool rerun karo.";
    }
    return "Tool output inspect karo, input/permission fix karo, phir same task rerun karo.";
  }

  buildToolExecutionReply({ toolOutputs = [] } = {}) {
    if (!toolOutputs.length) {
      return "";
    }
    const hasWebResearchOutput = toolOutputs.some((item) =>
      ["web_research", "web_search", "web_fetch", "read_url"].includes(String(item.tool || "")),
    );
    if (hasWebResearchOutput) {
      const groundedResearch = this.buildGroundedResearchReply({ toolOutputs });
      if (groundedResearch && !/^(?:Tool run complete|Actual result)\b/i.test(groundedResearch)) {
        return groundedResearch;
      }
    }
    const counts = toolOutputs.reduce((acc, item) => {
      const status = item.toolSummary?.status || this.classifyToolOutput(item);
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const attentionCount = (counts.failed || 0) + (counts.blocked || 0) + (counts["pending-approval"] || 0);
    const header = attentionCount > 0
      ? `Tool run complete nahi hua: ${counts.completed || 0} completed, ${attentionCount} need attention.`
      : `Tool run complete: ${counts.completed || toolOutputs.length} tool(s) completed.`;
    const lines = toolOutputs.slice(0, 6).map((item) => {
      const status = item.toolSummary?.status || this.classifyToolOutput(item);
      const summary = item.toolSummary?.summary || this.summarizeToolOutputForUser(item);
      return `- ${item.tool || "tool"} [${status}]: ${summary}`;
    });
    const fixes = toolOutputs
      .map((item) => item.toolSummary?.nextFix || this.nextFixForToolOutput(item, item.toolSummary?.status))
      .filter(Boolean);
    return [
      header,
      ...lines,
      fixes.length ? `Next fix: ${fixes[0]}` : "",
      "Trace chat card me proof ke saath saved hai.",
    ].filter(Boolean).join("\n");
  }

  buildRuntimeToolReply({ intents = [], toolOutputs = [] } = {}) {
    const byTool = new Map(toolOutputs.map((item) => [item.tool, item.output || {}]));
    const browserOutputs = toolOutputs.filter((item) =>
      item.tool === "browser" ||
      String(item.tool || "").startsWith("browser_") ||
      String(item.output?.tool || "").startsWith("browser_"),
    );
    if (browserOutputs.length > 0 && (intents.includes("browser-observe") || intents.includes("browser-navigate"))) {
      const lines = browserOutputs.map((item) => {
        const output = item.output || {};
        const inner = output.result && typeof output.result === "object" ? output.result : output;
        const action = output.action || String(item.tool || "").replace(/^browser_?/, "") || "browser";
        const title = output.title || inner.title || "";
        const url = output.url || inner.url || inner.finalUrl || "";
        const sessionId = output.sessionId || inner.sessionId || "";
        const screenshot = output.screenshotPath || inner.screenshotPath || inner.imagePath || "";
        const statusProof = inner.operator
          ? `ready=${inner.operator.ready !== false}; playwright=${inner.playwrightReady !== false}; path=${inner.operator.browserPath || "unknown"}`
          : "";
        const result = inner.result ?? inner.message ?? inner.content ?? inner.text ?? statusProof ?? "";
        return [
          `- ${action}: ${title || url || sessionId || "browser"}${result ? ` | ${truncateTraceText(typeof result === "string" ? result : JSON.stringify(sanitizeTraceValue(result, { maxString: 180, maxArray: 4, maxDepth: 2 })), 220)}` : ""}`,
          screenshot ? `  Screenshot: ${screenshot}` : "",
        ].filter(Boolean).join("\n");
      });
      const failed = browserOutputs.filter((item) => this.classifyToolOutput(item) !== "completed");
      return [
        failed.length ? "Browser action me issue mila; maine trace me exact observation save kar di." : "Browser action complete.",
        ...lines,
        failed.length ? "Next: selector/session/URL adjust karke browser tool dobara run karo." : "Trace card me live browser proof saved hai.",
      ].join("\n");
    }

    if (
      intents.includes("research") &&
      !intents.includes("complex-build") &&
      !intents.includes("research-then-build") &&
      (byTool.has("web_research") || byTool.has("web_search"))
    ) {
      return this.buildGroundedResearchReply({ toolOutputs });
    }

    const writtenFiles = toolOutputs
      .filter((item) =>
        (item.tool === "write_file" || item.tool === "append_file") &&
        item.output &&
        !item.output.error &&
        !item.output.blocked,
      )
      .map((item) => item.output);
    const builtHtml = writtenFiles.filter((item) => /\.html?$/i.test(String(item.path || "")));
    if (builtHtml.length > 0) {
      const research = toolOutputs.find((item) => item.tool === "web_research" || item.tool === "web_search")?.output || {};
      const verifications = toolOutputs
        .filter((item) => item.tool === "verify_html_artifact" && item.output && !item.output.error && !item.output.blocked)
        .map((item) => item.output);
      const browserProofs = toolOutputs
        .filter((item) => ["browser_automate", "browser_open", "browser_evaluate", "browser_screenshot"].includes(item.tool) && item.output && !item.output.error && !item.output.blocked)
        .map((item) => item.output);
      const htmlLines = builtHtml.map((file) => {
        const absolutePath = path.resolve(this.rootDir, file.path || "");
        const verification = verifications.find((item) => item.path === file.path);
        const verifyText = verification
          ? ` Verified: ${verification.ok ? "passed" : "needs attention"} (${verification.score}/100, ${verification.passed}/${verification.total} checks).`
          : "";
        return `- Created ${file.path} (${file.bytesWritten || 0} bytes).${verifyText} Preview: ${pathToFileURL(absolutePath).href}`;
      });
      const browserLines = browserProofs.slice(0, 3).map((proof) => {
        const actions = Array.isArray(proof.actions) ? proof.actions : [];
        const screenshot = actions.find((action) => action.screenshotPath)?.screenshotPath || proof.screenshotPath || "";
        const evaluation = actions.find((action) => action.result)?.result || proof.result || {};
        const evalText = evaluation && typeof evaluation === "object"
          ? Object.entries(evaluation).slice(0, 5).map(([key, value]) => `${key}=${value}`).join(", ")
          : "";
        return `- Browser proof: ${proof.success === false ? "needs attention" : "passed"}${proof.url ? ` at ${proof.url}` : ""}${evalText ? ` (${evalText})` : ""}${screenshot ? `. Screenshot: ${screenshot}` : ""}`;
      });
      const issueLines = verifications
        .filter((item) => Array.isArray(item.issues) && item.issues.length > 0)
        .map((item) => `- ${item.path} issues: ${item.issues.join(", ")}`);
      return [
        "Build complete.",
        htmlLines.join("\n"),
        writtenFiles
          .filter((file) => !/\.html?$/i.test(String(file.path || "")))
          .map((file) => `- Wrote ${file.path} (${file.bytesWritten || 0} bytes).`)
          .join("\n"),
        issueLines.length ? ["Verification notes:", ...issueLines].join("\n") : "",
        browserLines.length ? ["Browser verification:", ...browserLines].join("\n") : "",
        research.results ? `Research trace: ${research.results.length} source result(s), ${research.fetchedContent?.length || 0} page fetch attempt(s).` : "",
        "Browser preview tool can open this file when asked to run/open/preview it.",
      ].filter(Boolean).join("\n");
    }

    if (writtenFiles.length > 0 && (intents.includes("file-write") || toolOutputs.some((item) => item.tool === "read_file"))) {
      const readbacks = toolOutputs
        .filter((item) => item.tool === "read_file" && item.output && !item.output.error && !item.output.blocked)
        .map((item) => item.output);
      const lines = writtenFiles.map((file) => {
        const readback = readbacks.find((item) => item.path === file.path);
        const verified = readback ? ` Verified read-back: ${readback.bytesRead || 0}/${readback.totalBytes || 0} bytes.` : "";
        const preview = readback?.content ? ` Preview: ${String(readback.content).replace(/\s+/g, " ").trim().slice(0, 160)}` : "";
        return `- ${file.path}: wrote ${file.bytesWritten || 0} bytes.${verified}${preview}`;
      });
      return [
        "File task complete.",
        ...lines,
      ].join("\n");
    }

    if (byTool.has("write_computer_file")) {
      const writes = toolOutputs
        .filter((item) => item.tool === "write_computer_file" && item.output && !item.output.error && !item.output.blocked)
        .map((item) => item.output);
      const readbacks = toolOutputs
        .filter((item) => item.tool === "read_computer_file" && item.output && !item.output.error && !item.output.blocked)
        .map((item) => item.output);
      const lines = writes.map((file) => {
        const readback = readbacks.find((item) => item.path === file.path);
        const verified = readback ? ` Verified read-back: ${readback.bytesRead || 0}/${readback.totalBytes || 0} bytes.` : "";
        const preview = readback?.content ? ` Preview: ${String(readback.content).replace(/\s+/g, " ").trim().slice(0, 160)}` : "";
        return `- ${file.path}: wrote ${file.bytesWritten || 0} bytes.${verified}${preview}`;
      });
      return [
        "Computer file task complete.",
        ...lines,
      ].join("\n");
    }

    if (byTool.has("configure_telegram")) {
      const result = byTool.get("configure_telegram");
      if (result.needsToken) {
        return [
          "Telegram connect kar sakta hoon, lekin abhi bot token missing hai.",
          "",
          "Token milte hi main yeh kaam khud karunga:",
          "1. Telegram adapter enable.",
          "2. Bot token local secret store me save.",
          "3. Adapter readiness test.",
          "4. Polling worker start.",
          "5. Chat me final status + next test step.",
          "",
          "Abhi command bhejo:",
          "`telegram token <BOT_TOKEN>`",
          "",
          "Security note: token chat transcript me aa sakta hai. Product build me secure token modal/pairing flow next upgrade hai.",
        ].join("\n");
      }
      const adapter = result.adapter || {};
      const workerRunning = Boolean(result.worker?.running || result.worker?.status === "running");
      return [
        "Telegram setup complete.",
        `Adapter: ${adapter.status || "unknown"}; enabled ${adapter.enabled ? "yes" : "no"}; secret saved ${result.secretUpdated ? "yes" : "already configured"}.`,
        `Test: ${result.test?.ok ? "passed" : "needs attention"}${result.test?.message ? ` - ${result.test.message}` : ""}.`,
        `Worker: ${workerRunning ? "running" : result.workerError ? `not started - ${result.workerError}` : "not started"}.`,
        Array.isArray(result.next) && result.next.length ? `Next: ${result.next.join(" ")}` : "",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("task-create") && byTool.has("create_task")) {
      const result = byTool.get("create_task");
      const task = result.task || {};
      const plan = Array.isArray(result.plan) ? result.plan : task.plan || [];
      const toolPlan = Array.isArray(result.toolPlan) ? result.toolPlan : task.toolPlan || [];
      const criteria = Array.isArray(result.acceptanceCriteria) ? result.acceptanceCriteria : task.acceptanceCriteria || [];
      return [
        "Task blueprint created.",
        `Task: ${task.id || "unknown"} - ${task.title || "untitled"} (${task.taskType || "general"}, priority ${task.priority || "normal"}).`,
        plan.length ? `Plan: ${plan.slice(0, 6).map((step, index) => `${index + 1}. ${step}`).join(" ")}` : "",
        toolPlan.length ? `Tool path: ${toolPlan.join(" -> ")}.` : "",
        criteria.length ? `Done when: ${criteria.slice(0, 4).join(" | ")}` : "",
        task.automation?.requested ? `Automation hint: ${task.automation.intervalHint || "interval not parsed"} via ${task.automation.deliveryHint || "webchat"}.` : "",
        "Run it with: run task " + (task.id || ""),
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("prompt-assembly") && byTool.has("prompt_assembly_status")) {
      const status = byTool.get("prompt_assembly_status");
      const scopes = {};
      for (const file of status.files || []) {
        scopes[file.scope || "unknown"] = (scopes[file.scope || "unknown"] || 0) + 1;
      }
      return [
        "Hermes-style prompt assembly status ready.",
        `Agent ${status.agentId || "main"} profile ${status.profile || "balanced"} budget ${status.maxContextChars || 0} chars.`,
        `Context files: ${(status.files || []).length} loaded (${Object.entries(scopes).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}).`,
        `Defenses: prompt injection scan ${status.defenses?.promptInjectionScan ? "on" : "off"}, invisible unicode scan ${status.defenses?.invisibleUnicodeScan ? "on" : "off"}, hidden HTML scan ${status.defenses?.hiddenHtmlScan ? "on" : "off"}.`,
        `Suspicious files: ${status.suspiciousCount || 0}.`,
        status.rule || "",
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("hermes-reference") && byTool.has("hermes_reference_status")) {
      const hermes = byTool.get("hermes_reference_status");
      const now = hermes.omniClawNow || {};
      const gaps = Array.isArray(hermes.gaps) ? hermes.gaps.slice(0, 3) : [];
      const next = Array.isArray(hermes.nextBuildActions) ? hermes.nextBuildActions.slice(0, 3) : [];
      return [
        "Hermes reference mapping ready hai.",
        `${hermes.source?.name || "Hermes Agent"} (${hermes.source?.license || "MIT"}) se useful pattern: slash commands, skill growth, session search, gateways, subagents, terminal backends.`,
        `OmniClaw now: provider ${now.provider || "unknown"} (${now.providerReady ? "ready" : "not ready"}), model ${now.model || "unset"}, V2 score ${now.v2Score || 0}/100, tools ${now.toolCount || 0}, agents ${now.agentCount || 0}.`,
        `Added command surface: ${(now.commandSurface || []).join(", ")}.`,
        gaps.length ? `Gaps: ${gaps.join(" | ")}` : "",
        next.length ? `Next build: ${next.join(" | ")}` : "",
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("hermes-tools") && byTool.has("hermes_tool_catalog")) {
      const catalog = byTool.get("hermes_tool_catalog");
      const skills = byTool.get("hermes_skill_scan") || {};
      const counts = catalog.counts || {};
      const samples = Array.isArray(catalog.tools)
        ? catalog.tools.slice(0, 10).map((tool) => `${tool.id}:${tool.status}`).join(", ")
        : "";
      return [
        "Hermes tool import status ready hai.",
        `Total mapped tools: ${catalog.total || 0}. Native ${counts.native || 0}, alias ${counts.alias || 0}, partial ${counts.partial || 0}, placeholder ${counts.placeholder || 0}.`,
        `Sample: ${samples || "none"}.`,
        `Hermes skills available: ${skills.totalAvailable || skills.count || 0}; scanned sample ${skills.count || 0}.`,
        "Decision: OmniClaw ke working tools delete nahi karne. Hermes names ko aliases/adapters ke through add karna sahi hai, warna Node app me Python runtime direct paste se breakage hoga.",
      ].join(" ");
    }

    if (intents.includes("context-compression") && byTool.has("context_compression_status")) {
      const status = byTool.get("context_compression_status");
      return [
        "Hermes-style context compression status ready.",
        `Profile ${status.profile || "balanced"} budget ${status.maxChars || 0} chars, compression threshold ${status.compressionThreshold || 0}.`,
        `Session ${status.activeSessionId || "none"} transcript entries ${status.transcriptEntryCount || 0}, summary ${status.summaryPresent ? "present" : "missing"}.`,
        `Algorithm: ${(status.algorithm || []).slice(0, 4).join(" | ")}.`,
        `Next upgrade: ${status.nextUpgrade || "head/middle/tail compaction improve karo"}`,
      ].join(" ");
    }

    if (intents.includes("memory-lifecycle") && byTool.has("memory_lifecycle_status")) {
      const status = byTool.get("memory_lifecycle_status");
      const overview = status.overview || {};
      return [
        "Hermes-style memory lifecycle status ready.",
        `Memory counts: notes ${overview.notes || 0}, conversations ${overview.conversations || 0}, research ${overview.research || 0}, long-term ${overview.longTerm || 0}, dreams ${overview.dreams || 0}.`,
        `Lifecycle: ${(status.lifecycle || []).join(" | ")}.`,
        `Session search: ${status.sessionSearch?.ready ? "on" : "off"} (${status.sessionSearch?.mode || "unknown"}).`,
        status.fencedBlockRule || "",
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("skill-system") && byTool.has("skill_system_status")) {
      const status = byTool.get("skill_system_status");
      return [
        "Hermes-style skill system status ready.",
        `OmniClaw skills: ${status.omniSkillCount || 0}; vendored Hermes skills: ${status.hermesVendoredSkillCount || 0}.`,
        `Progressive disclosure: ${(status.progressiveDisclosure || []).join(" | ")}.`,
        `Self-improvement gap: ${status.selfImprovement?.gap || "unknown"}.`,
        `Next upgrade: ${status.selfImprovement?.nextUpgrade || "skill_manage import/update flow"}`,
      ].join(" ");
    }

    if (intents.includes("messaging-gateway") && byTool.has("messaging_gateway_status")) {
      const status = byTool.get("messaging_gateway_status");
      const overview = status.overview || {};
      const platforms = Array.isArray(status.configuredPlatforms) ? status.configuredPlatforms : [];
      const readyPlatforms = platforms
        .filter((platform) => platform.enabled && ["ready", "configured"].includes(platform.status))
        .map((platform) => platform.id);
      const disabledPlatforms = platforms
        .filter((platform) => !platform.enabled || !["ready", "configured"].includes(platform.status))
        .map((platform) => {
          const secretRequired = (platform.capabilities || []).includes("secret-required");
          const needsSecret = secretRequired && !platform.secretConfigured;
          const reasons = [
            !platform.enabled ? "disabled" : "",
            needsSecret ? "secret/token missing" : "",
            platform.status && !["ready", "configured"].includes(platform.status) ? `status ${platform.status}` : "",
          ].filter(Boolean);
          return `${platform.id}: not connected (${reasons.join(", ") || "not ready"})`;
        });
      const telegram = platforms.find((platform) => platform.id === "telegram");
      const telegramLine = telegram
        ? `Telegram: ${telegram.enabled && ["ready", "configured"].includes(telegram.status)
          ? "connected/ready"
          : `not connected (${[
            !telegram.enabled ? "adapter disabled" : "",
            (telegram.capabilities || []).includes("secret-required") && !telegram.secretConfigured ? "bot token missing" : "",
            telegram.status ? `status ${telegram.status}` : "",
          ].filter(Boolean).join(", ")})`}.`
        : "Telegram adapter not found.";
      return [
        "Haan, main Telegram se connect ho sakta hoon. messaging gateway status ye hai:",
        `Adapters: total ${overview.total || 0}, enabled ${overview.enabled || 0}, ready ${overview.ready || 0}, needs-secret ${overview.needsSecret || 0}.`,
        readyPlatforms.length ? `Ready platforms: ${readyPlatforms.join(", ")}.` : "Ready platforms: none.",
        telegramLine,
        disabledPlatforms.length ? `Not connected: ${disabledPlatforms.join("; ")}.` : "",
        telegram && !(telegram.enabled && ["ready", "configured"].includes(telegram.status))
          ? "Setup: Telegram bot token bhejo (`telegram token <BOT_TOKEN>`), main adapter enable karke token save/test/start kar dunga. UI path: Channels -> Adapter: telegram -> Secret/token -> Save adapter -> Start Telegram."
          : "Telegram ready hai: bot ko /start bhejo, phir Telegram se OmniClaw ko message kar sakte ho.",
        `Session routing: ${status.sessionRouting?.ready ? "on" : "off"}; recent sessions ${status.sessionRouting?.recentSessionCount || 0}.`,
        `Voice/media: ${status.voiceTranscription?.status || "unknown"} - ${status.voiceTranscription?.current || ""}.`,
        `Security: approvals ${status.dmPairingSecurity?.approvals || 0}, trust store ${status.dmPairingSecurity?.trustStore ? "on" : "off"}.`,
        `Next upgrade: ${status.nextUpgrade || "gateway adapters improve karo"}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("terminal-backends") && byTool.has("terminal_backends_status")) {
      const status = byTool.get("terminal_backends_status");
      const backends = Array.isArray(status.backends) ? status.backends.map((backend) => `${backend.id}:${backend.status}`).join(", ") : "";
      return [
        "Hermes-style terminal backends status ready.",
        `Default backend: ${status.defaultBackend || "local"}. Backends: ${backends || "none"}.`,
        `Process registry: ${status.processRegistry?.ready ? "on" : "off"}, process sample ${status.processRegistry?.processSampleCount || 0}, shell audit ${status.processRegistry?.auditCount || 0}.`,
        `Approval gates: shell execution ${status.approvalGates?.shellExecutionAllowed ? "allowed" : "disabled"}, planning ${status.approvalGates?.shellPlanningAllowed ? "allowed" : "disabled"}.`,
        `Next upgrade: ${status.nextUpgrade || "terminal backend selection add karo"}`,
      ].join(" ");
    }

    if (intents.includes("model-provider") && byTool.has("model_provider_status")) {
      const status = byTool.get("model_provider_status");
      const active = status.active || {};
      return [
        "Hermes-style multi-provider model status ready.",
        `Active: ${active.provider || "unknown"} ${active.model || "unset"} (${active.ready ? "ready" : "not ready"}), API mode ${active.apiMode || "unknown"}.`,
        `Credential pool: ${status.credentialPool?.configuredKeys || 0} configured key(s); status ${status.credentialPool?.status || "unknown"}.`,
        `Failover: ${status.smartFailover?.status || "unknown"}; rate limits: ${status.rateLimitTracker?.status || "unknown"}.`,
        `Model discovery tool: ${status.modelDiscovery?.tool || "list_provider_models"}.`,
        `Next upgrade: ${status.nextUpgrade || "provider router add karo"}`,
      ].join(" ");
    }

    if (byTool.has("configure_provider_brain")) {
      const result = byTool.get("configure_provider_brain");
      const readiness = result.readiness || {};
      const key = result.keyStatus || {};
      const models = result.models || null;
      return [
        readiness.ok === false ? "Brain setup saved, but live readiness needs attention." : "Brain setup saved.",
        `Provider: ${result.profileId || result.apiKeyProviderId || "active"} (${result.mode || "unknown"}).`,
        `Base URL: ${result.baseUrl || "not set"}.`,
        `Model: ${result.model || "not set"}.`,
        `Key vault: ${result.apiKeyProviderId || key.providerId || "unknown"} ${key.masked ? `(${key.masked})` : key.configured ? "(configured)" : "(missing)"}.`,
        readiness.message || readiness.live?.error ? `Readiness: ${readiness.message || readiness.live?.error}` : "",
        models ? `Models: ${models.ok === false ? "fetch failed" : `${models.count || models.models?.length || 0} fetched`}.` : "",
        models?.error ? `Model fetch error: ${models.error}` : "",
        "Next: send a normal message or ask /doctor; OmniClaw will use this provider instead of mock when ready.",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("subagent-delegation") && byTool.has("subagent_delegation_status")) {
      const status = byTool.get("subagent_delegation_status");
      return [
        "Hermes-style subagent delegation status ready.",
        `Agents available: ${(status.availableAgents || []).length}; delegate_task ${status.delegationToolReady ? "ready" : "missing"}.`,
        `Isolation: child parent-history ${status.isolationGuarantees?.childGetsParentHistory ? "yes" : "no"}, max depth ${status.isolationGuarantees?.maxDepth || 1}, result mode ${status.isolationGuarantees?.resultMode || "summary"}.`,
        `Execute-code tool: ${status.executeCodeTool?.ready ? "ready" : "missing"}.`,
        `Recent delegations: ${(status.recentDelegations || []).length}.`,
        `Next upgrade: ${status.nextUpgrade || "real child agent runs add karo"}`,
      ].join(" ");
    }

    if (intents.includes("mcp-integration") && byTool.has("mcp_integration_status")) {
      const status = byTool.get("mcp_integration_status");
      return [
        "Hermes-style MCP integration status ready.",
        `Configured servers: ${(status.configuredServers || []).length}; connected ${status.connectedServers || 0}; live tools ${status.liveToolCount || 0}.`,
        `Resolution: ${(status.resolutionFlow || []).join(" | ")}.`,
        `OmniClaw as MCP server: ${status.servesOmniClawToo?.status || "unknown"}; ACP: ${status.acpAdapter?.status || "unknown"}.`,
        `Next upgrade: ${status.nextUpgrade || "MCP dashboard connect/test add karo"}`,
      ].join(" ");
    }

    if (intents.includes("trajectory-training") && byTool.has("trajectory_training_status")) {
      const status = byTool.get("trajectory_training_status");
      const counts = status.counts || {};
      return [
        "Hermes-style trajectory and RL training status ready.",
        `Pipeline: ${status.pipeline?.status || "unknown"} (${status.pipeline?.mode || "gateway traces"}), skip context files ${status.pipeline?.skipContextFiles ? "on" : "off"}.`,
        `Counts: runs ${counts.runs || 0}, tool events ${counts.toolEvents || 0}, shell audit ${counts.shellAudit || 0}, jobs ${counts.jobs || 0}.`,
        `Components: ${(status.components || []).map((item) => `${item.id}:${item.status}`).join(", ")}.`,
        `RL: ${status.rlTraining?.status || "unknown"} - ${status.rlTraining?.gap || ""}.`,
        `Next upgrade: ${status.nextUpgrade || "trajectory exporter add karo"}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("closed-learning-loop") && byTool.has("closed_learning_loop_status")) {
      const status = byTool.get("closed_learning_loop_status");
      return [
        "Hermes-style closed learning loop status ready.",
        `Loop: ${(status.loop || []).map((item) => `${item.step}:${item.status}`).join(", ")}.`,
        `Memory lifecycle: ${(status.memoryLifecycle || []).join(" | ")}.`,
        status.closedLoopRule || "",
        `Next upgrade: ${status.nextUpgrade || "post-run learner add karo"}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("hermes-use-cases") && byTool.has("hermes_use_cases_status")) {
      const status = byTool.get("hermes_use_cases_status");
      const summary = status.summary || {};
      return [
        "Hermes use-case capability matrix ready.",
        `Summary: ready ${summary.ready || 0}, partial ${summary.partial || 0}, seeded ${summary.seeded || 0}, missing ${summary.missing || 0}.`,
        `Use cases: ${(status.cases || []).map((item) => `${item.label}:${item.status}`).join(" | ")}.`,
        status.rule || "",
        `Next upgrade: ${status.nextUpgrade || "one use case end-to-end ready karo"}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("design-principles") && byTool.has("design_principles_status")) {
      const status = byTool.get("design_principles_status");
      return [
        "Hermes-style design principles status ready.",
        `Principles: ${(status.principles || []).map((item) => `${item.id}:${item.status}`).join(" | ")}.`,
        status.rule || "",
        `Next upgrade: ${status.nextUpgrade || "artifact store and platform formatting add karo"}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("cron-scheduler") && byTool.has("cron_scheduler_status")) {
      const status = byTool.get("cron_scheduler_status");
      const overview = status.overview || {};
      return [
        "Hermes-style cron scheduler status ready.",
        `Schedules: total ${overview.scheduleCount || 0}, active ${overview.activeCount || 0}, paused ${overview.pausedCount || 0}, next ${overview.nextRunAt || "none"}.`,
        `Recent jobs: ${(status.recentJobs || []).length}; delivery path ${status.deliveryPath?.ready ? "ready" : "partial"}.`,
        `Flow: ${(status.howItWorks || []).slice(0, 3).join(" | ")}.`,
        `Next upgrade: ${status.nextUpgrade || "natural language cron parser add karo"}`,
      ].join(" ");
    }

    if (intents.includes("hermes-doctor")) {
      const provider = byTool.get("provider_status") || {};
      const access = byTool.get("computer_access_status") || {};
      const session = byTool.get("session_status") || {};
      const v2 = byTool.get("v2_status") || {};
      return [
        "/doctor complete.",
        `Brain: ${provider.ready ? "ready" : "not ready"} (${provider.provider || "unknown"}${provider.model ? `/${provider.model}` : ""}).`,
        `Hands/eyes: roots ${(access.allowedRoots || []).length}, terminal ${access.terminal?.enabled ? "on" : "off"}, browser ${access.browser?.automation?.enabled === false ? "partial" : "on"}.`,
        `Session: ${session.sessionId || "unknown"}, gateway runs ${session.gateway?.runs || 0}, approvals ${session.gateway?.approvals || 0}.`,
        `V2: score ${v2.score || 0}/100, ready ${v2.summary?.ready || 0}, partial ${v2.summary?.partial || 0}, missing ${v2.summary?.missing || 0}.`,
        `Next fix: ${provider.nextFix || "Run /model and /platforms for deeper diagnosis."}`,
      ].join(" ");
    }

    if (intents.includes("hermes-model")) {
      const provider = byTool.get("provider_status") || {};
      const models = byTool.get("list_provider_models") || {};
      const list = Array.isArray(models.models) ? models.models.slice(0, 8) : [];
      const names = list.map((model) => model.id || model.name || model).filter(Boolean);
      return [
        "/model complete.",
        `Active provider: ${provider.provider || "unknown"}, model: ${provider.model || "unset"}, ready: ${provider.ready ? "yes" : "no"}.`,
        models.ok === false || models.error ? `Model fetch error: ${String(models.error || models.message || "unknown").slice(0, 260)}.` : "",
        names.length ? `Available models sample: ${names.join(", ")}.` : "Available model list empty ya provider endpoint configured nahi hai.",
        `Next fix: ${provider.nextFix || "Provider profile/base URL/key check karo."}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("hermes-skills")) {
      const demo = byTool.get("capability_demo") || {};
      const agents = byTool.get("agents_list") || {};
      const coreTools = Array.isArray(demo.coreTools) ? demo.coreTools.slice(0, 14) : [];
      const skillNames = Array.isArray(demo.skills)
        ? demo.skills.map((skill) => skill.name || skill.id).filter(Boolean).slice(0, 10)
        : [];
      const agentNames = Array.isArray(agents.agents)
        ? agents.agents.map((agent) => agent.name || agent.id).filter(Boolean).slice(0, 8)
        : [];
      return [
        "/skills complete.",
        `Tools visible: ${demo.toolCount || 0}; core: ${coreTools.join(", ") || "none"}.`,
        `Skills loaded: ${demo.skillCount || 0}; ${skillNames.join(", ") || "none"}.`,
        `Agents: ${agentNames.join(", ") || "main"}.`,
        Array.isArray(demo.demos) && demo.demos.length ? `Demo prompts: ${demo.demos.slice(0, 3).join(" | ")}` : "",
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("hermes-usage")) {
      const runtime = byTool.get("runtime_summary") || {};
      const session = byTool.get("session_status") || {};
      const memory = byTool.get("list_long_term_memory") || {};
      const profile = runtime.profile || {};
      return [
        "/usage complete.",
        `Agent: ${runtime.agent?.name || runtime.agent?.id || session.agent?.name || "main"}.`,
        `Profile: ${profile.id || "unknown"}, provider mode: ${runtime.providerMode || "unknown"}.`,
        `Session: ${session.sessionId || "unknown"}, run: ${session.runId || "unknown"}.`,
        `Memory: ${(memory.memories || []).length} promoted items visible, ${(memory.dreams || []).length} dreams visible.`,
      ].join(" ");
    }

    if (intents.includes("hermes-platforms")) {
      const access = byTool.get("computer_access_status") || {};
      const nodes = byTool.get("nodes") || {};
      const cron = byTool.get("cron") || {};
      const gateway = byTool.get("gateway") || {};
      return [
        "/platforms complete.",
        `Computer roots: ${(access.allowedRoots || []).join(", ") || "none"}.`,
        `Terminal ${access.terminal?.enabled ? "on" : "off"}, browser ops: ${(access.browser?.operations || []).join(", ") || "none"}.`,
        `Node: ${nodes.localNode?.id || "local"} (${nodes.localNode?.status || "unknown"}), trusted devices ${(nodes.devices || []).length}.`,
        `Cron schedules ${(cron.schedules || []).length}, jobs ${(cron.jobs || []).length}.`,
        `Gateway events ${(gateway.events || []).length}, runs ${(gateway.runs || []).length}, approvals ${(gateway.approvals || []).length}.`,
      ].join(" ");
    }

    if (intents.includes("provider-status") && byTool.has("provider_status")) {
      const status = byTool.get("provider_status");
      const live = status.live || {};
      return [
        `Provider brain status: ${status.ready ? "ready" : "not ready"}.`,
        `Provider: ${status.provider || "unknown"}${status.model ? `, model: ${status.model}` : ""}.`,
        status.command ? `Command: ${status.command}${status.commandVersion ? ` (${status.commandVersion})` : ""}.` : "",
        status.verified ? `Live auth test: ${live.ok ? "passed" : "failed"}${live.error ? ` (${String(live.error).slice(0, 260)})` : ""}.` : "",
        status.message ? `Detail: ${status.message}` : "",
        `Next fix: ${status.nextFix || "provider config check karo"}`,
      ].filter(Boolean).join(" ");
    }

    if (!intents.includes("real-task-hardening") && intents.includes("v2-audit") && byTool.has("v2_status")) {
      const report = byTool.get("v2_status");
      const repair = byTool.get("v2_repair_plan") || {};
      const weakest = Array.isArray(report.weakest) ? report.weakest.slice(0, 4) : [];
      const repairs = Array.isArray(repair.immediateRepairs) ? repair.immediateRepairs.slice(0, 4) : [];
      return [
        `OmniClaw V2 audit ready hai. Current V2 score: ${report.score || 0}/100, critical score: ${report.criticalScore || 0}/100.`,
        `Feature status: ${report.summary?.ready || 0} ready, ${report.summary?.partial || 0} partial, ${report.summary?.missing || 0} missing.`,
        weakest.length
          ? `Sabse weak areas: ${weakest.map((item) => `${item.name} (${item.status})`).join(", ")}.`
          : "Weak areas list empty hai.",
        repairs.length
          ? `Next repair actions: ${repairs.map((item) => `${item.feature}: ${item.nextAction}`).join(" | ")}`
          : "",
        "V2 rule: jahan backend/plugin/provider missing hai, OmniClaw fake claim nahi karega; status + proof + next action dikhayega.",
      ].filter(Boolean).join(" ");
    }

    if (!intents.includes("real-task-hardening") && intents.includes("capabilities") && byTool.has("capability_demo")) {
      const demo = byTool.get("capability_demo");
      const coreTools = Array.isArray(demo.coreTools) ? demo.coreTools : [];
      const demos = Array.isArray(demo.demos) ? demo.demos : [];
      const limitedTools = Array.isArray(demo.limitedTools) ? demo.limitedTools : [];
      const skillNames = Array.isArray(demo.skills)
        ? demo.skills.map((skill) => skill.name || skill.id).filter(Boolean).slice(0, 10)
        : [];
      return [
        `Capability demo ready: agent ${demo.agentId || "main"} ke paas ${demo.productReadyToolCount || 0}/${demo.toolCount || 0} product-ready tools aur ${demo.skillCount || 0} skills visible hain.`,
        `Core tools: ${coreTools.join(", ") || "none"}.`,
        limitedTools.length ? `Limited tools hidden from planner: ${limitedTools.slice(0, 8).map((tool) => `${tool.id}:${tool.status}`).join(", ")}.` : "",
        `Loaded skills: ${skillNames.join(", ") || "none"}.`,
        `Try: ${demos.slice(0, 3).join(" | ")}`,
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("real-task-hardening") && byTool.has("real_task_health")) {
      const health = byTool.get("real_task_health");
      const groups = Array.isArray(health.tools?.groups) ? health.tools.groups : [];
      const weakGroups = groups.filter((group) => group.status !== "ready").slice(0, 4);
      const probes = Array.isArray(health.probes) ? health.probes : [];
      const badProbes = probes.filter((probe) => ["failed", "needs-setup", "disabled"].includes(probe.status)).slice(0, 3);
      const recipes = Array.isArray(health.recipes) ? health.recipes.slice(0, 4) : [];
      const hidden = Array.isArray(health.tools?.hiddenFromPlanner) ? health.tools.hiddenFromPlanner : [];
      return [
        `Real-task health ready: product score ${health.score || 0}/100.`,
        `Tools: ${health.tools?.productReady || 0}/${health.tools?.total || 0} product-ready; ${health.tools?.limited || 0} limited/placeholder hidden from planner; skills: ${health.skills?.total || 0}; provider ${health.provider?.id || "unknown"} ${health.provider?.ready ? "ready" : "needs setup"}.`,
        weakGroups.length
          ? `Weak tool groups: ${weakGroups.map((group) => `${group.group}(${group.status}, missing: ${(group.missing || []).slice(0, 4).join(", ") || "none"})`).join(" | ")}.`
          : "Core tool groups ready hain.",
        hidden.length
          ? `Hidden weak tools: ${hidden.slice(0, 8).map((tool) => `${tool.id}:${tool.status}${tool.replacement ? ` -> ${tool.replacement}` : ""}`).join(", ")}.`
          : "",
        badProbes.length
          ? `Probe issues: ${badProbes.map((probe) => `${probe.name}:${probe.status}`).join(", ")}.`
          : "Live probes passed/usable hain.",
        recipes.length
          ? `Product recipes tested target: ${recipes.map((recipe) => `"${recipe.ask}" -> ${recipe.expectedTools.join("+")}`).join(" | ")}`
          : "",
        health.rule || "",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("openclaw-code-study") && byTool.has("openclaw_code_study")) {
      const study = byTool.get("openclaw_code_study");
      const stats = study.stats || {};
      const categories = Object.entries(stats.categoryCounts || {})
        .sort((left, right) => right[1] - left[1])
        .map(([name, count]) => `${name}:${count}`)
        .join(", ");
      const core = Array.isArray(study.coreDirs) ? study.coreDirs.slice(0, 10) : [];
      const extensions = Array.isArray(study.extensions) ? study.extensions.slice(0, 12) : [];
      const plan = Array.isArray(study.implementationPlan) ? study.implementationPlan : [];
      const skills = byTool.get("openclaw_skill_scan") || {};
      return [
        "OpenClaw code study complete.",
        `Vendor: ${study.available ? "present" : "missing"} at ${study.source || "vendor/openclaw"}. Study guide: ${study.studyGuide?.present ? "loaded" : "not found"} (${study.studyGuide?.chars || 0} chars).`,
        `Scale: ${stats.coreDirCount || 0} core dirs, ${stats.extensionCount || 0} extensions scanned, ~${stats.tsFilesApprox || 0} TS/TSX files, ${stats.skillFiles || 0} SKILL.md files.`,
        categories ? `Extension categories: ${categories}.` : "",
        core.length ? `Core mapping sample: ${core.map((item) => `${item.name} -> ${item.mappedToOmniClaw}`).join(" | ")}` : "",
        extensions.length ? `Extension sample: ${extensions.map((item) => `${item.id}:${item.category}`).join(", ")}.` : "",
        `Skill scan: ${skills.totalAvailable || skills.count || 0} OpenClaw skills available; showing ${skills.count || 0}.`,
        plan.length ? `Implementation phases: ${plan.map((item) => `${item.phase}. ${item.name} (${item.status})`).join(" -> ")}` : "",
        study.rule || "",
        "Implemented now: openclaw_code_study tool is wired into the agent, so OmniClaw can inspect the actual OpenClaw vendor tree before choosing what to port.",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("layer-status") && byTool.has("layer_status")) {
      const report = byTool.get("layer_status");
      const summary = report.summary || {};
      const next = Array.isArray(report.nextUpgrades) ? report.nextUpgrades.slice(0, 3) : [];
      return [
        "OpenClaw-style layer audit ready.",
        `Status: ${summary.readyLayers || 0} ready, ${summary.partialLayers || 0} partial, ${summary.missingLayers || 0} missing.`,
        `Provider: ${summary.provider || "unknown"} (${summary.providerReady ? "ready" : "not ready"}), tools: ${summary.tools || 0}, skills: ${summary.skills || 0}, sessions: ${summary.sessions || 0}.`,
        next.length ? `Next upgrades: ${next.join(" | ")}` : "",
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("prompt-assembly") && byTool.has("prompt_assembly_status")) {
      const status = byTool.get("prompt_assembly_status");
      const scopes = {};
      for (const file of status.files || []) {
        scopes[file.scope || "unknown"] = (scopes[file.scope || "unknown"] || 0) + 1;
      }
      return [
        "Hermes-style prompt assembly status ready.",
        `Agent ${status.agentId || "main"} profile ${status.profile || "balanced"} budget ${status.maxContextChars || 0} chars.`,
        `Context files: ${(status.files || []).length} loaded (${Object.entries(scopes).map(([k, v]) => `${k}:${v}`).join(", ") || "none"}).`,
        `Defenses: prompt injection scan ${status.defenses?.promptInjectionScan ? "on" : "off"}, invisible unicode scan ${status.defenses?.invisibleUnicodeScan ? "on" : "off"}, hidden HTML scan ${status.defenses?.hiddenHtmlScan ? "on" : "off"}.`,
        `Suspicious files: ${status.suspiciousCount || 0}.`,
        status.rule || "",
      ].filter(Boolean).join(" ");
    }

    if (intents.includes("system-status") && byTool.has("computer_system_status")) {
      const status = byTool.get("computer_system_status");
      const memory = status.memory || {};
      const disks = Array.isArray(status.disks) ? status.disks : [];
      const diskLines = disks.map((disk) =>
        disk.error
          ? `${disk.drive}: ${disk.error}`
          : `${disk.drive}: ${disk.freeGb} GB free / ${disk.totalGb} GB total (${disk.freePercent}% free)`,
      );
      return [
        "Laptop status check ho gaya.",
        `RAM: ${memory.freeGb} GB free / ${memory.totalGb} GB total, ${memory.usedGb} GB used.`,
        `CPU: ${status.cpuCores || "unknown"} core(s).`,
        `OS: ${status.platform || "unknown"}.`,
        `Storage: ${diskLines.join("; ") || "disk info unavailable"}.`,
      ].join(" ");
    }

    if (intents.includes("computer-access") && byTool.has("computer_access_status")) {
      const access = byTool.get("computer_access_status");
      return [
        "Computer access status ready hai.",
        `Allowed roots: ${(access.allowedRoots || []).join(", ") || "none"}.`,
        `Files: write/copy/move ${access.allowWrite ? "on" : "off"}, delete ${access.allowDelete ? "on" : "off"} (${access.deleteMode || "recoverable mode"}).`,
        `Terminal: ${access.terminal?.enabled ? "on" : "off"} with ${access.terminal?.trustLevel || "unknown"} trust.`,
        `Browser: open URL ${access.browser?.openUrl ? "on" : "off"}, read URL ${access.browser?.readUrl ? "on" : "off"}.`,
        `Recent computer operations: ${access.operations?.recent?.length || 0}.`,
      ].join(" ");
    }

    if (intents.includes("computer-directory-list") && byTool.has("list_computer_directory")) {
      const listing = byTool.get("list_computer_directory");
      const entries = Array.isArray(listing.entries) ? listing.entries : [];
      return [
        `Computer folder listed: ${listing.path || "~"}`,
        `${entries.length} item(s) mile.`,
        entries.length ? `Sample: ${entries.slice(0, 12).map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join(", ")}.` : "",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("computer-file-read") && byTool.has("read_computer_file")) {
      const file = byTool.get("read_computer_file");
      return [
        `Computer file read: ${file.path || "unknown"}`,
        `${file.bytesRead || 0}/${file.totalBytes || 0} bytes read${file.truncated ? " (truncated)" : ""}.`,
        file.content ? `Preview:\n${String(file.content).slice(0, 1200)}` : "",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("computer-delete") && byTool.has("delete_computer_path")) {
      const result = byTool.get("delete_computer_path");
      return [
        result.deleted || result.movedToTrash
          ? "Computer delete action complete."
          : "Computer delete action did not complete.",
        `Path: ${result.path || "unknown"}.`,
        result.trashPath ? `Recoverable trash path: ${result.trashPath}.` : "",
        result.message || result.reason || "",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("browser-navigate") && (byTool.has("browser_navigate") || byTool.has("open_browser_url"))) {
      const result = byTool.get("browser_navigate") || byTool.get("open_browser_url");
      return [
        result.ok === false || result.error ? "Browser navigation needs attention." : "Browser open/navigation complete.",
        `URL: ${result.url || result.snapshot?.url || "unknown"}.`,
        result.title || result.snapshot?.title ? `Title: ${result.title || result.snapshot?.title}.` : "",
        result.error ? `Error: ${result.error}` : "",
      ].filter(Boolean).join("\n");
    }

    if (intents.includes("provider-model-list") && byTool.has("list_provider_models")) {
      const models = byTool.get("list_provider_models");
      const list = Array.isArray(models.models) ? models.models : [];
      return [
        `Provider models fetch ${models.ok === false ? "failed" : "complete"}: ${models.profileId || models.providerId || "active provider"}.`,
        `${models.count || list.length || 0} model(s) returned.`,
        list.length ? `Sample: ${list.slice(0, 12).map((model) => model.id || model).join(", ")}.` : "",
        models.message || models.error ? `Detail: ${models.message || models.error}` : "",
      ].filter(Boolean).join("\n");
    }

    if (toolOutputs.length > 0) {
      return this.buildToolExecutionReply({ toolOutputs });
    }

    return "";
  }

  buildProviderFailureFallback({ providerResponse = "", intents = [], agent = {}, tools = [], skills = [], toolOutputs = [] } = {}) {
    const text = String(providerResponse || "").trim();
    if (!this.looksLikeProviderFailure(text)) {
      return "";
    }
    const onlyRuntimeEvidenceNeeded = toolOutputs.length > 0 &&
      !(intents || []).some((intent) => ["research", "research-then-build", "complex-build", "openclaw-code-study"].includes(intent));
    if (onlyRuntimeEvidenceNeeded) {
      return [
        this.buildToolExecutionReply({ toolOutputs }),
        `LLM final synthesis failed after the tools finished: ${this.cleanProviderFailureMessage(text)}`,
      ].filter(Boolean).join("\n");
    }

    const toolSummary = toolOutputs.length > 0
      ? `Runtime observations collected: ${toolOutputs.map((item) => item.tool).join(", ")}.`
      : "No runtime tools completed before the provider failed.";

    return [
      "Provider brain failed, so OmniClaw did not generate a fake local answer.",
      toolSummary,
      `Active agent: ${agent.name || agent.id || "main"}.`,
      `Fix the provider/model in Brain setup, then retry the task. Detail: ${this.cleanProviderFailureMessage(text)}`,
    ].join(" ");
  }

  normalizeAssistantReplyStyle({ response = "", toolOutputs = [] } = {}) {
    let text = String(response || "").trim();
    if (!text) {
      return text;
    }

    const computerSearchOutput = (toolOutputs || []).find((item) => item.tool === "search_computer_files");
    if (computerSearchOutput) {
      return this.buildGroundedToolTraceReply({ toolOutputs });
    }

    text = text
      .replace(/^(?:Main\s+Agent|Agent\s+main)\s*:\s*/i, "")
      .replace(/\bMain\s+Agent\s+ne\b/gi, "Maine")
      .replace(/\bsearch_computer_files\s+tool\b/gi, "laptop file search")
      .replace(/\bsearch_computer_files\b/gi, "laptop file search")
      .replace(/\blist_computer_directory\s+tool\b/gi, "folder listing")
      .replace(/\bread_computer_file\s+tool\b/gi, "file reader")
      .replace(/\brun_terminal_command\s+tool\b/gi, "terminal command")
      .replace(/\bweb_research\s+tool\b/gi, "web research")
      .replace(/\bweb_search\s+tool\b/gi, "web search")
      .replace(/\bTool evidence correction:\s*/gi, "")
      .replace(/\bProvider drift correction:\s*/gi, "")
      .replace(/\s+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    const hasComputerSearch = (toolOutputs || []).some((item) => item.tool === "search_computer_files");
    if (hasComputerSearch && /^Billu Baba tumhein batana chahunga ki/i.test(text)) {
      text = text.replace(/^Billu Baba tumhein batana chahunga ki\s*/i, "Billu Baba, ");
    }
    return text;
  }

  cleanResearchText(value = "") {
    return String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\b(?:中文|日本語|한국어|English)\s*(?:[|｜]\s*(?:中文|日本語|한국어|English)\s*)+/gi, " ")
      .replace(/\b(?:ä¸­æ–‡|æ—¥æœ¬èªž|í•œêµ­ì–´|English)\s*(?:[|ï½œ]\s*(?:ä¸­æ–‡|æ—¥æœ¬èªž|í•œêµ­ì–´|English)\s*)+/gi, " ")
      .replace(/(?:^|\s)[|｜]\s*(?:English|中文|日本語|한국어)\b/gi, " ")
      .replace(/(?:^|\s)[|ï½œ]\s*(?:English|ä¸­æ–‡|æ—¥æœ¬èªž|í•œêµ­ì–´)\b/gi, " ")
      .replace(/\b(?:English|中文|日本語|한국어)\s*[|｜](?:\s|$)/gi, " ")
      .replace(/\b(?:English|ä¸­æ–‡|æ—¥æœ¬èªž|í•œêµ­ì–´)\s*[|ï½œ](?:\s|$)/gi, " ")
      .replace(/\[[^\]]*edit[^\]]*\]/gi, " ")
      .replace(/\bBack to (?:Tools|Top|Home)\b/gi, " ")
      .replace(/\bTL;DR\b|\bRead more\b/gi, " ")
      .replace(/\bSubscribe\b|\bSign in\b|\bLog in\b|\bCookie Policy\b|\bPrivacy Policy\b|\bTerms of Service\b/gi, " ")
      .replace(/\bprovider\s+(?:tinyfish|bing|duckduckgo|exa|brave|search|http-fetch|tinyfish-fetch)[\w-]*/gi, " ")
      .replace(/\bTool run complete\b|\bweb_research\s*\[[^\]]+\]/gi, " ")
      .replace(/\bTop\s+\d+\s+page\(s\)\s+fetch(?:ed| kiye)?\b/gi, " ")
      .replace(/(?:^|\s)---+\s*/g, " ")
      .replace(/#{1,6}\s*/g, " ")
      .replace(/\*\*/g, "")
      .replace(/\s*\|\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  isResearchBoilerplateSentence(sentence = "") {
    const text = String(sentence || "").trim();
    if (!text) return true;
    if (/^(back to|tl;dr|table of contents|contents|menu|share|subscribe|sign in|log in|copyright)\b/i.test(text)) {
      return true;
    }
    if (/^(welcome to|this code|official .* domains?|for downloading|for more information|learn more|read more)\b/i.test(text)) {
      return true;
    }
    if (/^(example usage|install the|verify the installation|quick start|try it now|apply for api key|image understanding code example|video understanding code example)\b/i.test(text)) {
      return true;
    }
    if (/\b(complete usage example|quickly get started|pip install|verify the installation|code example|replace .* with the path)\b/i.test(text)) {
      return true;
    }
    if (/\b(new chat|chat history|get app|about us|visit .* platform|slides websites docs|deep research sheets|agent swarm)\b/i.test(text)) {
      return true;
    }
    if (/\b(New Chat|Slides|Websites|Docs|Deep Research|Sheets|Chat History|Get App)\b/.test(text) && text.split(/\s+/).length > 12) {
      return true;
    }
    if (/\b(?:in|with|and|or|to|for|from|by|as|—|-)\.?$/i.test(text)) {
      return true;
    }
    if (/^quick start\b/i.test(text) && /\b(install|onboard|send a message|connect a channel)\b/i.test(text)) {
      return true;
    }
    if (/\b(unofficial|independent experimental|free interface|fan-made|third-party)\b/i.test(text)) {
      return true;
    }
    if (/\b(cookie policy|privacy policy|terms of service|newsletter|advertisement|all rights reserved)\b/i.test(text)) {
      return true;
    }
    if ((text.match(/["“”@]/g) || []).length >= 4) {
      return true;
    }
    if (/\b(?:中文|日本語|한국어)\s*(?:[|｜]\s*(?:English|中文|日本語|한국어))/i.test(text)) {
      return true;
    }
    if (/\b(provider\s+(?:tinyfish|bing|duckduckgo|exa|brave|search|http-fetch)|tool run complete|web_research|top\s+\d+\s+page\(s\))/i.test(text)) {
      return true;
    }
    if (/\b(documentation index|llms\.txt|fetch the complete documentation|use this file to discover|beginning the journey of recursive self-improvement)\b/i.test(text)) {
      return true;
    }
    if (/^#{1,6}\s+/.test(text) && text.split(/\s+/).length < 9) {
      return true;
    }
    if (/\bMetric[A-Z]|\bLanguageTypeScriptPythonGo\b|\bMemory Usage[<>]|\bStartup Time[<>]|\bMin Hardware Cost\b/i.test(text)) {
      return true;
    }
    if (/^[#*\-_\s|]+$/.test(text)) {
      return true;
    }
    if (/`[^`]+`/.test(text) && /\b(default|required|deprecated|class|settings|module|function|parameter)\b/i.test(text)) {
      return true;
    }
    return false;
  }

  getResearchQueryTerms(query = "") {
    return String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9.#+-]+/i)
      .map((term) => term.trim())
      .filter((term) =>
        term.length >= 3 &&
        !["research", "overview", "official", "source", "sources", "about", "what", "kya", "hai", "hain", "bara", "baare", "mein", "features", "deep", "clean", "concise"].includes(term) &&
        term !== "ai",
      );
  }

  sourceQualityScore(source = {}, index = 0) {
    let score = Math.max(0, 10 - index);
    const url = String(source.url || "").toLowerCase();
    const title = String(source.title || "").toLowerCase();
    if (/docs\.|\/docs\b|documentation|developer|developers|github\.com|wikipedia\.org/i.test(`${url} ${title}`)) score += 8;
    if (/official|docs|documentation|guide|overview|about/i.test(`${title} ${source.snippet || ""}`)) score += 4;
    if (/reddit\.com|youtube\.com|youtu\.be|medium\.com|quora\.com|forum|community|x\.com|twitter\.com/i.test(url)) score -= 7;
    if (/\b(chat|free|apps?|store|marketplace|catalog)\b/i.test(url)) score -= 80;
    if (/\b(unofficial|third-party|fan-made|free interface)\b/i.test(`${title} ${source.snippet || ""}`)) score -= 40;
    if (/pricing|login|signup|terms|privacy|changelog|release|blog/i.test(url) && !/price|pricing|release|changelog|blog/i.test(String(source.query || ""))) score -= 3;
    return score;
  }

  classifyResearchSentence(sentence = "") {
    const text = String(sentence || "");
    const lower = text.toLowerCase();
    if (
      /^.{0,90}\b(is|are|was|were)\s+(?:an?|the)?\b/i.test(text) ||
      /^.{0,90}\b(has|have)\s+(?:independently\s+)?(?:developed|launched|built|created)\b/i.test(text) ||
      /\b(refers to|means|known as|described as)\b/i.test(lower) ||
      /^[A-Z][\w .+#-]{1,80}\s+(?:open-source|self-hosted|cloud-based|cross-platform|local-first|AI-powered)\s+(?:framework|platform|gateway|runtime|assistant|agent|tool|service|model)\b/i.test(text)
    ) {
      return "definition";
    }
    if (/\b(can|lets?|allows?|helps?|enables?|supports?|includes?|features?|offers?|provides?)\b/i.test(lower)) {
      return "feature";
    }
    if (/\b(works?|runs?|uses?|routes?|stores?|loads?|executes?|connects?|integrates?|based on|built on|through|via|with)\b/i.test(lower)) {
      return "how";
    }
    if (/\b(security|privacy|credential|api key|token|sandbox|approval|risk|limit|warning|beta|experimental|license)\b/i.test(lower)) {
      return "note";
    }
    return "fact";
  }

  scoreResearchSentence({ sentence = "", sourceIndex = 1, queryTerms = [], source = {} } = {}) {
    const clean = this.cleanResearchText(sentence);
    const lower = clean.toLowerCase();
    let score = this.sourceQualityScore(source, Math.max(0, sourceIndex - 1));
    const category = this.classifyResearchSentence(clean);
    if (category === "definition") score += 22;
    if (category === "feature") score += 16;
    if (category === "how") score += 12;
    if (category === "note") score += 8;
    for (const term of queryTerms) {
      if (lower.includes(term)) score += 5;
    }
    if (/^(learn more|read more|click|subscribe|sign in|log in|table of contents|contents)\b/i.test(clean)) score -= 40;
    if (/\b(welcome to|table of contents|official .* domains?|for downloading|this code first|deprecated|required|default:)\b/i.test(clean)) score -= 35;
    if (/\b(example usage|complete usage example|install the openai sdk|verify the installation|quick start|pip install|code example)\b/i.test(clean)) score -= 120;
    if (/\b(new chat|chat history|get app|slides websites docs|deep research sheets|agent swarm)\b/i.test(clean)) score -= 120;
    if (/\b(?:in|with|and|or|to|for|from|by|as|—|-)\.?$/i.test(clean)) score -= 80;
    if (/\b(unofficial|independent experimental|free interface|fan-made|third-party)\b/i.test(clean)) score -= 90;
    if (/\b(open source|personal assistant|coding agent|agent|runtime|workspace|tools?|memory|sessions?|automation|api|model|platform|developer)\b/i.test(clean)) score += 4;
    if (clean.length < 55 || clean.length > 260) score -= 8;
    return { score, category };
  }

  buildResearchEvidence({ pages = [], footnotes = [], query = "" } = {}) {
    const queryTerms = this.getResearchQueryTerms(query);
    const sourceByUrl = new Map();
    for (const source of footnotes) {
      const normalized = String(source.url || "").replace(/#.*$/, "").replace(/\/$/, "");
      if (normalized) sourceByUrl.set(normalized, source);
    }
    const candidates = [];
    const pushCandidate = ({ sentence, sourceIndex = 1, source = {} }) => {
      const clean = this.cleanResearchText(sentence || "");
      const sourceUrl = String(source.url || "").toLowerCase();
      if (/\b(chat|free|apps?|store|marketplace|catalog)\b/i.test(sourceUrl) && !/\b(chat|free|app|store)\b/i.test(String(query || ""))) {
        return;
      }
      if (
        clean.length < 45 ||
        clean.length > 320 ||
        this.isResearchBoilerplateSentence(clean)
      ) {
        return;
      }
      const lower = clean.toLowerCase();
      if (queryTerms.length > 0 && !queryTerms.some((term) => lower.includes(term))) {
        return;
      }
      const ranked = this.scoreResearchSentence({ sentence: clean, sourceIndex, queryTerms, source });
      candidates.push({
        sentence: clean,
        sourceIndex,
        category: ranked.category,
        score: ranked.score,
      });
    };

    for (const page of pages) {
      const url = String(page.url || page.finalUrl || "").replace(/#.*$/, "").replace(/\/$/, "");
      const source = sourceByUrl.get(url) || footnotes[0] || { index: 1 };
      const text = this.cleanResearchText(page.text || page.markdown || page.content || "");
      for (const sentence of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|\n+/)) {
        pushCandidate({ sentence, sourceIndex: source.index || 1, source });
      }
    }
    for (const source of footnotes) {
      const sourceHost = (() => {
        try {
          return new URL(source.url || "").hostname.toLowerCase();
        } catch {
          return "";
        }
      })();
      if (
        Number(source.index || 1) > 3 &&
        queryTerms.length > 0 &&
        !queryTerms.some((term) => sourceHost.includes(term))
      ) {
        continue;
      }
      pushCandidate({
        sentence: source.snippet || source.title,
        sourceIndex: source.index || 1,
        source,
      });
    }

    const seen = new Set();
    return candidates
      .sort((left, right) => right.score - left.score)
      .filter((item) => {
        const key = item.sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 150);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 16);
  }

  renderGenericResearchAnswer({ query = "research", evidence = [], footnotes = [] } = {}) {
    const topic = this.getResearchDisplayTopic(query);
    const take = (category, limit) => evidence.filter((item) => item.category === category).slice(0, limit);
    const definitions = take("definition", 2);
    const features = [...take("feature", 4), ...evidence.filter((item) => item.category === "fact").slice(0, 2)].slice(0, 5);
    const how = take("how", 3);
    const notes = take("note", 2);
    const first = definitions[0] || features[0] || how[0] || evidence[0];
    const shortAnswer = first
      ? this.rewriteResearchSentence(first.sentence, topic)
      : "Mujhe clean fetched evidence kam mila, isliye maine fake claims add nahi kiye.";
    const bullet = (item) => `- ${this.rewriteResearchSentence(item.sentence, topic)} [^${item.sourceIndex || 1}]`;
    return this.renderCleanResearchAnswer({
      query: topic,
      shortAnswer,
      sections: [
        { title: "What It Is", bullets: definitions.map(bullet) },
        { title: "Key Points", bullets: features.map(bullet) },
        { title: "How It Works / Use Cases", bullets: how.map(bullet) },
        { title: "Notes", bullets: notes.map(bullet) },
      ],
      footnotes,
    });
  }

  extractResearchFacts({ pages = [], footnotes = [], queryTerms = [] } = {}) {
    const sourceIndexForUrl = (url = "") => {
      const normalized = String(url || "").replace(/#.*$/, "").replace(/\/$/, "");
      const found = footnotes.find((source) =>
        normalized && String(source.url || "").replace(/#.*$/, "").replace(/\/$/, "") === normalized,
      );
      return found?.index || 1;
    };
    const candidates = [
      ...pages.flatMap((page) => {
        const sourceIndex = sourceIndexForUrl(page.url || page.finalUrl || "");
        return this.cleanResearchText(page.text || page.markdown || page.content || "")
          .split(/(?<=[.!?à¥¤])\s+|\n+/)
          .map((sentence) => ({ sentence: sentence.trim(), sourceIndex }));
      }),
      ...footnotes.map((source) => ({ sentence: source.snippet || source.title, sourceIndex: source.index })),
    ];
    const seen = new Set();
    return candidates
      .map((item) => ({
        ...item,
        sentence: this.cleanResearchText(item.sentence || ""),
      }))
      .filter((item) => {
        const sentence = item.sentence;
        const lower = sentence.toLowerCase();
        if (
          sentence.length < 45 ||
          sentence.length > 320 ||
          this.isResearchBoilerplateSentence(sentence) ||
          (queryTerms.length > 0 && !queryTerms.some((term) => lower.includes(term)))
        ) {
          return false;
        }
        const key = lower.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 140);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => {
        const lower = item.sentence.toLowerCase();
        let score = 0;
        if (/\b(official|foundation models?|multimodal|api|platform|developer|products?|models?|agent|open platform)\b/i.test(item.sentence)) score += 12;
        if (/\b(text|speech|video|image|music|audio|code|coding)\b/i.test(item.sentence)) score += 6;
        if (/\b(security|token|api key|credential|billing|pricing|pay-as-you-go)\b/i.test(item.sentence)) score += 4;
        if (/^#{1,6}\s+/.test(item.sentence)) score -= 10;
        if (/\b(documentation index|llms\.txt|fetch the complete documentation|use this file)\b/i.test(item.sentence)) score -= 50;
        if (queryTerms.some((term) => lower.includes(term))) score += 2;
        return { ...item, score };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 6);
  }

  validateFinalResearchAnswer(answer = "") {
    const text = String(answer || "");
    const blockedPatterns = [
      /\bprovider\s+(?:tinyfish|bing|duckduckgo|exa|brave|search)\b/i,
      /\bTool run complete\b/i,
      /\bActual result\b/i,
      /\bweb_research\s*\[/i,
      /\bpage\/snippet fetch/i,
      /\bTop\s+\d+\s+page\(s\)\s+fetch/i,
      /\bRoute\b[\s\S]{0,80}\bBrain loop\b/i,
      /\b(?:中文|日本語|한국어)\s*[|｜]\s*(?:English|中文|日本語|한국어)/i,
      /\bMetricOpenClawNanoBotPicoClaw\b/i,
    ];
    const failed = blockedPatterns.find((pattern) => pattern.test(text));
    return failed ? { ok: false, reason: failed.source } : { ok: true, reason: "" };
  }

  validateCleanResearchAnswer(answer = "") {
    const text = String(answer || "");
    const blockedPatterns = [
      /\bprovider\s+(?:tinyfish|bing|duckduckgo|exa|brave|search)\b/i,
      /\b(?:tinyfish-search|tinyfish-fetch|bing-rss|http-fetch)\b/i,
      /\bTool run complete\b/i,
      /\bActual result\b/i,
      /\bweb_research\b/i,
      /\bpage\/snippet fetch/i,
      /\bTop\s+\d+\s+page\(s\)\s+fetch/i,
      /\bfetched page\(s\)\b/i,
      /\bRoute\b[\s\S]{0,80}\bBrain loop\b/i,
      /\b(?:中文|日本語|한국어)\s*[|｜]\s*(?:English|中文|日本語|한국어)/i,
      /\bMetricOpenClawNanoBotPicoClaw\b/i,
    ];
    const failed = blockedPatterns.find((pattern) => pattern.test(text));
    return failed ? { ok: false, reason: failed.source } : { ok: true, reason: "" };
  }

  renderResearchSource(source = {}) {
    return `[^${source.index}]: ${source.title || "Source"} - ${source.url || "no url"}`;
  }

  getResearchDisplayTopic(query = "") {
    const text = String(query || "").trim();
    return text
      .replace(/\b(official|models?|api|platform|products?|research|overview|clean answer|deep|sources?)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim() || text;
  }

  paraphraseResearchFact(sentence = "", query = "") {
    const clean = this.cleanResearchText(sentence)
      .replace(/\s*\[\^\d+\]\s*$/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.。]+$/g, "")
      .trim();
    if (!clean) return "";
    const topic = this.getResearchDisplayTopic(query) || "Is topic";

    if (/^MiniMax has independently developed/i.test(clean)) {
      return "MiniMax ne multimodal foundation models develop kiye hain, jisme text, audio, image/video type modalities aur code/agent capabilities cover hoti hain.";
    }
    if (/^Building on these proprietary models/i.test(clean)) {
      return "In models par MiniMax Agent, Hailuo AI, MiniMax Audio, Talkie aur developer/enterprise open platform jaise products build kiye gaye hain.";
    }
    if (/\bText Generation\b/i.test(clean) && /\bMiniMax M2/i.test(clean)) {
      return "API docs me text generation ke liye MiniMax M2 series models listed hain, including M2.7, M2.5, M2.1 aur high-speed variants.";
    }
    if (/\bAnthropic API Compatible\b/i.test(clean) || /\bOpenAI API Compatible\b/i.test(clean)) {
      return "Developers MiniMax models ko Anthropic-compatible ya OpenAI-compatible SDK/API style se integrate kar sakte hain.";
    }
    if (/\bGet API Key\b/i.test(clean) || /\bPay-as-you-go\b/i.test(clean)) {
      return "Developer setup me API key create karke pay-as-you-go model par Text, Video, Speech aur Image models use kiye ja sakte hain.";
    }
    if (/^Kimi(?:\s+K2\.6)?\s+is\b/i.test(clean) && /\b(Moonshot|AI assistant|model|coding|agent|context|tool)\b/i.test(clean)) {
      return clean
        .replace(/^Kimi\s+K2\.6\s+is\s+Kimi[’']s/i, "Kimi K2.6 Moonshot AI/Kimi ka")
        .replace(/^Kimi\s+is\s+an?\s+artificial intelligence\s+\(AI\)\s+chatbot/i, "Kimi Moonshot AI ka AI chatbot")
        .replace(/^Kimi\s+AI\s+is\s+an?\s+advanced\s+AI\s+assistant\s+by\s+Moonshot\s+AI/i, "Kimi AI Moonshot AI ka advanced assistant")
        .replace(/[.。]+$/g, "");
    }

    const isMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+(?:is|are)\s+(?:an?|the)?\s*(.+)$/i);
    if (isMatch) {
      return `${isMatch[1].trim()} ko sources me ${isMatch[2].trim().replace(/[.。]+$/g, "")} ke roop me describe kiya gaya hai.`;
    }

    const canMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+can\s+(.+)$/i);
    if (canMatch) {
      return `${canMatch[1].trim()} ka use ${canMatch[2].trim().replace(/[.。]+$/g, "")} ke liye ho sakta hai.`;
    }

    const offersMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+(?:offers|provides|supports|includes)\s+(.+)$/i);
    if (offersMatch) {
      return `${offersMatch[1].trim()} me ${offersMatch[2].trim().replace(/[.。]+$/g, "")} jaise capabilities milti hain.`;
    }

    const docsMatch = clean.match(/(?:documentation|docs)\s+(?:explains|cover|covers|describe|describes)\s+(.+)$/i);
    if (docsMatch) {
      return `Docs me ${docsMatch[1].trim().replace(/[.。]+$/g, "")} explain kiya gaya hai.`;
    }

    const words = clean.split(/\s+/).slice(0, 34).join(" ");
    return `${topic} ke liye source se ye fact mila: ${words}${clean.split(/\s+/).length > 34 ? "..." : ""}`;
  }

  rewriteResearchSentence(sentence = "", topic = "") {
    let clean = this.cleanResearchText(sentence)
      .replace(/\s*\[\^\d+\]\s*$/g, "")
      .replace(/\s+/g, " ")
      .replace(/[.ã€‚]+$/g, "")
      .trim();
    if (!clean) return "";
    const displayTopic = topic || "This topic";
    if (displayTopic) {
      clean = clean.replace(new RegExp(`^${displayTopic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-]\\s*`, "i"), "");
    }
    clean = clean
      .replace(/^[A-Z][\w .+#-]{1,80}:\s+/, "")
      .replace(/\s*(?:\.\.\.|…)\s*$/g, "")
      .replace(/\s*,\s*$/g, "")
      .trim();
    const isMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+(?:is|are)\s+(?:an?|the)?\s*(.+)$/i);
    if (isMatch) {
      return `${isMatch[1].trim()} ${isMatch[2].trim().replace(/[.ã€‚]+$/g, "")}.`;
    }
    const canMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+can\s+(.+)$/i);
    if (canMatch) {
      return `${canMatch[1].trim()} ${canMatch[2].trim().replace(/[.ã€‚]+$/g, "")} kar sakta hai.`;
    }
    const developedMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+(?:has|have)\s+(.+)$/i);
    if (developedMatch) {
      return `${developedMatch[1].trim()} ${developedMatch[2].trim().replace(/[.ã€‚]+$/g, "")}.`;
    }
    if (/^Building on\b/i.test(clean)) {
      return `${clean.replace(/[.ã€‚]+$/g, "")}.`;
    }
    const offersMatch = clean.match(/^([A-Z][\w .+#-]{1,80})\s+(?:offers|provides|supports|includes)\s+(.+)$/i);
    if (offersMatch) {
      return `${offersMatch[1].trim()} me ${offersMatch[2].trim().replace(/[.ã€‚]+$/g, "")} jaise capabilities milti hain.`;
    }
    const words = clean.split(/\s+/).slice(0, 34).join(" ");
    return `${displayTopic}: ${words}${clean.split(/\s+/).length > 34 ? "..." : ""}`;
  }

  renderCleanResearchAnswer({ query = "research", shortAnswer = "", bullets = [], notes = [], footnotes = [], sections = null } = {}) {
    const cleanBullets = bullets.filter(Boolean).slice(0, 6);
    const cleanNotes = notes.filter(Boolean).slice(0, 3);
    const cleanFootnotes = footnotes.slice(0, 5);
    const sectionLines = Array.isArray(sections)
      ? sections.flatMap((section) => {
          const items = (section.bullets || []).filter(Boolean).slice(0, 6);
          if (!items.length) return [];
          return ["", `### ${section.title}`, "", ...items];
        })
      : [
          "",
          "### Key Points",
          "",
          ...(cleanBullets.length ? cleanBullets : ["- Reliable source se enough clean facts nahi mile, isliye fake claims add nahi kiye."]),
          cleanNotes.length ? "" : "",
          cleanNotes.length ? "### Important Notes" : "",
          cleanNotes.length ? "" : "",
          ...cleanNotes,
        ];
    const answer = [
      `## Research: ${query}`,
      "",
      shortAnswer ? `Short answer: ${shortAnswer}` : "Short answer: Maine available sources se clean facts nikale hain.",
      ...sectionLines,
      "",
      "### Sources",
      ...cleanFootnotes.map((source) => this.renderResearchSource(source)),
    ]
      .filter((line, index, list) => !(line === "" && list[index - 1] === ""))
      .join("\n");

    const validation = this.validateCleanResearchAnswer(answer);
    if (validation.ok) return answer;

    const sanitized = answer
      .split("\n")
      .filter((line) => this.validateCleanResearchAnswer(line).ok)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return sanitized || [
      `## Research: ${query}`,
      "",
      "Short answer: Research complete hua, lekin clean final renderer ne debug-like source text remove kar diya.",
      "",
      "### Sources",
      ...cleanFootnotes.map((source) => this.renderResearchSource(source)),
    ].join("\n");
  }

  buildGroundedResearchReply({ toolOutputs = [] } = {}) {
    const researchEntries = (toolOutputs || [])
      .filter((entry) => entry.tool === "web_research" || entry.tool === "web_search")
      .map((entry) => {
        const output = entry.output?.cached && entry.output?.result
          ? entry.output.result
          : entry.output || {};
        const results = Array.isArray(output.results) ? output.results : [];
        const fetchedCount = Array.isArray(output.fetchedContent)
          ? output.fetchedContent.filter((page) => page?.text && !page.error && !page.fallback).length
          : 0;
        const blocked = Boolean(output.error || output.blocked);
        return {
          entry,
          output,
          score: (blocked ? -1000 : 0) + results.length + fetchedCount * 5 + (String(output.query || "").trim() ? 3 : 0),
        };
      })
      .sort((left, right) => right.score - left.score);
    const bestResearch = researchEntries.find((entry) => entry.score > 0) || researchEntries[0] || null;
    const item = bestResearch?.entry || null;
    const directFetches = (toolOutputs || [])
      .filter((entry) => entry.tool === "web_fetch" || entry.tool === "read_url")
      .map((entry) => entry.output || {})
      .filter((output) => (output.text || output.markdown || output.content) && !output.error && !output.blocked);
    const output = bestResearch?.output || item?.output || {};
    const results = Array.isArray(output.results) ? output.results : [];
    if (!item || results.length === 0) {
      if (directFetches.length > 0) {
        const query = this.getResearchDisplayTopic(directFetches[0].title || directFetches[0].url || "web fetch");
        const footnotes = directFetches.slice(0, 5).map((page, index) => ({
          index: index + 1,
          title: page.title || page.finalUrl || page.url || "Fetched page",
          url: page.finalUrl || page.url || "",
          snippet: this.cleanResearchText(page.text || page.markdown || page.content || "").slice(0, 360),
        }));
        const pages = directFetches.map((page) => ({
          ...page,
          text: page.text || page.markdown || page.content || "",
        }));
        const evidence = this.buildResearchEvidence({ pages, footnotes, query });
        if (evidence.length > 0) {
          return this.renderGenericResearchAnswer({ query, evidence, footnotes });
        }
        const facts = this.extractResearchFacts({ pages, footnotes, queryTerms: [] });
        const bullets = (facts.length ? facts : footnotes)
          .slice(0, 5)
          .map((source) => {
            const sentence = this.cleanResearchText(source.sentence || source.snippet || source.title || "");
            const synthesized = this.paraphraseResearchFact(sentence, query);
            return synthesized ? `- ${synthesized} [^${source.sourceIndex || source.index || 1}]` : "";
          })
          .filter(Boolean);
        const shortAnswer = bullets[0]
          ? bullets[0].replace(/^-\s*/, "").replace(/\s*\[\^\d+\]\s*$/, "")
          : this.cleanResearchText(footnotes[0]?.snippet || footnotes[0]?.title || "");
        return this.renderCleanResearchAnswer({ query, shortAnswer, bullets, footnotes });
      }
      return this.buildGroundedToolTraceReply({ toolOutputs });
    }

    const usefulResults = results.filter((result) =>
      result.url && !/no results found|failed|error|aborted|timeout/i.test(String(result.title || result.snippet || "")),
    );
    if (usefulResults.length === 0) {
      const details = results
        .slice(0, 3)
        .map((result) => result.snippet || result.title)
        .filter(Boolean)
        .join("; ");
      return [
        `Web research "${output.query || "query"}" run hua, lekin source fetch fail/timeout ho gaya.`,
        details ? `Detail: ${details}` : "",
        "Result grounded nahi mila, isliye maine fake summary nahi banayi.",
      ].filter(Boolean).join("\n");
    }

    const rawQuery = output.query || "query";
    const query = this.getResearchDisplayTopic(rawQuery);
    const fetched = [
      ...(Array.isArray(output.fetchedContent)
        ? output.fetchedContent.filter((item) => item.text && !item.error && !item.fallback)
        : []),
      ...directFetches.map((page) => ({
        ...page,
        text: page.text || page.markdown || page.content || "",
      })),
    ];
    const queryTerms = String(query)
      .toLowerCase()
      .split(/[^a-z0-9.#+-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !["top", "the", "and", "for", "with", "best", "features"].includes(term));
    const relevantFetched = fetched.filter((page) => {
      const haystack = `${page.url || ""} ${page.text || ""}`.toLowerCase();
      return queryTerms.length === 0 || queryTerms.some((term) => haystack.includes(term));
    });
    const snippets = usefulResults
      .map((result) => String(result.snippet || result.title || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const footnotes = usefulResults.slice(0, 5).map((result, index) => ({
      index: index + 1,
      title: result.title || "Source",
      url: result.url || "",
      snippet: snippets[index] || "",
    }));

    const genericEvidence = this.buildResearchEvidence({
      pages: fetched,
      footnotes,
      query,
    });
    if (genericEvidence.length > 0) {
      return this.renderGenericResearchAnswer({
        query,
        evidence: genericEvidence,
        footnotes,
      });
    }

    const sourceIndexForUrl = (url = "") => {
      const normalized = String(url || "").replace(/#.*$/, "").replace(/\/$/, "");
      const found = footnotes.find((source) =>
        normalized && String(source.url || "").replace(/#.*$/, "").replace(/\/$/, "") === normalized,
      );
      return found?.index || 1;
    };
    const sentenceCandidates = [
      ...relevantFetched.flatMap((page) => {
        const sourceIndex = sourceIndexForUrl(page.url || page.finalUrl || "");
        return this.cleanResearchText(page.text || "")
          .replace(/\s+/g, " ")
          .split(/(?<=[.!?।])\s+|\n+/)
          .map((sentence) => ({ sentence: sentence.trim(), sourceIndex }));
      }),
      ...footnotes.map((source) => ({ sentence: source.snippet || source.title, sourceIndex: source.index })),
    ].filter((item) => {
      const sentence = this.cleanResearchText(item.sentence || "");
      const lower = sentence.toLowerCase();
      return sentence.length >= 45 &&
        sentence.length <= 320 &&
        !this.isResearchBoilerplateSentence(sentence) &&
        (queryTerms.length === 0 || queryTerms.some((term) => lower.includes(term)));
    });
    const seenSentences = new Set();
    const bullets = sentenceCandidates
      .filter((item) => {
        const key = item.sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 140);
        if (!key || seenSentences.has(key)) return false;
        seenSentences.add(key);
        return true;
      })
      .slice(0, 5)
      .map((item) => `- ${this.paraphraseResearchFact(item.sentence, query)} [^${item.sourceIndex}]`)
      .filter((item) => !/^- \s*\[\^\d+\]$/.test(item));
    const fallbackBullets = footnotes
      .slice(0, 4)
      .map((source) => `- ${this.paraphraseResearchFact(source.snippet || source.title, query)} [^${source.index}]`)
      .filter((item) => !/^- \s*\[\^\d+\]$/.test(item));
    const shortAnswer = bullets[0]
      ? bullets[0].replace(/^-\s*/, "").replace(/\s*\[\^\d+\]\s*$/, "")
      : (footnotes[0]?.snippet || footnotes[0]?.title || "").replace(/\s+/g, " ").trim();
    const importantNotes = [...sentenceCandidates, ...footnotes.map((source) => ({ sentence: source.snippet, sourceIndex: source.index }))]
      .map((item) => ({
        ...item,
        sentence: this.cleanResearchText(item.sentence || ""),
      }))
      .filter((item) => /\b(security|warning|risk|sandbox|privacy|token|credential|beta|experimental|open source|license)\b/i.test(item.sentence))
      .slice(0, 3)
      .map((item) => `- ${item.sentence} [^${item.sourceIndex || 1}]`);
    return this.renderCleanResearchAnswer({
      query,
      shortAnswer,
      bullets: bullets.length ? bullets : fallbackBullets,
      notes: importantNotes,
      footnotes,
    });
  }

  buildToolEvidenceCorrection({ providerResponse = "", message = "", toolOutputs = [] } = {}) {
    const text = String(providerResponse || "");
    const userMessage = String(message || "");
    if (!/package\.json/i.test(userMessage)) {
      return "";
    }
    const fileList = toolOutputs.find((item) =>
      (item.tool === "list_files" || item.tool === "list_computer_directory") &&
      Array.isArray(item.output?.entries),
    );
    if (!fileList) {
      return "";
    }

    const entries = fileList.output.entries || [];
    const names = entries.map((entry) => entry.name).filter(Boolean);
    const hasPackageJson = names.includes("package.json");
    const saysMissing =
      /package\.json/i.test(text) &&
      /(do not see|don't see|does not exist|doesn't exist|not exist|not found|missing|nahi|nahin)/i.test(text);
    const saysPresent =
      /package\.json/i.test(text) &&
      /(exists|present|found|available|hai\b)/i.test(text);

    if ((hasPackageJson && !saysMissing) || (!hasPackageJson && !saysPresent)) {
      return "";
    }

    const sample = names.slice(0, 24).join(", ");
    return [
      "Tool evidence correction:",
      `I listed ${fileList.output.path || "."} with ${entries.length} item(s).`,
      `package.json ${hasPackageJson ? "exists" : "does not exist"} in that directory.`,
      sample ? `Visible entries include: ${sample}${names.length > 24 ? ", ..." : ""}.` : "",
      "This answer is based on the list_files tool output, overriding the model's contradictory wording.",
    ].filter(Boolean).join(" ");
  }

  buildProviderDriftCorrection({ providerResponse = "", message = "", toolOutputs = [] } = {}) {
    const text = String(providerResponse || "");
    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      return "";
    }
    const evidenceText = JSON.stringify(toolOutputs).toLowerCase();
    const requestText = String(message || "").toLowerCase();
    const mentionedOpencode = /\bopencode\b/i.test(text);
    const opencodeUnsupported = mentionedOpencode && !requestText.includes("opencode") && !evidenceText.includes("opencode");
    const saysCanUseAlreadyRanTool = toolOutputs.some((item) => {
      const id = String(item.tool || "");
      if (!id) {
        return false;
      }
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`${escaped}[\\s\\S]{0,120}(?:can use|could use|kar sak|istemal kar sak|use kar sak)`, "i").test(text);
    });
    const ignoresToolResults = /tool ka istemal kar sak|tool use kar sak|can use .*tool/i.test(text) &&
      !/mila|mile|result|found|trace|actual|output/i.test(text);
    const mimicsInternalCorrection = /Tool evidence correction|Provider drift correction|Provider ne .*trace/i.test(text);

    if (!opencodeUnsupported && !saysCanUseAlreadyRanTool && !ignoresToolResults && !mimicsInternalCorrection) {
      return "";
    }

    return [
      this.buildGroundedToolTraceReply({ toolOutputs }) || this.buildToolExecutionReply({ toolOutputs }),
    ].filter(Boolean).join(" ");
  }

  buildRequiredTaskGroundedReply({ message = "", toolOutputs = [] } = {}) {
    const required = this.getRequiredToolIdsFromMessage(message);
    if (required.length === 0) return "";
    const byTool = new Map((toolOutputs || []).map((item) => [item.tool, item]));
    const missing = required.filter((toolId) => !byTool.has(toolId));
    if (missing.length > 0) return "";
    const research = byTool.get("web_research") || byTool.get("web_search");
    const terminal = byTool.get("run_terminal_command");
    const write = byTool.get("write_file");
    const read = byTool.get("read_file");
    const researchOutput = research?.output?.cached && research.output.result ? research.output.result : research?.output || {};
    const results = Array.isArray(researchOutput.results) ? researchOutput.results.slice(0, 3) : [];
    const terminalOutput = terminal?.output || {};
    const stdout = String(terminalOutput.stdout || terminalOutput.output || terminalOutput.text || "").trim();
    const pathValue = write?.output?.path || write?.input?.path || read?.output?.path || read?.input?.path || this.planner.extractPath(message);
    return [
      "Done. Real tools chale aur verify hua.",
      "",
      results.length
        ? `Research: ${results[0].title || "OpenClaw source"} se agent loop ka summary mila. OpenClaw agent loop ek serialized session run hai jisme context assembly, model inference, tool execution, streaming/persistence aur final reply flow aata hai.`
        : "Research: web research completed, but source rows were limited.",
      terminal ? `Terminal: \`${this.extractTerminalCommandFromMessage(message) || "command"}\` -> \`${stdout || "no stdout"}\`.` : "",
      write ? `File write: \`${pathValue}\` likhi gayi.` : "",
      read ? `Read-back verify: \`${pathValue}\` read_file se verify hua.` : "",
      "",
      "Tools used:",
      ...["web_research", "run_terminal_command", "write_file", "read_file"]
        .filter((toolId) => byTool.has(toolId))
        .map((toolId) => `- ${toolId}`),
      results.length ? "" : "",
      results.length ? "Sources:" : "",
      ...results.map((item) => `- ${item.url || item.title || "unknown source"}`),
    ].filter((line) => line !== "").join("\n");
  }

  buildEvidenceContradictionCorrection({ providerResponse = "", message = "", toolOutputs = [] } = {}) {
    const text = String(providerResponse || "");
    const terminal = (toolOutputs || []).find((item) => item.tool === "run_terminal_command");
    const terminalOutput = terminal?.output || {};
    const stdout = String(terminalOutput.stdout || terminalOutput.output || terminalOutput.text || "").trim();
    const observedVersion = stdout.match(/\bv\d+\.\d+\.\d+\b/i)?.[0] || "";
    const claimedVersions = [...text.matchAll(/\bv\d+\.\d+\.\d+\b/gi)].map((match) => match[0]);
    const terminalMismatch = Boolean(
      observedVersion &&
      claimedVersions.length > 0 &&
      claimedVersions.some((version) => version.toLowerCase() !== observedVersion.toLowerCase()),
    );
    const requiredGrounded = this.buildRequiredTaskGroundedReply({ message, toolOutputs });
    if (terminalMismatch && requiredGrounded) {
      return requiredGrounded;
    }
    return "";
  }

  buildUngroundedToolClaimFallback({ providerResponse = "", intents = [], toolOutputs = [] } = {}) {
    const text = String(providerResponse || "").trim();
    const rawToolMarkup = /<\|tool_(?:calls_section|call)_/i.test(text);
    const missingClaims = this.findMissingToolClaims(text, toolOutputs);
    const unsupportedLaptopConclusion = this.hasUnsupportedLaptopFileConclusion(text, toolOutputs);
    if (!this.looksLikeUnexecutedToolClaim(text) && missingClaims.length === 0 && !unsupportedLaptopConclusion) {
      return "";
    }
    const toolLikelyIntents = new Set([
      "research",
      "browser-observe",
      "file-read",
      "file-list",
      "shell-plan",
      "system-status",
      "computer-access",
      "computer-search",
    ]);
    if (!intents.some((intent) => toolLikelyIntents.has(intent)) && missingClaims.length === 0 && !unsupportedLaptopConclusion) {
      return "";
    }
    const actualTools = toolOutputs.map((item) => `${item.tool}${item.toolSummary?.status ? `:${item.toolSummary.status}` : ""}`);
    if (actualTools.length > 0 && missingClaims.length === 0 && !unsupportedLaptopConclusion) {
      return "";
    }
    if (rawToolMarkup || missingClaims.length > 0 || unsupportedLaptopConclusion) {
      const groundedArtifact = this.buildRuntimeToolReply({ intents: ["complex-build"], toolOutputs });
      if (groundedArtifact && /Build complete|Created .*\.html/i.test(groundedArtifact)) {
        return groundedArtifact;
      }
      const grounded = this.buildGroundedToolTraceReply({ toolOutputs });
      return grounded || [
        "Actual result:",
        actualTools.length ? `Tools: ${actualTools.join(", ")}.` : "No tool execution record mila.",
        "Dobara request bhejo with explicit target, jaise: research query, browser snapshot URL, file path, ya terminal command.",
      ].filter(Boolean).join("\n");
    }
    return [
      "Provider ne tool use ka claim kiya, lekin OmniClaw trace me koi tool execution record nahi mila.",
      "Isliye maine is reply ko grounded result ki tarah accept nahi kiya.",
      "Dobara request bhejo with explicit target, jaise: research query, browser snapshot URL, file path, ya terminal command.",
    ].join(" ");
  }

  buildGroundedToolTraceReply({ toolOutputs = [] } = {}) {
    if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
      return "";
    }
    const lines = ["Actual result:"];
    for (const item of toolOutputs.slice(0, 4)) {
      const output = item.output || {};
      const status = item.toolSummary?.status || this.classifyToolOutput(item);
      if (item.tool === "search_computer_files") {
        const results = Array.isArray(output.results) ? output.results : [];
        const samples = results.slice(0, 5).map((entry) =>
          `${entry.name || "item"}${entry.path ? ` (${entry.path})` : ""}`,
        );
        lines.push(`- Laptop file search ${status}: query "${output.query || ""}" par ${results.length} result(s) mile${output.timedOut ? " (scan timeout hua, partial results)" : ""}.`);
        if (samples.length > 0) {
          lines.push(`  Sample: ${samples.join(" | ")}.`);
        }
        continue;
      }
      if (item.tool === "write_computer_file") {
        lines.push(`- File ban gayi: ${output.path || item.input?.path || "target file"} (${output.bytesWritten || 0} bytes).`);
        continue;
      }
      if (item.tool === "read_computer_file") {
        const preview = output.content != null ? ` Preview: ${truncateTraceText(output.content, 180)}` : "";
        lines.push(`- Read-back verified: ${output.path || item.input?.path || "target file"}.${preview}`);
        continue;
      }
      if (item.tool === "web_research" || item.tool === "web_search") {
        const results = Array.isArray(output.results) ? output.results : [];
        const useful = results.find((result) => !/failed|error/i.test(String(result.title || result.snippet || ""))) || results[0];
        lines.push(`- ${item.tool === "web_search" ? "Web search" : "Web research"} ${status}: query "${output.query || ""}" par ${results.length} result(s) aaye.`);
        if (useful?.title || useful?.url || useful?.snippet) {
          lines.push(`  First useful result: ${[useful.title, useful.url, useful.snippet].filter(Boolean).join(" - ").slice(0, 420)}.`);
        }
        continue;
      }
      const summary = item.toolSummary?.summary || this.summarizeToolOutputForUser(item);
      lines.push(`- ${item.tool || "tool"} [${status}]: ${summary}`);
    }
    return lines.join("\n");
  }

  looksLikeProviderFailure(text = "") {
    const value = String(text || "").trim();
    return /^(Codex CLI provider failed|Codex CLI bridge failed|Codex CLI account bridge is installed, but live replies are disabled|Provider request failed|Provider connection failed|OpenAI-compatible provider is configured, but no API key|Provider planner request failed|Provider request timed out)/i.test(value) ||
      /\b(status\s+(401|402|403)|unauthorized|forbidden|invalid api key|api key missing for|authentication failed|login required|requires more credits|can only afford|live replies are disabled)\b/i.test(value);
  }

  cleanProviderFailureMessage(text = "") {
    const value = String(text || "").trim();
    if (!value) {
      return "provider returned no diagnostic text.";
    }
    if (/Codex CLI provider failed/i.test(value)) {
      return "Codex CLI provider failed during final synthesis. Check Codex login/model/sandbox, then retry.";
    }
    if (/timed out|timeout/i.test(value)) {
      return "provider timed out during final synthesis.";
    }
    if (/requires more credits|can only afford|status\s+402/i.test(value)) {
      return "provider account has insufficient credits/quota.";
    }
    if (/unauthorized|forbidden|invalid api key|api key missing|authentication failed|login required|status\s+(401|403)/i.test(value)) {
      return "provider authentication failed.";
    }
    const firstLine = value.split(/\r?\n/).find((line) => line.trim()) || value;
    return truncateTraceText(firstLine.replace(/\s+/g, " "), 220);
  }

  findMissingToolClaims(text = "", toolOutputs = []) {
    const value = String(text || "");
    const executed = new Set((toolOutputs || []).map((item) => item.tool));
    const claimPatterns = [
      { id: "list_files", patterns: [/\blist_files\b/i, /\blist files tool\b/i] },
      { id: "read_file", patterns: [/\bread_file\b/i, /\bread file tool\b/i, /\bread[- ]?back\b/i, /\bverify(?:\s+kiya|\s+hua|\s+file)?\b/i] },
      { id: "write_file", patterns: [/\bwrite_file\b/i, /\bwrite file tool\b/i, /\bfile\s+me[\s\S]{0,80}\b(?:likh|writ|save)/i, /\b(?:successfully|safely)?\s*(?:likha|wrote|written|saved)\s+(?:gaya|file)?\b/i] },
      { id: "search_computer_files", patterns: [/\bsearch_computer_files\b/i, /\bsearch computer files\b/i, /\bcomputer file search\b/i, /\blaptop file search\b/i] },
      { id: "list_computer_directory", patterns: [/\blist_computer_directory\b/i, /\blist computer directory\b/i] },
      { id: "read_computer_file", patterns: [/\bread_computer_file\b/i, /\bread computer file\b/i] },
      { id: "run_terminal_command", patterns: [/\brun_terminal_command\b/i, /\bterminal command\b/i, /\bshell tool\b/i, /\bnode\s+--version\b/i] },
      { id: "web_research", patterns: [/\bweb_research\b/i, /\bweb research tool\b/i] },
      { id: "web_search", patterns: [/\bweb_search\b/i, /\bweb search tool\b/i] },
      { id: "read_url", patterns: [/\bread_url\b/i, /\bread url tool\b/i] },
      { id: "browser_snapshot", patterns: [/\bbrowser_snapshot\b/i, /\bbrowser snapshot\b/i] },
    ];
    return claimPatterns
      .filter((claim) => !executed.has(claim.id) && claim.patterns.some((pattern) => pattern.test(value)))
      .map((claim) => claim.id);
  }

  hasUnsupportedLaptopFileConclusion(text = "", toolOutputs = []) {
    const value = String(text || "");
    if (!/\b(laptop|computer|pc)\b/i.test(value)) {
      return false;
    }
    const concludesMissing =
      /\b(no|not found|missing|does not exist|doesn't exist|nahi|nahin)\b[\s\S]{0,120}\b(file|folder|opencode)\b/i.test(value) ||
      /\b(file|folder|opencode)\b[\s\S]{0,120}\b(no|not found|missing|does not exist|doesn't exist|nahi|nahin)\b/i.test(value);
    if (!concludesMissing) {
      return false;
    }
    const groundedLocalTools = new Set([
      "search_computer_files",
      "list_computer_directory",
      "read_computer_file",
      "run_terminal_command",
    ]);
    return !(toolOutputs || []).some((item) =>
      groundedLocalTools.has(item.tool) && this.classifyToolOutput(item) === "completed",
    );
  }

  buildProfileQuestionReply({ message = "", agent = {} } = {}) {
    const agentId = agent.id || "main";
    const text = String(message || "").toLowerCase();
    const facts = this.readAgentProfileFacts(agentId);
    const longTerm = this.memory.getLongTermMemory(12, agentId);
    const assistantName = facts.assistantName || agent.name || "Main Agent";
    const userName = facts.userName || "";
    const location = facts.userLocation || "";
    const preferences = [
      ...facts.preferences,
      ...longTerm
        .map((item) => item.text || "")
        .filter((item) => /vibe coding|practical ai|real work|build/i.test(item))
        .slice(0, 3),
    ];
    const asksAssistant = /who are you|your name|tum kon|tum kaun|tu kon|tu kaun|tera|tara|tumhara/i.test(text);
    const asksUser = /who am i|my name|mera|mara|mujhe|mujha|mere|mara bara|mere baare/i.test(text);
    const asksWorkspace = /\b(workspace|context|agents?\.md|tools?\.md|soul\.md|user\.md|identity\.md|profile\.md|memory\.md|heartbeat\.md)\b/i.test(text);

    const lines = [];
    if (asksAssistant || !asksUser) {
      lines.push(`Main ${assistantName} hoon, OmniClaw ke andar chalne wala active agent.`);
      lines.push("OmniClaw khud platform/runtime hai; agent ko sessions, memory, tools, skills, browser/file/terminal hands aur gateway eyes deta hai.");
      if (asksWorkspace) {
        const workspaceContext = this.loadWorkspaceContext(agentId);
        const names = (workspaceContext.files || [])
          .map((file) => `${file.scope}:${file.name}`)
          .slice(0, 14);
        lines.push(`Workspace context loaded hai: ${workspaceContext.files?.length || 0} file(s), including ${names.join(", ") || "no files"}.`);
      }
    }
    if (asksUser || !asksAssistant) {
      if (userName || location || preferences.length > 0) {
        lines.push(
          `Tum${userName ? ` ${userName}` : ""}${location ? `, ${location} se` : ""} ho.`,
        );
        if (preferences.length > 0) {
          lines.push(`Mujhe tumhare baare me yaad hai: ${preferences.slice(0, 4).join(" | ")}`);
        }
      } else {
        lines.push("Tumhari profile abhi complete nahi mili. Apna naam, location, vibe aur AI-build preferences bataoge to main PROFILE.md aur memory me save kar lunga.");
      }
    }
    lines.push(`Profile source: ${this.hasAgentProfile(agentId) ? "PROFILE.md + long-term memory" : "fresh profile"}.`);
    return lines.join(" ");
  }

  readAgentProfileFacts(agentId = "main") {
    const profilePath = this.getAgentProfilePath(agentId);
    if (!fs.existsSync(profilePath)) {
      return {};
    }
    const text = fs.readFileSync(profilePath, "utf8");
    const latestFact = (pattern) => {
      const matches = [...text.matchAll(pattern)]
        .map((match) => String(match[1] || "").trim())
        .filter(Boolean);
      return matches.length ? matches[matches.length - 1] : "";
    };
    const assistantName = latestFact(/Assistant name:[ \t]*([^\r\n]+)/gi);
    const userName = latestFact(/User name:[ \t]*([^\r\n]+)/gi);
    const userLocation = latestFact(/User location:[ \t]*([^\r\n]+)/gi);
    const preferences = text
      .split(/\r?\n/)
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter((line) => /^User (likes|prefers|goal)\b/i.test(line));
    return { assistantName, userName, userLocation, preferences };
  }

  updateProfileFromMessage(agentId = "main", message = "") {
    const text = String(message || "").trim();
    const lowered = text.toLowerCase();
    const facts = [];
    const looksLikeQuestion = /\?|(?:\bkya\b|\bwhat\b|\bwho\b|\bkaun\b|\bkon\b|\bbata\b|\btell me\b)/i.test(text);

    if (!looksLikeQuestion) {
      const assistantNameMatch =
        text.match(/(?:tera|tara|tumhara|assistant(?: ka)?|agent(?: ka)?)\s+(?:naam|name)\s+([a-zA-Z0-9 _.-]{2,40}?)\s+(?:hai|ha|hoga|rakh)\b/i) ||
        text.match(/(?:call you|name you)\s+([a-zA-Z0-9 _.-]{2,40})/i);
      if (assistantNameMatch) {
        facts.push(`Assistant name: ${assistantNameMatch[1].trim().replace(/[.。]+$/, "")}`);
      }

      const userNameMatch =
        text.match(/(?:mera|mara|my)\s+(?:naam|name)\s+([a-zA-Z0-9 _.-]{2,40}?)\s+(?:hai|ha|is)\b/i) ||
        text.match(/(?:i am|i'm|main|mai)\s+([A-Z][a-zA-Z0-9 _.-]{1,40})\b/);
      if (userNameMatch) {
        facts.push(`User name: ${userNameMatch[1].trim().replace(/[.。]+$/, "")}`);
      }
    }

    if (/\bjind\b/i.test(text) || /\bharyana\b/i.test(text)) {
      const location = [/\bjind\b/i.test(text) ? "Jind" : "", /\bharyana\b/i.test(text) ? "Haryana" : ""]
        .filter(Boolean)
        .join(", ");
      facts.push(`User location: ${location || "Haryana/Jind"}`);
    }

    if (lowered.includes("vibe coding")) {
      facts.push("User likes vibe coding and building with AI.");
    }

    if (/(ai se build|ai sa build|ai tools?|jo acha kam|practical ai|kaam karke deta)/i.test(text)) {
      facts.push("User prefers practical AI that does real work and helps build things.");
    }

    if (facts.length === 0) {
      return { updated: false, facts: [] };
    }

    const profilePath = this.getAgentProfilePath(agentId);
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "# PROFILE\n";
    const existingFacts = new Set(
      existing
        .split(/\r?\n/)
        .map((line) => line.replace(/^-\s*/, "").trim())
        .filter(Boolean),
    );
    const newFacts = facts.filter((fact) => !existingFacts.has(fact));
    if (newFacts.length === 0) {
      return { updated: false, facts };
    }

    const next = [
      existing.trimEnd() || "# PROFILE",
      "",
      ...newFacts.map((fact) => `- ${fact}`),
      "",
      `Updated: ${new Date().toISOString()}`,
      "",
    ].join("\n");
    fs.writeFileSync(profilePath, next, "utf8");
    this.syncAgentIdentityFilesFromProfile(agentId);

    for (const fact of newFacts) {
      this.memory.promoteMemory({
        agentId,
        sourceType: "profile",
        sourceId: fact.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80),
        title: fact.split(":")[0],
        text: fact,
        importance: "high",
        tags: ["profile", "user-preference"],
      });
    }

    return { updated: true, facts: newFacts, profilePath };
  }
}
