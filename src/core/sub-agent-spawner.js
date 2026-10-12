import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
// Reuse the main loop's harness machinery so a sub-agent is NOT a weaker
// agent: verdict-first tool results + plain-rendered reads, schema-aware
// argument repair, and text-drift tool-call recovery all apply here too.
import { formatToolResultForModel, repairToolInput, extractTextModeToolCalls, extractBalancedJsonObject } from "./omni-loop.js";
import { classifyProviderError } from "./provider-error-classifier.js";
import { saveFileCheckpoint, WRITE_TOOLS } from "./file-checkpoint.js";
import { getProvider } from "./provider-factory.js";
import { isModelRetired, markModelRetired, recordModelTest, statusFromReason } from "./model-registry.js";

function generateId(prefix = "subagent") {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

function truncate(value, maxChars = 2000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  // Reserve room for the note itself so the result never exceeds maxChars.
  const shown = Math.max(0, maxChars - 60);
  return text.slice(0, shown) + `\n... [truncated, ${text.length - shown} chars omitted]`;
}

// Endpoint model-list cache (fail-fast invalid-model detection without a
// /models request per spawn). Null = list unavailable → skip validation.
// Entries carry a sample for "valid alternatives" error messages (A3).
const modelListCache = new Map();
async function fetchEndpointModels(provider) {
  let base = "";
  try {
    base = String(provider?.getInfo?.()?.baseUrl || "").trim();
  } catch { /* best effort */ }
  if (!base || typeof provider?.listModels !== "function") return null;
  const hit = modelListCache.get(base);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit;
  try {
    const list = await provider.listModels();
    const raw = Array.isArray(list) ? list : (list?.models || list?.data || []);
    const ids = new Set();
    const sample = [];
    for (const m of (Array.isArray(raw) ? raw : [])) {
      const id = String(m?.id || m?.name || m || "").trim();
      if (!id || ids.has(id)) continue;
      ids.add(id);
      if (sample.length < 12) sample.push(id);
    }
    const entry = { at: Date.now(), base, ids, sample };
    modelListCache.set(base, entry);
    return entry;
  } catch {
    return null;
  }
}

// Values of runtime.subAgents.model (and the delegate_task model arg) that
// mean "inherit the parent's FULL provider binding" (A2/A4).
function isInheritWord(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "" || v === "inherit" || v === "auto";
}

function vendorOf(modelId) {
  const s = String(modelId || "");
  return s.includes("/") ? s.split("/")[0].toLowerCase() : "";
}

function describeBinding(binding = {}) {
  const model = String(binding.model || "").trim() || "(provider default)";
  const where = binding.providerId
    ? `profile "${binding.providerId}" (${binding.baseUrl || "endpoint"})`
    : (binding.baseUrl || "main provider");
  return `${model} on ${where}`;
}

// Tools a sub-agent gets when the caller does not pass an explicit list.
// Mirrors the parent loop's core set: files, shell, web, and a real browser.
const DEFAULT_SUBAGENT_TOOLS = [
  "read_file",
  "write_file",
  "edit",
  "list_files",
  "exec",
  "process_status",
  "web_search",
  "web_fetch",
  "browser_open",
  "browser_view",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_wait",
  "memory_search",
];

export class SubAgentSpawner extends EventEmitter {
  constructor({ agentRuntime, configStore, toolRegistry, agentRegistry, memoryStore, taskStore }) {
    super();
    this.agentRuntime = agentRuntime;
    this.configStore = configStore;
    this.toolRegistry = toolRegistry;
    this.agentRegistry = agentRegistry;
    this.memoryStore = memoryStore;
    this.taskStore = taskStore;
    this.activeAgents = new Map();
    this.completedAgents = new Map();
    this.spawnTimestamps = []; // rolling-window budget (per hour)
    this.defaultTimeoutMs = 300000;
  }

  // Config-driven limits (Settings → runtime.subAgents). The old hardcoded
  // maxTotal=20 was a LIFETIME cap — after 20 spawns the gateway could never
  // delegate again until restart. Now it's a rolling per-hour budget.
  getLimits() {
    const cfg = this.configStore?.getConfig?.()?.runtime?.subAgents || {};
    const provider = this.configStore?.getConfig?.()?.provider || {};
    return {
      maxConcurrent: Math.max(1, Math.min(8, Number(cfg.maxConcurrent || 3))),
      maxPerHour: Math.max(1, Math.min(200, Number(cfg.maxPerHour || 30))),
      // Default model for ALL sub-agents. "" / "inherit" (the default) means
      // INHERIT THE PARENT'S FULL BINDING — endpoint AND model as one unit
      // (A2). An explicit id is validated against its endpoint before spawn
      // (A3) and falls down the ladder on failure (A5), never split across
      // endpoints. Research fan-out can name a cheaper model here.
      defaultModel: String(cfg.model || "").trim(),
      // On a provider rate-limit inside a sub-agent, retry once on this model.
      fallbackModel: String(cfg.fallbackModel || provider.compactionModel || "").trim(),
      timeoutMs: Math.max(30000, Math.min(1800000, Number(cfg.timeoutMs || this.defaultTimeoutMs))),
      // Transcript char budget for a sub-agent run. Lower this when sub-agents
      // run on a small-context local model (e.g. 32k window ≈ 100000 chars).
      contextChars: Math.max(30000, Math.min(2000000, Number(cfg.contextChars || 240000))),
    };
  }

  getStatus() {
    const active = Array.from(this.activeAgents.values()).map((a) => ({
      id: a.id,
      parentAgentId: a.parentAgentId,
      task: a.task,
      status: a.status,
      startedAt: a.startedAt,
      elapsedMs: Date.now() - a.startedMs,
      toolCallCount: a.toolCallCount,
    }));
    const completed = Array.from(this.completedAgents.values()).slice(-10).map((a) => ({
      id: a.id,
      parentAgentId: a.parentAgentId,
      task: a.task,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      durationMs: a.durationMs,
      resultPreview: truncate(a.result, 200),
    }));
    const limits = this.getLimits();
    const hourAgo = Date.now() - 3600000;
    return {
      activeCount: active.length,
      completedCount: this.completedAgents.size,
      maxConcurrent: limits.maxConcurrent,
      maxPerHour: limits.maxPerHour,
      spawnedThisHour: this.spawnTimestamps.filter((t) => t > hourAgo).length,
      defaultModel: limits.defaultModel || "(same as main agent)",
      fallbackModel: limits.fallbackModel || "(none)",
      active,
      recentCompleted: completed,
    };
  }

  canSpawn() {
    const limits = this.getLimits();
    const hourAgo = Date.now() - 3600000;
    this.spawnTimestamps = this.spawnTimestamps.filter((t) => t > hourAgo);
    return this.activeAgents.size < limits.maxConcurrent &&
      this.spawnTimestamps.length < limits.maxPerHour;
  }

  async spawn({
    task,
    parentAgentId = "main",
    tools = [],
    model = "",
    provider = "",
    timeoutMs = 0,
    systemPrompt = "",
    context = {},
  } = {}) {
    if (!task || !String(task).trim()) {
      throw new Error("Sub-agent task is required.");
    }
    const limits = this.getLimits();
    if (!this.canSpawn()) {
      throw new Error(
        `Cannot spawn sub-agent: ${this.activeAgents.size} active (max ${limits.maxConcurrent} concurrent), ` +
        `${this.spawnTimestamps.length} spawned this hour (max ${limits.maxPerHour}/hour). ` +
        "Wait for a running sub-agent to finish, or raise runtime.subAgents.maxConcurrent/maxPerHour in Settings.",
      );
    }
    this.spawnTimestamps.push(Date.now());

    const id = generateId();
    const agent = {
      id,
      parentAgentId,
      task: String(task).trim(),
      tools: Array.isArray(tools) ? tools : [],
      model: String(model || "").trim() || limits.defaultModel || this.configStore?.getConfig?.()?.provider?.mode || "",
      // Per-spawn model override, falling back to the configured sub-agent
      // default (runtime.subAgents.model) — so ALL sub-agents can run on a
      // cheaper/less-rate-limited model than the main agent.
      modelOverride: String(model || "").trim() || limits.defaultModel,
      // Raw explicit model (before default fallback), so validation can fail
      // fast on a user-named bad id while a stale CONFIGURED default merely
      // warns and inherits the main model instead of killing the delegation.
      explicitModel: String(model || "").trim(),
      // Optional per-call provider profile id (delegate_task `provider` arg).
      // Empty = configured dedicated provider, else the parent binding.
      requestedProvider: String(provider || "").trim(),
      // Resolved binding {provider, providerId, baseUrl, model, source} plus
      // the ordered fallback ladder — filled by resolveSubAgentBinding before
      // the first provider call (A2/A5). modelOverride always mirrors the
      // ACTIVE rung's model ("" = provider default).
      binding: null,
      ladder: [],
      ladderIndex: 0,
      // First-class child chat (Part B): own session record + transcript,
      // linked both ways. Filled by openChildSession; "" when sessions are
      // unavailable (tests) — every session op below is best-effort.
      childSessionId: "",
      childRunId: id,
      fallbackModel: limits.fallbackModel,
      timeoutMs: Number(timeoutMs) || limits.timeoutMs,
      systemPrompt: String(systemPrompt || "").trim(),
      status: "starting",
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      completedAt: null,
      completedMs: null,
      durationMs: null,
      result: null,
      error: null,
      toolCallCount: 0,
      messages: [],
      cancelRequested: false,
    };

    this.activeAgents.set(id, agent);
    this.emit("spawned", { ...agent });
    // Surface sub-agent lifecycle in the gateway activity feed — without this
    // the user sees a silent multi-minute gap while a sub-agent works.
    const gateway = this.agentRuntime?.gateway;
    gateway?.addEvent?.("subagent.spawned", {
      subagentId: id,
      parentAgentId,
      runId: context.runId || "",
      sessionId: context.sessionId || "",
      message: `sub-agent started: ${agent.task.slice(0, 140)}`,
    });

    try {
      const outcome = await this.runAgent(agent, context);
      // Honesty contract (D1): runAgent returns {status, result, reason}.
      // completed = final answer produced. incomplete = rounds/timeout/budget
      // exhausted or cancelled — NEVER reported as success.
      const status = String(outcome?.status || "failed");
      agent.status = status;
      agent.reason = String(outcome?.reason || "");
      agent.result = String(outcome?.result || "");
      agent.completedAt = new Date().toISOString();
      agent.completedMs = Date.now();
      agent.durationMs = agent.completedMs - agent.startedMs;
      this.activeAgents.delete(id);
      this.completedAgents.set(id, agent);
      this.pruneCompleted();
      this.emit(status === "completed" ? "completed" : "incomplete", { ...agent });
      // Isolation contract: the parent receives ONLY the bounded structured
      // report (never the child's tool results) plus the transcript pointer
      // and the child session id (a pointer, not content).
      const transcriptPath = this.persistSubAgentTranscript(agent);
      const report = this.buildSubAgentReport(agent, outcome, transcriptPath);
      const reportObj = this.buildSubAgentReportObject(agent, outcome, transcriptPath);
      this.finishChildRun(agent, "idle");
      gateway?.addEvent?.(status === "completed" ? "subagent.completed" : "subagent.incomplete", {
        subagentId: id,
        parentAgentId,
        runId: context.runId || "",
        sessionId: context.sessionId || "",
        childSessionId: agent.childSessionId || "",
        childRunId: agent.childRunId || id,
        durationMs: agent.durationMs,
        toolCallCount: agent.toolCallCount,
        status,
        reason: agent.reason,
        report: reportObj,
        message: status === "completed"
          ? `sub-agent done in ${Math.round(agent.durationMs / 1000)}s (${agent.toolCallCount} tools): ${truncate(agent.result, 160)}`
          : `sub-agent INCOMPLETE (${agent.reason || "no reason"}) after ${Math.round(agent.durationMs / 1000)}s (${agent.toolCallCount} tools)`,
      });
      return {
        id: agent.id,
        status,
        reason: agent.reason,
        result: report,
        transcriptPath,
        childSessionId: agent.childSessionId || "",
        durationMs: agent.durationMs,
        toolCallCount: agent.toolCallCount,
      };
    } catch (error) {
      const wasCancelled = Boolean(error?.cancelled || agent.cancelRequested);
      const msg = String(error?.message || "");
      // Timeout / budget exhaustion maps to incomplete (never completed, never
      // silent success). Genuine errors stay failed.
      const isBudget = /timed out|timeout|budget|rounds/i.test(msg);
      const status = wasCancelled || isBudget ? "incomplete" : "failed";
      const reason = wasCancelled ? "cancelled" : (isBudget ? "budget-exhausted" : "error");
      agent.status = status;
      agent.reason = wasCancelled ? "cancelled by request" : msg.slice(0, 400);
      agent.error = status === "failed" ? msg : null;
      agent.completedAt = new Date().toISOString();
      agent.completedMs = Date.now();
      agent.durationMs = agent.completedMs - agent.startedMs;
      this.activeAgents.delete(id);
      this.completedAgents.set(id, agent);
      this.pruneCompleted();
      this.emit(status === "incomplete" ? "incomplete" : "failed", { ...agent });
      try {
        this.mirrorChildMessage(agent, {
          text: status === "failed"
            ? `Sub-agent failed: ${msg.slice(0, 500)}`
            : `Sub-agent stopped (${reason}): ${(agent.result || msg).slice(0, 500)}`,
        });
      } catch { /* best effort */ }
      const transcriptPath = this.persistSubAgentTranscript(agent);
      const report = this.buildSubAgentReport(agent, { status, reason, result: agent.result || msg }, transcriptPath);
      const reportObj = this.buildSubAgentReportObject(agent, { status, reason, result: agent.result || msg }, transcriptPath);
      this.finishChildRun(agent, status === "failed" ? "error" : "idle");
      gateway?.addEvent?.(status === "incomplete" ? "subagent.incomplete" : "subagent.failed", {
        subagentId: id,
        parentAgentId,
        runId: context.runId || "",
        sessionId: context.sessionId || "",
        childSessionId: agent.childSessionId || "",
        childRunId: agent.childRunId || id,
        durationMs: agent.durationMs,
        status,
        reason: agent.reason,
        report: reportObj,
        message: status === "incomplete" ? `sub-agent INCOMPLETE (${reason}): ${msg.slice(0, 160)}` : `sub-agent failed: ${msg.slice(0, 160)}`,
      });
      if (status === "incomplete") {
        return {
          id: agent.id,
          status,
          reason,
          result: report,
          transcriptPath,
          childSessionId: agent.childSessionId || "",
          durationMs: agent.durationMs,
          toolCallCount: agent.toolCallCount,
        };
      }
      const wrapped = new Error(msg);
      wrapped.subagentStatus = status;
      wrapped.subagentReport = report;
      throw wrapped;
    }
  }

  // Keep only the newest completed records — the map used to grow forever
  // (and worse, counted against the old lifetime spawn cap).
  pruneCompleted(keep = 20) {
    while (this.completedAgents.size > keep) {
      const oldest = this.completedAgents.keys().next().value;
      this.completedAgents.delete(oldest);
    }
  }

  // Full child transcript to disk as JSONL (one JSON object per line).
  // Truncation happens ONLY at line boundaries — never mid-JSON — and every
  // line is validated to parse after writing (D2). The parent only ever gets
  // the ≤2000-char structured report below, never these tool results.
  persistSubAgentTranscript(agent) {
    try {
      const rootDir = this.agentRuntime?.rootDir || process.cwd();
      const dir = path.join(rootDir, "tmp", "subagents");
      fs.mkdirSync(dir, { recursive: true });
      const safeId = String(agent.id || "subagent").replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 120);
      const filePath = path.join(dir, `${safeId}.jsonl`);
      const header = { v: 1, id: agent.id, task: agent.task, status: agent.status, reason: agent.reason || "", model: agent.modelOverride || agent.model || "", startedAt: agent.startedAt, completedAt: agent.completedAt, durationMs: agent.durationMs, toolCallCount: agent.toolCallCount };
      const lines = [JSON.stringify(header)];
      for (const m of agent.messages || []) {
        try { lines.push(JSON.stringify(m)); } catch { lines.push(JSON.stringify({ role: m?.role || "unknown", truncated: true })); }
      }
      // Budget ~500k chars, cut ONLY whole lines from the middle (keep header
      // + newest tail; oldest tool results are the least valuable).
      const MAX_CHARS = 500000;
      let total = lines.reduce((n, l) => n + l.length + 1, 0);
      if (total > MAX_CHARS) {
        const keepHead = 1;
        const keepTail = Math.max(4, Math.floor((lines.length - keepHead) / 3));
        const head = lines.slice(0, keepHead);
        const tail = lines.slice(lines.length - keepTail);
        const dropped = lines.length - head.length - tail.length;
        lines.length = 0;
        lines.push(...head, JSON.stringify({ truncated: true, droppedLines: dropped }), ...tail);
      }
      const body = lines.join("\n") + "\n";
      fs.writeFileSync(filePath, body, "utf8");
      // Validate: every non-empty line must parse (D2).
      const check = String(fs.readFileSync(filePath, "utf8")).split("\n").filter((l) => l.trim());
      for (const line of check) JSON.parse(line);
      try {
        const now = Date.now();
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith(".jsonl") && !name.endsWith(".json")) continue;
          const full = path.join(dir, name);
          try {
            if (now - fs.statSync(full).mtimeMs > 7 * 24 * 60 * 60 * 1000) fs.rmSync(full, { force: true });
          } catch { /* best effort */ }
        }
      } catch { /* best effort */ }
      return filePath.replace(/\\/g, "/");
    } catch {
      return "";
    }
  }

  // Close the child run on its session (clears activeRunId, appends the run
  // completed entry) so open-as-chat stops attaching and replays cleanly.
  finishChildRun(agent, status = "idle") {
    try {
      if (agent.childSessionId && typeof this.agentRuntime?.sessions?.finishRun === "function") {
        this.agentRuntime.sessions.finishRun(agent.childSessionId, agent.childRunId || agent.id, { status });
      }
    } catch { /* best effort */ }
  }

  // Structured report as data (for subagent.completed/incomplete event
  // payloads → the /next child card). buildSubAgentReport formats it for the
  // parent model context (bounded string, never child tool content).
  buildSubAgentReportObject(agent, outcome = {}, transcriptPath = "") {
    const status = String(outcome.status || agent.status || "failed");
    const reason = String(outcome.reason || agent.reason || "");
    const raw = String(outcome.result || agent.result || "");
    const files = [];
    try {
      for (const m of agent.messages || []) {
        for (const tc of m.tool_calls || []) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
          const p = args.path || args.file || args.target || "";
          if (p && (tc.function?.name || "").match(/write|edit|patch/i)) {
            const s = String(p);
            if (!files.includes(s)) files.push(s);
          }
        }
      }
    } catch { /* best effort */ }
    return {
      status,
      reason,
      done: (raw || "(no output)").slice(0, 900),
      notDone: status === "completed"
        ? ""
        : (reason || "Task did not complete; re-plan with a smaller scope or retry.").slice(0, 400),
      filesTouched: files.slice(0, 12),
      transcriptPath: transcriptPath || "",
      childSessionId: agent.childSessionId || "",
      toolCallCount: agent.toolCallCount || 0,
      durationMs: agent.durationMs || 0,
    };
  }

  // Bounded structured report for the parent (D3): status, what was done,
  // what was NOT done, files touched, transcript path. ≤2000 chars. The
  // parent receives ONLY this — never the child's tool results.
  buildSubAgentReport(agent, outcome = {}, transcriptPath = "") {
    const rep = this.buildSubAgentReportObject(agent, outcome, transcriptPath);
    const lines = [
      `status: ${rep.status}`,
      rep.reason ? `reason: ${rep.reason}` : null,
      `done: ${rep.done}`,
      rep.notDone ? `notDone: ${rep.notDone}` : null,
      `filesTouched: ${rep.filesTouched.join(", ") || "(none)"}`,
      rep.transcriptPath ? `transcript: ${rep.transcriptPath}` : null,
      rep.childSessionId ? `session: ${rep.childSessionId} (open as chat to replay every step)` : null,
      `tools: ${rep.toolCallCount}, durationMs: ${rep.durationMs}`,
    ].filter(Boolean);
    let report = lines.join("\n");
    if (report.length > 2000) report = report.slice(0, 1940) + "\n... [report truncated]";
    return report;
  }

  // The parent's FULL provider binding as one unit: endpoint (baseUrl + key,
  // baked into the provider instance) AND the model id actually answering the
  // parent (run-scoped override first, then configured main model). Inheriting
  // a model id WITHOUT its endpoint is what produced "not a valid model id
  // on the active endpoint" — this is never split again (A2).
  parentBinding(context = {}) {
    const main = this.agentRuntime?.provider || null;
    let baseUrl = "";
    let mainModel = "";
    try {
      const info = main?.getInfo?.() || {};
      baseUrl = String(info.baseUrl || "").trim();
      mainModel = String(info.model || "").trim();
    } catch { /* best effort */ }
    try {
      const runId = String(context?.runId || "").trim();
      const runModel = runId
        ? String(this.agentRuntime?.gateway?.getRun?.(runId)?.model || "").trim()
        : "";
      if (runModel) mainModel = runModel;
    } catch { /* best effort */ }
    try {
      if (!mainModel) mainModel = String(this.configStore?.getConfig?.()?.provider?.model || "").trim();
      if (!baseUrl) baseUrl = String(this.configStore?.getConfig?.()?.provider?.baseUrl || "").trim();
    } catch { /* best effort */ }
    return { provider: main, providerId: "", baseUrl, model: mainModel, source: "inherited" };
  }

  // Build a provider instance for a profile id (the dedicated sub-agent
  // connection: its own baseUrl + own key). Null when unset/unusable.
  providerForProfile(profileId) {
    try {
      const id = String(profileId || "").trim();
      if (!id) return { provider: null, usable: false };
      const dedicated = getProvider(this.configStore, this.agentRuntime?.secrets, id);
      if (!dedicated) {
        return {
          provider: null,
          usable: false,
          warning: `sub-agent provider "${id}" is selected but has no usable API key — add its key in Settings.`,
        };
      }
      const info = dedicated.getInfo?.() || {};
      return {
        provider: dedicated,
        providerId: id,
        baseUrl: String(info.baseUrl || "").trim(),
        model: String(info.model || "").trim(),
        usable: true,
      };
    } catch {
      return { provider: null, usable: false };
    }
  }

  // Validate ONE (model, endpoint) pair before it is ever sent (A3).
  // {ok} — or {ok:false, reason:"retired"|"not-listed", alternatives[]}.
  // A missing model list is NOT a failure (can't prove anything) — the
  // call-time ladder still guards the first request.
  async checkModelOnEndpoint(provider, baseUrl, model) {
    const id = String(model || "").trim();
    if (!id) return { ok: true, empty: true };
    const rootDir = this.agentRuntime?.rootDir;
    if (isModelRetired(rootDir, baseUrl, id)) return { ok: false, reason: "retired" };
    const listed = await fetchEndpointModels(provider);
    if (!listed) return { ok: true, unlisted: true };
    if (listed.ids.has(id)) return { ok: true };
    return { ok: false, reason: "not-listed", alternatives: (listed.sample || []).filter((s) => s !== id).slice(0, 8) };
  }

  // Last-resort ladder rung: a loopback-hosted model (local-first escapes a
  // dead cloud ladder). Probed with a short timeout; never throws, never
  // blocks spawn for long.
  async probeLocalBinding(excludeKeys = new Set()) {
    try {
      const cfg = this.configStore?.getConfig?.() || {};
      const profiles = cfg.providerProfiles || {};
      for (const [id, profile] of Object.entries(profiles)) {
        const baseUrl = String(profile?.baseUrl || "");
        if (!/localhost|127\.0\.0\.1|::1/i.test(baseUrl)) continue;
        const model = String(profile?.model || "").trim();
        if (!model || excludeKeys.has(`local:${model}`)) continue;
        const built = this.providerForProfile(id);
        if (!built.usable) continue;
        const listed = await Promise.race([
          fetchEndpointModels(built.provider),
          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
        ]);
        if (listed && !listed.ids.has(model)) continue;
        return { provider: built.provider, providerId: id, baseUrl: built.baseUrl, model, source: "local" };
      }
    } catch { /* best effort */ }
    return null;
  }

  // Resolve the ordered fallback ladder for one spawn (A2/A4/A5).
  // Rung 0 is the primary; every rung is a COMPLETE binding (endpoint+model).
  // Returns {ladder, primary}. Throws ONLY for an explicitly requested model
  // that is invalid everywhere it could run (A3 fail-fast with alternatives).
  async resolveSubAgentBinding({ model = "", provider = "", context = {}, subagentId = "" } = {}) {
    const gateway = this.agentRuntime?.gateway;
    const rootDir = this.agentRuntime?.rootDir;
    const cfg = this.configStore?.getConfig?.() || {};
    const sub = cfg.runtime?.subAgents || {};
    const explicit = String(model || "").trim();
    const explicitProviderId = String(provider || "").trim();
    const configured = String(sub.model || "").trim();
    const dedicatedId = String(sub.provider || "").trim();
    const parent = this.parentBinding(context);
    const ladder = [];
    const seen = new Set();
    const pushRung = (rung) => {
      if (!rung || !rung.provider) return false;
      const key = `${rung.providerId || ""}::${rung.model || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      ladder.push(rung);
      return true;
    };
    const warn = (message, extra = {}) => {
      try {
        gateway?.addEvent?.("subagent.model_fallback", {
          subagentId: subagentId || extra.subagentId || "",
          model: extra.model || "",
          message,
        });
      } catch { /* best effort */ }
    };

    // 1. Explicit per-call model: the endpoint follows the model (never split).
    //    explicit provider > dedicated > parent; valid elsewhere ⇒ retarget
    //    with a warning; invalid everywhere ⇒ immediate clear failure (A3).
    if (explicit) {
      const targets = [];
      if (explicitProviderId) {
        const t = this.providerForProfile(explicitProviderId);
        if (!t.usable || !t.provider) {
          throw new Error(`Sub-agent provider "${explicitProviderId}" is not usable (${t.warning || "missing key or unknown profile"}). Fix: apply the profile in Settings, or omit provider to inherit the parent binding.`);
        }
        targets.push({ ...t, strict: true });
      } else {
        if (dedicatedId) {
          const t = this.providerForProfile(dedicatedId);
          if (t.usable && t.provider) targets.push(t);
        }
        if (parent.provider) {
          targets.push({ provider: parent.provider, providerId: "", baseUrl: parent.baseUrl, model: "", usable: true });
        }
      }
      if (targets.length === 0) {
        throw new Error(`Sub-agent model "${explicit}" has no endpoint to run on (dedicated provider unusable and no parent provider). Fix: apply a provider profile in Settings.`);
      }
      let primary = null;
      let firstAlternatives = [];
      let retiredSomewhere = false;
      const triedNotes = [];
      for (const target of targets) {
        const check = await this.checkModelOnEndpoint(target.provider, target.baseUrl, explicit);
        const label = target.providerId ? `provider "${target.providerId}"` : "parent endpoint";
        triedNotes.push(`${label}: ${check.ok ? "valid" : check.reason}`);
        if (check.ok) { primary = { target, strict: Boolean(target.strict) }; break; }
        if (check.reason === "retired") {
          retiredSomewhere = true;
          markModelRetired(rootDir, target.baseUrl, explicit, "explicit model retired on endpoint");
          continue;
        }
        if (firstAlternatives.length === 0 && check.alternatives) firstAlternatives = check.alternatives;
      }
      if (!primary) {
        const scope = explicitProviderId
          ? `provider profile "${explicitProviderId}"`
          : `the active endpoint (${triedNotes.join("; ") || "unreachable"})`;
        const alts = firstAlternatives.length ? ` Valid models there: ${firstAlternatives.join(", ")}.` : "";
        const retiredNote = retiredSomewhere ? ` Model "${explicit}" is RETIRED and will never work again.` : "";
        throw new Error(`Sub-agent model "${explicit}" is not a valid model id on ${scope}.${retiredNote}${alts} Fix: pass a valid model, omit model to inherit the parent binding (${parent.model || "provider default"} on ${parent.baseUrl || "main endpoint"}), or omit provider to let the endpoint follow the model.`);
      }
      if (!primary.strict && primary.target !== targets[0]) {
        const fromLabel = targets[0].providerId ? `provider "${targets[0].providerId}"` : "the first endpoint";
        const toLabel = primary.target.providerId ? `provider "${primary.target.providerId}"` : "the parent binding";
        warn(`explicit model "${explicit}" is not on ${fromLabel} — retargeted to ${toLabel} so model and endpoint stay together`, { model: explicit });
      }
      pushRung({ provider: primary.target.provider, providerId: primary.target.providerId || "", baseUrl: primary.target.baseUrl, model: explicit, source: "explicit" });
    } else if (!isInheritWord(configured)) {
      // 2. Configured default: forgiving — warn and ladder on (a stale value
      //    must not kill the delegation).
      const target = dedicatedId
        ? this.providerForProfile(dedicatedId)
        : { provider: parent.provider, providerId: "", baseUrl: parent.baseUrl, model: "", usable: Boolean(parent.provider) };
      if (!target.usable || !target.provider) {
        warn(`configured sub-agent model "${configured}" has no usable endpoint (${target.warning || "dedicated provider unusable"}) — using the parent binding`, { model: configured });
      } else {
        const check = await this.checkModelOnEndpoint(target.provider, target.baseUrl, configured);
        if (check.ok) {
          pushRung({ provider: target.provider, providerId: target.providerId || "", baseUrl: target.baseUrl, model: configured, source: "configured" });
        } else {
          if (check.reason === "retired") markModelRetired(rootDir, target.baseUrl, configured, "configured default retired");
          warn(`configured sub-agent model "${configured}" is ${check.reason === "retired" ? "RETIRED" : "not valid"} on ${target.providerId ? `provider "${target.providerId}"` : "the parent endpoint"} — inheriting the parent binding for this run (fix runtime.subAgents.model in Settings)`, { model: configured });
        }
      }
    }
    // 3. Dedicated provider default — ONLY when that exact (endpoint, model)
    //    validates. A blind profile default is how a retired model 410s at
    //    call time with the endpoint kept and the model dropped.
    if (dedicatedId) {
      const target = this.providerForProfile(dedicatedId);
      if (target.usable && target.model) {
        const check = await this.checkModelOnEndpoint(target.provider, target.baseUrl, target.model);
        if (check.ok) {
          pushRung({ provider: target.provider, providerId: target.providerId, baseUrl: target.baseUrl, model: target.model, source: "dedicated-default" });
        } else {
          if (check.reason === "retired") markModelRetired(rootDir, target.baseUrl, target.model, "dedicated default retired");
          warn(`dedicated provider "${dedicatedId}" default model "${target.model}" is ${check.reason === "retired" ? "RETIRED" : "not valid"} there — the dedicated endpoint is skipped for this run`, { model: target.model });
        }
      }
    }
    // 4. No explicit choice: the parent full binding is the primary
    //    (inherit = endpoint AND model as one unit). A chosen primary from
    //    steps 1-3 keeps its position ahead of this.
    if (ladder.length === 0 && parent.provider) {
      pushRung({ provider: parent.provider, providerId: "", baseUrl: parent.baseUrl, model: parent.model, source: "inherited" });
    }
    // 5. Configured fallback rung (A5): anchored on the primary rung.
    //    Validation decides when the endpoint list is available (multi-vendor
    //    endpoints like OpenRouter serve many prefixes from one connection, so
    //    a vendor guess must never overrule a successful validation). The
    //    vendor heuristic applies ONLY when blind (no list): a cross-vendor
    //    fallback then likely turns a rate-limit into an invalid-model.
    {
      const anchor = ladder[0] || null;
      const primaryModel = String((ladder[0] && ladder[0].model) || parent.model || "");
      const fallback = String(sub.fallbackModel || cfg.provider?.compactionModel || "").trim();
      if (anchor && fallback && fallback !== String((ladder[0] && ladder[0].model) || "")) {
        const check = await this.checkModelOnEndpoint(anchor.provider, anchor.baseUrl, fallback);
        if (check.ok) {
          pushRung({ provider: anchor.provider, providerId: anchor.providerId || "", baseUrl: anchor.baseUrl, model: fallback, source: "fallback" });
        } else if (check.reason === "retired") {
          markModelRetired(rootDir, anchor.baseUrl, fallback, "fallback model retired");
        } else if (check.unlisted) {
          const mismatch = primaryModel && vendorOf(fallback) && vendorOf(primaryModel) && vendorOf(fallback) !== vendorOf(primaryModel);
          if (!mismatch) {
            pushRung({ provider: anchor.provider, providerId: anchor.providerId || "", baseUrl: anchor.baseUrl, model: fallback, source: "fallback" });
          } else {
            warn(`fallback model "${fallback}" looks cross-vendor to "${primaryModel}" and the endpoint list is unavailable — skipping it rather than turning a rate-limit into an invalid-model`, { model: fallback });
          }
        }
      }
    }
    // 6. Parent full binding as a ladder rung when it is not already the
    //    primary (dedupes to a no-op when inherited above).
    if (parent.provider) {
      pushRung({ provider: parent.provider, providerId: "", baseUrl: parent.baseUrl, model: parent.model, source: "inherited" });
    }
    // 7. Local loopback last resort (probed with a short timeout, never fatal).
    {
      const exclude = new Set(ladder.map((r) => String(r.model || "")).filter(Boolean));
      const local = await this.probeLocalBinding(exclude);
      if (local) pushRung(local);
    }
    if (ladder.length === 0) {
      throw new Error("No provider available for sub-agent execution.");
    }
    return { ladder, parent };
  }

  async runAgent(agent, context) {
    const gateway = this.agentRuntime?.gateway;
    // Binding-first (A2/A3/A5): resolve the COMPLETE ordered ladder before
    // the first provider call — endpoint+model as one unit, pre-validated.
    const { ladder } = await this.resolveSubAgentBinding({
      model: agent.explicitModel,
      provider: agent.requestedProvider,
      context,
      subagentId: agent.id,
    });
    agent.ladder = ladder;
    agent.ladderIndex = 0;
    agent.binding = ladder[0];
    agent.modelOverride = String(ladder[0].model || "");
    const provider = ladder[0].provider;
    // First-class child chat (Part B): own session + transcript from here on.
    // All child gateway events below carry the child session/run ids PLUS the
    // parent ids, so the parent thread can route them into the child card
    // while the child's own view replays them as a normal chat.
    {
      const linkage = this.openChildSession(agent, context);
      if (linkage) {
        agent.childSessionId = linkage.childSessionId;
        agent.childRunId = linkage.childRunId;
      }
      // Mark the child session busy so open-as-chat shows the live note and
      // attaches to the child run's event stream (same as a main chat).
      try {
        this.agentRuntime?.sessions?.startRun?.(agent.childSessionId, {
          runId: agent.childRunId || agent.id,
          message: agent.task.slice(0, 140),
        });
      } catch { /* best effort */ }
    }
    const childSessionId = String(agent.childSessionId || "");
    const childRunId = String(agent.childRunId || agent.id || "");
    const parentRunId = String(context.runId || "");
    const parentSessionId = String(context.sessionId || "");
    const childAgentId = agent.parentAgentId || "main";
    const childEventBase = () => ({
      runId: childRunId,
      sessionId: childSessionId || parentSessionId,
      parentRunId,
      parentSessionId,
      subagentId: agent.id,
      agentId: childAgentId,
      source: "sub-agent",
    });
    // Child-scoped tool context: read ledger, checkpoints, and workspace-root
    // resolution follow the CHILD session (whose workspacePath mirrors the
    // parent project), never the parent's live run state.
    const childCtx = {
      ...context,
      sessionId: childSessionId || context.sessionId,
      runId: childRunId,
      parentSessionId: parentSessionId || undefined,
      parentRunId: parentRunId || undefined,
      source: "sub-agent",
    };
    // Binding event carries the child session link (open-as-chat/sidebar).
    gateway?.addEvent?.("subagent.binding", {
      subagentId: agent.id,
      parentAgentId: agent.parentAgentId,
      runId: parentRunId,
      sessionId: parentSessionId,
      childSessionId: childSessionId || "",
      childRunId,
      providerId: ladder[0].providerId || "",
      baseUrl: ladder[0].baseUrl || "",
      model: ladder[0].model || "(provider default)",
      source: ladder[0].source || "",
      ladder: ladder.map((r) => `${r.source || "?"}:${r.providerId || "parent"}/${r.model || "default"}`),
      message: `sub-agent binding: ${describeBinding(ladder[0])} [${ladder[0].source || "?"}]`,
    });
    if (ladder[0].providerId) {
      gateway?.addEvent?.("subagent.provider_dedicated", { subagentId: agent.id, providerId: ladder[0].providerId });
    }
    const primarySupportsTools = typeof provider.completeWithTools === "function";
    if (!primarySupportsTools && typeof provider.complete !== "function") {
      throw new Error("Current provider does not support sub-agent completion.");
    }
    const toolIds = agent.tools.length > 0 ? agent.tools : DEFAULT_SUBAGENT_TOOLS;
    const toolDefinitions = primarySupportsTools ? this.buildToolDefinitions(toolIds) : [];
    const availableToolIds = new Set(toolDefinitions.map((def) => def.function.name));
    const toolParamSchemas = new Map(toolDefinitions.map((def) => [def.function.name, def.function.parameters || {}]));

    // Same environment truth the main loop gets — without it a weak model
    // assumes Linux/bash and its shell commands fail on this machine.
    const isWin = process.platform === "win32";
    const rootDir = this.agentRuntime?.rootDir || process.cwd();
    const envSection = [
      `Environment: ${isWin ? "Windows" : process.platform} · shell for exec = ${isWin ? "Windows PowerShell (NOT bash: no && / mkdir -p / touch / 2>/dev/null — use ; / write_file / Test-Path / 2>$null)" : "bash"} · project root: ${rootDir}`,
      "write_file/edit auto-create parent folders and resolve relative paths from the project root.",
    ].join("\n");

    const systemPrompt = agent.systemPrompt || `You are a focused sub-agent working on ONE specific task delegated by your parent agent. You cannot see the parent conversation — the task text is your full spec.
${envSection}
Work in small verifiable steps: inspect -> act -> observe -> verify. Read a file before editing it.
TOOL ARGUMENT RULES (strict): every tool call MUST include its required arguments — never call a tool with {} or missing fields. write_file needs BOTH path AND content. edit needs path AND find AND replace. exec needs command. read_file needs path. If you do not have a required value yet, get it first (list_files / read_file), then make the call once, complete.
Call tools through the native function-calling interface; never describe a tool call in prose.
When the task is complete (or genuinely blocked), reply with final text only and no tool calls. Your final reply goes back to the parent agent: lead with the OUTCOME (what was produced/changed, with exact file paths), then key evidence (commands run + results). Be dense and factual — the parent cannot see your tool calls, only this summary.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: agent.task },
    ];

    agent.messages = [...messages];
    agent.status = "running";

    const timeoutMs = agent.timeoutMs;
    const startTime = Date.now();
    const maxToolRounds = 24;
    // Identical-call budget (parent-loop parity): a weak model inside a
    // sub-agent can spin the same read/search with the same args for all 24
    // rounds. After 3 identical calls the harness answers instead of the tool.
    const identicalCallCounts = new Map();
    const MAX_IDENTICAL_CALLS = 3;
    // Schema-spin guard (parent-loop parity): a weak model can fail the SAME
    // tool with the SAME missing required args every round (live: exec{} →
    // "command is required" x3, write_file{} → "path/content required" x2)
    // and just spin until the 300s timeout. Fail LOUD and EARLY instead.
    const schemaSpinCounts = new Map(); // tool -> consecutive schema-blocked count
    const MAX_SCHEMA_SPINS = 2;
    // No-progress guard (live 2026-09-19: a weak model returned 6 empty
    // content turns with 0 tool calls and the sub-agent reported "Task
    // completed with no output"). A sub-agent that produces NOTHING — no
    // text, no tool call — round after round is stuck, not done.
    let consecutiveEmptyRounds = 0;
    const MAX_EMPTY_ROUNDS = 3;

    const throwIfCancelled = () => {
      if (agent.cancelRequested) {
        const err = new Error("Sub-agent cancelled by request.");
        err.cancelled = true;
        throw err;
      }
    };

    for (let round = 0; round < maxToolRounds; round++) {
      throwIfCancelled();
      if (Date.now() - startTime > timeoutMs) {
        const lastOut = agent.messages.length > 0
          ? String(agent.messages[agent.messages.length - 1]?.content || "").slice(0, 300)
          : "none";
        throw new Error(`Sub-agent timed out after ${timeoutMs}ms (${round} rounds, ${agent.toolCallCount} tool calls). Last output: ${lastOut || "none"}. Split the task smaller or raise runtime.subAgents.timeoutMs.`);
      }
      // Same thinking shape as the main loop so the child view renders it.
      try {
        gateway?.addEvent?.("agent.thinking", {
          ...childEventBase(),
          phase: "sub-agent",
          step: agent.toolCallCount,
          maxSteps: maxToolRounds,
          message: `Sub-agent round ${round + 1}/${maxToolRounds}: reading observations and deciding the next action.`,
        });
      } catch { /* best effort */ }
      // Deterministic context bound: sub-agents have no LLM compaction, so a
      // file-heavy delegation used to grow the transcript until the provider
      // died on context overflow — killing the whole delegation. Stub old tool
      // results (newest turns keep full fidelity) before each model call.
      const trimmed = this.boundSubAgentContext(messages, { maxChars: this.getLimits().contextChars });
      if (trimmed > 0) {
        this.agentRuntime?.gateway?.addEvent?.("subagent.context_bounded", {
          subagentId: agent.id, round, trimmedToolResults: trimmed,
          childSessionId: childSessionId || "", childRunId,
        });
      }

      const remainingMs = Math.max(5000, timeoutMs - (Date.now() - startTime));
      const activeBinding = agent.binding || {};
      const activeProvider = activeBinding.provider || provider;
      // Recomputed per round: a ladder step can move the child to a provider
      // with different tool-calling support.
      const nativeTools = typeof activeProvider.completeWithTools === "function";
      const modelOpt = activeBinding.model ? { model: activeBinding.model } : {};
      let response;
      try {
        response = nativeTools
          ? await activeProvider.completeWithTools(messages, {
              tools: toolDefinitions,
              toolChoice: "auto",
              maxTokens: 4000,
              temperature: 0,
              timeoutMs: remainingMs,
              ...modelOpt,
            })
          : await activeProvider.complete(messages, { maxTokens: 1600, temperature: 0, timeoutMs: remainingMs, ...modelOpt });
      } catch (error) {
        // Ladder step-down (A5): rate-limit, invalid/retired model, or an
        // unreachable endpoint moves to the next COMPLETE binding instead of
        // killing the delegation. Retired ids are recorded so no future spawn
        // offers them again (D4).
        const classified = classifyProviderError(error);
        const advanced = await this.advanceLadder(agent, context, classified, error);
        if (advanced) {
          round -= 1; // retry this round on the next ladder rung
          continue;
        }
        // Ladder exhausted: ACTIONABLE reason naming the real binding — model
        // AND endpoint as one unit, never a "(main model)" placeholder.
        const tried = (agent.ladder || []).map((r) => describeBinding(r)).join(" → ") || describeBinding(agent.binding);
        const reason = classified.reason === "billing"
          ? "out of credits / payment required on the active endpoint"
          : classified.isRateLimit
            ? "rate-limited on every configured endpoint"
            : (classified.isModelGone
              ? "rejected as an invalid/retired model on the active endpoint"
              : (classified.reason === "auth"
                ? "rejected — the active endpoint's API key is missing or invalid"
                : (classified.userMessage || "the provider request failed")));
        const hint = `Sub-agent binding ${describeBinding(agent.binding)} failed: ${reason}${activeBinding.baseUrl ? ` (endpoint: ${activeBinding.baseUrl})` : ""}. Ladder tried: ${tried}. Fix: give the child a model that is valid on its endpoint (delegate_task {model} + {provider}), or set runtime.subAgents.model to "inherit" so the child runs exactly where the parent runs. Raw: ${String(error?.message || "").slice(0, 200)}`;
        const wrapped = new Error(hint);
        wrapped.cause = error;
        wrapped.subagentModel = String((agent.binding && agent.binding.model) || "");
        throw wrapped;
      }

      const responseText = response.content || response.text || "";
      let toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];

      // Text-drift recovery: a weak model may write the tool call as JSON text
      // instead of a native call — recover it instead of ending the run.
      if (toolCalls.length === 0) {
        const recovered = extractTextModeToolCalls(responseText, availableToolIds, 5);
        if (recovered.length > 0) {
          toolCalls = recovered.map((call, index) => ({ id: `subrecovered_${round}_${index}`, tool: call.tool, input: call.input }));
        }
      }

      if (toolCalls.length === 0) {
        // Empty-response guard: a weak model can emit turn after turn of
        // blank/whitespace content with no tool call. That is NOT completion —
        // it is the model stuck. Count consecutive empty rounds; after the
        // budget, return incomplete with an actionable reason instead of
        // "Task completed with no output" (which lies to the parent).
        const isEmpty = !String(responseText || "").trim();
        if (isEmpty) {
          consecutiveEmptyRounds += 1;
          if (consecutiveEmptyRounds >= MAX_EMPTY_ROUNDS) {
            const stuckResult = `Sub-agent produced ${consecutiveEmptyRounds} consecutive empty responses with no tool calls — the model is not engaging with the task. Re-delegate with a stronger model (delegate_task {model}) or rephrase the task with more concrete instructions.`;
            this.mirrorChildMessage(agent, { text: stuckResult });
            return { status: "incomplete", reason: "empty-response-spin", result: stuckResult, toolCallCount: agent.toolCallCount };
          }
          // Nudge once so a borderline model gets a chance to recover.
          messages.push({ role: "assistant", content: responseText || "[empty]" });
          agent.messages.push({ role: "assistant", content: responseText || "[empty]" });
          messages.push({ role: "user", content: "Your last response was empty and made no tool call. Take ONE concrete action now: call a tool that moves the task forward (read_file, write_file, exec, etc.), or if you are genuinely done, give a final text answer summarizing what you produced." });
          agent.messages.push({ role: "user", content: "Your last response was empty and made no tool call. Take ONE concrete action now: call a tool that moves the task forward, or give a final answer." });
          continue;
        }
        consecutiveEmptyRounds = 0;
        messages.push({ role: "assistant", content: responseText });
        agent.messages.push({ role: "assistant", content: responseText });
        this.mirrorChildMessage(agent, { text: responseText });
        return { status: "completed", reason: "", result: responseText || "Task completed with no output.", toolCallCount: agent.toolCallCount };
      }

      // Echo the assistant turn with normalized tool calls so the transcript
      // stays valid for the next provider request. Repair near-miss arguments
      // (filepath->path, cmd->command, string->number) like the main loop.
      const normalizedCalls = toolCalls.map((call, index) => {
        const tool = String(call.tool || call.function?.name || "").trim();
        const parsed = this.parseToolArguments(call.input ?? call.function?.arguments);
        const repaired = repairToolInput(tool, parsed, toolParamSchemas.get(tool));
        return {
          id: call.id || `subcall_${round}_${index}`,
          tool,
          input: repaired.input,
        };
      });
      const assistantMsg = {
        role: "assistant",
        content: responseText || null,
        tool_calls: normalizedCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.tool, arguments: JSON.stringify(call.input) },
        })),
      };
      messages.push(assistantMsg);
      agent.messages.push(assistantMsg);

      const roundItems = [];
      for (const call of normalizedCalls) {
        throwIfCancelled();
        agent.toolCallCount++;
        const callStarted = Date.now();
        try {
          gateway?.addEvent?.("tool.started", {
            ...childEventBase(),
            tool: call.tool,
            input: call.input,
            reason: `sub-agent round ${round + 1}`,
            step: agent.toolCallCount,
            toolCallId: call.id,
          });
        } catch { /* best effort */ }
        let toolResult;
        const callSignature = `${call.tool}:${JSON.stringify(call.input || {})}`;
        const identicalUses = identicalCallCounts.get(callSignature) || 0;
        if (!call.tool || !availableToolIds.has(call.tool)) {
          toolResult = { error: true, message: `Tool "${call.tool}" is not available to this sub-agent.` };
        } else if (identicalUses >= MAX_IDENTICAL_CALLS) {
          toolResult = {
            blocked: true,
            error: true,
            message: `Repeated identical tool call blocked (already ran ${identicalUses}x with these exact arguments). The result is earlier in this conversation — use it, change the arguments, or finish with what you have.`,
          };
        } else {
          // Pre-validate REQUIRED args BEFORE burning a tool execution: a weak
          // model's empty-args call (write_file {} / exec {}) would otherwise
          // hit the runtime validator and come back as a cryptic block that it
          // repeats next round. Answer immediately with the exact schema so it
          // self-corrects THIS round instead of spinning to the timeout.
          const callSchema = toolParamSchemas.get(call.tool) || {};
          const requiredList = Array.isArray(callSchema.required) ? callSchema.required : [];
          const missing = requiredList.filter((key) => {
            const value = call.input?.[key];
            return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
          });
          const spins = schemaSpinCounts.get(call.tool) || 0;
          if (missing.length > 0) {
            identicalCallCounts.set(callSignature, identicalUses + 1);
            schemaSpinCounts.set(call.tool, spins + 1);
            const props = callSchema.properties && typeof callSchema.properties === "object" ? callSchema.properties : {};
            const argHints = missing.map((key) => {
              const prop = props[key] && typeof props[key] === "object" ? props[key] : {};
              return `${key} (${prop.type || "string"})`;
            }).join(", ");
            toolResult = {
              blocked: true,
              error: true,
              message: `Missing required argument(s): ${argHints}. ${call.tool} was called with empty/incomplete arguments. Do NOT call ${call.tool} again without filling ${missing.join(" and ")}. If you do not have this information yet, gather it first (read_file / list_files), then call ${call.tool} once with complete arguments.`,
            };
            if (spins + 1 >= MAX_SCHEMA_SPINS) {
              const stuckResult = `Sub-agent stuck: ${call.tool} was blocked ${spins + 1}x in a row on missing required argument(s) (${missing.join(", ")}). The model is not supplying valid arguments — likely too weak for this tool surface. Re-delegate with a stronger model (delegate_task {model}) or split the task smaller.`;
              this.mirrorChildMessage(agent, { text: stuckResult });
              return { status: "incomplete", reason: `schema-spin: ${call.tool} missing ${missing.join(",")}`, result: stuckResult, toolCallCount: agent.toolCallCount };
            }
          } else {
            schemaSpinCounts.delete(call.tool);
            identicalCallCounts.set(callSignature, identicalUses + 1);
            toolResult = await this.executeToolCall(call, childCtx);
          }
        }
        // Verdict-first + plain-rendered observation (reads show real numbered
        // code, command failures lead with ❌ + stderr) — same contract as the
        // parent loop, so a weak model inside a sub-agent sees clearly too.
        const content = formatToolResultForModel(toolResult, 10000, call.tool);
        messages.push({ role: "tool", tool_call_id: call.id, content });
        agent.messages.push({ role: "tool", tool_call_id: call.id, content });
        const failed = Boolean(toolResult && (toolResult.error || toolResult.blocked));
        const durationMs = Date.now() - callStarted;
        try {
          gateway?.addEvent?.("tool.output", {
            ...childEventBase(),
            tool: call.tool,
            step: agent.toolCallCount,
            toolCallId: call.id,
            preview: String(content || "").slice(0, 500),
          });
          gateway?.addEvent?.(failed ? "tool.failed" : "tool.completed", {
            ...childEventBase(),
            tool: call.tool,
            step: agent.toolCallCount,
            toolCallId: call.id,
            durationMs,
            blocked: Boolean(toolResult && toolResult.blocked),
            error: failed,
            ok: !failed,
          });
        } catch { /* best effort */ }
        roundItems.push({ tool: call.tool, input: call.input, output: toolResult, summary: String(content || "").split("\n")[0].slice(0, 300) });
      }
      this.mirrorChildMessage(agent, { text: responseText, toolOutputs: roundItems });
      // Visible progress (D4): every 3rd round + round 0 emit a lifecycle
      // event with a tool-activity summary so the user can watch the child.
      if (round === 0 || (round + 1) % 3 === 0) {
        try {
          this.agentRuntime?.gateway?.addEvent?.("subagent.progress", {
            subagentId: agent.id,
            parentAgentId: agent.parentAgentId,
            runId: context.runId || "",
            sessionId: context.sessionId || "",
            childSessionId: childSessionId || "",
            childRunId,
            round: round + 1,
            maxRounds: maxToolRounds,
            stepCount: agent.toolCallCount,
            toolCallCount: agent.toolCallCount,
            lastTools: normalizedCalls.map((c) => c.tool).slice(0, 5),
            message: `sub-agent working: round ${round + 1}/${maxToolRounds}, ${agent.toolCallCount} tools so far (${normalizedCalls.map((c) => c.tool).slice(0, 3).join(", ") || "thinking"})`,
          });
        } catch { /* progress is best-effort */ }
      }
    }

    const lastContent = String(agent.messages[agent.messages.length - 1]?.content || "none").slice(0, 500);
    const incompleteResult = `Reached maximum tool rounds (${maxToolRounds}) without a final answer. Last output: ${lastContent}`;
    this.mirrorChildMessage(agent, { text: incompleteResult });
    return { status: "incomplete", reason: `rounds-exhausted after ${maxToolRounds} rounds with ${agent.toolCallCount} tool calls`, result: incompleteResult, toolCallCount: agent.toolCallCount };
  }

  // Step the child down its ordered ladder after a rung fails (A5).
  // Steps on: rate-limit, invalid/retired model, unreachable endpoint, auth
  // on a non-primary rung. Records what actually ran (acceptance 5) and marks
  // retired ids so no future spawn offers them again (D4). Returns the new
  // active rung, or null when the ladder is exhausted (caller wraps+throws).
  async advanceLadder(agent, context, classified, error) {
    const gateway = this.agentRuntime?.gateway;
    const rootDir = this.agentRuntime?.rootDir;
    const reason = String(classified?.reason || "unknown");
    const steppable = classified?.isRateLimit || classified?.isModelGone
      || reason === "auth" || reason === "timeout" || reason === "overloaded"
      || reason === "server_error" || reason === "billing" || reason === "unknown";
    if (!steppable) return null;
    const raw = String(error?.message || "").slice(0, 200);
    const cur = agent.binding || {};
    // Record the observation against the exact (endpoint, model) that failed.
    if (cur.model && classified?.isModelGone) {
      markModelRetired(rootDir, cur.baseUrl, cur.model, raw || "invalid/retired at call time");
    } else if (cur.model && classified?.isRateLimit) {
      recordModelTest(rootDir, { baseUrl: cur.baseUrl, model: cur.model, ok: false, status: statusFromReason("rate_limit"), error: raw });
    }
    const ladder = Array.isArray(agent.ladder) ? agent.ladder : [];
    for (let i = (agent.ladderIndex || 0) + 1; i < ladder.length; i++) {
      const rung = ladder[i];
      if (!rung || !rung.provider) continue;
      if (rung.model && isModelRetired(rootDir, rung.baseUrl, rung.model)) continue;
      if (rung.model) {
        const check = await this.checkModelOnEndpoint(rung.provider, rung.baseUrl, rung.model);
        if (!check.ok && !check.unlisted) continue;
      }
      agent.ladderIndex = i;
      agent.binding = rung;
      agent.modelOverride = String(rung.model || "");
      try {
        gateway?.addEvent?.("subagent.model_ladder", {
          subagentId: agent.id,
          parentAgentId: agent.parentAgentId,
          runId: context.runId || "",
          sessionId: context.sessionId || "",
          from: describeBinding(cur),
          to: describeBinding(rung),
          reason,
          message: `sub-agent ladder: ${reason} on ${describeBinding(cur)} → retrying on ${describeBinding(rung)}`,
        });
      } catch { /* best effort */ }
      return rung;
    }
    return null;
  }

  // ── First-class child chat (Part B) ────────────────────────────────
  // Every sub-agent gets its own session record + transcript, structured
  // exactly like a main-agent chat (user message + assistant messages with
  // toolOutputs), so the same viewer renders it (open-as-chat, replay,
  // search). Linkage is stored both ways: the child record carries
  // parentSessionId + the task as its first message; the parent transcript
  // gets a subagent.session system event with the child session id.
  // Child tool RESULTS live only in the child transcript — the parent model
  // context still receives just the bounded report (isolation intact, B4).
  openChildSession(agent, context) {
    try {
      const sessions = this.agentRuntime?.sessions;
      if (!sessions || typeof sessions.createSession !== "function") return null;
      const parentSessionId = String(context?.sessionId || "").trim();
      let parent = null;
      if (parentSessionId && typeof sessions.getSession === "function") {
        try {
          parent = sessions.getSession(parentSessionId, { messageLimit: 1 }) || null;
        } catch { parent = null; }
      }
      const agentId = (parent && parent.agentId) || agent.parentAgentId || "main";
      const channel = (parent && parent.channel) || "webchat";
      const workspacePath = (parent && parent.workspacePath) || null;
      const shortId = String(agent.id || "").replace(/^subagent-/, "").slice(-8) || "child";
      const wsTail = (parent && parent.key && parent.key.match(/:ws:[^:]+$/)) ? parent.key.match(/:ws:[^:]+$/)[0] : ":ws:default";
      const label = `sub: ${agent.task.slice(0, 56)}`;
      const session = sessions.createSession({
        key: `agent:${agentId}:${channel}:sub-${shortId}${wsTail}`,
        label,
        agentId,
        channel,
        parentSessionId: parentSessionId || null,
        resetReason: null,
        workspacePath,
        model: (agent.binding && agent.binding.model) || null,
      });
      if (typeof sessions.persistSession === "function") {
        try { sessions.persistSession(session); } catch { /* already stored */ }
      }
      const childRunId = String(agent.childRunId || agent.id || "");
      try {
        sessions.appendMessage(session.id, { role: "user", text: agent.task, runId: childRunId });
      } catch { /* transcript best-effort */ }
      if (parentSessionId && typeof sessions.appendSystemEvent === "function") {
        try {
          sessions.appendSystemEvent(parentSessionId, "subagent.session", {
            subagentId: agent.id,
            childSessionId: session.id,
            childRunId,
            task: agent.task.slice(0, 200),
          });
        } catch { /* linkage best-effort */ }
      }
      return { childSessionId: session.id, childRunId };
    } catch {
      return null;
    }
  }

  // Mirror one child round into the child transcript in main-chat shape
  // (assistant message + toolOutputs). Bounded per output; failures included
  // with their error verdicts so replay shows what actually happened.
  mirrorChildMessage(agent, { text = "", toolOutputs = [] } = {}) {
    try {
      const sessions = this.agentRuntime?.sessions;
      if (!sessions || !agent.childSessionId || typeof sessions.appendMessage !== "function") return;
      const pick = (o = {}) => {
        const out = {};
        for (const k of ["outputSummary", "path", "command", "url", "exitCode", "durationMs", "bytesWritten", "bytesRead", "message"]) {
          if (o[k] !== undefined && o[k] !== null && o[k] !== "") {
            out[k] = typeof o[k] === "string" ? o[k].slice(0, 500) : o[k];
          }
        }
        return out;
      };
      const bounded = (toolOutputs || []).slice(0, 12).map((item) => {
        const raw = item.output && typeof item.output === "object" ? item.output : {};
        const summary = String(item.summary || raw.outputSummary || raw.message || "").slice(0, 500);
        return {
          tool: String(item.tool || "tool"),
          input: item.input && typeof item.input === "object" ? item.input : {},
          output: { ...pick(raw), ...(summary ? { outputSummary: summary } : {}) },
          outputStatus: { error: Boolean(raw.error), blocked: Boolean(raw.blocked) },
        };
      });
      sessions.appendMessage(agent.childSessionId, {
        role: "assistant",
        text: String(text || ""),
        runId: agent.childRunId || agent.id,
        toolOutputs: bounded.length ? bounded : undefined,
      });
    } catch { /* transcript best-effort */ }
  }

  // Trim the OLDEST bulky tool results once the transcript exceeds the char
  // budget, protecting the system prompt, the task, and the newest turns.
  // Deterministic and lossy-last: nothing is touched until the budget is hit.
  boundSubAgentContext(messages, { maxChars = 240000, protectedTail = 8 } = {}) {
    let total = 0;
    for (const m of messages) total += String(m.content || "").length;
    if (total <= maxChars) return 0;
    let stubbed = 0;
    for (let i = 1; i < messages.length - protectedTail && total > maxChars * 0.7; i += 1) {
      const m = messages[i];
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > 600) {
        total -= m.content.length - 200;
        m.content = `${m.content.slice(0, 160)}\n... [older tool result trimmed to keep this sub-agent within its context budget]`;
        stubbed += 1;
      }
    }
    return stubbed;
  }

  parseToolArguments(raw) {
    if (raw && typeof raw === "object") return raw;
    const text = String(raw || "").trim();
    if (!text) return {};
    const attempts = [text, text.replace(/,\s*([}\]])/g, "$1")];
    for (const candidate of attempts) {
      try {
        let value = JSON.parse(candidate);
        // Same double-encoding unwrap as the main loop: a JSON string
        // containing JSON must become the object, not _rawArguments.
        let depth = 0;
        while (typeof value === "string" && depth < 3 && /^[{[]/.test(value.trim())) {
          try {
            value = JSON.parse(value.trim());
            depth++;
          } catch {
            break;
          }
        }
        return value;
      } catch {
        // next attempt
      }
    }
    try {
      const recovered = extractBalancedJsonObject(text);
      if (recovered) return recovered;
    } catch {
      // fall through to _rawArguments
    }
    return { _rawArguments: text.slice(0, 4000) };
  }

  buildToolDefinitions(toolIds) {
    if (!this.toolRegistry) return [];
    const allTools = this.toolRegistry.getAll({});
    const wanted = new Set(toolIds);
    return allTools
      .filter((t) => wanted.has(t.id))
      .map((t) => {
        // Richer schema than a bare passthrough: weak rented models (free
        // router ids) emit EMPTY args ({}) when required params are not shown
        // with a type — exactly how `write_file {}` → "path is required" and
        // `exec {}` → "command is required" blocked runs. Annotate each
        // required param (type + short hint) so the schema itself teaches
        // the model what to send, and add a few canonical examples to the
        // description for the file/shell tools sub-agents use most.
        const baseSchema = t.schema && typeof t.schema === "object" ? t.schema : {};
        const properties = { ...(baseSchema.properties || {}) };
        const REQ_HINTS = {
          path: "target file path (relative to project root or absolute)",
          content: "full file content to write",
          command: "shell command to run",
          query: "search query text",
          url: "full URL",
          edits: "list of {find, replace} edit operations",
        };
        for (const req of baseSchema.required || []) {
          const existing = properties[req];
          if (!existing || typeof existing !== "object") {
            properties[req] = { type: "string", description: REQ_HINTS[req] || `required: ${req}` };
          } else if (!existing.type && !existing.anyOf) {
            properties[req] = { type: "string", ...existing, description: existing.description || REQ_HINTS[req] || `required: ${req}` };
          } else if (!existing.description && REQ_HINTS[req]) {
            properties[req] = { ...existing, description: REQ_HINTS[req] };
          }
        }
        const EXAMPLES = {
          write_file: ' Example call: write_file({"path":"css/style.css","content":"...full css..."}).',
          edit: ' Example call: edit({"path":"index.html","find":"<old>","replace":"<new>"}).',
          exec: ' Example call: exec({"command":"node --check js/main.js"}).',
          read_file: ' Example call: read_file({"path":"index.html"}).',
        };
        let description = String(t.description || "").slice(0, 1024);
        if (EXAMPLES[t.id] && !description.includes("Example call:")) description += EXAMPLES[t.id];
        return {
          type: "function",
          function: {
            name: t.id,
            description,
            parameters: { type: "object", additionalProperties: true, ...baseSchema, properties },
          },
        };
      });
  }

  async executeToolCall(call, context) {
    if (!this.toolRegistry) {
      return { error: "Tool registry not available." };
    }
    try {
      // Rewind safety net: snapshot an existing file BEFORE a sub-agent write,
      // into the SAME per-run checkpoint store the main loop uses — so a
      // sub-agent that clobbers a file can be rolled back with
      // restore_checkpoint (previously sub-agent writes were unprotected).
      if (WRITE_TOOLS.has(call.tool) && call.input?.path) {
        const rootDir = this.agentRuntime?.rootDir || process.cwd();
        const runId = context.runId || context.sessionId || "";
        if (runId) saveFileCheckpoint({ rootDir, runId, filePath: call.input.path, tool: call.tool });
      }
      // Registry run() applies agent permission gating and result sanitizing.
      if (typeof this.toolRegistry.run === "function") {
        return await this.toolRegistry.run(call.tool, call.input, { ...context, source: "sub-agent" });
      }
      const tool = this.toolRegistry.getAll({}).find((t) => t.id === call.tool);
      if (!tool) {
        return { error: `Tool "${call.tool}" not found.` };
      }
      return await tool.run(call.input, context);
    } catch (error) {
      return { error: error.message };
    }
  }

  async cancel(agentId) {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      return { found: false, message: `Sub-agent ${agentId} not found or already completed.` };
    }
    // Cooperative cancel: flag it and let the run loop unwind at its next
    // checkpoint; spawn()'s catch is the single place that finalizes the agent
    // (moves it to completed + emits), so we don't move it here — avoids
    // double-finalize / status clobber.
    agent.cancelRequested = true;
    agent.status = "cancelling";
    this.emit("cancelling", { ...agent });
    return { found: true, message: `Sub-agent ${agentId} cancellation requested.` };
  }

  getHistory(limit = 20) {
    const all = Array.from(this.completedAgents.values());
    return all.slice(-limit).map((a) => ({
      id: a.id,
      parentAgentId: a.parentAgentId,
      task: a.task,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      durationMs: a.durationMs,
      toolCallCount: a.toolCallCount,
    }));
  }
}
