export class Planner {
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

    if (intents.includes("greeting") || intents.includes("api-setup") || intents.includes("capabilities")) {
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

    if (intents.includes("computer-access")) {
      steps.push({
        type: "tool",
        tool: "computer_access_status",
        input: {},
        reason: "User asked to give OmniClaw laptop/computer tools and understand current access policy.",
      });
    }

    if (intents.includes("provider-status")) {
      steps.push({
        type: "tool",
        tool: "provider_status",
        input: { verify: true },
        reason: "User reported provider/model/auth trouble or asked for active brain status.",
      });
    }

    if (intents.includes("capabilities") && !intents.includes("provider-status")) {
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
        input: { title },
        reason: "Message looks like a task creation request.",
      });
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
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: '"npm.cmd run build"' },
        reason: "Run the local syntax build check.",
      });
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: '"npm.cmd run test"' },
        reason: "Run the local smoke test.",
      });
    }

    if (intents.includes("project-build") && !intents.includes("v2-audit") && !intents.includes("self-build")) {
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: '"npm.cmd run portable:build"' },
        reason: "Build the Windows portable executable package.",
      });
    }

    if (intents.includes("project-release")) {
      steps.push({
        type: "tool",
        tool: "plan_shell_command",
        input: { request: '"npm.cmd run release:windows"' },
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

    if (intents.includes("file-list")) {
      steps.push({
        type: "tool",
        tool: "list_files",
        input: { path: this.extractPath(message, ".") },
        reason: "The user asked to inspect workspace contents.",
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

    if (intents.includes("file-write")) {
      const writeRequest = this.extractWriteRequest(message);
      steps.push({
        type: "tool",
        tool: writeRequest.append ? "append_file" : "write_file",
        input: writeRequest,
        reason: "The user asked to create or update a workspace file.",
      });
    }

    if (intents.includes("research") && !intents.includes("delegation")) {
      steps.push({
        type: "tool",
        tool: "web_research",
        input: { query: this.extractResearchQuery(message) },
        reason: "The user asked for lightweight web research.",
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
        return match[1].trim();
      }
    }

    return fallback;
  }

  extractWriteRequest(message) {
    const quoted = [...message.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
    const append = message.toLowerCase().includes("append file");

    return {
      path: quoted[0] || "data/generated/output.txt",
      content: quoted[1] || "Generated by OmniClaw.\n",
      append,
    };
  }

  extractResearchQuery(message) {
    const quoted = message.match(/["']([^"']+)["']/);
    if (quoted) {
      return quoted[1];
    }

    return message
      .replace(/research|search web|look up|find on web/gi, "")
      .trim() || message;
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
