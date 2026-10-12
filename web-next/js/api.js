// Backend API wrappers: one function per route. No streaming here (sse.js, Phase 2).

import { toast } from "./ui/toast.js";

// On 429: toast "Server rate limit — retrying in Ns" and auto-retry ONCE
// after retryAfter seconds (server sends retryAfter, server.js rate limiter).
async function req(path, opts = {}, retries = 1) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 429 && retries > 0) {
    let wait = 60;
    try {
      const data = await res.clone().json();
      if (Number.isFinite(Number(data.retryAfter))) wait = Number(data.retryAfter);
    } catch {}
    const header = res.headers.get("retry-after");
    if (header && Number.isFinite(Number(header))) wait = Number(header);
    wait = Math.max(1, Math.min(wait, 120));
    toast(`Server rate limit — retrying in ${wait}s`, "error");
    await new Promise((r) => setTimeout(r, wait * 1000));
    return req(path, opts, retries - 1);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status} for ${path}`);
  return data;
}

// backend: server.js:1919 GET /api/workspace (neo.js:1317 loadWorkspace)
export function getWorkspace() {
  return req("/api/workspace");
}

// backend: GET /api/capabilities (B1 step 8). Old servers 404 → caller
// treats every B1 feature as false. Never throws: returns null instead.
export async function getCapabilities() {
  try {
    const res = await fetch("/api/capabilities", { headers: { "Content-Type": "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- B1 fs routes (server.js /api/fs/*) ---
export function fsTree(path, depth = 2) {
  const q = `?path=${encodeURIComponent(path || "")}&depth=${depth}`;
  return req(`/api/fs/tree${q}`);
}

export function fsRead(path, maxBytes) {
  let q = `?path=${encodeURIComponent(path || "")}`;
  if (maxBytes != null) q += `&maxBytes=${encodeURIComponent(maxBytes)}`;
  return req(`/api/fs/read${q}`);
}

export function fsSearch(q, limit = 50, path = "") {
  return req(`/api/fs/search?q=${encodeURIComponent(q)}&limit=${limit}&path=${encodeURIComponent(path || "")}`);
}

export function fsWrite(path, content, expectedMtime) {
  const body = { path, content };
  if (expectedMtime !== undefined && expectedMtime !== null) body.expectedMtime = expectedMtime;
  return req("/api/fs/write", { method: "POST", body: JSON.stringify(body) });
}

// --- B1 git routes (server.js /api/git/*) ---
export function gitStatus() {
  return req("/api/git/status");
}

export function gitDiff(path, staged = false) {
  return req(`/api/git/diff?path=${encodeURIComponent(path || "")}&staged=${staged ? 1 : 0}`);
}

export function gitStage(path) {
  return req("/api/git/stage", { method: "POST", body: JSON.stringify({ path }) });
}

export function gitUnstage(path) {
  return req("/api/git/unstage", { method: "POST", body: JSON.stringify({ path }) });
}

export function gitRevert(path) {
  return req("/api/git/revert", { method: "POST", body: JSON.stringify({ path, confirm: true }) });
}

// --- B1 system routes (server.js /api/system/*) ---
export function systemReveal(path) {
  return req("/api/system/reveal", { method: "POST", body: JSON.stringify({ path }) });
}

export function systemOpen(path, app = "vscode") {
  return req("/api/system/open", { method: "POST", body: JSON.stringify({ path, app }) });
}

// backend: server.js:1992 GET /api/workspace/git — branch pill stays.
export function getGit() {
  return req("/api/workspace/git");
}

// backend: server.js:2054 GET /api/models → {ok, models[], endpoint, error, activeModel}
// (neo.js:1230 live models for the ACTIVE provider only)
export function listModels() {
  return req("/api/models");
}

// backend: server.js:2297 GET /api/provider/status → {provider, providerSecrets, readiness{ok, error?}}
// Red dot on the model pill when readiness.ok !== true.
export function getProviderStatus() {
  return req("/api/provider/status");
}

// backend: server.js:2250 POST /api/config {provider:{model}} (neo.js:1248-1251 model apply)
export function setModel(id) {
  return req("/api/config", { method: "POST", body: JSON.stringify({ provider: { model: id } }) });
}

// backend: server.js:2352 POST /api/provider/profile {profileId} (neo.js:1263-1266)
export function applyProfile(profileId) {
  return req("/api/provider/profile", { method: "POST", body: JSON.stringify({ profileId }) });
}

// backend: POST /api/provider/select {profileId?, model} — ONE atomic
// operation: switch connection + set exact model + verify the committed pair.
// Scope is global (all chats). Throws on {ok:false} AND on tool-layer
// {blocked:true} (schema/permission refusals) with a readable message.
export async function selectProviderConnection({ profileId = "", model = "", contextTokens = 0 } = {}) {
  const body = { model };
  if (profileId) body.profileId = profileId;
  if (Number.isFinite(Number(contextTokens)) && Number(contextTokens) > 0) {
    body.contextTokens = Math.round(Number(contextTokens));
  }
  const res = await req("/api/provider/select", { method: "POST", body: JSON.stringify(body) });
  if (res && (res.ok === false || res.blocked === true)) {
    const detail = (res.errors || []).join("; ") || res.error || "selection refused";
    throw new Error(res.stage && res.stage !== "done" ? `${detail} (failed at: ${res.stage})` : detail);
  }
  return res;
}

// Existing generic tool-call route (NOT B1): POST /api/tools/run {tool, input}.
// Neo's whole My-Browser panel drives browser_remote_* through this same route
// (public/neo.js:2808-2810, runTool at :2837-2846), so panel and agent share
// one connection instead of drifting apart.
export async function runTool(tool, input = {}) {
  const body = await req("/api/tools/run", { method: "POST", body: JSON.stringify({ tool, input }) });
  const result = (body && body.result) || {};
  if (result.error) {
    throw new Error(result.hint ? `${result.error} — ${result.hint}` : result.error);
  }
  return result;
}

// backend: server.js:2364 POST /api/provider/profile/save
// {name, baseUrl, model, apiKey?, authStyle?, apply?} (neo.js:2494-2497)
export function saveProfile(body) {
  return req("/api/provider/profile/save", { method: "POST", body: JSON.stringify(body) });
}

// backend: server.js:2376 POST /api/provider/profile/delete {profileId, removeKey?}
// (tool-registry.js:2898-2911)
export function deleteProfile(profileId) {
  return req("/api/provider/profile/delete", { method: "POST", body: JSON.stringify({ profileId }) });
}

// backend: server.js:2388 POST /api/provider/key {providerId, apiKey} (neo.js:2598-2601)
export function setProviderKey(providerId, apiKey) {
  return req("/api/provider/key", { method: "POST", body: JSON.stringify({ providerId, apiKey }) });
}

// backend: server.js:2403 GET /api/provider/key/status?providerId= → {statuses:[{configured, masked}]}
// Masked only — the key is never echoed back (neo.js:2603-2606 reconfirms this way).
export function keyStatus(providerId) {
  const q = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
  return req(`/api/provider/key/status${q}`);
}

// backend: server.js:2410 POST /api/provider/test
// {baseUrl, model, apiKey?, authStyle?, apiKeyProviderId?, profileId?, live:true}
// → {ok, candidate, live, message|error} (neo.js:2475-2481)
export function testProfile(body) {
  return req("/api/provider/test", { method: "POST", body: JSON.stringify(body) });
}

// backend: server.js POST /api/provider/models {profileId} or
// {baseUrl, apiKey, authStyle, apiKeyProviderId} → {ok, models[{id}]} (neo.js:2455, 2528)
export function fetchProviderModels(body) {
  return req("/api/provider/models", { method: "POST", body: JSON.stringify(body) });
}

// backend: server.js POST /api/provider/model-test {model, profileId?|baseUrl?}
// → {ok, model, endpoint, reachable, toolCalling, parallel, ...} — a minimal
// REAL call whose result persists to the model registry (D2).
export function testProviderModel(body) {
  return req("/api/provider/model-test", { method: "POST", body: JSON.stringify(body) });
}

// backend: server.js GET /api/models/registry → {models: {"base::id": {...}}}
// Persisted per-(endpoint, model) health: ok/retired/rate_limited/... (D1/D4).
export function getModelRegistry() {
  return req("/api/models/registry");
}

// backend: server.js POST /api/config {runtime:{subAgents:{model}}} — sub-agent
// model picker persistence ("inherit" = parent's full binding) (D3).
export function setSubAgentModel(model) {
  return req("/api/config", { method: "POST", body: JSON.stringify({ runtime: { subAgents: { model } } }) });
}

// backend: server.js:2871 POST /api/config/validate (config-store.js:126-163)
// Partial config ok — used as a pre-save shape check for the provider block.
export function validateConfig(patch) {
  return req("/api/config/validate", { method: "POST", body: JSON.stringify(patch) });
}

// backend: server.js:2487 POST /api/uploads {name, dataBase64} → {ok, relPath, bytes, isImage}
// (~10MB cap). Referenced in chat text as neo does (neo.js:712-715) —
// /api/chat/stream takes NO attachments[] field.
export function uploadFile(name, dataBase64) {
  return req("/api/uploads", { method: "POST", body: JSON.stringify({ name, dataBase64 }) });
}

// backend: server.js:2536 POST /api/tools/run {tool, input} — @ mentions list
// FILES via the list tools (no dedicated file-search endpoint exists;
// GET /api/fs/browse, server.js:1981, returns folders only).
const LIST_TOOLS = ["list_computer_directory", "list_directory", "list"];
export async function listFilesWithTool(dirPath) {
  let lastError = null;
  for (const tool of LIST_TOOLS) {
    try {
      const res = await req("/api/tools/run", {
        method: "POST", body: JSON.stringify({ tool, input: { path: dirPath } }),
      });
      const out = (res && (res.output || res.result || res)) || {};
      const entries = out.entries || out.files || out.items || [];
      if (Array.isArray(entries) && entries.length) {
        return entries.map((e) => (typeof e === "string"
          ? { name: e.split(/[/\\]/).pop(), path: e, type: "file" }
          : { name: e.name || "", path: e.path || "", type: e.type || (e.isDirectory ? "folder" : "file") }));
      }
      if (Array.isArray(entries)) return [];
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error("file list unavailable");
}

// backend: server.js:2880 POST /api/sessions/compact {sessionId, maxEntries?}
export function compactSession(sessionId, maxEntries = 80) {
  return req("/api/sessions/compact", { method: "POST", body: JSON.stringify({ sessionId, maxEntries }) });
}

// backend: server.js:2695 GET /api/sessions/:id/export
export function exportSession(sessionId) {
  return req(`/api/sessions/${encodeURIComponent(sessionId)}/export`);
}

// backend: server.js:2862 GET /api/memory/search?q=
export function memorySearch(query) {
  return req(`/api/memory/search?q=${encodeURIComponent(query)}`);
}

// backend: server.js:1945 GET /api/fs/browse?path= (neo.js:1394 browseTo)
export function browseFs(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  return req(`/api/fs/browse${q}`);
}

// backend: server.js:1927 POST /api/workspace/select (neo.js:1434 selectWorkspaceFolder)
export function selectWorkspace(path) {
  return req("/api/workspace/select", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

// backend: server.js:1099 GET /api/sessions (limit + optional workspace filter)
export function listSessions(limit = 200, workspace = "") {
  let q = `?limit=${encodeURIComponent(limit)}`;
  if (workspace) q += `&workspace=${encodeURIComponent(workspace)}`;
  return req(`/api/sessions${q}`);
}

// backend: server.js GET /api/sessions/:id/summary
// generate=1 → on-demand build from transcript when missing; force=1 → rebuild.
export function getSessionSummary(sessionId, { generate = false, force = false } = {}) {
  let q = "";
  if (generate) q += "?generate=1";
  if (force) q += generate ? "&force=1" : "?force=1";
  return req(`/api/sessions/${encodeURIComponent(sessionId)}/summary${q}`);
}

// backend: server.js:1465 GET /api/sessions/:id (neo.js:596 openSession)
export function getSession(sessionId) {
  return req(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

// backend: server.js:986 GET /api/runs/:id/prompt-trace (T2.1: carries
// report.budget for the Context Details block; 404 on old/unknown runs)
export async function getPromptTrace(runId) {
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/prompt-trace`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// backend: server.js:1478 POST /api/sessions/rename (neo.js:553)
export function renameSession(sessionId, label) {
  return req("/api/sessions/rename", {
    method: "POST",
    body: JSON.stringify({ sessionId, label }),
  });
}

