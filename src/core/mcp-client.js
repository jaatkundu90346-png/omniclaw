// ─── MCP Server Client ─────────────────────────────────────────
// Model Context Protocol client for connecting to external tool servers.
// Supports:
//   • stdio transport (spawn a local process, newline-delimited JSON-RPC)
//   • HTTP transport — modern "Streamable HTTP" (2025-03-26) with optional
//     text/event-stream responses AND the older single-POST JSON style.
//
// This is the transport that Composio's hosted MCP servers use
// (https://mcp.composio.dev/.../mcp). Those endpoints:
//   • require an auth header (Authorization: Bearer / x-api-key), and
//   • may answer a JSON-RPC POST with an SSE (text/event-stream) body, and
//   • hand back an `mcp-session-id` header on initialize that MUST be echoed
//     on every subsequent request.
// The previous client did none of these, which is why remote servers like
// Composio connected-but-empty or failed auth outright.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "OmniClaw", version: "0.1.0" };

export class McpClient extends EventEmitter {
  constructor({
    id,
    command,
    args = [],
    env = {},
    transport = "stdio",
    url = null,
    headers = {},
    apiKey = null,
    bearer = null,
    rootDir = process.cwd(),
  }) {
    super();
    this.id = id;
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    // Normalize transport aliases so config can say http / https / sse /
    // streamable-http / streamable and all land on the HTTP path.
    const t = String(transport || "stdio").toLowerCase();
    this.transport = t === "stdio" ? "stdio" : "http";
    this.url = url;
    this.headers = this._buildHeaders(headers, apiKey, bearer, env);
    this.rootDir = rootDir;
    this.process = null;
    this.tools = [];
    this.connected = false;
    this.sessionId = null; // mcp-session-id from Streamable HTTP servers
    this.lastError = null;
    this._requestId = 0;
    this._pending = new Map();
    this._buffer = "";
  }

