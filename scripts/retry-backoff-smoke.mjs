// Smoke test for jittered backoff + rate-limit header parsing + the classifier
// honoring a server-provided reset window. Offline, no network.

import { jitteredBackoff, parseRateLimitHeaders, attachProviderHttpMeta, rateLimitGuard } from "../src/core/retry-backoff.js";
import { classifyProviderError } from "../src/core/provider-error-classifier.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

// --- jitteredBackoff ---------------------------------------------------------
{
  // Always within [capped, capped*(1+jitterRatio)] for given attempt.
  const base = 5000, ratio = 0.5;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const capped = Math.min(base * 2 ** (attempt - 1), 120000);
    let inRange = true;
    for (let i = 0; i < 200; i += 1) {
      const d = jitteredBackoff(attempt, { baseDelayMs: base, maxDelayMs: 120000, jitterRatio: ratio });
      if (d < capped || d > capped * (1 + ratio) + 1) inRange = false;
    }
    ok(inRange, `jitteredBackoff attempt ${attempt} stays within [capped, capped*1.5]`);
  }
  // Cap respected at high attempts.
  const hi = jitteredBackoff(20, { baseDelayMs: 5000, maxDelayMs: 120000, jitterRatio: 0 });
  ok(hi === 120000, "jitteredBackoff caps at maxDelayMs with zero jitter");
  // Decorrelation: two draws are (almost surely) different.
  const a = jitteredBackoff(3, { baseDelayMs: 5000 });
  const b = jitteredBackoff(3, { baseDelayMs: 5000 });
  ok(a !== b || a !== jitteredBackoff(3, { baseDelayMs: 5000 }), "jitter decorrelates concurrent retries");
  // floorMs honored.
  ok(jitteredBackoff(1, { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0, floorMs: 999 }) === 999, "floorMs is a lower bound");
}

// --- parseRateLimitHeaders ---------------------------------------------------
{
  const h = new Map([
    ["retry-after", "30"],
    ["x-ratelimit-remaining-requests", "0"],
    ["x-ratelimit-reset-requests", "45"],
    ["x-ratelimit-limit-requests", "200"],
  ]);
  // Map has .get, so it works with readHeader's get path.
  const parsed = parseRateLimitHeaders(h);
  ok(parsed.retryAfterMs === 30000, "retry-after seconds -> ms");
  ok(parsed.resetMs === 45000, "resetMs is the max of retry-after / reset windows");
  ok(parsed.remainingRequests === 0, "remaining-requests parsed");
  ok(parsed.limitRequests === 200, "limit-requests parsed");
  ok(parsed.present === true, "present flag true when headers exist");

  const plain = parseRateLimitHeaders({ "Retry-After": "1m30s" });
  ok(plain.retryAfterMs === 90000, "compound duration 1m30s -> 90000ms (case-insensitive)");

  const none = parseRateLimitHeaders({ "content-type": "application/json" });
  ok(none.present === false && none.resetMs === null, "no rate-limit headers -> present false");

  const ms = parseRateLimitHeaders({ "x-ratelimit-reset-tokens": "500ms" });
  ok(ms.resetMs === 500, "explicit ms suffix parsed");
}

// --- classifier honors server reset + jitter ---------------------------------
{
  // A 429 with an attached reset of 60s must back off at least ~60s.
  const err = attachProviderHttpMeta(
    new Error("Provider native tool request failed with status 429: rate limit exceeded"),
    null,
    { resetMs: 60000, retryAfterMs: 60000, present: true },
  );
  const c = classifyProviderError(err, { attempt: 0 });
  ok(c.reason === "rate_limit", "429 classified as rate_limit");
  ok(c.isRateLimit === true, "isRateLimit flag set");
  ok(c.retryable === true, "rate_limit is retryable");
  ok(c.backoffMs >= 60000, `backoff honors server reset (got ${c.backoffMs}ms >= 60000)`);
  ok(c.serverResetMs === 60000, "serverResetMs surfaced on result");
  ok(c.rateLimit && c.rateLimit.resetMs === 60000, "parsed rateLimit surfaced on result");

  // A 429 with NO server hint still gets a jittered (non-zero, bounded) backoff.
  const plain429 = classifyProviderError("status 429 too many requests", { attempt: 0 });
  ok(plain429.backoffMs >= 8000 && plain429.backoffMs <= 120000, `plain 429 jittered backoff in range (got ${plain429.backoffMs})`);
  ok(plain429.serverResetMs === 0, "no server hint -> serverResetMs 0");

  // Permanent errors never back off.
  const auth = classifyProviderError("status 401 unauthorized", { attempt: 1 });
  ok(auth.retryable === false && auth.backoffMs === 0, "auth error: no retry, no backoff");

  // attachProviderHttpMeta sets status from a response-like object.
  const e2 = attachProviderHttpMeta(new Error("boom"), { status: 503, headers: new Map([["retry-after", "5"]]) });
  ok(e2.status === 503, "attachProviderHttpMeta sets status from response");
  ok(e2.retryAfterMs === 5000, "attachProviderHttpMeta derives retryAfterMs from headers");
}

// --- rateLimitGuard (in-process cooldown) -----------------------------------
{
  rateLimitGuard.reset();
  const key = "openrouter:anthropic/claude";
  ok(rateLimitGuard.remainingMs(key) === 0, "guard: unknown key not blocked");
  // Only a real reset engages the block.
  ok(rateLimitGuard.block(key, 0) === 0, "guard: block with 0 reset is a no-op");
  ok(rateLimitGuard.remainingMs(key) === 0, "guard: still not blocked after no-op");
  const rem = rateLimitGuard.block(key, 5000);
  ok(rem > 4000 && rem <= 5000, `guard: block records ~5s (got ${rem})`);
  ok(rateLimitGuard.remainingMs(key) > 0, "guard: key now blocked");
  // Cap at 120s.
  rateLimitGuard.reset();
  rateLimitGuard.block(key, 9999999);
  ok(rateLimitGuard.remainingMs(key) <= 120000, "guard: block capped at 120s");
  // clear() lifts the block (simulates a successful response).
  rateLimitGuard.clear(key);
  ok(rateLimitGuard.remainingMs(key) === 0, "guard: clear lifts the block");
  // Different provider+model keys are independent.
  rateLimitGuard.block("a:m1", 5000);
  ok(rateLimitGuard.remainingMs("a:m2") === 0, "guard: keys are independent");
  rateLimitGuard.reset();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
