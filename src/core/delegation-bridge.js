// Agent-to-agent delegation bridge.
//
// WHY A SEPARATE MODULE: agent.js already carries the run path, the gate and
// the session queue. Delegation rules (limits, dedupe, depth, report-back) are
// policy, not plumbing, and they need to be testable without booting a run.
//
// THE HARD RULE: this is ASYNC. create() starts the target run and RETURNS. It
// never awaits the child. With runtime.maxConcurrentRuns = 1 the child sits in
// `queued` until the SOURCE run finishes and releases the gate, so any await
// here is a guaranteed deadlock. The source run must complete normally.
//
// Every limit fails CLOSED with a message the model can act on - a refused
// delegation must say WHY, not return an empty object.

import { normalizeAgentId } from "./agent-registry.js";

export const MAX_DELEGATION_DEPTH = 3;
export const MAX_OPEN_PER_SOURCE = 3;
export const MAX_PROMPT_CHARS = 8000;
export const DEDUPE_WINDOW_MS = 60_000;
export const DELEGATION_STALL_MS = 60_000;
// `main` is the ONE shipped OmniClaw coding agent - research/builder/ops were
// removed - so `main` is both the default target and the only target.
export const DEFAULT_TARGET_AGENT = "main"; // the one shipped OmniClaw coding agent
const OPEN_STATUSES = new Set(["queued", "running"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isDelegationError = true;
  return error;
}

function trimSummary(text, max = 1500) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export class DelegationBridge {
  constructor(agentRuntime) {
    this.agent = agentRuntime;
    this.gateway = agentRuntime.gateway;
    // Bound ONCE: the listener outlives individual create() calls, which is the
    // whole point - status keeps mirroring after the source run has exited.
    this.gateway.onEvent((record) => {
      try { this.mirrorFromEvent(record); } catch { /* never break the bus */ }
    });
  }

  /**
   * Validate + create. Returns the delegation record. Starts the target run
   * without awaiting it (see THE HARD RULE above).
   */
  create(input = {}) {
    const runtime = this.agent;
    const prompt = String(input.prompt || input.instruction || "").trim();
    const title = trimSummary(input.title || prompt, 120);
    if (!prompt) throw fail("EINVAL", "prompt is required.");
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw fail("ELIMIT", `prompt is too long (${prompt.length} chars, max ${MAX_PROMPT_CHARS}).`);
    }

    const sourceAgentId = normalizeAgentId(input.sourceAgentId || "main");
    const targetAgentId = normalizeAgentId(input.targetAgentId || DEFAULT_TARGET_AGENT);

    // --- limits, in the order a model can act on them ---------------------
    if (targetAgentId === sourceAgentId) {
      throw fail("EINVAL", "An agent cannot delegate to itself.");
    }
    const depth = Math.max(0, Number(input.depth) || 0);
    if (depth >= MAX_DELEGATION_DEPTH) {
      throw fail("ELIMIT", `Delegation depth limit reached (max ${MAX_DELEGATION_DEPTH}). Do the work here instead.`);
    }

    // Explicit existence check. resolveAgent() silently falls back to the
    // default agent, which would turn "delegate to an archived agent" into
    // "delegate to main" - exactly the silent fallback M1's cloud rule forbids.
    const known = new Set((runtime.agents?.getAll?.() || []).map((a) => a.id));
    if (!known.has(targetAgentId)) {
      // Say what the target actually IS: the default target is the Coder agent.
      throw fail("ENOENT", `Unknown or archived delegation target: ${targetAgentId}. Call agents_list to see valid targets.`);
    }

    const existing = runtime.gateway.listDelegations({ limit: 200 });
    const open = existing.filter(
      (d) => d.sourceAgentId === sourceAgentId && OPEN_STATUSES.has(d.status),
    );
    if (open.length >= MAX_OPEN_PER_SOURCE) {
      throw fail("ELIMIT", `${sourceAgentId} already has ${open.length} open tasks (max ${MAX_OPEN_PER_SOURCE}). Wait for one to finish.`);
    }

    // Dedupe: the same source asking the same target for the same thing inside a
    // minute is a retry, not new work. Without this a confused loop burns the
    // run gate on identical tasks. An EXPLICIT retry (the Retry button) opts
    // out - the user already said yes to running it again.
    const now = Date.now();
    const twin = input.dedupe === false ? null : existing.find((d) => (
      d.sourceAgentId === sourceAgentId
      && d.targetAgentId === targetAgentId
      && String(d.prompt || d.instruction || "").trim() === prompt
      && now - Date.parse(d.createdAt || 0) < DEDUPE_WINDOW_MS
    ));
    if (twin) {
      runtime.gateway.addEvent("delegation.deduplicated", {
        delegationId: twin.id, sourceAgentId, targetAgentId, reason: "identical-prompt-within-window",
      });
      return { ...twin, deduplicated: true };
    }

// --- record BEFORE the run, so the card can appear instantly -----------
    const sourceAgent = runtime.agents.resolveAgent(sourceAgentId);
    const delegation = runtime.gateway.createDelegation({
      // `instruction` is kept in sync for the legacy readers (ws-gateway and the
      // UI) so the older field names keep working alongside `prompt`.
      title,
      prompt,
      instruction: prompt,
      sourceAgentId,
      sourceSessionId: String(input.parentSessionId || input.sessionId || ""),
      targetAgentId,
      targetSessionId: "",
      targetRunId: "",
      depth,
      parentDelegationId: String(input.parentDelegationId || ""),
      status: "queued",
      resultSummary: "",
      filesChanged: [],
      lastActivityAt: new Date().toISOString(),
      finishedAt: "",
      source: input.source || "agent",
      // pre-M3 field names, kept in sync
      parentRunId: String(input.parentRunId || ""),
      parentSessionId: String(input.parentSessionId || input.sessionId || ""),
    });

    runtime.gateway.addEvent("delegation.created", {
      delegationId: delegation.id,
      runId: input.parentRunId || "",
      sessionId: input.parentSessionId || "",
      sourceAgentId,
      targetAgentId,
      title,
      depth,
    });

    if (delegation.sourceSessionId) {
      try {
        runtime.sessions.appendSystemEvent(delegation.sourceSessionId, "delegation.created", {
          delegationId: delegation.id,
          targetAgentId,
          targetLabel: runtime.agents.resolveAgent(targetAgentId).label,
          title,
        });
      } catch { /* the source session may be gone; never fail the delegation */ }
    }

    // --- target session ----------------------------------------------------
    // A NEW session, parented to the source, so the delegated work gets its own
    // transcript, its own memory and its own row in the sidebar.
    const targetSession = runtime.sessions.resolveSession({
      agentId: targetAgentId,
      label: `from ${sourceAgent.label || sourceAgent.name}: ${title}`.slice(0, 120),
      channel: "internal",
      parentSessionId: delegation.sourceSessionId || null,
      workspacePath: runtime.workspaces.getActivePath(),
      model: runtime.config.getConfig()?.provider?.model || "",
    });
    runtime.gateway.updateDelegation(delegation.id, {
      targetSessionId: targetSession.id,
      childSessionId: targetSession.id, // pre-M3 alias
    });
    try {
      runtime.sessions.appendSystemEvent(targetSession.id, "delegation.assigned", {
        delegationId: delegation.id,
        sourceAgentId,
        sourceSessionId: delegation.sourceSessionId,
        title,
      });
    } catch { /* best effort */ }
// --- start the run. NOT awaited - THE HARD RULE. ------------------------
    let childPromise;
    try {
      childPromise = runtime.handleMessage(prompt, {
        sessionId: targetSession.id,
        label: targetSession.label,
        agentId: targetAgentId,
        channel: "internal",
        source: "delegation",
        parentRunId: String(input.parentRunId || ""),
        parentSessionId: delegation.sourceSessionId,
        delegationId: delegation.id,
        delegationDepth: depth + 1,
      });
    } catch (error) {
      runtime.gateway.updateDelegation(delegation.id, {
        status: "failed",
        error: String(error.message || error),
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }

    // The run record lands a moment after handleMessage resolves; find it so the
    // card can mirror status/step. Not required - the event listener fills it in.
    const childRun = runtime.gateway.listRuns(20)
      .find((r) => r.delegationId === delegation.id && r.sessionId === targetSession.id);
    runtime.gateway.updateDelegation(delegation.id, {
      targetRunId: childRun?.id || "",
      childRunId: childRun?.id || "", // pre-M3 alias
      // Honest status. With the global gate busy the child has NOT started, so
      // the card must say "queued" - guessing "running" would show a spinner on
      // a task that has not moved. The event listener promotes it to "running"
      // the moment the run actually goes live.
      status: childRun && childRun.status !== "queued" ? "running" : "queued",
      startedAt: new Date().toISOString(),
    });

    // Completion is a side effect of the run, never a step in ours.
    Promise.resolve(childPromise)
      .then((result) => this.finish(delegation.id, { ok: true, result }))
      .catch((error) => this.finish(delegation.id, { ok: false, error }));

    return this.gateway.getDelegation(delegation.id) || delegation;
  }

  // ── status mirroring ───────────────────────────────────────────────────
  // The run is the source of truth; the delegation card is a view of it.
  mirrorFromEvent(record) {
    const payload = (record && record.payload) || {};
    const runId = String(payload.runId || "");
    const sessionId = String(payload.sessionId || "");
    if (!runId && !sessionId) return;
    const event = String((record && record.event) || "");
    if (!/^(agent\.|run\.|tool\.|omni_loop\.|model_tool_loop\.|provider\.)/.test(event)) return;

    const delegation = this.gateway.listDelegations({ limit: 60 }).find((d) => (
      OPEN_STATUSES.has(d.status)
      && ((d.targetRunId && runId && String(d.targetRunId) === runId)
        || (d.targetSessionId && sessionId && String(d.targetSessionId) === sessionId))
    ));
    if (!delegation) return;

    const run = runId ? this.gateway.getRun(runId) : null;
    const patch = { lastActivityAt: new Date().toISOString() };
    if (run) {
      if (run.status === "queued") patch.status = "queued";
      else if (run.status === "running" || run.status === "accepted") patch.status = "running";
    }
    if (event === "model_tool_loop.round_started") {
      // "step x of y" - the same payload the M1/M2 status chips read.
      patch.step = { round: Number(payload.round) || 0, maxRounds: Number(payload.maxRounds) || 0 };
    }
    this.gateway.updateDelegation(delegation.id, patch);
  }

  /** A running delegation silent for a minute is reported as stalled. */
  sweepStalled() {
    const now = Date.now();
    let changed = 0;
    for (const d of this.gateway.listDelegations({ limit: 100 })) {
      if (d.status !== "running") continue;
      if (now - Date.parse(d.lastActivityAt || d.updatedAt || 0) > DELEGATION_STALL_MS) {
        this.gateway.updateDelegation(d.id, { status: "stalled" });
        changed += 1;
      }
    }
    return changed;
  }
// ── completion + report back ───────────────────────────────────────────
  finish(delegationId, { ok, result, error }) {
    const delegation = this.gateway.getDelegation(delegationId);
    if (!delegation) return null;
    if (delegation.status === "cancelled") return delegation; // a cancel won

    const run = delegation.targetRunId ? this.gateway.getRun(delegation.targetRunId) : null;
    const reply = ok ? String(result?.reply || "") : "";
    const summary = trimSummary(reply || (error && error.message) || "");
    const files = collectChangedFiles(run);
    const finishedAt = new Date().toISOString();

    const updated = this.gateway.updateDelegation(delegationId, {
      // "done", not "completed": the M3 card vocabulary is
      // queued|running|done|failed|cancelled|stalled.
      status: ok ? "done" : "failed",
      resultSummary: summary,
      filesChanged: files,
      error: error ? String(error.message || error) : "",
      finishedAt,
      lastActivityAt: finishedAt,
    });
    this.gateway.addEvent(ok ? "delegation.done" : "delegation.failed", {
      delegationId,
      sourceAgentId: delegation.sourceAgentId,
      targetAgentId: delegation.targetAgentId,
      targetSessionId: delegation.targetSessionId,
      title: delegation.title,
      resultSummary: summary,
      filesChanged: files,
    });

    // Report back into the SOURCE session. We do NOT start a new run of the
    // source agent: that would be a second unsolicited run, and it would fight
    // the global gate. The message just lands in the transcript being read.
    if (delegation.sourceSessionId) {
      const targetLabel = this.agent.agents.resolveAgent(delegation.targetAgentId).label;
      const line = [
        `${targetLabel} ${ok ? "finished" : "failed on"} ${delegation.title}:`,
        summary || "(no summary)",
        files.length ? `Files changed: ${files.slice(0, 8).join(", ")}` : "Files changed: none reported",
      ].join(" ");
      try {
        this.agent.sessions.appendSystemEvent(delegation.sourceSessionId, "delegation.reported", {
          delegationId, targetAgentId: delegation.targetAgentId, ok, title: delegation.title,
        });
        this.agent.sessions.appendMessage(delegation.sourceSessionId, { role: "assistant", text: line });
      } catch { /* source session gone; the card still carries the result */ }
    }
    return updated;
  }

  // ── cancel / retry ────────────────────────────────────────────────────
  cancel(delegationId) {
    const delegation = this.gateway.getDelegation(delegationId);
    if (!delegation) throw fail("ENOENT", `Delegation not found: ${delegationId}`);
    if (!OPEN_STATUSES.has(delegation.status)) return this.gateway.getDelegation(delegationId);
    // Cancel the TARGET RUN too, or the target keeps working on a task the user
    // already called off - and keeps holding the global run slot.
    let runCancelled = false;
    if (delegation.targetRunId) {
      const run = this.gateway.getRun(delegation.targetRunId);
      if (run && ["accepted", "queued", "running"].includes(run.status)) {
        runCancelled = Boolean(this.agent.cancelRun?.(delegation.targetRunId));
      }
    }
    const updated = this.gateway.updateDelegation(delegationId, {
      status: "cancelled",
      finishedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      runCancelled,
    });
    this.gateway.addEvent("delegation.cancelled", {
      delegationId, targetAgentId: delegation.targetAgentId, runCancelled,
    });
    return updated;
  }

  retry(delegationId) {
    const delegation = this.gateway.getDelegation(delegationId);
    if (!delegation) throw fail("ENOENT", `Delegation not found: ${delegationId}`);
    return this.create({
      sourceAgentId: delegation.sourceAgentId,
      targetAgentId: delegation.targetAgentId,
      title: delegation.title,
      prompt: delegation.prompt || delegation.instruction,
      parentSessionId: delegation.sourceSessionId,
      depth: Number(delegation.depth) || 0,
      parentDelegationId: delegation.id,
      source: "retry",
      dedupe: false, // an explicit retry must not be swallowed by the dedupe window
    });
  }
}

// Files the run actually touched, from its tool outputs. Best effort: a run
// with no recorded tool outputs reports none rather than guessing.
function collectChangedFiles(run) {
  const out = new Set();
  for (const item of (run && run.toolOutputs) || []) {
    const output = (item && item.output) || {};
    const filePath = String(output.path || output.file || (item.input && item.input.path) || "");
    if (filePath && /\.(js|mjs|css|json|md|html|ts|py)$/i.test(filePath)) out.add(filePath);
  }
  return [...out].slice(0, 30);
}