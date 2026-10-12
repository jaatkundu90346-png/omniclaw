import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 4B.1: single source of truth for approval lifetimes (additive fields only).
// APPROVAL_TTL_MS matches the sweepers (server.js internal call + heartbeat
// "approval-expiry" check both use 30 minutes; POST /api/approvals/expire
// defaults to 30). APPROVAL_TOOL_TIMEOUT_MS matches the tool-side waits
// (tool-registry.js awaitShellApproval + ask_user both wait 5 minutes).
// Frontend reads both via record.expiresAt + caps.approvalToolTimeoutMs.
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
export const APPROVAL_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

// A run is "alive" while it holds (or is waiting for) a global slot. Anything
// outside this set is terminal, which is what makes a pending approval on such a
// run stale (M2).
export const ACTIVE_RUN_STATUSES = new Set(["accepted", "queued", "running"]);
export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "archived", "busy", "stopped"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function truncateText(value = "", maxChars = 1200) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

function compactValue(value, options = {}, depth = 0) {
  const maxString = Number(options.maxString || 1000);
  const maxArray = Number(options.maxArray || 20);
  const maxDepth = Number(options.maxDepth || 4);
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateText(value, maxString);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((item) => compactValue(item, options, depth + 1));
    if (value.length > maxArray) {
      items.push({ omittedItems: value.length - maxArray });
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) {
      return truncateText(JSON.stringify(value), maxString);
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(promptTrace|contextBundle|nativeMessages|messages)$/i.test(key)) {
        out[key] = "[omitted-large-runtime-context]";
      } else if (/^(content|text|stdout|stderr|reply|message|answer)$/i.test(key)) {
        out[key] = truncateText(item, maxString);
      } else {
        out[key] = compactValue(item, options, depth + 1);
      }
    }
    return out;
  }
  return truncateText(String(value), maxString);
}

function compactToolOutput(item = {}) {
  const output = item.output || {};
  let compactOutput = compactValue(output, { maxString: 700, maxArray: 5, maxDepth: 3 });
  if (/memory_search|semantic_memory_search/i.test(item.tool || "")) {
    compactOutput = {
      agentId: output.agentId || "",
      query: truncateText(output.query || "", 400),
      scope: output.scope || "",
      mode: output.mode || "",
      count: output.count ?? (Array.isArray(output.results) ? output.results.length : 0),
      results: (output.results || []).slice(0, 5).map((result) => ({
        title: truncateText(result.title || result.id || result.sourceRef || "", 180),
        text: truncateText(result.text || result.content || result.preview || "", 500),
        score: result.score,
        sourceRef: result.sourceRef || "",
      })),
      omittedResults: Math.max(0, (output.results || []).length - 5),
    };
  } else if (/web_research|web_search|read_url|web_fetch/i.test(item.tool || "")) {
    compactOutput = {
      agentId: output.agentId || "",
      query: truncateText(output.query || "", 400),
      url: output.url || "",
      provider: output.provider || "",
      status: output.status || "",
      error: truncateText(output.error || "", 500),
      results: (output.results || output.result?.results || []).slice(0, 5).map((result) => ({
        title: truncateText(result.title || "", 220),
        url: result.url || "",
        snippet: truncateText(result.snippet || result.description || "", 500),
      })),
      content: truncateText(output.content || output.fetchedContent || output.result?.content || "", 1200),
      contentFetched: Boolean(output.contentFetched || output.fetchedContent || output.content),
    };
  } else if (/list_files|list_computer_directory|search_computer_files/i.test(item.tool || "")) {
    const entries = output.entries || output.results || [];
    compactOutput = {
      path: output.path || "",
      query: output.query || "",
      count: entries.length,
      entries: entries.slice(0, 40).map((entry) => ({
        name: entry.name || "",
        path: entry.path || "",
        type: entry.type || "",
      })),
      omittedEntries: Math.max(0, entries.length - 40),
    };
  }
  return {
    tool: item.tool || "",
    input: compactValue(item.input || {}, { maxString: 500, maxArray: 8, maxDepth: 3 }),
    reason: truncateText(item.reason || "", 400),
    source: item.source || "",
    round: item.round,
    output: compactOutput,
    toolSummary: compactValue(item.toolSummary || {}, { maxString: 500, maxArray: 6, maxDepth: 3 }),
  };
}

