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
              "web_search",
              "web_fetch",
              "read",
              "write",
              "edit",
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
                "file read/write inside protected roots",
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
            },
          };
        },
      },
      list_computer_directory: {
        description: "List files from configured laptop access roots such as the user home folder.",
        permission: "allowComputerAccess",
        run: async ({ path }) => this.fileStore.listComputerDirectory(path || "~", this.requireComputerAccessPolicy()),
      },
      read_computer_file: {
        description: "Read a text file from configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ path }) => {
          const config = this.configStore.getConfig();
          return this.fileStore.readComputerText(
            path,
            config.tools?.computerAccess?.maxReadBytes || 131072,
            this.requireComputerAccessPolicy(),
          );
        },
      },
      write_computer_file: {
        description: "Write or append a text file inside configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ path, content, append }) =>
          this.fileStore.writeComputerText(path, String(content || ""), {
            append: Boolean(append),
            policy: this.requireComputerAccessPolicy(),
          }),
      },
      create_computer_directory: {
        description: "Create a directory inside configured laptop access roots.",
        permission: "allowComputerAccess",
        run: async ({ path }) => this.fileStore.createComputerDirectory(path, this.requireComputerAccessPolicy()),
      },
      delete_computer_path: {
        description: "Delete a file or folder inside configured laptop access roots. By default it moves the item to data/trash for restore.",
        permission: "allowComputerAccess",
        run: async ({ path, permanent }) =>
          this.fileStore.deleteComputerPath(path, {
            permanent: Boolean(permanent),
            policy: this.requireComputerAccessPolicy(),
          }),
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
        run: async ({ url }) => this.browserOperator.readUrl(String(url || "").trim()),
      },
      open_browser_url: {
        description: "Open a URL in the laptop's default browser.",
        permission: "allowBrowserControl",
        run: async ({ url }) => this.browserOperator.openUrl(String(url || "").trim()),
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
      exec: {
        description: "OpenClaw-compatible alias for governed terminal command execution.",
        permission: "allowShellExecution",
        group: "runtime",
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
      browser: {
        description: "OpenClaw-compatible browser helper for URL open/fetch and DevTools automation actions.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}) => {
          const { action, url } = input;
          const normalizedAction = String(action || "open").trim().toLowerCase();
          if (["status", "screenshot", "capture", "text", "links", "click", "type", "fill"].includes(normalizedAction)) {
            return this.browserOperator.automate(input);
          }
          if (["navigate", "goto"].includes(normalizedAction)) {
            return this.browserOperator.automate(input);
          }
          if (["fetch", "read", "read_url"].includes(normalizedAction)) {
            return this.browserOperator.readUrl(String(url || "").trim());
          }
          if (["open"].includes(normalizedAction)) {
            return this.browserOperator.openUrl(String(url || "").trim());
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
      browser_screenshot: {
        description: "Capture a screenshot from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}) => this.browserOperator.automate({ ...input, action: "screenshot" }),
      },
      browser_text: {
        description: "Extract visible text from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}) => this.browserOperator.automate({ ...input, action: "text" }),
      },
      web_search: {
        description: "OpenClaw-compatible web search alias.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ query }) => this.webResearch.search(String(query || "").trim()),
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
        run: async ({ url }) => this.browserOperator.readUrl(String(url || "").trim()),
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

  getRootDir() {
    return this.agentRuntime?.rootDir || this.fileStore?.rootDir || process.cwd();
  }

  getOpenClawRoot() {
    return path.join(this.getRootDir(), "vendor", "openclaw");
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