// backend: server.js:1495 POST /api/sessions/reset (neo.js:567 archive; no true delete)
export function archiveSession(sessionId, reason = "archived-from-ui") {
  return req("/api/sessions/reset", {
    method: "POST",
    body: JSON.stringify({ sessionId, reason }),
  });
}

// NOTE: session "create" is MISSING server-side — neo creates the label locally
// (neo.js:612-621) and the server creates the session on first sendMessage.
// No create function here by design; see docs/FRONTEND_TODO.md.

// backend: server.js:2239 GET /api/config (neo.js:1200-1203 fetchConfig, unwraps .config)
// NOTE: masked key statuses (providerSecrets) and live provider info ride as
// TOP-LEVEL siblings of .config — merge them in, otherwise every consumer
// thinks no keys exist (they are masked presence flags, never secrets).
export async function getConfig() {
  const data = await req("/api/config");
  const cfg = (data && data.config) || data || {};
  if (data && data.providerSecrets && !cfg.providerSecrets) cfg.providerSecrets = data.providerSecrets;
  if (data && data.provider && !cfg.providerInfo) cfg.providerInfo = data.provider;
  return cfg;
}

// backend: server.js:2250 POST /api/config (neo.js:1188-1194 applyAccessMode,
// neo.js:1248 model apply; C2: permission mode is global, not per-thread)
export function setConfig(patch) {
  return req("/api/config", { method: "POST", body: JSON.stringify(patch) });
}

