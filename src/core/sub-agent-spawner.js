import { EventEmitter } from "node:events";

function generateId(prefix = "subagent") {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

function truncate(value, maxChars = 2000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} chars omitted]`;
}

export class SubAgentSpawner extends EventEmitter {
  constructor({ agentRuntime, configStore, toolRegistry, agentRegistry, memoryStore, taskStore }) {
    super();
    this.agentRuntime = agentRuntime;
    this.configStore = configStore;
    this.toolRegistry = toolRegistry;
    this.agentRegistry = agentRegistry;
    this.memoryStore = memoryStore;
    this.taskStore = taskStore;
    this.activeAgents = new Map();
    this.completedAgents = new Map();
    this.maxConcurrent = 3;
    this.maxTotal = 20;
    this.defaultTimeoutMs = 120000;
  }

  getStatus() {
    const active = Array.from(this.activeAgents.values()).map((a) => ({
      id: a.id,
      parentAgentId: a.parentAgentId,
      task: a.task,
      status: a.status,
      startedAt: a.startedAt,
      elapsedMs: Date.now() - a.startedMs,
      toolCallCount: a.toolCallCount,
    }));
    const completed = Array.from(this.completedAgents.values()).slice(-10).map((a) => ({
      id: a.id,
      parentAgentId: a.parentAgentId,
      task: a.task,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      durationMs: a.durationMs,
      resultPreview: truncate(a.result, 200),
    }));
    return {
      activeCount: active.length,
      completedCount: this.completedAgents.size,
      maxConcurrent: this.maxConcurrent,
      maxTotal: this.maxTotal,
      active,
      recentCompleted: completed,
    };
  }

  canSpawn() {
    return this.activeAgents.size < this.maxConcurrent &&
      (this.activeAgents.size + this.completedAgents.size) < this.maxTotal;
  }

  async spawn({
    task,
    parentAgentId = "main",
    tools = [],
    model = "",
    timeoutMs = 0,
    systemPrompt = "",
    context = {},
  } = {}) {
    if (!task || !String(task).trim()) {
      throw new Error("Sub-agent task is required.");
    }
    if (!this.canSpawn()) {
      throw new Error(
        `Cannot spawn sub-agent: ${this.activeAgents.size} active (max ${this.maxConcurrent}), ` +
        `${this.completedAgents.size} completed (max ${this.maxTotal}).`,
      );
    }

    const id = generateId();
    const agent = {
      id,
      parentAgentId,
      task: String(task).trim(),
      tools: Array.isArray(tools) ? tools : [],
      model: String(model || "").trim() || this.configStore?.getConfig()?.provider?.mode || "",
      timeoutMs: Number(timeoutMs) || this.defaultTimeoutMs,
      systemPrompt: String(systemPrompt || "").trim(),
      status: "starting",
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      completedAt: null,
      completedMs: null,
      durationMs: null,
      result: null,
      error: null,
      toolCallCount: 0,
      messages: [],
    };

    this.activeAgents.set(id, agent);
    this.emit("spawned", { ...agent });

    try {
      const result = await this.runAgent(agent, context);
      agent.status = "completed";
      agent.result = result;
      agent.completedAt = new Date().toISOString();
      agent.completedMs = Date.now();
      agent.durationMs = agent.completedMs - agent.startedMs;
      this.activeAgents.delete(id);
      this.completedAgents.set(id, agent);
      this.emit("completed", { ...agent });
      return {
        id: agent.id,
        status: "completed",
        result: agent.result,
        durationMs: agent.durationMs,
        toolCallCount: agent.toolCallCount,
      };
    } catch (error) {
      agent.status = "failed";
      agent.error = error.message;
      agent.completedAt = new Date().toISOString();
      agent.completedMs = Date.now();
      agent.durationMs = agent.completedMs - agent.startedMs;
      this.activeAgents.delete(id);
      this.completedAgents.set(id, agent);
      this.emit("failed", { ...agent });
      throw error;
    }
  }

  async runAgent(agent, context) {
    const provider = this.agentRuntime?.provider;
    if (!provider) {
      throw new Error("No provider available for sub-agent execution.");
    }
    if (typeof provider.chat !== "function" && typeof provider.complete !== "function") {
      throw new Error("Current provider does not support sub-agent completion.");
    }

    const config = this.configStore?.getConfig() || {};
    const model = agent.model || config.provider?.mode || "";

    // Build system prompt for sub-agent
    let systemPrompt = agent.systemPrompt || `You are a focused sub-agent working on a specific task.
