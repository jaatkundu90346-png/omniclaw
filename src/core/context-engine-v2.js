import fs from "node:fs";
import path from "node:path";

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text, budget, reservedTokens = 0) {
  const available = budget - reservedTokens;
  if (available <= 0) return "";
  const maxChars = available * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 50) + "\n... [truncated to fit token budget]";
}

const DEFAULT_CONTEXT_ENGINES = {
  legacy: "legacy",
  compact: "compact",
  smart: "smart",
};

export class ContextEngine {
  constructor({ rootDir, configStore, sessionStore, memoryStore }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.sessionStore = sessionStore;
    this.memoryStore = memoryStore;
    this.engines = new Map();
    this.activeEngine = "legacy";
    this.registerDefaultEngines();
  }

  registerDefaultEngines() {
    this.engines.set("legacy", {
      name: "legacy",
      description: "Simple pass-through context assembly",
      assemble: (params) => this.legacyAssemble(params),
      compact: (params) => this.legacyCompact(params),
      ingest: (params) => this.legacyIngest(params),
    });

    this.engines.set("compact", {
      name: "compact",
      description: "Aggressive context compression",
      assemble: (params) => this.compactAssemble(params),
      compact: (params) => this.compactCompact(params),
      ingest: (params) => this.compactIngest(params),
    });

    this.engines.set("smart", {
      name: "smart",
      description: "Smart context with relevance scoring",
      assemble: (params) => this.smartAssemble(params),
      compact: (params) => this.smartCompact(params),
      ingest: (params) => this.smartIngest(params),
    });
  }

  registerEngine(id, engine) {
    this.engines.set(id, engine);
  }

  setActiveEngine(id) {
    if (!this.engines.has(id)) {
      throw new Error(`Context engine "${id}" not found. Available: ${Array.from(this.engines.keys()).join(", ")}`);
    }
    this.activeEngine = id;
  }

  getAvailableEngines() {
    return Array.from(this.engines.entries()).map(([id, engine]) => ({
      id,
      name: engine.name,
      description: engine.description,
      active: id === this.activeEngine,
    }));
  }

  async assemble(params) {
    const engine = this.engines.get(this.activeEngine);
    if (!engine) {
      throw new Error(`Active engine "${this.activeEngine}" not found.`);
    }
    return engine.assemble(params);
  }

  async compact(params) {
    const engine = this.engines.get(this.activeEngine);
    if (!engine) {
      throw new Error(`Active engine "${this.activeEngine}" not found.`);
    }
    return engine.compact(params);
  }

  async ingest(params) {
    const engine = this.engines.get(this.activeEngine);
    if (!engine) {
      throw new Error(`Active engine "${this.activeEngine}" not found.`);
    }
    return engine.ingest(params);
  }

  async legacyAssemble(params) {
    const { messages, sessionId, tokenBudget, systemPrompt, tools, memoryContext } = params;
    const config = this.configStore?.getConfig?.() || {};
    const budget = tokenBudget || config.tools?.context?.maxTokens || 32000;

    const assembled = [];

    if (systemPrompt) {
      assembled.push({ role: "system", content: systemPrompt });
    }

    const memoryText = memoryContext || this.buildMemoryContext(sessionId);
    if (memoryText) {
      assembled.push({ role: "system", content: memoryText });
    }

    for (const msg of messages) {
      assembled.push({ role: msg.role, content: msg.content, tool_calls: msg.tool_calls, tool_call_id: msg.tool_call_id });
    }

    const totalTokens = assembled.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

    return {
      messages: assembled,
      estimatedTokens: totalTokens,
      tokenBudget: budget,
      utilizationPercent: ((totalTokens / budget) * 100).toFixed(1),
      engine: "legacy",
    };
  }

  async legacyCompact(params) {
    const { messages, targetTokens } = params;
    if (!messages || messages.length === 0) return { messages: [], tokens: 0 };

    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
    if (totalTokens <= targetTokens) {
      return { messages, tokens: totalTokens, compacted: false };
    }

    const systemMessages = messages.filter((m) => m.role === "system");
    const recentMessages = messages.slice(-20);
    const compacted = [...systemMessages, ...recentMessages];
    const newTokens = compacted.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

    return {
      messages: compacted,
      tokens: newTokens,
      compacted: true,
      originalTokens: totalTokens,
      removedTokens: totalTokens - newTokens,
    };
  }

  async legacyIngest(params) {
    const { message, sessionId } = params;
    return { ingested: true, sessionId, message };
  }

  async compactAssemble(params) {
    const { messages, sessionId, tokenBudget, systemPrompt, memoryContext } = params;
    const config = this.configStore?.getConfig?.() || {};
    const budget = tokenBudget || config.tools?.context?.maxTokens || 32000;

    const assembled = [];

    if (systemPrompt) {
      assembled.push({ role: "system", content: truncateToTokenBudget(systemPrompt, budget * 0.2) });
    }

    const memoryText = memoryContext || this.buildMemoryContext(sessionId);
    if (memoryText) {
      assembled.push({ role: "system", content: truncateToTokenBudget(memoryText, budget * 0.15) });
    }

    const systemTokens = assembled.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
    const remainingBudget = budget - systemTokens - 1000;

    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const toolMessages = messages.filter((m) => m.role === "tool");

    const keepLast = Math.min(10, userMessages.length);
    const recentUser = userMessages.slice(-keepLast);
    const recentAssistant = assistantMessages.slice(-keepLast);
    const recentTool = toolMessages.slice(-keepLast * 2);

    const interleaved = [];
    const allRecent = [...recentUser, ...recentAssistant, ...recentTool].sort((a, b) => {
      const aIdx = messages.indexOf(a);
      const bIdx = messages.indexOf(b);
      return aIdx - bIdx;
    });

    for (const msg of allRecent) {
      const content = truncateToTokenBudget(msg.content || "", remainingBudget / allRecent.length);
      interleaved.push({ role: msg.role, content, tool_calls: msg.tool_calls, tool_call_id: msg.tool_call_id });
    }

    assembled.push(...interleaved);

    const totalTokens = assembled.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

    return {
      messages: assembled,
      estimatedTokens: totalTokens,
      tokenBudget: budget,
      utilizationPercent: ((totalTokens / budget) * 100).toFixed(1),
      engine: "compact",
      compressionRatio: messages.length > 0 ? (assembled.length / messages.length).toFixed(2) : "1.00",
    };
  }

