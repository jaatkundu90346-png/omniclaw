// Reasoning effort: prove OmniClaw actually ASKS the model to think hard, and
// that asking can never wedge a provider that can't.
//
// THE BUG: `provider.reasoning` shipped as null and no UI existed for it, so
// every reply ran on the model's cheapest thinking budget regardless of the
// task. The plumbing already existed — the provider read the key — it was just
// never set and never editable. "Never set" is invisible, which is why nobody
// caught it.
//
// THE RISK OF FIXING IT NAIVELY: setting a default effort means every request
// carries a `reasoning_effort`/`reasoning` param. Any endpoint that rejects
// unknown params would then 400 on EVERY message — trading a quiet quality
// problem for a total outage. So the default is only shippable alongside the
// strip-and-remember fallback, and THAT is what this file exists to pin.
//
// R14: markers before every step, hard wall clock, cleanup in finally.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let step = "startup";
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 60000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  REASONING_EFFORTS,
  REASONING_OFF,
  DEFAULT_REASONING_EFFORT,
  resolveReasoningEffort,
  normalizeReasoningEffort,
  reasoningRequestFragment,
  isUnsupportedReasoningError,
} = await import("../src/core/reasoning-effort.js");
const { CustomizationEngine } = await import("../src/core/customization-engine.js");

