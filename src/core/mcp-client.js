// ─── MCP Server Client ─────────────────────────────────────────
// Model Context Protocol client for connecting to external tool servers
// Supports stdio transport (spawn process) and HTTP transport

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

export class McpClient extends EventEmitter {
  constructor({ id, command, args = [], env = {}, transport = "stdio", url = null, rootDir = process.cwd() }) {
    super();
    this.id = id;
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.transport = transport;
    this.url = url;
    this.rootDir = rootDir;
    this.process = null;
    this.tools = [];
    this.connected = false;
    this._requestId = 0;
    this._pending = new Map();
    this._buffer = "";
  }

  // ─── Connect ──────────────────────────────────────────────────
  async connect() {
    if (this.transport === "stdio") {
      return this._connectStdio();
    }
    if (this.transport === "http" && this.url) {
      this.connected = true;
      await this._initializeHttp();
      return true;
    }
    throw new Error(`Unsupported transport: ${this.transport}`);
  }

  async _connectStdio() {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.command, this.args, {
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: this.rootDir,
        });

        this.process.stdout.on("data", (chunk) => {
          this._buffer += chunk.toString("utf8");
          this._processBuffer();
        });

        this.process.stderr.on("data", () => {}); // ignore stderr

        this.process.on("error", (err) => {
          this.connected = false;
          this.emit("error", err);
        });

        this.process.on("close", () => {
          this.connected = false;
          this.emit("close");
        });

        // Send initialize request
        this._send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "OmniClaw", version: "0.1.0" },
        }).then((result) => {
          this.connected = true;
          this.emit("connected", result);
          // List tools after init
          return this._send("tools/list", {}).then((toolsResult) => {
            this.tools = (toolsResult?.tools || []).map((t) => ({
              id: `mcp_${this.id}_${t.name}`,
              name: t.name,
              description: t.description || "",
              inputSchema: t.inputSchema || {},
              mcpServer: this.id,
              mcpToolName: t.name,
            }));
            resolve(true);
          });
        }).catch(reject);

        // Timeout
        setTimeout(() => {
          if (!this.connected) reject(new Error("MCP connection timeout"));
        }, 10000);
      } catch (err) {
        reject(err);
      }
    });
  }

  async _initializeHttp() {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this._requestId,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "OmniClaw", version: "0.1.0" },
          },
        }),
      });
      const result = await response.json();
      // List tools
      const toolsResponse = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this._requestId,
          method: "tools/list",
          params: {},
        }),
      });
      const toolsResult = await toolsResponse.json();
      this.tools = (toolsResult?.result?.tools || []).map((t) => ({
        id: `mcp_${this.id}_${t.name}`,
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || {},
        mcpServer: this.id,
        mcpToolName: t.name,
      }));
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }

  // ─── Call Tool ────────────────────────────────────────────────
  async callTool(toolName, args = {}) {
    if (!this.connected) throw new Error("MCP client not connected");
    return this._send("tools/call", { name: toolName, arguments: args });
  }

  // ─── JSON-RPC Messaging ───────────────────────────────────────
  _send(method, params) {
    const id = ++this._requestId;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    if (this.transport === "http" && this.url) {
      return fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: message,
      }).then(async (r) => {
        const data = await r.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
      });
    }

    // stdio transport
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      const framed = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
      this.process.stdin.write(framed);
      // Timeout
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  _processBuffer() {
    while (this._buffer.length > 0) {
      const headerEnd = this._buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this._buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { this._buffer = this._buffer.slice(headerEnd + 4); continue; }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this._buffer.length < bodyStart + contentLength) break;

      const body = this._buffer.slice(bodyStart, bodyStart + contentLength);
      this._buffer = this._buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body);
        if (message.id && this._pending.has(message.id)) {
          const { resolve, reject } = this._pending.get(message.id);
          this._pending.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        } else if (message.method) {
          this.emit("notification", message);
        }
      } catch {}
    }
  }

  // ─── Disconnect ───────────────────────────────────────────────
  disconnect() {
    this.connected = false;
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this.tools = [];
  }

  getStatus() {
    return {
      id: this.id,
      transport: this.transport,
      connected: this.connected,
      toolCount: this.tools.length,
      tools: this.tools.map((t) => t.name),
    };
  }
}

// ─── MCP Server Registry ────────────────────────────────────────
export class McpRegistry {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.clients = new Map();
    this.configPath = path.join(rootDir, "config", "mcp-servers.json");
    this._loadConfig();
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        this._config = data.servers || {};
      } else {
        this._config = {};
      }
    } catch {
      this._config = {};
    }
  }

  async connectServer(serverId) {
    const cfg = this._config[serverId];
    if (!cfg) throw new Error(`MCP server not configured: ${serverId}`);
    if (this.clients.has(serverId)) return this.clients.get(serverId);

    const client = new McpClient({
      id: serverId,
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {},
      transport: cfg.transport || "stdio",
      url: cfg.url || null,
      rootDir: this.rootDir,
    });

    await client.connect();
    this.clients.set(serverId, client);
    return client;
  }

  async connectAll() {
    const results = {};
    for (const [id] of Object.entries(this._config)) {
      try {
        await this.connectServer(id);
        results[id] = "connected";
      } catch (err) {
        results[id] = `error: ${err.message}`;
      }
    }
    return results;
  }

  getAllTools() {
    const tools = [];
    for (const [, client] of this.clients) {
      tools.push(...client.tools);
    }
    return tools;
  }

  async callTool(toolId, args) {
    for (const [, client] of this.clients) {
      const tool = client.tools.find((t) => t.id === toolId);
      if (tool) {
        return client.callTool(tool.mcpToolName, args);
      }
    }
    throw new Error(`MCP tool not found: ${toolId}`);
  }

  disconnectAll() {
    for (const [, client] of this.clients) {
      client.disconnect();
    }
    this.clients.clear();
  }

  getStatus() {
    const status = {};
    for (const [id, client] of this.clients) {
      status[id] = client.getStatus();
    }
    return status;
  }
}
