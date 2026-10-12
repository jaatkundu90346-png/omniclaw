// Smoke test: OmniLoop provider ROTATION on hard provider failure.
//
// Why this exists: with OmniLoop as the engine, a single 429/402/401/404 used to
// end the whole run even when the user had configured fallback provider
// profiles — the user had to keep typing "continue". Claude Code / Codex move
// to the next configured binding by themselves; this guards that parity.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { OmniLoop } = await import(pathToFileURL(path.join(ROOT, "src/core/omni-loop.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const makeRuntime = ({ profiles = {}, fallbacks = [], keys = {}, events = [] }) => ({
  config: {
    getConfig: () => ({
      provider: { mode: "openai-compatible", baseUrl: "https://a.example/v1", model: "model-a", apiKeyProviderId: "prov-a", fallbacks },
      providerProfiles: profiles,
    }),
  },
  secrets: {
    getProviderKeyStatus: (id) => ({ providerId: id, configured: Boolean(keys[id]), masked: keys[id] ? "sk-***" : "" }),
    getProviderKey: (id) => keys[id] || "",
  },
  provider: { getInfo: () => ({ id: "prov-a", model: "model-a", ready: true }) },
  gateway: { addEvent: (e, p) => events.push({ e, p }) },
});

const ALT = {
  alt: { mode: "openai-compatible", baseUrl: "https://b.example/v1", model: "model-b", apiKeyProviderId: "prov-b" },
  dead: { mode: "openai-compatible", baseUrl: "https://c.example/v1", model: "model-c", apiKeyProviderId: "prov-c" },
};

// ── 1. Rotation walks the chain, swaps the provider, emits the event ────────
{
  const events = [];
  const runtime = makeRuntime({ profiles: ALT, fallbacks: ["dead", "alt"], keys: { "prov-b": "sk-b" }, events });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const rotation = { chain: null, tried: new Set(), applied: [], skipped: [] };
  const first = loop.rotateProviderForRetry({ rotation, agent: { id: "main" }, gateway: runtime.gateway, run: { id: "r1" }, session: { id: "s1" }, reason: "rate_limit" });
  check("rotates past a keyless profile to the first READY one", first && first.profileId === "alt", JSON.stringify(first));
  check("active runtime provider is swapped", runtime.provider.getInfo().model === "model-b", runtime.provider.getInfo().model);
  check("skipped profile is recorded with a reason", rotation.skipped.length === 1 && rotation.skipped[0].profileId === "dead", JSON.stringify(rotation.skipped));
  check("omni_loop.provider_rotated event emitted", events.some((x) => x.e === "omni_loop.provider_rotated" && x.p.profileId === "alt"), JSON.stringify(events.map((x) => x.e)));
  check("chain exhaustion returns null (no infinite rotation)", loop.rotateProviderForRetry({ rotation, agent: { id: "main" }, gateway: runtime.gateway, run: { id: "r1" }, session: { id: "s1" }, reason: "rate_limit" }) === null);
}

// ── 2. No configured fallbacks = no rotation (honest provider-error path) ───
{
  const runtime = makeRuntime({ profiles: {}, fallbacks: [], keys: {} });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const rotation = { chain: null, tried: new Set(), applied: [], skipped: [] };
  const rec = loop.rotateProviderForRetry({ rotation, agent: { id: "main" }, gateway: runtime.gateway, run: { id: "r2" }, session: { id: "s2" }, reason: "auth" });
  check("no configured fallbacks -> no rotation", rec === null, JSON.stringify(rec));
  check("provider untouched when nothing to rotate to", runtime.provider.getInfo().model === "model-a");
}

// ── 3. agent.fallbackChain is honored, and each profile is tried once ───────
{
  const runtime = makeRuntime({ profiles: ALT, fallbacks: [], keys: { "prov-b": "sk-b" } });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const rotation = { chain: null, tried: new Set(), applied: [], skipped: [] };
  const rec = loop.rotateProviderForRetry({ rotation, agent: { id: "main", fallbackChain: ["alt"] }, gateway: runtime.gateway, run: { id: "r3" }, session: { id: "s3" }, reason: "billing" });
  check("agent.fallbackChain is used when provider.fallbacks is empty", rec && rec.profileId === "alt", JSON.stringify(rec));
  check("rotation is recorded with its reason", rec && rec.reason === "billing", JSON.stringify(rec));
}

// ── 4. Report shape carries the new counter ─────────────────────────────────
{
  const src = await import("node:fs").then((fs) => fs.readFileSync(path.join(ROOT, "src/core/omni-loop.js"), "utf8"));
  check("report declares providerRotations (stable report contract)", /providerRotations: 0,/.test(src));
  check("rotation is wired into the round-error path", /provider-rotated/.test(src));
}

console.log(failures === 0 ? "\nprovider-rotation: ALL PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
