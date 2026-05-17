import { EventEmitter } from "node:events";

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
  }

  async start() {
    if (!this.botToken) {
      throw new Error("Telegram bot token not configured.");
    }
    this.connected = true;
    this.startedAt = new Date().toISOString();
    this.polling = true;
    this.startPolling();
    return { status: "started", channel: "telegram" };
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
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.offset}&limit=10&timeout=30`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          this.offset = update.update_id + 1;
          if (update.message) {
            this.messageCount++;
            this.emit("message", {
              channel: "telegram",
              chatId: String(update.message.chat.id),
              userId: String(update.message.from.id),
              text: update.message.text || "",
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    } catch (error) {
      this.errorCount++;
    }
    this.pollInterval = setTimeout(() => this.pollUpdates(), 1000);
  }

  async sendMessage(chatId, text, options = {}) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || "Markdown",
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
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
