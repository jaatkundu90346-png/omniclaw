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

// Ordered low -> high, plus the two non-level states.
//
// "off" IS a stored value, not the absence of one. That distinction is the whole
// reason this function exists. There are THREE states a user can be in:
//   unset / null -> "use whatever OmniClaw ships"  (the Default row in the UI)
//   "off"        -> "actively do not ask the model to think"
//   "low".."max" -> a specific effort
// Collapsing "Default" and "Off" into one value means a user who picks Default
// silently DOWNGRADES themselves, or a user who picks Off silently gets high
// again. Both are worse than having one more enum member.
//
// "minimal"/"none" are included even though the UI does not offer them: /fast
// emits "minimal" and some models accept only "minimal".
export const REASONING_OFF = "off";
export const REASONING_EFFORTS = Object.freeze([
  REASONING_OFF, "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);

/** What OmniClaw ships with. Used when the user has expressed no preference. */
export const DEFAULT_REASONING_EFFORT = "high";

/**
 * Normalize any stored/incoming value to a storable level string.
 * Returns null for "off"/false, and the level itself otherwise. Used by the
 * settings writer to validate before persisting.
 */
export function normalizeReasoningEffort(value) {
  if (value === null || value === undefined || value === false) return null;
  const effort = typeof value === "object" ? value.effort : value;
  const level = String(effort || "").trim().toLowerCase();
  // "off" is a STORED level but not a SENDABLE one. Returning it here would
  // produce `reasoning_effort: "off"` on the wire — asking the provider for
  // something that is not a level, which is exactly the 400 this whole module
  // exists to avoid.
  if (level === REASONING_OFF) return null;
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