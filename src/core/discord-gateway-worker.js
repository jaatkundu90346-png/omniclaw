function truncate(value, max = 1900) {
  const text = String(value == null ? "" : value).trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 18))}...[truncated]`;
}

function getAuthorName(author = {}) {
  return author.global_name || author.username || "Discord user";
}

function extractDiscordAttachments(data = {}) {
  const attachments = [];
  for (const item of data.attachments || []) {
    attachments.push({
      type: "attachment",
      id: item.id || "",
      name: item.filename || "",
      mimeType: item.content_type || "",
      size: Number(item.size || 0),
      width: Number(item.width || 0),
      height: Number(item.height || 0),
      duration: Number(item.duration_secs || 0),
      url: item.url || item.proxy_url || "",
    });
  }
  for (const embed of data.embeds || []) {
    attachments.push({
      type: `embed:${embed.type || "rich"}`,
      id: embed.url || embed.title || "",
      name: embed.title || embed.provider?.name || "",
      mimeType: "discord/embed",
      size: 0,
      width: Number(embed.image?.width || embed.thumbnail?.width || 0),
      height: Number(embed.image?.height || embed.thumbnail?.height || 0),
      duration: 0,
      url: embed.url || embed.image?.url || embed.thumbnail?.url || "",
    });
  }
  for (const sticker of data.sticker_items || []) {
    attachments.push({
      type: "sticker",
      id: sticker.id || "",
      name: sticker.name || "",
      mimeType: sticker.format_type ? `discord/sticker-${sticker.format_type}` : "discord/sticker",
      size: 0,
      width: 0,
      height: 0,
      duration: 0,
      url: "",
    });
  }
  return attachments;
}

function summarizeAttachments(attachments = []) {
  return attachments
    .map((item) => {
      const name = item.name ? `:${item.name}` : "";
      const size = item.size ? ` ${item.size}b` : "";
      const shape = item.width && item.height ? ` ${item.width}x${item.height}` : "";
      return `${item.type}${name}${shape}${size}`.trim();
    })
    .join("; ");
}

function gatewaySocketUrl(url) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  return base.includes("?") ? base : `${base}/?v=10&encoding=json`;
}

async function fetchLimitedBuffer(url, { maxBytes = 5_000_000 } = {}) {
  if (String(url || "").toLowerCase().startsWith("data:")) {
    const match = String(url).match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
    if (!match) {
      throw new Error("Invalid data URL attachment.");
    }
    const mimeType = match[1] || "";
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || "";
    const buffer = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    if (buffer.length > maxBytes) {
      throw new Error(`Attachment is too large (${buffer.length} bytes > ${maxBytes} bytes).`);
    }
    return {
      buffer,
      mimeType,
    };
  }

  const response = await fetch(url);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Attachment is too large (${contentLength} bytes > ${maxBytes} bytes).`);
  }
  if (!response.ok) {
    throw new Error(`Attachment download failed: ${response.statusText || response.status}`);
  }

  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Attachment is too large (${buffer.length} bytes > ${maxBytes} bytes).`);
    }
    return {
      buffer,
      mimeType: response.headers.get("content-type") || "",
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`Attachment is too large (${total} bytes > ${maxBytes} bytes).`);
    }
    chunks.push(chunk);
  }

  return {
    buffer: Buffer.concat(chunks),
    mimeType: response.headers.get("content-type") || "",
  };
}

function extractMessageCreate(payload = {}) {
  const data = payload.d || payload;
  const content = String(data.content || "").trim();
  if (data.author?.bot) {
    return null;
  }
  const attachments = extractDiscordAttachments(data);
  if (!content && attachments.length === 0) {
    return null;
  }
  return {
    id: data.id || "",
    channelId: data.channel_id || "",
    guildId: data.guild_id || "",
    author: getAuthorName(data.author || {}),
    username: data.author?.username || "",
    content,
    attachments,
    attachmentSummary: summarizeAttachments(attachments),
  };
}

export class DiscordGatewayWorker {
  constructor({ connectorStore, gatewayStore, agentRuntime, apiBase = "https://discord.com/api/v10" }) {
    this.connectorStore = connectorStore;
    this.gatewayStore = gatewayStore;
    this.agentRuntime = agentRuntime;
    this.apiBase = apiBase;
    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.suppressNextCloseReconnect = false;
    this.running = false;
    this.connecting = false;
    this.connected = false;
    this.reconnecting = false;
    this.resumeRequested = false;
    this.sessionId = "";
    this.resumeGatewayUrl = "";
    this.lastSequence = null;
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.lastConnectedAt = null;
    this.lastReconnectAt = null;
    this.lastReconnectReason = "";
    this.lastEventAt = null;
    this.lastHeartbeatSentAt = null;
    this.lastHeartbeatAckAt = null;
    this.lastError = "";
    this.reconnectAttempts = 0;
    this.reconnectDelayMs = 0;
    this.maxReconnectDelayMs = 30000;
  }

  getStatus() {
    const adapter = this.connectorStore.getAdapter("discord");
    return {
      running: this.running,
      connecting: this.connecting,
      connected: this.connected,
      reconnecting: this.reconnecting,
      reconnectAttempts: this.reconnectAttempts,
      reconnectDelayMs: this.reconnectDelayMs,
      lastReconnectAt: this.lastReconnectAt,
      lastReconnectReason: this.lastReconnectReason,
      resumeReady: Boolean(this.sessionId && this.lastSequence != null),
      sessionId: this.sessionId,
      resumeGatewayUrl: this.resumeGatewayUrl,
      lastSequence: this.lastSequence,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      lastConnectedAt: this.lastConnectedAt,
      lastEventAt: this.lastEventAt,
      lastHeartbeatSentAt: this.lastHeartbeatSentAt,
      lastHeartbeatAckAt: this.lastHeartbeatAckAt,
      lastError: this.lastError,
      adapter,
    };
  }

  start(input = {}) {
    const adapter = this.connectorStore.getAdapter("discord");
    if (!adapter.enabled) {
      throw new Error("Discord adapter is disabled.");
    }
    if (adapter.status !== "configured") {
      throw new Error("Discord adapter needs a bot token before gateway start.");
    }
    if (this.running) {
      return this.getStatus();
    }

    this.running = true;
    this.maxReconnectDelayMs = Math.max(1000, Number(input.maxReconnectDelayMs || this.maxReconnectDelayMs));
    this.lastStartedAt = new Date().toISOString();
    this.lastStoppedAt = null;
    this.lastError = "";
    this.gatewayStore.addEvent("connector.discord_worker_started", {
      agentId: adapter.defaultAgentId,
      connectNow: input.connectNow !== false,
    });

    if (input.connectNow !== false) {
      void this.connect().catch(() => {});
    }
    return this.getStatus();
  }

  stop(reason = "manual-stop") {
    this.running = false;
    this.connecting = false;
    this.connected = false;
    this.reconnecting = false;
    this.resumeRequested = false;
    this.lastStoppedAt = new Date().toISOString();
    this.clearHeartbeat();
    this.clearReconnect();
    if (this.socket) {
      try {
        this.socket.close(1000, reason);
      } catch {
        // ignore socket close errors
      }
      this.socket = null;
    }
    this.gatewayStore.addEvent("connector.discord_worker_stopped", {
      reason,
    });
    return this.getStatus();
  }

  async connect(input = {}) {
    if (!this.running || this.connecting || this.connected) {
      return this.getStatus();
    }
    const token = this.connectorStore.getAdapterSecret("discord", "botToken");
    if (!token) {
      throw new Error("Discord bot token is missing from local secret store.");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("This Node runtime does not provide a WebSocket client.");
    }

    this.connecting = true;
    try {
      const resume = Boolean(input.resume && this.sessionId && this.lastSequence != null);
      let gatewayBaseUrl = resume ? this.resumeGatewayUrl : "";
      if (!gatewayBaseUrl) {
        const response = await fetch(`${this.apiBase}/gateway/bot`, {
          headers: {
            Authorization: `Bot ${token}`,
          },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.url) {
          throw new Error(`Discord gateway lookup failed: ${data.message || response.statusText || response.status}`);
        }
        gatewayBaseUrl = data.url;
      }
      const gatewayUrl = gatewaySocketUrl(gatewayBaseUrl);
      this.resumeRequested = resume;
      this.socket = new WebSocket(gatewayUrl);
      this.socket.addEventListener("open", () => {
        this.connected = true;
        this.connecting = false;
        this.reconnecting = false;
        this.lastConnectedAt = new Date().toISOString();
        this.gatewayStore.addEvent("connector.discord_connected", {
          gatewayUrl: gatewayBaseUrl,
          resume,
        });
      });
      this.socket.addEventListener("message", (event) => {
        void this.handleRawMessage(event.data);
      });
      this.socket.addEventListener("close", (event) => {
        this.connected = false;
        this.connecting = false;
        this.socket = null;
        this.clearHeartbeat();
        this.gatewayStore.addEvent("connector.discord_disconnected", {
          code: event.code,
          reason: event.reason || "",
        });
        if (this.suppressNextCloseReconnect) {
          this.suppressNextCloseReconnect = false;
          return;
        }
        if (this.running) {
          this.scheduleReconnect(`socket-close-${event.code || "unknown"}`, this.canResume());
        }
      });
      this.socket.addEventListener("error", () => {
        this.lastError = "Discord gateway socket error.";
        this.gatewayStore.addEvent("connector.discord_socket_error", {
          error: this.lastError,
        });
      });
    } catch (error) {
      this.connecting = false;
      this.connected = false;
      this.resumeRequested = false;
      this.lastError = error.message;
      this.connectorStore.updateAdapterRuntime("discord", {
        lastEventAt: new Date().toISOString(),
        lastEventStatus: "error",
        lastEventMessage: error.message,
      });
      this.gatewayStore.addEvent("connector.discord_connect_failed", {
        error: error.message,
      });
      if (this.running) {
        this.scheduleReconnect("connect-failed", this.canResume());
      }
      throw error;
    }
    return this.getStatus();
  }

  async dispatch(input = {}) {
    const adapter = this.connectorStore.getAdapter("discord");
    if (!adapter.enabled) {
      throw new Error("Discord adapter is disabled.");
    }
    if (adapter.status !== "configured" && !Array.isArray(input.mockEvents)) {
      throw new Error("Discord adapter needs a bot token before gateway dispatch.");
    }

    const events = Array.isArray(input.mockEvents) ? input.mockEvents : [input.event || input.payload].filter(Boolean);
    const processed = [];
    for (const event of events) {
      const payload = event?.op != null || event?.t ? event : { op: 0, t: "MESSAGE_CREATE", d: event };
      const result = await this.handleDispatch(payload, {
        source: input.source || "discord-dry-run",
        reply: input.reply === true,
      });
      if (result) {
        processed.push(result);
      }
    }

    const updatedAdapter = this.connectorStore.updateAdapterRuntime("discord", {
      lastEventAt: new Date().toISOString(),
      lastEventStatus: "ok",
      lastEventMessage: `Processed ${processed.length} event(s).`,
      lastSequence: this.lastSequence || adapter.lastSequence || 0,
      totalEvents: Number(adapter.totalEvents || 0) + processed.length,
    });
    this.gatewayStore.addEvent("connector.discord_dispatched", {
      processed: processed.length,
      source: input.source || "manual",
    });
    return {
      processed,
      adapter: updatedAdapter,
    };
  }

  async handleRawMessage(data) {
    let payload;
    try {
      payload = JSON.parse(String(data || "{}"));
    } catch {
      this.lastError = "Invalid Discord gateway payload.";
      return;
    }
    await this.handleGatewayPayload(payload);
  }

  async handleGatewayPayload(payload = {}) {
    if (payload.s != null) {
      this.lastSequence = payload.s;
    }

    if (payload.op === 10) {
      this.startHeartbeat(Number(payload.d?.heartbeat_interval || 45000));
      if (this.resumeRequested && this.canResume()) {
        this.resume();
      } else {
        this.resumeRequested = false;
        this.identify();
      }
      return null;
    }
    if (payload.op === 11) {
      this.lastHeartbeatAckAt = new Date().toISOString();
      return null;
    }
    if (payload.op === 1) {
      this.sendHeartbeat();
      return null;
    }
    if (payload.op === 7) {
      this.lastError = "Discord requested reconnect.";
      this.scheduleReconnect("discord-reconnect-requested", this.canResume(), { closeSocket: true });
      return null;
    }
    if (payload.op === 9) {
      this.lastError = "Discord reported invalid session.";
      if (!payload.d) {
        this.sessionId = "";
        this.resumeGatewayUrl = "";
        this.lastSequence = null;
      }
      this.scheduleReconnect("discord-invalid-session", Boolean(payload.d && this.canResume()), { closeSocket: true });
      return null;
    }
    if (payload.op === 0) {
      return this.handleDispatch(payload, {
        source: "discord-gateway",
        reply: true,
      });
    }
    return null;
  }

  async handleDispatch(payload = {}, { source = "discord-gateway", reply = false } = {}) {
    if (payload.s != null) {
      this.lastSequence = payload.s;
    }
    if (payload.t === "READY") {
      this.sessionId = payload.d?.session_id || this.sessionId;
      this.resumeGatewayUrl = payload.d?.resume_gateway_url || this.resumeGatewayUrl;
      this.resumeRequested = false;
      this.reconnectAttempts = 0;
      this.reconnectDelayMs = 0;
      this.lastEventAt = new Date().toISOString();
      this.connectorStore.updateAdapterRuntime("discord", {
        lastEventAt: this.lastEventAt,
        lastEventStatus: "ready",
        lastEventMessage: "Discord READY received.",
        lastSequence: this.lastSequence || 0,
        resumeGatewayUrl: this.resumeGatewayUrl,
      });
      return null;
    }
    if (payload.t === "RESUMED") {
      this.resumeRequested = false;
      this.reconnectAttempts = 0;
      this.reconnectDelayMs = 0;
      this.lastEventAt = new Date().toISOString();
      this.connectorStore.updateAdapterRuntime("discord", {
        lastEventAt: this.lastEventAt,
        lastEventStatus: "resumed",
        lastEventMessage: "Discord session resumed.",
        lastSequence: this.lastSequence || 0,
        resumeGatewayUrl: this.resumeGatewayUrl,
      });
      this.gatewayStore.addEvent("connector.discord_resumed", {
        sessionId: this.sessionId,
        sequence: this.lastSequence,
      });
      return null;
    }
    if (payload.t !== "MESSAGE_CREATE") {
      return null;
    }

    const message = extractMessageCreate(payload);
    if (!message) {
      return null;
    }

    const adapter = this.connectorStore.getAdapter("discord");
    const prompt = [
      `Discord message from ${message.author}${message.username ? ` (@${message.username})` : ""}`,
      `Channel: ${message.channelId || "unknown"}${message.guildId ? ` | Guild: ${message.guildId}` : ""}`,
      message.attachmentSummary ? `Attachments: ${message.attachmentSummary}` : "",
      "",
      message.content || "(no text content)",
    ].filter((line) => line !== "").join("\n");
    const result = await this.agentRuntime.handleMessage(prompt, {
      agentId: adapter.defaultAgentId || "main",
      label: `discord:${message.channelId || "unknown"}`,
      channel: "discord",
    });

    const replyText = String(result?.reply || "").trim();
    let replySent = false;
    let replyStatus = reply ? "no-reply" : "disabled";
    let replyError = "";

    if (reply && !message.channelId) {
      replyStatus = "missing-conversation";
    } else if (reply && replyText) {
      try {
        await this.sendMessage(message.channelId, replyText);
        replySent = true;
        replyStatus = "sent";
      } catch (error) {
        replyStatus = "failed";
        replyError = error.message;
      }
    }

    const delivery = this.connectorStore.recordAdapterDelivery({
      adapterId: "discord",
      channel: "discord",
      eventType: "MESSAGE_CREATE",
      externalId: message.id,
      conversationId: message.channelId,
      author: message.author,
      message: message.content || message.attachmentSummary || "Discord attachment message",
      attachments: message.attachments,
      attachmentSummary: message.attachmentSummary,
      agentId: adapter.defaultAgentId || "main",
      label: `discord:${message.channelId || "unknown"}`,
      source,
      status: result.error ? "failed" : replyError ? "reply_failed" : "completed",
      error: result.error || "",
      replySent,
      replyStatus,
      replyError,
      result,
    });
    let outbox = null;
    if (replyError && replyText) {
      outbox = this.connectorStore.recordAdapterOutbox({
        deliveryId: delivery.id,
        adapterId: "discord",
        channel: "discord",
        conversationId: message.channelId,
        externalId: message.id,
        agentId: adapter.defaultAgentId || "main",
        source,
        message: message.content,
        replyText,
        status: "failed",
        error: replyError,
        attempts: 1,
        lastAttemptAt: new Date().toISOString(),
      });
      this.connectorStore.updateAdapterDelivery(delivery.id, {
        outboxId: outbox.id,
      });
    }

    let autoIngestion = null;
    if (delivery.attachmentCount > 0) {
      try {
        autoIngestion = await this.agentRuntime.ingestAdapterDeliveryAttachments(delivery, {
          source: `${source}:discord`,
        });
      } catch (error) {
        autoIngestion = {
          status: "failed",
          error: error.message,
        };
      }
    }

    this.lastEventAt = new Date().toISOString();
    return {
      event: "MESSAGE_CREATE",
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      agentId: adapter.defaultAgentId || "main",
      runId: result.run?.id || "",
      sessionId: result.session?.id || "",
      deliveryId: delivery.id,
      outboxId: outbox?.id || "",
      attachmentCount: message.attachments.length,
      autoIngestion,
      replySent,
      replyStatus,
      source,
    };
  }

  async retryOutbox(outboxId) {
    const item = this.connectorStore.getAdapterOutboxItem(outboxId);
    if (item.adapterId !== "discord") {
      throw new Error(`Outbox item ${item.id} belongs to ${item.adapterId || "another adapter"}.`);
    }
    const adapter = this.connectorStore.getAdapter("discord");
    if (!adapter.enabled || adapter.status !== "configured") {
      throw new Error("Discord adapter must be enabled and configured before retry.");
    }
    if (!item.conversationId || !item.replyText) {
      throw new Error("Discord outbox item is missing channel id or reply text.");
    }

    try {
      const response = await this.sendMessage(item.conversationId, item.replyText);
      const outbox = this.connectorStore.markAdapterOutboxAttempt(item.id, {
        status: "sent",
        error: "",
      });
      this.connectorStore.updateAdapterDelivery(item.deliveryId, {
        status: "completed",
        replySent: true,
        replyStatus: "sent",
        replyError: "",
        outboxId: item.id,
      });
      this.gatewayStore.addEvent("connector.discord_outbox_sent", {
        outboxId: item.id,
        deliveryId: item.deliveryId,
      });
      return {
        outbox,
        response,
        adapter: this.getStatus().adapter,
      };
    } catch (error) {
      const outbox = this.connectorStore.markAdapterOutboxAttempt(item.id, {
        status: "failed",
        error: error.message,
      });
      this.connectorStore.updateAdapterDelivery(item.deliveryId, {
        replySent: false,
        replyStatus: "failed",
        replyError: error.message,
        outboxId: item.id,
      });
      this.gatewayStore.addEvent("connector.discord_outbox_failed", {
        outboxId: item.id,
        deliveryId: item.deliveryId,
        error: error.message,
      });
      throw Object.assign(new Error(error.message), { outbox });
    }
  }

  async cacheAttachment(input = {}) {
    const { delivery, attachment, attachmentIndex } = this.connectorStore.getAdapterDeliveryAttachment(input);
    if (delivery.adapterId !== "discord") {
      throw new Error(`Delivery ${delivery.id} belongs to ${delivery.adapterId || "another adapter"}.`);
    }
    if (!attachment.url) {
      throw new Error("Discord attachment has no downloadable URL.");
    }

    try {
      const downloaded = await fetchLimitedBuffer(attachment.url, {
        maxBytes: Math.max(1024, Number(input.maxBytes || 5_000_000)),
      });
      const result = this.connectorStore.recordAdapterAttachmentCache({
        deliveryId: delivery.id,
        adapterId: "discord",
        attachment,
        attachmentIndex,
        contentBuffer: downloaded.buffer,
        mimeType: downloaded.mimeType || attachment.mimeType,
        sourceUrl: attachment.url,
        status: "cached",
      });
      this.gatewayStore.addEvent("connector.discord_attachment_cached", {
        deliveryId: delivery.id,
        cacheId: result.cache.id,
        byteLength: result.cache.byteLength,
      });
      return result;
    } catch (error) {
      const result = this.connectorStore.recordAdapterAttachmentCache({
        deliveryId: delivery.id,
        adapterId: "discord",
        attachment,
        attachmentIndex,
        sourceUrl: attachment.url,
        status: "failed",
        error: error.message,
      });
      this.gatewayStore.addEvent("connector.discord_attachment_cache_failed", {
        deliveryId: delivery.id,
        cacheId: result.cache.id,
        error: error.message,
      });
      throw Object.assign(new Error(error.message), result);
    }
  }

  identify() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const token = this.connectorStore.getAdapterSecret("discord", "botToken");
    const intents = 1 | 512 | 4096 | 32768;
    this.socket.send(
      JSON.stringify({
        op: 2,
        d: {
          token,
          intents,
          properties: {
            os: "windows",
            browser: "omniclaw",
            device: "omniclaw",
          },
        },
      }),
    );
  }

  resume() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.canResume()) {
      this.resumeRequested = false;
      this.identify();
      return;
    }
    const token = this.connectorStore.getAdapterSecret("discord", "botToken");
    this.socket.send(
      JSON.stringify({
        op: 6,
        d: {
          token,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
      }),
    );
    this.gatewayStore.addEvent("connector.discord_resume_sent", {
      sessionId: this.sessionId,
      sequence: this.lastSequence,
    });
  }

  canResume() {
    return Boolean(this.sessionId && this.lastSequence != null);
  }

  scheduleReconnect(reason = "reconnect", resume = true, { closeSocket = false } = {}) {
    if (!this.running) {
      return;
    }
    this.clearReconnect();
    this.clearHeartbeat();
    this.connected = false;
    this.connecting = false;
    this.reconnecting = true;
    this.resumeRequested = Boolean(resume && this.canResume());
    this.lastReconnectAt = new Date().toISOString();
    this.lastReconnectReason = reason;
    this.reconnectAttempts += 1;
    this.reconnectDelayMs = Math.min(
      this.maxReconnectDelayMs,
      Math.max(1000, 1000 * 2 ** Math.min(this.reconnectAttempts - 1, 5)),
    );

    if (closeSocket && this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.suppressNextCloseReconnect = true;
      try {
        socket.close(4000, reason);
      } catch {
        // ignore socket close errors
      }
    }

    this.connectorStore.updateAdapterRuntime("discord", {
      lastEventAt: new Date().toISOString(),
      lastEventStatus: "reconnecting",
      lastEventMessage: `${reason}; retry in ${this.reconnectDelayMs}ms.`,
      lastSequence: this.lastSequence || 0,
    });
    this.gatewayStore.addEvent("connector.discord_reconnect_scheduled", {
      reason,
      resume: this.resumeRequested,
      attempt: this.reconnectAttempts,
      delayMs: this.reconnectDelayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) {
        return;
      }
      void this.connect({ resume: this.resumeRequested }).catch(() => {});
    }, this.reconnectDelayMs);
  }

  startHeartbeat(intervalMs) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), Math.max(1000, intervalMs));
    this.sendHeartbeat();
  }

  sendHeartbeat() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.lastHeartbeatSentAt = new Date().toISOString();
    this.socket.send(
      JSON.stringify({
        op: 1,
        d: this.lastSequence,
      }),
    );
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async sendMessage(channelId, content) {
    const token = this.connectorStore.getAdapterSecret("discord", "botToken");
    if (!token) {
      throw new Error("Discord bot token is missing from local secret store.");
    }
    const response = await fetch(`${this.apiBase}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: truncate(content),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Discord send message failed: ${data.message || response.statusText || response.status}`);
    }
    return data;
  }
}