  async compactCompact(params) {
    return this.legacyCompact(params);
  }

  async compactIngest(params) {
    return this.legacyIngest(params);
  }

  async smartAssemble(params) {
    const { messages, sessionId, tokenBudget, systemPrompt, memoryContext, availableTools } = params;
    const config = this.configStore?.getConfig?.() || {};
    const budget = tokenBudget || config.tools?.context?.maxTokens || 32000;

    const assembled = [];
    let reservedTokens = 0;

    if (systemPrompt) {
      const spTokens = estimateTokens(systemPrompt);
      reservedTokens += spTokens;
      assembled.push({ role: "system", content: systemPrompt });
    }

    const memoryText = memoryContext || this.buildMemoryContext(sessionId, { maxTokens: budget * 0.1 });
    if (memoryText) {
      const memTokens = estimateTokens(memoryText);
      reservedTokens += memTokens;
      assembled.push({ role: "system", content: memoryText });
    }

    const messageScores = messages.map((msg, index) => {
      let score = 0;
      const isRecent = index > messages.length - 15;
      const isUser = msg.role === "user";
      const hasToolCall = msg.tool_calls?.length > 0;
      const hasToolResult = msg.role === "tool";
      const contentLength = (msg.content || "").length;

      if (isRecent) score += 10;
      if (isUser) score += 5;
      if (hasToolCall) score += 8;
      if (hasToolResult) score += 6;
      if (contentLength > 100) score += 3;

      const isQuestion = /\?/.test(msg.content || "");
      if (isQuestion) score += 4;

      return { msg, score, index };
    });

    messageScores.sort((a, b) => b.score - a.score);

    const remainingBudget = budget - reservedTokens - 1000;
    let usedTokens = 0;
    const selected = [];

    for (const { msg } of messageScores) {
      const msgTokens = estimateTokens(msg.content || "");
      if (usedTokens + msgTokens <= remainingBudget) {
        selected.push({ msg, tokens: msgTokens });
        usedTokens += msgTokens;
      }
    }

    selected.sort((a, b) => a.msg.index - b.msg.index);

    for (const { msg } of selected) {
      assembled.push({ role: msg.role, content: msg.content, tool_calls: msg.tool_calls, tool_call_id: msg.tool_call_id });
    }

    const totalTokens = assembled.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);

    return {
      messages: assembled,
      estimatedTokens: totalTokens,
      tokenBudget: budget,
      utilizationPercent: ((totalTokens / budget) * 100).toFixed(1),
      engine: "smart",
      messageCount: messages.length,
      selectedCount: assembled.length,
      relevanceThreshold: messageScores[selected.length - 1]?.score || 0,
    };
  }

  async smartCompact(params) {
    const { messages, targetTokens } = params;
    if (!messages || messages.length === 0) return { messages: [], tokens: 0 };

    const messageScores = messages.map((msg, index) => {
      let score = 0;
      const isRecent = index > messages.length - 10;
      const isSystem = msg.role === "system";
      const hasToolCall = msg.tool_calls?.length > 0;

      if (isSystem) score += 20;
      if (isRecent) score += 15;
      if (hasToolCall) score += 10;

      return { msg, score, index };
    });

    messageScores.sort((a, b) => b.score - a.score);

    let totalTokens = 0;
    const selected = [];

    for (const { msg } of messageScores) {
      const msgTokens = estimateTokens(msg.content || "");
      if (totalTokens + msgTokens <= targetTokens) {
        selected.push(msg);
        totalTokens += msgTokens;
      }
    }

    selected.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));

    return {
      messages: selected,
      tokens: totalTokens,
      compacted: true,
      originalTokens: messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0),
      removedCount: messages.length - selected.length,
    };
  }

  async smartIngest(params) {
    return this.legacyIngest(params);
  }

  buildMemoryContext(sessionId, options = {}) {
    const maxTokens = options.maxTokens || 2000;
    const agentId = options.agentId || "main";

    let context = "";

    try {
      const notes = this.memoryStore?.getNotes?.(agentId) || [];
      if (notes.length > 0) {
        context += "\n## User Notes\n";
        for (const note of notes.slice(-5)) {
          context += `- ${note.text?.slice(0, 100)}\n`;
        }
      }

      const longTerm = this.memoryStore?.getLongTermMemory?.(5, agentId) || [];
      if (longTerm.length > 0) {
        context += "\n## Long-Term Memory\n";
        for (const mem of longTerm) {
          context += `- ${mem.summary || mem.text?.slice(0, 100)}\n`;
        }
      }
    } catch {}

    if (context.length === 0) return "";
    return truncateToTokenBudget(context, maxTokens);
  }

  getStatus() {
    const config = this.configStore?.getConfig?.() || {};
    return {
      activeEngine: this.activeEngine,
      availableEngines: this.getAvailableEngines(),
      defaultBudget: config.tools?.context?.maxTokens || 32000,
      compactionThreshold: config.tools?.context?.compactionThreshold || 0.75,
    };
  }
}
