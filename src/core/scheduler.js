export class Scheduler {
  constructor({ scheduleStore, worker, gatewayStore, pollMs = 1000 }) {
    this.scheduleStore = scheduleStore;
    this.worker = worker;
    this.gatewayStore = gatewayStore;
    this.pollMs = pollMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    void this.tick();
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  getOverview() {
    const schedules = this.scheduleStore.listSchedules(100);
    return {
      scheduleCount: schedules.length,
      activeCount: schedules.filter((schedule) => schedule.status === "active").length,
      pausedCount: schedules.filter((schedule) => schedule.status === "paused").length,
      completedCount: schedules.filter((schedule) => schedule.status === "completed").length,
      nextRunAt:
        schedules
          .filter((schedule) => schedule.status === "active" && schedule.nextRunAt)
          .map((schedule) => schedule.nextRunAt)
          .sort()[0] || null,
    };
  }

  createSchedule(input = {}) {
    const schedule = this.scheduleStore.createSchedule(input);
    this.gatewayStore.addEvent("schedule.created", {
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      tool: schedule.tool,
      nextRunAt: schedule.nextRunAt,
    });
    void this.tick();
    return schedule;
  }

  runNow(scheduleId, source = "manual") {
    const schedule = this.scheduleStore.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    return this.enqueueSchedule(schedule, source);
  }

  setStatus(scheduleId, status) {
    const schedule = this.scheduleStore.setStatus(scheduleId, status);
    this.gatewayStore.addEvent("schedule.status_changed", {
      scheduleId,
      status: schedule.status,
    });
    void this.tick();
    return schedule;
  }

  deleteSchedule(scheduleId) {
    const schedule = this.scheduleStore.deleteSchedule(scheduleId);
    this.gatewayStore.addEvent("schedule.deleted", {
      scheduleId,
      agentId: schedule.agentId,
      tool: schedule.tool,
    });
    return schedule;
  }

  async tick() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const dueSchedules = this.scheduleStore.getDueSchedules();
      for (const schedule of dueSchedules) {
        this.enqueueSchedule(schedule, "scheduler");
      }
    } finally {
      this.running = false;
    }
  }

  enqueueSchedule(schedule, source) {
    if (!schedule.tool) {
      const failed = this.scheduleStore.updateSchedule(schedule.id, {
        status: "paused",
        lastError: "Schedule is missing a tool.",
      });
      this.gatewayStore.addEvent("schedule.failed", {
        scheduleId: schedule.id,
        reason: failed.lastError,
      });
      return { schedule: failed, job: null };
    }

    const job = this.worker.enqueueToolJob({
      tool: schedule.tool,
      input: schedule.input,
      source: `schedule:${source}`,
      agentId: schedule.agentId,
      scheduleId: schedule.id,
      retry: schedule.retry,
    });
    const updated = this.scheduleStore.recordRun(schedule.id, {
      jobId: job.id,
    });
    this.gatewayStore.addEvent("schedule.enqueued", {
      scheduleId: schedule.id,
      jobId: job.id,
      agentId: schedule.agentId,
      tool: schedule.tool,
      nextRunAt: updated.nextRunAt,
    });
    return { schedule: updated, job };
  }
}
