// Smoke test for provider-error-classifier.
// Run: node scripts/provider-error-classifier-smoke.mjs
import { classifyProviderError } from "../src/core/provider-error-classifier.js";

let passed = 0;
let failed = 0;

function check(name, errText, expect) {
  const got = classifyProviderError(errText, { attempt: 0 });
  const fields = Object.keys(expect);
  const ok = fields.every((k) => got[k] === expect[k]);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name} -> ${got.reason}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
    for (const k of fields) {
      if (got[k] !== expect[k]) console.log(`       ${k}: expected ${JSON.stringify(expect[k])}, got ${JSON.stringify(got[k])}`);
    }
  }
}

// Category detection + retry policy
check("429 rate limit", "round-3: provider request failed: 429 rate-limit-exceeded: free-models-per-day",
  { reason: "rate_limit", retryable: true, isRateLimit: true, stopReason: "provider-rate-limited" });
check("402 billing", "Error 402: insufficient credit. Add funds to continue.",
  { reason: "billing", retryable: false, stopReason: "provider-billing" });
check("401 auth", "401 Unauthorized: invalid api key",
  { reason: "auth", retryable: false, stopReason: "provider-auth-error" });
check("404 model", "404 model not found: nvidia/foo-bar",
  { reason: "model_not_found", retryable: false, stopReason: "provider-model-not-found" });
check("context overflow", "This model's maximum context length is 8192 tokens. reduce the length of the messages.",
  { reason: "context_overflow", retryable: false, recover: "compact", isContextOverflow: true, stopReason: "provider-context-overflow" });
check("413 payload", "413 Request entity too large",
  { reason: "payload_too_large", retryable: false, isContextOverflow: true });
check("503 overloaded", "503 Service Unavailable: server overloaded",
  { reason: "overloaded", retryable: true, stopReason: "provider-error" });
check("500 server error", "500 Internal Server Error",
  { reason: "server_error", retryable: true });
check("400 format", "400 Bad Request: invalid_request_error unexpected role",
  { reason: "format_error", retryable: false });
check("timeout", "request timed out after 180000ms (ETIMEDOUT)",
  { reason: "timeout", retryable: true });
check("unknown", "something totally weird happened",
  { reason: "unknown", retryable: true, stopReason: "provider-error" });

// Disambiguation: "exceeded your current quota" is billing, NOT plain rate_limit
check("quota-exhausted is billing", "You exceeded your current quota, please check your plan and billing details.",
  { reason: "billing", retryable: false });

// Backoff is now jittered (decorrelated exponential) so assert RANGES + growth,
// not fixed values. attempt 0 -> capped 8000 + jitter[0,4000]; attempt 2 ->
// capped 32000 + jitter[0,16000]. Higher attempt must back off longer.
const rl0 = classifyProviderError("429 rate limit", { attempt: 0 });
const rl2 = classifyProviderError("429 rate limit", { attempt: 2 });
if (rl0.backoffMs >= 8000 && rl0.backoffMs <= 12000 &&
    rl2.backoffMs >= 32000 && rl2.backoffMs <= 48000 &&
    rl2.backoffMs > rl0.backoffMs) {
  passed += 1; console.log("  ok   rate-limit backoff jittered + scales with attempt");
} else { failed += 1; console.log(`  FAIL backoff: got ${rl0.backoffMs} / ${rl2.backoffMs}`); }

// Rate-limit message stays actionable (smoke parity): mentions continue + switch
const msg = classifyProviderError("429 rate limit", {}).userMessage;
if (/continue/i.test(msg) && /(provider|model)/i.test(msg) && !/provider brain failed/i.test(msg)) {
  passed += 1; console.log("  ok   rate-limit message actionable, no 'provider brain failed' garbage");
} else { failed += 1; console.log("  FAIL rate-limit message not actionable"); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