try {
  step = "the shipped default actually asks for effort";
  assert.equal(DEFAULT_REASONING_EFFORT, "high",
    "the default must be high — the whole point of this change");
  assert.ok(REASONING_EFFORTS.includes(DEFAULT_REASONING_EFFORT),
    "the default must itself be a valid level");
  console.log(`ok: default effort = ${DEFAULT_REASONING_EFFORT}`);

  step = "config/default.json ships a thinking default, not null";
  const defaults = JSON.parse(fs.readFileSync(path.join(root, "config", "default.json"), "utf8"));
  assert.equal(defaults.provider.reasoning, DEFAULT_REASONING_EFFORT,
    "config/default.json still ships reasoning: null, so nobody gets a default");
  console.log("ok: config/default.json agrees with the code default");

  step = "'Default' and 'Off' must never collapse into each other";
  // These two look identical at the call site (both "don't send an effort") and
  // mean OPPOSITE things to the user. Default = "I have no preference, use the
  // shipped setting". Off = "actively do not ask the model to think". If one
  // entry can express both, picking one silently performs the other.
  assert.equal(resolveReasoningEffort(null), DEFAULT_REASONING_EFFORT,
    "no preference must fall back to the shipped default, NOT to off");
  assert.equal(resolveReasoningEffort(undefined), DEFAULT_REASONING_EFFORT,
    "an absent key must fall back to the shipped default");
  assert.equal(resolveReasoningEffort(REASONING_OFF), null,
    "an explicit 'off' must send no reasoning param at all");
  assert.equal(resolveReasoningEffort(false), null, "the false sentinel must mean off");
  assert.equal(resolveReasoningEffort("low"), "low", "an explicit level must be honoured");
  assert.equal(resolveReasoningEffort({ effort: "max" }), "max", "the object form must be honoured");
  assert.equal(resolveReasoningEffort("banana"), DEFAULT_REASONING_EFFORT,
    "garbage must degrade to the default, never to off and never outbound");
  assert.ok(REASONING_EFFORTS.includes(REASONING_OFF),
    "'off' must be a storable value, otherwise it cannot be told apart from unset");
  console.log("ok: three states (unset / off / level) stay distinct");

  step = "the composer pill writes each row to the right value";
  const composer = fs.readFileSync(path.join(root, "web-next/js/ui/composer.js"), "utf8");
  assert.match(composer, /class: "model-pill effort-pill"/,
    "the composer has no reasoning effort pill next to the model pill");
  assert.match(composer, /row\.append\([^)]*effortPill/,
    "the effort pill is built but never mounted in the composer row");
  assert.match(composer, /\["default", "Default"/,
    "the pill must offer a Default row");
  assert.match(composer, /id === "default" \? null : id/,
    'Default must clear the preference (null), not write "off" — writing off would silently downgrade the user');
  assert.match(composer, /\["off", "Off"/,
    "the pill must offer an explicit Off row");
  assert.match(composer, /paintEffort\(\);\s*\n\s*loadDraft\(\)/,
    "the pill must be painted on first render, not only after a config change");
  console.log("ok: composer pill wired, Default and Off map to different values");

  step = "the effort row is visible without scrolling in Settings";
  const settings = fs.readFileSync(path.join(root, "web-next/js/ui/settings.js"), "utf8");
  // The invariant that matters is "before the provider list is painted", not
  // "before the loading spinner" (the spinner is created before the fetch, so
  // anchoring there would pass even with the row at the bottom again).
  const listAt = settings.indexOf("\n  paintList();");
  const effortCallAt = settings.indexOf("paintReasoning(page,");
  assert.ok(effortCallAt > -1, "paintReasoning is never called");
  assert.ok(listAt > -1 && effortCallAt > -1 && effortCallAt < listAt,
    "the reasoning row must render ABOVE the provider list, not after it — appended last it sat below several screens of scroll and nobody found it");
  console.log("ok: reasoning row renders at the top of the providers page");

  step = "wire shape follows the provider dialect";
  assert.deepEqual(reasoningRequestFragment({ effort: "high", baseUrl: "https://openrouter.ai/api/v1" }),
    { reasoning: { effort: "high" } }, "OpenRouter takes the nested reasoning object");
  assert.deepEqual(reasoningRequestFragment({ effort: "high", baseUrl: "https://api.openai.com/v1" }),
    { reasoning_effort: "high" }, "OpenAI takes the flat reasoning_effort string");
  assert.deepEqual(reasoningRequestFragment({ effort: { effort: "max" }, baseUrl: "https://api.openai.com/v1" }),
    { reasoning: { effort: "max" } },
    "an explicit OBJECT config value states its own wire shape and must be honoured verbatim");
  assert.deepEqual(reasoningRequestFragment({ effort: { effort: "max" }, baseUrl: "https://openrouter.ai/api/v1" }),
    { reasoning: { effort: "max" } }, "object form on OpenRouter stays the nested shape");
  console.log("ok: OpenRouter vs OpenAI wire shapes, and explicit object shapes");

  step = "'off' is storable but never sendable";
  // A provider that receives reasoning_effort:"off" has been handed a level that
  // does not exist. This is the exact 400 the strip-and-remember fallback exists
  // to absorb, and it would cost a failed round on every single message.
  assert.equal(reasoningRequestFragment({ effort: REASONING_OFF, baseUrl: "https://api.openai.com/v1" }), null,
    '"off" must produce NO reasoning param, not reasoning_effort:"off"');
  assert.equal(reasoningRequestFragment({ effort: REASONING_OFF, baseUrl: "https://openrouter.ai/api/v1" }), null,
    '"off" must produce no param on OpenRouter either');
  assert.equal(normalizeReasoningEffort(REASONING_OFF), null,
    'normalizeReasoningEffort must collapse "off" to null');
  assert.equal(normalizeReasoningEffort("high"), "high", "a real level must survive normalization");
  assert.equal(normalizeReasoningEffort({ effort: "low" }), "low", "the object form must normalize to its level");
  console.log("ok: off is storable but never goes on the wire");

  step = "off / bogus values send no param rather than garbage";
  for (const off of [null, false, undefined, "", "banana"]) {
    assert.equal(reasoningRequestFragment({ effort: off, baseUrl: "https://api.openai.com/v1" }), null,
      `"${String(off)}" must produce no reasoning param, not an invalid one`);
  }
  console.log("ok: off/unknown values degrade to no param");

  step = "/fast still emits minimal thinking (not silence)";
  assert.deepEqual(reasoningRequestFragment({ effort: { effort: "minimal" }, baseUrl: "https://api.openai.com/v1" }),
    { reasoning: { effort: "minimal" } },
    "Fast mode sends 'minimal'; dropping it would make Fast slower, not faster");
  assert.deepEqual(reasoningRequestFragment({ effort: "minimal", baseUrl: "https://api.openai.com/v1" }),
    { reasoning_effort: "minimal" }, "the string form of minimal survives too");
  console.log("ok: minimal preserved");

  step = "unsupported-param detection is narrow, not trigger-happy";
  assert.ok(isUnsupportedReasoningError("Unrecognized request argument supplied: reasoning_effort"));
  assert.ok(isUnsupportedReasoningError("Unknown parameter: 'reasoning'"));
  assert.ok(!isUnsupportedReasoningError("Incorrect API key provided"),
    "an auth failure must NOT be mistaken for an unsupported param and silently retried");
  assert.ok(!isUnsupportedReasoningError("rate limit exceeded"),
    "a quota failure must not be silently retried without the param");
  assert.ok(!isUnsupportedReasoningError("reasoning tokens exceeded maximum"),
    "an over-limit reasoning error is a real limit, not an unsupported param");
  console.log("ok: only genuine unknown-param errors trigger the strip");

  step = "Settings can persist a level, and can turn it off";
  const writes = [];
  const engine = new CustomizationEngine({
    configStore: { updateUserConfig: (patch) => { writes.push(patch); } },
    skillRegistry: {},
    secretStore: {},
  });
  engine.updateRuntimeSettings({ provider: { reasoning: "xhigh" } });
  assert.deepEqual(writes.at(-1).provider.reasoning, "xhigh", "a level must persist");
  // "Off" is the case that silently rots: the value is null, so a naive
  // `if (reasoning)` guard drops it and the UI reports success while nothing
  // changed.
  engine.updateRuntimeSettings({ provider: { reasoning: null } });
  const off = writes.at(-1).provider;
  assert.ok("reasoning" in off, "turning reasoning off must still write the key");
  assert.equal(off.reasoning, null, "off must persist as null, not be skipped");
  console.log("ok: levels and off both persist");

  step = "a junk level is rejected instead of being sent to the API";
  assert.throws(
    () => engine.updateRuntimeSettings({ provider: { reasoning: "'; DROP TABLE--" } }),
    /reasoning/,
    "an arbitrary string must not reach the provider request body",
  );
  console.log("ok: invalid levels rejected");

  step = "saving reasoning must not disturb the model already in use";
  writes.length = 0;
  engine.updateRuntimeSettings({ provider: { reasoning: "high" } });
  const patch = writes.at(-1).provider;
  assert.ok(!("model" in patch), "the reasoning patch must not overwrite the active model");
  assert.ok(!("baseUrl" in patch), "the reasoning patch must not overwrite the endpoint");
  console.log("ok: reasoning write is surgical");

  step = "the provider strips the param once and then remembers it";
  const src = fs.readFileSync(path.join(root, "src/core/providers/openai-compatible-provider.js"), "utf8");
  assert.match(src, /isUnsupportedReasoningError\(errText\)/,
    "the 400 fallback must recognise an unsupported reasoning param");
  assert.match(src, /this\.reasoningUnsupported = true/,
    "the rejection must be remembered, or every message pays the failed round");
  assert.match(src, /this\.reasoningUnsupported\s*\?\s*null/,
    "a remembered rejection must stop the param being sent");
  console.log("ok: strip-once-then-remember is wired");

  clearTimeout(timer);
  console.log("reasoning-effort: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  if (error?.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
} finally {
  clearTimeout(timer);
}