Your parent agent has delegated this task to you.
Be concise, thorough, and return actionable results.
You have access to tools: ${agent.tools.length > 0 ? agent.tools.join(", ") : "none"}.
When you are done, summarize your findings clearly.`;

    // Build messages
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: agent.task },
    ];

    agent.messages = [...messages];
    agent.status = "running";

    const timeoutMs = agent.timeoutMs;
    const startTime = Date.now();

    // Run with tool loop
    let maxToolRounds = 10;
    let round = 0;

    while (round < maxToolRounds) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Sub-agent timed out after ${timeoutMs}ms.`);
      }

      const response = typeof provider.chat === "function"
        ? await provider.chat(messages, { model, tools: this.buildToolDefinitions(agent.tools) })
        : await provider.complete(messages, {
            model,
            maxTokens: 900,
            temperature: 0,
          });
      const responseText = response.content || response.text || "";
      const assistantMsg = { role: "assistant", content: responseText };
      messages.push(assistantMsg);
      agent.messages.push(assistantMsg);

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        return responseText || "Task completed with no output.";
      }

      // Execute tool calls
      for (const toolCall of response.toolCalls) {
        agent.toolCallCount++;
        const toolResult = await this.executeToolCall(toolCall, context);
        const toolMsg = {
          role: "tool",
          content: JSON.stringify(toolResult),
          toolCallId: toolCall.id,
        };
        messages.push(toolMsg);
        agent.messages.push(toolMsg);
      }

      round++;
    }

    // If we hit max rounds, return the last assistant message
    return `Task reached maximum tool rounds (${maxToolRounds}). Last output: ${agent.messages[agent.messages.length - 1]?.content || "none"}`;
  }

  buildToolDefinitions(toolIds) {
    if (!this.toolRegistry || toolIds.length === 0) return [];
    const allTools = this.toolRegistry.getAll({});
    return allTools
      .filter((t) => toolIds.includes(t.id))
      .map((t) => ({
        type: "function",
        function: {
          name: t.id,
          description: t.description || "",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      }));
  }

  async executeToolCall(toolCall, context) {
    if (!this.toolRegistry) {
      return { error: "Tool registry not available." };
    }
    const toolName = toolCall.function?.name || toolCall.name || "";
    const toolArgs = toolCall.function?.arguments || toolCall.arguments || {};
    const parsedArgs = typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs;

    const allTools = this.toolRegistry.getAll({});
    const tool = allTools.find((t) => t.id === toolName);
    if (!tool) {
      return { error: `Tool "${toolName}" not found.` };
    }

    try {
      const result = await tool.run(parsedArgs, context);
      return result;
    } catch (error) {
      return { error: error.message };
    }
  }

  async cancel(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      return { found: false, message: `Sub-agent ${agentId} not found or already completed.` };
    }
    agent.status = "cancelled";
    agent.completedAt = new Date().toISOString();
    agent.completedMs = Date.now();
    agent.durationMs = agent.completedMs - agent.startedMs;
    this.activeAgents.delete(agentId);
    this.completedAgents.set(agentId, agent);
    this.emit("cancelled", { ...agent });
    return { found: true, message: `Sub-agent ${agentId} cancelled.` };
  }

  getHistory(limit = 20) {
    const all = Array.from(this.completedAgents.values());
    return all.slice(-limit).map((a) => ({
      id: a.id,
      parentAgentId: a.parentAgentId,
      task: a.task,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      durationMs: a.durationMs,
      toolCallCount: a.toolCallCount,
    }));
  }
}
