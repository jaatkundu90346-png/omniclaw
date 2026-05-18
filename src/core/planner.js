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
      steps.push({
        type: "tool",
        tool: "browser_snapshot",
        input: { screenshot: /screenshot|capture/i.test(message) },
        reason: "User asked OmniClaw to inspect the current automated browser page.",
      });
    }
    if (intents.includes("browser-navigate")) {
      const target = this.extractBrowserUrl(message);
      const opensWorkspaceFile = /^(?:file:\/\/|[^:]+\.html?$)/i.test(target) && !/^https?:\/\//i.test(target);
      steps.push({
        type: "tool",
        tool: opensWorkspaceFile ? "open_browser_url" : "browser_navigate",
        input: opensWorkspaceFile ? { path: target } : { url: target },
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

    if (intents.includes("file-write") && !intents.includes("complex-build")) {
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
      steps.push({
        type: "tool",
        tool: "web_research",
        input: { query: this.extractResearchQuery(message) },
        reason: "Research the architecture and implementation pattern for the requested build.",
      });
      steps.push({
        type: "tool",
        tool: "write_file",
        input: {
          path: "data/generated/build_plan.md",
          content: `# Build Plan\n\nRequest: ${message}\n\n- Research architecture\n- Define files to create\n- Implement incrementally\n- Run verification\n`,
        },
        reason: "Create a structured build plan artifact before implementation.",
      });
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
          input: { path: artifact.path },
          reason: "Verify the generated app artifact before claiming the build is complete.",
        });
      }
    }

    if (intents.includes("research-then-build")) {
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

    if (heuristic.steps.some((step) => step.type === "tool")) {
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
    const isComplex = intents.some(i => ["planning", "research", "skill-create"].includes(i)) || 
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
      const response = await provider.complete([
        { role: "system", content: "You are an expert task planner. You output valid JSON." },
        { role: "user", content: prompt }
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
    if (quoted) {
      return quoted[1];
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
    if (quoted) {
      return quoted[1].trim();
    }

    const drivePath = text.match(/[a-zA-Z]:[\\/][^\r\n"']+/);
    if (drivePath) {
      return drivePath[0].trim().replace(/[.。]+$/, "");
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
      message.match(/\b(?:with content|content|containing|write)\s+["']([^"']+)["']/i) ||
      message.match(/\b(?:with content|content|containing)\s+(.+)$/i);

    return {
      path: pathMatch?.[1] || quoted[0] || "data/generated/output.txt",
      content: contentMatch?.[1]?.trim() || quoted[1] || "Generated by OmniClaw.\n",
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
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) {
      return quoted[1];
    }

    const cleaned = String(message || "")
      .replace(/\buse\s+(?:a\s+)?(?:research|researcher|reasearch)\s+agent\s+to\b/gi, "")
      .replace(/\b(do a |perform a |conduct a |make a )?research (on |about |for )?/gi, "")
      .replace(/\b(reasearch|search (the web )?(for |on |about )?|look up |find (on web|information about|info on|info about|out about) )/gi, "")
      .replace(/\b(summarize|summarise|explain|describe|tell me about|give me|show me|list|get)\b/gi, "")
      .replace(/\bweb\b(?=\s*$|\s+(?:sources?|research|search)\b)/gi, "")
      .replace(/\b(karo|kar|kr|karke|karna|de do|batao|bata do|dijiye)\b/gi, "")
      .replace(/\b(ke baare mein|ke bare mein|ke baare me|ke bare me|ka bara ma|ke bara ma|ka bare ma|ke bare ma|ke sath|ke saath|sources? ke sath|sources? ke saath|source ke sath|source ke saath|with sources?|sources?)\b/gi, "")
      .replace(/\b(?:ke|ka|ki)\s+(?:bare|bara|baare)\s+(?:me|mein|ma)\b/gi, "")
      .replace(/\b(?:then|and)\s+(?:summarize|summarise|explain|describe)\s+(?:it|this|that)?\b/gi, "")
      .replace(/\b(?:then|and)\s+(?:it|this|that)\b/gi, "")
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
    const quoted = [...text.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    const append = /\bappend\b/i.test(text);
    const drivePath =
      text.match(/[a-zA-Z]:[\\/][^\r\n"']+?\.(?:txt|html|js|css|json|md|py|ts|csv)\b/i)?.[0] ||
      "";
    const namedPath =
      text.match(/\b(?:called|named|as|to|path|file)\s+([~A-Za-z0-9:._\/\\ -]+\.(?:txt|html|js|css|json|md|py|ts|csv))\b/i)?.[1] ||
      "";
    const path = (drivePath || namedPath || quoted.find((item) => /(?:[a-zA-Z]:[\\/]|[~\/\\]|\.\w+$)/.test(item)) || "").trim();
    const contentMatch =
      text.match(/\b(?:with content|content|containing|write)\s+["']([^"']+)["']/i) ||
      text.match(/\b(?:with content|content|containing)\s+(.+)$/i);
    const content = contentMatch?.[1]?.trim()
      || quoted.find((item) => item !== path)
      || "Generated by OmniClaw.\n";
    return {
      path: path || "~/Documents/omniclaw-output.txt",
      content,
      append,
    };
  }

  buildGeneratedWebArtifact(message = "") {
    const text = String(message || "");
    const lower = text.toLowerCase();
    const pathMatch = text.match(/\b(?:save|as|called|named|to)\s+([A-Za-z0-9._\/\\-]+\.html)\b/i);
    const path = pathMatch?.[1] || "data/generated/index.html";
    const title = lower.includes("calculator")
      ? "OmniClaw Calculator"
      : lower.includes("todo") || lower.includes("to-do")
        ? "OmniClaw Todo"
        : lower.includes("clock") || lower.includes("time")
          ? "OmniClaw Clock"
          : lower.includes("website") || lower.includes("web app") || lower.includes("app")
            ? "OmniClaw Web App"
            : "";
    if (!title) {
      return null;
    }

    if (lower.includes("calculator")) {
      return {
        path,
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

    return {
      path,
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#111; color:#f7f7f2; font-family:Inter, system-ui, sans-serif; }
    main { text-align:center; padding:40px; }
    h1 { font-size:clamp(42px, 8vw, 92px); margin:0 0 18px; letter-spacing:0; }
    p { color:#b8b8b0; font-size:18px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p id="status">Built by OmniClaw</p>
  </main>
  <script>
    const status = document.querySelector("#status");
    if (${lower.includes("clock") || lower.includes("time")}) {
      setInterval(() => status.textContent = new Date().toLocaleTimeString(), 1000);
    }
  </script>
</body>
</html>
`,
    };
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
    const modelMatch = message.match(/model\s+([a-zA-Z0-9._:-]+)/i);

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
    const modelMatch = text.match(/\bmodel\s*(?:is|=|:)?\s*([A-Za-z0-9._:/+-]{2,})/i);
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