  // Auth is the #1 reason a remote MCP server (Composio, etc.) rejects a
  // connection. Accept it in several shapes and normalize to real HTTP headers.
  _buildHeaders(headers = {}, apiKey = null, bearer = null, env = {}) {
    const out = { ...(headers || {}) };
    const token = bearer || env.MCP_BEARER || env.COMPOSIO_BEARER || null;
    const key = apiKey || env.MCP_API_KEY || env.COMPOSIO_API_KEY || null;
    const hasAuth = Object.keys(out).some((h) => h.toLowerCase() === "authorization");
    if (token && !hasAuth) out.Authorization = `Bearer ${token}`;
    if (key && !hasAuth && !Object.keys(out).some((h) => h.toLowerCase() === "x-api-key")) {
      out["x-api-key"] = key;
    }
    // Expand ${ENV_VAR} placeholders inside header values so a config file can
    // reference a secret without hardcoding it.
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "string") {
        out[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || env[name] || "");
      }
    }
    return out;
  }

  // ─── Connect ──────────────────────────────────────────────────
  async connect() {
    if (this.transport === "stdio") {
      return this._connectStdio();
    }
    if (this.transport === "http" && this.url) {
      await this._initializeHttp();
      this.connected = true;
      this.emit("connected");
      return true;
    }
    throw new Error(`Unsupported transport: ${this.transport}${this.url ? "" : " (missing url)"}`);
  }

  async _connectStdio() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };
      try {
        // On Windows `npx`/`npm` are .cmd shims that spawn() cannot exec
        // directly without a shell — this is why local stdio servers never
        // started on Windows. shell:true resolves the shim.
        const useShell = process.platform === "win32";
        this.process = spawn(this.command, this.args, {
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: this.rootDir,
          shell: useShell,
        });

        this.process.stdout.on("data", (chunk) => {
          this._buffer += chunk.toString("utf8");
          this._processBuffer();
        });

        // Keep the last stderr so a failed handshake reports WHY, instead of a
        // silent "connection timeout".
        this.process.stderr.on("data", (chunk) => {
          this.lastError = chunk.toString("utf8").slice(-500);
        });

        this.process.on("error", (err) => {
          this.connected = false;
          this._rejectAllPending(`MCP process error: ${err.message}`);
          this.emit("error", err);
          done(err);
        });

        this.process.on("close", () => {
          this.connected = false;
          this._rejectAllPending("MCP process closed");
          this.emit("close");
        });

        // Handshake: initialize -> notifications/initialized -> tools/list
        this._send("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        })
          .then(() => {
            this.connected = true;
            this._notify("notifications/initialized", {});
            this.emit("connected");
            return this._send("tools/list", {});
          })
          .then((toolsResult) => {
            this.tools = this._mapTools(toolsResult?.tools);
            done(null, true);
          })
          .catch((err) => done(err));

        setTimeout(() => {
          if (!this.connected) {
            done(new Error(`MCP connection timeout${this.lastError ? `: ${this.lastError}` : ""}`));
          }
        }, 15000);
      } catch (err) {
        done(err);
      }
    });
  }

  async _initializeHttp() {
    const initResult = await this._httpRequest("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (initResult && initResult.error) {
      throw new Error(`MCP initialize failed: ${initResult.error.message || JSON.stringify(initResult.error)}`);
    }
    // Per spec: confirm with the initialized notification BEFORE any normal
    // request. Strict servers reject tools/list otherwise.
    await this._httpNotify("notifications/initialized", {});
    const toolsResult = await this._httpRequest("tools/list", {});
    if (toolsResult && toolsResult.error) {
      throw new Error(`MCP tools/list failed: ${toolsResult.error.message || JSON.stringify(toolsResult.error)}`);
    }
    this.tools = this._mapTools(toolsResult?.result?.tools);
  }

  _mapTools(list) {
    return (list || []).map((t) => ({
      id: `mcp_${this.id}_${t.name}`,
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || {},
      mcpServer: this.id,
      mcpToolName: t.name,
    }));
  }

  // ─── Call Tool ────────────────────────────────────────────────
  async callTool(toolName, args = {}) {
    if (!this.connected) throw new Error("MCP client not connected");
    if (this.transport === "http") {
      const res = await this._httpRequest("tools/call", { name: toolName, arguments: args });
      if (res && res.error) throw new Error(res.error.message || "MCP tool error");
      return res?.result ?? res;
    }
    return this._send("tools/call", { name: toolName, arguments: args });
  }

  // ─── HTTP (Streamable HTTP) transport ─────────────────────────
  _httpHeaders() {
    const h = {
      "Content-Type": "application/json",
      // Streamable HTTP servers pick JSON vs SSE from what we accept.
      Accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  // Send a JSON-RPC request over HTTP and return the parsed JSON-RPC envelope
  // ({ result } or { error }). Handles both a plain JSON body and an SSE
  // (text/event-stream) body, and captures the mcp-session-id header.
  async _httpRequest(method, params) {
    const id = ++this._requestId;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const response = await fetch(this.url, { method: "POST", headers: this._httpHeaders(), body });

    const sid = response.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (!response.ok && response.status >= 400) {
      const errText = await response.text().catch(() => "");
      throw new Error(`MCP HTTP ${response.status}: ${errText.slice(0, 300) || response.statusText}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      return this._parseSse(await response.text(), id);
    }
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Some gateways still stream SSE without the right content-type.
      return this._parseSse(text, id);
    }
  }

  // Fire-and-forget notification (no id, no response body expected). Servers
  // typically answer 202 Accepted.
  async _httpNotify(method, params = {}) {
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", method, params });
      const response = await fetch(this.url, { method: "POST", headers: this._httpHeaders(), body });
      const sid = response.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      // Drain the body so the socket can be reused.
      await response.text().catch(() => {});
    } catch {
      // Notifications are best-effort.
    }
  }

  // Parse an SSE payload and return the JSON-RPC envelope matching `id`
  // (or the last response-shaped event if no id match).
  _parseSse(raw, id) {
    let match = null;
    let lastResponse = null;
    for (const block of String(raw).split(/\n\n+/)) {
      const dataLines = block
        .split(/\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      if (!payload || payload === "[DONE]") continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj && (obj.result !== undefined || obj.error !== undefined)) {
        lastResponse = obj;
        if (obj.id === id) match = obj;
      }
    }
    return match || lastResponse || {};
  }

  // ─── stdio JSON-RPC Messaging ─────────────────────────────────
  _send(method, params) {
    const id = ++this._requestId;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    // stdio transport frames messages as newline-delimited JSON (one JSON-RPC
    // object per line) — NOT LSP Content-Length framing.
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this.process.stdin.write(`${message}\n`);
      } catch (err) {
        this._pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  // Fire-and-forget JSON-RPC notification for stdio (no id, no response).
  _notify(method, params = {}) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    try {
      if (this.process?.stdin?.writable) {
        this.process.stdin.write(`${payload}\n`);
      }
    } catch {
      // Notifications are best-effort; never throw into the caller.
    }
  }

  _processBuffer() {
    let newlineIndex;
    while ((newlineIndex = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, newlineIndex).trim();
      this._buffer = this._buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this._handleMessage(JSON.parse(line));
      } catch {
        // Ignore non-JSON lines (startup banners printed to stdout).
      }
    }
  }

  _handleMessage(message) {
    if (message.id != null && this._pending.has(message.id)) {
      const { resolve, reject } = this._pending.get(message.id);
      this._pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || "MCP error"));
      else resolve(message.result);
    } else if (message.method) {
      this.emit("notification", message);
    }
  }

  // ─── Disconnect ───────────────────────────────────────────────
  disconnect() {
    this.connected = false;
    this._rejectAllPending("MCP client disconnected");
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
    }
    this.tools = [];
    this.sessionId = null;
  }

  _rejectAllPending(reason) {
    for (const [, pending] of this._pending) {
      try { pending.reject(new Error(reason)); } catch {}
    }
    this._pending.clear();
  }

  getStatus() {
    return {
      id: this.id,
      transport: this.transport,
      connected: this.connected,
      toolCount: this.tools.length,
      tools: this.tools.map((t) => t.name),
      lastError: this.lastError || null,
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

  // Persist a server entry (e.g. a Composio URL supplied at runtime) so a
  // rebuild/restart keeps it. Skips servers flagged disabled.
  saveServer(serverId, cfg) {
    this._config[serverId] = cfg;
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify({ servers: this._config }, null, 2));
    } catch {
      // In a read-only packaged context the in-memory config still works.
    }
    return this._config[serverId];
  }

  removeServer(serverId) {
    if (this.clients.has(serverId)) {
      try { this.clients.get(serverId).disconnect(); } catch {}
      this.clients.delete(serverId);
    }
    delete this._config[serverId];
    try {
      fs.writeFileSync(this.configPath, JSON.stringify({ servers: this._config }, null, 2));
    } catch {}
  }

  async connectServer(serverId) {
    const cfg = this._config[serverId];
    if (!cfg) throw new Error(`MCP server not configured: ${serverId}`);
    if (cfg.disabled) throw new Error(`MCP server disabled: ${serverId}`);
    if (this.clients.has(serverId) && this.clients.get(serverId).connected) {
      return this.clients.get(serverId);
    }

    const client = new McpClient({
      id: serverId,
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {},
      transport: cfg.transport || (cfg.url ? "http" : "stdio"),
      url: cfg.url || null,
      headers: cfg.headers || {},
      apiKey: cfg.apiKey || null,
      bearer: cfg.bearer || null,
      rootDir: this.rootDir,
    });

    await client.connect();
    this.clients.set(serverId, client);
    return client;
  }

  async connectAll() {
    const results = {};
    for (const [id, cfg] of Object.entries(this._config)) {
      if (cfg?.disabled) {
        results[id] = "disabled";
        continue;
      }
      try {
        const client = await this.connectServer(id);
        results[id] = `connected (${client.tools.length} tools)`;
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
