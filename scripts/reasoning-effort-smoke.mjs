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
  DEFAULT_REASONING_EFFORT,
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