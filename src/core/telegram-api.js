// Thin, honest wrapper over the Telegram Bot API.
//
// Why this exists: connector-store.testAdapter() only checked whether a secret
// STRING was present locally — it never talked to Telegram. So `configure_telegram`
// answered `ok: true` for a typo'd or revoked token, the polling worker then
// failed silently, and the user was told they were connected while nothing
// worked. Everything here makes a real call and reports what Telegram actually
// said.
//
// Note: outbound requests only work because src/core/network-bootstrap.js
// disables Happy Eyeballs — api.telegram.org resolves to a dead NAT64 address
// alongside its good IPv4 one on some networks.

const API_ROOT = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Bot tokens look like `123456789:AA...` — reject obvious junk before a round trip. */
export function looksLikeBotToken(token) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(token || "").trim());
}

/** Never echo a token back into a tool result, a log line, or an event. */
export function maskToken(token) {
  const value = String(token || "").trim();
  if (!value) return "";
  const [id] = value.split(":");
  return `${id}:${"*".repeat(6)}`;
}

/**
 * Call one Bot API method. Always resolves — network faults, HTTP errors and
 * Telegram-level `ok:false` all come back as `{ ok: false, error, ... }` so
 * callers never have to distinguish "threw" from "failed".
 */
export async function telegramCall(token, method, payload = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return { ok: false, error: "Telegram bot token is missing.", code: "no-token" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_ROOT}/bot${trimmed}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      return {
        ok: false,
        code: `telegram-${data.error_code || response.status}`,
        error: data.description || response.statusText || `HTTP ${response.status}`,
        httpStatus: response.status,
        retryAfter: data.parameters?.retry_after,
      };
    }
    return { ok: true, result: data.result };
  } catch (error) {
    if (error.name === "AbortError") {
      return { ok: false, code: "timeout", error: `Telegram ${method} timed out after ${timeoutMs}ms.` };
    }
    return {
      ok: false,
      code: "network",
      error: `Telegram ${method} could not reach ${API_ROOT}: ${error.cause?.message || error.message}`,
    };
  }
}

/** Live token check. This is the ONLY trustworthy "am I connected?" signal. */
export async function verifyTelegramToken(token) {
  if (!String(token || "").trim()) {
    return { ok: false, code: "no-token", error: "No bot token configured. Get one from @BotFather." };
  }
  if (!looksLikeBotToken(token)) {
    return {
      ok: false,
      code: "malformed-token",
      error: "That does not look like a bot token. Expected `<digits>:<letters>` exactly as @BotFather sends it.",
    };
  }
  const result = await telegramCall(token, "getMe");
  if (!result.ok) return result;
  const bot = result.result || {};
  return {
    ok: true,
    bot: {
      id: bot.id,
      username: bot.username || "",
      firstName: bot.first_name || "",
      canJoinGroups: Boolean(bot.can_join_groups),
      canReadAllGroupMessages: Boolean(bot.can_read_all_group_messages),
    },
  };
}

/**
 * A registered webhook makes getUpdates fail with 409 Conflict — the single
 * most common reason polling "connects" but receives nothing forever.
 */
export async function getWebhookConflict(token) {
  const info = await telegramCall(token, "getWebhookInfo");
  if (!info.ok) return { ok: false, error: info.error, code: info.code };
  const url = info.result?.url || "";
  return {
    ok: true,
    hasWebhook: Boolean(url),
    url,
    pendingUpdateCount: Number(info.result?.pending_update_count || 0),
    lastErrorMessage: info.result?.last_error_message || "",
    conflictsWithPolling: Boolean(url),
  };
}

/** Drop a webhook so polling can take over. */
export async function deleteWebhook(token, { dropPendingUpdates = false } = {}) {
  return telegramCall(token, "deleteWebhook", { drop_pending_updates: Boolean(dropPendingUpdates) });
}

/** Send a message. `chatId` may be a numeric id or an `@channelusername`. */
export async function sendTelegramMessage(token, chatId, text, { parseMode, disablePreview, replyToMessageId } = {}) {
  const target = String(chatId || "").trim();
  if (!target) return { ok: false, code: "no-chat-id", error: "chatId is required." };
  const body = String(text ?? "");
  if (!body.trim()) return { ok: false, code: "empty-text", error: "text is required." };

  const payload = {
    chat_id: target,
    // Telegram hard-caps a message at 4096 chars and rejects the whole call if
    // it is longer, so trim rather than lose the send.
    text: body.length > 4096 ? `${body.slice(0, 4080)}...[truncated]` : body,
    disable_web_page_preview: disablePreview !== false,
  };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyToMessageId) payload.reply_to_message_id = Number(replyToMessageId);

  const sent = await telegramCall(token, "sendMessage", payload);
  if (!sent.ok) {
    // Markdown is the usual culprit: an unbalanced `*` or `_` in model output
    // makes Telegram reject the entire message. Retry once as plain text so a
    // formatting slip never eats the reply.
    if (parseMode && /can't parse entities/i.test(sent.error || "")) {
      const retry = await telegramCall(token, "sendMessage", { ...payload, parse_mode: undefined });
      if (retry.ok) return { ...retry, parseModeDowngraded: true };
    }
    return sent;
  }
  return sent;
}
