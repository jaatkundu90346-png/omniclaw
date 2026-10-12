// Provider error classifier.
//
// Adapted from the failover taxonomy in Hermes's agent/error_classifier.py
// (open source) to OmniClaw's single-provider loop. A model/transport call can
// fail for very different reasons, and treating them all as one generic
// "provider failed" both wastes retries (e.g. retrying a 401 or a 404 model id
// never helps) and hides the actual fix from the user. This maps a raw error
// into a category + a retry decision + a sane backoff + an actionable message,
// so the loop can fail fast on permanent errors, back off properly on transient
// ones, and route context-overflow into compaction instead of failover.
//
// Backoff is jittered (Hermes retry_utils.py) and honors the server's real
// reset window when the error carries x-ratelimit-* / retry-after metadata
// (Hermes rate_limit_tracker.py), instead of a blind fixed constant.

import { jitteredBackoff } from "./retry-backoff.js";

// Order matters: billing/auth/context must be tested before the broad
// rate-limit / format buckets, because the same status code (429 / 400) is
// reused by providers for several distinct conditions.
const PATTERNS = [
  // Auth — invalid/expired/missing key. Retrying the identical request is futile.
  { reason: "auth", re: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|incorrect api key|api key.*(invalid|expired|missing|not valid)|authentication (failed|error)|no api key|missing api key/i },
  // Billing — credit/funds/payment exhausted. Needs money or a different key, not a retry.
  { reason: "billing", re: /\b402\b|payment required|insufficient (funds|credit|credits|balance|quota)|credit balance is too low|add (credit|credits|funds)|billing (hard )?limit|exceeded your current quota|out of credits/i },
  // Context overflow — prompt too big. Recover by compacting, NOT by retrying as-is.
  { reason: "context_overflow", re: /context (length|window)|maximum context|context_length_exceeded|too many (input )?tokens|reduce the length|input is too long|prompt is too long|exceeds? the (maximum|model'?s?) context|this model'?s maximum context/i },
  // Payload too large — same family as context overflow; compact/shrink.
  { reason: "payload_too_large", re: /\b413\b|payload too large|request entity too large|request too large/i },
  // Model not found / invalid model id — fall back to a different model.
  { reason: "model_not_found", re: /\b404\b|model not found|no such model|unknown model|model_not_found|model .* does not exist|invalid model|is not a valid model/i },
  // Model retired / decommissioned (410 Gone and vendor sunset notices).
  // Distinct from 404: the id was valid once, retrying or re-listing will
  // NOT bring it back — it must be recorded and excluded, not retried.
  { reason: "model_retired", re: /\b410\b|model .*retired|retired .*model|decommissioned|sunset(ted|ting)?\b|no longer (supported|available)|has been (removed|retired|deleted|shut down)|model (is |has been )?(removed|deleted|disabled|deprecated)\b/i },
  // Rate limit — transient throttling; back off (and rotate if multi-key).
  { reason: "rate_limit", re: /\b429\b|rate.?limit|too many requests|free-models-per-day|requests? per (day|minute|min)|quota (exceeded|reached)|throttl/i },
  // Overloaded — provider capacity; back off longer.
  { reason: "overloaded", re: /\b503\b|\b529\b|overloaded|service unavailable|server is busy|temporarily unavailable|capacity|try again later/i },
  // Server error — transient 5xx; retry.
  { reason: "server_error", re: /\b500\b|\b502\b|\b504\b|internal server error|bad gateway|gateway timeout/i },
  // Format / bad request — malformed request; retrying identically fails again.
  { reason: "format_error", re: /\b400\b|bad request|invalid request|invalid_request_error|unexpected (role|field|message)|malformed/i },
  // Timeout / transport — connection dropped; rebuild + retry.
  { reason: "timeout", re: /timed out|timeout|etimedout|econnreset|esockettimedout|fetch failed|socket hang up|network error|aborted|connection (reset|closed|refused)/i },
];

// Per-category policy. retryable = retry the SAME request at the transport
// layer. recover="compact" = the loop should compact context and continue
// rather than retry the identical (oversized) request.
const POLICY = {
  auth:              { retryable: false, recover: null,      stopReason: "provider-auth-error",      backoffBase: 0 },
  billing:           { retryable: false, recover: null,      stopReason: "provider-billing",          backoffBase: 0 },
  model_not_found:   { retryable: false, recover: null,      stopReason: "provider-model-not-found",  backoffBase: 0 },
  model_retired:     { retryable: false, recover: null,      stopReason: "provider-model-retired",    backoffBase: 0 },
  format_error:      { retryable: false, recover: null,      stopReason: "provider-error",            backoffBase: 0 },
  context_overflow:  { retryable: false, recover: "compact", stopReason: "provider-context-overflow", backoffBase: 0 },
  payload_too_large: { retryable: false, recover: "compact", stopReason: "provider-context-overflow", backoffBase: 0 },
  rate_limit:        { retryable: true,  recover: null,      stopReason: "provider-rate-limited",     backoffBase: 8000 },
  overloaded:        { retryable: true,  recover: null,      stopReason: "provider-error",            backoffBase: 4000 },
  server_error:      { retryable: true,  recover: null,      stopReason: "provider-error",            backoffBase: 2000 },
  timeout:           { retryable: true,  recover: null,      stopReason: "provider-error",            backoffBase: 1500 },
  unknown:           { retryable: true,  recover: null,      stopReason: "provider-error",            backoffBase: 1500 },
};

function errorToText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const parts = [
    error.message,
    error.status ?? error.statusCode ?? error.code,
    error.type ?? error.error?.type,
    typeof error.body === "string" ? error.body : error.body ? JSON.stringify(error.body) : "",
    error.response && typeof error.response === "object" ? JSON.stringify(error.response).slice(0, 1000) : "",
  ];
  return parts.filter((p) => p != null && p !== "").join(" ");
}

