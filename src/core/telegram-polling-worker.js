function truncate(value, max = 3500) {
  const text = String(value == null ? "" : value).trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 18))}...[truncated]`;
}

function fileAttachment(type, file = {}, extras = {}) {
  return {
    type,
    id: file.file_id || "",
    fileUniqueId: file.file_unique_id || "",
    name: file.file_name || "",
    mimeType: file.mime_type || "",
    ...extras,
    size: Number(extras.size || file.file_size || 0),
    width: Number(extras.width || file.width || 0),
    height: Number(extras.height || file.height || 0),
    duration: Number(extras.duration || file.duration || 0),
  };
}

function extractTelegramAttachments(message = {}) {
  const attachments = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = [...message.photo].sort((left, right) => Number(right.file_size || 0) - Number(left.file_size || 0))[0];
    attachments.push(fileAttachment("photo", largest));
  }
  for (const type of ["document", "video", "animation", "audio", "voice", "video_note", "sticker"]) {
    if (message[type]) {
      attachments.push(fileAttachment(type, message[type], {
        name: message[type].file_name || message[type].emoji || "",
      }));
    }
  }
  if (message.contact) {
    attachments.push({
      type: "contact",
      id: String(message.contact.user_id || ""),
      name: [message.contact.first_name, message.contact.last_name].filter(Boolean).join(" "),
      mimeType: "telegram/contact",
      size: 0,
      width: 0,
      height: 0,
      duration: 0,
    });
  }
  if (message.location) {
    attachments.push({
      type: "location",
      id: `${message.location.latitude || 0},${message.location.longitude || 0}`,
      name: "shared location",
      mimeType: "telegram/location",
      size: 0,
      width: 0,
      height: 0,
      duration: 0,
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

async function fetchLimitedBuffer(url, { maxBytes = 5_000_000 } = {}) {
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

function extractTelegramMessage(update = {}) {
  const message =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    null;
  if (!message) {
    return null;
  }

  const text = String(message.text || message.caption || "").trim();
  const attachments = extractTelegramAttachments(message);
  if (!text && attachments.length === 0) {
    return null;
  }

  const chat = message.chat || {};
  const from = message.from || {};
  const author = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Telegram user";
  return {
    updateId: Number(update.update_id || 0),
    messageId: Number(message.message_id || 0),
    chatId: chat.id,
    chatType: chat.type || "",
    author,
    username: from.username || "",
    text,
    attachments,
    attachmentSummary: summarizeAttachments(attachments),
  };
}

export class TelegramPollingWorker {
  constructor({ connectorStore, gatewayStore, agentRuntime, intervalMs = 5000 }) {
    this.connectorStore = connectorStore;
    this.gatewayStore = gatewayStore;
    this.agentRuntime = agentRuntime;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.polling = false;
    this.lastStartedAt = null;
    this.lastStoppedAt = null;
    this.lastError = "";
  }

  getStatus() {
    const adapter = this.connectorStore.getAdapter("telegram");
    return {
      running: this.running,
      polling: this.polling,
      intervalMs: this.intervalMs,
      lastStartedAt: this.lastStartedAt,
      lastStoppedAt: this.lastStoppedAt,
      lastError: this.lastError,
      adapter,
    };
  }

  start(input = {}) {
    const adapter = this.connectorStore.getAdapter("telegram");
    if (!adapter.enabled) {
      throw new Error("Telegram adapter is disabled.");
    }
    if (adapter.status !== "configured") {
      throw new Error("Telegram adapter needs a bot token before polling can start.");
    }
    if (this.running) {
      return this.getStatus();
    }

    this.intervalMs = Math.max(1000, Number(input.intervalMs || this.intervalMs || 5000));
    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastStoppedAt = null;
    this.lastError = "";
    this.gatewayStore.addEvent("connector.telegram_worker_started", {
      intervalMs: this.intervalMs,
      agentId: adapter.defaultAgentId,
    });
    this.timer = setInterval(() => {
      void this.pollOnce({ limit: Number(input.limit || 10), source: "telegram-worker" });
    }, this.intervalMs);
    if (input.runNow !== false) {
      void this.pollOnce({ limit: Number(input.limit || 10), source: "telegram-worker" });
    }
    return this.getStatus();
  }

  stop(reason = "manual-stop") {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.lastStoppedAt = new Date().toISOString();
    this.gatewayStore.addEvent("connector.telegram_worker_stopped", {
      reason,
    });
    return this.getStatus();
  }

  async pollOnce(input = {}) {
    if (this.polling) {
      return {
        skipped: true,
        reason: "poll-already-running",
        status: this.getStatus(),
      };
    }

    this.polling = true;
    try {
      const adapter = this.connectorStore.getAdapter("telegram");
      if (!adapter.enabled) {
        throw new Error("Telegram adapter is disabled.");
      }
      if (adapter.status !== "configured" && !Array.isArray(input.mockUpdates)) {
        throw new Error("Telegram adapter needs a bot token before polling can start.");
      }

      const updates = Array.isArray(input.mockUpdates)
        ? input.mockUpdates
        : await this.fetchUpdates(adapter, input);
      const processed = await this.processUpdates(updates, {
        adapter,
        source: input.source || (input.mockUpdates ? "telegram-dry-run" : "telegram-poll"),
        reply: input.reply === true || (input.reply !== false && !input.mockUpdates),
      });
      const highestUpdateId = processed.reduce(
        (max, item) => Math.max(max, Number(item.updateId || 0)),
        Number(adapter.lastUpdateId || 0),
      );
      const updatedAdapter = this.connectorStore.updateAdapterRuntime("telegram", {
        lastPollAt: new Date().toISOString(),
        lastPollStatus: "ok",
        lastPollMessage: `Processed ${processed.length} update(s).`,
        lastUpdateId: highestUpdateId,
        totalUpdates: Number(adapter.totalUpdates || 0) + processed.length,
      });
      this.lastError = "";
      this.gatewayStore.addEvent("connector.telegram_polled", {
        processed: processed.length,
        lastUpdateId: highestUpdateId,
        source: input.source || "manual",
      });
      return {
        processed,
        adapter: updatedAdapter,
      };
    } catch (error) {
      this.lastError = error.message;
      const adapter = this.connectorStore.updateAdapterRuntime("telegram", {
        lastPollAt: new Date().toISOString(),
        lastPollStatus: "error",
        lastPollMessage: error.message,
      });
      this.gatewayStore.addEvent("connector.telegram_poll_failed", {
        error: error.message,
      });
      throw Object.assign(new Error(error.message), { adapter });
    } finally {
      this.polling = false;
    }
  }

  async fetchUpdates(adapter, input = {}) {
    const token = this.connectorStore.getAdapterSecret("telegram", "botToken");
    if (!token) {
      throw new Error("Telegram bot token is missing from local secret store.");
    }
    const baseOffset = input.offset != null ? Number(input.offset) : Number(adapter.lastUpdateId || 0);
    const offset = baseOffset > 0 ? baseOffset + 1 : 0;
    const payload = {
      limit: Math.min(100, Math.max(1, Number(input.limit || 10))),
      timeout: Math.max(0, Math.min(10, Number(input.timeoutSeconds || 1))),
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"],
    };
    if (offset > 0) {
      payload.offset = offset;
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`Telegram getUpdates failed: ${data.description || response.statusText || response.status}`);
    }
    return Array.isArray(data.result) ? data.result : [];
  }

  async processUpdates(updates, { adapter, source = "telegram-poll", reply = false } = {}) {
    const processed = [];
    for (const update of updates || []) {
      const message = extractTelegramMessage(update);
      if (!message) {
        continue;
      }

      const prompt = [
        `Telegram message from ${message.author}${message.username ? ` (@${message.username})` : ""}`,
        `Chat: ${message.chatId || "unknown"}${message.chatType ? ` (${message.chatType})` : ""}`,
        message.attachmentSummary ? `Attachments: ${message.attachmentSummary}` : "",
        "",
        message.text || "(no text content)",
      ].filter((line) => line !== "").join("\n");
      const result = await this.agentRuntime.handleMessage(prompt, {
        agentId: adapter.defaultAgentId || "main",
        label: `telegram:${message.chatId || "unknown"}`,
        channel: "telegram",
      });

      const replyText = String(result?.reply || "").trim();
      let replySent = false;
      let replyStatus = reply ? "no-reply" : "disabled";
      let replyError = "";

      if (reply && !message.chatId) {
        replyStatus = "missing-conversation";
      } else if (reply && replyText) {
        try {
          await this.sendMessage(message.chatId, replyText);
          replySent = true;
          replyStatus = "sent";
        } catch (error) {
          replyStatus = "failed";
          replyError = error.message;
        }
      }

      const delivery = this.connectorStore.recordAdapterDelivery({
        adapterId: "telegram",
        channel: "telegram",
        eventType: "message",
        externalId: String(message.updateId || message.messageId || ""),
        conversationId: String(message.chatId || ""),
        author: message.author,
        message: message.text || message.attachmentSummary || "Telegram media message",
        attachments: message.attachments,
        attachmentSummary: message.attachmentSummary,
        agentId: adapter.defaultAgentId || "main",
        label: `telegram:${message.chatId || "unknown"}`,
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
          adapterId: "telegram",
          channel: "telegram",
          conversationId: String(message.chatId || ""),
          externalId: String(message.updateId || message.messageId || ""),
          agentId: adapter.defaultAgentId || "main",
          source,
          message: message.text,
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
            source: `${source}:telegram`,
          });
        } catch (error) {
          autoIngestion = {
            status: "failed",
            error: error.message,
          };
        }
      }

      processed.push({
        updateId: message.updateId,
        messageId: message.messageId,
        chatId: message.chatId,
        agentId: adapter.defaultAgentId || "main",
        runId: result.run?.id || "",
        sessionId: result.session?.id || "",
        deliveryId: delivery.id,
        outboxId: outbox?.id || "",
        attachmentCount: message.attachments.length,
        autoIngestion,
        replySent,
        replyStatus,
      });
    }
    return processed;
  }

  async retryOutbox(outboxId) {
    const item = this.connectorStore.getAdapterOutboxItem(outboxId);
    if (item.adapterId !== "telegram") {
      throw new Error(`Outbox item ${item.id} belongs to ${item.adapterId || "another adapter"}.`);
    }
    const adapter = this.connectorStore.getAdapter("telegram");
    if (!adapter.enabled || adapter.status !== "configured") {
      throw new Error("Telegram adapter must be enabled and configured before retry.");
    }
    if (!item.conversationId || !item.replyText) {
      throw new Error("Telegram outbox item is missing chat id or reply text.");
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
      this.gatewayStore.addEvent("connector.telegram_outbox_sent", {
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
      this.gatewayStore.addEvent("connector.telegram_outbox_failed", {
        outboxId: item.id,
        deliveryId: item.deliveryId,
        error: error.message,
      });
      throw Object.assign(new Error(error.message), { outbox });
    }
  }

  async cacheAttachment(input = {}) {
    const { delivery, attachment, attachmentIndex } = this.connectorStore.getAdapterDeliveryAttachment(input);
    if (delivery.adapterId !== "telegram") {
      throw new Error(`Delivery ${delivery.id} belongs to ${delivery.adapterId || "another adapter"}.`);
    }

    let sourceUrl = attachment.url || "";
    try {
      if (!sourceUrl) {
        sourceUrl = await this.resolveTelegramFileUrl(attachment.id);
      }
      const downloaded = await fetchLimitedBuffer(sourceUrl, {
        maxBytes: Math.max(1024, Number(input.maxBytes || 5_000_000)),
      });
      const result = this.connectorStore.recordAdapterAttachmentCache({
        deliveryId: delivery.id,
        adapterId: "telegram",
        attachment,
        attachmentIndex,
        contentBuffer: downloaded.buffer,
        mimeType: downloaded.mimeType || attachment.mimeType,
        sourceUrl,
        status: "cached",
      });
      this.gatewayStore.addEvent("connector.telegram_attachment_cached", {
        deliveryId: delivery.id,
        cacheId: result.cache.id,
        byteLength: result.cache.byteLength,
      });
      return result;
    } catch (error) {
      const result = this.connectorStore.recordAdapterAttachmentCache({
        deliveryId: delivery.id,
        adapterId: "telegram",
        attachment,
        attachmentIndex,
        sourceUrl,
        status: "failed",
        error: error.message,
      });
      this.gatewayStore.addEvent("connector.telegram_attachment_cache_failed", {
        deliveryId: delivery.id,
        cacheId: result.cache.id,
        error: error.message,
      });
      throw Object.assign(new Error(error.message), result);
    }
  }

  async resolveTelegramFileUrl(fileId) {
    if (!fileId) {
      throw new Error("Telegram attachment has no file id to download.");
    }
    const token = this.connectorStore.getAdapterSecret("telegram", "botToken");
    if (!token) {
      throw new Error("Telegram bot token is missing from local secret store.");
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false || !data.result?.file_path) {
      throw new Error(`Telegram getFile failed: ${data.description || response.statusText || response.status}`);
    }
    return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
  }

  async sendMessage(chatId, text) {
    const token = this.connectorStore.getAdapterSecret("telegram", "botToken");
    if (!token) {
      throw new Error("Telegram bot token is missing from local secret store.");
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncate(text),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`Telegram sendMessage failed: ${data.description || response.statusText || response.status}`);
    }
    return data.result || null;
  }
}
