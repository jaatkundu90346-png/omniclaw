import { randomUUID } from "node:crypto";

function encodeWsFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const payloads = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let len = buffer[offset + 1] & 0x7f;
    let headerLen = 2;

    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      len = buffer.readUInt32BE(offset + 6);
      headerLen = 10;
    }

    const maskingKeyOffset = offset + headerLen;
    const payloadOffset = offset + headerLen + (masked ? 4 : 0);

    if (payloadOffset + len > buffer.length) break;

    let payload = buffer.subarray(payloadOffset, payloadOffset + len);

    if (masked) {
      const mask = buffer.subarray(maskingKeyOffset, maskingKeyOffset + 4);
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    if (opcode === 1 || opcode === 2) {
      payloads.push(payload);
    }

    offset = payloadOffset + len;
  }

  return { payloads, remaining: buffer.subarray(offset) };
}

const FRAME_TYPES = {
  REQUEST: "request",
  RESPONSE: "response",
  EVENT: "event",
  ERROR: "error",
};

const METHOD_HANDLERS = {
  connect: "handleConnect",
  "sessions.send": "handleSessionSend",
  "sessions.list": "handleSessionsList",
  "sessions.get": "handleSessionGet",
  "sessions.reset": "handleSessionReset",
  "sessions.history": "handleSessionHistory",
  "config.get": "handleConfigGet",
  "config.update": "handleConfigUpdate",
  "tools.invoke": "handleToolInvoke",
  "tools.list": "handleToolsList",
  "gateway.status": "handleGatewayStatus",
  "gateway.events": "handleGatewayEvents",
  "agent.send": "handleAgentSend",
  "agents.list": "handleAgentsList",
  "memory.overview": "handleMemoryOverview",
  "memory.promote": "handleMemoryPromote",
  "memory.search": "handleMemorySearch",
  "delegations.list": "handleDelegationsList",
  "delegations.create": "handleDelegationsCreate",
  "delegations.cancel": "handleDelegationsCancel",
  "approvals.list": "handleApprovalsList",
  "approvals.resolve": "handleApprovalsResolve",
  "cron.list": "handleCronList",
  "cron.create": "handleCronCreate",
  "cron.delete": "handleCronDelete",
  "cron.toggle": "handleCronToggle",
  "channels.list": "handleChannelsList",
  "channels.status": "handleChannelsStatus",
  "health.check": "handleHealthCheck",
};

function createFrame(type, data) {
  return {
    jsonrpc: "2.0",
    frame: type,
    id: data.id || null,
    ...data,
  };
}

function createRequest(id, method, params = {}) {
  return createFrame(FRAME_TYPES.REQUEST, { id, method, params });
}

function createResponse(id, result) {
  return createFrame(FRAME_TYPES.RESPONSE, { id, result });
}

function createError(id, code, message, data = null) {
  return createFrame(FRAME_TYPES.ERROR, {
    id,
    error: { code, message, data },
  });
}

function createEvent(method, params = {}) {
  return createFrame(FRAME_TYPES.EVENT, { method, params });
}

class ClientSession {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.authenticated = false;
    this.role = "operator";
    this.scopes = [];
    this.connectedAt = new Date().toISOString();
    this.messageCount = 0;
    this.lastActivity = Date.now();
  }

  send(frame) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  close(code = 1000, reason = "") {
    this.ws.close(code, reason);
  }

  updateActivity() {
    this.lastActivity = Date.now();
    this.messageCount++;
  }
}

export class GatewayWSProtocol {
  constructor(agent) {
    this.agent = agent;
    this.clients = new Map();
    this.connectAttempts = new Map();
    this.maxConnectAttempts = 10;
    this.connectWindowMs = 60000;
    this.eventSubscriptions = new Map();
  }