function compactRun(run = {}) {
  const compactPlan = run.plan
    ? {
        ...run.plan,
        profile: run.plan.profile
          ? {
              id: run.plan.profile.id,
              description: run.plan.profile.description,
              allowToolExecution: run.plan.profile.allowToolExecution,
              enableSkillMatching: run.plan.profile.enableSkillMatching,
            }
          : run.plan.profile,
        toolsAvailable: Array.isArray(run.plan.toolsAvailable)
          ? run.plan.toolsAvailable.map((tool) => ({
              id: tool.id,
              permission: tool.permission || null,
            }))
          : [],
      }
    : run.plan;

  const context = run.context
    ? {
        profileId: run.context.profileId,
        maxChars: run.context.maxChars,
        usedChars: run.context.usedChars,
        utilization: run.context.utilization,
        omittedItems: run.context.omittedItems,
        summary: truncateText(run.context.summary || "", 600),
        contextManifest: compactValue(run.context.contextManifest || {}, { maxString: 700, maxArray: 20, maxDepth: 4 }),
      }
    : undefined;

  const promptTrace = run.promptTrace
    ? {
        version: run.promptTrace.version,
        runId: run.promptTrace.runId,
        sessionId: run.promptTrace.sessionId,
        agentId: run.promptTrace.agentId,
        createdAt: run.promptTrace.createdAt,
        report: compactValue(run.promptTrace.report || {}, { maxString: 700, maxArray: 16, maxDepth: 4 }),
        workspace: compactValue(run.promptTrace.workspace || {}, { maxString: 500, maxArray: 20, maxDepth: 3 }),
        tools: compactValue(run.promptTrace.tools || [], { maxString: 350, maxArray: 40, maxDepth: 3 }),
        skills: compactValue(run.promptTrace.skills || [], { maxString: 500, maxArray: 20, maxDepth: 3 }),
        harness: compactValue(run.promptTrace.harness || {}, { maxString: 600, maxArray: 10, maxDepth: 3 }),
        mcp: compactValue(run.promptTrace.mcp || {}, { maxString: 600, maxArray: 10, maxDepth: 3 }),
      }
    : undefined;

  // Context Organization Layer (additive): per-tier prompt cost + pointer-collapsed
  // sections, so a run record explains what the model was actually given.
  const contextBoard = run.contextBoard
    ? {
        tiers: run.contextBoard.tiers || {},
        totalChars: Number(run.contextBoard.totalChars) || 0,
        collapsed: compactValue(run.contextBoard.collapsed || [], { maxString: 300, maxArray: 12, maxDepth: 3 }),
      }
    : undefined;

  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    startedAt: run.startedAt,
    acceptedAt: run.acceptedAt,
    enqueuedAt: run.enqueuedAt,
    // M2: queuedAt/waitingForRunId/lastActivityAt are written by the global run
    // gate and the activity stamper. They MUST survive compactRun, otherwise a
    // reload silently drops them and /api/agents falls back to guessing.
    queuedAt: run.queuedAt,
    waitingForRunId: run.waitingForRunId,
    lastActivityAt: run.lastActivityAt,
    sessionId: run.sessionId,
    sessionKey: run.sessionKey,
    agentId: run.agentId,
    channel: run.channel,
    label: run.label,
    source: run.source,
    parentRunId: run.parentRunId,
    parentSessionId: run.parentSessionId,
    delegationId: run.delegationId,
    queuePosition: run.queuePosition,
    waitedMs: run.waitedMs,
    blockedByRunId: run.blockedByRunId,
    stopReason: run.stopReason,
    error: truncateText(run.error || "", 1000),
    message: truncateText(run.message || "", 1200),
    reply: truncateText(run.reply || "", 1800),
    plan: compactPlan,
    context,
    contextBoard,
    promptTrace,
    providerDiagnostics: compactValue(run.providerDiagnostics || null, { maxString: 900, maxArray: 8, maxDepth: 4 }),
    finalMetadata: compactValue(run.finalMetadata || null, { maxString: 800, maxArray: 12, maxDepth: 4 }),
    shellExecutions: compactValue((run.shellExecutions || []).slice(-6), { maxString: 700, maxArray: 6, maxDepth: 4 }),
    toolOutputs: Array.isArray(run.toolOutputs) ? run.toolOutputs.slice(-12).map(compactToolOutput) : run.toolOutputs,
  };
}

function compactEvent(event = {}) {
  return {
    ...event,
    payload: compactValue(event.payload || {}, { maxString: 900, maxArray: 20, maxDepth: 4 }),
  };
}

