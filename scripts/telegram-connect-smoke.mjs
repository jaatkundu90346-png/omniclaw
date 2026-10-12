// telegram-connect-smoke — Telegram must tell the TRUTH about being connected.
//
// Before 2026-07-31, connector-store.testAdapter() only checked that a token
// string existed locally, so configure_telegram reported success for a revoked
// or typo'd token and the channel reported `connected: true` while receiving
// nothing. These checks make a real API call and assert the failure paths.
//
// Runs offline-safe: every assertion here uses deliberately invalid tokens, so
// it never needs a real bot. Set TELEGRAM_BOT_TOKEN to additionally verify a
// live token end to end.
//
//   node scripts/telegram-connect-smoke.mjs

import "../src/core/network-bootstrap.js";
import {
  looksLikeBotToken,
  maskToken,
  verifyTelegramToken,
  telegramCall,
} from "../src/core/telegram-api.js";
import { TelegramChannel } from "../src/core/channels.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── Local token shape ───────────────────────────────────────────────────────
check("well-formed token accepted", looksLikeBotToken("123456789:AAF-abcdefghijklmnopqrstuvwxyz12"));
check("prose rejected as token", !looksLikeBotToken("my bot token"));
check("token id-only rejected", !looksLikeBotToken("123456789"));
check("token never echoed in full", maskToken("123456789:AAF-secretpart") === "123456789:******");

// ── Live API: an invalid token must FAIL, not pass ──────────────────────────
const bogus = await verifyTelegramToken("123456789:AAF-definitelynotarealtokenxx");
check("invalid token rejected by live check", bogus.ok === false, `${bogus.code}: ${bogus.error}`);
check("invalid token reports a 401 from Telegram", bogus.code === "telegram-401", `got ${bogus.code}`);

const malformed = await verifyTelegramToken("not-a-token");
check("malformed token caught without a round trip", malformed.code === "malformed-token");

const missing = await verifyTelegramToken("");
check("missing token reported distinctly", missing.code === "no-token");

// ── The channel must refuse to claim it is connected ────────────────────────
{
  const channel = new TelegramChannel({ config: { botToken: "123456789:AAF-definitelynotarealtokenxx" } });
  let threw = false;
  try {
    await channel.start();
  } catch (error) {
    threw = /Telegram connect failed/.test(error.message);
  }
  check("channel.start() throws on a bad token", threw);
  check("channel stays disconnected after a failed start", channel.connected === false);
  check("channel records why it failed", Boolean(channel.lastError), channel.lastError);
}

// ── Errors are surfaced, not swallowed ──────────────────────────────────────
{
  const result = await telegramCall("123456789:AAF-definitelynotarealtokenxx", "getUpdates", { limit: 1 });
  check("telegramCall resolves (never throws) on failure", result.ok === false && typeof result.error === "string", result.error);
}

// ── Optional: a real token, when one is provided ────────────────────────────
const liveToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (liveToken) {
  const live = await verifyTelegramToken(liveToken);
  check("live TELEGRAM_BOT_TOKEN verifies", live.ok === true, live.ok ? `@${live.bot.username}` : live.error);
} else {
  console.log("SKIP  live token check — set TELEGRAM_BOT_TOKEN to enable");
}

console.log(failures === 0 ? "\ntelegram-connect-smoke: all checks passed" : `\ntelegram-connect-smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
