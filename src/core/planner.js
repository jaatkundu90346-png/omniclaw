export class Planner {
  getNpmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
  }

  normalizeToolInput(step = {}) {
    const raw = step.input ?? step.arguments ?? {};
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

  normalizeModelStep(step = {}) {
    const type = String(step.type || step.kind || "").trim();
    const tool = String(step.tool || step.name || step.function || "").trim();

    if (type === "tool_call" || type === "function" || (tool && type !== "respond")) {
      return {
        type: "tool",
        tool,
        input: this.normalizeToolInput(step),
        reason: step.reason || "Model requested this runtime tool.",
      };
    }

    return {
      ...step,
      type: type || "respond",
    };
  }

  mergeModelPlanWithHeuristic(modelPlan, heuristic) {
    const heuristicToolSteps = (heuristic.steps || []).filter((step) => step.type === "tool");
    const modelSteps = (modelPlan.steps || []).map((step) => this.normalizeModelStep(step));
    const merged = [];
    const seen = new Set();

    for (const step of heuristicToolSteps) {
      const key = `${step.tool}:${JSON.stringify(step.input || {})}`;
      merged.push(step);
      seen.add(key);
    }

    for (const step of modelSteps) {
      if (step.type === "tool") {
        const key = `${step.tool}:${JSON.stringify(step.input || {})}`;
        if (!seen.has(key)) {
          merged.push(step);
          seen.add(key);
        }
        continue;
      }

      if (step.type === "respond" || step.type === "analysis" || step.type === "skill-context") {
        merged.push(step);
      }
    }

    if (merged.length === 0) {
      return heuristic.steps || [{ type: "respond", reason: "No tool call needed, answer directly." }];
    }

    return merged;
  }

  buildPlan({ message, intents, skills, tools, profile }) {
    const steps = [];

    if (intents.includes("hermes-reference")) {
      steps.push({
        type: "tool",
        tool: "hermes_reference_status",
        input: {},
        reason: "User referenced Hermes Agent as an OpenClaw alternative and wants OmniClaw to learn from it.",
      });
    }

    if (intents.includes("hermes-tools")) {
      steps.push({
        type: "tool",
        tool: "hermes_tool_catalog",
        input: {},
        reason: "User asked to copy/compare Hermes tools and wants tool coverage status.",
      });
      steps.push({
        type: "tool",
        tool: "hermes_skill_scan",
        input: { limit: 12 },
        reason: "User asked to add Hermes skills; scan the vendored skill catalog first.",
      });
    }

    if (intents.includes("openclaw-code-study")) {
      steps.push({
        type: "tool",
        tool: "openclaw_code_study",
        input: { includeExtensions: true, includeCore: true },
        reason: "User provided an OpenClaw study guide and wants OmniClaw to study the vendored OpenClaw codebase before implementing features.",
      });
      steps.push({
        type: "tool",
        tool: "openclaw_skill_scan",
        input: { source: "all", limit: 16 },
        reason: "OpenClaw skills are the safest first implementation layer to import into OmniClaw.",
      });
    }

    if (intents.includes("real-task-hardening")) {
      steps.push({
        type: "tool",
        tool: "real_task_health",
        input: { live: true },
        reason: "User wants OmniClaw to behave like a product-grade real-task agent, not a demo chatbot.",
      });
      steps.push({
        type: "tool",
        tool: "capability_demo",
        input: {},
        reason: "Show the real tool and skill surface after the live health probe.",
      });
    }

    if (intents.includes("context-compression")) {
      steps.push({
        type: "tool",
        tool: "context_compression_status",
        input: {},
        reason: "User shared Hermes context compression architecture and wants OmniClaw improved.",
      });
    }

    if (intents.includes("memory-lifecycle")) {
      steps.push({
        type: "tool",
        tool: "memory_lifecycle_status",
        input: {},
        reason: "User shared Hermes memory lifecycle/session search architecture.",
      });
    }

    if (intents.includes("skill-system")) {
      steps.push({
        type: "tool",
        tool: "skill_system_status",
        input: {},
        reason: "User shared Hermes skills system architecture.",
      });
    }

    if (intents.includes("messaging-gateway")) {
      const telegramSetup = this.extractTelegramSetup(message);
      if (telegramSetup.shouldConfigure) {
        steps.push({
          type: "tool",
          tool: "configure_telegram",
          input: telegramSetup,
          reason: telegramSetup.botToken
            ? "The user provided or requested Telegram setup; configure the Telegram adapter."
            : "The user asked to connect Telegram; explain the token requirement and current status.",
        });
      }
      steps.push({
        type: "tool",
        tool: "messaging_gateway_status",
        input: {},
        reason: "User shared Hermes messaging gateway architecture.",
      });
    }

    if (intents.includes("terminal-backends")) {
      steps.push({
        type: "tool",
        tool: "terminal_backends_status",
        input: {},
        reason: "User shared Hermes terminal backend architecture.",
      });
    }

    if (intents.includes("model-provider")) {
      steps.push({
        type: "tool",
        tool: "model_provider_status",
        input: {},
        reason: "User shared Hermes multi-provider model support architecture.",
      });
    }

    if (intents.includes("subagent-delegation")) {
      steps.push({
        type: "tool",
        tool: "subagent_delegation_status",
        input: {},
        reason: "User shared Hermes subagent delegation architecture.",
      });
    }

    if (intents.includes("mcp-integration")) {
      steps.push({
        type: "tool",
        tool: "mcp_integration_status",
        input: {},
        reason: "User shared Hermes MCP integration architecture.",
      });
    }

    if (intents.includes("trajectory-training")) {
      steps.push({
        type: "tool",
        tool: "trajectory_training_status",
        input: {},
        reason: "User shared Hermes trajectory generation and RL training architecture.",
      });
    }

    if (intents.includes("closed-learning-loop")) {
      steps.push({
        type: "tool",
        tool: "closed_learning_loop_status",
        input: {},
        reason: "User shared Hermes closed learning loop architecture.",
      });
    }

    if (intents.includes("hermes-use-cases")) {
      steps.push({
        type: "tool",
        tool: "hermes_use_cases_status",
        input: {},
        reason: "User shared Hermes use-case capability matrix.",
      });
    }

    if (intents.includes("design-principles")) {
      steps.push({
        type: "tool",
        tool: "design_principles_status",
        input: {},
        reason: "User shared Hermes design principles and wants OmniClaw aligned.",
      });
    }

    if (intents.includes("cron-scheduler")) {
      steps.push({
        type: "tool",
        tool: "cron_scheduler_status",
        input: {},
        reason: "User shared Hermes cron scheduler architecture.",
      });
    }

    if (intents.includes("hermes-doctor")) {
      steps.push({
        type: "tool",
        tool: "provider_status",
        input: { verify: false },
        reason: "Hermes-style /doctor should inspect brain readiness without hanging on a live auth call.",
      });
      steps.push({
        type: "tool",
        tool: "computer_access_status",
        input: {},
        reason: "Hermes-style /doctor should show local hands/eyes access.",
      });
      steps.push({
        type: "tool",
        tool: "session_status",
        input: {},
        reason: "Hermes-style /doctor should show session and gateway health.",
      });
      steps.push({
        type: "tool",
        tool: "v2_status",
        input: {},
        reason: "Hermes-style /doctor should expose V2 feature health.",
      });
    }

    if (intents.includes("hermes-model")) {
      steps.push({
        type: "tool",
        tool: "provider_status",
        input: { verify: false },
        reason: "Hermes-style /model should show the selected model/provider.",
      });
      steps.push({
        type: "tool",
        tool: "list_provider_models",
        input: {},
        reason: "Hermes-style /model should fetch available provider models when configured.",
      });
    }

    if (intents.includes("hermes-skills")) {
      steps.push({
        type: "tool",
        tool: "capability_demo",
        input: {},
        reason: "Hermes-style /skills should show real tools and loaded skills.",
      });
      steps.push({
        type: "tool",
        tool: "agents_list",
        input: {},
        reason: "Hermes-style /skills should show configured agents.",
      });
    }

    if (intents.includes("hermes-usage")) {
      steps.push({
        type: "tool",
        tool: "runtime_summary",
        input: {},
        reason: "Hermes-style /usage should summarize active runtime profile.",
      });
      steps.push({
        type: "tool",
        tool: "session_status",
        input: {},
        reason: "Hermes-style /usage should show current session context.",
      });
      steps.push({
        type: "tool",
        tool: "list_long_term_memory",
        input: {},
        reason: "Hermes-style /usage should show memory state.",
      });
    }

    if (intents.includes("hermes-platforms")) {
      steps.push({
        type: "tool",
        tool: "computer_access_status",
        input: {},
        reason: "Hermes-style /platforms should show laptop, terminal, and browser access.",
      });
      steps.push({
        type: "tool",
        tool: "nodes",
        input: {},
        reason: "Hermes-style /platforms should show paired nodes.",
      });
      steps.push({
        type: "tool",
        tool: "cron",
        input: { limit: 20 },
        reason: "Hermes-style /platforms should show background jobs.",
      });
      steps.push({
        type: "tool",
        tool: "gateway",
        input: { limit: 8 },
        reason: "Hermes-style /platforms should show gateway events and approvals.",
      });
    }

    const providerSetupRequest = intents.includes("api-setup") ? this.extractProviderSetupRequest(message) : null;
    if (providerSetupRequest?.shouldConfigure) {
      steps.push({
        type: "tool",
        tool: "configure_provider_brain",
        input: providerSetupRequest.input,
        reason: "User supplied provider brain setup details; save key/model/base URL and test readiness in one atomic flow.",
      });
    }

    if (intents.includes("greeting") || (intents.includes("api-setup") && !providerSetupRequest?.shouldConfigure) || intents.includes("capabilities")) {
      steps.push({
        type: "respond",
        reason: intents.includes("api-setup")
          ? "User is asking about the provider brain/API key setup."
          : intents.includes("capabilities")
            ? "User asked what this agent can actually do; answer from loaded agents, tools, skills, and workspace identity."
            : "User greeted the assistant; answer naturally without tool calls.",
      });
    }

    if (intents.includes("self-build")) {
      steps.push({
        type: "tool",
        tool: "self_build_plan",
        input: { focus: "codex-openclaw-omniclaw" },
        reason: "User asked to build OmniClaw as a Codex-style worker plus OpenClaw-style control shell.",
      });
    }

    if (intents.includes("v2-audit")) {
      steps.push({
        type: "tool",
        tool: "v2_status",
        input: {},
        reason: "User says OmniClaw is weak and wants a V2 upgrade across all features.",
      });
      steps.push({
        type: "tool",
        tool: "v2_repair_plan",
        input: {},
        reason: "Generate the next implementation plan from the weakest V2 features.",
      });
    }

    if (intents.includes("layer-status")) {
      steps.push({
        type: "tool",
        tool: "layer_status",
        input: {},
        reason: "User asked for OpenClaw-style layer status, tools/skills, or a demo of real runtime capability.",
      });
    }

    if (intents.includes("prompt-assembly")) {
      steps.push({
        type: "tool",
        tool: "prompt_assembly_status",
        input: {},
        reason: "User shared Hermes architecture screenshots about prompt assembly and wants OmniClaw improved.",
      });
    }

    if (intents.includes("computer-access")) {
      steps.push({
        type: "tool",
        tool: "computer_access_status",
        input: {},
        reason: "User asked to give OmniClaw laptop/computer tools and understand current access policy.",
      });
    }
    if (intents.includes("computer-search")) {
      steps.push({
        type: "tool",
        tool: "search_computer_files",
        input: { query: this.extractComputerSearchQuery(message), maxDepth: 4, maxResults: 80, maxScanMs: 7000 },
        reason: "User asked OmniClaw to search laptop files through governed computer access.",
      });
    }
    if (intents.includes("browser-observe")) {
      const wantsStatus = /\bbrowser\s+(?:status|doctor|health|ready|available)\b/i.test(message)
        || /\bstatus\s+(?:of\s+)?browser\b/i.test(message);
      steps.push({
        type: "tool",
        tool: "browser",
        input: wantsStatus
          ? { action: "status" }
          : { action: /screenshot|capture/i.test(message) ? "screenshot" : "view", format: "markdown" },
        reason: wantsStatus
          ? "User asked OmniClaw to show browser automation status."
          : "User asked OmniClaw to inspect the current automated browser page.",
      });
    }
    if (intents.includes("browser-navigate")) {
      const target = this.extractBrowserUrl(message);
      const opensWorkspaceFile = /^(?:file:\/\/|[^:]+\.html?$)/i.test(target) && !/^https?:\/\//i.test(target);
      steps.push({
        type: "tool",
        tool: opensWorkspaceFile ? "open_browser_url" : "browser",
        input: opensWorkspaceFile ? { path: target } : { action: "open", url: target },
        reason: "User asked OmniClaw to open or navigate a browser page.",
      });
    }

    if (intents.includes("provider-status") && !intents.includes("hermes-doctor") && !intents.includes("hermes-model")) {
      steps.push({
        type: "tool",
        tool: "provider_status",
        input: { verify: true },
        reason: "User reported provider/model/auth trouble or asked for active brain status.",
      });
    }

    if (intents.includes("capabilities") && !intents.includes("provider-status") && !intents.includes("hermes-skills")) {
      steps.push({
        type: "tool",
        tool: "capability_demo",
        input: {},
        reason: "User asked what tools and skills the active agent really has.",
      });
    }

    if (intents.includes("system-status")) {
      steps.push({
        type: "tool",
        tool: "computer_system_status",
        input: {},
        reason: "User asked to inspect laptop RAM/storage/system status.",
      });
    }

    if (intents.includes("time")) {
      steps.push({
        type: "tool",
        tool: "time_now",
        reason: "User asked for time-related information.",
      });
    }

    if (intents.includes("remember")) {
      const text = message.toLowerCase().startsWith("remember ")
        ? message.slice("remember ".length)
        : message;

      steps.push({
        type: "tool",
        tool: "remember_note",
        input: { text },
        reason: "Message looks like a memory request.",
      });
    }

    if (intents.includes("recall")) {
      steps.push({
        type: "tool",
        tool: "list_notes",
        reason: "User asked to inspect memory notes.",
      });
    }

    if (intents.includes("memory-list")) {
      steps.push({
        type: "tool",
        tool: "list_long_term_memory",
        reason: "User asked to inspect promoted long-term memory.",
      });
    }

    if (intents.includes("memory-dream")) {
      steps.push({
        type: "tool",
        tool: "dream_memory_sweep",
        input: { source: "chat" },
        reason: "User asked OmniClaw to review and promote useful memory candidates.",
      });
    }

    if (intents.includes("delegation")) {
      const delegation = this.extractDelegationRequest(message);
      steps.push({
        type: "tool",
        tool: "delegate_task",
        input: delegation,
        reason: `Route the request to the ${delegation.agentId} agent.`,
      });
    }

    if (intents.includes("task-create")) {
      const title =
        message.toLowerCase().startsWith("task ")
          ? message.slice("task ".length)
          : message.toLowerCase().startsWith("todo ")
            ? message.slice("todo ".length)
            : message;

      steps.push({
        type: "tool",
        tool: "create_task",
        input: this.buildTaskBlueprintInput({ title, message }),
        reason: "Message looks like a task creation request.",
      });
      if (!/\b(?:run now|start now|execute now|abhi run|abhi chala|run it)\b/i.test(message)) {
        return {
          summary: `Generated ${steps.length} step(s) using the ${profile.id} runtime profile.`,
          intents,
          profile,
          toolsAvailable: tools,
          steps,
        };
      }
    }

    if (intents.includes("task-list")) {
      steps.push({
        type: "tool",
        tool: "list_tasks",
        reason: "User asked to inspect tracked tasks.",
      });
    }

    if (intents.includes("planning")) {
      steps.push({
        type: "analysis",
        focus: "planning",
        reason: "The user is asking for structured product or build guidance.",
      });
    }

    if (intents.includes("project-test")) {
      const npm = this.getNpmCommand();
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: `"${npm} run build"` },
        reason: "Run the local syntax build check.",
      });
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: `"${npm} run test"` },
        reason: "Run the local smoke test.",
      });
    }

    if (intents.includes("project-build") && !intents.includes("v2-audit") && !intents.includes("self-build")) {
      const npm = this.getNpmCommand();
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: `"${npm} run portable:build"` },
        reason: "Build the portable executable package.",
      });
    }

    if (intents.includes("project-release")) {
      const npm = this.getNpmCommand();
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: `"${npm} run release:windows"` },
        reason: "Create the Windows release ZIP.",
      });
    }

    if (intents.includes("file-read")) {
      steps.push({
        type: "tool",
        tool: "read_file",
        input: { path: this.extractPath(message) },
        reason: "The user asked to inspect a workspace file.",
      });
    }

    if (intents.includes("computer-file-read")) {
      steps.push({
        type: "tool",
        tool: "read_computer_file",
        input: { path: this.extractComputerPath(message) },
        reason: "The user asked to read a laptop/computer file through governed computer access.",
      });
    }

    if (intents.includes("file-list")) {
      steps.push({
        type: "tool",
        tool: "list_files",
        input: { path: this.extractPath(message, ".") },
        reason: "The user asked to inspect workspace contents.",
      });
    }

    if (intents.includes("computer-directory-list")) {
      steps.push({
        type: "tool",
        tool: "list_computer_directory",
        input: { path: this.extractComputerPath(message, "~") },
        reason: "The user asked to list a laptop/computer folder through governed computer access.",
      });
    }

    if (intents.includes("shell-plan")) {
      steps.push({
        type: "tool",
        tool: "run_terminal_command",
        input: { command: this.extractShellCommand(message) },
        reason: "The user asked for a shell or terminal action.",
      });
    }

    if (intents.includes("file-write") && !intents.includes("complex-build") && !intents.includes("research")) {
      const writeRequest = this.extractWriteRequest(message);
      steps.push({
        type: "tool",
        tool: writeRequest.append ? "append_file" : "write_file",
        input: writeRequest,
        reason: "The user asked to create or update a workspace file.",
      });
      steps.push({
        type: "tool",
        tool: "read_file",
        input: { path: writeRequest.path },
        reason: "Read the file back after writing so the final reply proves the task completed.",
      });
    }

    if (intents.includes("computer-file-write")) {
      const writeRequest = this.extractComputerWriteRequest(message);
      steps.push({
        type: "tool",
        tool: "write_computer_file",
        input: writeRequest,
        reason: "The user asked to create or update a laptop/computer file through governed computer access.",
      });
      steps.push({
        type: "tool",
        tool: "read_computer_file",
        input: { path: writeRequest.path },
        reason: "Read the laptop/computer file back after writing so the final reply proves completion.",
      });
    }

    if (intents.includes("computer-delete")) {
      steps.push({
        type: "tool",
        tool: "delete_computer_path",
        input: { path: this.extractComputerPath(message, ""), permanent: /permanent|forever|hamesha|hard delete/i.test(message) },
        reason: "The user explicitly asked to delete a laptop/computer file or folder through governed computer access.",
      });
    }

    if (intents.includes("computer-copy")) {
      steps.push({
        type: "tool",
        tool: "copy_computer_path",
        input: this.extractCopyMoveRequest(message),
        reason: "The user asked to copy a file or folder through governed computer access.",
      });
    }

    if (intents.includes("computer-move")) {
      steps.push({
        type: "tool",
        tool: "move_computer_path",
        input: this.extractCopyMoveRequest(message),
        reason: "The user asked to move or rename a file or folder through governed computer access.",
      });
    }

    if (intents.includes("research") && !intents.includes("delegation") && !intents.includes("research-then-build")) {
      steps.push({
        type: "tool",
        tool: "web_research",
        input: { query: this.extractResearchQuery(message) },
        reason: "The user asked for lightweight web research.",
      });
    }

    if (intents.includes("complex-build")) {
      const artifact = this.buildGeneratedWebArtifact(message);
      const manifest = artifact ? this.buildGeneratedAppManifest(message, artifact) : null;
      if (intents.includes("research") || intents.includes("research-then-build")) {
        steps.push({
          type: "tool",
          tool: "web_research",
          input: { query: this.extractResearchQuery(message) },
          reason: "Research first because the user explicitly asked for research before/during the build.",
        });
      }
      steps.push({
        type: "tool",
        tool: "write_file",
        input: {
          path: "data/generated/build_plan.md",
          content: this.buildGeneratedAppPlan(message, artifact),
        },
        reason: "Create a structured build plan artifact before implementation.",
      });
      if (manifest) {
        steps.push({
          type: "tool",
          tool: "write_file",
          input: manifest,
          reason: "Write a machine-readable manifest with requested features and verification rules.",
        });
      }
      for (const extraFile of artifact?.extraFiles || []) {
        steps.push({
          type: "tool",
          tool: "write_file",
          input: extraFile,
          reason: "Write an additional project file required by the requested app.",
        });
      }
      if (artifact) {
        steps.push({
          type: "tool",
          tool: "write_file",
          input: artifact,
          reason: "Create a runnable first version instead of stopping at planning.",
        });
        steps.push({
          type: "tool",
          tool: "verify_html_artifact",
          input: {
            path: artifact.path,
            requiredText: artifact.requiredText || [],
            forbiddenText: artifact.forbiddenText || [],
            minBytes: artifact.minBytes || 1200,
          },
          reason: "Verify the generated app artifact before claiming the build is complete.",
        });
      }
    }

    if (intents.includes("research-then-build") && !intents.includes("complex-build")) {
      steps.push({
        type: "tool",
        tool: "web_research",
        input: { query: this.extractResearchQuery(message) },
        reason: "Research first because the request explicitly asks to research before building.",
      });
    }

    if (intents.includes("task-run")) {
      steps.push({
        type: "tool",
        tool: "run_task",
        input: { taskId: this.extractTaskId(message) },
        reason: "The user asked to execute a saved task workflow.",
      });
    }

    if (intents.includes("skill-create")) {
      steps.push({
        type: "tool",
        tool: "create_skill",
        input: this.extractSkillRequest(message),
        reason: "The user asked OmniClaw to add a new skill.",
      });
    }

    if (intents.includes("config-update")) {
      steps.push({
        type: "tool",
        tool: "update_runtime_settings",
        input: this.extractRuntimeRequest(message),
        reason: "The user asked OmniClaw to customize its runtime settings.",
      });
    }

    if (intents.includes("provider-model-list") && !intents.includes("hermes-model")) {
      steps.push({
        type: "tool",
        tool: "list_provider_models",
        input: this.extractProviderModelsRequest(message),
        reason: "The user asked to fetch/select available provider models from the configured endpoint.",
      });
    }

    if (intents.includes("plugin-echo")) {
      steps.push({
        type: "tool",
        tool: "plugin_echo",
        input: { message: this.extractPluginEchoMessage(message) },
        reason: "The user asked for a plugin runtime tool.",
      });
    }

    if (skills.length > 0) {
      steps.push({
        type: "skill-context",
        skills: skills.map((skill) => skill.name),
        reason: "Matching skills can shape the assistant response.",
      });
    }

    if (steps.length === 0) {
      steps.push({
        type: "respond",
        reason: "No tool call needed, answer directly.",
      });
    }

    return {
      summary: `Generated ${steps.length} step(s) using the ${profile.id} runtime profile.`,
      intents,
      profile,
      toolsAvailable: tools,
      steps,
    };
  }

  async buildPlanWithModel({ message, intents, skills, tools, profile, provider }) {
    if (!provider) {
      return this.buildPlan({ message, intents, skills, tools, profile });
    }

    const heuristic = this.buildPlan({ message, intents, skills, tools, profile });
    if (heuristic.steps.some((step) => step.tool === "delegate_task")) {
      return heuristic;
    }
    const hasConcreteToolSteps = heuristic.steps.some((step) => step.type === "tool");
    if (hasConcreteToolSteps && !intents.some((intent) => ["repair", "verification"].includes(intent))) {
      return {
        ...heuristic,
        source: "heuristic",
        modelPlanningSkipped: true,
        modelPlanningReason: "Heuristic planner already selected concrete runtime tools; skip provider planning so execution starts immediately.",
      };
    }

    const requiresModelPlanning = intents.some((intent) =>
      [
        "complex-build",
        "research",
        "research-then-build",
        "repair",
        "verification",
      ].includes(intent),
    );

    if (hasConcreteToolSteps && !requiresModelPlanning) {
      return {
        ...heuristic,
        source: "heuristic",
        modelPlanningSkipped: true,
        modelPlanningReason: "Heuristic planner already selected concrete runtime tools.",
      };
    }

    const providerInfo = typeof provider.getInfo === "function" ? provider.getInfo() : {};
    if (providerInfo.ready === false || providerInfo.apiKeySource === "missing") {
      return {
        ...heuristic,
        source: "heuristic",
        modelPlanningSkipped: true,
        modelPlanningReason: providerInfo.message || "Provider is not ready for model-assisted planning.",
      };
    }

    const directResponseIntents = ["greeting", "api-setup", "capabilities"];
    if (intents.every((intent) => directResponseIntents.includes(intent))) {
      return heuristic;
    }
    
    // Only use model if heuristic is simple or intents suggest complexity
    const isComplex = requiresModelPlanning ||
                      intents.some(i => ["planning", "research", "skill-create"].includes(i)) ||
                      heuristic.steps.every(s => s.type === "respond");
    
    if (!isComplex) {
      return heuristic;
    }

    const prompt = `Task: Generate a multi-step plan for the user request.
Available Tools:
${tools.map(t => `- ${t.id}: ${t.description}`).join("\n")}

User Message: "${message}"
Detected Intents: ${intents.join(", ")}

Return a JSON object with:
1. summary: (string) short plan summary
2. steps: (array) list of tool calls
   - type: "tool"
   - tool: (string) tool id
   - input: (object) tool arguments
   - reason: (string) why this step is needed

Rule: Use as few steps as possible. If the user asks to research/search/look up/read a URL, include the relevant runtime tool call. Never answer "I will research" unless a tool call is included.

JSON:`;

    try {
      const planningTimeoutMs = Math.max(3000, Math.min(12000, Number(profile?.modelPlanningTimeoutMs || 8000)));
      const response = await Promise.race([
        provider.complete([
          { role: "system", content: "You are an expert task planner. You output valid JSON." },
          { role: "user", content: prompt }
        ]),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Model planning timed out after ${planningTimeoutMs}ms`)),
          planningTimeoutMs,
        )),
      ]);

      const text = response.text || "{}";
      const plan = JSON.parse(text.match(/\{.*\}/s)?.[0] || "{}");
      
      if (plan.steps && Array.isArray(plan.steps)) {
        const mergedSteps = this.mergeModelPlanWithHeuristic(plan, heuristic);
        return {
          summary: plan.summary || "Model-generated multi-step plan.",
          intents,
          profile,
          toolsAvailable: tools,
          steps: mergedSteps,
          source: "model",
          heuristicPreserved: mergedSteps.some((step) => heuristic.steps.includes(step)),
        };
      }
    } catch (error) {
      console.error("Model planning error:", error);
    }

    return heuristic;
  }

  extractPath(message, fallback = "") {
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted && /\.[A-Za-z0-9]{1,8}$/.test(quoted[1].trim())) {
      return quoted[1];
    }

    const pathMatch = String(message || "").match(/\b([A-Za-z0-9._\/\\-]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i);
    if (pathMatch) {
      return pathMatch[1].trim();
    }

    const patterns = [
      /(?:read file|open file|show file|read|list files|show files|list folder|list directory)\s+(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        let extracted = match[1].trim();
        extracted = extracted.replace(/^(?:in |from |of |at )(?:the )?/i, "").trim();
        if (/^(?:workspace|project|root|current|here|cwd|\.?)$/i.test(extracted)) {
          return fallback || ".";
        }
        if (extracted) return extracted;
      }
    }

    return fallback;
  }

  extractComputerPath(message, fallback = "~") {
    const text = String(message || "").trim();
    const quoted = text.match(/["']([^"']+)["']/);
    if (quoted && /(?:[a-zA-Z]:[\\/]|[~\/\\]|\.[A-Za-z0-9]{1,8}$)/.test(quoted[1].trim())) {
      return quoted[1].trim();
    }

    const drivePath = text.match(/[a-zA-Z]:[\\/][^\r\n"']+/);
    if (drivePath) {
      return drivePath[0].trim().replace(/[.。]+$/, "");
    }

    const relativeFile = text.match(/\b([A-Za-z0-9._\/\\-]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i);
    if (relativeFile) {
      return relativeFile[1].trim();
    }

    if (/\bdownloads?\b/i.test(text)) {
      return "~/Downloads";
    }
    if (/\bdesktop\b/i.test(text)) {
      return "~/Desktop";
    }
    if (/\bdocuments?\b/i.test(text)) {
      return "~/Documents";
    }
    if (/\bhome\b/i.test(text)) {
      return "~";
    }

    const afterPhrase = text.match(/(?:path|file|folder|directory)\s+(.+)$/i);
    if (afterPhrase?.[1]) {
      return afterPhrase[1].trim().replace(/[.。]+$/, "");
    }

    return fallback;
  }

  extractBrowserUrl(message) {
    const text = String(message || "").trim();
    const quoted = text.match(/["']([^"']+)["']/);
    if (quoted) {
      return this.normalizeBrowserUrl(quoted[1]);
    }
    const fileUrl = text.match(/file:\/\/[^\s"'<>]+/i);
    if (fileUrl) {
      return fileUrl[0];
    }
    const htmlPath = text.match(/\b([A-Za-z0-9._\/\\-]+\.html?)\b/i);
    if (htmlPath) {
      return htmlPath[1];
    }
    if (/\b(?:generated app|last app|html app|website)\b/i.test(text) && /\b(?:open|preview|run|chalao|chala|kholo)\b/i.test(text)) {
      return "data/generated/index.html";
    }
    const url = text.match(/https?:\/\/[^\s"'<>]+/i);
    if (url) {
      return this.normalizeBrowserUrl(url[0]);
    }
    const domain = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s"'<>]*)?/i);
    if (domain) {
      return this.normalizeBrowserUrl(domain[0]);
    }
    if (/\bgoogle\b/i.test(text)) {
      return "https://www.google.com";
    }
    if (/\bgithub\b/i.test(text)) {
      return "https://github.com";
    }
    if (/\byoutube\b/i.test(text)) {
      return "https://www.youtube.com";
    }
    return "http://localhost:3147/";
  }

  normalizeBrowserUrl(value) {
    const text = String(value || "").trim().replace(/[.。]+$/, "");
    if (!text) {
      return "http://localhost:3147/";
    }
    if (/^(?:https?|file):\/\//i.test(text) || /\.html?$/i.test(text)) {
      return text;
    }
    return `https://${text}`;
  }

  extractWriteRequest(message) {
    const quoted = [...message.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    const append = message.toLowerCase().includes("append file");
    const pathMatch =
      message.match(/\b(?:called|named|as|to)\s+([A-Za-z0-9._\/\\-]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i) ||
      message.match(/\b([A-Za-z0-9._\/\\-]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i);
    const contentMatch =
      message.match(/\b(?:exactly this content|with exactly this content)\s*:?\s*([\s\S]+?)(?:\bafter writing\b|\bthen verify\b|\bverify it\b|\band read (?:it )?back\b|\bread it back\b|$)/i) ||
      message.match(/\b(?:with content|content|containing|write)\s+["']([^"']+)["']/i) ||
      message.match(/\b(?:with content|content|containing)\s+([\s\S]+?)(?:\band read (?:it )?back\b|\bread it back\b|\bthen verify\b|\bverify it\b|$)/i);

    return {
      path: pathMatch?.[1] || quoted[0] || "data/generated/output.txt",
      content: contentMatch?.[1]?.trim().replace(/[.ã€‚]\s*$/, ".") || quoted[1] || "Generated by OmniClaw.\n",
      append,
    };
  }

  extractCopyMoveRequest(message) {
    const quoted = [...message.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    if (quoted.length >= 2) {
      return {
        from: quoted[0],
        to: quoted[1],
        overwrite: /overwrite|replace/i.test(message),
      };
    }

    const match = message.match(/\bfrom\s+(.+?)\s+\bto\s+(.+)$/i) || message.match(/\b(.+?)\s+->\s+(.+)$/);
    return {
      from: match ? match[1].trim() : "",
      to: match ? match[2].trim() : "",
      overwrite: /overwrite|replace/i.test(message),
    };
  }

  extractResearchQuery(message) {
    const rawMessage = String(message || "");
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted && /\.[A-Za-z0-9]{1,8}$/.test(quoted[1].trim())) {
      return quoted[1];
    }

    const explicitResearchClause =
      rawMessage.match(/\b(?:web\s+)?(?:research|reaserach|raeserach|reaserch|raeserch)\s+(?:karo|karna|do|on|about|for)?\s*[:\-]\s*([^\r\n.]+(?:\.[^\r\n.]+)?)/i) ||
      rawMessage.match(/\b(?:web\s+)?(?:research|reaserach|raeserach|reaserch|raeserch)\s+(?:karo|karna|do|on|about|for)\s+([^\r\n.]+(?:\.[^\r\n.]+)?)/i);
    if (explicitResearchClause?.[1]?.trim()) {
      const clause = explicitResearchClause[1]
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

    const featurePhrase = rawMessage.match(/\b(?:the\s+)?(?:top\s+\d+\s+)?(features?|benefits|advantages|best practices|capabilities|use cases?)\s+of\s+([A-Za-z0-9][\p{L}\p{N}\s.+#_-]{1,80}?)(?:\s+(?:and|then|with|using|use|clean|concise|short)\b|[,;!?]|$)/iu);
    if (featurePhrase?.[1] && featurePhrase?.[2]) {
      const topic = featurePhrase[2]
        .replace(/[.,;!?]+$/g, "")
        .trim();
      return `${topic} ${featurePhrase[1].replace(/s$/i, "").trim()}s`.replace(/\s+/g, " ");
    }

    const hinglishTopic =
      rawMessage.match(/^\s*(?:tu\s+|tum\s+)?(?:m[eai]r[ae]?|mara|mera|mere)\s+li(?:ye|ya)\s+(.+?)\s+(?:ka|ke|ki)\s+(?:baare|bare|bara)\s+(?:me|mein|ma)\b/i) ||
      rawMessage.match(/\b([A-Za-z0-9][\p{L}\p{N}\s.+#_-]{1,80}?)\s+(?:ai\s+)?(?:kya|what)\s+(?:ha|hai|he|is)\b/iu);
    if (hinglishTopic?.[1]?.trim()) {
      return hinglishTopic[1].trim();
    }

    const entityTopic = rawMessage.match(/^\s*([A-Z][A-Za-z0-9.+#-]*(?:\s+[A-Z][A-Za-z0-9.+#-]*){0,4})\s+(?:ka|ke|ki)\s+.*?\b(?:research|reasearch|reaserach|search|batao|summary|summarize|summarise)\b/i);
    if (entityTopic?.[1]?.trim()) {
      return entityTopic[1].trim();
    }

    const pathMatch = rawMessage.match(/\b([A-Za-z0-9._\/\\-]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i);
    if (pathMatch) {
      return pathMatch[1].trim();
    }

    const cleaned = rawMessage
      .replace(/\buse\s+(?:a\s+)?(?:research|researcher|reasearch|reaserach)\s+agent\s+to\b/gi, "")
      .replace(/\b(do a |perform a |conduct a |make a )?research (on |about |for )?/gi, "")
      .replace(/\b(reasearch|reaserach|search (the web )?(for |on |about )?|look up |find (on web|information about|info on|info about|out about) )/gi, "")
      .replace(/\b(summarize|summarise|explain|describe|tell me about|give me|show me|list|get)\b/gi, "")
      .replace(/^\s*(?:tu|tum)\s+(?:m[eai]r[ae]?|mara|mera|mere)\s+li(?:ye|ya)\s+/gi, "")
      .replace(/^\s*(?:m[eai]r[ae]?|mara|mera|mere)\s+li(?:ye|ya)\s+/gi, "")
      .replace(/\bmujh[ae]?\s+samjha(?:o)?\b/gi, "")
      .replace(/\bweb\b(?=\s*$|\s+(?:sources?|research|search)\b)/gi, "")
      .replace(/\b(karo|kar|kr|karke|karna|de do|batao|bata do|dijiye)\b/gi, "")
      .replace(/\b(ke baare mein|ke bare mein|ke baare me|ke bare me|ka bara ma|ke bara ma|ka bare ma|ke bare ma|ke sath|ke saath|sources? ke sath|sources? ke saath|source ke sath|source ke saath|with sources?|sources?)\b/gi, "")
      .replace(/\b(?:ke|ka|ki)\s+(?:bare|bara|baare)\s+(?:me|mein|ma)\b/gi, "")
      .replace(/\b(?:then|and)\s+(?:summarize|summarise|explain|describe)\s+(?:it|this|that)?\b/gi, "")
      .replace(/\b(?:then|and)\s+(?:it|this|that)\b/gi, "")
      .replace(/\b(?:official\s+)?sources?\s+first\b/gi, "")
      .replace(/\b(?:official\s+)?docs?\s+first\b/gi, "")
      .replace(/\bofficial\s+first\b/gi, "")
      .replace(/\bofficial\s+(?:sources?|docs?|documentation|website)\s+first\b/gi, "")
      .replace(/\b(?:use|using)\s+(?:web\s+)?(?:search|fetch|sources?|official sources?)\b/gi, "")
      .replace(/\b(?:clean\s+hinglish|clean answer|concise answer|short answer)\b/gi, "")
      .replace(/\braw\s+tool\s+logs?.*$/gi, "")
      .replace(/\b(?:main|key)\s+(?:models?|products?|notes?|points?)\b.*$/gi, "")
      .replace(/\b(?:features?|use cases?|capabilities|overview|concise|clean answer|deep)\b/gi, " ")
      .replace(/\b(?:aur|or|and|do|please|pls|ka|ke|ki)\b\s*$/gi, " ")
      .replace(/\btop\s+\d+\s+/gi, "")
      .replace(/\b(?:the|a|an)\s+(?=(?:features|benefits|best practices|advantages)\b)/gi, "")
      .replace(/\bweb\b\s*$/gi, "")
      .replace(/^(and |then |now )+/gi, "")
      .replace(/[^\p{L}\p{N}\s._-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const ofPhrase = cleaned.match(/^(features|benefits|advantages|best practices)\s+of\s+(.+)$/i);
    if (ofPhrase?.[1] && ofPhrase?.[2]) {
      return `${ofPhrase[2].trim()} ${ofPhrase[1].trim()}`;
    }
    if (cleaned.length >= 3) {
      return cleaned;
    }
    const namedTopic = String(message || "").match(/\b([A-Z][A-Za-z0-9.+#-]*(?:\s+[A-Z][A-Za-z0-9.+#-]*){0,4})\b/);
    if (namedTopic?.[1]) {
      return namedTopic[1].trim();
    }
    const normalized = cleaned.toLowerCase();
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const mostlyAiNoise =
      /\bai\b/i.test(cleaned) &&
      tokens.every((token) => ["ai", "ki", "i", "kisi", "koi", "ek", "ik"].includes(token));
    if (mostlyAiNoise) {
      return "artificial intelligence";
    }
    if (cleaned.length < 3 && message.length > 10) {
      const keyTerms = message.match(/\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g);
      if (keyTerms?.length) {
        return keyTerms.join(" ");
      }
      const afterPrep = message.match(/\b(?:about|for|on|of)\s+([a-zA-Z0-9\s._-]+?)(?:\s+and|\s+then|\s*[.,;]|$)/i);
      if (afterPrep?.[1]?.trim().length > 2) {
        return afterPrep[1].trim();
      }
    }
    return cleaned || message;
  }

  extractTelegramSetup(message) {
    const text = String(message || "");
    const lowered = text.toLowerCase();
    const tokenMatch = text.match(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
    const shouldConfigure = /\btelegram\b/i.test(text) && (
      Boolean(tokenMatch) ||
      /connect|setup|set\s*up|enable|start|token|bot|configure|jod|jodo|add|save/i.test(lowered)
    );
    return {
      shouldConfigure,
      botToken: tokenMatch?.[0] || "",
      enabled: true,
      startWorker: Boolean(tokenMatch) || /start|chala|run|enable/i.test(lowered),
      defaultAgentId: "main",
      mode: "polling",
    };
  }

  extractComputerWriteRequest(message) {
    const text = String(message || "");
    const lowered = text.toLowerCase();
    const quoted = [...text.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    const append = /\bappend\b/i.test(text);
    const normalizeComputerFileName = (value = "") => {
      const cleaned = String(value || "")
        .replace(/\b(?:mara|mere|meri|mera|liya|liye|please|plz|download|downloads|documents|desktop|folder|directory|ma|mein|me|pa|par|pe|inside|in|under)\b/gi, " ")
        .replace(/\b(?:naam|name|called|named|ki|ka|ke|wali|wala)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
        .replace(/[. ]+$/g, "");
      if (!cleaned) {
        return "";
      }
      return /\.[A-Za-z0-9]{1,8}$/.test(cleaned) ? cleaned : `${cleaned}.txt`;
    };
    const drivePath =
      text.match(/[a-zA-Z]:[\\/][^\r\n"']+?\.(?:txt|html|js|css|json|md|py|ts|csv)\b/i)?.[0] ||
      "";
    const namedPath =
      text.match(/\b(?:called|named|as|to|path|file)\s+([~A-Za-z0-9:._\/\\ -]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i)?.[1] ||
      "";
    const requestedFileName = normalizeComputerFileName(
      text.match(/\b(?:ma|mein|me|pa|par|pe|inside|in|under)\s+(.+?)\s+(?:name|naam)\s+(?:ki|se)\s+file\s+(?:bna|bana|banao|bnana|banana|create|write|save)\b/i)?.[1] ||
      text.match(/\b(.+?)\s+(?:name|naam)\s+(?:ki|se)\s+file\s+(?:bna|bana|banao|bnana|banana|create|write|save)\b/i)?.[1] ||
      text.match(/\bfile\s+(?:called|named|naam|name)\s+([A-Za-z0-9 ._-]{1,120})\b/i)?.[1] ||
      "",
    );
    const path = (drivePath || namedPath || quoted.find((item) => /(?:[a-zA-Z]:[\\/]|[~\/\\]|\.\w+$)/.test(item)) || "").trim();
    const contentMatch = requestedFileName ? null :
      text.match(/\b(?:with content|content|containing|write)\s+["']([^"']+)["']/i) ||
      text.match(/\b(?:with content|content|containing)\s+(.+)$/i) ||
      text.match(/\b(?:ma|mein|me|with)\s+(.+?)\s+(?:ya\s+)?file\s+(?:bna|bana|banao|bnana|banana|create|write|save)\b/i);
    const content = contentMatch?.[1]?.trim()
      || quoted.find((item) => item !== path)
      || "Generated by OmniClaw.\n";
    const defaultPath = /\bdownloads?\b/i.test(lowered)
      ? `~/Downloads/${requestedFileName || "omniclaw-output.txt"}`
      : `~/Documents/${requestedFileName || "omniclaw-output.txt"}`;
    return {
      path: path || defaultPath,
      content,
      append,
    };
  }

  buildGeneratedWebArtifact(message = "") {
    const spec = this.extractGeneratedAppSpec(message);
    const { lower, path, title } = spec;
    if (!title) {
      return null;
    }

    if (lower.includes("calculator")) {
      return {
        path,
        requiredText: [title, "Calculator", "AC"],
        forbiddenText: ["OmniClaw Web App"],
        minBytes: 1800,
        content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background:#101112; color:#f7f7f4; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; }
    main { width:min(360px, calc(100vw - 32px)); background:#1b1c1e; border:1px solid #303236; border-radius:22px; padding:20px; box-shadow:0 20px 80px rgba(0,0,0,.35); }
    output { display:block; min-height:72px; padding:18px; margin-bottom:14px; border-radius:16px; background:#0b0c0d; font-size:34px; text-align:right; overflow:hidden; }
    .keys { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
    button { height:58px; border:0; border-radius:15px; background:#2b2d31; color:#fff; font-size:20px; cursor:pointer; }
    button:hover { background:#383b40; }
    .op { background:#ff7a1a; color:#111; font-weight:700; }
    .wide { grid-column:span 2; }
  </style>
</head>
<body>
  <main aria-label="Calculator">
    <output id="display">0</output>
    <section class="keys">
      <button data-clear class="wide">AC</button><button data-key="/">/</button><button data-key="*">*</button>
      <button data-key="7">7</button><button data-key="8">8</button><button data-key="9">9</button><button data-key="-" class="op">-</button>
      <button data-key="4">4</button><button data-key="5">5</button><button data-key="6">6</button><button data-key="+" class="op">+</button>
      <button data-key="1">1</button><button data-key="2">2</button><button data-key="3">3</button><button data-equals class="op">=</button>
      <button data-key="0" class="wide">0</button><button data-key=".">.</button>
    </section>
  </main>
  <script>
    const display = document.querySelector("#display");
    let expr = "";
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.clear !== undefined) expr = "";
      if (button.dataset.key) expr += button.dataset.key;
      if (button.dataset.equals !== undefined) {
        try { expr = String(Function('"use strict"; return (' + expr + ')')()); }
        catch { expr = "Error"; }
      }
      display.textContent = expr || "0";
    });
  </script>
</body>
</html>
`,
      };
    }

    if (lower.includes("todo") || lower.includes("to-do")) {
      return {
        path,
        requiredText: [title, "Todo List", "Add a task"],
        forbiddenText: ["OmniClaw Web App"],
        minBytes: 1800,
        content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f4f1ea; color:#181818; font-family:Inter, system-ui, sans-serif; }
    main { width:min(560px, calc(100vw - 32px)); background:white; border:1px solid #ddd7cc; border-radius:20px; padding:24px; box-shadow:0 16px 60px rgba(40,35,25,.16); }
    h1 { margin:0 0 16px; font-size:30px; }
    form { display:flex; gap:10px; }
    input { flex:1; padding:14px; border-radius:12px; border:1px solid #ccc5b8; font-size:16px; }
    button { border:0; border-radius:12px; padding:0 16px; background:#111; color:white; cursor:pointer; }
    li { display:flex; align-items:center; gap:10px; padding:12px 0; border-bottom:1px solid #eee8dc; }
    li.done span { text-decoration:line-through; color:#777; }
    li span { flex:1; }
  </style>
</head>
<body>
  <main>
    <h1>Todo List</h1>
    <form id="form"><input id="task" placeholder="Add a task" /><button>Add</button></form>
    <ul id="list"></ul>
  </main>
  <script>
    const form = document.querySelector("#form");
    const task = document.querySelector("#task");
    const list = document.querySelector("#list");
    const items = JSON.parse(localStorage.omniclawTodos || "[]");
    const save = () => localStorage.omniclawTodos = JSON.stringify(items);
    const render = () => {
      list.innerHTML = "";
      items.forEach((item, index) => {
        const li = document.createElement("li");
        li.className = item.done ? "done" : "";
        li.innerHTML = '<input type="checkbox" ' + (item.done ? 'checked' : '') + '><span></span><button>Delete</button>';
        li.querySelector("span").textContent = item.text;
        li.querySelector("input").onchange = () => { item.done = !item.done; save(); render(); };
        li.querySelector("button").onclick = () => { items.splice(index, 1); save(); render(); };
        list.appendChild(li);
      });
    };
    form.onsubmit = (event) => { event.preventDefault(); if (task.value.trim()) items.push({ text: task.value.trim(), done:false }); task.value = ""; save(); render(); };
    render();
  </script>
</body>
</html>
`,
      };
    }

    if (lower.includes("fitness") || lower.includes("workout") || lower.includes("calories") || lower.includes("macros")) {
      return {
        path,
        requiredText: ["PulseFit Tracker", "Workout Plan", "Macros", "Weekly Progress", "Quick Log"],
        forbiddenText: ["OmniClaw Web App"],
        minBytes: 5000,
        content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; --ink:#17211c; --muted:#65736b; --line:#dbe4dd; --mint:#88f2c2; --green:#1f8f5f; --coal:#101715; --card:#ffffff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:#eef5ef; color:var(--ink); }
    .shell { width:min(1180px, calc(100vw - 28px)); margin:0 auto; padding:24px 0 34px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:18px; }
    .brand { display:flex; align-items:center; gap:12px; }
    .logo { width:42px; height:42px; border-radius:14px; display:grid; place-items:center; background:var(--coal); color:var(--mint); font-weight:900; }
    h1 { margin:0; font-size:clamp(26px, 4vw, 44px); letter-spacing:0; }
    .sub { color:var(--muted); margin:4px 0 0; }
    .hero { display:grid; grid-template-columns:1.15fr .85fr; gap:18px; align-items:stretch; }
    .panel { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:20px; box-shadow:0 14px 40px rgba(22, 46, 32, .08); }
    .summary { background:linear-gradient(135deg, #102018, #1f8f5f); color:white; }
    .summary p { color:#d8ffe9; max-width:56ch; line-height:1.55; }
    .stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-top:22px; }
    .stat { background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.18); border-radius:8px; padding:14px; }
    .stat strong { display:block; font-size:28px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:18px; }
    h2 { margin:0 0 14px; font-size:20px; }
    .workout { display:grid; gap:10px; }
    .move { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px; border:1px solid var(--line); border-radius:8px; background:#f8fbf8; }
    .move span { color:var(--muted); font-size:14px; }
    .macro { margin:14px 0; }
    .bar { height:10px; background:#e9efe9; border-radius:999px; overflow:hidden; }
    .fill { height:100%; width:var(--w); background:linear-gradient(90deg, var(--green), var(--mint)); }
    .chart { display:flex; align-items:end; gap:10px; height:180px; padding-top:10px; }
    .day { flex:1; display:grid; align-items:end; gap:8px; text-align:center; color:var(--muted); font-size:12px; }
    .col { min-height:18px; height:var(--h); background:#1f8f5f; border-radius:8px 8px 2px 2px; }
    form { display:grid; grid-template-columns:1fr 1fr auto; gap:10px; margin-top:12px; }
    input, select, button { min-height:42px; border-radius:8px; border:1px solid var(--line); padding:0 12px; font:inherit; }
    button { background:var(--coal); color:white; border-color:var(--coal); cursor:pointer; }
    button:hover { background:#22312c; }
    .log { margin:12px 0 0; padding:0; list-style:none; display:grid; gap:8px; }
    .log li { display:flex; justify-content:space-between; padding:10px 12px; background:#f8fbf8; border:1px solid var(--line); border-radius:8px; }
    @media (max-width: 820px) { .hero, .grid { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } .stats, form { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div class="brand"><div class="logo">PF</div><div><h1>PulseFit Tracker</h1><p class="sub">Daily training, nutrition, and progress in one clean dashboard.</p></div></div>
      <button id="reset">Reset demo</button>
    </header>
    <section class="hero">
      <article class="panel summary">
        <h2>Today&apos;s Readiness</h2>
        <p>Balanced strength session with a moderate calorie target. Stay inside macro range and finish the evening mobility block.</p>
        <div class="stats">
          <div class="stat"><span>Calories</span><strong id="calories">1840</strong></div>
          <div class="stat"><span>Workout</span><strong>72%</strong></div>
          <div class="stat"><span>Streak</span><strong id="streak">12</strong></div>
        </div>
      </article>
      <article class="panel">
        <h2>Macros</h2>
        <div class="macro"><strong>Protein 132g</strong><div class="bar"><div class="fill" style="--w:82%"></div></div></div>
        <div class="macro"><strong>Carbs 210g</strong><div class="bar"><div class="fill" style="--w:68%"></div></div></div>
        <div class="macro"><strong>Fat 58g</strong><div class="bar"><div class="fill" style="--w:54%"></div></div></div>
      </article>
    </section>
    <section class="grid">
      <article class="panel">
        <h2>Workout Plan</h2>
        <div class="workout">
          <div class="move"><strong>Push Press</strong><span>4 sets x 6 reps</span></div>
          <div class="move"><strong>Goblet Squat</strong><span>3 sets x 12 reps</span></div>
          <div class="move"><strong>Incline Walk</strong><span>22 minutes</span></div>
          <div class="move"><strong>Mobility Flow</strong><span>10 minutes</span></div>
        </div>
      </article>
      <article class="panel">
        <h2>Weekly Progress</h2>
        <div class="chart" aria-label="Weekly progress chart">
          <div class="day"><div class="col" style="--h:45%"></div>Mon</div>
          <div class="day"><div class="col" style="--h:66%"></div>Tue</div>
          <div class="day"><div class="col" style="--h:52%"></div>Wed</div>
          <div class="day"><div class="col" style="--h:78%"></div>Thu</div>
          <div class="day"><div class="col" style="--h:88%"></div>Fri</div>
          <div class="day"><div class="col" style="--h:61%"></div>Sat</div>
          <div class="day"><div class="col" style="--h:72%"></div>Sun</div>
        </div>
      </article>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Quick Log</h2>
      <form id="logForm">
        <input id="activity" placeholder="Activity" value="Cycling" />
        <select id="minutes"><option>15 min</option><option>30 min</option><option>45 min</option></select>
        <button>Add entry</button>
      </form>
      <ul class="log" id="log"></ul>
    </section>
  </main>
  <script>
    const log = document.querySelector("#log");
    const form = document.querySelector("#logForm");
    const activity = document.querySelector("#activity");
    const minutes = document.querySelector("#minutes");
    const calories = document.querySelector("#calories");
    let entries = JSON.parse(localStorage.pulseFitEntries || "[]");
    function render() {
      log.innerHTML = entries.map((entry, index) => '<li><span>' + entry.activity + '</span><strong>' + entry.minutes + '</strong><button data-remove="' + index + '">Remove</button></li>').join("");
      calories.textContent = 1840 + entries.length * 90;
      localStorage.pulseFitEntries = JSON.stringify(entries);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      entries.push({ activity: activity.value.trim() || "Workout", minutes: minutes.value });
      render();
    });
    log.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      entries.splice(Number(button.dataset.remove), 1);
      render();
    });
    document.querySelector("#reset").addEventListener("click", () => { entries = []; render(); });
    render();
  </script>
</body>
</html>
`,
      };
    }

    if (spec.kind === "omnicore") {
      return this.buildOmniCoreArtifact(spec);
    }

    return this.buildProjectWebArtifact(spec);
  }

  buildOmniCoreArtifact(spec = {}) {
    const folder = String(spec.path || "data/generated/omnicore/index.html").replace(/[^/\\]+\.html?$/i, "").replace(/[\\/]?$/, "/") || "data/generated/omnicore/";
    const path = `${folder}index.html`;
    const serverPath = `${folder}server.js`;
    const packagePath = `${folder}package.json`;
    const readmePath = `${folder}README.md`;
    return {
      path,
      requiredText: ["OmniCore", "Task Chat", "Live Computer", "Provider Setup", "Agent Profile", "Progress Timeline"],
      forbiddenText: ["OmniClaw Web App", "OmniClaw Clock"],
      minBytes: 6500,
      extraFiles: [
        {
          path: packagePath,
          content: JSON.stringify({
            name: "omnicore-agent-prototype",
            version: "0.1.0",
            private: true,
            type: "module",
            scripts: {
              start: "node server.js",
              test: "node server.js --self-test",
            },
          }, null, 2),
        },
        {
          path: serverPath,
          content: `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4177);
const tasks = [
  { id: "task_research", title: "Research Manus-style agent UX", status: "complete" },
  { id: "task_build", title: "Build OmniCore prototype", status: "running" },
  { id: "task_verify", title: "Verify frontend and API", status: "queued" },
];

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data, null, 2));
}

function serveIndex(res) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
}

function handleChat(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    const text = String(parsed.message || "").trim();
    json(res, 200, {
      agent: "OmniCore",
      reply: text
        ? "I created a task plan, attached it to the live computer panel, and queued tool execution proof for: " + text
        : "OmniCore is online. Give me a task and I will plan, act, and verify.",
      task: { id: "task_" + Date.now(), title: text || "New task", status: "planned" },
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (url.pathname === "/" || url.pathname === "/index.html") return serveIndex(res);
  if (url.pathname === "/api/status") return json(res, 200, { ok: true, name: "OmniCore", computer: "ready", provider: "configurable", tasks: tasks.length });
  if (url.pathname === "/api/tasks") return json(res, 200, { tasks });
  if (url.pathname === "/api/chat" && req.method === "POST") return handleChat(req, res);
  json(res, 404, { error: "not_found" });
});

if (process.argv.includes("--self-test")) {
  const indexOk = fs.existsSync(path.join(__dirname, "index.html"));
  const apiOk = tasks.length >= 3;
  console.log(JSON.stringify({ ok: indexOk && apiOk, indexOk, apiOk, endpoints: ["/api/status", "/api/tasks", "/api/chat"] }));
  process.exit(indexOk && apiOk ? 0 : 1);
}

server.listen(port, () => {
  console.log("OmniCore running at http://localhost:" + port);
});
`,
        },
        {
          path: readmePath,
          content: `# OmniCore

OmniCore is a local Manus-style agent prototype generated by OmniClaw.

## Architecture

- Frontend: single-page task workspace with left sidebar, chat, live computer panel, provider setup, profile settings, and progress timeline.
- Backend: tiny Node HTTP server with /api/status, /api/tasks, and /api/chat.
- Agent loop model: user task -> plan -> tool/computer progress -> API status -> verified response.

## Run

\`\`\`bash
cd data/generated/omnicore
npm start
\`\`\`

Open http://localhost:4177.

## Test

\`\`\`bash
cd data/generated/omnicore
npm test
\`\`\`
`,
        },
      ],
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OmniCore</title>
  <style>
    :root { --bg:#f7f7f4; --panel:#ffffff; --ink:#191919; --muted:#757575; --line:#e6e2dc; --dark:#1f1f1d; --accent:#2f7d68; --soft:#edf7f2; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); }
    .app { display:grid; grid-template-columns:250px minmax(380px, 1fr) minmax(360px, 42vw); min-height:100vh; }
    aside { border-right:1px solid var(--line); background:#f0efeb; padding:18px 14px; display:flex; flex-direction:column; gap:20px; }
    .brand { display:flex; align-items:center; gap:10px; font-weight:800; font-size:20px; }
    .mark { width:34px; height:34px; border-radius:10px; background:var(--dark); color:white; display:grid; place-items:center; }
    nav { display:grid; gap:6px; }
    nav button, .task { width:100%; min-height:40px; border:0; border-radius:8px; background:transparent; text-align:left; padding:0 12px; font:inherit; color:#4d4d4a; cursor:pointer; }
    nav button.active, .task.active { background:#fff; color:var(--ink); box-shadow:0 1px 0 rgba(0,0,0,.04); }
    .projects { margin-top:auto; display:grid; gap:8px; }
    .task { border:1px solid transparent; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    main { padding:22px 26px; overflow:auto; }
    .topbar { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:28px; }
    .model { border:1px solid var(--line); background:white; border-radius:999px; padding:9px 12px; color:#4b4b48; }
    .chat { max-width:780px; margin:0 auto; display:grid; gap:18px; }
    h1 { font-size:34px; letter-spacing:0; margin:8px 0 0; }
    .msg { display:grid; gap:8px; }
    .bubble { width:fit-content; max-width:72ch; border:1px solid var(--line); border-radius:8px; padding:14px 16px; background:white; line-height:1.55; }
    .bubble.user { margin-left:auto; background:#f5f5f2; }
    .agent-row { display:flex; align-items:center; gap:9px; color:#555; font-weight:700; }
    .composer { position:sticky; bottom:0; background:linear-gradient(180deg, rgba(247,247,244,0), var(--bg) 35%); padding-top:60px; }
    form { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:10px; border:1px solid var(--line); background:white; border-radius:18px; padding:12px; box-shadow:0 18px 50px rgba(30,30,25,.08); }
    input, select, textarea { border:1px solid var(--line); border-radius:8px; padding:11px 12px; font:inherit; background:#fff; }
    input { border:0; outline:0; }
    button.icon, button.send { width:42px; height:42px; border-radius:50%; border:1px solid var(--line); background:#fff; cursor:pointer; }
    button.send { background:#111; color:#fff; }
    .computer { border-left:1px solid var(--line); background:#fbfbf8; padding:18px; display:grid; grid-template-rows:auto auto 1fr; gap:14px; }
    .computer-card { border:1px solid var(--line); background:white; border-radius:8px; overflow:hidden; min-height:360px; display:grid; grid-template-rows:auto 1fr auto; }
    .computer-head { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); }
    .screen { background:#242424; color:#d8f8e7; padding:16px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; display:grid; align-content:start; gap:8px; }
    .timeline { background:#f4f4f0; border-top:1px solid var(--line); padding:12px; display:grid; gap:8px; }
    .step { display:flex; gap:9px; align-items:center; color:#555; }
    .dot { width:9px; height:9px; border-radius:50%; background:var(--accent); }
    .settings { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .card { background:white; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .card h2 { margin:0 0 10px; font-size:16px; }
    label { display:grid; gap:6px; color:#555; font-size:13px; margin-bottom:10px; }
    .profile textarea { width:100%; min-height:86px; resize:vertical; }
    @media (max-width: 1050px) { .app { grid-template-columns:74px 1fr; } aside { align-items:center; } aside span.label, .projects, .computer { display:none; } nav button { text-align:center; padding:0; } }
    @media (max-width: 720px) { .app { grid-template-columns:1fr; } aside { display:none; } main { padding:16px; } .settings { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="brand"><div class="mark">OC</div><span class="label">OmniCore</span></div>
      <nav aria-label="Main navigation">
        <button class="active">New task</button>
        <button>Agent</button>
        <button>Scheduled</button>
        <button>Search</button>
        <button>Library</button>
      </nav>
      <section class="projects">
        <small>All tasks</small>
        <button class="task active">Manus architecture clone</button>
        <button class="task">Provider setup polish</button>
        <button class="task">Computer-use demo</button>
      </section>
    </aside>
    <main>
      <div class="topbar"><strong>OmniCore 0.1 Lite</strong><span class="model">Model: configurable BYOK</span></div>
      <section class="chat" aria-label="Task Chat">
        <div>
          <small>Agent workspace</small>
          <h1>Task Chat</h1>
        </div>
        <article class="msg">
          <div class="bubble user">Research Manus AI architecture and build a working local clone.</div>
        </article>
        <article class="msg">
          <div class="agent-row"><strong>OmniCore</strong><small>planning + tools</small></div>
          <div class="bubble">I mapped the product into five layers: task gateway, chat runtime, live computer, provider setup, and persistent profile. The prototype now exposes a backend API and a Manus-style workspace UI.</div>
        </article>
        <section class="settings">
          <div class="card">
            <h2>Provider Setup</h2>
            <label>Base URL<input value="https://api.openai.com/v1" /></label>
            <label>Model<select><option>gpt-4.1-mini</option><option>openai-compatible/custom</option></select></label>
          </div>
          <div class="card profile">
            <h2>Agent Profile</h2>
            <label>Name<input value="OmniCore" /></label>
            <textarea>Persistent personal agent with chat, tools, memory, and live computer proof.</textarea>
          </div>
        </section>
        <div class="composer">
          <form id="chatForm">
            <button class="icon" type="button">+</button>
            <input id="prompt" placeholder="Assign a task or ask anything" />
            <button class="send" aria-label="Send">></button>
          </form>
        </div>
      </section>
    </main>
    <section class="computer" aria-label="Live Computer">
      <div class="computer-head"><strong>Live Computer</strong><small id="apiStatus">checking API...</small></div>
      <div class="computer-card">
        <div class="computer-head"><span>Workspace browser</span><small>/api/status</small></div>
        <div class="screen" id="screen">
          <span>$ research Manus AI architecture</span>
          <span>$ create frontend workspace</span>
          <span>$ create backend API</span>
        </div>
        <div class="timeline" aria-label="Progress Timeline">
          <strong>Progress Timeline</strong>
          <div class="step"><span class="dot"></span>Research UI and architecture</div>
          <div class="step"><span class="dot"></span>Build backend + frontend</div>
          <div class="step"><span class="dot"></span>Verify files and API</div>
        </div>
      </div>
    </section>
  </div>
  <script>
    const screen = document.querySelector("#screen");
    const status = document.querySelector("#apiStatus");
    const form = document.querySelector("#chatForm");
    const prompt = document.querySelector("#prompt");
    async function refreshStatus() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        status.textContent = data.ok ? "API online" : "API degraded";
      } catch {
        status.textContent = "static preview";
      }
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = prompt.value.trim();
      if (!text) return;
      screen.insertAdjacentHTML("beforeend", "<span>$ task: " + text.replace(/[<>]/g, "") + "</span>");
      prompt.value = "";
      try {
        const res = await fetch("/api/chat", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ message:text }) });
        const data = await res.json();
        screen.insertAdjacentHTML("beforeend", "<span>" + data.reply.replace(/[<>]/g, "") + "</span>");
      } catch {
        screen.insertAdjacentHTML("beforeend", "<span>Queued locally. Start server.js for backend replies.</span>");
      }
    });
    refreshStatus();
  </script>
</body>
</html>
`,
    };
  }

  buildGeneratedAppManifest(message = "", artifact = {}) {
    const spec = this.extractGeneratedAppSpec(message);
    const artifactPath = String(artifact.path || spec.path || "data/generated/index.html");
    const manifestPath = artifactPath.replace(/[^/\\]+\.html?$/i, "manifest.json");
    return {
      path: manifestPath === artifactPath ? "data/generated/manifest.json" : manifestPath,
      content: JSON.stringify({
        app: spec.title || "Generated web app",
        kind: spec.kind || "custom",
        sourceRequest: String(message || ""),
        artifactPath,
        features: spec.requestedFeatures || [],
        verification: {
          requiredText: artifact.requiredText || [],
          forbiddenText: artifact.forbiddenText || [],
          minBytes: artifact.minBytes || 1200,
        },
        generatedAt: new Date().toISOString(),
      }, null, 2),
    };
  }

  extractGeneratedAppSpec(message = "") {
    const text = String(message || "");
    const lower = text.toLowerCase();
    const pathMatch = text.match(/\b(?:save|as|called|named|to|in|inside)\s+([A-Za-z0-9._\/\\-]+\.html)\b/i);
    const folderMatch = text.match(/(data[\/\\]generated[\/\\][A-Za-z0-9._\/\\-]+)/i)
      || text.match(/\b(?:in|inside|to)\s+([A-Za-z0-9._\/\\-]+\/)\b/i);
    const kind = lower.includes("omnicore") || /\bmanus\b/i.test(text)
      ? "omnicore"
      : lower.includes("calculator")
      ? "calculator"
      : lower.includes("todo") || lower.includes("to-do")
        ? "todo"
        : lower.includes("fitness") || lower.includes("workout") || lower.includes("calories") || lower.includes("macros")
          ? "fitness"
          : lower.includes("clock") || /\btime\b/.test(lower)
            ? "clock"
            : lower.includes("finance") || lower.includes("budget") || lower.includes("expense")
              ? "finance"
              : lower.includes("travel") || lower.includes("trip") || lower.includes("itinerary") || lower.includes("destination") || lower.includes("flight") || lower.includes("hotel")
                ? "travel"
                : lower.includes("food") || lower.includes("restaurant") || lower.includes("recipe")
                  ? "food"
                  : lower.includes("website") || lower.includes("web app") || lower.includes("app")
                    ? "app"
                    : "";
    const defaultFolder = kind === "fitness"
      ? "data/generated/fitness-app"
      : kind === "omnicore"
        ? "data/generated/omnicore"
        : "data/generated";
    const path = pathMatch?.[1]
      || (folderMatch?.[1] ? `${folderMatch[1].replace(/[\\/]?$/, "/")}index.html` : "")
      || `${defaultFolder}/index.html`;
    const extractedTitle = this.extractGeneratedAppTitle(text);
    const title = extractedTitle || (kind === "calculator"
      ? "OmniClaw Calculator"
      : kind === "todo"
        ? "OmniClaw Todo"
        : kind === "fitness"
          ? "PulseFit Tracker"
          : kind === "omnicore"
            ? "OmniCore"
          : kind === "clock"
            ? "OmniClaw Clock"
            : kind === "finance"
              ? "LedgerFlow Dashboard"
              : kind === "travel"
              ? "TripForge Planner"
              : kind === "food"
                  ? "Mango Table"
                  : kind
                    ? this.titleFromMessage(text)
                    : "");
    const requestedFeatures = this.extractRequestedFeatures(text, kind);
    return { text, lower, kind, path, title, requestedFeatures };
  }

  extractGeneratedAppTitle(message = "") {
    const text = String(message || "");
    const patterns = [
      /\b(?:brand|brand\/name|name|naam|title)\s*[:=-]\s*([A-Za-z0-9][A-Za-z0-9 &'.-]{1,70})/i,
      /\b(?:for|called|named)\s+["']([^"']{2,70})["']/i,
      /\b["']([^"']{2,70})["']\s+(?:website|web app|app|dashboard|site)\b/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const title = match[1]
          .replace(/\b(?:cuisine|include|deliverable|create|folder|modern|responsive)\b.*$/i, "")
          .replace(/[.,;]+$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (title && !/\b(?:website|web app|app|html|css|javascript|folder|data)\b/i.test(title)) {
          return title.split(/\s+/).slice(0, 5).map((word) =>
            /^[A-Z0-9&'.-]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
          ).join(" ");
        }
      }
    }
    return "";
  }

  titleFromMessage(message = "") {
    const text = String(message || "")
      .replace(/\b(build|create|make|develop|frontend-only|frontend|website|web app|app|html|css|javascript|js|artifact|working|polished)\b/gi, " ")
      .replace(/\b(in|inside|to|with|and|no backend|backend)\b/gi, " ")
      .replace(/\bdata[\/\\]generated[\/\\][A-Za-z0-9._\/\\-]+/gi, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = text.split(/\s+/).filter((word) => word.length > 2).slice(0, 4);
    if (!words.length) return "OmniClaw App";
    return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  }

  extractRequestedFeatures(message = "", kind = "") {
    const featureMap = [
      ["dashboard", "Dashboard"],
      ["workout", "Workout plan"],
      ["calories", "Calorie tracking"],
      ["macro", "Macro goals"],
      ["progress", "Progress chart"],
      ["chart", "Progress chart"],
      ["responsive", "Responsive layout"],
      ["mobile", "Mobile layout"],
      ["form", "Quick entry form"],
      ["search", "Search"],
      ["filter", "Filters"],
      ["analytics", "Analytics"],
      ["profile", "Profile"],
      ["calendar", "Calendar"],
      ["task", "Task board"],
      ["habit", "Habit tracker"],
      ["budget", "Budget summary"],
      ["expense", "Expense log"],
      ["booking", "Booking flow"],
      ["recipe", "Recipe cards"],
      ["menu", "Menu highlights"],
      ["chef", "Chef story"],
      ["story", "Story section"],
      ["gallery", "Gallery"],
      ["ambience", "Ambience gallery"],
      ["reservation", "Reservation form"],
      ["opening", "Opening hours"],
      ["hours", "Opening hours"],
      ["location", "Location"],
      ["contact", "Contact"],
    ];
    const lower = String(message || "").toLowerCase();
    const features = featureMap.filter(([key]) => lower.includes(key)).map(([, label]) => label);
    if (kind === "fitness") {
      features.push("Daily readiness", "Workout plan", "Calories and macros", "Weekly progress", "Quick workout log");
    }
    if (kind === "omnicore") {
      features.push(
        "Manus-style left sidebar",
        "Task chat",
        "Live computer panel",
        "Provider setup",
        "Agent profile settings",
        "Task progress timeline",
        "Backend API",
      );
    }
    if (kind === "food") {
      features.push("Hero section", "Menu highlights", "Chef story", "Gallery", "Reservation form", "Opening hours", "Location and contact");
    }
    const unique = [...new Set(features)];
    return unique.length ? unique.slice(0, 8) : ["Dashboard", "Interactive form", "Progress indicators", "Responsive layout"];
  }

  buildGeneratedAppPlan(message, artifact) {
    const spec = this.extractGeneratedAppSpec(message);
    return [
      "# Build Plan",
      "",
      `Request: ${message}`,
      "",
      `Target: ${artifact?.path || spec.path}`,
      `App: ${spec.title || "Generated web app"} (${spec.kind || "custom"})`,
      "",
      "Implementation:",
      artifact?.extraFiles?.length
        ? "- Create a frontend project with separate HTML, CSS, and JavaScript files."
        : "- Create a self-contained frontend artifact with HTML, CSS, and JavaScript.",
      `- Include requested feature areas: ${spec.requestedFeatures.join(", ")}.`,
      "- Add at least one real interactive control.",
      "- Keep the layout responsive for mobile and desktop.",
      "- Verify with the HTML artifact checker before claiming completion.",
      "",
    ].join("\n");
  }

  buildProjectWebArtifact(spec = {}) {
    const folder = String(spec.path || "data/generated/index.html")
      .replace(/[^/\\]+\.html?$/i, "")
      .replace(/[\\/]?$/, "/") || "data/generated/";
    const path = `${folder}index.html`;
    const cssPath = `${folder}styles.css`;
    const jsPath = `${folder}app.js`;
    const title = spec.title || this.titleFromMessage(spec.text || "") || "OmniClaw App";
    const content = this.buildProjectWebHtml(spec, { cssPath, jsPath });
    const css = this.buildProjectWebCss(spec);
    const js = this.buildProjectWebJs(spec);
    const required = [
      title,
      ...(spec.requestedFeatures || []).slice(0, 6),
      spec.kind === "food" ? "Reserve a table" : "Get Started",
      "styles.css",
      "app.js",
    ].filter(Boolean);
    return {
      path,
      requiredText: required,
      forbiddenText: ["FreshTable Studio", "OmniClaw Web App", "Command Center"],
      minBytes: 2400,
      extraFiles: [
        { path: cssPath, content: css },
        { path: jsPath, content: js },
      ],
      content,
    };
  }

  buildProjectWebHtml(spec = {}, files = {}) {
    const title = spec.title || "OmniClaw App";
    const kind = spec.kind || "app";
    const features = (spec.requestedFeatures || []).slice(0, 8);
    const cssHref = String(files.cssPath || "styles.css").replace(/^.*[\\/]/, "");
    const jsSrc = String(files.jsPath || "app.js").replace(/^.*[\\/]/, "");
    const hero = this.projectHeroCopy(spec);
    const sections = this.projectSections(spec, features);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="${cssHref}" />
</head>
<body data-kind="${kind}">
  <header class="site-header">
    <a class="brand" href="#top" aria-label="${title} home">
      <span class="brand-mark">${title.split(/\s+/).slice(0, 2).map((word) => word[0] || "").join("").toUpperCase()}</span>
      <span>${title}</span>
    </a>
    <nav aria-label="Primary navigation">
      ${sections.map((section) => `<a href="#${section.id}">${section.nav}</a>`).join("\n      ")}
    </nav>
  </header>
  <main id="top">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">${hero.eyebrow}</p>
        <h1>${hero.heading}</h1>
        <p>${hero.body}</p>
        <div class="hero-actions">
          <a class="button primary" href="#${kind === "food" ? "reservations" : sections[0]?.id || "features"}">${kind === "food" ? "Reserve a table" : "Get Started"}</a>
          <a class="button ghost" href="#${kind === "food" ? "menu" : "features"}">${kind === "food" ? "View menu" : "Explore"}</a>
        </div>
      </div>
      <div class="hero-visual" aria-label="${title} visual preview">
        <div class="visual-card large"></div>
        <div class="visual-card small"></div>
        <div class="visual-note">${hero.note}</div>
      </div>
    </section>
    ${sections.map((section) => section.html).join("\n    ")}
  </main>
  <footer>
    <strong>${title}</strong>
    <span>Built as a local OmniClaw artifact with index.html, styles.css, and app.js.</span>
  </footer>
  <script src="${jsSrc}"></script>
</body>
</html>
`;
  }

  projectHeroCopy(spec = {}) {
    const title = spec.title || "OmniClaw App";
    if (spec.kind === "food") {
      return {
        eyebrow: "Modern Indian fusion",
        heading: `${title} brings fire, spice, and calm hospitality together.`,
        body: "A polished restaurant experience with menu highlights, ambience, reservations, hours, and contact details ready to open directly in the browser.",
        note: "Signature tasting menu",
      };
    }
    if (spec.kind === "travel") {
      return {
        eyebrow: "Trip planning workspace",
        heading: `${title} turns scattered travel ideas into a clear itinerary.`,
        body: "Compare destinations, save notes, and shape a responsive client-side trip planner with no backend required.",
        note: "Live itinerary board",
      };
    }
    if (spec.kind === "finance") {
      return {
        eyebrow: "Financial command view",
        heading: `${title} makes spending and priorities easier to scan.`,
        body: "A clean dashboard-style experience with summaries, filters, and quick client-side interactions.",
        note: "Budget health",
      };
    }
    return {
      eyebrow: "Custom web experience",
      heading: `${title} is ready as a polished local website.`,
      body: "Responsive layout, feature sections, and real JavaScript interactions are wired into separate project files.",
      note: "Interactive build",
    };
  }

  projectSections(spec = {}, features = []) {
    const title = spec.title || "OmniClaw App";
    if (spec.kind === "food") {
      return [
        {
          id: "menu",
          nav: "Menu",
          html: `<section id="menu" class="section">
      <div class="section-head"><p class="eyebrow">Menu highlights</p><h2>Modern Indian plates built for sharing.</h2></div>
      <div class="menu-controls" role="group" aria-label="Menu filters">
        <button class="chip active" data-filter="all">All</button>
        <button class="chip" data-filter="veg">Veg</button>
        <button class="chip" data-filter="grill">Grill</button>
        <button class="chip" data-filter="dessert">Dessert</button>
      </div>
      <div class="menu-grid">
        <article class="menu-card" data-category="veg"><span>Veg</span><h3>Paneer Pepper Leaf</h3><p>Charred paneer, curry leaf butter, smoked tomato chutney.</p><strong>Rs 420</strong></article>
        <article class="menu-card" data-category="grill"><span>Grill</span><h3>Tandoori Citrus Prawns</h3><p>Bright lime, roasted garlic, fennel pollen, crisp onions.</p><strong>Rs 680</strong></article>
        <article class="menu-card" data-category="veg"><span>Veg</span><h3>Millet Khichdi Risotto</h3><p>Little millet, black garlic, mushroom dust, pickled chilli.</p><strong>Rs 390</strong></article>
        <article class="menu-card" data-category="dessert"><span>Dessert</span><h3>Saffron Cloud Kulfi</h3><p>Cardamom cream, pistachio crumb, rose syrup.</p><strong>Rs 310</strong></article>
      </div>
    </section>`,
        },
        {
          id: "story",
          nav: "Story",
          html: `<section id="story" class="section split">
      <div><p class="eyebrow">Chef story</p><h2>A kitchen that treats tradition like a living ingredient.</h2><p>${title} pairs familiar Indian comfort with sharp plating, seasonal produce, and a dining room made for long conversations.</p></div>
      <div class="quote-card">"Every plate should feel rooted, generous, and a little surprising."</div>
    </section>`,
        },
        {
          id: "gallery",
          nav: "Gallery",
          html: `<section id="gallery" class="section">
      <div class="section-head"><p class="eyebrow">Ambience gallery</p><h2>Warm light, open tables, confident details.</h2></div>
      <div class="gallery"><div></div><div></div><div></div><div></div></div>
    </section>`,
        },
        {
          id: "reservations",
          nav: "Reserve",
          html: `<section id="reservations" class="section split">
      <form class="reservation-form" id="reservationForm">
        <p class="eyebrow">Reservation form</p>
        <h2>Reserve a table</h2>
        <input name="name" placeholder="Name" required />
        <input name="date" type="date" required />
        <select name="guests" required><option value="">Guests</option><option>2 guests</option><option>4 guests</option><option>6 guests</option></select>
        <button class="button primary" type="submit">Book table</button>
        <p id="reservationStatus" class="form-status" role="status"></p>
      </form>
      <div class="info-card"><h3>Opening hours</h3><p>Tue to Sun: 12:00 PM - 11:30 PM</p><h3>Location and contact</h3><p>MG Road, Indore<br />hello@mankushbistro.local<br />+91 98765 43210</p></div>
    </section>`,
        },
      ];
    }
    const cards = (features.length ? features : ["Responsive layout", "Interactive form", "Feature cards", "Local state"]).map((feature, index) =>
      `<article class="feature-card"><span>0${index + 1}</span><h3>${feature}</h3><p>${this.featureDescription(feature)}</p></article>`,
    ).join("");
    return [
      {
        id: "features",
        nav: "Features",
        html: `<section id="features" class="section"><div class="section-head"><p class="eyebrow">Feature set</p><h2>Everything requested, shaped into visible UI.</h2></div><div class="feature-grid">${cards}</div></section>`,
      },
      {
        id: "workspace",
        nav: "Workspace",
        html: `<section id="workspace" class="section split"><div><p class="eyebrow">Interactive workspace</p><h2>Add, track, and clear local items.</h2><p>The form below proves JavaScript is connected and local state updates without a backend.</p></div><form id="quickForm" class="reservation-form"><input id="quickInput" placeholder="Add an item" /><button class="button primary">Add item</button><p id="reservationStatus" class="form-status"></p><ul id="quickList"></ul></form></section>`,
      },
    ];
  }

  buildProjectWebCss(spec = {}) {
    const food = spec.kind === "food";
    return `:root {
  --ink: #171513;
  --muted: #6f6861;
  --paper: #fffaf2;
  --card: #ffffff;
  --line: #eadfce;
  --brand: ${food ? "#8c2f20" : "#245f4f"};
  --accent: ${food ? "#e4ad59" : "#92e6bd"};
  --deep: ${food ? "#25130f" : "#101715"};
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; color: var(--ink); background: var(--paper); }
.site-header { position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px min(5vw, 56px); background: rgba(255,250,242,.9); backdrop-filter: blur(16px); border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; font-weight: 850; }
.brand-mark { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 8px; background: var(--deep); color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 10px; }
nav a { color: var(--muted); text-decoration: none; font-size: 14px; }
nav a:hover { color: var(--brand); }
main { width: min(1180px, calc(100vw - 28px)); margin: 0 auto; }
.hero { min-height: 78vh; display: grid; grid-template-columns: 1.05fr .95fr; gap: 26px; align-items: center; padding: 40px 0 28px; }
.eyebrow { color: var(--brand); text-transform: uppercase; font-size: 12px; font-weight: 850; letter-spacing: .12em; }
h1 { margin: 0; font-size: clamp(42px, 7vw, 82px); line-height: .96; letter-spacing: 0; max-width: 11ch; }
h2 { margin: 0; font-size: clamp(28px, 4vw, 48px); line-height: 1.04; letter-spacing: 0; }
h3 { margin: 0 0 8px; }
p { color: var(--muted); line-height: 1.65; }
.hero-copy > p:not(.eyebrow) { max-width: 58ch; font-size: 18px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 24px; }
.button { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; padding: 0 18px; text-decoration: none; border: 1px solid var(--deep); font-weight: 800; cursor: pointer; }
.button.primary { color: white; background: var(--deep); }
.button.ghost { color: var(--deep); background: transparent; }
.hero-visual { min-height: 470px; position: relative; border-radius: 8px; overflow: hidden; background: radial-gradient(circle at 20% 20%, var(--accent), transparent 28%), linear-gradient(135deg, var(--deep), var(--brand)); box-shadow: 0 30px 80px rgba(54,30,18,.24); }
.visual-card { position: absolute; border: 1px solid rgba(255,255,255,.28); border-radius: 8px; background: rgba(255,255,255,.14); backdrop-filter: blur(8px); }
.visual-card.large { width: 62%; height: 52%; right: 8%; top: 12%; }
.visual-card.small { width: 34%; height: 28%; left: 10%; bottom: 13%; }
.visual-note { position: absolute; left: 24px; bottom: 24px; color: white; font-weight: 850; }
.section { padding: 54px 0; border-top: 1px solid var(--line); }
.section-head { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 20px; }
.section-head h2 { max-width: 720px; }
.split { display: grid; grid-template-columns: .9fr 1.1fr; gap: 26px; align-items: center; }
.menu-controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
.chip { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 999px; padding: 10px 14px; cursor: pointer; }
.chip.active { background: var(--deep); color: white; border-color: var(--deep); }
.menu-grid, .feature-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.menu-card, .feature-card, .quote-card, .info-card, .reservation-form { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 14px 44px rgba(55, 38, 20, .08); }
.menu-card span, .feature-card span { color: var(--brand); font-weight: 850; font-size: 12px; text-transform: uppercase; }
.menu-card strong { display: block; margin-top: 12px; }
.gallery { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 12px; min-height: 300px; }
.gallery div { border-radius: 8px; background: linear-gradient(135deg, rgba(140,47,32,.9), rgba(228,173,89,.72)); }
.gallery div:first-child { grid-row: span 2; }
.reservation-form { display: grid; gap: 12px; }
input, select { min-height: 44px; border-radius: 8px; border: 1px solid var(--line); padding: 0 12px; font: inherit; background: #fff; }
.form-status { min-height: 24px; margin: 0; font-weight: 750; color: var(--brand); }
#quickList { margin: 0; padding-left: 18px; }
footer { width: min(1180px, calc(100vw - 28px)); margin: 0 auto; padding: 28px 0 40px; color: var(--muted); display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid var(--line); }
@media (max-width: 900px) {
  .site-header, footer { align-items: flex-start; flex-direction: column; }
  .hero, .split { grid-template-columns: 1fr; }
  .hero { min-height: auto; }
  .hero-visual { min-height: 340px; }
  .menu-grid, .feature-grid, .gallery { grid-template-columns: 1fr; }
  h1 { max-width: 100%; }
}
`;
  }

  buildProjectWebJs(spec = {}) {
    if (spec.kind === "food") {
      return `const chips = document.querySelectorAll("[data-filter]");
const cards = document.querySelectorAll(".menu-card");
chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    chips.forEach((item) => item.classList.remove("active"));
    chip.classList.add("active");
    const filter = chip.dataset.filter;
    cards.forEach((card) => {
      card.hidden = filter !== "all" && card.dataset.category !== filter;
    });
  });
});

const reservationForm = document.querySelector("#reservationForm");
const reservationStatus = document.querySelector("#reservationStatus");
if (reservationForm) {
  reservationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(reservationForm);
    const name = String(data.get("name") || "").trim();
    const date = String(data.get("date") || "").trim();
    const guests = String(data.get("guests") || "").trim();
    if (!name || !date || !guests) {
      reservationStatus.textContent = "Please complete every field.";
      return;
    }
    reservationStatus.textContent = "Table request saved for " + name + " on " + date + " for " + guests + ".";
    reservationForm.reset();
  });
}
`;
    }
    return `const form = document.querySelector("#quickForm");
const input = document.querySelector("#quickInput");
const list = document.querySelector("#quickList");
const status = document.querySelector("#reservationStatus");
const storageKey = "omniclawProjectItems";
let items = JSON.parse(localStorage.getItem(storageKey) || "[]");

function render() {
  if (!list) return;
  list.innerHTML = items.map((item, index) => '<li><button type="button" data-remove="' + index + '">Remove</button> ' + item + '</li>').join("");
  localStorage.setItem(storageKey, JSON.stringify(items));
}

if (form) {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      status.textContent = "Add a real item first.";
      return;
    }
    items.push(value);
    input.value = "";
    status.textContent = "Saved " + value + ".";
    render();
  });
}

if (list) {
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    items.splice(Number(button.dataset.remove), 1);
    render();
  });
}

render();
`;
  }

  buildGenericWebAppHtml(spec = {}) {
    const title = spec.title || "OmniClaw App";
    const features = (spec.requestedFeatures || []).slice(0, 6);
    const featureCards = features.map((feature, index) => `
        <article class="feature">
          <span>0${index + 1}</span>
          <strong>${feature}</strong>
          <p>${this.featureDescription(feature)}</p>
        </article>`).join("");
    const chartBars = [52, 76, 61, 88, 67, 93, 74]
      .map((height, index) => `<div class="bar"><i style="--h:${height}%"></i><span>${["M", "T", "W", "T", "F", "S", "S"][index]}</span></div>`)
      .join("");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { --ink:#171817; --muted:#68706b; --line:#dce4df; --brand:#245f4f; --accent:#9ef0c1; --soft:#f4f8f5; font-family:Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--soft); color:var(--ink); }
    main { width:min(1160px, calc(100vw - 28px)); margin:0 auto; padding:24px 0 34px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:18px; padding-bottom:18px; }
    h1 { font-size:clamp(30px, 5vw, 58px); margin:0; letter-spacing:0; }
    p { color:var(--muted); line-height:1.55; }
    .pill { border:1px solid var(--line); background:white; border-radius:999px; padding:10px 14px; }
    .hero, .grid { display:grid; grid-template-columns:1.25fr .75fr; gap:16px; }
    .card, .feature { background:white; border:1px solid var(--line); border-radius:8px; padding:20px; box-shadow:0 12px 38px rgba(31,57,45,.08); }
    .hero .card:first-child { background:linear-gradient(135deg, #12241d, var(--brand)); color:white; }
    .hero .card:first-child p { color:#d9f8e7; }
    .metrics { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:20px; }
    .metric { background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.2); border-radius:8px; padding:14px; }
    .metric strong { display:block; font-size:28px; }
    .features { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:16px; }
    .feature span { color:var(--brand); font-weight:800; }
    .feature strong { display:block; margin:8px 0; }
    .chart { height:210px; display:flex; align-items:end; gap:10px; }
    .bar { flex:1; display:grid; gap:8px; text-align:center; color:var(--muted); font-size:12px; }
    .bar i { display:block; height:var(--h); min-height:18px; background:linear-gradient(180deg, var(--accent), var(--brand)); border-radius:8px 8px 2px 2px; }
    form { display:grid; grid-template-columns:1fr auto; gap:10px; margin-top:14px; }
    input, button { min-height:44px; border-radius:8px; border:1px solid var(--line); padding:0 12px; font:inherit; }
    button { background:#111a16; color:white; cursor:pointer; }
    ul { padding:0; list-style:none; display:grid; gap:8px; }
    li { display:flex; justify-content:space-between; gap:10px; padding:10px 12px; background:#f9fbfa; border:1px solid var(--line); border-radius:8px; }
    @media (max-width: 820px) { header, .hero, .grid { grid-template-columns:1fr; flex-direction:column; align-items:flex-start; } .features, .metrics, form { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header><h1>${title}</h1><span class="pill">Frontend only</span></header>
    <section class="hero">
      <article class="card">
        <h2>Command Center</h2>
        <p>Built from the requested brief as a working client-side app with responsive layout, real controls, and visible proof sections.</p>
        <div class="metrics">
          <div class="metric"><span>Focus</span><strong>${features.length}</strong></div>
          <div class="metric"><span>Status</span><strong>Live</strong></div>
          <div class="metric"><span>Mode</span><strong>JS</strong></div>
        </div>
      </article>
      <article class="card">
        <h2>Progress</h2>
        <div class="chart" aria-label="Progress chart">${chartBars}</div>
      </article>
    </section>
    <section class="features">${featureCards}</section>
    <section class="grid" style="margin-top:16px">
      <article class="card">
        <h2>Quick Add</h2>
        <form id="entryForm"><input id="entryInput" placeholder="Add an item" /><button>Add</button></form>
        <ul id="entries"></ul>
      </article>
      <article class="card">
        <h2>Session Notes</h2>
        <p id="status">Ready for local-only use. No backend required.</p>
        <button id="complete">Mark complete</button>
      </article>
    </section>
  </main>
  <script>
    const form = document.querySelector("#entryForm");
    const input = document.querySelector("#entryInput");
    const entries = document.querySelector("#entries");
    const status = document.querySelector("#status");
    const items = JSON.parse(localStorage.omniclawGeneratedItems || "[]");
    function render() {
      entries.innerHTML = items.map((item, index) => '<li><span>' + item + '</span><button data-remove="' + index + '">Remove</button></li>').join("");
      localStorage.omniclawGeneratedItems = JSON.stringify(items);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      items.push(value);
      input.value = "";
      render();
    });
    entries.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      items.splice(Number(button.dataset.remove), 1);
      render();
    });
    document.querySelector("#complete").addEventListener("click", () => {
      status.textContent = "Marked complete at " + new Date().toLocaleTimeString();
    });
    if (${spec.kind === "clock"}) setInterval(() => status.textContent = new Date().toLocaleTimeString(), 1000);
    render();
  </script>
</body>
</html>
`;
  }

  featureDescription(feature = "") {
    const key = String(feature).toLowerCase();
    if (key.includes("dashboard")) return "High-level overview for quick scanning.";
    if (key.includes("chart") || key.includes("progress")) return "Visual progress feedback without a backend.";
    if (key.includes("form") || key.includes("entry")) return "Local client-side input and list management.";
    if (key.includes("mobile") || key.includes("responsive")) return "Layout adapts cleanly on small screens.";
    if (key.includes("macro") || key.includes("calorie")) return "Nutrition targets presented as readable progress bars.";
    if (key.includes("workout")) return "Training blocks are organized into repeatable actions.";
    return "A requested feature translated into a visible app section.";
  }

  extractComputerSearchQuery(message) {
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) {
      return quoted[1].trim();
    }

    const raw = String(message || "");
    const targetFileMatch =
      raw.match(/\bkoi\s+([a-zA-Z0-9._ -]{2,80}?)\s+(?:ki\s+)?(?:file|folder)\b/i) ||
      raw.match(/\b([a-zA-Z0-9._-]{2,80})\s+(?:ki\s+)?(?:file|folder)\b/i);
    if (targetFileMatch?.[1]) {
      return targetFileMatch[1].trim();
    }

    return raw
      .replace(/search file|find file|search laptop|search computer|laptop ki files|puri laptop ki files|pura laptop|puri laptop/gi, "")
      .replace(/\b(file|folder|naam|name|dhund|dhoond|search|find|check|cheack|dekh|dakh|kar|karo|mara|mera|mere|meri|par|ha|hai|koi|ki|ka|ke|laptop|computer|pc|me|mein|ma)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() || "omniclaw";
  }

  extractDelegationRequest(message) {
    const agentId = this.extractDelegationAgent(message);
    const task = this.extractDelegationTask(message);
    return {
      agentId,
      task,
    };
  }

  extractDelegationAgent(message) {
    const lowered = String(message || "").toLowerCase();
    const targetPatterns = [
      { id: "research", patterns: [/\b(?:to|ko|se)\s+(?:the\s+)?(?:research|researcher|reasearch)\b/i, /\b(?:research|researcher|reasearch)\s+(?:agent|ko|se)\b/i] },
      { id: "builder", patterns: [/\b(?:to|ko|se)\s+(?:the\s+)?(?:builder|build|coder|coding|developer|dev)\b/i, /\b(?:builder|build|coder|coding|developer|dev)\s+(?:agent|ko|se)\b/i] },
      { id: "ops", patterns: [/\b(?:to|ko|se)\s+(?:the\s+)?(?:ops|operator|system|shell|terminal|host)\b/i, /\b(?:ops|operator|system|shell|terminal|host)\s+(?:agent|ko|se)\b/i] },
      { id: "main", patterns: [/\b(?:to|ko|se)\s+(?:the\s+)?(?:main|primary|default)\b/i, /\b(?:main|primary|default)\s+(?:agent|ko|se)\b/i] },
    ];

    for (const item of targetPatterns) {
      if (item.patterns.some((pattern) => pattern.test(message))) {
        return item.id;
      }
    }

    if (/\b(?:build|builder|banao|bnao|banwa|fix|code|implement|ui|frontend|backend)\b/i.test(lowered)) {
      return "builder";
    }
    if (/\b(?:ops|operator|shell|terminal|process|system|monitor|windows|host)\b/i.test(lowered)) {
      return "ops";
    }
    if (/\b(?:research|researcher|reasearch|search|study|investigate|padh|dhund|find)\b/i.test(lowered)) {
      return "research";
    }

    return "research";
  }

  extractDelegationTask(message) {
    const text = String(message || "").trim();
    const quoted = text.match(/["']([^"']+)["']/);
    if (quoted) {
      return quoted[1].trim();
    }

    const patterns = [
      /(?:delegate|handoff|hand off|assign|route|send|bhej|bhejo|de do|karwao|karwa|banwao|banwa)[^:]*:\s*(.+)$/i,
      /(?:delegate|handoff|hand off|assign|route|send)\s+(?:this|ye|isko|task)?\s*(?:to\s+)?(?:the\s+)?(?:research|researcher|reasearch|builder|build|coder|coding|developer|dev|ops|operator|system|shell|terminal|main|primary|default)(?:\s+agent)?\s*(?:to|for)?\s*(.+)$/i,
      /(?:research|researcher|reasearch|builder|build|coder|coding|developer|dev|ops|operator|system|shell|terminal|main|primary|default)(?:\s+agent)?\s*(?:ko|se)\s*(.+)$/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return this.cleanupDelegationTask(match[1]) || text;
      }
    }

    return this.cleanupDelegationTask(text) || text;
  }

  cleanupDelegationTask(text) {
    return String(text || "")
      .replace(/^(?:ye|this|isko|isse|usko|task|kaam)\s+/i, "")
      .replace(/^(?:task|kaam)\s+(?:do|de|bhejo|bhej|karwao|karwa|handle|run)\s*/i, "")
      .replace(/^(?:do|de|bhejo|bhej|karwao|karwa|handle|run)\s*/i, "")
      .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
      .trim();
  }

  extractTaskId(message) {
    const match = message.match(/task_[a-zA-Z0-9_-]+/);
    return match ? match[0] : "";
  }

  buildTaskBlueprintInput({ title = "", message = "" } = {}) {
    const text = `${title} ${message}`.toLowerCase();
    const taskType = /build|code|implement|app|website|feature|fix|debug/.test(text)
      ? "build"
      : /research|search|study|compare|analyse|analyze/.test(text)
        ? "research"
        : /browser|form|fill|login|website|open/.test(text)
          ? "browser"
          : /schedule|daily|hourly|weekly|every|24\s*hours|monitor|watch/.test(text)
            ? "automation"
            : /file|folder|download|document|pdf/.test(text)
              ? "file"
              : "general";
    return {
      title,
      objective: title,
      sourceMessage: message,
      taskType,
      priority: /urgent|high priority|jaldi|fast|asap/i.test(message) ? "high" : "normal",
      automation: taskType === "automation"
        ? {
            requested: true,
            intervalHint: this.extractIntervalHint(message),
            deliveryHint: this.extractDeliveryHint(message),
          }
        : null,
    };
  }

  extractIntervalHint(message = "") {
    const text = String(message || "");
    if (/\b24\s*hours|daily|roz|har din|every day\b/i.test(text)) return "daily";
    if (/\bhourly|every hour|har ghante\b/i.test(text)) return "hourly";
    if (/\bweekly|every week|har hafte\b/i.test(text)) return "weekly";
    const every = text.match(/\bevery\s+([0-9]+)\s+(minute|minutes|hour|hours|day|days)\b/i);
    return every ? `every ${every[1]} ${every[2]}` : "";
  }

  extractDeliveryHint(message = "") {
    const text = String(message || "").toLowerCase();
    if (text.includes("telegram")) return "telegram";
    if (text.includes("discord")) return "discord";
    if (text.includes("whatsapp")) return "whatsapp";
    if (text.includes("email")) return "email";
    return "webchat";
  }

  extractSkillRequest(message) {
    const quoted = [...message.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    return {
      name: quoted[0] || "Custom Skill",
      triggers: quoted[1]
        ? quoted[1].split(",").map((item) => item.trim()).filter(Boolean)
        : ["custom"],
      description: quoted[2] || "User-created OmniClaw skill.",
      instructions: quoted[3] || "Use this skill when the request matches its triggers.",
    };
  }

  extractRuntimeRequest(message) {
    const lowered = message.toLowerCase();
    const profileMatch = lowered.match(/\b(lite|balanced|power)\b/);
    const providerMode = lowered.includes("openai-compatible")
      ? "openai-compatible"
      : lowered.includes("mock")
        ? "mock"
        : "";
    const modelMatch = message.match(/\bmodel(?:\s+(?:is|=|:)\s*|\s+)([A-Za-z0-9][A-Za-z0-9._:/+-]{1,})/i);

    return {
      profile: profileMatch ? profileMatch[1] : "",
      providerMode,
      model: modelMatch ? modelMatch[1] : "",
    };
  }

  extractProviderSetupRequest(message) {
    const text = String(message || "");
    const lowered = text.toLowerCase();
    const profiles = [
      "openrouter",
      "openai",
      "nvidia",
      "minimax",
      "anthropic",
      "gemini",
      "groq",
      "mistral",
      "deepseek",
      "together",
      "fireworks",
      "ollama",
      "local-compatible",
      "codex-cli",
    ];
    const profileId = profiles.find((profile) => lowered.includes(profile)) || "";
    const keyMatch =
      text.match(/\b(?:api\s*key|apikey|key|token)\s*(?:is|=|:)?\s*([A-Za-z0-9._:/+=-]{12,})/i) ||
      text.match(/\b(sk-[A-Za-z0-9._-]{12,}|sk-or-v1-[A-Za-z0-9._-]{12,}|nvapi-[A-Za-z0-9._-]{12,})\b/i);
    const baseUrlMatch = text.match(/\b(?:base\s*url|endpoint|url)\s*(?:is|=|:)?\s*(https?:\/\/[^\s"'<>]+)/i);
    const modelMatch = text.match(/\bmodel(?:\s+(?:is|=|:)\s*|\s+)([A-Za-z0-9][A-Za-z0-9._:/+-]{1,})/i);
    const mode = lowered.includes("codex-cli")
      ? "codex-cli"
      : profileId || keyMatch || baseUrlMatch || modelMatch
        ? "openai-compatible"
        : "";
    const shouldConfigure = Boolean(profileId || keyMatch || baseUrlMatch || modelMatch);
    return {
      shouldConfigure,
      input: {
        profileId,
        mode,
        apiKey: keyMatch?.[1] || "",
        baseUrl: baseUrlMatch?.[1]?.replace(/[),.]+$/g, "") || "",
        model: modelMatch?.[1]?.replace(/[),.]+$/g, "") || "",
        live: !/\b(?:no live|skip live|skip test|without test|test mat|test nahi)\b/i.test(text),
        fetchModels: /\b(?:fetch models|list models|models fetch|model list)\b/i.test(text),
      },
    };
  }

  extractProviderModelsRequest(message) {
    const lowered = String(message || "").toLowerCase();
    const profiles = [
      "openai",
      "openrouter",
      "nvidia",
      "minimax",
      "anthropic",
      "gemini",
      "groq",
      "mistral",
      "deepseek",
      "together",
      "fireworks",
      "ollama",
      "local-compatible",
      "codex-cli",
    ];
    const profileId = profiles.find((profile) => lowered.includes(profile));
    return profileId ? { profileId } : {};
  }

  extractShellCommand(message) {
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) {
      return quoted[1].trim();
    }
    const prints = String(message || "").match(/\bprints?\s+([A-Za-z0-9._:-]+)\b/i);
    if (prints?.[1]) {
      return `Write-Output "${prints[1]}"`;
    }

    return String(message || "")
      .replace(/^(?:run command|run shell|run terminal|terminal command|powershell command|command chala|cmd chala)\s*/i, "")
      .trim();
  }

  extractPluginEchoMessage(message) {
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) {
      return quoted[1];
    }

    return message.replace(/plugin echo/gi, "").trim() || message;
  }
}
