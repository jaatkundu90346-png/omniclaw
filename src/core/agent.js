import fs from "node:fs";
import path from "node:path";

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
import { SystemMonitor } from "./system-monitor.js";
import { V2FeatureHealth } from "./v2-feature-health.js";
import { SandboxRunner } from "./sandbox-runner.js";
import { EventBus } from "./event-bus.js";
import { Heartbeat } from "./heartbeat.js";
import { McpRegistry } from "./mcp-client.js";

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

function redactTraceString(value = "") {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-or-v1|nvapi|ghp|github_pat|xox[baprs])-[A-Za-z0-9._-]{16,}\b/gi, "[redacted-token]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]{12,}@/g, "[redacted-auth]@")
    .replace(/((?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*)[^\s,"']+/gi, "$1[redacted]");
}

function isTraceSecretKey(key = "") {
  return /api[_-]?key|authorization|bearer|password|secret|token|cookie|credential/i.test(String(key || ""));
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
    ["provider_connection_failed", "provider connection failed"],
    ["provider_connection_failed", "request failed"],
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
    this.shellAudit = new ShellAuditStore(rootDir);
    this.connectors = new ConnectorStore(rootDir, { secretStore: this.secrets });
    this.jobs = new JobStore(rootDir);
    this.schedules = new ScheduleStore(rootDir);
    this.tasks = new TaskStore(rootDir);
    this.skills = new SkillRegistry(rootDir);
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
    });
    this.webResearch = new WebResearch(this.config);
    this.taskRunner = new TaskRunner(this.tasks);
    this.customizationEngine = new CustomizationEngine({
      configStore: this.config,
      skillRegistry: this.skills,
      secretStore: this.secrets,
    });
    this.contextEngine = new ContextEngine(this.config);
    this.browserOperator = new BrowserOperator({ rootDir });
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
      webResearch: this.webResearch,
      browserOperator: this.browserOperator,
      sandboxRunner: this.sandboxRunner,
      systemMonitor: this.systemMonitor,
      taskRunner: this.taskRunner,
      customizationEngine: this.customizationEngine,
      pluginRegistry: this.plugins,
      agentRegistry: this.agents,
      connectorStore: this.connectors,
      agentRuntime: this,
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
    this.eventBus = new EventBus();
  this.heartbeat = new Heartbeat({ agent: this, intervalMs: 1800000 });
  this.heartbeat.addCheck({ id: "memory-review", description: "Review and promote memory candidates", fn: (a) => a.memory.dreamSweep?.({ limit: 3, minScore: 0.7 }) });
  this.heartbeat.addCheck({ id: "approval-expiry", description: "Expire old pending approvals", fn: (a) => a.gateway.expireOldApprovals?.(30) });
  this.heartbeat.addCheck({ id: "session-cleanup", description: "Auto-compact large sessions", fn: (a) => { const sessions = a.sessions.listSessions(100); let compacted = 0; for (const s of sessions) { if (s.messageCount > 150) { try { a.sessions.compactSession(s.id, 80); compacted++; } catch {} } } return { compacted }; } });
  this.heartbeat.start();

  // ─── MCP Server Registry ────────────────────────────────────────
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
    this.intentEngine = new IntentEngine();
    this.planner = new Planner();
    this.provider = createProvider(this.config, this.secrets);
    this.summarizer = new SummarizationEngine(rootDir, this.provider, this.gateway);
    this.sessionRunQueues = new Map();
    this.workspace.ensure();
    this.agents.ensure();
    this.plugins.refreshLifecycle("startup");
    this.recoverStaleRuns("startup");
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
    return {
      agent,
      profile,
      skills: this.agents.filterSkills(this.skills.getAll(), agent.id),
      tools: this.tools.getAll({ agentId: agent.id }),
      recentConversations: this.memory.getRecentConversations(profile.maxRecentConversations, agent.id),
      notes: this.memory.getNotes(agent.id),
      longTermMemory: this.memory.getLongTermMemory(20, agent.id),
      research: this.memory.getResearch(10, agent.id),
      artifacts: this.memory.getArtifacts(10, agent.id),
      tasks: profile.enableTasks ? this.tasks.listTasks(agent.id) : [],
    };
  }

  getState() {
    this.provider = createProvider(this.config, this.secrets);
    const config = this.config.getConfig();
    const profile = this.config.getActiveProfile();
    return {
      app: config.app,
      runtime: {
        profile,
      },
      config,
      provider: this.provider.getInfo(),
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
      sessions: this.sessions.listSessions(12).map((session) => ({
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
      connectors: {
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
    return {
      runId: run.id,
      sessionId: run.sessionId || "",
      agentId: run.agentId || "main",
      status: run.status,
      available: toolTrace.length > 0,
      toolTrace,
      toolTraceCount: toolTrace.length,
      currentTool: run.currentTool || "",
      toolExecutionStatus: run.toolExecutionStatus || "",
      modelToolLoop: run.modelToolLoop || null,
      shellExecutions: sanitizeTraceValue(run.shellExecutions || [], { maxString: 1000, maxArray: 12, maxDepth: 4 }),
    };
  }

  queueDelegation(input = {}) {
    const targetAgentId = String(input.targetAgentId || input.agentId || "").trim();
    const instruction = String(input.instruction || input.task || "").trim();
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

    this.handleMessage(instruction, {
      sessionId: delegateSession.id,
      label: delegateSession.label,
      agentId: targetAgent.id,
      channel: "internal",
      source: "delegation",
      parentRunId,
      parentSessionId,
      delegationId: delegation.id,
    }).then((result) => {
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
      queued: true,
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
          const result = await this.executeMessageRun(job);
          job.resolve(result);
        } catch (error) {
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
    const runGuard = this.sessions.startRun(session.id, {
      runId: run.id,
      message,
      at: enqueuedAt,
    });
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

    const routedAgent = this.agents.resolveAgent(session.agentId);
    const profile = this.agents.getProfileForAgent(routedAgent.id);
    const availableTools = this.tools.getAll({ agentId: routedAgent.id });
    const intents = this.intentEngine.detect(message);
    const matchedSkills = profile.enableSkillMatching
      ? intents.includes("capabilities")
        ? this.agents.filterSkills(this.skills.getAll(), routedAgent.id)
        : this.skills.match(message, {
            agentId: routedAgent.id,
          })
      : [];
    const profileUpdate = this.updateProfileFromMessage(routedAgent.id, message);
    const forcedResponse = this.buildOnboardingReply({
      agentId: routedAgent.id,
      intents,
      session,
      profileUpdated: Boolean(profileUpdate?.updated),
    }) || this.buildDirectRuntimeReply({
      intents,
      message,
      agent: routedAgent,
      profile,
      tools: availableTools,
      skills: matchedSkills,
    });
    let plan = forcedResponse
      ? {
          summary: "OpenClaw-style onboarding response.",
          intents,
          profile,
          toolsAvailable: availableTools,
          steps: [{ type: "respond", reason: "Fresh agent profile is incomplete; ask identity and user-profile questions." }],
          source: "onboarding",
        }
      : await this.planner.buildPlanWithModel({
      message,
      intents,
      skills: matchedSkills,
      tools: availableTools,
      profile,
      provider: this.provider,
    });
    const toolOutputs = [];
    const approvals = [];

    this.gateway.updateRun(run.id, {
      status: "running",
      intents,
      profile: profile.id,
      agentId: routedAgent.id,
      plan,
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

    if (profile.allowToolExecution) {
      for (const step of plan.steps) {
        if (step.type !== "tool" || !this.tools.has(step.tool, { agentId: routedAgent.id })) {
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
        this.gateway.addEvent("tool.completed", {
          runId: run.id,
          sessionId: session.id,
          tool: step.tool,
          agentId: routedAgent.id,
          blocked: Boolean(output?.blocked),
          error: Boolean(output?.error),
        });

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

    const modelToolLoop = await this.runModelToolLoop({
      message,
      intents,
      profile,
      agent: routedAgent,
      tools: availableTools,
      toolOutputs,
      forcedResponse,
      session,
      run,
    });
    if (modelToolLoop.toolOutputs.length > 0) {
      toolOutputs.push(...modelToolLoop.toolOutputs);
      plan.modelToolLoop = modelToolLoop.report;
      this.gateway.updateRun(run.id, {
        modelToolLoop: modelToolLoop.report,
      });
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

      if (item.tool === "delegate_task" && item.output && !item.output.error) {
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

    try {
      const agentContext = this.getAgentContext(routedAgent.id);
      const sessionSummary = this.summarizer.readSummary(session.id);
      
      const workspaceContext = this.loadWorkspaceContext(routedAgent.id);
      
      const contextBundle = this.contextEngine.build({
        message,
        intents,
        agent: { ...routedAgent, workspaceFiles: workspaceContext.files.map((file) => file.name) },
        profile,
        skills: matchedSkills,
        plan,
        toolOutputs,
        workspaceContext,
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
      this.gateway.addEvent("context.compacted", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        usedChars: contextBundle.report.usedChars,
        maxChars: contextBundle.report.maxChars,
        omittedItems: contextBundle.report.omittedItems,
      });
      const runtimeToolReply = this.buildRuntimeToolReply({ intents, toolOutputs });
      let response = forcedResponse || runtimeToolReply;
      let providerDiagnostics = null;
      if (!response) {
        const providerStartedAt = new Date().toISOString();
        const providerInfo = this.provider.getInfo?.() || {};
        this.gateway.updateRun(run.id, {
          providerStatus: "running",
          provider: providerInfo,
          providerStartedAt,
        });
        this.gateway.addEvent("provider.started", {
          runId: run.id,
          sessionId: session.id,
          agentId: routedAgent.id,
          providerId: providerInfo.id || "unknown",
          model: providerInfo.model || "",
          ready: providerInfo.ready !== false,
        });
        const providerResponse = await this.provider.respond({
          message,
          intents,
          agent: contextBundle.agent,
          profile,
          skills: contextBundle.skills,
          plan,
          toolOutputs: contextBundle.toolOutputs,
          workspaceContext: contextBundle.workspaceContext,
          recentConversations: contextBundle.recentConversations,
          notes: contextBundle.notes,
          longTermMemory: contextBundle.longTermMemory,
          research: contextBundle.research,
          artifacts: contextBundle.artifacts,
          tasks: contextBundle.tasks,
          tools: contextBundle.tools,
          contextBundle,
        });
        const outcome = classifyProviderOutcome(providerResponse);
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
        };
        this.gateway.updateRun(run.id, {
          providerStatus: providerDiagnostics.status,
          providerDiagnostics,
        });
        this.gateway.addEvent(outcome.ok ? "provider.completed" : "provider.failed", {
          runId: run.id,
          sessionId: session.id,
          agentId: routedAgent.id,
          providerId: providerDiagnostics.providerId,
          model: providerDiagnostics.model,
          reason: providerDiagnostics.reason,
          durationMs: providerDiagnostics.durationMs,
        });
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

      const assistantAt = new Date().toISOString();
      this.sessions.appendMessage(session.id, {
        id: `message_${Date.now()}_assistant`,
        at: assistantAt,
        role: "assistant",
        text: response,
        toolOutputs,
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
        approvalIds: approvals.map((item) => item.id),
      });
      this.gateway.addEvent("agent.completed", {
        runId: run.id,
        sessionId: session.id,
        agentId: routedAgent.id,
        status: completedRun.status,
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
      maxRounds: Math.max(0, Math.min(5, Number(loop.maxRounds || 2))),
      maxToolCallsPerRound: Math.max(1, Math.min(8, Number(loop.maxToolCallsPerRound || 3))),
      runWhenHeuristicHasTools: Boolean(loop.runWhenHeuristicHasTools),
    };
  }

  shouldRunModelToolLoop({ forcedResponse = "", runtimeToolReply = "", profile = {}, toolOutputs = [], intents = [] } = {}) {
    const settings = this.getModelToolLoopSettings();
    if (!settings.enabled || !profile.allowToolExecution || forcedResponse || runtimeToolReply) {
      return false;
    }
    if (!this.provider || typeof this.provider.complete !== "function") {
      return false;
    }
    const providerInfo = this.provider.getInfo?.() || {};
    if (providerInfo.ready === false || providerInfo.id === "mock/local-rule-engine") {
      return false;
    }
    const directIntents = new Set([
      "greeting",
      "api-setup",
      "provider-status",
      "capabilities",
      "layer-status",
      "v2-audit",
      "system-status",
      "computer-access",
      "project-test",
      "project-build",
      "project-release",
    ]);
    if (intents.every((intent) => directIntents.has(intent))) {
      return false;
    }
    if (toolOutputs.length > 0 && !settings.runWhenHeuristicHasTools) {
      return false;
    }
    return true;
  }

  buildModelToolLoopPrompt({ message, intents, tools, toolOutputs, round }) {
    const toolLines = (tools || [])
      .filter((tool) => tool.id && !["message", "sessions_send"].includes(tool.id))
      .slice(0, 80)
      .map((tool) => `- ${tool.id}: ${tool.description || ""}`)
      .join("\n");
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
      "Return only valid JSON. Do not use markdown.",
      "If more runtime evidence is needed, return: {\"toolCalls\":[{\"tool\":\"tool_id\",\"input\":{},\"reason\":\"why\"}]}",
      "If no more tools are needed, return: {\"toolCalls\":[],\"finalReady\":true,\"reason\":\"why\"}",
      "Rules: use the fewest safe tool calls; never request destructive tools unless the user explicitly asked; do not call unknown tools.",
      "",
      `Round: ${round}`,
      `User message: ${message}`,
      `Detected intents: ${(intents || []).join(", ") || "general"}`,
      "",
      "Available tools:",
      toolLines || "(none)",
      "",
      "Previous observations:",
      observations || "[]",
      "",
      "JSON:",
    ].join("\n");
  }

  parseModelToolCalls(text, allowedToolIds, maxCalls) {
    const raw = String(text || "").trim();
    if (!raw) {
      return [];
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    } catch {
      return [];
    }
    const calls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : Array.isArray(parsed.tools) ? parsed.tools : [];
    return calls
      .map((call) => ({
        tool: String(call.tool || call.name || "").trim(),
        input: this.normalizeModelToolInput(call),
        reason: String(call.reason || "Provider requested this tool.").trim(),
      }))
      .filter((call) => call.tool && allowedToolIds.has(call.tool))
      .slice(0, maxCalls);
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

  async runModelToolLoop({
    message,
    intents,
    profile,
    agent,
    tools,
    toolOutputs,
    forcedResponse,
    session,
    run,
  }) {
    const runtimeToolReply = this.buildRuntimeToolReply({ intents, toolOutputs });
    const settings = this.getModelToolLoopSettings();
    const report = {
      enabled: settings.enabled,
      attempted: false,
      rounds: 0,
      toolCallCount: 0,
      skippedReason: "",
      errors: [],
    };
    if (!this.shouldRunModelToolLoop({ forcedResponse, runtimeToolReply, profile, toolOutputs, intents })) {
      report.skippedReason = "not-needed-or-not-eligible";
      return { report, toolOutputs: [] };
    }

    const allowedToolIds = new Set((tools || []).map((tool) => tool.id));
    const extraOutputs = [];
    report.attempted = true;

    for (let round = 1; round <= settings.maxRounds; round += 1) {
      report.rounds = round;
      let completion;
      try {
        completion = await this.provider.complete([
          {
            role: "system",
            content: "You are an OmniClaw tool-call planner. Return only valid JSON.",
          },
          {
            role: "user",
            content: this.buildModelToolLoopPrompt({
              message,
              intents,
              tools,
              toolOutputs: [...toolOutputs, ...extraOutputs],
              round,
            }),
          },
        ]);
      } catch (error) {
        report.errors.push(error.message);
        break;
      }

      const calls = this.parseModelToolCalls(completion?.text || "", allowedToolIds, settings.maxToolCallsPerRound);
      if (calls.length === 0) {
        break;
      }

      for (const call of calls) {
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
        extraOutputs.push({
          tool: call.tool,
          input: call.input,
          reason: call.reason,
          source: "model-tool-loop",
          round,
          output,
        });
        report.toolCallCount += 1;
        this.gateway.addEvent("model_tool_loop.tool_completed", {
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
      }
    }

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
    const fileNames = ["AGENTS.md", "IDENTITY.md", "SOUL.md", "USER.md", "PROFILE.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md"];
    const files = [];

    const readScopedFiles = (scope, workspaceDir) => {
      for (const name of fileNames) {
        const filePath = path.join(workspaceDir, name);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        files.push({
          name,
          scope,
          path: filePath,
          content: fs.readFileSync(filePath, "utf8"),
        });
      }
    };

    try {
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

  buildOnboardingReply({ agentId = "main", intents = [], session = {}, profileUpdated = false } = {}) {
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

  buildDirectRuntimeReply({ intents = [], agent = {}, tools = [], skills = [] } = {}) {
    if (intents.includes("api-setup") && !intents.includes("provider-status")) {
      return [
        "API key OmniClaw ke active agent ko real LLM brain deti hai.",
        "Provider model reasoning karta hai; OmniClaw platform hands, eyes, memory, tools, skills, sessions, channels, aur approvals deta hai.",
        "OpenRouter/OpenAI-compatible setup me teen cheezein chahiye: base URL, model, aur API key. Key local SecretStore me masked form me save hoti hai.",
        "Agar key ready hai to agent real provider se reply karega; agar provider fail ho to local tools aur memory phir bhi run ho sakte hain.",
      ].join(" ");
    }

    if (intents.includes("greeting") && intents.length === 1) {
      const profileFacts = this.readAgentProfileFacts(agent.id || "main");
      const assistantName = profileFacts.assistantName || agent.name || "Main Agent";
      const userName = profileFacts.userName || "Mankush";
      return `Haan ${userName}, main online hoon. Main ${assistantName} agent hoon, OmniClaw runtime ke andar chal raha hoon. Agar provider brain auth fail bhi ho, local tools, memory, sessions, gateway, files aur terminal policy yahin available hain.`;
    }

    return "";
  }

  buildRuntimeToolReply({ intents = [], toolOutputs = [] } = {}) {
    const byTool = new Map(toolOutputs.map((item) => [item.tool, item.output || {}]));
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

    if (intents.includes("v2-audit") && byTool.has("v2_status")) {
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

    if (intents.includes("capabilities") && byTool.has("capability_demo")) {
      const demo = byTool.get("capability_demo");
      const coreTools = Array.isArray(demo.coreTools) ? demo.coreTools : [];
      const demos = Array.isArray(demo.demos) ? demo.demos : [];
      const skillNames = Array.isArray(demo.skills)
        ? demo.skills.map((skill) => skill.name || skill.id).filter(Boolean).slice(0, 10)
        : [];
      return [
        `Capability demo ready: agent ${demo.agentId || "main"} ke paas ${demo.toolCount || 0} tools aur ${demo.skillCount || 0} skills visible hain.`,
        `Core tools: ${coreTools.join(", ") || "none"}.`,
        `Loaded skills: ${skillNames.join(", ") || "none"}.`,
        `Try: ${demos.slice(0, 3).join(" | ")}`,
      ].join(" ");
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

    return "";
  }

  buildProviderFailureFallback({ providerResponse = "", intents = [], agent = {}, tools = [], skills = [], toolOutputs = [] } = {}) {
    const text = String(providerResponse || "").trim();
    if (!this.looksLikeProviderFailure(text)) {
      return "";
    }

    const toolSummary = toolOutputs.length > 0
      ? `Local tools ran: ${toolOutputs.map((item) => item.tool).join(", ")}.`
      : "Is request me local tool ki zarurat nahi thi.";

    if (intents.includes("capabilities")) {
      return this.buildDirectRuntimeReply({ intents: ["capabilities"], agent, tools, skills });
    }

    return [
      `Provider brain abhi auth/config issue de raha hai, isliye remote model reply nahi aaya.`,
      toolSummary,
      `Main ${agent.name || agent.id || "active agent"} as OmniClaw local runtime abhi bhi sessions, memory, tools, gateway aur safe computer access sambhal sakta hoon.`,
      `Fix: BYOK panel se provider switch karo ya terminal me codex login chalao. Detail: ${text.slice(0, 420)}`,
    ].join(" ");
  }

  looksLikeProviderFailure(text = "") {
    return /Codex CLI provider failed|Codex CLI bridge|codex command|Provider request failed|Provider connection failed|API key missing|authentication|auth|login/i.test(String(text || ""));
  }

  readAgentProfileFacts(agentId = "main") {
    const profilePath = this.getAgentProfilePath(agentId);
    if (!fs.existsSync(profilePath)) {
      return {};
    }
    const text = fs.readFileSync(profilePath, "utf8");
    const assistantName = text.match(/Assistant name:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
    const userName = text.match(/User name:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
    return { assistantName, userName };
  }

  updateProfileFromMessage(agentId = "main", message = "") {
    const text = String(message || "").trim();
    const lowered = text.toLowerCase();
    const facts = [];
    const looksLikeQuestion = /\?|(?:\bkya\b|\bwhat\b|\bwho\b|\bkaun\b|\bkon\b|\bbata\b|\btell me\b)/i.test(text);

    if (!looksLikeQuestion) {
      const assistantNameMatch =
        text.match(/(?:tera|tara|tumhara|assistant(?: ka)?|agent(?: ka)?)\s+(?:naam|name)\s+([a-zA-Z0-9 _.-]{2,40})\s+(?:hai|ha|hoga|rakh)/i) ||
        text.match(/(?:call you|name you)\s+([a-zA-Z0-9 _.-]{2,40})/i);
      if (assistantNameMatch) {
        facts.push(`Assistant name: ${assistantNameMatch[1].trim().replace(/[.。]+$/, "")}`);
      }

      const userNameMatch =
        text.match(/(?:mera|mara|my)\s+(?:naam|name)\s+([a-zA-Z0-9 _.-]{2,40})\s+(?:hai|ha|is)/i) ||
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
