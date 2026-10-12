import { EventEmitter } from "node:events";
import { verifyTelegramToken, getWebhookConflict, sendTelegramMessage, telegramCall } from "./telegram-api.js";

export class ChannelBase extends EventEmitter {
  constructor({ id, name, type, config }) {
    super();
    this.id = id;
    this.name = name;
    this.type = type;
    this.config = config || {};
    this.connected = false;
    this.startedAt = null;
    this.messageCount = 0;
    this.errorCount = 0;
  }

  async start() {
    throw new Error("start() must be implemented by subclass");
  }

  async stop() {
    throw new Error("stop() must be implemented by subclass");
  }

  async sendMessage(chatId, text, options = {}) {
    throw new Error("sendMessage() must be implemented by subclass");
  }

  onMessage(handler) {
    this.on("message", handler);
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      connected: this.connected,
      startedAt: this.startedAt,
      messageCount: this.messageCount,
      errorCount: this.errorCount,
    };
  }
}

export class TelegramChannel extends ChannelBase {
  constructor({ config, gatewayStore, agentRuntime }) {
    super({ id: "telegram", name: "Telegram", type: "telegram", config });
    this.gatewayStore = gatewayStore;
    this.agentRuntime = agentRuntime;
    this.botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
    this.polling = false;
    this.offset = 0;
    this.pollInterval = null;
    this.bot = null;
    this.lastError = "";
    this.consecutiveErrors = 0;
  }

  async start() {
    if (!this.botToken) {
      throw new Error("Telegram bot token not configured.");
    }
    // Verify against Telegram before claiming to be connected. Flipping
    // `connected = true` on nothing but the presence of a string is how a
    // revoked token used to look like a healthy channel forever.
    const identity = await verifyTelegramToken(this.botToken);
    if (!identity.ok) {
      this.connected = false;
      this.lastError = identity.error;
      throw new Error(`Telegram connect failed: ${identity.error}`);
    }
    this.bot = identity.bot;

    // getUpdates returns 409 for as long as a webhook is registered, so polling
    // would spin forever receiving nothing. Say so instead.
    const webhook = await getWebhookConflict(this.botToken);
    if (webhook.ok && webhook.conflictsWithPolling) {
      this.connected = false;
      this.lastError = `A webhook is registered (${webhook.url}); polling cannot receive updates until it is deleted.`;
      throw new Error(`Telegram connect failed: ${this.lastError}`);
    }

    this.connected = true;
    this.lastError = "";
    this.consecutiveErrors = 0;
    this.startedAt = new Date().toISOString();
    this.polling = true;
    this.startPolling();
    return { status: "started", channel: "telegram", bot: this.bot };
  }

  getStatus() {
    return { ...super.getStatus(), bot: this.bot, lastError: this.lastError };
  }

  async stop() {
    this.polling = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    return { status: "stopped", channel: "telegram" };
  }

  startPolling() {
    if (!this.polling) return;
    this.pollUpdates().catch(() => {});
  }

  async pollUpdates() {
    if (!this.polling) return;
    // Swallowing every failure into a counter meant a wrong token, a 409
    // webhook conflict and a dead network were all indistinguishable from
    // "nobody has messaged yet". Keep the reason, and back off instead of
    // hammering the API once per second while it is failing.
    let delayMs = 1000;
    const updates = await telegramCall(
      this.botToken,
      "getUpdates",
      { offset: this.offset, limit: 10, timeout: 30 },
      { timeoutMs: 40_000 },
    );

    if (!updates.ok) {
      this.errorCount++;
      this.consecutiveErrors++;
      this.lastError = updates.error;
      if (updates.retryAfter) {
        delayMs = Math.max(delayMs, Number(updates.retryAfter) * 1000);
      } else {
        delayMs = Math.min(60_000, 1000 * 2 ** Math.min(this.consecutiveErrors, 6));
      }
    } else {
      this.consecutiveErrors = 0;
      this.lastError = "";
      for (const update of updates.result || []) {
        this.offset = update.update_id + 1;
        const message = update.message;
        if (!message) continue;
        this.messageCount++;
        this.emit("message", {
          channel: "telegram",
          chatId: String(message.chat?.id ?? ""),
          userId: String(message.from?.id ?? ""),
          text: message.text || "",
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (!this.polling) return;
    this.pollInterval = setTimeout(() => this.pollUpdates(), delayMs);
  }

  async sendMessage(chatId, text, options = {}) {
    return sendTelegramMessage(this.botToken, chatId, text, {
      parseMode: options.parseMode || "Markdown",
      disablePreview: options.disablePreview,
      replyToMessageId: options.replyToMessageId,
    });
  }
}

export class DiscordChannel extends ChannelBase {
  constructor({ config, gatewayStore, agentRuntime }) {
    super({ id: "discord", name: "Discord", type: "discord", config });
    this.gatewayStore = gatewayStore;
    this.agentRuntime = agentRuntime;
    this.botToken = config?.botToken || process.env.DISCORD_BOT_TOKEN || "";
    this.client = null;
  }

  async start() {
    if (!this.botToken) {
      throw new Error("Discord bot token not configured.");
    }
    this.connected = true;
    this.startedAt = new Date().toISOString();
    return { status: "started", channel: "discord" };
  }

  async stop() {
    this.connected = false;
    return { status: "stopped", channel: "discord" };
  }

  async sendMessage(channelId, text, options = {}) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const body = { content: text };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${this.botToken}`,
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }
}

export class ChannelManager {
  constructor({ configStore, gatewayStore, agentRuntime }) {
    this.configStore = configStore;
    this.gatewayStore = gatewayStore;
    this.agentRuntime = agentRuntime;
    this.channels = new Map();
  }

  register(channel) {
    this.channels.set(channel.id, channel);
  }

  get(id) {
    return this.channels.get(id);
  }

  getAll() {
    return Array.from(this.channels.values());
  }

  async startAll() {
    const results = [];
    for (const channel of this.channels.values()) {
      try {
        const result = await channel.start();
        results.push({ id: channel.id, status: "started" });
      } catch (error) {
        results.push({ id: channel.id, status: "failed", error: error.message });
      }
    }
    return results;
  }

  async stopAll() {
    const results = [];
    for (const channel of this.channels.values()) {
      try {
        const result = await channel.stop();
        results.push({ id: channel.id, status: "stopped" });
      } catch (error) {
        results.push({ id: channel.id, status: "failed", error: error.message });
      }
    }
    return results;
  }

  getStatus() {
    return {
      channels: this.getAll().map((c) => c.getStatus()),
      total: this.channels.size,
      connected: this.getAll().filter((c) => c.connected).length,
    };
  }
}