// Hard byte budget for the persisted gateway file.
//
// Why this exists: every event schedules a debounced flush, and a flush
// re-serialises and rewrites the ENTIRE file synchronously. With 120 retained
// runs that had grown to ~4.7MB (plan 1.9MB, promptTrace 1.3MB,
// finalMetadata 0.6MB, toolOutputs 0.6MB), so EVERY tool call paid a multi-MB
// synchronous stringify + write on the single event-loop thread. That is the
// "read_file took 45 seconds" class of stall: the loop is blocked, so every
// tool — not just the browser ones — queues behind it.
//
// The budget bounds the per-flush cost no matter how large any one run is, and
// it is self-healing: the first flush after this ships compacts the existing
// oversized file back down on its own.
const GATEWAY_MAX_BYTES = 1_500_000;   // ~1.5MB: 200 events + ~40 recent runs
const GATEWAY_MIN_RUNS = 25;           // never starve history below this

function enforceSizeBudget(data) {
  if (!data || !Array.isArray(data.runs)) return data;
  // Measure once; a stringify-per-iteration loop would cost as much as the
  // write it is trying to avoid.
  const sizes = data.runs.map((run) => {
    try { return JSON.stringify(run).length; } catch { return 0; }
  });
  let total = sizes.reduce((a, b) => a + b, 0);
  for (const key of ["events", "approvals", "delegations"]) {
    if (Array.isArray(data[key])) {
      try { total += JSON.stringify(data[key]).length; } catch { /* ignore */ }
    }
  }
  // Oldest first: recent runs are what a resume/inspector actually needs.
  while (total > GATEWAY_MAX_BYTES && data.runs.length > GATEWAY_MIN_RUNS) {
    total -= sizes.shift() || 0;
    data.runs.shift();
  }
  return data;
}

function normalizeGatewayData(parsed = {}) {
  const runs = Array.isArray(parsed.runs) ? parsed.runs.slice(-120).map(compactRun) : [];
  return enforceSizeBudget({
    seq: Number(parsed.seq || 0),
    events: Array.isArray(parsed.events) ? parsed.events.slice(-200).map(compactEvent) : [],
    runs,
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals.slice(-200) : [],
    delegations: Array.isArray(parsed.delegations) ? parsed.delegations.slice(-120) : [],
  });
}

