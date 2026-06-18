import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    const urlObj = new URL(url);
    const client = urlObj.protocol === "https:" ? https : http;
    const req = client.request(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OmniClaw-ToolResolver/0.1.0",
        ...options.headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        } catch {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

export class ToolResolver {
  constructor({ toolRegistry, configStore }) {
    this.toolRegistry = toolRegistry;
    this.configStore = configStore;
    this.remoteTools = new Map();
    this.aliases = new Map();
  }

  registerRemoteTool({ id, name, description, url, method = "POST", headers = {}, timeoutMs = 10000 }) {
    this.remoteTools.set(id, { id, name, description, url, method, headers, timeoutMs, type: "remote" });
  }

  registerAlias(alias, targetId) {
    this.aliases.set(alias.toLowerCase(), targetId);
  }

  resolveTool(toolId) {
    const normalized = toolId.toLowerCase();

    if (this.aliases.has(normalized)) {
      return this.resolveTool(this.aliases.get(normalized));
    }

    if (this.toolRegistry) {
      const allTools = this.toolRegistry.getAll({});
      const localTool = allTools.find((t) => t.id === toolId);
      if (localTool) return { tool: localTool, type: "local" };
    }

    const remoteTool = this.remoteTools.get(toolId);
    if (remoteTool) return { tool: remoteTool, type: "remote" };

    return null;
  }

  async invokeTool(toolId, args, context = {}) {
    const resolved = this.resolveTool(toolId);
    if (!resolved) {
      throw new Error(`Tool "${toolId}" not found. Available: ${this.listTools().map(t => t.id).join(", ")}`);
    }

    if (resolved.type === "local") {
      return resolved.tool.run(args, context);
    }

    if (resolved.type === "remote") {
      const remote = resolved.tool;
      const response = await fetchWithTimeout(remote.url, {
        method: remote.method,
        headers: remote.headers,
        body: JSON.stringify({ tool: remote.id, arguments: args, context }),
        timeoutMs: remote.timeoutMs,
      });
      return response.data;
    }

    throw new Error(`Unknown tool type: ${resolved.type}`);
  }

  listTools() {
    const localTools = [];
    if (this.toolRegistry) {
      const allTools = this.toolRegistry.getAll({});
      for (const tool of allTools) {
        localTools.push({
          id: tool.id,
          description: tool.description,
          type: "local",
          permission: tool.permission,
          group: tool.group || "",
        });
      }
    }

    const remoteTools = Array.from(this.remoteTools.values()).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      type: "remote",
      url: t.url,
    }));

    const aliasList = Array.from(this.aliases.entries()).map(([alias, target]) => ({
      id: alias,
      type: "alias",
      target,
    }));

    return [...localTools, ...remoteTools, ...aliasList];
  }

  getToolDefinitions() {
    const localTools = this.toolRegistry
      ? this.toolRegistry.getAll({ modelCallableOnly: true }).map((tool) => ({
          id: tool.id,
          description: tool.description,
          type: "local",
          permission: tool.permission,
          group: tool.group || "",
        }))
      : [];
    const remoteTools = Array.from(this.remoteTools.values()).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      type: "remote",
      url: t.url,
    }));

    return [...localTools, ...remoteTools].map((t) => ({
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

  getStatus() {
    return {
      localTools: this.toolRegistry ? this.toolRegistry.getAll({}).length : 0,
      remoteTools: this.remoteTools.size,
      aliases: this.aliases.size,
      total: this.listTools().length,
    };
  }
}