// backend: server.js:706 POST /api/runs/:id/stop (neo.js:1099 stop button;
// runId = first SSE type:"event" record.payload.runId per C3)
export function stopRun(runId) {
  return req(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
}

// backend: server.js:717 POST /api/runs/:id/steer {message|text}
// (server.js:722; confirms via run.steer_requested, agent.js:5854)
export function steerRun(runId, message) {
  return req(`/api/runs/${encodeURIComponent(runId)}/steer`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

// backend: server.js:1786 GET /api/approvals (neo.js:1544 card detail lookup;
// 4B.1: ?status=pending filters server-side for the global store poll)
export function getApprovals(status = "") {
  const q = status ? `?status=${encodeURIComponent(status)}` : "";
  return req(`/api/approvals${q}`);
}

// backend: server.js GET /api/tools?view=layers (T2.2: Core/Toolsets/Operator
// grouping with runtimeStatus health badges for the Tools page)
export function getToolsLayers() {
  return req("/api/tools?view=layers");
}

// backend: server.js POST /api/sessions/:id/toolsets {toolsets[]} (T2.2:
// per-session pinned toolsets for the menu builder; loopback-only)
export function pinSessionToolsets(sessionId, toolsets) {
  return req(`/api/sessions/${encodeURIComponent(sessionId)}/toolsets`, {
    method: "POST",
    body: JSON.stringify({ toolsets }),
  });
}

// backend: server.js:1585 POST /api/approvals/resolve {approvalId, decision, note}
// (neo.js:1559-1562; decision "approved"|"denied" — no allow-always scope exists)
export function resolveApproval(approvalId, decision, note = "") {
  return req("/api/approvals/resolve", {
    method: "POST",
    body: JSON.stringify({ approvalId, decision, note }),
  });
}

// backend: server.js:1606 POST /api/questions/answer {questionId, answer}
// (neo.js:1496-1499 → run.question_answered, agent.js:5881)
export function answerQuestion(questionId, answer) {
  return req("/api/questions/answer", {
    method: "POST",
    body: JSON.stringify({ questionId, answer }),
  });
}

// backend: server.js GET /api/questions?status=pending (Q1 4B.2, loopback-only
// open run.question list for hydration after reload; old servers 404 → null)
export async function getPendingQuestions() {
  try {
    const res = await fetch("/api/questions?status=pending", { headers: { "Content-Type": "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Footer "Gateway ready · Agents N · Cron N" + version "v0.1.0": neo builds it
// from THREE calls — GET /api/health (gateway dot + version, neo.js:467-487),
// GET /api/agents (count, neo.js:489-491), GET /api/schedules (active cron
// count, neo.js:493-496). Singles exist so idle polling can rotate ONE request
// per 10s (F5: 60 req/min limiter); getStatus is boot-only (3 reqs once).
export function getHealth() {
  return req("/api/health");
}

// backend: server.js:592 GET /api/agents (neo.js:489)
export function getAgents() {
  return req("/api/agents");
}

// ── Delegation (agent-to-agent hand-off) ──────────────────────────────────
// agentId matches BOTH sides, so one agent's list is its inbox + its outbox.
export function getDelegations(agentId, limit = 30) {
  const q = new URLSearchParams();
  if (agentId) q.set("agentId", agentId);
  q.set("limit", String(limit));
  return req(`/api/delegations?${q}`);
}

export function cancelDelegationTask(delegationId) {
  return req("/api/delegations/cancel", {
    method: "POST", body: JSON.stringify({ delegationId }),
  });
}

export function retryDelegationTask(delegationId) {
  return req("/api/delegations/retry", {
    method: "POST", body: JSON.stringify({ delegationId }),
  });
}

// backend: server.js:2034 GET /api/schedules (neo.js:493)
export function getSchedules() {
  return req("/api/schedules");
}

// backend: server.js GET /api/apps → {apps[], computerUse{}} (neo.js:1998).
// Statuses only — OAuth tokens stay encrypted server-side, never echoed.
export function getApps() {
  return req("/api/apps");
}

// backend: server.js POST /api/apps/oauth/config {provider, clientId,
// clientSecret?, scopes} (neo.js:2096). Secret is stored encrypted, never read back.
export function configureAppOAuth(body) {
  return req("/api/apps/oauth/config", { method: "POST", body: JSON.stringify(body) });
}

// OAuth start is a redirect, not fetch (neo.js:2103): the browser shows the
// official provider consent screen, then returns to /api/apps/oauth/callback/.
export function appOAuthStartUrl(providerId) {
  return `/api/apps/oauth/start?provider=${encodeURIComponent(providerId)}`;
}

// backend: server.js POST /api/apps/disconnect {provider} (neo.js:2107).
// Server clears the token; UI re-reads truth afterwards.
export function disconnectApp(providerId) {
  return req("/api/apps/disconnect", { method: "POST", body: JSON.stringify({ provider: providerId }) });
}

// backend: server.js POST /api/apps/computer-use {enabled} (neo.js:2113).
export function setComputerUse(enabled) {
  return req("/api/apps/computer-use", { method: "POST", body: JSON.stringify({ enabled: !!enabled }) });
}

// backend: server.js GET /api/plugins → {plugins[]} (neo.js:1997).
export function getPlugins() {
  return req("/api/plugins");
}

// backend: server.js POST /api/plugins/toggle {pluginId, enabled} (neo.js:2077).
export function togglePlugin(pluginId, enabled) {
  return req("/api/plugins/toggle", { method: "POST", body: JSON.stringify({ pluginId, enabled: !!enabled }) });
}

export async function getStatus() {
  const [health, agents, schedules] = await Promise.all([
    getHealth(),
    getAgents().catch(() => null),
    getSchedules().catch(() => null),
  ]);
  const provider = (health && health.provider) || {};
  const agentList = (agents && agents.agents) || [];
  const schedList = (schedules && schedules.schedules) || [];
  return {
    ok: true,
    gateway: { ok: provider.ready !== false, text: provider.ready === false ? "Gateway degraded" : "Gateway ready" },
    version: health.version || "",
    model: provider.model || provider.id || "No provider",
    agents: agentList.length,
    cron: schedList.filter((s) => s.status === "active").length,
  };
}
