// Jittered backoff + rate-limit header parsing.
//
// Ports two Hermes ideas into OmniClaw's Node retry path:
//   - agent/retry_utils.py  -> jitteredBackoff(): decorrelated exponential
//     backoff so concurrent sessions hitting the same rate-limited provider
//     don't all retry on the same instant (thundering-herd).
//   - agent/rate_limit_tracker.py -> parseRateLimitHeaders(): read the
//     standard x-ratelimit-* / retry-after headers a provider returns so the
//     loop can back off until the REAL reset instead of a blind constant.

// Monotonic seed so two calls in the same millisecond still decorrelate.
let jitterCounter = 0;

/**
 * Decorrelated exponential backoff.
 * @param {number} attempt 1-based retry attempt number.
 * @param {{baseDelayMs?:number,maxDelayMs?:number,jitterRatio?:number,floorMs?:number}} [opts]
 * @returns {number} delay in ms = min(base * 2^(attempt-1), max) + jitter, never below floor.
 */
export function jitteredBackoff(attempt, opts = {}) {
  const baseDelayMs = Number(opts.baseDelayMs ?? 5000);
  const maxDelayMs = Number(opts.maxDelayMs ?? 120000);
  const jitterRatio = Number(opts.jitterRatio ?? 0.5);
  const floorMs = Number(opts.floorMs ?? 0);
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const exp = baseDelayMs * Math.pow(2, n - 1);
  const capped = Math.min(exp, maxDelayMs);
  jitterCounter = (jitterCounter + 1) % 1_000_000;
  const jitter = Math.random() * Math.max(0, jitterRatio) * capped;
  return Math.max(floorMs, Math.round(capped + jitter));
}

// Parse a duration token like "12", "12s", "1m30s", "500ms", or an HTTP-date,
// returning milliseconds (or null when it can't be parsed).
function durationToMs(raw) {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  // Pure number -> seconds (retry-after / x-ratelimit-reset convention).
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(parseFloat(value) * 1000);
  // Explicit ms.
  const ms = value.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
  if (ms) return Math.round(parseFloat(ms[1]));
  // Compound like 1m30s / 90s / 2h.
  const compound = value.match(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi);
  if (compound) {
    let total = 0;
    for (const part of compound) {
      const m = part.match(/(\d+(?:\.\d+)?)\s*(h|m|s)/i);
      if (!m) continue;
      const num = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      total += unit === "h" ? num * 3600 : unit === "m" ? num * 60 : num;
    }
    return Math.round(total * 1000);
  }
  // HTTP-date (retry-after can be an absolute date).
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  // plain object — case-insensitive lookup
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function toIntOrNull(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract rate-limit state from a provider response's headers.
 * Accepts a fetch Headers object or a plain header map.
 * @returns {{resetMs:number|null, retryAfterMs:number|null, remainingRequests:number|null,
 *            remainingTokens:number|null, limitRequests:number|null, limitTokens:number|null,
 *            present:boolean}}
 */
export function parseRateLimitHeaders(headers) {
  const retryAfterMs = durationToMs(readHeader(headers, "retry-after"));
  const resetRequests = durationToMs(readHeader(headers, "x-ratelimit-reset-requests"));
  const resetTokens = durationToMs(readHeader(headers, "x-ratelimit-reset-tokens"));
  const remainingRequests = toIntOrNull(readHeader(headers, "x-ratelimit-remaining-requests"));
  const remainingTokens = toIntOrNull(readHeader(headers, "x-ratelimit-remaining-tokens"));
  const limitRequests = toIntOrNull(readHeader(headers, "x-ratelimit-limit-requests"));
  const limitTokens = toIntOrNull(readHeader(headers, "x-ratelimit-limit-tokens"));

  // The most relevant reset is the soonest non-null window we should wait for.
  const candidates = [retryAfterMs, resetRequests, resetTokens].filter((v) => v != null && v >= 0);
  const resetMs = candidates.length ? Math.max(...candidates) : null;

  const present = [
    retryAfterMs, resetRequests, resetTokens, remainingRequests,
    remainingTokens, limitRequests, limitTokens,
  ].some((v) => v != null);

  return {
    resetMs,
    retryAfterMs: retryAfterMs ?? null,
    remainingRequests,
    remainingTokens,
    limitRequests,
    limitTokens,
    present,
  };
}

// In-process rate-limit guard (Hermes nous_rate_guard.py concept, scoped to
// OmniClaw's single gateway process). When a provider returns a 429 WITH a real
// server reset window, we record `provider:model -> blockedUntil` so the next
// round / a concurrent run on the SAME provider+model short-circuits instead of
// hammering a provider we already know is throttled (retry amplification). We
// only engage on a real server reset hint — a bare 429 with no reset header
// gets only the per-call jittered backoff, never a speculative cross-call block.
const rateLimitBlocks = new Map();
const RATE_LIMIT_BLOCK_CAP_MS = 120000;

export const rateLimitGuard = {
  /** Record a cooldown for key, bounded to the cap. Only call with a real resetMs. */
  block(key, resetMs) {
    if (!key || !(Number(resetMs) > 0)) return 0;
    const until = Date.now() + Math.min(Number(resetMs), RATE_LIMIT_BLOCK_CAP_MS);
    const existing = rateLimitBlocks.get(key) || 0;
    if (until > existing) rateLimitBlocks.set(key, until);
    return rateLimitBlocks.get(key) - Date.now();
  },
  /** Remaining cooldown ms for key (0 if not blocked / expired). Self-prunes. */
  remainingMs(key) {
    if (!key) return 0;
    const until = rateLimitBlocks.get(key) || 0;
    const rem = until - Date.now();
    if (rem <= 0) { if (until) rateLimitBlocks.delete(key); return 0; }
    return rem;
  },
  /** Clear a key (call on a successful response). */
  clear(key) { if (key) rateLimitBlocks.delete(key); },
  /** Test/maintenance: clear everything. */
  reset() { rateLimitBlocks.clear(); },
};

/**
 * Build an Error from a non-ok provider HTTP response, attaching status + the
 * parsed rate-limit reset so the classifier can honor the server's real wait
 * instead of guessing. `messageText` is the already-parsed error string.
 */
export function attachProviderHttpMeta(error, response, parsedRateLimit) {
  if (!error || typeof error !== "object") return error;
  if (response) {
    error.status = response.status;
    error.statusCode = response.status;
  }
  const rateLimit = parsedRateLimit || (response ? parseRateLimitHeaders(response.headers) : null);
  if (rateLimit) {
    error.rateLimit = rateLimit;
    if (rateLimit.resetMs != null) error.retryAfterMs = rateLimit.resetMs;
  }
  return error;
}
