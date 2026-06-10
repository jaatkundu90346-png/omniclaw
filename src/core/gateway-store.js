import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

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

  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    startedAt: run.startedAt,
    acceptedAt: run.acceptedAt,
    enqueuedAt: run.enqueuedAt,
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

function normalizeGatewayData(parsed = {}) {
  const runs = Array.isArray(parsed.runs) ? parsed.runs.slice(-120).map(compactRun) : [];
  return {
    seq: Number(parsed.seq || 0),
    events: Array.isArray(parsed.events) ? parsed.events.slice(-200).map(compactEvent) : [],
    runs,
    approvals: Array.isArray(parsed.approvals) ? parsed.approvals.slice(-200) : [],
    delegations: Array.isArray(parsed.delegations) ? parsed.delegations.slice(-120) : [],
  };
}

export class GatewayStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "gateway.json");
    this.emitter = new EventEmitter();
    this.cache = null;
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ seq: 0, events: [], runs: [], approvals: [], delegations: [] }, null, 2),
      );
    }
  }

  read() {
    const stat = fs.statSync(this.filePath);
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return this.cache.data;
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const data = normalizeGatewayData(parsed);
    this.cache = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      data,
    };
    return data;
  }

  write(data) {
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    data = normalizeGatewayData(data);
    const nextJson = JSON.stringify(data, null, 2);
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

  addEvent(event, payload = {}) {
    const data = this.read();
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
    this.write(data);
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
    const approval = {
      id: createId("approval"),
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    };
    data.approvals.push(approval);
    this.write(data);
    this.addEvent("approval.requested", {
      approvalId: approval.id,
      type: approval.type,
      sessionId: approval.sessionId,
      runId: approval.runId,
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
    this.addEvent("approval.resolved", {
      approvalId,
      decision,
    });
    return data.approvals[index];
  }

  listApprovals(status = "") {
    const approvals = this.read().approvals;
    return (status ? approvals.filter((item) => item.status === status) : approvals)
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
  expireOldApprovals(timeoutMinutes = 30) {
    const data = this.read();
    const now = Date.now();
    let expired = 0;
    for (const approval of data.approvals) {
      if (approval.status !== "pending") continue;
      const age = (now - Date.parse(approval.createdAt || approval.updatedAt || 0)) / 60_000;
      if (age > timeoutMinutes) {
        approval.status = "expired";
        approval.expiredAt = new Date().toISOString();
        approval.updatedAt = new Date().toISOString();
        approval.expiryReason = `Auto-expired after ${timeoutMinutes} minutes`;
        expired++;
      }
    }
    if (expired > 0) {
      this.write(data);
      this.addEvent("approval.expired_batch", { count: expired, timeoutMinutes });
    }
    return { expired, checked: data.approvals.filter(a => a.status === "pending" || a.status === "expired").length };
  }
}
