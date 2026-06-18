function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function truncate(value, maxChars = 4000) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

export function getAgentLoopSettings(config = {}) {
  const loop = config.runtime?.agentLoop || {};
  const modelLoop = config.runtime?.modelToolLoop || {};
  return {
    maxSteps: clampNumber(loop.maxSteps ?? modelLoop.maxSteps, 1, 5000, 50),
    maxToolCallsPerStep: clampNumber(loop.maxToolCallsPerStep ?? modelLoop.maxToolCallsPerRound, 1, 20, 5),
    maxRepeatedToolCalls: clampNumber(loop.maxRepeatedToolCalls ?? modelLoop.maxRepeatedToolCalls, 1, 10, 2),
    outputPreviewChars: clampNumber(loop.outputPreviewChars, 500, 12000, 4000),
  };
}

export class AgentLoopController {
  constructor({ config = {}, gateway = null, run = {}, session = {}, agent = {}, source = "agent-loop" } = {}) {
    this.settings = getAgentLoopSettings(config);
    this.gateway = gateway;
    this.run = run || {};
    this.session = session || {};
    this.agent = agent || {};
    this.source = source;
    this.steps = 0;
    this.toolCallCount = 0;
    this.repeatedToolCallsSkipped = 0;
    this.callCounts = new Map();
    this.remainingIssues = [];
    this.stopReason = "";
  }

  event(name, payload = {}) {
    this.gateway?.addEvent?.(name, {
      runId: this.run.id,
      sessionId: this.session.id,
      agentId: this.agent.id,
      source: this.source,
      ...payload,
    });
  }

  startStep({ phase = "think", message = "", step = null } = {}) {
    if (this.steps >= this.settings.maxSteps) {
      this.stopReason = "max_steps";
      this.remainingIssues.push(`Agent loop reached maxSteps=${this.settings.maxSteps}.`);
      this.event("agent.reviewing", {
        phase: "step-budget",
        stopReason: this.stopReason,
        remainingIssues: this.remainingIssues,
      });
      return false;
    }
    this.steps += 1;
    this.event("agent.thinking", {
      phase,
      step: step || this.steps,
      maxSteps: this.settings.maxSteps,
      message: message || "Agent loop is deciding the next action.",
    });
    return true;
  }

  canRunTool(call = {}) {
    if (this.toolCallCount >= this.settings.maxSteps * this.settings.maxToolCallsPerStep) {
      this.stopReason = "tool_budget_exhausted";
      this.remainingIssues.push("Tool budget exhausted before task completion.");
      return false;
    }
    const key = `${call.tool || ""}:${JSON.stringify(call.input || {})}`;
    const seen = this.callCounts.get(key) || 0;
    if (seen >= this.settings.maxRepeatedToolCalls) {
      this.repeatedToolCallsSkipped += 1;
      this.event("tool.failed", {
        tool: call.tool || "",
        reason: "repeat-call-budget-exceeded",
        step: this.steps,
      });
      return false;
    }
    this.callCounts.set(key, seen + 1);
    return true;
  }

  toolStarted(call = {}) {
    this.toolCallCount += 1;
    this.event("tool.started", {
      tool: call.tool || "",
      input: call.input || {},
      reason: call.reason || "",
      step: this.steps,
    });
  }

  toolOutput(call = {}, output = {}) {
    const preview = truncate(output, this.settings.outputPreviewChars);
    this.event("tool.output", {
      tool: call.tool || "",
      step: this.steps,
      preview,
      outputSummary: truncate(output, 700),
      resultPreview: truncate(output, 700),
      bytes: Buffer.byteLength(preview, "utf8"),
    });
  }

  toolCompleted(call = {}, output = {}) {
    const failed = Boolean(
      output?.error ||
      output?.blocked ||
      output?.ok === false ||
      (Array.isArray(output?.issues) && output.issues.length > 0),
    );
    this.event(failed ? "tool.failed" : "tool.completed", {
      tool: call.tool || "",
      step: this.steps,
      blocked: Boolean(output?.blocked),
      error: Boolean(output?.error),
      ok: !failed,
    });
    if (failed) {
      this.remainingIssues.push(`${call.tool || "tool"} failed or needs attention.`);
    }
  }

  reviewing({ reason = "", remainingIssues = [] } = {}) {
    if (remainingIssues.length > 0) {
      this.remainingIssues.push(...remainingIssues);
    }
    this.event("agent.reviewing", {
      reason,
      remainingIssues: [...new Set(this.remainingIssues)].slice(0, 12),
    });
  }

  done({ stopReason = "", finalMetadata = {} } = {}) {
    this.stopReason = stopReason || this.stopReason || "final";
    this.event("agent.done", {
      stopReason: this.stopReason,
      steps: this.steps,
      toolCallCount: this.toolCallCount,
      remainingIssues: [...new Set(this.remainingIssues)].slice(0, 12),
      finalMetadata,
    });
  }

  getReport() {
    return {
      controller: "AgentLoopController",
      maxSteps: this.settings.maxSteps,
      maxToolCallsPerStep: this.settings.maxToolCallsPerStep,
      steps: this.steps,
      toolCallCount: this.toolCallCount,
      repeatedToolCallsSkipped: this.repeatedToolCallsSkipped,
      stopReason: this.stopReason,
      remainingIssues: [...new Set(this.remainingIssues)].slice(0, 12),
    };
  }
}
