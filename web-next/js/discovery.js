// Central model discovery for /next (picker + Providers settings share this).
// No backend changes: fans out over existing routes — GET /api/models for the
// ACTIVE connection, POST /api/provider/models {profileId} per saved profile.
// The backend is live-only with no cache/dedup (customization-engine.js,
// openai-compatible-provider.js), so this module owns both:
// - TTL cache (5 min) per connection key, invalidated on key replacement
//   (caller passes keyState; a changed keyState busts the entry) and on
//   explicit refresh ({force:true}).
// - In-flight dedup: concurrent callers share one network request.
// - Stale guard: every fan-out carries a token; late responses from an older
//   fan-out are dropped by the caller via isCurrent(token).
// Bounded: one request per connection per fan-out, never per keystroke.

import { listModels, fetchProviderModels } from "./api.js";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, keyState, data }
const inflight = new Map(); // key -> Promise
let fanSeq = 0;
let currentFan = 0;

export function connectionKey(conn) {
  return conn.profileId ? `profile:${conn.profileId}` : "active";
}

function normModels(models) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(models) ? models : []) {
    const id = typeof m === "string" ? m : m && m.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ctx = Number(m && (m.contextTokens ?? m.context_length ?? m.context_window));
    out.push({
      id, name: (m && m.name) || id,
      ...(Number.isFinite(ctx) && ctx > 0 ? { contextTokens: Math.round(ctx) } : {}),
    });
  }
  return out;
}

export function beginFan() {
  currentFan = ++fanSeq;
  return currentFan;
}

export function isCurrent(token) {
  return token === currentFan;
}

export function invalidateConnection(conn) {
  cache.delete(connectionKey(conn));
}

// One connection: cached models or a single live fetch. Shared inflight.
export function fetchConnectionModels(conn, { force = false } = {}) {
  const key = connectionKey(conn);
  const now = Date.now();
  const hit = cache.get(key);
  if (!force && hit && now - hit.at < TTL_MS && hit.keyState === (conn.keyState || "")) {
    return Promise.resolve({ ...hit.data, fromCache: true });
  }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    try {
      const res = conn.profileId
        ? await fetchProviderModels({ profileId: conn.profileId })
        : await listModels();
      if (res && res.ok === false) {
        return { models: [], state: "failed", error: res.error || "Model discovery failed.", fromCache: false, at: now };
      }
      const models = normModels(res && res.models);
      const data = models.length
        ? { models, state: "ok", error: "", fromCache: false, at: now }
        : { models: [], state: "empty", error: "", fromCache: false, at: now };
      cache.set(key, { at: now, keyState: conn.keyState || "", data });
      return data;
    } catch (e) {
      return { models: [], state: "failed", error: e.message || "Discovery request failed.", fromCache: false, at: now };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

export function isLoopbackUrl(baseUrl = "") {
  let host = "";
  try {
    host = new URL(String(baseUrl)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost")
    || /^127\./.test(host);
}

// Connections from a GET /api/config payload: the ACTIVE connection plus one
// entry per saved profile. ELIGIBILITY follows each adapter's real auth
// requirements — a missing raw key field does NOT prove "unauthenticated":
//   mock → built-in, always fetchable · codex-cli → CLI account, fetchable
//   openai-compatible → stored key, OR the active connection's environment key
//     (backend resolves apiKeyEnv per ACTIVE config only), OR keyless loopback
//     (local runtimes serve /models with no auth — backend allows loopback).
// Ineligible profiles ("Needs key") are NOT picker scope: no chips, no
// headings, no fetches. They surface in Providers settings as needing
// attention — never as connected accounts.
export function connectionsFromConfig(config) {
  const cfg = config || {};
  const active = cfg.provider || {};
  const profiles = cfg.providerProfiles || {};
  const secrets = cfg.providerSecrets || [];
  const storedKey = (keyId) => (secrets.find((s) => s.providerId === keyId) || {}).configured === true;

  const classify = ({ mode, baseUrl, keyId, isActive, apiKeySource, apiKeyEnv }) => {
    const m = String(mode || "openai-compatible");
    if (m === "mock") return { eligible: true, authKind: "builtin", authLabel: "Built-in (no key needed)" };
    if (m === "codex-cli") return { eligible: true, authKind: "cli-account", authLabel: "ChatGPT account (CLI)" };
    if (storedKey(keyId)) {
      const masked = (secrets.find((s) => s.providerId === keyId) || {}).masked || "";
      return { eligible: true, authKind: "stored", authLabel: masked ? `Stored key ${masked}` : "Stored key set" };
    }
    if (isActive && apiKeySource === "env") {
      return { eligible: true, authKind: "env", authLabel: `Environment key ${apiKeyEnv || ""} (managed outside OmniClaw)`.trim() };
    }
    if (isLoopbackUrl(baseUrl)) return { eligible: true, authKind: "keyless-local", authLabel: "No key needed (local endpoint)" };
    return { eligible: false, authKind: "none", authLabel: "Needs key" };
  };

  const liveInfo = cfg.providerInfo || {};
  const conns = [{
    kind: "active",
    profileId: "",
    name: active.label || "Active provider",
    baseUrl: active.baseUrl || "",
    authStyle: active.authStyle || "",
    mode: active.mode || "openai-compatible",
    keyState: `${active.apiKeyProviderId || ""}:${active.baseUrl || ""}`,
    hasKey: true, // replaced by eligible below; kept for compat
    activeModel: active.model || "",
    ...classify({
      mode: active.mode, baseUrl: active.baseUrl,
      keyId: active.apiKeyProviderId || "openai-compatible",
      isActive: true,
      apiKeySource: active.apiKeySource || liveInfo.apiKeySource || "",
      apiKeyEnv: active.apiKeyEnv || liveInfo.apiKeyEnv || "",
    }),
  }];
  for (const [pid, p] of Object.entries(profiles)) {
    const keyId = (p && p.apiKeyProviderId) || pid;
    conns.push({
      kind: "profile",
      profileId: pid,
      name: (p && p.label) || pid,
      baseUrl: (p && p.baseUrl) || "",
      authStyle: (p && p.authStyle) || "",
      mode: (p && p.mode) || "openai-compatible",
      keyState: `${keyId}:${(p && p.baseUrl) || ""}`,
      hasKey: true,
      activeModel: (p && p.model) || "",
      ...classify({ mode: p && p.mode, baseUrl: p && p.baseUrl, keyId, isActive: false }),
    });
  }
  return conns;
}

// Picker scope: eligible connections only. Everything else is a Providers
// settings concern, never picker clutter.
export function eligibleConnections(conns) {
  return (conns || []).filter((c) => c.eligible);
}
