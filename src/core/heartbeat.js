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
  return tasks;
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
  }

  // Register a periodic check
  addCheck({ id, description, fn, intervalMs }) {
    this.checks.push({ id, description, fn, intervalMs: intervalMs || this.intervalMs, lastRun: null });
  }

  start() {
    if (this.timer) return;
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
        this.taskRuns.set(key, now);
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
        promptPreview: prompt.slice(0, 1200),
        target: config.target || "none",
        lightContext: config.lightContext !== false,
        isolatedSession: config.isolatedSession === true,
        skipWhenBusy: config.skipWhenBusy !== false,
      },
    };
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
