function estimateChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value || "").length;
  }
}

function truncateText(value, maxChars = 800) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32))}...[truncated ${text.length - maxChars} chars]`;
}

function looksSecret(key) {
  return /api[_-]?key|authorization|bearer|password|secret|token/i.test(String(key || ""));
}

function compactValue(value, options = {}, depth = 0) {
  const maxString = Number(options.maxString || 900);
  const maxArray = Number(options.maxArray || 8);
  const maxDepth = Number(options.maxDepth || 4);

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value, maxString);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((item) => compactValue(item, options, depth + 1));
    if (value.length > maxArray) {
      items.push({ omittedItems: value.length - maxArray });
    }
    return items;
  }

  if (typeof value === "object") {
    if (depth >= maxDepth) {
      return truncateText(JSON.stringify(value), maxString);
    }

    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = looksSecret(key) ? "[redacted]" : compactValue(item, options, depth + 1);
    }
    return output;
  }

  return truncateText(String(value), maxString);
}

function compactConversation(entry) {
  return {
    at: entry.at || entry.createdAt || "",
    agentId: entry.agentId || "main",
    sessionId: entry.sessionId || "",
    runId: entry.runId || "",
    user: truncateText(entry.user || "", 700),
    assistant: truncateText(entry.assistant || "", 900),
    intents: Array.isArray(entry.intents) ? entry.intents.slice(0, 8) : [],
    plan: entry.plan?.summary ? truncateText(entry.plan.summary, 500) : "",
    toolCount: Array.isArray(entry.toolOutputs) ? entry.toolOutputs.length : 0,
  };
}

function compactSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: truncateText(skill.description || "", 500),
    triggers: Array.isArray(skill.triggers) ? skill.triggers.slice(0, 12) : [],
    instructions: truncateText(skill.instructions || "", 1200),
  };
}

function compactTool(tool) {
  return {
    id: tool.id,
    description: truncateText(tool.description || "", 500),
    permission: tool.permission || "",
    pluginId: tool.pluginId || "",
  };
}

function compactToolOutput(item) {
  return {
    tool: item.tool || "unknown",
    output: compactValue(item.output, {
      maxString: 1200,
      maxArray: 10,
      maxDepth: 4,
    }),
  };
}

function compactResearch(item) {
  return {
    id: item.id,
    query: truncateText(item.query || "", 400),
    provider: item.provider || "",
    createdAt: item.createdAt || "",
    results: (item.results || []).slice(0, 3).map((result) => ({
      title: truncateText(result.title || "", 220),
      url: result.url || "",
      snippet: truncateText(result.snippet || result.description || "", 520),
    })),
  };
}

function compactArtifact(item) {
  return {
    id: item.id,
    kind: item.kind || "",
    path: item.path || "",
    createdAt: item.createdAt || "",
    bytesWritten: item.bytesWritten,
    updated: item.updated,
  };
}

function compactTask(item) {
  return compactValue(item, {
    maxString: 500,
    maxArray: 8,
    maxDepth: 3,
  });
}

function compactNote(item) {
  return {
    id: item.id,
    agentId: item.agentId || "main",
    createdAt: item.createdAt || "",
    text: truncateText(item.text || "", 900),
  };
}

function compactLongTermMemory(item) {
  return {
    id: item.id,
    agentId: item.agentId || "main",
    title: truncateText(item.title || "", 220),
    text: truncateText(item.text || "", 1100),
    importance: item.importance || "medium",
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
    sourceRef: item.sourceRef || "",
    promotedAt: item.promotedAt || item.createdAt || "",
  };
}

function compactWorkspaceFile(file) {
  return {
    name: file.name || "",
    scope: file.scope || "",
    path: file.path || "",
    content: truncateText(file.content || "", 2200),
  };
}

function compactWorkspaceContext(context = {}) {
  return {
    agentId: context.agentId || "main",
    loadedAt: context.loadedAt || "",
    files: (context.files || []).map(compactWorkspaceFile),
    heartbeatPrompt: truncateText(context.heartbeatPrompt || "", 1200),
  };
}

function defaultBudgetForProfile(profileId) {
  switch (profileId) {
    case "lite":
      return 12000;
    case "power":
      return 36000;
    default:
      return 22000;
  }
}

export class ContextEngine {
  constructor(configStore) {
    this.configStore = configStore;
  }

  getMaxChars(profile = {}) {
    const config = this.configStore?.getConfig?.() || {};
    return Number(
      profile.maxContextChars ||
        config.runtime?.context?.profiles?.[profile.id]?.maxChars ||
        config.runtime?.context?.maxChars ||
        defaultBudgetForProfile(profile.id),
    );
  }

  build(input = {}) {
    const profile = input.profile || {};
    const maxChars = this.getMaxChars(profile);
    let usedChars = 0;
    const reportSections = [];

    const bundle = {
      message: truncateText(input.message || "", 2000),
      intents: Array.isArray(input.intents) ? input.intents.slice(0, 12) : [],
      agent: compactValue(input.agent || {}, { maxString: 700, maxDepth: 3 }),
      profile: compactValue(profile, { maxString: 700, maxDepth: 3 }),
      plan: compactValue(input.plan || {}, { maxString: 900, maxArray: 12, maxDepth: 4 }),
      skills: [],
      tools: [],
      toolOutputs: [],
      recentConversations: [],
      notes: [],
      longTermMemory: [],
      research: [],
      artifacts: [],
      tasks: [],
      workspaceContext: null,
      sessionSummary: null,
      report: null,
    };

    function reserve(id, label, value) {
      const chars = estimateChars(value);
      usedChars += chars;
      reportSections.push({
        id,
        label,
        inputCount: 1,
        includedCount: 1,
        omittedCount: 0,
        chars,
      });
    }

    function addList(id, label, rawItems, compactItem, options = {}) {
      const source = Array.isArray(rawItems) ? rawItems : [];
      const newestFirst = Boolean(options.newestFirst);
      const restoreOrder = Boolean(options.restoreOrder);
      const ordered = newestFirst ? source.slice().reverse() : source.slice();
      const target = [];
      const maxSectionChars = Math.min(
        Number(options.maxChars || maxChars),
        Math.max(0, maxChars - usedChars),
      );
      let sectionChars = 0;
      let omittedCount = 0;

      for (const item of ordered) {
        const compacted = compactItem(item);
        const chars = estimateChars(compacted);
        if (target.length > 0 && (usedChars + chars > maxChars || sectionChars + chars > maxSectionChars)) {
          omittedCount += 1;
          continue;
        }
        if (target.length === 0 && usedChars + chars > maxChars) {
          omittedCount += 1;
          continue;
        }
        target.push(compacted);
        usedChars += chars;
        sectionChars += chars;
      }

      bundle[id] = restoreOrder ? target.reverse() : target;
      reportSections.push({
        id,
        label,
        inputCount: source.length,
        includedCount: target.length,
        omittedCount,
        chars: sectionChars,
      });
    }

    reserve("message", "Current user message", bundle.message);
    if (input.workspaceContext) {
      bundle.workspaceContext = compactWorkspaceContext(input.workspaceContext);
      reserve("workspaceContext", "Workspace identity files", bundle.workspaceContext);
    }
    reserve("plan", "Planner output", bundle.plan);

    if (input.sessionSummary) {
      bundle.sessionSummary = input.sessionSummary;
      reserve("sessionSummary", "Active session summary", bundle.sessionSummary);
    }

    addList("toolOutputs", "Tool outputs", input.toolOutputs, compactToolOutput, {
      maxChars: Math.floor(maxChars * 0.28),
    });
    addList("skills", "Matched skills", input.skills, compactSkill, {
      maxChars: Math.floor(maxChars * 0.12),
    });
    addList("notes", "Long-term notes", input.notes, compactNote, {
      newestFirst: true,
      restoreOrder: true,
      maxChars: Math.floor(maxChars * 0.14),
    });
    addList("longTermMemory", "Promoted long-term memory", input.longTermMemory, compactLongTermMemory, {
      newestFirst: true,
      restoreOrder: true,
      maxChars: Math.floor(maxChars * 0.18),
    });
    addList("recentConversations", "Recent conversations", input.recentConversations, compactConversation, {
      newestFirst: true,
      restoreOrder: true,
      maxChars: Math.floor(maxChars * 0.14),
    });
    addList("research", "Research memory", input.research, compactResearch, {
      newestFirst: true,
      restoreOrder: true,
      maxChars: Math.floor(maxChars * 0.14),
    });
    addList("artifacts", "Generated artifacts", input.artifacts, compactArtifact, {
      newestFirst: true,
      restoreOrder: true,
      maxChars: Math.floor(maxChars * 0.08),
    });
    addList("tasks", "Tasks", input.tasks, compactTask, {
      maxChars: Math.floor(maxChars * 0.12),
    });
    addList("tools", "Available tools", input.tools, compactTool, {
      maxChars: Math.floor(maxChars * 0.12),
    });

    const omittedItems = reportSections.reduce((total, section) => total + section.omittedCount, 0);
    bundle.report = {
      profileId: profile.id || "balanced",
      maxChars,
      usedChars,
      utilization: maxChars > 0 ? Number((usedChars / maxChars).toFixed(3)) : 0,
      omittedItems,
      sections: reportSections,
      summary: `Context bundle used ${usedChars}/${maxChars} chars with ${omittedItems} omitted item(s).`,
    };

    return bundle;
  }
}
