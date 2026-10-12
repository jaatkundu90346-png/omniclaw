// ─── Heartbeat System ──────────────────────────────────────────
// Periodic checks that the agent can perform autonomously
// Similar to OpenClaw's heartbeat polling

function parseDurationMs(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1000, value);
  }
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) {
    return fallbackMs;
  }
  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.max(1000, Math.round(amount * multipliers[unit]));
}

function parseHeartbeatTasks(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const tasks = [];
  let current = null;
  for (const line of lines) {
    const taskMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/i);
    if (taskMatch) {
      current = {
        name: taskMatch[1].trim(),
        interval: "30m",
        prompt: "",
      };
      tasks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const intervalMatch = line.match(/^\s*interval:\s*(.+?)\s*$/i);
    if (intervalMatch) {
      current.interval = intervalMatch[1].trim();
      continue;
    }
    const promptMatch = line.match(/^\s*prompt:\s*["']?(.+?)["']?\s*$/i);
    if (promptMatch) {
      current.prompt = promptMatch[1].trim();
    }
  }
  // Freeform HEARTBEAT.md (OpenClaw/Hermes style — no "- name:" entries):
  // the whole file is ONE implicit task run at the heartbeat interval.
  if (tasks.length === 0 && String(markdown || "").trim()) {
    tasks.push({
      name: "heartbeat",
      interval: "",
      prompt: String(markdown).trim(),
      implicit: true,
    });
  }
  return tasks;
}

// A heartbeat run that has nothing to report replies HEARTBEAT_OK (the
// OpenClaw convention) — such results stay quiet instead of being delivered.
function isHeartbeatOkReply(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;
  return /^\s*HEARTBEAT_OK\b/i.test(t) || (t.length <= 240 && /\bHEARTBEAT_OK\b/.test(t));
}

function isWithinActiveHours(activeHours = null, now = new Date()) {
  if (!activeHours || typeof activeHours !== "object") {
    return true;
  }
  const start = String(activeHours.start || "").trim();
  const end = String(activeHours.end || "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
    return true;
  }
  const toMinutes = (value) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  const current = now.getHours() * 60 + now.getMinutes();
  const startMin = toMinutes(start);
  const endMin = toMinutes(end);
  return startMin <= endMin
    ? current >= startMin && current <= endMin
    : current >= startMin || current <= endMin;
}

export class Heartbeat {
  constructor({ agent, intervalMs = 1800000 }) { // default: 30 min
    this.agent = agent;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.checks = [];
    this.lastCheckAt = null;
    this.checkCount = 0;
    this.taskRuns = new Map();
    this.lastSkipReason = "";
    this.lastDueTasks = [];
    // Execution state: due HEARTBEAT.md tasks now RUN as real agent turns
    // (Hermes-style) instead of only being reported as "due".
    this.taskRunning = false;
    this.lastTaskResults = [];
    this.taskRunCount = 0;
    this.taskFailCount = 0;
  }

  // Register a periodic check
  addCheck({ id, description, fn, intervalMs }) {
    this.checks.push({ id, description, fn, intervalMs: intervalMs || this.intervalMs, lastRun: null });
  }

  start() {
    if (this.timer) return;
    // runtime.heartbeat.every ("5m", "1h", ...) overrides the constructor
    // interval so users can tune the cadence from config without code.
    try {
      const every = this.agent?.config?.getConfig?.()?.runtime?.heartbeat?.every;
      if (every) this.intervalMs = parseDurationMs(every, this.intervalMs);
    } catch { /* keep constructor interval */ }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't run immediately on start - wait first interval
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tick() {
    const now = Date.now();
    this.checkCount++;
    this.lastCheckAt = new Date(now).toISOString();
    this.lastSkipReason = "";
    const heartbeatConfig = this.agent?.config?.getConfig?.()?.runtime?.heartbeat || {};

    if (!isWithinActiveHours(heartbeatConfig.activeHours, new Date(now))) {
      this.lastSkipReason = "outside-active-hours";
      this.agent.gateway?.addEvent?.("heartbeat.skipped", {
        checkCount: this.checkCount,
        reason: this.lastSkipReason,
        activeHours: heartbeatConfig.activeHours,
      });
      return;
    }

    if (this.shouldSkipWhenBusy()) {
      this.lastSkipReason = "runtime-busy";
      this.agent.gateway?.addEvent?.("heartbeat.skipped", {
        checkCount: this.checkCount,
        reason: this.lastSkipReason,
      });
      return;
    }

    const results = [];
    const promptResult = this.evaluateHeartbeatPrompt(now);
    if (promptResult) {
      results.push(promptResult);
      this.lastDueTasks = promptResult.result?.dueTasks || [];
      if (promptResult.result?.skipModelCall) {
        this.agent.gateway?.addEvent?.("heartbeat.skipped", {
          checkCount: this.checkCount,
          reason: promptResult.result.reason || "no due HEARTBEAT.md tasks",
          taskCount: promptResult.result.taskCount || 0,
        });
      } else if (this.lastDueTasks.length > 0) {
        // Due tasks actually EXECUTE as agent runs (this used to only emit an
        // event, so HEARTBEAT.md tasks never ran). Fire-and-forget: a slow
        // model run must never block the heartbeat timer itself.
        // Opt-in gate: without explicit enablement this only records the due
        // tasks — no model call, no billing. Local checks below still run.
        if (promptResult.result?.modelRunsAllowed) {
          void this.executeDueTasks(this.lastDueTasks, heartbeatConfig);
        } else {
          this.agent.gateway?.addEvent?.("heartbeat.skipped", {
            checkCount: this.checkCount,
            reason: "model-runs-not-enabled",
            taskCount: promptResult.result?.taskCount || 0,
            dueTasks: this.lastDueTasks.map((t) => t.name),
          });
        }
      }
    }
    for (const check of this.checks) {
      const elapsed = now - (check.lastRun || 0);
      if (elapsed < check.intervalMs) continue;

      try {
        check.lastRun = now;
        const result = await check.fn(this.agent);
        results.push({ id: check.id, status: "ok", result });
      } catch (err) {
        results.push({ id: check.id, status: "error", error: err.message });
      }
    }

    // Emit heartbeat event
    if (results.length > 0) {
      this.agent.eventBus?.emit?.("heartbeat", { checkCount: this.checkCount, results });
      this.agent.gateway?.addEvent?.("heartbeat.tick", {
        checkCount: this.checkCount,
        checks: results.length,
        ok: results.filter(r => r.status === "ok").length,
        errors: results.filter(r => r.status === "error").length,
        heartbeatOk: results.some((item) => item.result?.reply === "HEARTBEAT_OK"),
      });
    }
  }

  shouldSkipWhenBusy() {
    const config = this.agent?.config?.getConfig?.() || {};
    const setting = config.runtime?.heartbeat?.skipWhenBusy;
    if (setting === false) {
      return false;
    }
    const queues = this.agent?.sessionRunQueues;
    if (!queues || typeof queues.values !== "function") {
      return false;
    }
    for (const queue of queues.values()) {
      if (queue?.activeRunId || (Array.isArray(queue?.items) && queue.items.length > 0)) {
        return true;
      }
    }
    return false;
  }

  // Token-cost opt-in gate for background MODEL runs (local housekeeping
  // checks always run). A due HEARTBEAT.md task becomes a real agent run
  // ONLY when explicitly enabled, either via config
  // (runtime.heartbeat.modelRuns: true) or via an enable marker line inside
  // HEARTBEAT.md itself ("enable: true" or "heartbeat: on"). Default OFF:
  // the shipped template file must never bill model calls on its own.
  isModelRunAllowed(promptText = "") {
    const cfg = this.agent?.config?.getConfig?.()?.runtime?.heartbeat || {};
    if (cfg.modelRuns === true) return true;
    if (cfg.modelRuns === false) return false;
    return /(^|\n)\s*(enable\s*:\s*true|heartbeat\s*:\s*on)\s*(\n|$)/i.test(String(promptText || ""));
  }

  evaluateHeartbeatPrompt(now) {
    let workspaceContext = null;
    try {
      workspaceContext = this.agent?.loadWorkspaceContext?.("main");
    } catch {
      workspaceContext = null;
    }
    const prompt = String(
      (workspaceContext?.files || []).find((file) => String(file.name || "").toUpperCase() === "HEARTBEAT.MD" && file.scope === "agent")?.content ||
      (workspaceContext?.files || []).find((file) => String(file.name || "").toUpperCase() === "HEARTBEAT.MD")?.content ||
      workspaceContext?.heartbeatPrompt ||
      "",
    ).trim();
    if (!prompt) {
      return null;
    }
    const tasks = parseHeartbeatTasks(prompt);
    const dueTasks = [];
    for (const task of tasks) {
      const key = task.name;
      const intervalMs = parseDurationMs(task.interval, this.intervalMs);
      const lastRun = this.taskRuns.get(key) || 0;
      if (now - lastRun >= intervalMs) {
        // NOTE: do NOT mark the task run here. executeDueTasks only runs the
        // first 3 due tasks per tick and drops the whole batch when a prior
        // heartbeat run is still in flight — marking at due-evaluation time
        // meant those unexecuted tasks were silently skipped for a full
        // interval. The clock is now advanced in executeDueTasks, per task,
        // only when it is actually consumed for execution.
        dueTasks.push({
          ...task,
          intervalMs,
        });
      }
    }
    if (tasks.length > 0 && dueTasks.length === 0) {
      return {
        id: "heartbeat-prompt",
        status: "ok",
        result: {
          reply: "HEARTBEAT_OK",
          reason: "no due HEARTBEAT.md tasks",
          taskCount: tasks.length,
          dueTasks: [],
          skipModelCall: true,
        },
      };
    }
    const config = this.agent?.config?.getConfig?.()?.runtime?.heartbeat || {};
    return {
      id: "heartbeat-prompt",
      status: "ok",
      result: {
        reply: dueTasks.length > 0 ? "DUE_TASKS" : "HEARTBEAT_OK",
        taskCount: tasks.length,
        dueTasks,
        modelRunsAllowed: this.isModelRunAllowed(prompt),
        promptPreview: prompt.slice(0, 1200),
        target: config.target || "none",
        lightContext: config.lightContext !== false,
        isolatedSession: config.isolatedSession === true,
        skipWhenBusy: config.skipWhenBusy !== false,
      },
    };
  }

  // ── Task execution (Hermes-style: due tasks become real agent runs) ─────
  // Runs each due HEARTBEAT.md task through the normal agent pipeline in a
  // dedicated heartbeat session. Results are delivered to the configured
  // target channel unless the run replies HEARTBEAT_OK (nothing to report).
  // Background-model resolution (cheap first): explicit heartbeat model →
  // compaction model → "" (inherit main). Extracted for unit-testing.
  resolveBackgroundModel() {
    try {
      const hbConfig = this.agent?.config?.getConfig?.()?.runtime?.heartbeat || {};
      return String(hbConfig.model || "").trim()
        || String(this.agent?.config?.getConfig?.()?.provider?.compactionModel || "").trim();
    } catch {
      return "";
    }
  }

  async executeDueTasks(dueTasks = [], config = {}) {
    if (this.taskRunning) return; // never pile heartbeat runs on top of each other
    if (typeof this.agent?.handleMessage !== "function") return;
    this.taskRunning = true;
    const results = [];
    try {
      for (const task of dueTasks.slice(0, 3)) { // cap per tick so a long list can't monopolize the agent
        // Advance the task clock the moment we COMMIT to running it (not at
        // due-evaluation). Tasks beyond this per-tick cap stay due and are
        // picked up on the next tick instead of being lost for a full interval.
        // Mark-on-attempt (not on success) so a persistently failing task can't
        // hammer the model every tick.
        this.taskRuns.set(task.name, Date.now());
        const prompt = String(task.prompt || "").trim();
        if (!prompt) continue;
        const label = config.isolatedSession === true
          ? `heartbeat-${Date.now().toString(36)}`
          : "heartbeat";
        const startedAt = Date.now();
        // Background runs default to the cheap model (explicit heartbeat
        // model → compaction model → main). They never answer the user
        // directly, so they must never bill the main model by default.
        const cheapModel = this.resolveBackgroundModel();
        this.agent.gateway?.addEvent?.("heartbeat.task_started", {
          task: task.name,
          checkCount: this.checkCount,
          label,
          model: cheapModel || "(main model)",
        });
        try {
          const outcome = await this.agent.handleMessage(
            [
              `[HEARTBEAT — scheduled background check "${task.name}", not a user message]`,
              prompt,
              "",
              "If everything is fine and there is NOTHING worth reporting, reply with exactly: HEARTBEAT_OK",
              "Otherwise do the check/work with tools and report concisely what you found or did.",
            ].join("\n"),
            {
              label,
              agentId: "main",
              channel: "heartbeat",
              source: "heartbeat",
              ...(cheapModel ? { model: cheapModel } : {}),
            },
          );
          const reply = String(outcome?.reply || "").trim();
          const quiet = isHeartbeatOkReply(reply);
          this.taskRunCount += 1;
          const record = {
            task: task.name,
            at: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            ok: true,
            quiet,
            replyPreview: reply.slice(0, 400),
          };
          results.push(record);
          this.agent.gateway?.addEvent?.("heartbeat.task_completed", {
            ...record,
            checkCount: this.checkCount,
          });
          if (!quiet && reply) {
            await this.deliverResult(task, reply, config);
          }
        } catch (err) {
          this.taskFailCount += 1;
          const record = {
            task: task.name,
            at: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            ok: false,
            error: String(err?.message || err).slice(0, 300),
          };
          results.push(record);
          this.agent.gateway?.addEvent?.("heartbeat.task_failed", {
            ...record,
            checkCount: this.checkCount,
          });
        }
      }
    } finally {
      this.taskRunning = false;
      if (results.length > 0) {
        this.lastTaskResults = results.slice(-10);
      }
    }
  }

  // Deliver a non-quiet heartbeat result to runtime.heartbeat.target:
  //   "telegram:<chatId>" | "discord:<channelId>" | "none"/"" (event only —
  //   the heartbeat.task_completed event already carries the reply preview).
  async deliverResult(task, reply, config = {}) {
    const target = String(config.target || "").trim();
    if (!target || target === "none") return;
    const [kind, id] = target.split(":").map((s) => String(s || "").trim());
    if (!id) return;
    const text = `[heartbeat: ${task.name}]\n${String(reply).slice(0, 3500)}`;
    try {
      if (/^telegram$/i.test(kind) && this.agent?.telegramWorker?.sendMessage) {
        await this.agent.telegramWorker.sendMessage(id, text);
      } else if (/^discord$/i.test(kind) && this.agent?.discordWorker?.sendMessage) {
        await this.agent.discordWorker.sendMessage(id, text);
      } else {
        return;
      }
      this.agent.gateway?.addEvent?.("heartbeat.result_delivered", {
        task: task.name,
        target: `${kind}:${id.slice(0, 6)}…`,
      });
    } catch (err) {
      this.agent.gateway?.addEvent?.("heartbeat.delivery_failed", {
        task: task.name,
        target: kind,
        error: String(err?.message || err).slice(0, 200),
      });
    }
  }

  getStatus() {
    return {
      running: !!this.timer,
      intervalMs: this.intervalMs,
      checkCount: this.checkCount,
      lastCheckAt: this.lastCheckAt,
      lastSkipReason: this.lastSkipReason,
      heartbeatTaskCount: this.taskRuns.size,
      dueTasks: this.lastDueTasks,
      taskRunning: this.taskRunning,
      taskRunCount: this.taskRunCount,
      taskFailCount: this.taskFailCount,
      lastTaskResults: this.lastTaskResults,
      config: this.agent?.config?.getConfig?.()?.runtime?.heartbeat || {
        every: "30m",
        target: "none",
        lightContext: true,
        isolatedSession: false,
        skipWhenBusy: true,
      },
      checks: this.checks.map(c => ({ id: c.id, description: c.description, lastRun: c.lastRun })),
    };
  }
}
