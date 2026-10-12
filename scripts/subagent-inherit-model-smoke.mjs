// Sub-agents always inherit the main agent's model.
//
// WHAT WAS REMOVED AND WHY IT WAS A PROBLEM: a sub-agent could be pointed at a
// different model AND a different provider connection than the one you were
// talking to. The user chose a model in the composer, watched it work, and then
// a delegated task silently ran on something else — a stale compaction model, or
// a profile whose key had quietly expired. Delegation adds parallelism and
// context isolation; it should never change WHO IS THINKING. So the model /
// provider / fallback knobs are gone, not defaulted.
//
// THE CONTRACT, asserted below:
//   1. A spawn resolves to exactly the parent's binding. One rung. No ladder.
//   2. No code path reads a sub-agent model from config.
//   3. No code path ACCEPTS one from a caller.
//   4. A stale client that still sends the old setting gets an ERROR, not a
//      cheerful 200 that discarded it. (Silent drops are how removed settings
//      come back three versions later.)
//   5. The things that are NOT about the model — concurrency and rate limits —
//      still work, because those are about resources, not about who answers.
//
// R14: markers before every step, hard wall clock, cleanup in finally.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let step = "startup";
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 60000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { SubAgentSpawner } = await import("../src/core/sub-agent-spawner.js");
const { CustomizationEngine } = await import("../src/core/customization-engine.js");

