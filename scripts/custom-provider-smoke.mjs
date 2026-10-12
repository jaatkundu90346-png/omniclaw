// Smoke test for the custom-provider feature: a user gives a name + base URL +
// API key, and it becomes a persisted, selectable providerProfiles entry.
// Runs against a TEMP config dir so the real user config is untouched.
//
// Run: node scripts/custom-provider-smoke.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { ConfigStore } from "../src/core/config-store.js";
import { CustomizationEngine } from "../src/core/customization-engine.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-cp-"));
fs.mkdirSync(path.join(root, "config"), { recursive: true });
// Minimal default config the ConfigStore/validator needs.
fs.writeFileSync(path.join(root, "config", "default.json"), JSON.stringify({
  provider: { mode: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeyProviderId: "openai" },
  providerProfiles: { openai: { mode: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKeyProviderId: "openai" } },
}, null, 2));

const configStore = new ConfigStore(root);

// In-memory secret store stub.
const keys = new Map();
const secretStore = {
  setProviderKey: (id, key) => { if (key) keys.set(id, key); else keys.delete(id); return { providerId: id, configured: Boolean(key), masked: key ? `***${key.slice(-3)}` : "" }; },
  getProviderKey: (id) => keys.get(id) || "",
  getProviderKeyStatus: (id) => ({ providerId: id, configured: keys.has(id), masked: keys.has(id) ? `***${keys.get(id).slice(-3)}` : "" }),
  getAllStatuses: () => [...keys.keys()].map((id) => ({ providerId: id, configured: true, masked: "***" })),
};

const engine = new CustomizationEngine({ configStore, secretStore });

async function main() {
  // 1) Save a custom provider with a friendly name.
  const saved = await engine.saveProviderProfile({
    name: "My Cerebras",
    baseUrl: "https://api.cerebras.ai/v1/",
    model: "llama-3.3-70b",
    apiKey: "sk-test-999",
    apply: true,
  });
  assert.ok(saved.ok, `save should succeed: ${saved.error || ""}`);
  assert.equal(saved.profileId, "my-cerebras", "name should slugify to id");
  assert.ok(saved.keySaved, "key should be saved");
  console.log("✓ custom provider saved with slugified id 'my-cerebras'");

  // 2) It persists in providerProfiles under the slug, with the label + trimmed url.
  const cfg = configStore.getConfig();
  const prof = cfg.providerProfiles["my-cerebras"];
  assert.ok(prof, "profile should be persisted");
  assert.equal(prof.label, "My Cerebras", "label keeps original name");
  assert.equal(prof.baseUrl, "https://api.cerebras.ai/v1", "trailing slash trimmed");
  assert.equal(prof.apiKeyProviderId, "my-cerebras", "key id defaults to slug");
  assert.equal(prof.custom, true);
  console.log("✓ profile persisted with label, trimmed url, custom flag");

  // 3) apply:true made it the active provider.
  assert.equal(cfg.provider.baseUrl, "https://api.cerebras.ai/v1", "apply set active provider");
  assert.equal(cfg.provider.model, "llama-3.3-70b");
  assert.equal(keys.get("my-cerebras"), "sk-test-999", "key stored under slug");
  console.log("✓ apply:true switched the active provider + key");

  // 4) authStyle passthrough (anthropic).
  const anthropic = await engine.saveProviderProfile({
    name: "Claude Direct", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5", apiKey: "sk-ant-1", authStyle: "anthropic",
  });
  assert.ok(anthropic.ok);
  assert.equal(configStore.getConfig().providerProfiles["claude-direct"].authStyle, "anthropic");
  console.log("✓ authStyle 'anthropic' persisted");

  // 5) Validation rejects a bad model.
  const bad = await engine.saveProviderProfile({ name: "Broken", baseUrl: "https://x.ai/v1", model: "has space" });
  assert.equal(bad.ok, false, "invalid model should be rejected");
  console.log("✓ invalid model rejected:", bad.error);

  // 6) Delete removes the user profile but not built-in defaults.
  const del = engine.deleteProviderProfile({ profileId: "my-cerebras" });
  assert.ok(del.ok, "delete should succeed");
  assert.ok(!configStore.getConfig().providerProfiles["my-cerebras"], "profile removed");
  const delBuiltin = engine.deleteProviderProfile({ profileId: "openai" });
  assert.equal(delBuiltin.ok, false, "built-in default can't be deleted");
  console.log("✓ delete removes custom profile, protects built-in defaults");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("\nALL CUSTOM-PROVIDER SMOKE CHECKS PASSED");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