// Actionable, user-facing message per category. Hinglish to match OmniClaw's
// default voice; kept short and concrete (what happened + what to do next).
function messageFor(reason, { detail = "", workDone = "" } = {}) {
  const work = workDone ? `\n\nAb tak jo ban chuka hai:\n${workDone}` : "";
  switch (reason) {
    case "rate_limit":
      return [
        "⚠️ Provider ka rate limit / free daily quota khatam ho gaya (429) — isliye aage nahi badh paya.",
        work.trim(),
        'Aage badhne ke liye: thodi der baad (quota reset hone par) "continue" bolo, YA Settings me doosra provider/model (jaise nvidia, jiski key already lagi hai) ya ek paid model laga lo, phir "continue".',
      ].filter(Boolean).join("\n\n");
    case "billing":
      return [
        "⚠️ Provider ka credit / balance khatam (402) — retry se theek nahi hoga.",
        work.trim(),
        'Settings me is provider me credit add karo, YA doosra provider/model (jaise nvidia) select karke "continue" bolo.',
      ].filter(Boolean).join("\n\n");
    case "auth":
      return [
        "🔑 Provider ki API key invalid / expired / missing hai (401/403) — isliye ruk gaya.",
        work.trim(),
        'Settings → Brain me sahi API key daalo, phir "continue" bolo.',
      ].filter(Boolean).join("\n\n");
    case "model_not_found":
      return [
        `🚫 Selected model provider pe nahi mila (404)${detail ? `: ${detail}` : ""}.`,
        work.trim(),
        'Settings me ek valid model select karo (ya "Fetch models" se list refresh karo), phir "continue".',
      ].filter(Boolean).join("\n\n");
    case "model_retired":
      return [
        `🚫 Ye model provider pe retire/decommission ho chuka hai (410 Gone)${detail ? `: ${detail}` : ""} — retry se wapas nahi aayega.`,
        work.trim(),
        'Settings me doosra (non-retired) model select karo — retired models picker me nahi dikhenge — phir "continue".',
      ].filter(Boolean).join("\n\n");
    case "context_overflow":
    case "payload_too_large":
      return [
        "📏 Conversation/context model ki limit se bada ho gaya — isliye provider ne reject kiya.",
        work.trim(),
        '"continue" bolo to main purani history aur compact karke dobara try karunga; ya bada context window wala model laga lo.',
      ].filter(Boolean).join("\n\n");
    default:
      return work
        ? `Provider error aa gaya, isliye ruk gaya.${work}\n\n"continue" bolo to dobara try karun.`
        : `Provider abhi respond nahi kar paya${detail ? ` (${detail.slice(0, 160)})` : ""}. Thodi der baad "continue" bolo, ya Settings me provider/model check karo.`;
  }
}

/**
 * Classify a provider/transport error.
 * @returns {{reason, retryable, recover, isContextOverflow, isRateLimit, stopReason, backoffMs, userMessage}}
 */
export function classifyProviderError(error, { attempt = 0, workDone = "" } = {}) {
  const text = errorToText(error);
  let reason = "unknown";
  for (const { reason: r, re } of PATTERNS) {
    if (re.test(text)) { reason = r; break; }
  }
  const policy = POLICY[reason] || POLICY.unknown;
  // Server-provided reset hint (retry-after / x-ratelimit-reset-*) attached to
  // the error by the provider, if any — honor it as a floor so we wait until the
  // window actually resets instead of guessing low and burning retries.
  const rateLimit = (typeof error === "object" && error && error.rateLimit) ? error.rateLimit : null;
  const serverResetMs = (typeof error === "object" && error && Number(error.retryAfterMs) > 0)
    ? Number(error.retryAfterMs)
    : (rateLimit && Number(rateLimit.resetMs) > 0 ? Number(rateLimit.resetMs) : 0);
  let backoffMs = 0;
  if (policy.backoffBase > 0) {
    // 1-based attempt for the jitter math; decorrelated exponential growth.
    const jittered = jitteredBackoff(Number(attempt) + 1, {
      baseDelayMs: policy.backoffBase,
      maxDelayMs: 120000,
      jitterRatio: 0.5,
    });
    backoffMs = Math.max(jittered, serverResetMs > 0 ? Math.min(serverResetMs, 120000) : 0);
  }
  const detail = (typeof error === "object" && error ? error.message : String(error || "")).replace(/^round-\d+:\s*/, "");
  return {
    reason,
    retryable: policy.retryable,
    recover: policy.recover,
    isContextOverflow: reason === "context_overflow" || reason === "payload_too_large",
    isRateLimit: reason === "rate_limit",
    isModelGone: reason === "model_retired" || reason === "model_not_found",
    stopReason: policy.stopReason,
    backoffMs,
    serverResetMs: serverResetMs || 0,
    rateLimit: rateLimit || null,
    userMessage: messageFor(reason, { detail, workDone }),
  };
}

export const PROVIDER_ERROR_REASONS = Object.keys(POLICY);