  handleConnection(socket, req) {
    const clientId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const ws = {
      readyState: 1,
      send: (data) => {
        if (socket.writable) {
          const payload = Buffer.from(String(data), "utf8");
          const frame = encodeWsFrame(payload);
          socket.write(frame);
        }
      },
      close: (code = 1000, reason = "") => {
        socket.end();
      },
    };

    const session = new ClientSession(ws, clientId);
    this.clients.set(clientId, session);

    let buffer = Buffer.alloc(0);

    socket.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frames = decodeWsFrames(buffer);
      if (frames.payloads.length > 0) {
        buffer = frames.remaining || Buffer.alloc(0);
        for (const payload of frames.payloads) {
          try {
            const message = JSON.parse(payload.toString("utf8"));
            await this.handleMessage(session, message);
          } catch (error) {
            session.send(createError(null, -32700, "Parse error", { detail: error.message }));
          }
        }
      }
    });

    socket.on("close", () => {
      ws.readyState = 3;
      this.clients.delete(clientId);
      this.unsubscribeAll(clientId);
      this.broadcastEvent("client.disconnected", { clientId, at: new Date().toISOString() });
    });

    socket.on("error", () => {
      ws.readyState = 3;
      this.clients.delete(clientId);
      this.unsubscribeAll(clientId);
    });

    this.broadcastEvent("client.connected", { clientId, at: session.connectedAt });
  }

  async handleMessage(session, message) {
    session.updateActivity();

    if (message.frame === FRAME_TYPES.REQUEST || (message.jsonrpc === "2.0" && message.method)) {
      const { id, method, params } = message;
      const handlerName = METHOD_HANDLERS[method];

      if (!handlerName) {
        session.send(createError(id, -32601, `Method "${method}" not found.`));
        return;
      }

      if (!this[handlerName]) {
        session.send(createError(id, -32603, `Handler "${handlerName}" not implemented.`));
        return;
      }

      try {
        const result = await this[handlerName](session, params || {}, method);
        if (id !== null && id !== undefined) {
          session.send(createResponse(id, result));
        }
      } catch (error) {
        session.send(createError(id, -32603, error.message));
      }
    }
  }

  async handleConnect(session, params) {
    const { token, role } = params || {};
    const config = this.agent?.config?.getConfig?.() || {};
    const gatewayToken = config.gateway?.token || "";

    if (token && token === gatewayToken) {
      session.authenticated = true;
      session.role = role || "operator";
      session.scopes = role === "node" ? ["node.read", "node.write"] : ["operator.read", "operator.write", "operator.approvals"];
      return {
        authenticated: true,
        clientId: session.id,
        role: session.role,
        scopes: session.scopes,
        serverVersion: "0.1.0",
        serverName: "OmniClaw",
        connectedAt: session.connectedAt,
      };
    }

    if (!gatewayToken) {
      session.authenticated = true;
      session.role = "operator";
      session.scopes = ["operator.read", "operator.write", "operator.approvals"];
      return {
        authenticated: true,
        clientId: session.id,
        role: "operator",
        scopes: session.scopes,
        serverVersion: "0.1.0",
        serverName: "OmniClaw",
        connectedAt: session.connectedAt,
        note: "No gateway token configured. Full access granted.",
      };
    }

    throw new Error("Authentication failed. Invalid gateway token.");
  }

  async handleSessionSend(session, params) {
    this.requireAuth(session);
    const { sessionId, message, label, agentId } = params;
    if (!message) throw new Error("'message' is required.");

    const result = await this.agent.runChat({
      sessionId: sessionId || "",
      message: String(message).trim(),
      label: label || "ws-session",
      agentId: agentId || "main",
      channel: "websocket",
    });

    return { runId: result.runId, status: result.status };
  }

  async handleSessionsList(session, params) {
    this.requireAuth(session);
    const { limit, agentId, status } = params || {};
    const sessions = this.agent.sessions.listSessions(Number(limit || 50));
    const filtered = sessions.filter((s) => {
      if (agentId && s.agentId !== agentId) return false;
      if (status && s.status !== status) return false;
      return true;
    });
    return { sessions: filtered, total: filtered.length };
  }

  async handleSessionGet(session, params) {
    this.requireAuth(session);
    const { sessionId } = params;
    if (!sessionId) throw new Error("'sessionId' is required.");
    const sessionData = this.agent.sessions.getSession(sessionId);
    if (!sessionData) throw new Error(`Session "${sessionId}" not found.`);
    return { session: sessionData };
  }

  async handleSessionReset(session, params) {
    this.requireAuth(session);
    const { sessionId } = params;
    if (!sessionId) throw new Error("'sessionId' is required.");
    const result = this.agent.sessions.resetSession(sessionId);
    return { reset: true, sessionId };
  }

  async handleSessionHistory(session, params) {
    this.requireAuth(session);
    const { sessionId, limit } = params;
    if (!sessionId) throw new Error("'sessionId' is required.");
    const history = this.agent.sessions.getSessionHistory(sessionId, Number(limit || 50));
    return { history, sessionId };
  }

  async handleConfigGet(session, params) {
    this.requireAuth(session);
    const config = this.agent.config.getConfig();
    return { config };
  }

  async handleConfigUpdate(session, params) {
    this.requireAuth(session, "operator.write");
    const { key, value } = params;
    if (!key) throw new Error("'key' is required.");
    this.agent.config.updateConfig(key, value);
    return { updated: true, key };
  }

  async handleToolInvoke(session, params) {
    this.requireAuth(session);
    const { tool, arguments: args } = params;
    if (!tool) throw new Error("'tool' is required.");
    const toolRegistry = this.agent.tools;
    if (!toolRegistry) throw new Error("Tool registry unavailable.");
    const allTools = toolRegistry.getAll({});
    const toolDef = allTools.find((t) => t.id === tool);
    if (!toolDef) throw new Error(`Tool "${tool}" not found.`);
    const result = await toolDef.run(args || {}, {});
    return { tool, result };
  }

  async handleToolsList(session, params) {
    this.requireAuth(session);
    const toolRegistry = this.agent.tools;
    if (!toolRegistry) return { tools: [] };
    const allTools = toolRegistry.getAll({});
    return {
      tools: allTools.map((t) => ({
        id: t.id,
        description: t.description,
        permission: t.permission,
        group: t.group || "",
      })),
      total: allTools.length,
    };
  }

  async handleGatewayStatus(session, params) {
    this.requireAuth(session);
    return {
      overview: this.agent.gateway.getOverview(),
      events: this.agent.gateway.listEvents(20),
      runs: this.agent.gateway.listRuns(10),
    };
  }

  async handleGatewayEvents(session, params) {
    this.requireAuth(session);
    const { limit, type } = params || {};
    return { events: this.agent.gateway.listEvents(Number(limit || 50), type || "") };
  }

  async handleAgentSend(session, params) {
    this.requireAuth(session);
    const { agentId, message } = params;
    if (!message) throw new Error("'message' is required.");
    return { sent: true, agentId: agentId || "main" };
  }

  async handleAgentsList(session, params) {
    this.requireAuth(session);
    const agents = this.agent.agents?.getAll?.() || [];
    return { agents };
  }

  async handleMemoryOverview(session, params) {
    this.requireAuth(session);
    const { agentId } = params || {};
    return {
      notes: this.agent.memory.getNotes(agentId || "main"),
      conversations: this.agent.memory.getRecentConversations(10, agentId || "main"),
      longTerm: this.agent.memory.getLongTermMemory(20, agentId || "main"),
      dreams: this.agent.memory.getDreams(10, agentId || "main"),
    };
  }

  async handleMemoryPromote(session, params) {
    this.requireAuth(session, "operator.write");
    const { noteId, agentId, summary } = params;
    if (!noteId) throw new Error("'noteId' is required.");
    const result = this.agent.memory.promoteMemory({ noteId, agentId: agentId || "main", summary });
    return { promoted: true, ...result };
  }

  async handleMemorySearch(session, params) {
    this.requireAuth(session);
    const { query, agentId, limit } = params;
    if (!query) throw new Error("'query' is required.");
    const conversations = this.agent.memory.getRecentConversations(Number(limit || 20), agentId || "main");
    const results = conversations.filter((c) =>
      c.text?.toLowerCase().includes(query.toLowerCase())
    );
    return { query, results, total: results.length };
  }

  async handleDelegationsList(session, params) {
    this.requireAuth(session);
    const { limit, status, agentId } = params || {};
    return {
      delegations: this.agent.gateway.listDelegations({
        limit: Number(limit || 20),
        status: status || "",
        agentId: agentId || "",
      }),
    };
  }

  async handleDelegationsCreate(session, params) {
    this.requireAuth(session, "operator.write");
    const { sourceAgentId, targetAgentId, instruction, parentSessionId } = params;
    if (!instruction) throw new Error("'instruction' is required.");
    const result = this.agent.queueDelegation({
      sourceAgentId: sourceAgentId || "main",
      targetAgentId,
      instruction,
      parentSessionId: parentSessionId || "",
      source: "websocket",
    });
    return result;
  }

  async handleDelegationsCancel(session, params) {
    this.requireAuth(session, "operator.write");
    const { delegationId } = params;
    if (!delegationId) throw new Error("'delegationId' is required.");
    return this.agent.cancelDelegation(delegationId, "ws-cancel");
  }

  async handleApprovalsList(session, params) {
    this.requireAuth(session);
    return { approvals: this.agent.gateway.listApprovals() };
  }

  async handleApprovalsResolve(session, params) {
    this.requireAuth(session, "operator.approvals");
    const { approvalId, action } = params;
    if (!approvalId) throw new Error("'approvalId' is required.");
    return this.agent.gateway.resolveApproval(approvalId, action === "approve");
  }

  async handleCronList(session, params) {
    this.requireAuth(session);
    const schedules = this.agent.schedules?.listSchedules?.() || [];
    return { schedules, total: schedules.length };
  }

  async handleCronCreate(session, params) {
    this.requireAuth(session, "operator.write");
    const { schedule, expression, tool, enabled } = params;
    if (!expression) throw new Error("'expression' is required.");
    return { created: true, expression };
  }

  async handleCronDelete(session, params) {
    this.requireAuth(session, "operator.write");
    const { scheduleId } = params;
    if (!scheduleId) throw new Error("'scheduleId' is required.");
    return { deleted: true, scheduleId };
  }

  async handleCronToggle(session, params) {
    this.requireAuth(session, "operator.write");
    const { scheduleId, enabled } = params;
    if (!scheduleId) throw new Error("'scheduleId' is required.");
    return { toggled: true, scheduleId, enabled: enabled !== false };
  }

  async handleChannelsList(session, params) {
    this.requireAuth(session);
    const connectors = this.agent.connectors?.getAdapterStatus?.() || [];
    return { channels: connectors, total: connectors.length };
  }

  async handleChannelsStatus(session, params) {
    this.requireAuth(session);
    const { adapterId } = params;
    if (!adapterId) throw new Error("'adapterId' is required.");
    return { adapterId, status: "unknown" };
  }

  async handleHealthCheck(session, params) {
    return {
      ok: true,
      name: "OmniClaw",
      version: "0.1.0",
      uptime: Math.round(process.uptime()),
      provider: this.agent.getProviderInfo(),
      timestamp: new Date().toISOString(),
    };
  }

  requireAuth(session, requiredScope) {
    if (!session.authenticated) {
      throw new Error("Authentication required. Send a 'connect' request first.");
    }
    if (requiredScope && !session.scopes.includes(requiredScope)) {
      throw new Error(`Insufficient permissions. Required scope: ${requiredScope}`);
    }
  }

  broadcastEvent(method, params) {
    const frame = createEvent(method, params);
    for (const [clientId, session] of this.clients) {
      if (session.authenticated && session.ws.readyState === 1) {
        session.send(frame);
      }
    }
  }

  subscribe(clientId, eventFilter) {
    if (!this.eventSubscriptions.has(clientId)) {
      this.eventSubscriptions.set(clientId, new Set());
    }
    this.eventSubscriptions.get(clientId).add(eventFilter);
  }

  unsubscribeAll(clientId) {
    this.eventSubscriptions.delete(clientId);
  }

  getActiveClients() {
    const clients = [];
    for (const [id, session] of this.clients) {
      clients.push({
        id,
        authenticated: session.authenticated,
        role: session.role,
        connectedAt: session.connectedAt,
        messageCount: session.messageCount,
        lastActivity: new Date(session.lastActivity).toISOString(),
      });
    }
    return clients;
  }

  getStatus() {
    return {
      activeClients: this.clients.size,
      authenticatedClients: Array.from(this.clients.values()).filter((s) => s.authenticated).length,
      uptime: Math.round(process.uptime()),
    };
  }
}
