// ─── Heartbeat System ──────────────────────────────────────────
// Periodic checks that the agent can perform autonomously
// Similar to OpenClaw's heartbeat polling

export class Heartbeat {
  constructor({ agent, intervalMs = 1800000 }) { // default: 30 min
    this.agent = agent;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.checks = [];
    this.lastCheckAt = null;
    this.checkCount = 0;
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

    const results = [];
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
      });
    }
  }

  getStatus() {
    return {
      running: !!this.timer,
      intervalMs: this.intervalMs,
      checkCount: this.checkCount,
      lastCheckAt: this.lastCheckAt,
      checks: this.checks.map(c => ({ id: c.id, description: c.description, lastRun: c.lastRun })),
    };
  }
}