export class GatewayStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "gateway.json");
    this.emitter = new EventEmitter();
    this.cache = null;
    // Event writes are debounced: addEvent mutates the cache and schedules a
    // flush instead of rewriting the multi-MB file synchronously per event
    // (a 60-round run emits hundreds of events). Runs/approvals still write
    // through immediately for durability.
    this.flushTimer = null;
    this.flushDelayMs = 250;
    // Q1 (4B.2): open run.question items — IN-MEMORY by design, mirroring the
    // process-local runtime.pendingQuestions map (tool-registry/agent). A
    // restart drops live runs and their questions together, so nothing to
    // persist; GET /api/questions serves this map.
    this.openQuestions = new Map();
    this.ensureFile();
  }

  // Q1: track an open mid-run question. expiresAt defaults to the ask_user
  // tool wait (same budget the frontend countdown uses).
  upsertOpenQuestion({ id, sessionId = "", runId = "", agentId = null, text = "", options = [], createdAt = "", expiresAt = "" } = {}) {
    if (!id) return null;
    const stamp = createdAt || new Date().toISOString();
    const item = {
      id: String(id),
      // WHO is asking. Stamped at creation from the run's agent.
      // null means the caller had neither a run nor a session (e.g.
      // POST /api/tools/run) - the UI renders those as "System", not as an agent.
      agentId: agentId ? String(agentId) : null,
      sessionId: String(sessionId || ""),
      runId: String(runId || ""),
      text: String(text || "").slice(0, 600),
      options: Array.isArray(options) ? options.slice(0, 4) : [],
      createdAt: stamp,
      expiresAt: expiresAt || new Date(Date.now() + APPROVAL_TOOL_TIMEOUT_MS).toISOString(),
    };
    this.openQuestions.set(item.id, item);
    return item;
  }

  removeOpenQuestion(id) {
    return this.openQuestions.delete(String(id || ""));
  }

  // status "pending" (default) drops expired items; "" lists all open.
  listOpenQuestions(status = "pending") {
    const now = Date.now();
    const out = [];
    for (const [id, q] of this.openQuestions) {
      if (status === "pending" && Date.parse(q.expiresAt || 0) <= now) {
        this.openQuestions.delete(id);
        continue;
      }
      out.push({ ...q });
    }
    return out.reverse();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ seq: 0, events: [], runs: [], approvals: [], delegations: [] }, null, 2),
      );
    }
    // Sweep orphaned atomic-write temp files left behind by earlier crashes
    // or EBUSY rename failures.
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const cutoff = Date.now() - 3600000;
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`${base}.`) && entry.endsWith(".tmp")) {
          const stale = fs.statSync(path.join(dir, entry)).mtimeMs < cutoff;
          if (stale) fs.rmSync(path.join(dir, entry), { force: true });
        }
      }
    } catch {
      // Hygiene sweep only; never block startup on it.
    }
  }

  read() {
    // A missing or corrupt gateway.json must NEVER throw: addEvent() is called
    // from dozens of fire-and-forget async paths (boot MCP connect, heartbeat,
    // sub-agents), and an uncaught throw there kills the whole process. Fall
    // back to the in-memory cache (authoritative anyway) or a fresh default —
    // the next write/flush recreates the file.
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      if (this.cache) return this.cache.data;
      const data = normalizeGatewayData({});
      this.cache = { mtimeMs: 0, size: 0, data };
      return data;
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.data;
    }
    let data;
    try {
      data = normalizeGatewayData(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      // Truncated/corrupt file (crash mid-write, disk issue): keep serving the
      // last good state instead of crashing every event producer.
      if (this.cache) return this.cache.data;
      data = normalizeGatewayData({});
    }
    this.cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
    };
    return data;
  }

  scheduleFlush(data) {
    // Keep the in-memory cache authoritative so read() returns the latest
    // state before the disk catches up.
    if (this.cache) {
      this.cache.data = data;
    } else {
      this.cache = { mtimeMs: 0, size: 0, data };
    }
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.write(this.cache?.data || data);
      } catch {
        // Disk flush failures must not crash the runtime; the next write
        // (or flush) retries with current state.
      }
    }, this.flushDelayMs);
    this.flushTimer.unref?.();
  }

  write(data) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    data = normalizeGatewayData(data);
    const nextJson = JSON.stringify(data);
    // The data dir can vanish (cleanup scripts, test teardown) — recreate it
    // instead of throwing from every event/flush path.
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmpPath, nextJson);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.renameSync(tmpPath, this.filePath);
        const stat = fs.statSync(this.filePath);
        this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 7) {
          try {
            fs.writeFileSync(this.filePath, nextJson);
            fs.rmSync(tmpPath, { force: true });
            const stat = fs.statSync(this.filePath);
            this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
            return;
          } catch {
            throw error;
          }
        }
        sleepSync(25 * (attempt + 1));
      }
    }
  }

  onEvent(listener) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  // Notify live listeners (SSE/WS) without persisting to the event log.
  // Used for high-frequency events like assistant token deltas that would
  // otherwise hammer the disk and flush real events out of the 200-entry cap.
  emitTransient(event, payload = {}) {
    const record = {
      seq: 0,
      id: createId("event"),
      event,
      payload,
      at: new Date().toISOString(),
      transient: true,
    };
    this.emitter.emit("event", record);
    return record;
  }

  addEvent(event, payload = {}) {
    const data = this.read();
    // M2: EVERY event that names a run is proof that run is alive. Stamp
    // lastActivityAt on the RUN RECORD itself so /api/agents can compute status
    // from the run instead of replaying a capped, lossy events log
    // (AGENTS_AUDIT risk 3). Cache-only: the debounced flush persists it, and a
    // synchronous write per event would re-introduce the multi-MB stall the
    // debounce exists to prevent.
    const runId = String((payload && payload.runId) || "");
    if (runId) {
      const run = data.runs.find((item) => item.id === runId);
      if (run && ACTIVE_RUN_STATUSES.has(run.status)) {
        run.lastActivityAt = new Date().toISOString();
      }
    }
    const record = {
      seq: data.seq + 1,
      id: createId("event"),
      event,
      payload,
      at: new Date().toISOString(),
    };
    data.seq = record.seq;
    data.events.push(record);
    if (data.events.length > 200) {
      data.events = data.events.slice(-200);
    }
    this.scheduleFlush(data);
    this.emitter.emit("event", record);
    if (this.agentRef && this.agentRef.eventBus) {
      try { this.agentRef.eventBus.emit(event, record); } catch {}
    }
    return record;
  }

  listEvents(limit = 50) {
    return this.read().events.slice(-limit).reverse();
  }

  createRun(input) {
    const data = this.read();
    const run = {
      id: createId("run"),
      status: "accepted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    };
    data.runs.push(run);
    this.write(data);
    return run;
  }

  updateRun(runId, updates) {
    const data = this.read();
    const index = data.runs.findIndex((run) => run.id === runId);
    if (index === -1) {
      throw new Error(`Run not found: ${runId}`);
    }

    data.runs[index] = {
      ...data.runs[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.runs[index];
  }

  listRuns(limit = 50) {
    return this.read().runs.slice(-limit).reverse();
  }

  getRun(runId) {
    return this.read().runs.find((run) => run.id === runId) || null;
  }

  getApproval(approvalId) {
    return this.read().approvals.find((approval) => approval.id === approvalId) || null;
  }

  updateApproval(approvalId, updates) {
    const data = this.read();
    const index = data.approvals.findIndex((approval) => approval.id === approvalId);
    if (index === -1) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    data.approvals[index] = {
      ...data.approvals[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.approvals[index];
  }

  createApproval(input) {
    const data = this.read();
    const now = new Date();
    const approval = {
      id: createId("approval"),
      status: "pending",
      // Which agent is asking. Stamped from the caller at creation
      // time, because a run/session can be reaped long before the 30-minute TTL
      // expires - after that, the only way to still say WHO asked is this field.
      // null = no run and no session (POST /api/tools/run) -> shown as "System".
      agentId: input.agentId ? String(input.agentId) : null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      // 4B.1 additive: deterministic countdown deadline (sweeper uses the
      // same TTL, so pending + this field is all the UI needs).
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      ...input,
    };
    // A caller-provided expiresAt wins (spread above); otherwise the TTL stamp
    // stands. Never persist a non-string.
    if (typeof approval.expiresAt !== "string" || !approval.expiresAt) {
      approval.expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
    }
    data.approvals.push(approval);
    this.write(data);
    // 4B.1: enriched event so a global banner/card can render WITHOUT a
    // follow-up GET (summary/command/tool/sessionId/runId/expiresAt).
    // Reaches POST /api/chat/stream (interesting filter) AND GET /api/events
    // (server.js: agent.gateway.onEvent(broadcastEvent) — unfiltered fan-out).
    const cmd = approval.payload && (approval.payload.command || approval.payload.path)
      ? String(approval.payload.command || approval.payload.path).slice(0, 500)
      : "";
    this.addEvent("approval.requested", {
      approvalId: approval.id,
      type: approval.type,
      tool: approval.tool || "",
      // M3: the event carries the asker too, otherwise a card rendered from the
      // live event (not from the GET hydration) would have no attribution.
      agentId: approval.agentId || null,
      summary: approval.summary || "",
      command: cmd,
      sessionId: approval.sessionId,
      runId: approval.runId,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    });
    return approval;
  }

  resolveApproval(approvalId, decision, note = "") {
    const data = this.read();
    const index = data.approvals.findIndex((approval) => approval.id === approvalId);
    if (index === -1) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    data.approvals[index] = {
      ...data.approvals[index],
      status: decision,
      note,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    // 4B.1 additive: sessionId/runId on the resolved event so the global
    // store can clear per-session state without a refetch.
    const prev = data.approvals[index] || {};
    this.addEvent("approval.resolved", {
      approvalId,
      decision,
      sessionId: prev.sessionId || "",
      runId: prev.runId || "",
    });
    return data.approvals[index];
  }

  // status: "" = all, "pending" = only open.
// agentId: `?agentId=` filter. "" = no filter, "system" = only records with
  // no agent attribution (the POST /api/tools/run ones).
  listApprovals(status = "", agentId = "") {
    const approvals = this.read().approvals;
    const wantedAgent = String(agentId || "").trim();
    return approvals
      .filter((item) => (status ? item.status === status : true))
      .filter((item) => {
        if (!wantedAgent) return true;
        const owner = item.agentId ? String(item.agentId) : "system";
        return owner === wantedAgent;
      })
      .slice(-50)
      .reverse();
  }

  createDelegation(input) {
    const data = this.read();
    const now = new Date().toISOString();
    const delegation = {
      id: createId("delegation"),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      ...input,
    };
    data.delegations.push(delegation);
    this.write(data);
    return delegation;
  }

  updateDelegation(delegationId, updates) {
    const data = this.read();
    const index = data.delegations.findIndex((delegation) => delegation.id === delegationId);
    if (index === -1) {
      throw new Error(`Delegation not found: ${delegationId}`);
    }

    data.delegations[index] = {
      ...data.delegations[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.delegations[index];
  }

  getDelegation(delegationId) {
    return this.read().delegations.find((delegation) => delegation.id === delegationId) || null;
  }

  listDelegations({ limit = 50, status = "", agentId = "" } = {}) {
    const normalizedStatus = String(status || "").trim();
    const normalizedAgentId = String(agentId || "").trim();
    return this.read()
      .delegations.filter((delegation) => {
        if (normalizedStatus && delegation.status !== normalizedStatus) {
          return false;
        }
        if (
          normalizedAgentId &&
          delegation.sourceAgentId !== normalizedAgentId &&
          delegation.targetAgentId !== normalizedAgentId
        ) {
          return false;
        }
        return true;
      })
      .slice(-Number(limit || 50))
      .reverse();
  }

  getOverview() {
    const data = this.read();
    const now = Date.now();
    const activeDelegationCutoffMs = 3_600_000;
    return {
      eventCount: data.events.length,
      runCount: data.runs.length,
      queuedRuns: data.runs.filter((run) => run.status === "queued").length,
      runningRuns: data.runs.filter((run) => run.status === "running").length,
      pendingApprovals: data.approvals.filter((item) => item.status === "pending").length,
      delegationCount: data.delegations.length,
      activeDelegations: data.delegations.filter((item) => {
        if (!["queued", "running"].includes(item.status)) return false;
        const at = new Date(item.updatedAt || item.createdAt || 0).getTime();
        return Number.isFinite(at) && now - at <= activeDelegationCutoffMs;
      }).length,
      failedDelegations: data.delegations.filter((item) => item.status === "failed").length,
      lastEvent: data.events[data.events.length - 1] || null,
    };
  }

  // ─── Approval Timeout ─────────────────────────────────────────
  // M2: an approval is only meaningful while its run can still act on it. Two
  // things expire a pending approval:
  //   1. age > timeoutMinutes (the original rule), and
  //   2. its run is already terminal or gone from the log entirely.
  // (2) is why a row could sit amber forever: the run finished or was dropped
  // by the gateway size budget, but the approval row stayed pending, and
  // computeAgentRuntime matched it. A stale approval must never paint an agent.
  // Approvals with NO runId are left alone — those come from /api/tools/run
  // outside any run and have no run to be stale against.
  expireOldApprovals(timeoutMinutes = 30) {
    const data = this.read();
    const now = Date.now();
    const runsById = new Map(data.runs.map((run) => [String(run.id), run]));
    let expired = 0;
    let orphaned = 0;
    for (const approval of data.approvals) {
      if (approval.status !== "pending") continue;
      const age = (now - Date.parse(approval.createdAt || approval.updatedAt || 0)) / 60_000;
      const run = approval.runId ? runsById.get(String(approval.runId)) : null;
      const deadRun = Boolean(approval.runId) && (!run || TERMINAL_RUN_STATUSES.has(run.status));
      if (age > timeoutMinutes || deadRun) {
        approval.status = "expired";
        approval.expiredAt = new Date().toISOString();
        approval.updatedAt = new Date().toISOString();
        approval.expiryReason = deadRun
          ? "Auto-expired: the run that requested this approval is no longer active."
          : `Auto-expired after ${timeoutMinutes} minutes`;
        if (deadRun) orphaned++;
        expired++;
      }
    }
    if (expired > 0) {
      this.write(data);
      this.addEvent("approval.expired_batch", { count: expired, timeoutMinutes, orphaned });
    }
    return {
      expired,
      orphaned,
      checked: data.approvals.filter(a => a.status === "pending" || a.status === "expired").length,
    };
  }

  // M2: which pending approvals are still real? Used by /api/agents so a stale
  // row can never show an agent as waiting-approval, even between sweeps. Does NOT
  // mutate — expireOldApprovals owns the state change.
  listLivePendingApprovals() {
    const data = this.read();
    const runsById = new Map(data.runs.map((run) => [String(run.id), run]));
    return data.approvals.filter((approval) => {
      if (approval.status !== "pending") return false;
      if (!approval.runId) return true;
      const run = runsById.get(String(approval.runId));
      return Boolean(run) && ACTIVE_RUN_STATUSES.has(run.status);
    });
  }
}
