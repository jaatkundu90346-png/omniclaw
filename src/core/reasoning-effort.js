// ONE place that owns "how hard should the model think".
//
// WHY THIS FILE EXISTS: reasoning effort is THREE things that used to live in
// three places and disagree — the Settings UI's list of levels, the validation
// that /api/config applies before writing the value, and the provider that turns
// the value into a request body. When those drift, the UI offers a level the
// validator rejects (settings silently don't save), or the provider sends a shape
// the endpoint 400s on. One list, imported by all three.
//
// THE SHIPPED DEFAULT IS "high", NOT null. Reasoning-capable models default to
// their cheapest thinking budget, and the whole point of OmniClaw is real
// engineering work where that budget is the difference between a one-shot wrong
// answer and a correct one. Turning it off is a choice the user makes
// deliberately from Settings, not the state we ship everyone in.
//
// This is SAFE as a default only because the provider layer degrades: an
// endpoint that rejects the reasoning parameter costs one stripped retry, and
// the rejection is remembered for the process so it never recurs. Without that
// fallback a non-reasoning endpoint would 400 on EVERY message — a far worse
// failure than thinking less, which is why the default alone is not enough.

// Ordered low -> high. "off" is not a level; it is the null/off state.
//
// "minimal"/"none" are included even though the Settings UI does not offer
// them: /fast emits "minimal" and some models accept only "minimal". Dropping
// them here would silently turn Fast mode into "no reasoning param at all",
// which is a different (and slower) request than the one the user asked for.
export const REASONING_EFFORTS = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);

/** What OmniClaw ships with. Override per user from Settings > Providers. */
export const DEFAULT_REASONING_EFFORT = "high";

/**
 * Normalize any stored/incoming value to a valid level string.
 * Returns null for "off" (absent, false, null, or an unrecognised value) so a
 * typo in config degrades to "don't send a reasoning param" rather than
 * forwarding garbage into a request body.
 */
export function normalizeReasoningEffort(value) {
  if (value === null || value === undefined || value === false) return null;
  const effort = typeof value === "object" ? value.effort : value;
  const level = String(effort || "").trim().toLowerCase();
  return REASONING_EFFORTS.includes(level) ? level : null;
}

/**
 * Build the request-body fragment that asks for a reasoning effort.
 *
 * The two upstream dialects are NOT interchangeable, and sending the wrong one
 * is a 400:
 *   OpenRouter -> reasoning: { effort }
 *   OpenAI o-series -> reasoning_effort: "high"
 * OpenRouter is detected by host; everything else gets the OpenAI form, which is
 * what every other OpenAI-compatible endpoint (and most gateways) accept.
 *
 * Returns null when no effort should be sent — the caller then omits both keys
 * entirely, which is the correct request for a model that cannot think.
 */
export function reasoningRequestFragment({ effort, baseUrl } = {}) {
  const level = normalizeReasoningEffort(effort);
  if (!level) return null;
  // An OBJECT config value is an explicit statement of the wire shape: the
  // user (or a gateway profile) asked for `reasoning: {...}` and we honour it.
  // Dialect sniffing must not override that — doing so would silently rewrite a
  // working config into a 400ing one on gateways that only accept the object.
  // A STRING has no shape implied, so the endpoint decides.
  if (effort && typeof effort === "object" && !Array.isArray(effort)) {
    return { reasoning: { ...effort, effort: level } };
  }
  const isOpenRouter = /openrouter\.ai/i.test(String(baseUrl || ""));
  return isOpenRouter
    ? { reasoning: { effort: level } }
    : { reasoning_effort: level };
}

/**
 * Does this provider error mean "I don't accept the reasoning parameter"?
 *
 * Deliberately narrow. Guessing wrong in the other direction (stripping the
 * param on a real auth/quota failure) would mask a genuine problem, so this only
 * matches errors that actually name the parameter as unrecognized.
 */
export function isUnsupportedReasoningError(errorText = "") {
  const text = String(errorText || "").toLowerCase();
  if (!text.includes("reasoning")) return false;
  return /(unrecognized|unrecognised|unknown|unsupported|not supported|unexpected|invalid|not allowed|no such|does not support)/.test(text);
}