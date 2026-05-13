import fs from "node:fs";
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
          const skills = this.agentRegistry
            ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
            : [];
          const toolIds = tools.map((tool) => tool.id);
          return {
            agentId,
            toolCount: tools.length,
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
            ].includes(id)),
            skills: skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              triggers: skill.triggers,
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

  getAll(context = {}) {
    const normalized = normalizeContext(context);
    const tools = [
      ...Object.entries(this.tools).map(([id, tool]) => ({
        id,
        description: tool.description,
        permission: tool.permission,
      })),
      ...this.pluginRegistry.getToolDefinitions(),
    ];

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
      rule: "OmniClaw keeps its working tools and exposes Hermes-compatible aliases/adapters. Python-only Hermes backends stay placeholders until safely ported.",
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