try {
  step = "a spawn resolves to the parent's binding, verbatim";
  const parentProvider = { getInfo: () => ({ model: "main/model-x", baseUrl: "https://main.example/v1" }) };
  // A config that still carries the OLD sub-agent model, to prove it is ignored
  // rather than merely absent from the defaults.
  const config = {
    provider: { model: "main/model-x", baseUrl: "https://main.example/v1" },
    runtime: { subAgents: { model: "cheap/other-model", provider: "some-profile", fallbackModel: "cheap/fallback", maxConcurrent: 5 } },
  };
  const spawner = new SubAgentSpawner({
    agentRuntime: { provider: parentProvider, gateway: { addEvent: () => {} }, rootDir: root },
    configStore: { getConfig: () => config },
    toolRegistry: { run: async () => ({}) },
  });

  const { ladder } = await spawner.resolveSubAgentBinding({});
  assert.equal(ladder.length, 1, `expected exactly one binding, got ${ladder.length} rungs`);
  assert.equal(ladder[0].model, "main/model-x",
    `sub-agent ran on ${ladder[0].model}, not the main model's`);
  assert.equal(ladder[0].baseUrl, "https://main.example/v1",
    "sub-agent ran on a different endpoint than the main agent");
  assert.equal(ladder[0].provider, parentProvider, "sub-agent built its own provider");
  console.log(`ok: 1 rung, model=${ladder[0].model} (the stale config value was ignored)`);

  step = "a caller-supplied model is ignored, not honoured";
  const forced = await spawner.resolveSubAgentBinding({ model: "attacker/other-model", provider: "elsewhere" });
  assert.equal(forced.ladder[0].model, "main/model-x",
    "an explicit model argument still changed the child's model");
  assert.equal(forced.ladder[0].provider, parentProvider, "an explicit provider argument still changed the endpoint");
  console.log("ok: explicit model/provider arguments ignored");

  step = "no code path reads a sub-agent model from config";
  const spawnerSrc = fs.readFileSync(path.join(root, "src/core/sub-agent-spawner.js"), "utf8");
  assert.ok(!/sub\.model|subAgents\?\.model|subAgents\.model/.test(spawnerSrc),
    "sub-agent-spawner still reads a configured sub-agent model");
  assert.ok(!/sub\.fallbackModel/.test(spawnerSrc), "sub-agent-spawner still reads a fallback model");
  assert.ok(!/sub\.provider\b/.test(spawnerSrc), "sub-agent-spawner still reads a dedicated sub-agent provider");
  const defaults = JSON.parse(fs.readFileSync(path.join(root, "config", "default.json"), "utf8"));
  for (const key of ["model", "provider", "fallbackModel"]) {
    assert.ok(!(key in defaults.runtime.subAgents),
      `config/default.json still ships runtime.subAgents.${key}`);
  }
  console.log("ok: the setting is gone from the spawner and the shipped defaults");

  step = "no tool offers a per-call sub-agent model";
  const registrySrc = fs.readFileSync(path.join(root, "src/core/tool-registry.js"), "utf8");
  const delegateBlock = registrySrc.slice(registrySrc.indexOf("delegate_task: {"), registrySrc.indexOf("best_of_n: {"));
  assert.ok(delegateBlock.length > 0, "delegate_task block not found");
  assert.ok(!/\bmodel:\s*\{ type: "string"[^}]*child/i.test(delegateBlock),
    "delegate_task still advertises a child model argument");
  assert.ok(!/this\.configStore\.getConfig\(\)\?\.provider\?\.reviewerModel/.test(registrySrc),
    "evaluate_work still swaps in a separate reviewer model");
  assert.ok(!/scope === "subagents"/.test(registrySrc),
    "switch_model still has a 'subagents' scope");
  console.log("ok: no tool surfaces a sub-agent model choice");

  step = "a stale caller gets an ERROR, not a silent 200";
  const engine = new CustomizationEngine({
    configStore: { getConfig: () => config, updateUserConfig: () => {} },
    skillRegistry: {},
    secretStore: {},
  });
  for (const gone of ["model", "provider", "fallbackModel"]) {
    assert.throws(
      () => engine.updateRuntimeSettings({ runtime: { subAgents: { [gone]: "x" } } }),
      /always run on the main agent/,
      `runtime.subAgents.${gone} was silently ignored instead of rejected`,
    );
  }
  console.log("ok: all three rejected loudly");

  step = "the limits that are NOT about the model still work";
  const writes = [];
  const eng2 = new CustomizationEngine({
    configStore: { getConfig: () => config, updateUserConfig: (p) => writes.push(p) },
    skillRegistry: {},
    secretStore: {},
  });
  eng2.updateRuntimeSettings({ runtime: { subAgents: { maxConcurrent: 99, maxPerHour: 9999, evil: "x" } } });
  const sub = writes.at(-1).runtime.subAgents;
  assert.equal(sub.maxConcurrent, 8, "maxConcurrent must still clamp to 8");
  assert.equal(sub.maxPerHour, 200, "maxPerHour must still clamp to 200");
  assert.equal(sub.evil, undefined, "unknown keys must still be dropped");
  const limits = spawner.getLimits();
  assert.equal(limits.maxConcurrent, 5, "a configured concurrency limit must still be honoured");
  assert.ok(!("defaultModel" in limits), "getLimits must no longer report a sub-agent model");
  assert.ok(!("fallbackModel" in limits), "getLimits must no longer report a fallback model");
  console.log("ok: concurrency/rate limits intact, model fields gone");

  step = "no dead UI for the removed feature";
  const composer = fs.readFileSync(path.join(root, "web-next/js/ui/composer.js"), "utf8");
  assert.ok(!composer.includes("subPill"), "the composer still builds a sub-agent model pill");
  assert.ok(!/Sub: Inherit/.test(composer), "the composer still shows the 'Sub: Inherit' label");
  const api = fs.readFileSync(path.join(root, "web-next/js/api.js"), "utf8");
  assert.ok(!api.includes("setSubAgentModel"), "setSubAgentModel API still exists");
  const css = fs.readFileSync(path.join(root, "web-next/css/composer.css"), "utf8");
  assert.ok(!/\.model-pill\.sub-pill/.test(css), ".sub-pill CSS rules still exist for a removed control");

  clearTimeout(timer);
  console.log("subagent-inherit-model: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  if (error?.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
} finally {
  clearTimeout(timer);
}