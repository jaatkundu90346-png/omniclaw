import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizeContext(context = {}) {
  if (typeof context === "string") {
    return {
      agentId: context,
    };
  }

  return context && typeof context === "object" ? context : {};
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "openclaw-skill";
}

function parseOpenClawSkill(contents, filePath, rootDir) {
  const text = String(contents || "");
  const meta = {};
  let body = text;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (item) {
        meta[item[1].toLowerCase()] = item[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
  const directoryName = path.basename(path.dirname(filePath));
  return {
    name: meta.name || directoryName,
    description: meta.description || "",
    path: relativePath,
    absolutePath: filePath,
    source: relativePath.startsWith("vendor/openclaw/extensions/") ? "extensions" : "skills",
    instructions: body.trim(),
  };
}

const OPENCLAW_COMPAT_SKILL_PACKS = {
  v2_core: [
    {
      name: "browser-automation",
      path: "vendor/openclaw/extensions/browser/skills/browser-automation/SKILL.md",
      importName: "OpenClaw Browser Automation",
      triggers: ["browser", "automation", "web page", "click", "tab", "screenshot", "login"],
      agents: ["main", "ops", "research"],
      reason: "Gives the agent an OpenClaw-style browser operating loop: status, tabs, snapshot, narrow action, observe.",
    },
    {
      name: "coding-agent",
      path: "vendor/openclaw/skills/coding-agent/SKILL.md",
      importName: "OpenClaw Coding Agent",
      triggers: ["coding agent", "build", "implement", "review", "refactor", "codex", "opencode"],
      agents: ["main", "builder", "ops"],
      reason: "Documents how OpenClaw delegates implementation work to background coding CLIs.",
    },
    {
      name: "github",
      path: "vendor/openclaw/skills/github/SKILL.md",
      importName: "OpenClaw GitHub Operator",
      triggers: ["github", "repo", "pull request", "issue", "branch", "commit"],
      agents: ["main", "builder", "ops"],
      reason: "Adds GitHub workflow behavior for repo/PR/issue operations.",
    },
    {
      name: "healthcheck",
      path: "vendor/openclaw/skills/healthcheck/SKILL.md",
      importName: "OpenClaw Healthcheck",
      triggers: ["healthcheck", "diagnostics", "status", "doctor", "runtime"],
      agents: ["main", "ops"],
      reason: "Helps the agent inspect runtime health before claiming a feature works.",
    },
    {
      name: "session-logs",
      path: "vendor/openclaw/skills/session-logs/SKILL.md",
      importName: "OpenClaw Session Logs",
      triggers: ["session logs", "history", "transcript", "chat history", "conversation"],
      agents: ["main", "ops", "research"],
      reason: "Strengthens session-history behavior so the agent checks prior messages instead of starting fresh.",
    },
    {
      name: "skill-creator",
      path: "vendor/openclaw/skills/skill-creator/SKILL.md",
      importName: "OpenClaw Skill Creator",
      triggers: ["create skill", "new skill", "skill file", "capability"],
      agents: ["main", "builder", "ops"],
      reason: "Adds OpenClaw-style skill authoring guidance for growing OmniClaw capabilities.",
    },
  ],
};

const HERMES_COMPAT_TOOLS = [
  { id: "web_search", toolset: "web", status: "native", omniclawTool: "web_search" },
  { id: "web_extract", toolset: "web", status: "alias", omniclawTool: "web_fetch" },
  { id: "terminal", toolset: "terminal", status: "alias", omniclawTool: "run_terminal_command" },
  { id: "process", toolset: "terminal", status: "native", omniclawTool: "process" },
  { id: "read_file", toolset: "file", status: "native", omniclawTool: "read_file" },
  { id: "write_file", toolset: "file", status: "native", omniclawTool: "write_file" },
  { id: "patch", toolset: "file", status: "alias", omniclawTool: "apply_patch" },
  { id: "search_files", toolset: "file", status: "alias", omniclawTool: "memory_search/search_computer_files" },
  { id: "vision_analyze", toolset: "vision", status: "alias", omniclawTool: "image/analyze_pending_media_attachments" },
  { id: "video_analyze", toolset: "video", status: "alias", omniclawTool: "video_analyze" },
  { id: "image_generate", toolset: "image_gen", status: "native", omniclawTool: "image_generate" },
  { id: "skills_list", toolset: "skills", status: "alias", omniclawTool: "hermes_skill_scan/capability_demo" },
  { id: "skill_view", toolset: "skills", status: "alias", omniclawTool: "read_computer_file" },
  { id: "skill_manage", toolset: "skills", status: "partial", omniclawTool: "create_skill/openclaw_skill_import" },
  { id: "browser_navigate", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_snapshot", toolset: "browser", status: "native", omniclawTool: "browser_snapshot" },
  { id: "browser_click", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_type", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_scroll", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_back", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_press", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_get_images", toolset: "browser", status: "alias", omniclawTool: "browser_links/browser_screenshot" },
  { id: "browser_vision", toolset: "browser", status: "partial", omniclawTool: "browser_screenshot + image" },
  { id: "browser_console", toolset: "browser", status: "partial", omniclawTool: "browser" },
  { id: "browser_cdp", toolset: "browser", status: "partial", omniclawTool: "browser" },
  { id: "browser_dialog", toolset: "browser", status: "partial", omniclawTool: "browser" },
  { id: "text_to_speech", toolset: "tts", status: "placeholder", omniclawTool: "media plugin needed" },
  { id: "todo", toolset: "todo", status: "alias", omniclawTool: "create_task/list_tasks" },
  { id: "memory", toolset: "memory", status: "alias", omniclawTool: "memory_search/list_long_term_memory/promote_memory" },
  { id: "session_search", toolset: "session_search", status: "alias", omniclawTool: "sessions_history/memory_search" },
  { id: "clarify", toolset: "clarify", status: "placeholder", omniclawTool: "assistant follow-up" },
  { id: "execute_code", toolset: "code_execution", status: "alias", omniclawTool: "code_execution" },
  { id: "delegate_task", toolset: "delegation", status: "native", omniclawTool: "delegate_task" },
  { id: "cronjob", toolset: "cronjob", status: "alias", omniclawTool: "cron" },
  { id: "send_message", toolset: "messaging", status: "alias", omniclawTool: "message" },
  { id: "ha_list_entities", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "ha_get_state", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "ha_list_services", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "ha_call_service", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "kanban_show", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_list", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_complete", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_block", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_heartbeat", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_comment", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_create", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_link", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_unblock", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "computer_use", toolset: "computer_use", status: "partial", omniclawTool: "computer_access_status/browser/terminal" },
  { id: "mixture_of_agents", toolset: "moa", status: "partial", omniclawTool: "subagents/delegate_task" },
];

const LIMITED_PRODUCT_TOOLS = {
  browser_vision: {
    status: "partial",
    replacement: "browser_screenshot",
    reason: "Captures screenshots, but image interpretation needs a vision provider.",
  },
  browser_console: {
    status: "partial",
    replacement: "browser_snapshot",
    reason: "Console extraction needs a hardened Playwright/CDP adapter.",
  },
  browser_cdp: {
    status: "partial",
    replacement: "browser",
    reason: "Raw CDP execution needs a hardened browser adapter.",
  },
  browser_dialog: {
    status: "partial",
    replacement: "browser",
    reason: "Dialog accept/dismiss support is not wired yet.",
  },
  skill_manage: {
    status: "partial",
    replacement: "create_skill",
    reason: "Hermes-style self-editing skill management needs diff/review before writes.",
  },
  clarify: {
    status: "partial",
    replacement: "assistant_followup",
    reason: "Clarification should be a chat question, not a model-callable fake tool.",
  },
  mixture_of_agents: {
    status: "partial",
    replacement: "delegate_task",
    reason: "Full MoA orchestration is not built; delegate_task is the concrete backend.",
  },
  computer_use: {
    status: "partial",
    replacement: "computer_access_status",
    reason: "Computer-use is a status bundle; concrete actions use terminal/browser/file tools.",
  },
  text_to_speech: {
    status: "placeholder",
    replacement: "",
    reason: "TTS provider plugin is not configured.",
  },
  image_generate: {
    status: "placeholder",
    replacement: "",
    reason: "Image generation provider plugin is not configured.",
  },
  music_generate: {
    status: "placeholder",
    replacement: "",
    reason: "Music generation provider plugin is not configured.",
  },
  video_generate: {
    status: "placeholder",
    replacement: "",
    reason: "Video generation provider plugin is not configured.",
  },
  tts: {
    status: "placeholder",
    replacement: "",
    reason: "TTS provider plugin is not configured.",
  },
  ha_list_entities: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  ha_get_state: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  ha_list_services: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  ha_call_service: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  kanban_show: {
    status: "placeholder",
    replacement: "list_tasks",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_list: {
    status: "placeholder",
    replacement: "list_tasks",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_complete: {
    status: "placeholder",
    replacement: "run_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_block: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_heartbeat: {
    status: "placeholder",
    replacement: "cron",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_comment: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_create: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_link: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_unblock: {
    status: "placeholder",
    replacement: "run_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
};

export class ToolRegistry {
  constructor({
    memoryStore,
    taskStore,
    configStore,
    fileStore,
    shellPlanner,
    webResearch,
    browserOperator,
    sandboxRunner,
    systemMonitor,
    taskRunner,
    customizationEngine,
    pluginRegistry,
    agentRegistry,
    connectorStore,
    agentRuntime,
    subAgentSpawner,
  }) {
    this.memoryStore = memoryStore;
    this.taskStore = taskStore;
    this.configStore = configStore;
    this.fileStore = fileStore;
    this.shellPlanner = shellPlanner;
    this.webResearch = webResearch;
    this.browserOperator = browserOperator;
    this.sandboxRunner = sandboxRunner;
    this.systemMonitor = systemMonitor;
    this.taskRunner = taskRunner;
    this.customizationEngine = customizationEngine;
    this.pluginRegistry = pluginRegistry;
    this.agentRegistry = agentRegistry;
    this.connectorStore = connectorStore;
    this.agentRuntime = agentRuntime;
    this.subAgentSpawner = subAgentSpawner;
    this.tools = {
      time_now: {
        description: "Get the current local time in ISO format.",
        permission: null,
        run: async () => ({
          now: new Date().toISOString(),
        }),
      },
      remember_note: {
        description: "Save a short note into persistent memory.",
        permission: "allowNoteWrite",
        run: async ({ text }, context) => {
          const note = this.memoryStore.addNote(String(text || "").trim(), {
            agentId: this.getAgentId(context),
          });
          return { saved: true, note };
        },
      },
      list_notes: {
        description: "List all saved notes.",
        permission: null,
        run: async (_, context) => ({
          notes: this.memoryStore.getNotes(this.getAgentId(context)),
        }),
      },
      list_long_term_memory: {
        description: "List promoted long-term memories for the active agent.",
        permission: null,
        run: async (_, context) => ({
          memories: this.memoryStore.getLongTermMemory(50, this.getAgentId(context)),
          dreams: this.memoryStore.getDreams(10, this.getAgentId(context)),
          overview: this.memoryStore.getOverview(this.getAgentId(context)),
        }),
      },
      promote_memory: {
        description: "Promote a note, conversation, research item, or manual text into long-term memory.",
        permission: "allowMemoryPromotion",
        run: async (input, context) =>
          this.memoryStore.promoteMemory({
            ...input,
            agentId: input.agentId || this.getAgentId(context),
          }),
      },
      dream_memory_sweep: {
        description: "Run a lightweight memory review that promotes high-value candidates.",
        permission: "allowDreamSweep",
        run: async (input, context) =>
          this.memoryStore.runDreamSweep({
            ...input,
            agentId: input.agentId || this.getAgentId(context),
            provider: this.agentRuntime?.provider,
          }),
      },
      scan_file_drop: {
        description: "Scan the local data/inbox folder and process new text files as connector messages.",
        permission: "allowConnectorWrite",
        run: async (input, context) => {
          if (!this.agentRuntime?.scanFileDrop) {
            throw new Error("File-drop connector runtime is unavailable.");
          }
          return this.agentRuntime.scanFileDrop({
            ...input,
            agentId: input.agentId || "",
          });
        },
      },
      cleanup_attachment_cache: {
        description: "Apply the attachment retention policy and purge old or oversized cached connector files.",
        permission: "allowConnectorWrite",
        run: async (input = {}) => {
          if (!this.connectorStore?.cleanupAdapterAttachmentCache) {
            throw new Error("Attachment cleanup runtime is unavailable.");
          }
          return this.connectorStore.cleanupAdapterAttachmentCache({
            dryRun: input.dryRun !== false,
            force: input.force === true,
            policy: input.policy && typeof input.policy === "object" ? input.policy : {},
          });
        },
      },
      analyze_attachment_media: {
        description: "Run OCR/transcription media analysis for one cached media attachment extract.",
        permission: "allowConnectorWrite",
        run: async (input = {}) => {
          if (!this.connectorStore?.analyzeAdapterAttachmentMedia) {
            throw new Error("Media analysis runtime is unavailable.");
          }
          return this.connectorStore.analyzeAdapterAttachmentMedia({
            extractId: input.extractId || input.id || "",
            cacheId: input.cacheId || "",
            deliveryId: input.deliveryId || "",
            attachmentIndex: Number(input.attachmentIndex || 0),
            force: input.force === true,
            policy: input.policy && typeof input.policy === "object" ? input.policy : {},
          });
        },
      },
      analyze_pending_media_attachments: {
        description: "Analyze recent pending image, PDF, audio, or video attachment metadata records.",
        permission: "allowConnectorWrite",
        run: async (input = {}) => {
          if (!this.connectorStore?.analyzePendingMediaAttachments) {
            throw new Error("Media analysis runtime is unavailable.");
          }
          return this.connectorStore.analyzePendingMediaAttachments({
            limit: Number(input.limit || 5),
            force: input.force === true,
            policy: input.policy && typeof input.policy === "object" ? input.policy : {},
          });
        },
      },
      create_task: {
        description: "Create a task in the local task list.",
        permission: "allowTaskWrite",
        run: async ({ title }, context) => {
          const task = this.taskStore.createTask(String(title || "").trim(), {
            agentId: this.getAgentId(context),
          });
          return { created: true, task };
        },
      },
      list_tasks: {
        description: "List tracked local tasks.",
        permission: null,
        run: async (_, context) => ({
          tasks: this.taskStore.listTasks(this.getAgentId(context)),
        }),
      },
      todo: {
        description: "Hermes-compatible todo/task tool.",
        permission: "allowTaskWrite",
        group: "hermes-planning",
        run: async ({ action, title } = {}, context) => {
          const normalized = String(action || (title ? "create" : "list")).toLowerCase();
          if (["create", "add", "new"].includes(normalized)) {
            return this.tools.create_task.run({ title }, context);
          }
          return this.tools.list_tasks.run({}, context);
        },
      },
      runtime_summary: {
        description: "Summarize current runtime profile and provider mode.",
        permission: null,
        run: async (_, context) => {
          const config = this.configStore.getConfig();
          const agentId = this.getAgentId(context);
          const agent = this.agentRegistry?.resolveAgent(agentId) || null;
          const profile = agent
            ? this.configStore.getProfile(agent.profileId)
            : this.configStore.getActiveProfile();
          return {
            agent,
            profile,
            providerMode: config.provider.mode,
          };
        },
      },
      provider_status: {
        description: "Diagnose the active model/provider brain, auth readiness, command path, and next fix.",
        permission: null,
        group: "runtime",
        run: async ({ verify } = {}) => {
          const info = this.agentRuntime?.getProviderInfo?.() || {};
          let live = null;
          if (verify && this.agentRuntime?.provider?.testConnection) {
            try {
              live = await this.agentRuntime.provider.testConnection({
                verifyAuth: true,
                timeoutMs: 30000,
                prompt: "Reply with exactly: ok",
              });
            } catch (error) {
              live = {
                ok: false,
                error: error.message,
              };
            }
          }
          const ready = Boolean(info.ready);
          const liveOk = live ? Boolean(live.ok) : null;
          const needsAuth = (live && !liveOk) || (!ready && /auth|login|codex|key|not found|could not run/i.test(String(info.message || "")));
          return {
            ready: live ? liveOk : ready,
            provider: info.id || "unknown",
            mode: info.mode || "",
            model: info.model || "",
            command: info.command || "",
            commandPath: info.commandPath || "",
            commandVersion: info.commandVersion || "",
            apiKeyConfigured: Boolean(info.apiKeyConfigured),
            apiKeySource: info.apiKeySource || "",
            message: info.message || "",
            verified: Boolean(live),
            live,
            needsAuth,
            nextFix: needsAuth
              ? "Open a terminal and run codex login for ChatGPT/Codex bridge, or switch to an OpenAI-compatible BYOK provider with base URL, model, and API key."
              : live
                ? "Provider live reply test passed."
                : ready
                ? "Provider brain is ready."
                : "Check provider profile, base URL, model name, command path, and saved API key.",
          };
        },
      },
      prompt_trace: {
        description: "Inspect the sanitized prompt/context trace for a completed run.",
        permission: null,
        group: "runtime",
        run: async ({ runId }) => {
          const trace = this.agentRuntime?.getPromptTrace?.(String(runId || "").trim());
          if (!trace) {
            return {
              found: false,
              message: "Run not found.",
            };
          }
          return {
            found: true,
            ...trace,
          };
        },
      },
      prompt_assembly_status: {
        description: "Hermes-style prompt assembly report: identity files, project context discovery, injection defense, and context budget.",
        permission: null,
        group: "runtime",
        run: async (_, context) => this.getPromptAssemblyStatus(context),
      },
      tool_trace: {
        description: "Inspect the per-run tool execution ledger with inputs, outputs, status, and timing.",
        permission: null,
        group: "runtime",
        run: async ({ runId }) => {
          const trace = this.agentRuntime?.getToolTrace?.(String(runId || "").trim());
          if (!trace) {
            return {
              found: false,
              message: "Run not found.",
            };
          }
          return {
            found: true,
            ...trace,
          };
        },
      },
      v2_status: {
        description: "OmniClaw V2 feature health report with scores, weak features, evidence, and gaps.",
        permission: null,
        group: "runtime",
        run: async () => this.agentRuntime?.getV2Report?.() || {
          version: "v2-unavailable",
          score: 0,
          features: [],
          weakest: [],
        },
      },
      v2_repair_plan: {
        description: "Generate a prioritized OmniClaw V2 repair plan from the live feature health report.",
        permission: null,
        group: "runtime",
        run: async () => {
          const report = this.agentRuntime?.getV2Report?.() || { weakest: [], nextMilestones: [] };
          const weakest = Array.isArray(report.weakest) ? report.weakest : [];
          return {
            version: report.version || "v2-foundation",
            score: report.score || 0,
            criticalScore: report.criticalScore || 0,
            immediateRepairs: weakest.slice(0, 5).map((item, index) => ({
              rank: index + 1,
              feature: item.name,
              status: item.status,
              priority: item.priority,
              gaps: item.gaps,
              nextAction: item.nextAction,
            })),
            milestones: report.nextMilestones || [],
            rule: "Do not claim a feature is done unless status is ready and evidence is present.",
          };
        },
      },
      capability_demo: {
        description: "Return a practical demo of the active agent's real tools, skills, and example tasks.",
        permission: null,
        group: "runtime",
        run: async (_, context) => {
          const agentId = this.getAgentId(context);
          const tools = this.getAll({ agentId });
          const productReadyTools = tools.filter((tool) => tool.productReady !== false);
          const limitedTools = tools.filter((tool) => tool.productReady === false);
          const skills = this.agentRegistry
            ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
            : [];
          const toolIds = productReadyTools.map((tool) => tool.id);
          return {
            agentId,
            toolCount: tools.length,
            productReadyToolCount: productReadyTools.length,
            limitedToolCount: limitedTools.length,
            skillCount: skills.length,
            coreTools: toolIds.filter((id) => [
              "exec",
              "process",
              "code_execution",
              "browser",
              "browser_snapshot",
              "browser_audit",
              "web_search",
              "web_fetch",
              "read",
              "write",
              "edit",
              "copy_computer_path",
              "move_computer_path",
              "computer_access_audit",
              "sessions_list",
              "sessions_history",
              "memory_search",
              "gateway",
              "cron",
              "nodes",
              "mcp_integration_status",
              "mcp_connect_all",
              "trajectory_training_status",
              "closed_learning_loop_status",
              "hermes_use_cases_status",
              "design_principles_status",
            ].includes(id)),
            skills: skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              triggers: skill.triggers,
            })),
            limitedTools: limitedTools.slice(0, 24).map((tool) => ({
              id: tool.id,
              status: tool.runtimeStatus,
              replacement: tool.replacement,
              reason: tool.readinessReason,
            })),
            demos: [
              "Ask: 'laptop status check karo' -> computer_system_status runs.",
              "Ask: 'list files' or 'read file README.md' -> filesystem tools run.",
              "Ask: 'search web OpenClaw tools' -> web_search/web_research runs.",
              "Ask: 'gateway status' -> gateway/provider/session diagnostics run.",
              "Ask: 'run terminal command \"Get-Date\"' -> governed exec runs with audit logs.",
            ],
          };
        },
      },
      real_task_health: {
        description: "Run a product-grade real-task health probe across tools, skills, provider, files, terminal, browser, memory, and model routing.",
        permission: null,
        group: "runtime",
        run: async (input = {}, context) => this.getRealTaskHealth({
          live: input.live !== false,
          context,
        }),
      },
      layer_status: {
        description: "Report OmniClaw's OpenClaw-style layer 1-5 architecture status, gaps, and next upgrades.",
        permission: null,
        run: async () => {
          if (!this.agentRuntime?.getOpenClawLayerReport) {
            throw new Error("Layer report runtime is unavailable.");
          }
          return this.agentRuntime.getOpenClawLayerReport();
        },
      },
      self_build_plan: {
        description: "Create a Codex + OpenClaw implementation plan for improving OmniClaw itself.",
        permission: null,
        run: async ({ focus } = {}, context) => {
          const config = this.configStore.getConfig();
          const provider = this.agentRuntime?.getProviderInfo?.() || {};
          const tools = this.getAll({ agentId: this.getAgentId(context) });
          const scripts = {
            build: "npm.cmd run build",
            test: "npm.cmd run test",
            chatAgentSmoke: "npm.cmd run test:chat-agent",
            portableBuild: "npm.cmd run portable:build",
            release: "npm.cmd run release:windows",
          };
          const docs = [
            "docs/OMNICLAW_CODEX_OPENCLAW_ARCHITECTURE.md",
            "docs/OPENCLAW_UI_DEEP_STUDY.md",
            "docs/WINDOWS_INSTALLER_PLAN.md",
            "docs/SHELL_EXECUTION_GOVERNANCE.md",
            "docs/BYOK_PROVIDER_SETUP.md",
          ];

          return {
            focus: focus || "self-build",
            architecture: {
              brain: provider.ready && provider.id !== "mock/local-rule-engine"
                ? `Remote LLM provider ${provider.id} is ready.`
                : "Offline task engine is active; connect BYOK/API key for the real LLM brain.",
              hands: [
                "safe shell execution",
                "file read/write/copy/move/delete inside protected roots",
                "build/test/release commands",
                "task runner",
                "plugins",
                "connectors",
                "scheduler",
              ],
              eyes: [
                "workspace files",
                "system status",
                "sessions and gateway events",
                "memory and artifacts",
                "connector inboxes",
                "logs through command output",
              ],
              loop: "intent -> plan -> act with tools -> observe outputs -> provider final response",
            },
            currentProvider: provider,
            shellPolicy: {
              trustLevel: config.tools?.shellExecution?.trustLevel || "protected",
              allowlistMode: config.tools?.shellExecution?.allowlistMode || "advisory",
              allowlistCount: config.tools?.shellExecution?.allowlistPatterns?.length || 0,
            },
            toolSurface: {
              count: tools.length,
              coreTools: tools.slice(0, 16).map((tool) => tool.id),
            },
            implementationPlan: [
              {
                step: "Make the chat reply human-first",
                status: "done",
                detail: "Greetings and API setup no longer dump raw intent/plan text.",
              },
              {
                step: "Make safe local work executable",
                status: "done",
                detail: "Build/test/release requests map to allowlisted shell commands.",
              },
              {
                step: "Add self-build planner",
                status: "in_progress",
                detail: "Expose architecture, tools, scripts, docs, and next actions inside OmniClaw.",
              },
              {
                step: "Add richer hands",
                status: "next",
                detail: "Teach OmniClaw to apply scoped code patches and inspect browser screenshots through governed tools.",
              },
              {
                step: "Add stronger brain loop",
                status: "next",
                detail: "Use provider tool-call JSON for repeated think-act-observe cycles when an API key is configured.",
              },
            ],
            scripts,
            docs,
            nextPromptExamples: [
              "test karo",
              "release zip banao",
              "api key setup",
              "OmniClaw self build plan",
              "read file docs/OMNICLAW_CODEX_OPENCLAW_ARCHITECTURE.md",
            ],
          };
        },
      },
      list_files: {
        description: "List files in a workspace directory.",
        permission: "allowDirectoryList",
        run: async ({ path }) => ({
          path: path || ".",
          entries: this.fileStore.listDirectory(path || "."),
        }),
      },
      computer_access_status: {
        description: "Show configured laptop/computer access roots, terminal policy, and browser capability.",
        permission: null,
        run: async () => {
          const config = this.configStore.getConfig();
          const policy = this.getComputerAccessPolicy();
          const shellPolicy = config.tools?.shellExecution || {};
          const recentOperations = this.getComputerAccessAudit(8);
          return {
            enabled: policy.enabled,
            allowedRoots: policy.allowedRoots,
            allowWrite: policy.allowWrite !== false,
            allowDelete: policy.allowDelete !== false,
            deleteMode: policy.allowPermanentDelete ? "permanent-delete-allowed" : "move-to-data-trash",
            blockedPathPatterns: policy.blockedPathPatterns,
            terminal: {
              enabled: Boolean(config.tools?.permissions?.allowShellExecution),
              trustLevel: shellPolicy.trustLevel || "protected",
              allowlistMode: shellPolicy.allowlistMode || "advisory",
              cwd: shellPolicy.cwd || ".",
              timeoutMs: shellPolicy.timeoutMs || 15000,
            },
            sandbox: this.sandboxRunner?.getStatus?.() || {},
            browser: {
              openUrl: true,
              readUrl: true,
              automation: this.browserOperator.getStatus?.() || {},
              operations: ["browser_snapshot", "browser_links", "browser_screenshot", "browser_text", "browser_audit"],
            },
            operations: {
              available: [
                "list_computer_directory",
                "search_computer_files",
                "read_computer_file",
                "write_computer_file",
                "create_computer_directory",
                "copy_computer_path",
                "move_computer_path",
                "delete_computer_path",
              ],
              recent: recentOperations,
            },
          };
        },
      },
      search_computer_files: {
        description: "Search file and folder names across configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async (input = {}, context) => {
          const result = this.fileStore.searchComputerFiles(input, this.requireComputerAccessPolicy());
          this.recordComputerAccessOperation("search", {
            path: result.roots?.join(", ") || "",
            type: "search",
            bytes: result.results?.length || 0,
          }, context);
          return result;
        },
      },
      computer_access_audit: {
        description: "List recent governed computer-access operations captured in the gateway audit feed.",
        permission: "allowComputerAccess",
        run: async ({ limit }) => ({
          operations: this.getComputerAccessAudit(Number(limit || 25)),
        }),
      },
      list_computer_directory: {
        description: "List files from configured laptop access roots such as the user home folder.",
        permission: "allowComputerAccess",
        run: async ({ path }, context) => {
          const result = this.fileStore.listComputerDirectory(path || "~", this.requireComputerAccessPolicy());
          this.recordComputerAccessOperation("list", result, context);
          return result;
        },
      },
      read_computer_file: {
        description: "Read a text file from configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ path }, context) => {
          const config = this.configStore.getConfig();
          const result = this.fileStore.readComputerText(
            path,
            config.tools?.computerAccess?.maxReadBytes || 131072,
            this.requireComputerAccessPolicy(),
          );
          this.recordComputerAccessOperation("read", { ...result, content: undefined }, context);
          return result;
        },
      },
      write_computer_file: {
        description: "Write or append a text file inside configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ path, content, append }, context) => {
          const result = this.fileStore.writeComputerText(path, String(content || ""), {
            append: Boolean(append),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation(append ? "append" : "write", result, context);
          return result;
        },
      },
      create_computer_directory: {
        description: "Create a directory inside configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ path }, context) => {
          const result = this.fileStore.createComputerDirectory(path, this.requireComputerAccessPolicy());
          this.recordComputerAccessOperation("mkdir", result, context);
          return result;
        },
      },
      copy_computer_path: {
        description: "Copy a file or folder between configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ from, source, to, destination, overwrite }, context) => {
          const result = this.fileStore.copyComputerPath(from || source, to || destination, {
            overwrite: Boolean(overwrite),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation("copy", result, context);
          return result;
        },
      },
      move_computer_path: {
        description: "Move or rename a file or folder inside configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ from, source, to, destination, overwrite }, context) => {
          const result = this.fileStore.moveComputerPath(from || source, to || destination, {
            overwrite: Boolean(overwrite),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation("move", result, context);
          return result;
        },
      },
      delete_computer_path: {
        description: "Delete a file or folder inside configured laptop access roots. By default it moves the item to data/trash for restore.",
        permission: "allowComputerAccess",
        run: async ({ path, permanent }, context) => {
          const result = this.fileStore.deleteComputerPath(path, {
            permanent: Boolean(permanent),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation("delete", result, context);
          return result;
        },
      },
      read_file: {
        description: "Read a text file from the workspace.",
        permission: "allowFileRead",
        run: async ({ path }) => {
          const config = this.configStore.getConfig();
          return this.fileStore.readText(path, config.tools.filesystem.maxReadBytes);
        },
      },
      write_file: {
        description: "Write a text file inside protected writable roots.",
        permission: "allowFileWrite",
        run: async ({ path, content }) => {
          const config = this.configStore.getConfig();
          return this.fileStore.writeText(path, String(content || ""), {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
        },
      },
      append_file: {
        description: "Append text to a file inside protected writable roots.",
        permission: "allowFileWrite",
        run: async ({ path, content }) => {
          const config = this.configStore.getConfig();
          return this.fileStore.writeText(path, String(content || ""), {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: true,
          });
        },
      },
      plan_shell_command: {
        description: "Prepare a shell-command request that requires later approval.",
        permission: "allowShellPlanning",
        run: async ({ request }) => {
          const command = this.inferCommand(request);
          return this.shellPlanner.buildRequest(
            command,
            "Requested through OmniClaw as a planned shell action.",
          );
        },
      },
      web_research: {
        description: "Run lightweight web research using public web sources.",
        permission: "allowWebResearch",
        run: async ({ query }) => this.webResearch.search(String(query || "").trim()),
      },
      read_url: {
        description: "Fetch and read the text content of a specific public URL.",
        permission: "allowWebResearch",
        run: async ({ url }, context) =>
          this.runBrowserOperation("read_url", () => this.browserOperator.readUrl(String(url || "").trim()), context),
      },
      open_browser_url: {
        description: "Open a URL in the laptop's default browser.",
        permission: "allowBrowserControl",
        run: async ({ url }, context) =>
          this.runBrowserOperation("open_url", () => this.browserOperator.openUrl(String(url || "").trim()), context),
      },
      run_terminal_command: {
        description: "Execute a terminal command through OmniClaw shell policy and audit logging.",
        permission: "allowShellExecution",
        run: async ({ command, cwd }, context) =>
          this.agentRuntime?.executeTerminalCommand
            ? this.agentRuntime.executeTerminalCommand({
                command: String(command || "").trim(),
                cwd: String(cwd || "").trim(),
                context,
              })
            : this.shellPlanner.buildRequest(String(command || "").trim(), "Terminal execution requested."),
      },
      sandbox_status: {
        description: "Show the governed temp-workspace sandbox status, limits, and capabilities.",
        permission: null,
        group: "safety",
        run: async () => this.sandboxRunner?.getStatus?.() || { enabled: false },
      },
      sandbox_run: {
        description: "Run a shell command in an isolated temp workspace copy and report changed files without touching the real workspace.",
        permission: "allowShellExecution",
        group: "safety",
        run: async (input = {}) => this.sandboxRunner.run(input),
      },
      sandbox_apply: {
        description: "Apply selected changed files from a sandbox run into the real workspace.",
        permission: "allowFileWrite",
        group: "safety",
        run: async (input = {}) => this.sandboxRunner.apply(input),
      },
      list_processes: {
        description: "List currently running system processes (Windows).",
        permission: "allowShellExecution",
        run: async ({ filter }) => this.systemMonitor.listProcesses(String(filter || "").trim()),
      },
      exec: {
        description: "Execute a shell command with optional background mode. Use background=true for long-running commands. Returns processId for background processes.",
        permission: "allowShellExecution",
        group: "terminal",
        run: async ({ command, cwd, background, timeout }, context) => {
          const result = await this.shellExecutor.execute({
            command: String(command || "").trim(),
            cwd: String(cwd || "").trim(),
            background: Boolean(background),
          });
          return result;
        },
      },
      process_list: {
        description: "List all background processes started by OmniClaw. Filter by status: running, completed, failed, killed.",
        permission: null,
        group: "terminal",
        run: async ({ status }) => this.shellExecutor.listProcesses({ status }),
      },
      process_status: {
        description: "Get detailed status and output of a background process by ID.",
        permission: null,
        group: "terminal",
        run: async ({ processId }) => this.shellExecutor.getProcessStatus(String(processId || "").trim()),
      },
      process_kill: {
        description: "Kill a running background process by ID. Default signal is SIGTERM.",
        permission: "allowShellExecution",
        group: "terminal",
        run: async ({ processId, signal }) => this.shellExecutor.killProcess(
          String(processId || "").trim(),
          String(signal || "SIGTERM").trim()
        ),
      },
      process_cleanup: {
        description: "Remove completed/failed processes from the registry. Default maxAge is 1 hour.",
        permission: null,
        group: "terminal",
        run: async ({ maxAge }) => this.shellExecutor.cleanupProcesses({ maxAge }),
      },
      computer_system_status: {
        description: "Check laptop RAM, CPU, OS, and disk storage status.",
        permission: null,
        run: async () => this.systemMonitor.getComputerStatus(),
      },
      run_task: {
        description: "Run the latest open task or a task by id.",
        permission: "allowTaskRunner",
        run: async ({ taskId }, context) =>
          this.taskRunner.runTask(String(taskId || "").trim(), {
            agentId: this.getAgentId(context),
          }),
      },
      create_skill: {
        description: "Create a new local skill file for OmniClaw.",
        permission: "allowSkillWrite",
        run: async (input, context) =>
          this.customizationEngine.createSkill({
            ...input,
            agentId: input.agentId || this.getAgentId(context),
          }),
      },
      openclaw_vendor_status: {
        description: "Inspect the vendored OpenClaw reference checkout and license metadata.",
        permission: null,
        group: "openclaw",
        run: async () => this.getOpenClawVendorStatus(),
      },
      openclaw_code_study: {
        description: "Study the vendored OpenClaw source tree and produce an OmniClaw implementation map.",
        permission: null,
        group: "openclaw",
        run: async (input = {}) => this.getOpenClawCodeStudy(input),
      },
      hermes_reference_status: {
        description: "Summarize Hermes Agent reference ideas and map them to OmniClaw's current runtime.",
        permission: null,
        group: "hermes",
        run: async () => {
          const provider = this.agentRuntime?.getProviderInfo?.() || {};
          const report = this.agentRuntime?.getV2Report?.() || {};
          const agentCount = this.agentRegistry?.getAll?.()?.length || 0;
          const tools = this.getAll({ agentId: "main" });
          const toolIds = tools.map((tool) => tool.id);
          const vendor = this.getHermesVendorStatus();
          return {
            source: {
              name: "Hermes Agent",
              repo: "https://github.com/nousresearch/hermes-agent",
              license: "MIT",
              status: vendor.available ? "vendored in vendor/hermes-agent" : "external reference, not vendored into OmniClaw",
            },
            vendor,
            usefulPatterns: [
              "Slash command surface for /model, /skills, /usage, /doctor, and platform status.",
              "Self-improving skill library that grows from agent work.",
              "Full-text session/history search so old chats are first-class context.",
              "Gateway/channel layer for chat, cron, and background jobs.",
              "Subagents and terminal backends for real execution instead of prompt-only claims.",
            ],
            omniClawNow: {
              providerReady: Boolean(provider.ready),
              provider: provider.id || "unknown",
              model: provider.model || "",
              v2Score: report.score || 0,
              agentCount,
              toolCount: tools.length,
              commandSurface: ["/doctor", "/model", "/skills", "/usage", "/platforms", "/hermes"],
              matchingTools: toolIds.filter((id) => [
                "provider_status",
                "list_provider_models",
                "capability_demo",
                "sessions_list",
                "sessions_history",
                "memory_search",
                "gateway",
                "cron",
                "nodes",
                "subagents",
                "run_terminal_command",
                "browser_snapshot",
                "computer_access_status",
              ].includes(id)),
            },
            gaps: [
              "Self-improving skills are still manual/local skill writes, not automatic promotion from successful runs.",
              "Session history exists, but fast full-text search/indexing needs a stronger search layer.",
              "Gateways exist locally, but WhatsApp/Slack/Signal/iMessage adapters still need real account pairing.",
              "Terminal/browser tools are governed, but hard sandbox isolation is still partial.",
            ],
            nextBuildActions: [
              vendor.available
                ? "Scan vendored Hermes skills and import selected compatible skills into OmniClaw."
                : "Vendor Hermes Agent with license preserved before importing selected patterns.",
              "Make /doctor the first debugging path for provider, gateway, memory, tools, and permissions.",
              "Grow skill promotion from successful workflows into editable SKILL.md files.",
              "Index sessions and memories for laptop-wide recall/search.",
            ],
          };
        },
      },
      hermes_vendor_status: {
        description: "Inspect the vendored Hermes Agent reference copy and license metadata.",
        permission: null,
        group: "hermes",
        run: async () => this.getHermesVendorStatus(),
      },
      hermes_skill_scan: {
        description: "Scan vendored Hermes Agent SKILL.md files for possible OmniClaw imports.",
        permission: null,
        group: "hermes",
        run: async (input = {}) => this.scanHermesSkills(input),
      },
      hermes_tool_catalog: {
        description: "List Hermes Agent core tools and their OmniClaw compatibility/adaptation status.",
        permission: null,
        group: "hermes",
        run: async ({ status, toolset } = {}) => this.getHermesToolCatalog({ status, toolset }),
      },
      context_compression_status: {
        description: "Hermes-style context compression status: head/middle/tail, summary framing, token budget awareness.",
        permission: null,
        group: "runtime",
        run: async (_, context) => this.getContextCompressionStatus(context),
      },
      memory_lifecycle_status: {
        description: "Hermes-style memory lifecycle status: prefetch, fenced memory block, sync, dream sweep, and session search.",
        permission: null,
        group: "memory",
        run: async ({ query } = {}, context) => this.getMemoryLifecycleStatus({ query, context }),
      },
      skill_system_status: {
        description: "Hermes-style skills system status: progressive disclosure, agentskills compatibility, and self-improvement gaps.",
        permission: null,
        group: "skills",
        run: async (_, context) => this.getSkillSystemStatus(context),
      },
      messaging_gateway_status: {
        description: "Hermes-style messaging gateway status: adapters, session routing, voice/media ingestion, and DM security.",
        permission: null,
        group: "gateway",
        run: async (_, context) => this.getMessagingGatewayStatus(context),
      },
      configure_telegram: {
        description: "Configure the Telegram Bot adapter from a bot token, test it, and optionally start the polling worker.",
        permission: "allowConnectorWrite",
        group: "gateway",
        run: async (input = {}) => this.configureTelegramAdapter(input),
      },
      terminal_backends_status: {
        description: "Hermes-style terminal backend status: local/docker/ssh/cloud backends, process registry, and approval gates.",
        permission: null,
        group: "runtime",
        run: async (_, context) => this.getTerminalBackendsStatus(context),
      },
      model_provider_status: {
        description: "Hermes-style multi-provider model support status: API mode, credential pool, failover, and model discovery.",
        permission: null,
        group: "provider",
        run: async (_, context) => this.getModelProviderStatus(context),
      },
      subagent_delegation_status: {
        description: "Hermes-style subagent delegation status: isolation, blocked child tools, concurrency, and shared budget.",
        permission: null,
        group: "delegation",
        run: async (_, context) => this.getSubagentDelegationStatus(context),
      },
      mcp_integration_status: {
        description: "Hermes-style MCP integration status: configured servers, live tool registry, aliases, and ACP gap.",
        permission: null,
        group: "mcp",
        run: async (_, context) => this.getMcpIntegrationStatus(context),
      },
      mcp_connect_all: {
        description: "Connect all configured MCP servers and refresh their live tool registry.",
        permission: "allowConfigWrite",
        group: "mcp",
        run: async () => this.connectAllMcpServers(),
      },
      cron_scheduler_status: {
        description: "Hermes-style built-in cron scheduler status: schedules, background jobs, triggers, and delivery path.",
        permission: null,
        group: "cron",
        run: async (_, context) => this.getCronSchedulerStatus(context),
      },
      trajectory_training_status: {
        description: "Hermes-style trajectory generation and RL training status for agent runs/tool traces.",
        permission: null,
        group: "research",
        run: async (_, context) => this.getTrajectoryTrainingStatus(context),
      },
      closed_learning_loop_status: {
        description: "Hermes-style closed learning loop status: session logging, memory nudges, skill promotion, and next interaction improvement.",
        permission: null,
        group: "learning",
        run: async (_, context) => this.getClosedLearningLoopStatus(context),
      },
      hermes_use_cases_status: {
        description: "Map Hermes use-case categories to OmniClaw's current real capabilities and gaps.",
        permission: null,
        group: "runtime",
        run: async (_, context) => this.getHermesUseCasesStatus(context),
      },
      design_principles_status: {
        description: "Report Hermes-style design principles and OmniClaw compliance/gaps.",
        permission: null,
        group: "runtime",
        run: async (_, context) => this.getDesignPrinciplesStatus(context),
      },
      openclaw_skill_scan: {
        description: "Scan vendored OpenClaw SKILL.md files for possible OmniClaw imports.",
        permission: null,
        group: "openclaw",
        run: async (input = {}) => this.scanOpenClawSkills(input),
      },
      openclaw_skill_import: {
        description: "Import one vendored OpenClaw SKILL.md into OmniClaw's local .skill format.",
        permission: "allowSkillWrite",
        group: "openclaw",
        run: async (input = {}, context) => this.importOpenClawSkill(input, context),
      },
      openclaw_skill_pack_import: {
        description: "Import a curated OpenClaw compatibility skill pack into OmniClaw agents.",
        permission: "allowSkillWrite",
        group: "openclaw",
        run: async (input = {}, context) => this.importOpenClawSkillPack(input, context),
      },
      update_runtime_settings: {
        description: "Update OmniClaw runtime profile or provider mode.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.updateRuntimeSettings(input),
      },
      delegate_task: {
        description: "Delegate a complex task to a specialized sub-agent (research, builder, ops).",
        permission: "allowShellPlanning",
        run: async ({ agentId, task }, context) => {
          const targetAgentId = String(agentId || "").trim();
          const instruction = String(task || "").trim();
          if (!targetAgentId) {
            throw new Error("target agentId is required");
          }
          if (!instruction) {
            throw new Error("delegated task is required");
          }
          const agents = this.agentRegistry?.getAll?.() || [];
          if (agents.length > 0 && !agents.some((agent) => agent.id === targetAgentId)) {
            throw new Error(`Unknown target agent: ${targetAgentId}`);
          }

          return {
            delegated: true,
            targetAgentId,
            status: "queued",
            instruction,
            parentSessionId: context.sessionId || "",
            parentRunId: context.runId || "",
          };
        }
      },
      apply_provider_profile: {
        description: "Apply a saved provider profile.",
        permission: "allowConfigWrite",
        run: async ({ profileId }) => this.customizationEngine.applyProviderProfile(String(profileId || "").trim()),
      },
      set_provider_key: {
        description: "Store a BYOK provider key locally.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.setProviderKey(input),
      },
      get_provider_key_status: {
        description: "Read provider BYOK key status (masked only).",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.getProviderKeyStatus(input),
      },
      test_provider_profile: {
        description: "Validate provider profile and key readiness.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.testProviderProfile(input),
      },
      list_provider_models: {
        description: "Fetch available models from the selected provider's /models endpoint.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.listProviderModels(input),
      },
      exec: {
        description: "OpenClaw-compatible alias for governed terminal command execution.",
        permission: "allowShellExecution",
        group: "runtime",
        run: async ({ command, cwd }, context) => this.tools.run_terminal_command.run({ command, cwd }, context),
      },
      terminal: {
        description: "Hermes-compatible governed terminal command execution.",
        permission: "allowShellExecution",
        group: "hermes-terminal",
        run: async ({ command, cwd }, context) => this.tools.run_terminal_command.run({ command, cwd }, context),
      },
      process: {
        description: "OpenClaw-compatible process inspection tool.",
        permission: "allowShellExecution",
        group: "runtime",
        run: async ({ filter }) => this.systemMonitor.listProcesses(String(filter || "").trim()),
      },
      code_execution: {
        description: "Run a small Python snippet through governed terminal execution.",
        permission: "allowShellExecution",
        group: "runtime",
        run: async ({ code }, context) => {
          const snippet = String(code || "").trim();
          if (!snippet) {
            throw new Error("code is required.");
          }
          const encoded = Buffer.from(snippet, "utf8").toString("base64");
          const command = `python -c "import base64; exec(base64.b64decode('${encoded}').decode('utf-8'))"`;
          return this.tools.run_terminal_command.run({ command }, context);
        },
      },
      execute_code: {
        description: "Hermes-compatible Python code execution alias.",
        permission: "allowShellExecution",
        group: "hermes-code",
        run: async ({ code }, context) => this.tools.code_execution.run({ code }, context),
      },
      browser: {
        description: "OpenClaw-compatible browser helper for URL open/fetch and DevTools automation actions.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) => {
          const { action, url } = input;
          const normalizedAction = String(action || "open").trim().toLowerCase();
          if (["status", "snapshot", "observe", "inspect", "screenshot", "capture", "text", "links", "click", "type", "fill"].includes(normalizedAction)) {
            return this.runBrowserOperation(normalizedAction, () => this.browserOperator.automate(input), context);
          }
          if (["navigate", "goto"].includes(normalizedAction)) {
            return this.runBrowserOperation(normalizedAction, () => this.browserOperator.automate(input), context);
          }
          if (["fetch", "read", "read_url"].includes(normalizedAction)) {
            return this.runBrowserOperation("read_url", () => this.browserOperator.readUrl(String(url || "").trim()), context);
          }
          if (["open"].includes(normalizedAction)) {
            return this.runBrowserOperation("open_url", () => this.browserOperator.openUrl(String(url || "").trim()), context);
          }
          return {
            ok: false,
            action: normalizedAction,
            message: "Supported browser actions: status, open, navigate/goto, fetch/read, screenshot, text, links, click, type/fill.",
          };
        },
      },
      browser_status: {
        description: "Check real browser automation availability and current browser session.",
        permission: null,
        group: "ui",
        run: async () => this.browserOperator.getStatus?.() || {},
      },
      browser_audit: {
        description: "List recent governed browser actions captured in the gateway audit feed.",
        permission: null,
        group: "ui",
        run: async ({ limit }) => ({
          operations: this.getBrowserAudit(Number(limit || 25)),
          localActions: this.browserOperator.getStatus?.().recentActions || [],
        }),
      },
      browser_snapshot: {
        description: "Observe the current browser page: URL, title, text preview, links, controls, and forms.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) =>
          this.runBrowserOperation("snapshot", () => this.browserOperator.automate({ ...input, action: "snapshot" }), context),
      },
      browser_links: {
        description: "Extract visible links from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) =>
          this.runBrowserOperation("links", () => this.browserOperator.automate({ ...input, action: "links" }), context),
      },
      browser_screenshot: {
        description: "Capture a screenshot from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) =>
          this.runBrowserOperation("screenshot", () => this.browserOperator.automate({ ...input, action: "screenshot" }), context),
      },
      browser_text: {
        description: "Extract visible text from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) =>
          this.runBrowserOperation("text", () => this.browserOperator.automate({ ...input, action: "text" }), context),
      },
      browser_navigate: {
        description: "Hermes-compatible browser navigation tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async ({ url } = {}, context) =>
          this.tools.browser.run({ action: "navigate", url }, context),
      },
      browser_click: {
        description: "Hermes-compatible browser click tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.tools.browser.run({ ...input, action: "click" }, context),
      },
      browser_type: {
        description: "Hermes-compatible browser type/fill tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.tools.browser.run({ ...input, action: "type" }, context),
      },
      browser_scroll: {
        description: "Hermes-compatible browser scroll tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.tools.browser.run({ ...input, action: "scroll" }, context),
      },
      browser_back: {
        description: "Hermes-compatible browser back tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.tools.browser.run({ ...input, action: "back" }, context),
      },
      browser_press: {
        description: "Hermes-compatible browser key press tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.tools.browser.run({ ...input, action: "press" }, context),
      },
      browser_get_images: {
        description: "Hermes-compatible browser image discovery tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.tools.browser.run({ ...input, action: "links" }, context),
      },
      browser_vision: {
        description: "Hermes-compatible browser vision placeholder backed by screenshot capture.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) => {
          const screenshot = await this.tools.browser_screenshot.run(input, context);
          return {
            ready: false,
            screenshot,
            message: "Browser screenshot captured. Vision analysis needs an image-capable provider/plugin to interpret it.",
          };
        },
      },
      browser_console: {
        description: "Hermes-compatible browser console placeholder.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async () => this.hermesToolNotReady("browser_console", "Console log extraction needs a Playwright/CDP adapter wired into OmniClaw."),
      },
      browser_cdp: {
        description: "Hermes-compatible Chrome DevTools Protocol placeholder.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async () => this.hermesToolNotReady("browser_cdp", "Raw CDP command execution needs a hardened browser adapter."),
      },
      browser_dialog: {
        description: "Hermes-compatible browser dialog placeholder.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async () => this.hermesToolNotReady("browser_dialog", "Dialog accept/dismiss support needs browser adapter wiring."),
      },
      web_search: {
        description: "OpenClaw-compatible web search alias.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ query }) => this.webResearch.search(String(query || "").trim()),
      },
      web_extract: {
        description: "Hermes-compatible URL extraction/fetch alias.",
        permission: "allowWebResearch",
        group: "hermes-web",
        run: async ({ url }, context) => this.tools.web_fetch.run({ url }, context),
      },
      x_search: {
        description: "Search public web results scoped toward X/Twitter posts.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ query }) => this.webResearch.search(`${String(query || "").trim()} site:x.com OR site:twitter.com`),
      },
      web_fetch: {
        description: "OpenClaw-compatible URL fetch alias.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ url }, context) =>
          this.runBrowserOperation("web_fetch", () => this.browserOperator.readUrl(String(url || "").trim()), context),
      },
      read: {
        description: "OpenClaw-compatible workspace file read alias.",
        permission: "allowFileRead",
        group: "fs",
        run: async ({ path }) => this.tools.read_file.run({ path }),
      },
      write: {
        description: "OpenClaw-compatible workspace file write alias.",
        permission: "allowFileWrite",
        group: "fs",
        run: async ({ path, content, append }) =>
          append ? this.tools.append_file.run({ path, content }) : this.tools.write_file.run({ path, content }),
      },
      edit: {
        description: "Edit a workspace file by replacing exact text with new text inside writable roots.",
        permission: "allowFileWrite",
        group: "fs",
        run: async ({ path, find, replace }) => {
          const config = this.configStore.getConfig();
          const read = this.fileStore.readText(path, config.tools.filesystem.maxReadBytes);
          const target = String(find || "");
          if (!target) {
            throw new Error("find text is required.");
          }
          if (!read.content.includes(target)) {
            return {
              edited: false,
              path: read.path,
              message: "Find text was not present in file.",
            };
          }
          const next = read.content.replace(target, String(replace || ""));
          const write = this.fileStore.writeText(path, next, {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
          return {
            edited: true,
            replacements: 1,
            ...write,
          };
        },
      },
      apply_patch: {
        description: "OpenClaw-compatible patch entrypoint. Stores patch text as an artifact for review; direct application is intentionally gated.",
        permission: "allowFileWrite",
        group: "fs",
        run: async ({ patch, label }) => {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const safeLabel = String(label || "patch").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "patch";
          const path = `docs/drafts/${stamp}-${safeLabel}.patch`;
          const config = this.configStore.getConfig();
          return {
            applied: false,
            gated: true,
            reason: "Patch was saved for review. Use Codex/apply_patch or an approved shell command to apply it.",
            artifact: this.fileStore.writeText(path, String(patch || ""), {
              allowedRoots: config.tools.filesystem.writableRoots,
              append: false,
            }),
          };
        },
      },
      patch: {
        description: "Hermes-compatible patch alias.",
        permission: "allowFileWrite",
        group: "hermes-file",
        run: async (input = {}, context) => this.tools.apply_patch.run(input, context),
      },
      search_files: {
        description: "Hermes-compatible search across memory and configured computer roots.",
        permission: "allowComputerAccess",
        group: "hermes-file",
        run: async ({ pattern, query, path, target, limit } = {}, context) => {
          const q = String(query || pattern || "").trim();
          if (!q) {
            throw new Error("pattern or query is required.");
          }
          const memory = await this.tools.memory_search.run({ query: q }, context);
          let files = null;
          try {
            files = await this.tools.search_computer_files.run({
              query: q,
              root: path,
              target,
              maxResults: Number(limit || 80),
              maxDepth: 4,
              maxScanMs: 7000,
            }, context);
          } catch (error) {
            files = {
              ok: false,
              error: error.message,
            };
          }
          return { query: q, memory, files };
        },
      },
      message: {
        description: "Send a message into an OmniClaw agent session/channel.",
        permission: "allowConnectorWrite",
        group: "messaging",
        run: async ({ text, message, agentId, label, channel }) => {
          if (!this.agentRuntime?.handleMessage) {
            throw new Error("Agent message runtime is unavailable.");
          }
          return this.agentRuntime.handleMessage(String(text || message || "").trim(), {
            agentId: String(agentId || "main").trim(),
            label: String(label || "tool-message").trim(),
            channel: String(channel || "webchat").trim(),
          });
        },
      },
      send_message: {
        description: "Hermes-compatible cross-platform message send alias.",
        permission: "allowConnectorWrite",
        group: "hermes-messaging",
        run: async (input = {}) => this.tools.message.run(input),
      },
      sessions_list: {
        description: "List OmniClaw sessions.",
        permission: null,
        group: "sessions",
        run: async ({ limit }) => ({
          sessions: this.agentRuntime?.sessions?.listSessions?.(Number(limit || 50)) || [],
        }),
      },
      sessions_history: {
        description: "Read transcript history for one session.",
        permission: null,
        group: "sessions",
        run: async ({ sessionId, limit }, context) => {
          const sessions = this.agentRuntime?.sessions;
          if (!sessions?.getSession) {
            throw new Error("Session runtime is unavailable.");
          }
          const resolvedSessionId = String(sessionId || context.sessionId || "").trim();
          if (!resolvedSessionId) {
            return {
              session: null,
              transcript: [],
              message: "No sessionId was provided and the current tool context has no sessionId.",
            };
          }
          const session = sessions.getSession(resolvedSessionId, {
            messageLimit: Number(limit || 80),
          });
          if (!session) {
            return {
              session: null,
              transcript: [],
              message: `Session not found: ${resolvedSessionId}`,
            };
          }
          return {
            session,
            transcript: Array.isArray(session.transcript) ? session.transcript : [],
          };
        },
      },
      sessions_send: {
        description: "OpenClaw-compatible session send alias.",
        permission: "allowConnectorWrite",
        group: "sessions",
        run: async (input) => this.tools.message.run(input),
      },

      browser_open: {
        description: "Open a URL in a browser. Returns sessionId for subsequent operations.",
        permission: null,
        group: "browser",
        run: async ({ url, sessionId }) => this.browser.open({ url, sessionId }),
      },
      browser_view: {
        description: "View current page content and/or screenshot. Format: markdown, screenshot, or both.",
        permission: null,
        group: "browser",
        run: async ({ sessionId, format }) => this.browser.view({ sessionId, format: format || "markdown" }),
      },
      browser_screenshot: {
        description: "Take a screenshot of current page or specific element.",
        permission: null,
        group: "browser",
        run: async ({ sessionId, fullPage, selector }) => this.browser.screenshot({ sessionId, fullPage, selector }),
      },
      browser_click: {
        description: "Click an element on the page. Use CSS selector.",
        permission: null,
        group: "browser",
        run: async ({ sessionId, selector, waitForNavigation }) => this.browser.click({ sessionId, selector, waitForNavigation }),
      },
      browser_type: {
        description: "Type text into an input field. Set pressEnter=true to submit.",
        permission: null,
        group: "browser",
        run: async ({ sessionId, selector, text, pressEnter }) => this.browser.type({ sessionId, selector, text, pressEnter }),
      },
      browser_scroll: {
        description: "Scroll the page. Direction: up or down.",
        permission: null,
        group: "browser",
        run: async ({ sessionId, direction, amount }) => this.browser.scroll({ sessionId, direction: direction || "down", amount: amount || 500 }),
      },
      browser_wait: {
        description: "Wait for element or timeout in ms.",
        permission: null,
        group: "browser",
        run: async ({ sessionId, selector, timeout }) => this.browser.wait({ sessionId, selector, timeout }),
      },
      browser_evaluate: {
        description: "Run JavaScript in the browser page context.",
        permission: "allowBrowserEvaluate",
        group: "browser",
        run: async ({ sessionId, script }) => this.browser.evaluate({ sessionId, script }),
      },
      browser_back: {
        description: "Navigate back in browser history.",
        permission: null,
        group: "browser",
        run: async ({ sessionId }) => this.browser.goBack({ sessionId }),
      },
      browser_forward: {
        description: "Navigate forward in browser history.",
        permission: null,
        group: "browser",
        run: async ({ sessionId }) => this.browser.goForward({ sessionId }),
      },
      browser_close: {
        description: "Close the browser session.",
        permission: null,
        group: "browser",
        run: async ({ sessionId }) => this.browser.close({ sessionId }),
      },
      browser_automate: {
        description: "Perform multiple browser actions in sequence. Actions: click, type, scroll, wait, screenshot, evaluate.",
        permission: null,
        group: "browser",
        run: async ({ url, actions, sessionId }) => this.browser.automate({ url, actions, sessionId }),
      },
      browser_sessions: {
        description: "List all active browser sessions.",
        permission: null,
        group: "browser",
        run: async () => this.browser.listSessions(),
      },

      sessions_spawn: {
        description: "Start a new OmniClaw session lane by label, agent, and channel.",
        permission: null,
        group: "sessions",
        run: async ({ label, agentId, channel }) => {
          const session = this.agentRuntime?.sessions?.resolveSession?.({
            label: String(label || "spawned").trim(),
            agentId: String(agentId || "main").trim(),
            channel: String(channel || "webchat").trim(),
          });
          return { spawned: Boolean(session), session };
        },
      },
      sessions_yield: {
        description: "Return current run/session status without doing more work.",
        permission: null,
        group: "sessions",
        run: async (_, context) => ({
          yielded: true,
          sessionId: context.sessionId || "",
          runId: context.runId || "",
          agentId: this.getAgentId(context),
        }),
      },
      session_status: {
        description: "Lightweight /status-style readback for provider, queue, session, and active agent.",
        permission: null,
        group: "sessions",
        run: async (_, context) => ({
          provider: this.agentRuntime?.getProviderInfo?.() || {},
          gateway: this.agentRuntime?.gateway?.getOverview?.() || {},
          sessionId: context.sessionId || "",
          runId: context.runId || "",
          agent: this.agentRegistry?.resolveAgent?.(this.getAgentId(context)) || null,
        }),
      },
      subagents: {
        description: "List available sub-agents and optionally delegate a task.",
        permission: "allowShellPlanning",
        group: "sessions",
        run: async ({ agentId, task }, context) => {
          if (task) {
            return this.tools.delegate_task.run({ agentId, task }, context);
          }
          return {
            agents: this.agentRegistry?.getAll?.() || [],
          };
        },
      },
      agents_list: {
        description: "List configured OmniClaw agents.",
        permission: null,
        group: "sessions",
        run: async () => ({
          agents: this.agentRegistry?.getAll?.() || [],
        }),
      },
      skills_list: {
        description: "Hermes-compatible skill listing across OmniClaw and vendored Hermes skills.",
        permission: null,
        group: "hermes-skills",
        run: async (input = {}, context) => {
          const agentId = this.getAgentId(context);
          const omniSkills = this.agentRegistry
            ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
            : [];
          const hermes = this.scanHermesSkills({
            query: input.query || "",
            limit: Number(input.limit || 40),
          });
          return {
            agentId,
            omniSkillCount: omniSkills.length,
            hermesSkillCount: hermes.totalAvailable,
            omniSkills,
            hermesSkills: hermes.skills,
          };
        },
      },
      skill_view: {
        description: "Hermes-compatible skill read/view tool.",
        permission: null,
        group: "hermes-skills",
        run: async ({ id, name, path: skillPath } = {}) => {
          const target = String(skillPath || id || name || "").trim();
          if (!target) {
            throw new Error("skill id/name/path is required.");
          }
          const root = this.getRootDir();
          const candidates = this.getHermesSkillFiles();
          const match = candidates.find((filePath) => {
            const relative = path.relative(root, filePath).replace(/\\/g, "/");
            return relative.toLowerCase().includes(target.toLowerCase()) ||
              path.basename(path.dirname(filePath)).toLowerCase() === target.toLowerCase();
          });
          if (!match) {
            return {
              found: false,
              query: target,
              message: "Skill not found in vendored Hermes skills.",
            };
          }
          return {
            found: true,
            path: path.relative(root, match).replace(/\\/g, "/"),
            content: fs.readFileSync(match, "utf8"),
          };
        },
      },
      skill_manage: {
        description: "Hermes-compatible skill management placeholder for reviewable imports.",
        permission: "allowSkillWrite",
        group: "hermes-skills",
        run: async (input = {}) => ({
          ok: false,
          action: input.action || "review",
          message: "Hermes skill management is cataloged. Use hermes_skill_scan plus a dedicated import step so incompatible Python-only instructions are not blindly installed.",
          nextUpgrade: "Add hermes_skill_import with compatibility rewrite into OmniClaw skill format.",
        }),
      },
      memory_search: {
        description: "Search notes and promoted memory by text.",
        permission: null,
        group: "memory",
        run: async ({ query }, context) => {
          const q = String(query || "").trim().toLowerCase();
          const notes = this.memoryStore.getNotes(this.getAgentId(context)).filter((item) =>
            JSON.stringify(item).toLowerCase().includes(q),
          );
          const memories = this.memoryStore.getLongTermMemory(100, this.getAgentId(context)).filter((item) =>
            JSON.stringify(item).toLowerCase().includes(q),
          );
          return { query: q, notes, memories };
        },
      },
      memory_get: {
        description: "Read long-term memory overview and recent promoted memories.",
        permission: null,
        group: "memory",
        run: async (_, context) => this.tools.list_long_term_memory.run(_, context),
      },
      memory: {
        description: "Hermes-compatible memory read/search/save/promote tool.",
        permission: null,
        group: "hermes-memory",
        run: async ({ action, query, text } = {}, context) => {
          const normalized = String(action || (text ? "remember" : query ? "search" : "list")).toLowerCase();
          if (["search", "find"].includes(normalized)) {
            return this.tools.memory_search.run({ query }, context);
          }
          if (["remember", "save", "note"].includes(normalized)) {
            return this.tools.remember_note.run({ text }, context);
          }
          if (["promote"].includes(normalized)) {
            return this.tools.promote_memory.run({ text, sourceType: "manual" }, context);
          }
          return this.tools.list_long_term_memory.run({}, context);
        },
      },
      session_search: {
        description: "Hermes-compatible session and memory search.",
        permission: null,
        group: "hermes-memory",
        run: async ({ query, limit } = {}, context) => {
          const sessions = await this.tools.sessions_list.run({ limit: Number(limit || 20) }, context);
          const memory = query ? await this.tools.memory_search.run({ query }, context) : null;
          return {
            query: query || "",
            sessions,
            memory,
            message: "Full transcript FTS is a next upgrade; this returns session list plus memory search now.",
          };
        },
      },
      clarify: {
        description: "Hermes-compatible clarify placeholder. The assistant should ask the user directly.",
        permission: null,
        group: "hermes-planning",
        run: async ({ question, options } = {}) => ({
          needsUserInput: true,
          question: question || "Please clarify the request.",
          options: Array.isArray(options) ? options : [],
          message: "Clarify is represented as a tool result; the chat layer can ask this question directly.",
        }),
      },
      mixture_of_agents: {
        description: "Hermes-compatible multi-agent reasoning placeholder backed by OmniClaw subagents.",
        permission: "allowShellPlanning",
        group: "hermes-planning",
        run: async ({ task } = {}, context) => ({
          ok: false,
          availableSubagents: await this.tools.subagents.run({}, context),
          task: task || "",
          message: "Mixture-of-agents is cataloged. Use delegate_task/subagents for concrete routed work until full MoA orchestration is built.",
        }),
      },
      computer_use: {
        description: "Hermes-compatible computer-use status backed by OmniClaw laptop access, browser, and terminal tools.",
        permission: null,
        group: "hermes-computer",
        run: async () => this.tools.computer_access_status.run(),
      },
      ha_list_entities: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_list_entities", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      ha_get_state: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_get_state", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      ha_list_services: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_list_services", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      ha_call_service: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_call_service", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      nodes: {
        description: "Discover paired/trusted nodes and local host bindings.",
        permission: null,
        group: "runtime",
        run: async () => ({
          localNode: {
            id: "local-windows-host",
            role: "gateway",
            status: "online",
          },
          trust: this.agentRuntime?.trust?.getOverview?.() || {},
          devices: this.agentRuntime?.trust?.listDevices?.() || [],
        }),
      },
      canvas: {
        description: "Canvas compatibility status. Full node canvas eval/snapshot is not yet enabled.",
        permission: null,
        group: "ui",
        run: async () => ({
          ready: false,
          message: "Canvas tool surface is registered for OpenClaw compatibility; full canvas runtime is a next upgrade.",
        }),
      },
      cron: {
        description: "List schedules and background jobs.",
        permission: null,
        group: "runtime",
        run: async ({ limit }) => ({
          schedules: this.agentRuntime?.schedules?.listSchedules?.(Number(limit || 50)) || [],
          jobs: this.agentRuntime?.jobs?.listJobs?.(Number(limit || 50)) || [],
        }),
      },
      cronjob: {
        description: "Hermes-compatible cron job listing/status alias.",
        permission: null,
        group: "hermes-runtime",
        run: async (input = {}) => this.tools.cron.run(input),
      },
      kanban_show: {
        description: "Hermes-compatible kanban placeholder.",
        permission: null,
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_show", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_list: {
        description: "Hermes-compatible kanban placeholder.",
        permission: null,
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_list", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_complete: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_complete", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_block: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_block", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_heartbeat: {
        description: "Hermes-compatible kanban placeholder.",
        permission: null,
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_heartbeat", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_comment: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_comment", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_create: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_create", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_link: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_link", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_unblock: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_unblock", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      gateway: {
        description: "Inspect OmniClaw gateway overview, events, runs, approvals, and provider status.",
        permission: null,
        group: "runtime",
        run: async ({ limit }) => {
          const gateway = this.agentRuntime?.gateway;
          return {
            overview: gateway?.getOverview?.() || {},
            events: gateway?.listEvents?.(Number(limit || 20)) || [],
            runs: gateway?.listRuns?.(Number(limit || 20)) || [],
            approvals: gateway?.listApprovals?.("") || [],
            provider: this.agentRuntime?.getProviderInfo?.() || {},
          };
        },
      },
      image: {
        description: "Image analysis compatibility tool backed by attachment media analysis when configured.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async (input) => this.tools.analyze_attachment_media.run(input),
      },
      image_generate: {
        description: "Image generation compatibility placeholder. Requires adding an image provider plugin.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async ({ prompt }) => this.mediaNotConfigured("image_generate", prompt),
      },
      vision_analyze: {
        description: "Hermes-compatible image analysis alias.",
        permission: "allowConnectorWrite",
        group: "hermes-media",
        run: async (input = {}) =>
          input.extractId || input.cacheId
            ? this.tools.image.run(input)
            : this.tools.analyze_pending_media_attachments.run({ limit: input.limit || 5, force: input.force }),
      },
      video_analyze: {
        description: "Hermes-compatible video analysis alias.",
        permission: "allowConnectorWrite",
        group: "hermes-media",
        run: async (input = {}) => this.tools.analyze_pending_media_attachments.run({ ...input, limit: input.limit || 5 }),
      },
      text_to_speech: {
        description: "Hermes-compatible text-to-speech placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-media",
        run: async ({ text, voice } = {}) => ({
          ok: false,
          configured: false,
          textPreview: String(text || "").slice(0, 180),
          voice: voice || "",
          message: "Text-to-speech tool is cataloged from Hermes, but OmniClaw needs a TTS provider plugin before audio can be generated.",
        }),
      },
      music_generate: {
        description: "Music generation compatibility placeholder. Requires adding a music provider plugin.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async ({ prompt }) => this.mediaNotConfigured("music_generate", prompt),
      },
      video_generate: {
        description: "Video generation compatibility placeholder. Requires adding a video provider plugin.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async ({ prompt }) => this.mediaNotConfigured("video_generate", prompt),
      },
      tts: {
        description: "Text-to-speech compatibility placeholder. Requires adding a TTS provider plugin.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async ({ text }) => this.mediaNotConfigured("tts", text),
      },
      delegate_task: {
        description: "Delegate a complex task to a sub-agent that runs independently with its own tool loop. Returns when the sub-agent completes.",
        permission: "allowTaskWrite",
        group: "delegation",
        run: async ({ task, tools, model, timeoutMs, systemPrompt }, context) => {
          if (!this.subAgentSpawner) {
            throw new Error("Sub-agent spawner is not available.");
          }
          return this.subAgentSpawner.spawn({
            task: String(task || "").trim(),
            parentAgentId: this.getAgentId(context),
            tools: Array.isArray(tools) ? tools : [],
            model: String(model || "").trim(),
            timeoutMs: Number(timeoutMs) || 0,
            systemPrompt: String(systemPrompt || "").trim(),
            context,
          });
        },
      },
      subagents: {
        description: "List active and recently completed sub-agents, or cancel a running sub-agent.",
        permission: null,
        group: "delegation",
        run: async ({ action, agentId } = {}) => {
          if (!this.subAgentSpawner) {
            throw new Error("Sub-agent spawner is not available.");
          }
          const normalizedAction = String(action || "").toLowerCase();
          if (normalizedAction === "cancel" && agentId) {
            return this.subAgentSpawner.cancel(String(agentId).trim());
          }
          if (normalizedAction === "history") {
            return { history: this.subAgentSpawner.getHistory(20) };
          }
          return this.subAgentSpawner.getStatus();
        },
      },
    };
  }

  getAgentId(context = {}) {
    const normalized = normalizeContext(context);
    const requestedAgentId = String(normalized.agentId || "").trim();
    if (!this.agentRegistry) {
      return requestedAgentId || "main";
    }
    return this.agentRegistry.resolveAgent(requestedAgentId).id;
  }

  getComputerAccessPolicy() {
    const config = this.configStore.getConfig();
    const policy = config.tools?.computerAccess || {};
    return {
      enabled: policy.enabled !== false,
      allowedRoots: Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0 ? policy.allowedRoots : ["~"],
      blockedPathPatterns: Array.isArray(policy.blockedPathPatterns)
        ? policy.blockedPathPatterns
        : [
            "^[A-Z]:/$",
            "^[A-Z]:/Windows(?:/|$)",
            "^[A-Z]:/Program Files(?:/|$)",
            "^[A-Z]:/Program Files \\(x86\\)(?:/|$)",
            "^[A-Z]:/ProgramData(?:/|$)",
          ],
      allowWrite: policy.allowWrite !== false,
      allowDelete: policy.allowDelete !== false,
      allowPermanentDelete: Boolean(policy.allowPermanentDelete),
      trashDir: policy.trashDir || "data/trash",
    };
  }

  requireComputerAccessPolicy() {
    const policy = this.getComputerAccessPolicy();
    if (!policy.enabled) {
      throw new Error("Computer access is disabled by runtime policy.");
    }
    return policy;
  }

  recordComputerAccessOperation(action, result = {}, context = {}) {
    const gateway = this.agentRuntime?.gateway;
    if (!gateway?.addEvent) {
      return null;
    }
    return gateway.addEvent("computer.access_operation", {
      action,
      agentId: this.getAgentId(context),
      runId: context.runId || "",
      sessionId: context.sessionId || "",
      path: result.path || result.source || "",
      destination: result.destination || result.movedTo || "",
      type: result.type || "",
      bytes: result.bytes ?? result.bytesRead ?? result.bytesWritten ?? 0,
      permanent: Boolean(result.permanent),
      overwritten: Boolean(result.overwritten),
      ok: !result.error,
    });
  }

  getComputerAccessAudit(limit = 25) {
    const gateway = this.agentRuntime?.gateway;
    const count = Math.max(1, Math.min(100, Number(limit || 25)));
    return (gateway?.listEvents?.(200) || [])
      .filter((event) => event.event === "computer.access_operation")
      .slice(0, count)
      .map((event) => ({
        id: event.id,
        at: event.at,
        seq: event.seq,
        ...event.payload,
      }));
  }

  async runBrowserOperation(action, fn, context = {}) {
    const startedAt = Date.now();
    const config = this.configStore.getConfig();
    const timeoutMs = Math.max(1000, Math.min(120000, Number(config.tools?.browserControl?.timeoutMs || 30000)));
    let result;
    try {
      result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Browser operation timed out after ${timeoutMs}ms: ${action}`)), timeoutMs)),
      ]);
      this.recordBrowserOperation(action, result, context, Date.now() - startedAt);
      return result;
    } catch (error) {
      const failed = {
        ok: false,
        action,
        error: error.message,
      };
      this.recordBrowserOperation(action, failed, context, Date.now() - startedAt);
      throw error;
    }
  }

  recordBrowserOperation(action, result = {}, context = {}, durationMs = 0) {
    const gateway = this.agentRuntime?.gateway;
    if (!gateway?.addEvent) {
      return null;
    }
    const snapshot = result.snapshot || {};
    return gateway.addEvent("browser.operation", {
      action,
      agentId: this.getAgentId(context),
      runId: context.runId || "",
      sessionId: context.sessionId || "",
      ok: result.error ? false : Boolean(result.ok ?? result.opened ?? (result.status ? result.status === "success" : true)),
      url: result.url || snapshot.url || "",
      title: result.title || snapshot.title || "",
      screenshotPath: result.screenshot?.path || "",
      linkCount: Array.isArray(result.links) ? result.links.length : Array.isArray(snapshot.links) ? snapshot.links.length : 0,
      controlCount: Array.isArray(snapshot.controls) ? snapshot.controls.length : 0,
      durationMs,
      error: result.error || "",
    });
  }

  getBrowserAudit(limit = 25) {
    const gateway = this.agentRuntime?.gateway;
    const count = Math.max(1, Math.min(100, Number(limit || 25)));
    return (gateway?.listEvents?.(200) || [])
      .filter((event) => event.event === "browser.operation")
      .slice(0, count)
      .map((event) => ({
        id: event.id,
        at: event.at,
        seq: event.seq,
        ...event.payload,
      }));
  }

  getProductToolMetadata(id, tool = {}) {
    const limited = LIMITED_PRODUCT_TOOLS[id];
    if (!limited) {
      return {
        runtimeStatus: "ready",
        productReady: true,
        modelCallable: true,
        replacement: "",
        readinessReason: "Backend is wired.",
      };
    }
    return {
      runtimeStatus: limited.status,
      productReady: false,
      modelCallable: false,
      replacement: limited.replacement || "",
      readinessReason: limited.reason || "Backend is not production-ready yet.",
    };
  }

  getAll(context = {}) {
    const normalized = normalizeContext(context);
    const tools = [
      ...Object.entries(this.tools).map(([id, tool]) => ({
        id,
        description: tool.description,
        permission: tool.permission,
        group: tool.group || "",
        ...this.getProductToolMetadata(id, tool),
      })),
      ...this.pluginRegistry.getToolDefinitions().map((tool) => ({
        ...tool,
        runtimeStatus: "plugin",
        productReady: true,
        modelCallable: true,
        replacement: "",
        readinessReason: "Plugin tool is registered.",
      })),
    ].filter((tool) => !(normalized.productMode || normalized.modelCallableOnly) || tool.modelCallable !== false);

    if (normalized.includeAllAgents || !this.agentRegistry) {
      return tools;
    }

    return this.agentRegistry.filterTools(tools, this.getAgentId(normalized));
  }

  getToolDefinition(id) {
    if (this.tools[id]) {
      return {
        id,
        description: this.tools[id].description,
        permission: this.tools[id].permission,
      };
    }

    return this.pluginRegistry.getToolDefinitions().find((tool) => tool.id === id) || null;
  }

  has(id, context = {}) {
    return this.getAll(context).some((tool) => tool.id === id);
  }

  async run(id, input = {}, context = {}) {
    const normalized = normalizeContext(context);
    const agentId = this.getAgentId(normalized);
    const definition = this.getToolDefinition(id);

    if (!definition) {
      throw new Error(`Unknown tool: ${id}`);
    }

    if (this.agentRegistry && !this.agentRegistry.isToolAllowed(agentId, definition)) {
      return {
        blocked: true,
        reason: `Tool ${id} is blocked for agent ${agentId}.`,
        agentId,
      };
    }

    if (!this.tools[id]) {
      const result = await this.pluginRegistry.runTool(id, input);
      return {
        agentId,
        ...result,
      };
    }

    const permission = this.tools[id].permission;
    if (permission) {
      const config = this.configStore.getConfig();
      const allowed = Boolean(config.tools.permissions[permission]);
      if (!allowed) {
        return {
          blocked: true,
          reason: `Permission ${permission} is disabled.`,
          agentId,
        };
      }
    }

    const result = await this.tools[id].run(input, normalized);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return result;
    }

    return {
      agentId,
      ...result,
    };
  }

  inferCommand(request) {
    const text = String(request || "").trim();
    const match = text.match(/["']([^"']+)["']/);
    if (match) {
      return match[1];
    }

    return text;
  }

  mediaNotConfigured(tool, prompt = "") {
    return {
      ok: false,
      configured: false,
      tool,
      promptPreview: String(prompt || "").slice(0, 180),
      message: `${tool} is registered for OpenClaw compatibility, but no media provider plugin is configured yet.`,
      nextUpgrade: "Add provider-backed image/music/video/TTS plugins and route these tools to them.",
    };
  }

  hermesToolNotReady(tool, message = "") {
    const item = HERMES_COMPAT_TOOLS.find((entry) => entry.id === tool) || {};
    return {
      ok: false,
      ready: false,
      tool,
      toolset: item.toolset || "",
      status: item.status || "placeholder",
      omniclawTool: item.omniclawTool || "",
      message: message || "This Hermes-compatible tool is cataloged, but its backend is not wired into OmniClaw yet.",
      source: "vendor/hermes-agent",
    };
  }

  getHermesToolCatalog({ status = "", toolset = "" } = {}) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    const normalizedToolset = String(toolset || "").trim().toLowerCase();
    const visibleTools = new Set(this.getAll({ agentId: "main" }).map((tool) => tool.id));
    const tools = HERMES_COMPAT_TOOLS
      .filter((tool) => !normalizedStatus || tool.status === normalizedStatus)
      .filter((tool) => !normalizedToolset || tool.toolset === normalizedToolset)
      .map((tool) => ({
        ...tool,
        exposed: visibleTools.has(tool.id),
      }));
    const counts = tools.reduce((acc, tool) => {
      acc[tool.status] = (acc[tool.status] || 0) + 1;
      return acc;
    }, {});
    return {
      source: "vendor/hermes-agent/toolsets.py",
      total: tools.length,
      counts,
      toolsets: [...new Set(HERMES_COMPAT_TOOLS.map((tool) => tool.toolset))].sort(),
      tools,
      composableToolsets: [
        { id: "web", tools: ["web_search", "web_extract"] },
        { id: "terminal", tools: ["terminal", "process"] },
        { id: "file", tools: ["read_file", "write_file", "patch", "search_files"] },
        { id: "browser", tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll"] },
        { id: "memory", tools: ["memory", "session_search"] },
        { id: "skills", tools: ["skills_list", "skill_view", "skill_manage"] },
      ],
      rule: "OmniClaw keeps its working tools and exposes Hermes-compatible aliases/adapters. Python-only Hermes backends stay placeholders until safely ported.",
    };
  }

  async getRealTaskHealth({ live = true, context = {} } = {}) {
    const agentId = this.getAgentId(context);
    const config = this.configStore.getConfig();
    const tools = this.getAll({ agentId });
    const productReadyTools = tools.filter((tool) => tool.productReady !== false);
    const limitedTools = tools.filter((tool) => tool.productReady === false);
    const toolIds = new Set(tools.map((tool) => tool.id));
    const skills = this.agentRegistry
      ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
      : [];
    const provider = this.agentRuntime?.getProviderInfo?.() || {};
    const permissions = config.tools?.permissions || {};
    const hermesCatalog = this.getHermesToolCatalog({});
    const requiredTools = {
      files: ["list_files", "read_file", "write_file", "apply_patch"],
      computer: ["list_computer_directory", "search_computer_files", "read_computer_file", "write_computer_file", "delete_computer_path"],
      terminal: ["run_terminal_command", "exec", "process", "code_execution"],
      browser: ["browser_navigate", "browser_snapshot", "browser_text", "browser_screenshot"],
      web: ["web_research", "web_search", "read_url", "web_fetch"],
      memory: ["remember_note", "memory_search", "list_long_term_memory", "promote_memory"],
      skills: ["capability_demo", "create_skill", "hermes_skill_scan", "skill_system_status"],
      sessions: ["sessions_list", "sessions_history", "sessions_send", "delegate_task"],
      automation: ["cron", "list_tasks", "create_task", "run_task"],
      provider: ["provider_status", "list_provider_models", "test_provider_profile", "apply_provider_profile"],
    };
    const groups = Object.entries(requiredTools).map(([group, ids]) => {
      const present = ids.filter((id) => toolIds.has(id));
      return {
        group,
        status: present.length === ids.length ? "ready" : present.length > 0 ? "partial" : "missing",
        present,
        missing: ids.filter((id) => !toolIds.has(id)),
      };
    });

    const probes = [];
    const addProbe = (name, status, detail = "", extra = {}) => {
      probes.push({ name, status, detail, ...extra });
    };

    try {
      const entries = this.fileStore.listDirectory(".");
      addProbe("workspace_files", "ready", `${entries.length} workspace item(s) visible.`);
    } catch (error) {
      addProbe("workspace_files", "failed", error.message);
    }

    try {
      const home = this.fileStore.listComputerDirectory("~", this.requireComputerAccessPolicy());
      addProbe("computer_home", "ready", `${home.entries.length} home folder item(s) visible.`, {
        path: home.path,
        sample: home.entries.slice(0, 6).map((entry) => entry.name),
      });
    } catch (error) {
      addProbe("computer_home", "failed", error.message);
    }

    try {
      const system = await this.systemMonitor.getComputerStatus();
      addProbe("system_status", "ready", `RAM ${system.memory?.freeGb || "?"}/${system.memory?.totalGb || "?"} GB free/total.`);
    } catch (error) {
      addProbe("system_status", "failed", error.message);
    }

    if (live && this.agentRuntime?.executeTerminalCommand && permissions.allowShellExecution) {
      try {
        const execution = await this.agentRuntime.executeTerminalCommand({
          command: "Get-Date",
          context: {
            ...context,
            agentId,
            source: "real-task-health",
          },
        });
        addProbe(
          "terminal_execution",
          execution.status === "completed" ? "ready" : execution.status || "failed",
          execution.status === "completed"
            ? String(execution.stdout || "").trim().slice(0, 160)
            : String(execution.stderr || execution.reason || "").slice(0, 220),
        );
      } catch (error) {
        addProbe("terminal_execution", "failed", error.message);
      }
    } else {
      addProbe("terminal_execution", permissions.allowShellExecution ? "skipped" : "disabled", "Live terminal probe skipped.");
    }

    try {
      const browser = this.browserOperator.getStatus?.() || {};
      addProbe(browser.available === false ? "browser_control" : "browser_control", browser.available === false ? "partial" : "ready", browser.message || "Browser operator registered.", {
        status: browser,
      });
    } catch (error) {
      addProbe("browser_control", "failed", error.message);
    }

    addProbe(
      "provider_brain",
      provider.ready === false ? "needs-setup" : "ready",
      provider.ready === false
        ? (provider.message || "Provider brain needs API/account setup.")
        : `${provider.id || "provider"} ${provider.model || ""}`.trim(),
    );

    const readyCount = groups.filter((group) => group.status === "ready").length;
    const partialCount = groups.filter((group) => group.status === "partial").length;
    const failedProbeCount = probes.filter((probe) => ["failed", "needs-setup"].includes(probe.status)).length;
    const placeholderCount = limitedTools.filter((tool) => tool.runtimeStatus === "placeholder").length;
    const partialToolCount = limitedTools.filter((tool) => tool.runtimeStatus === "partial").length;
    const callableRatio = productReadyTools.length / Math.max(1, tools.length);
    const score = Math.max(0, Math.min(100, Math.round(
      (readyCount / groups.length) * 55 +
      ((groups.length - partialCount) / groups.length) * 10 +
      ((probes.length - failedProbeCount) / Math.max(1, probes.length)) * 20 +
      callableRatio * 15 -
      Math.min(12, placeholderCount * 0.6) -
      Math.min(6, partialToolCount * 0.35),
    )));

    return {
      agentId,
      productMode: true,
      score,
      provider: {
        id: provider.id || "unknown",
        mode: provider.mode || "",
        model: provider.model || "",
        ready: provider.ready !== false,
        apiKeySource: provider.apiKeySource || "",
      },
      tools: {
        total: tools.length,
        productReady: productReadyTools.length,
        limited: limitedTools.length,
        placeholders: placeholderCount,
        partial: partialToolCount,
        groups,
        hermesCompatibility: hermesCatalog.counts || {},
        hiddenFromPlanner: limitedTools.slice(0, 24).map((tool) => ({
          id: tool.id,
          status: tool.runtimeStatus,
          replacement: tool.replacement,
          reason: tool.readinessReason,
        })),
      },
      skills: {
        total: skills.length,
        loaded: skills.slice(0, 12).map((skill) => ({
          id: skill.id,
          name: skill.name,
          triggers: skill.triggers,
        })),
      },
      probes,
      recipes: [
        { ask: "mara laptop par opencode file search karo", expectedTools: ["search_computer_files"] },
        { ask: "list computer folder ~", expectedTools: ["list_computer_directory"] },
        { ask: "read file docs/PRODUCT_VISION.md", expectedTools: ["read_file"] },
        { ask: "run terminal command \"Get-Date\"", expectedTools: ["run_terminal_command"] },
        { ask: "open browser https://github.com", expectedTools: ["browser_navigate"] },
        { ask: "fetch models nvidia", expectedTools: ["list_provider_models"] },
      ],
      nextHardening: [
        "Convert each placeholder Hermes tool into a working adapter or hide it from product UI until backend exists.",
        "Add smoke tests for every high-value natural-language recipe, not just backend tool IDs.",
        "Prefer grounded tool-output replies for filesystem, browser, terminal, and provider tasks.",
        "Make provider model fetch/save/test one atomic flow in UI and chat.",
      ],
      rule: "Product mode means no fake success: every real task must show executed tool evidence, failure reason, or next fix.",
    };
  }

  getContextCompressionStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const agent = this.agentRegistry?.resolveAgent?.(agentId) || null;
    const profile = agent ? this.configStore.getProfile(agent.profileId) : this.configStore.getActiveProfile();
    const maxChars = this.agentRuntime?.contextEngine?.getMaxChars?.(profile || {}) || 0;
    const sessionId = context.sessionId || "";
    const session = sessionId && this.agentRuntime?.sessions?.getSession
      ? this.agentRuntime.sessions.getSession(sessionId, { messageLimit: 120 })
      : null;
    const summary = sessionId && this.agentRuntime?.summarizer?.readSummary
      ? this.agentRuntime.summarizer.readSummary(sessionId)
      : null;
    const transcriptCount = session?.transcriptEntryCount || 0;
    const compressionThreshold = Math.floor(maxChars * 0.82);
    return {
      agentId,
      profile: profile?.id || "balanced",
      maxChars,
      compressionThreshold,
      activeSessionId: sessionId,
      transcriptEntryCount: transcriptCount,
      summaryPresent: Boolean(summary),
      summaryFrame: summary
        ? "CONTEXT COMPACTION - treat as background reference, NOT active instructions. Respond only to the latest message."
        : "",
      algorithm: [
        "Preserve head/bootstrap identity and latest tail messages.",
        "Prune old bulky tool outputs first.",
        "Summarize middle conversation when session grows.",
        "Keep prior summary across re-compressions.",
        "Track rough char budget as token-budget proxy.",
      ],
      currentSummary: summary,
      nextUpgrade: "Replace simple session compaction with head+tail preservation plus middle summary budgeted around 20% of compressed content.",
    };
  }

  getMemoryLifecycleStatus({ query = "", context = {} } = {}) {
    const agentId = this.getAgentId(context);
    const prefetch = this.memoryStore.prefetchAll({
      query,
      agentId,
      limit: 12,
    });
    const search = query ? prefetch.search : this.memoryStore.searchAll("", agentId);
    return {
      ...prefetch,
      sessionSearch: {
        ready: true,
        mode: "JSON full-text scan now; SQLite FTS5 index is next upgrade.",
        query: query || "",
        resultCounts: search
          ? Object.fromEntries(Object.entries(search).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]))
          : {},
      },
      fencedBlockRule: "Memory is injected as context data, not as executable instructions.",
    };
  }

  getSkillSystemStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const omniSkills = this.agentRegistry
      ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
      : [];
    const hermes = this.scanHermesSkills({ limit: 16 });
    const standards = omniSkills.reduce((acc, skill) => {
      const key = skill.standard || "omniclaw-skill";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      agentId,
      omniSkillCount: omniSkills.length,
      hermesVendoredSkillCount: hermes.totalAvailable,
      standards,
      progressiveDisclosure: [
        "Tier 1: name + description + triggers are injected compactly.",
        "Tier 2: full instructions are loaded when the skill matches the user request.",
        "Tier 3: references/templates/assets should be loaded on demand by future skill importer.",
      ],
      selfImprovement: {
        current: "create_skill can write local .skill files; dream sweep promotes memory candidates.",
        gap: "skill_manage is still a placeholder for reviewable updates to SKILL.md after complex tasks.",
        nextUpgrade: "Add hermes_skill_import and skill_manage update flow with diff/review before writing.",
      },
      sampleHermesSkills: hermes.skills.slice(0, 8),
    };
  }

  getMessagingGatewayStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const adapters = this.connectorStore?.listAdapters?.() || [];
    const overview = this.connectorStore?.getAdaptersOverview?.() || {
      total: adapters.length,
      enabled: adapters.filter((adapter) => adapter.enabled).length,
      ready: adapters.filter((adapter) => ["ready", "configured"].includes(adapter.status)).length,
      needsSecret: adapters.filter((adapter) => adapter.status === "needs-secret").length,
    };
    const gateway = this.agentRuntime?.gateway;
    const sessions = this.agentRuntime?.sessions?.listSessions?.(20) || [];
    const deliveries = this.connectorStore?.listAdapterDeliveries?.({ limit: 12 }) || [];
    const webhookDeliveries = this.connectorStore?.listWebhookDeliveries?.(12) || [];
    const configuredPlatforms = adapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      transport: adapter.transport,
      direction: adapter.direction,
      enabled: adapter.enabled,
      status: adapter.status,
      defaultAgentId: adapter.defaultAgentId,
      secretConfigured: adapter.secretConfigured,
      capabilities: adapter.capabilities || [],
    }));
    return {
      agentId,
      mode: "single gateway process routes all configured platform adapters into agent sessions",
      overview,
      configuredPlatforms,
      supportedTargets: ["telegram", "discord", "http-webhook", "webchat"],
      plannedTargets: ["whatsapp", "slack", "signal", "email", "matrix", "mattermost", "dingtalk", "wecom", "feishu"],
      sessionRouting: {
        ready: true,
        rule: "platform/user/channel ids map into persistent OmniClaw sessions; webchat uses sessionId/sessionKey.",
        recentSessionCount: sessions.length,
        recentSessions: sessions.slice(0, 6).map((session) => ({
          id: session.id,
          key: session.key,
          agentId: session.agentId,
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
        })),
      },
      voiceTranscription: {
        status: "partial",
        current: "attachments are cached/extracted/analyzed through media-provider adapters when configured",
        gap: "automatic voice memo transcription and audio reply synthesis need speech/TTS provider plugins",
      },
      dmPairingSecurity: {
        trustStore: Boolean(this.agentRuntime?.trust),
        approvals: gateway?.listApprovals?.("")?.length || 0,
        rule: "gateway tokens, adapter secrets, device pairing, and shell approvals guard risky operations",
      },
      recentTraffic: {
        adapterDeliveries: deliveries.length,
        webhookDeliveries: webhookDeliveries.length,
        recentEvents: gateway?.listEvents?.(8) || [],
      },
      nextUpgrade: "Promote Telegram/Discord workers plus webhook into a unified gateway adapter dashboard, then add WhatsApp/Slack/Signal/Email account pairing.",
    };
  }

  async configureTelegramAdapter(input = {}) {
    const botToken = String(input.botToken || input.token || input.secret || "").trim();
    const defaultAgentId = String(input.defaultAgentId || "main").trim() || "main";
    const startWorker = input.startWorker !== false;

    if (!botToken) {
      const adapter = this.connectorStore?.getAdapter?.("telegram") || null;
      return {
        ok: false,
        needsToken: true,
        adapterId: "telegram",
        status: adapter?.status || "unknown",
        enabled: Boolean(adapter?.enabled),
        secretConfigured: Boolean(adapter?.secretConfigured),
        setup: [
          "Telegram me @BotFather open karo.",
          "/newbot se bot banao ya existing bot token copy karo.",
          "OmniClaw chat me token bhejo: telegram token <BOT_TOKEN>",
          "Main token save karke Telegram adapter enable/start kar dunga.",
        ],
      };
    }

    const configResult = this.connectorStore.setAdapterConfig({
      adapterId: "telegram",
      enabled: input.enabled !== false,
      defaultAgentId,
      mode: input.mode || "polling",
      secret: botToken,
    });
    const test = this.connectorStore.testAdapter("telegram");
    let worker = null;
    let workerError = "";
    if (startWorker && this.agentRuntime?.telegramWorker?.start) {
      try {
        worker = await this.agentRuntime.telegramWorker.start({ limit: 5 });
      } catch (error) {
        workerError = error.message;
      }
    }

    return {
      ok: true,
      adapterId: "telegram",
      secretUpdated: Boolean(configResult.secretUpdated),
      adapter: configResult.adapter,
      test,
      worker,
      workerError,
      next: [
        "Telegram me bot ko /start bhejo.",
        "Phir OmniClaw ko Telegram par message bhejkar poll/start test karo.",
      ],
    };
  }

  async getTerminalBackendsStatus(context = {}) {
    const config = this.configStore.getConfig();
    const shellPermissions = config.tools?.permissions || {};
    const shellPolicy = config.tools?.shell || {};
    const audit = this.agentRuntime?.shellAudit?.list?.({ limit: 12 }) || [];
    const processes = await (this.systemMonitor?.listProcesses?.("") || Promise.resolve({ processes: [], count: 0 }));
    const sandboxStatus = this.sandboxRunner?.getStatus?.() || {};
    return {
      agentId: this.getAgentId(context),
      defaultBackend: "local",
      backends: [
        { id: "local", status: shellPermissions.allowShellExecution ? "ready" : "permission-disabled", detail: "Direct governed subprocess execution on this Windows laptop." },
        { id: "docker", status: sandboxStatus.enabled ? "partial" : "missing", detail: "Sandbox runner exists, hard container isolation needs a stricter Docker backend." },
        { id: "ssh", status: "planned", detail: "Remote command backend not wired yet." },
        { id: "daytona", status: "planned", detail: "Serverless dev environment backend not wired yet." },
        { id: "modal", status: "planned", detail: "Serverless GPU/cloud backend not wired yet." },
        { id: "singularity", status: "planned", detail: "HPC container backend not wired yet." },
      ],
      persistentEnvironments: {
        status: "partial",
        current: "process registry and background jobs exist; per-backend long-lived environment reuse is next",
      },
      processRegistry: {
        ready: true,
        processSampleCount: Array.isArray(processes.processes) ? Math.min(processes.processes.length, 20) : 0,
        auditCount: audit.length,
        recentShellAudit: audit.slice(0, 5),
      },
      approvalGates: {
        enabled: Boolean(shellPolicy.requireApproval || shellPermissions.allowShellPlanning),
        shellExecutionAllowed: Boolean(shellPermissions.allowShellExecution),
        shellPlanningAllowed: Boolean(shellPermissions.allowShellPlanning),
        policy: shellPolicy,
      },
      nextUpgrade: "Add backend selection to terminal/process tools so local/docker/ssh/cloud execution can be chosen per tool call.",
    };
  }

  getModelProviderStatus(context = {}) {
    const config = this.configStore.getConfig();
    const provider = this.agentRuntime?.getProviderInfo?.() || {};
    const profiles = config.providerProfiles || {};
    const secretStatuses = this.agentRuntime?.secrets?.getAllStatuses?.() || [];
    const activeProfile = Object.entries(profiles).find(([, profile]) =>
      profile?.mode === config.provider?.mode &&
      profile?.baseUrl === config.provider?.baseUrl &&
      profile?.model === config.provider?.model
    );
    const baseUrl = String(config.provider?.baseUrl || "");
    const apiMode = provider.mode === "codex-cli"
      ? "codex_responses"
      : /anthropic|claude/i.test(baseUrl)
        ? "anthropic_messages"
        : "chat_completions";
    return {
      agentId: this.getAgentId(context),
      active: {
        provider: provider.id || "unknown",
        ready: Boolean(provider.ready),
        mode: provider.mode || config.provider?.mode || "",
        model: provider.model || config.provider?.model || "",
        baseUrl,
        apiMode,
        profileId: activeProfile?.[0] || "",
      },
      autoDetection: {
        ready: true,
        rule: "provider mode/baseUrl select chat_completions, anthropic_messages-style, or codex_responses command bridge",
        supportedModes: ["mock", "openai-compatible", "codex-cli"],
      },
      credentialPool: {
        status: "partial",
        configuredKeys: secretStatuses.filter((item) => item.configured).length,
        keys: secretStatuses,
        gap: "round-robin key rotation per provider is not implemented yet",
      },
      smartFailover: {
        status: "partial",
        current: "provider failures are classified and converted into fallback replies/status",
        gap: "automatic secondary model failover and jittered retry policy still need a provider router",
      },
      rateLimitTracker: {
        status: "planned",
        current: "provider test responses expose errors, but rate-limit headers are not persisted yet",
      },
      modelDiscovery: {
        ready: true,
        tool: "list_provider_models",
        rule: "OpenAI-compatible /models endpoint can be fetched after base URL and key are configured",
      },
      nextUpgrade: "Add provider router with key pool rotation, rate-limit header storage, and fallback model chain.",
    };
  }

  getSubagentDelegationStatus(context = {}) {
    const agents = this.agentRegistry?.getAll?.() || [];
    const delegations = this.agentRuntime?.gateway?.listDelegations?.({ limit: 20 }) || [];
    const visibleTools = new Set(this.getAll({ agentId: "main" }).map((tool) => tool.id));
    return {
      agentId: this.getAgentId(context),
      availableAgents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role || "",
        profileId: agent.profileId,
        toolCount: Array.isArray(agent.tools) ? agent.tools.length : 0,
      })),
      delegationToolReady: visibleTools.has("delegate_task"),
      isolationGuarantees: {
        childGetsParentHistory: false,
        resultMode: "summary result only",
        maxDepth: 1,
        defaultConcurrentChildren: 1,
        blockedChildTools: ["delegate_task", "clarify", "memory", "send_message", "execute_code"],
        gap: "current delegate_task queues a routed task; full isolated child execution loop is still partial",
      },
      sharedIterationBudget: {
        status: "planned",
        current: "parent run records delegation request; separate shared budget object is next",
      },
      executeCodeTool: {
        ready: visibleTools.has("execute_code") || visibleTools.has("code_execution"),
        note: "execute_code exists for compact local scripts, governed by shell execution permissions",
      },
      recentDelegations: delegations.slice(0, 8),
      nextUpgrade: "Turn queued delegations into real child agent runs with isolated context, bounded toolsets, and collected summaries.",
    };
  }

  getMcpIntegrationStatus(context = {}) {
    const mcp = this.agentRuntime?.mcp;
    const status = mcp?.getStatus?.() || {};
    const tools = mcp?.getAllTools?.() || [];
    const configPath = mcp?.configPath || "config/mcp-servers.json";
    let configuredServers = [];
    try {
      const parsed = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      configuredServers = Object.entries(parsed.servers || {}).map(([id, server]) => ({
        id,
        transport: server.transport || "stdio",
        command: server.command || "",
        url: server.url || "",
      }));
    } catch {
      configuredServers = [];
    }
    return {
      agentId: this.getAgentId(context),
      configPath,
      configuredServers,
      connectedServers: Object.values(status).filter((item) => item.connected).length,
      status,
      liveToolCount: tools.length,
      liveTools: tools.slice(0, 20),
      resolutionFlow: [
        "MCP server configured in config/mcp-servers.json",
        "mcp.connectServer/connectAll starts the server",
        "tools/list populates first-class mcp_* tool ids",
        "model/tool loop can call mcp tool through registry",
      ],
      explicitAliases: {
        ready: configuredServers.length > 0,
        rule: "server id is embedded in generated mcp_<server>_<tool> id to avoid ambiguous tool names",
      },
      servesOmniClawToo: {
        status: "planned",
        gap: "OmniClaw can consume MCP servers; exposing OmniClaw itself as an MCP server is not wired yet",
      },
      acpAdapter: {
        status: "planned",
        gap: "Agent Communication Protocol adapter is not wired yet",
      },
      nextUpgrade: "Add dashboard connect/test buttons for MCP servers, then expose connected MCP tools in capability_demo.",
    };
  }

  async connectAllMcpServers() {
    const mcp = this.agentRuntime?.mcp;
    if (!mcp?.connectAll) {
      return {
        ok: false,
        message: "MCP registry is not available in this runtime.",
      };
    }
    const results = await mcp.connectAll();
    const status = this.getMcpIntegrationStatus({ agentId: "main" });
    this.agentRuntime?.gateway?.addEvent?.("mcp.connect_all", {
      configuredServers: status.configuredServers.length,
      connectedServers: status.connectedServers,
      liveToolCount: status.liveToolCount,
      results,
    });
    return {
      ok: true,
      results,
      ...status,
    };
  }

  getCronSchedulerStatus(context = {}) {
    const overview = this.agentRuntime?.scheduler?.getOverview?.() || {};
    const schedules = this.agentRuntime?.schedules?.listSchedules?.(20) || [];
    const jobs = this.agentRuntime?.jobs?.listJobs?.(20) || [];
    return {
      agentId: this.getAgentId(context),
      overview,
      schedules: schedules.slice(0, 10),
      recentJobs: jobs.slice(0, 10),
      howItWorks: [
        "create_schedule/cronjob creates a persisted schedule",
        "scheduler ticks independently of the chat request",
        "due schedule enqueues a fresh background tool job",
        "job output is recorded in jobs/gateway logs and can be delivered through messaging adapters",
      ],
      unattendedOperation: {
        status: "partial",
        current: "scheduler runs inside the local gateway process while OmniClaw is running",
        gap: "OS-level service/auto-start and cloud serverless backends are next",
      },
      deliveryPath: {
        ready: true,
        current: "background worker -> gateway event/job log; send_message can route adapter outbox when configured",
      },
      cliReference: ["cron", "cronjob", "create_schedule", "delete_schedule", "run_schedule_now"],
      nextUpgrade: "Add natural-language schedule parsing and per-platform delivery selection from chat.",
    };
  }

  getTrajectoryTrainingStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const gateway = this.agentRuntime?.gateway;
    const runs = gateway?.listRuns?.(50) || [];
    const events = gateway?.listEvents?.(200) || [];
    const shellAudit = this.agentRuntime?.shellAudit?.list?.({ limit: 50 }) || [];
    const jobs = this.agentRuntime?.jobs?.listJobs?.(50) || [];
    const toolEvents = events.filter((event) =>
      /tool|shell|browser|computer|provider|schedule|mcp|connector/i.test(`${event.event || ""}`)
    );
    const trajectorySample = runs.slice(0, 5).map((run) => ({
      id: run.id,
      status: run.status,
      agentId: run.agentId || agentId,
      sessionId: run.sessionId || "",
      providerStatus: run.providerStatus || "",
      toolOutputs: Array.isArray(run.toolOutputs) ? run.toolOutputs.length : 0,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));
    return {
      agentId,
      pipeline: {
        status: runs.length > 0 ? "partial" : "seeded",
        mode: "gateway run log + tool outputs + shell/browser/audit events",
        skipContextFiles: true,
        rule: "training exports must exclude SOUL.md/USER.md/PROFILE.md and ephemeral system prompt data",
      },
      components: [
        { id: "trajectory", status: "partial", current: "gateway runs store structured run/session/provider/tool metadata" },
        { id: "batch_runner", status: "planned", current: "no large-scale trajectory generation runner yet" },
        { id: "trajectory_compressor", status: "partial", current: "session summaries/context compression exist; training-specific compression is next" },
        { id: "mini_swe_runner", status: "planned", current: "software engineering benchmark runner not wired yet" },
        { id: "rl_training_tool", status: "planned", current: "approved action -> reward sample pipeline not wired yet" },
      ],
      counts: {
        runs: runs.length,
        toolEvents: toolEvents.length,
        shellAudit: shellAudit.length,
        jobs: jobs.length,
      },
      sample: trajectorySample,
      rlTraining: {
        status: "planned",
        gap: "No reward model/environment feedback loop yet; traces are useful for later supervised/RL data export.",
      },
      nextUpgrade: "Add trajectory_export_jsonl with redaction, skip_context_files=true, and one approved run as one training sample.",
    };
  }

  getClosedLearningLoopStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const memory = this.memoryStore.prefetchAll({ agentId, limit: 8 });
    const sessions = this.agentRuntime?.sessions?.listSessions?.(30) || [];
    const skills = this.agentRegistry
      ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
      : [];
    const shellAuditOverview = this.agentRuntime?.shellAudit?.getOverview?.() || {};
    return {
      agentId,
      loop: [
        { step: "user_interaction", status: "ready", evidence: `${sessions.length} recent session(s)` },
        { step: "agent_executes_task", status: "ready", evidence: `${shellAuditOverview.executed || 0} executed shell record(s), gateway/tool logs available` },
        { step: "memory_nudge", status: "partial", evidence: `${memory.overview?.longTerm || 0} long-term memories, ${memory.overview?.dreams || 0} dreams` },
        { step: "session_logged", status: "ready", evidence: "session transcripts and gateway runs persist locally" },
        { step: "skill_auto_created", status: "partial", evidence: `${skills.length} local skill(s); automatic post-task skill refinement still guarded/manual` },
        { step: "user_model_updated", status: "partial", evidence: "PROFILE.md and memory facts update; Honcho-style external user model is not wired" },
        { step: "next_interaction_smarter", status: "partial", evidence: "prefetch_all injects memory/session context; FTS5 + skill_manage are next" },
      ],
      memoryLifecycle: memory.lifecycle || [],
      closedLoopRule: "Every interaction should leave usable state: transcript, run trace, memory candidate, or skill candidate.",
      nextUpgrade: "Add post-run learner that proposes MEMORY.md and SKILL.md diffs for review instead of silently rewriting identity.",
    };
  }

  getHermesUseCasesStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const toolIds = new Set(this.getAll({ agentId }).map((tool) => tool.id));
    const has = (...ids) => ids.some((id) => toolIds.has(id));
    const cases = [
      {
        id: "software_engineering",
        label: "Software engineering",
        status: has("read", "write", "edit", "apply_patch", "run_terminal_command", "code_execution") ? "partial" : "missing",
        ready: ["read/patch codebases", "run governed commands/tests", "inspect files"],
        gaps: ["full CI/GitHub PR automation depends on configured GitHub tooling and provider brain"],
      },
      {
        id: "research_analysis",
        label: "Research and analysis",
        status: has("web_search", "web_fetch", "memory_search", "vision_analyze") ? "partial" : "missing",
        ready: ["web search/fetch", "session/memory recall", "attachment/media analysis when provider configured"],
        gaps: ["deep extraction pipeline and image-capable provider plugins need more adapters"],
      },
      {
        id: "personal_assistant",
        label: "Personal assistant",
        status: has("cron", "send_message", "messaging_gateway_status") ? "partial" : "missing",
        ready: ["webchat", "scheduler", "gateway logs", "adapter outbox"],
        gaps: ["Telegram/WhatsApp/voice memo production pairing and TTS replies"],
      },
      {
        id: "devops_automation",
        label: "DevOps and automation",
        status: has("run_terminal_command", "cron", "computer_access_status") ? "partial" : "missing",
        ready: ["local terminal", "scheduled jobs", "file operations", "audits"],
        gaps: ["SSH/Docker/cloud terminal backends and Home Assistant connector"],
      },
      {
        id: "ml_research",
        label: "ML research",
        status: has("trajectory_training_status", "model_provider_status") ? "seeded" : "missing",
        ready: ["trajectory diagnostics", "provider/model diagnostics"],
        gaps: ["GPU backends, RL environments, benchmark runner, batch trajectory generation"],
      },
      {
        id: "team_workflows",
        label: "Team workflows",
        status: has("subagent_delegation_status", "mcp_integration_status") ? "partial" : "missing",
        ready: ["subagent routing status", "MCP consumer registry", "Discord adapter skeleton"],
        gaps: ["Slack/Discord production bot workflows, shared skills hub, company MCP dashboards"],
      },
    ];
    return {
      agentId,
      cases,
      summary: cases.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
      rule: "Use-case claims must map to real tools; partial means useful pieces exist but production-grade flow is incomplete.",
      nextUpgrade: "Pick one use case and drive it from partial to ready with a real end-to-end smoke test.",
    };
  }

  getDesignPrinciplesStatus(context = {}) {
    const config = this.configStore.getConfig();
    const provider = this.agentRuntime?.getProviderInfo?.() || {};
    const workspaceContext = this.agentRuntime?.loadWorkspaceContext?.(this.getAgentId(context)) || { files: [] };
    const shellAudit = this.agentRuntime?.shellAudit?.getOverview?.() || {};
    return {
      agentId: this.getAgentId(context),
      principles: [
        {
          id: "openai_compatible_everywhere",
          status: provider.mode === "openai-compatible" || provider.mode === "account-bridge" ? "partial" : "seeded",
          evidence: `provider=${provider.id || "unknown"}, mode=${provider.mode || config.provider?.mode || "unknown"}`,
          gap: "Provider-native schemas and all 200+ provider quirks are not fully normalized yet.",
        },
        {
          id: "stateless_prompt_assembly",
          status: "partial",
          evidence: `${workspaceContext.files?.length || 0} context file(s), prompt assembly status tool, injection scans`,
          gap: "Some runtime assembly still lives in Agent methods; extract smaller pure prompt-builder modules next.",
        },
        {
          id: "one_external_memory_plugin",
          status: "ready",
          evidence: "built-in memory store is primary; no conflicting external memory provider enabled",
          gap: "Optional Honcho-style external provider interface is not wired.",
        },
        {
          id: "trajectories_skip_ephemeral_data",
          status: "partial",
          evidence: "trajectory_training_status marks skipContextFiles=true and excludes identity files by policy",
          gap: "JSONL exporter/redactor still needs implementation.",
        },
        {
          id: "idempotent_tool_calls",
          status: "partial",
          evidence: `${shellAudit.total || 0} shell audit record(s), gateway event/run ids, durable job records`,
          gap: "Large tool outputs are not yet always persisted by content hash and replayed by id.",
        },
        {
          id: "platform_aware_formatting",
          status: "partial",
          evidence: "gateway adapters have platform metadata and prompt assembly includes platform hints",
          gap: "Per-platform formatter for Telegram/Discord/CLI output needs final routing.",
        },
      ],
      rule: "Design principles are guardrails for implementation, not marketing claims.",
      nextUpgrade: "Add trajectory exporter + idempotent artifact store, then wire platform-aware response formatting per adapter.",
    };
  }

  scanPromptContextText(value = "") {
    const text = String(value || "");
    const findings = [];
    const checks = [
      { id: "ignore-previous-instructions", pattern: /ignore (all )?(previous|prior|above) (instructions|rules|messages)/i },
      { id: "disregard-previous-instructions", pattern: /disregard (all )?(previous|prior|above) (instructions|rules|messages)/i },
      { id: "system-prompt-exfiltration", pattern: /reveal (your )?(instructions|prompt|system)|system prompt/i },
      { id: "role-rewrite", pattern: /you are now|act as|do not obey/i },
      { id: "hidden-html", pattern: /<script[\s>]|<iframe[\s>]|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/i },
      { id: "invisible-unicode", pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u },
    ];
    for (const check of checks) {
      if (check.pattern.test(text)) {
        findings.push(check.id);
      }
    }
    return findings;
  }

  getPromptAssemblyStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const agent = this.agentRegistry?.resolveAgent?.(agentId) || null;
    const profile = agent ? this.configStore.getProfile(agent.profileId) : this.configStore.getActiveProfile();
    const workspaceContext = this.agentRuntime?.loadWorkspaceContext?.(agentId) || { files: [] };
    const files = Array.isArray(workspaceContext.files) ? workspaceContext.files : [];
    const scanned = files.map((file) => ({
      name: file.name || "",
      scope: file.scope || "",
      path: file.path || "",
      chars: String(file.content || "").length,
      findings: this.scanPromptContextText(file.content || ""),
    }));
    const suspicious = scanned.filter((file) => file.findings.length > 0);
    return {
      agentId,
      profile: profile?.id || "balanced",
      maxContextChars: this.agentRuntime?.contextEngine?.getMaxChars?.(profile || {}) || 0,
      assembly: [
        "DEFAULT_AGENT_IDENTITY / runtime identity",
        "SOUL.md / USER.md / PROFILE.md",
        "Project context discovery: .hermes.md, HERMES.md, AGENTS.md, .cursorrules",
        "Skills index and tool schema",
        "Memory context and session summary",
        "Platform hints and heartbeat behavior",
      ],
      defenses: {
        promptInjectionScan: true,
        invisibleUnicodeScan: true,
        hiddenHtmlScan: true,
        untrustedContextTags: true,
      },
      files: scanned,
      suspiciousCount: suspicious.length,
      suspicious: suspicious.slice(0, 12),
      rule: "Workspace/project context is injected as untrusted data. Suspicious phrases are blocked in the final system prompt instead of treated as instructions.",
    };
  }

  getRootDir() {
    return this.agentRuntime?.rootDir || this.fileStore?.rootDir || process.cwd();
  }

  getOpenClawRoot() {
    return path.join(this.getRootDir(), "vendor", "openclaw");
  }

  getHermesRoot() {
    return path.join(this.getRootDir(), "vendor", "hermes-agent");
  }

  getOpenClawVendorStatus() {
    const root = this.getOpenClawRoot();
    const packagePath = path.join(root, "package.json");
    const licensePath = path.join(root, "LICENSE");
    const gitPath = path.join(root, ".git");
    const packageJson = fs.existsSync(packagePath)
      ? JSON.parse(fs.readFileSync(packagePath, "utf8"))
      : {};
    return {
      available: fs.existsSync(root),
      path: root,
      gitLinked: fs.existsSync(gitPath),
      packageName: packageJson.name || "",
      version: packageJson.version || "",
      license: packageJson.license || (fs.existsSync(licensePath) ? "present" : ""),
      docsPresent: fs.existsSync(path.join(root, "docs")),
      skillsPresent: fs.existsSync(path.join(root, "skills")),
      extensionsPresent: fs.existsSync(path.join(root, "extensions")),
      recommendedMode: "reference-submodule",
      nextActions: [
        "Use openclaw_skill_scan to find donor skills.",
        "Use openclaw_skill_import for selected skills only.",
        "Use docs/OPENCLAW_TO_OMNICLAW_TRANSPLANT_MAP.md for layer-by-layer runtime work.",
      ],
    };
  }

  countFilesUnder(dir, { extensions = null, max = 50000 } = {}) {
    if (!fs.existsSync(dir)) {
      return 0;
    }
    let count = 0;
    const stack = [dir];
    const allowed = Array.isArray(extensions) ? new Set(extensions.map((item) => item.toLowerCase())) : null;
    while (stack.length > 0 && count < max) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (["node_modules", ".git", "dist", "target", ".next"].includes(entry.name)) {
          continue;
        }
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolutePath);
        } else if (!allowed || allowed.has(path.extname(entry.name).toLowerCase())) {
          count += 1;
          if (count >= max) break;
        }
      }
    }
    return count;
  }

  listOpenClawExtensionCatalog(limit = 140) {
    const extensionsDir = path.join(this.getOpenClawRoot(), "extensions");
    if (!fs.existsSync(extensionsDir)) {
      return [];
    }
    return fs.readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const extensionDir = path.join(extensionsDir, entry.name);
        const manifestPath = path.join(extensionDir, "openclaw.plugin.json");
        const packagePath = path.join(extensionDir, "package.json");
        const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
        const packageJson = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, "utf8")) : {};
        const name = entry.name;
        const category = this.classifyOpenClawExtension(name, manifest, packageJson);
        return {
          id: name,
          category,
          title: manifest.displayName || manifest.name || packageJson.name || name,
          description: manifest.description || packageJson.description || "",
          hasManifest: fs.existsSync(manifestPath),
          hasPackage: fs.existsSync(packagePath),
          tsFiles: this.countFilesUnder(extensionDir, { extensions: [".ts", ".tsx"], max: 2000 }),
          skillFiles: this.walkOpenClawSkillFiles(extensionDir, []).length,
        };
      })
      .sort((left, right) => left.category.localeCompare(right.category) || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(Number(limit) || 140, 300)));
  }

  classifyOpenClawExtension(name, manifest = {}, packageJson = {}) {
    const text = [name, manifest.name, manifest.description, packageJson.description].join(" ").toLowerCase();
    if (/telegram|whatsapp|discord|slack|signal|imessage|bluebubbles|matrix|mattermost|feishu|line|messenger|teams|googlechat|irc|nostr|qqbot|twitch|nextcloud|synology/.test(text)) {
      return "channel";
    }
    if (/openai|anthropic|deepseek|groq|nvidia|minimax|moonshot|qwen|mistral|ollama|openrouter|together|fireworks|bedrock|azure|vertex|gemini|huggingface|cerebras|perplexity|litellm|vllm|lmstudio|venice|qianfan/.test(text)) {
      return "model-provider";
    }
    if (/brave|duckduckgo|exa|firecrawl|searxng|tavily|web|readability/.test(text)) {
      return "web-search";
    }
    if (/speech|tts|audio|voice|deepgram|elevenlabs|senseaudio|talk/.test(text)) {
      return "speech";
    }
    if (/image|video|music|fal|comfy|runway|media/.test(text)) {
      return "media";
    }
    if (/memory|lancedb|wiki|active-memory/.test(text)) {
      return "memory";
    }
    if (/browser|phone|device|pair|file-transfer|diffs|codex|opencode|mcp|acp|qa|diagnostics|webhooks/.test(text)) {
      return "tooling";
    }
    return "other";
  }

  getOpenClawCodeStudy({ includeExtensions = true, includeCore = true, limit = 140 } = {}) {
    const root = this.getOpenClawRoot();
    const studyGuidePath = path.join(os.homedir(), "Downloads", "OMNICLAW_STUDY_GUIDE.md");
    const coreDirs = includeCore && fs.existsSync(path.join(root, "src"))
      ? fs.readdirSync(path.join(root, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = path.join(root, "src", entry.name);
          return {
            name: entry.name,
            tsFiles: this.countFilesUnder(dir, { extensions: [".ts", ".tsx"], max: 5000 }),
            mappedToOmniClaw: this.mapOpenClawCoreDir(entry.name),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const extensions = includeExtensions ? this.listOpenClawExtensionCatalog(limit) : [];
    const categories = extensions.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    }, {});
    const keyFiles = [
      "openclaw.mjs",
      "src/entry.ts",
      "src/agents/index.ts",
      "src/gateway/index.ts",
      "src/channels/base.ts",
      "src/config/index.ts",
      "src/plugin-sdk/index.ts",
    ].map((relative) => ({
      path: relative,
      exists: fs.existsSync(path.join(root, relative)),
    }));
    const implementationPlan = [
      {
        phase: 1,
        name: "Study and catalog",
        status: "implemented-now",
        action: "openclaw_code_study maps core dirs, extensions, key files, and safe import points.",
      },
      {
        phase: 2,
        name: "Safe skill transplant",
        status: "available",
        action: "openclaw_skill_scan/openclaw_skill_import imports SKILL.md guidance into OmniClaw agents.",
      },
      {
        phase: 3,
        name: "Provider/channel setup parity",
        status: "next",
        action: "Turn OpenClaw extension manifests into OmniClaw provider/channel setup cards and token flows.",
      },
      {
        phase: 4,
        name: "Runtime parity",
        status: "next",
        action: "Port selected working adapters one by one: Telegram, browser, web-search, memory, media.",
      },
      {
        phase: 5,
        name: "Hard sandbox/product installer",
        status: "next",
        action: "Installer, permissions, sandbox, and auto-update must be native OmniClaw code, not blind copied.",
      },
    ];
    return {
      source: "vendor/openclaw",
      available: fs.existsSync(root),
      root,
      studyGuide: {
        path: studyGuidePath,
        present: fs.existsSync(studyGuidePath),
        chars: fs.existsSync(studyGuidePath) ? fs.readFileSync(studyGuidePath, "utf8").length : 0,
      },
      stats: {
        coreDirCount: coreDirs.length,
        extensionCount: extensions.length,
        categoryCounts: categories,
        skillFiles: this.getOpenClawSkillFiles("all").length,
        tsFilesApprox: this.countFilesUnder(root, { extensions: [".ts", ".tsx"], max: 20000 }),
      },
      keyFiles,
      coreDirs,
      extensions: extensions.slice(0, 80),
      implementationPlan,
      rule: "OpenClaw code is a reference donor. OmniClaw should port compatible patterns/adapters with tests, not paste the full repo into runtime.",
    };
  }

  mapOpenClawCoreDir(name) {
    const map = {
      agents: "src/core/agent.js + tool loop + sub-agent spawner",
      gateway: "src/core/ws-gateway.js + connector-store + session routing",
      channels: "connectors/adapters + Telegram/Discord workers",
      tools: "src/core/tool-registry.js aliases and native tools",
      terminal: "run_terminal_command + sandbox-runner + process monitor",
      "web-search": "src/core/web-research.js providers/fallbacks",
      "web-fetch": "src/core/web-research.js fetchUrl/read_url",
      memory: "memory-store + long-term memory + dream sweep",
      "context-engine": "src/core/context-engine.js + summarizer",
      sessions: "session-store transcripts and session search",
      config: "config-store + provider profiles + BYOK UI",
      secrets: "secret-store provider/connector keys",
      security: "approval store + shell policy + computer access guard",
      plugins: "OpenClaw extension catalog -> OmniClaw plugin plan",
      "plugin-sdk": "future OmniClaw plugin SDK",
      cron: "job-store + background-worker",
      pairing: "trust-store pairing requests",
      media: "connector attachment cache + media analysis",
      tts: "text_to_speech placeholder -> provider plugin",
      "image-generation": "image_generate placeholder -> provider plugin",
      "video-generation": "video_analyze/video provider placeholders",
    };
    return map[name] || "not mapped yet";
  }

  getHermesVendorStatus() {
    const root = this.getHermesRoot();
    const packagePath = path.join(root, "pyproject.toml");
    const licensePath = path.join(root, "LICENSE");
    const readmePath = path.join(root, "README.md");
    const packageText = fs.existsSync(packagePath) ? fs.readFileSync(packagePath, "utf8") : "";
    const version = packageText.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1] || "";
    const name = packageText.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] || "hermes-agent";
    const skillFiles = this.getHermesSkillFiles().length;
    return {
      available: fs.existsSync(root),
      path: root,
      gitLinked: fs.existsSync(path.join(root, ".git")),
      packageName: name,
      version,
      license: fs.existsSync(licensePath) ? "MIT" : "",
      licensePath: fs.existsSync(licensePath) ? path.relative(this.getRootDir(), licensePath).replace(/\\/g, "/") : "",
      readmePresent: fs.existsSync(readmePath),
      skillsPresent: fs.existsSync(path.join(root, "skills")),
      gatewayPresent: fs.existsSync(path.join(root, "gateway")),
      cliPresent: fs.existsSync(path.join(root, "hermes_cli")),
      agentRuntimePresent: fs.existsSync(path.join(root, "agent")),
      skillFileCount: skillFiles,
      recommendedMode: "copied-reference-vendor",
      nextActions: [
        "Use hermes_skill_scan to find donor skills.",
        "Import only compatible skills/patterns; do not run Hermes Python code inside OmniClaw without an adapter.",
        "Use docs/HERMES_AGENT_REFERENCE.md for layer-by-layer runtime work.",
      ],
    };
  }

  walkOpenClawSkillFiles(dir, output = []) {
    if (!fs.existsSync(dir)) {
      return output;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist"].includes(entry.name)) {
          continue;
        }
        this.walkOpenClawSkillFiles(absolutePath, output);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        output.push(absolutePath);
      }
    }
    return output;
  }

  getOpenClawSkillFiles(source = "skills") {
    const root = this.getOpenClawRoot();
    const normalized = String(source || "skills").trim().toLowerCase();
    const roots = [];
    if (normalized === "skills" || normalized === "all") {
      roots.push(path.join(root, "skills"));
    }
    if (normalized === "extensions" || normalized === "all") {
      roots.push(path.join(root, "extensions"));
    }
    return roots.flatMap((item) => this.walkOpenClawSkillFiles(item));
  }

  getHermesSkillFiles() {
    const root = this.getHermesRoot();
    return this.walkOpenClawSkillFiles(path.join(root, "skills"));
  }

  scanHermesSkills({ query = "", limit = 40 } = {}) {
    const rootDir = this.getRootDir();
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    const skills = this.getHermesSkillFiles()
      .map((filePath) => parseOpenClawSkill(fs.readFileSync(filePath, "utf8"), filePath, rootDir))
      .filter((skill) => {
        if (!normalizedQuery) {
          return true;
        }
        return [skill.name, skill.description, skill.path].join(" ").toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, safeLimit)
      .map(({ absolutePath, instructions, ...skill }) => ({
        ...skill,
        source: "hermes-agent",
        instructionChars: instructions.length,
      }));
    return {
      source: "hermes-agent",
      query,
      count: skills.length,
      totalAvailable: this.getHermesSkillFiles().length,
      skills,
    };
  }

  scanOpenClawSkills({ query = "", source = "skills", limit = 40 } = {}) {
    const rootDir = this.getRootDir();
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    const skills = this.getOpenClawSkillFiles(source)
      .map((filePath) => parseOpenClawSkill(fs.readFileSync(filePath, "utf8"), filePath, rootDir))
      .filter((skill) => {
        if (!normalizedQuery) {
          return true;
        }
        return [skill.name, skill.description, skill.path].join(" ").toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, safeLimit)
      .map(({ absolutePath, instructions, ...skill }) => ({
        ...skill,
        instructionChars: instructions.length,
      }));
    return {
      source,
      query,
      count: skills.length,
      skills,
    };
  }

  importOpenClawSkillPack(input = {}, context = {}) {
    const packId = String(input.pack || "v2_core").trim();
    const pack = OPENCLAW_COMPAT_SKILL_PACKS[packId];
    if (!pack) {
      return {
        imported: false,
        reason: `Unknown OpenClaw skill pack: ${packId}`,
        availablePacks: Object.keys(OPENCLAW_COMPAT_SKILL_PACKS),
      };
    }

    const dryRun = Boolean(input.dryRun);
    const defaultAgentId = input.agentId || this.getAgentId(context);
    const items = pack.map((item) => ({
      ...item,
      agents: Array.isArray(input.agents) && input.agents.length > 0 ? input.agents : item.agents,
    }));

    if (dryRun) {
      return {
        imported: false,
        dryRun: true,
        pack: packId,
        count: items.length,
        skills: items.map(({ name, path: skillPath, importName, triggers, agents, reason }) => ({
          name,
          path: skillPath,
          importName,
          triggers,
          agents,
          reason,
        })),
      };
    }

    const results = [];
    for (const item of items) {
      try {
        results.push({
          ok: true,
          reason: item.reason,
          result: this.importOpenClawSkill({
            path: item.path,
            importName: item.importName,
            triggers: item.triggers,
            agents: item.agents,
            agentId: defaultAgentId,
            description: `${item.reason} Imported from OpenClaw ${item.path}.`,
          }, context),
        });
      } catch (error) {
        results.push({
          ok: false,
          name: item.name,
          path: item.path,
          reason: item.reason,
          error: error.message,
        });
      }
    }

    return {
      imported: results.filter((item) => item.ok && item.result?.imported).length,
      failed: results.filter((item) => !item.ok || item.result?.imported === false).length,
      pack: packId,
      results,
      nextActions: [
        "Ask 'tumhare paas kaun si skills hain demo do' to force capability_demo.",
        "Use imported skills only as operating guidance; tools still execute through OmniClaw runtime definitions.",
        "Keep transplanting OpenClaw features selectively from docs/OPENCLAW_TO_OMNICLAW_TRANSPLANT_MAP.md.",
      ],
    };
  }

  importOpenClawSkill(input = {}, context = {}) {
    const rootDir = this.getRootDir();
    const requestedPath = String(input.path || "").trim().replace(/\\/g, "/");
    const requestedName = String(input.name || "").trim().toLowerCase();
    const matches = this.getOpenClawSkillFiles(input.source || "all")
      .map((filePath) => parseOpenClawSkill(fs.readFileSync(filePath, "utf8"), filePath, rootDir))
      .filter((skill) => {
        if (requestedPath) {
          return skill.path === requestedPath || skill.path.endsWith(`/${requestedPath}`);
        }
        return requestedName && skill.name.toLowerCase() === requestedName;
      });

    if (matches.length === 0) {
      throw new Error("OpenClaw skill not found. Use openclaw_skill_scan first and pass the exact path.");
    }
    if (matches.length > 1) {
      return {
        imported: false,
        reason: "Multiple skills matched. Pass exact path.",
        matches: matches.map((skill) => ({ name: skill.name, path: skill.path, description: skill.description })),
      };
    }

    const skill = matches[0];
    const triggers = Array.isArray(input.triggers) && input.triggers.length > 0
      ? input.triggers
      : [skill.name, ...skill.name.split(/[-_\s]+/)].map((item) => item.trim()).filter(Boolean);
    const imported = this.customizationEngine.createSkill({
      name: input.importName || `OpenClaw ${skill.name}`,
      triggers: [...new Set(triggers.map((item) => item.toLowerCase()))],
      description: input.description || `Imported from OpenClaw ${skill.path}. ${skill.description}`.trim(),
      instructions: [
        "Compatibility note: this skill was imported from the vendored OpenClaw reference. Map OpenClaw tool names to OmniClaw runtime tools that are visible in the current prompt; do not claim missing plugins are installed.",
        "",
        `Imported from OpenClaw vendor path: ${skill.path}`,
        "",
        skill.instructions,
      ].join("\n"),
      agentId: input.agentId || this.getAgentId(context),
      agents: input.agents,
    });
    return {
      imported: true,
      source: {
        name: skill.name,
        path: skill.path,
        description: skill.description,
      },
      target: imported,
      id: slugify(input.importName || `OpenClaw ${skill.name}`),
    };
  }
}
