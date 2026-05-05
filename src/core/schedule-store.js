import fs from "node:fs";
import path from "node:path";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeSchedule(schedule) {
  const createdAt = schedule.createdAt || new Date().toISOString();
  return {
    id: String(schedule.id || createId("schedule")),
    name: String(schedule.name || "Scheduled tool job"),
    type: String(schedule.type || "tool"),
    status: String(schedule.status || "active"),
    source: String(schedule.source || "api"),
    tool: String(schedule.tool || ""),
    input: schedule.input && typeof schedule.input === "object" ? schedule.input : {},
    agentId: String(schedule.agentId || "main"),
    intervalMs: normalizePositiveNumber(schedule.intervalMs, 60_000),
    maxRuns: Number(schedule.maxRuns || 0),
    runCount: Number(schedule.runCount || 0),
    failureCount: Number(schedule.failureCount || 0),
    retry: {
      maxAttempts: Number(schedule.retry?.maxAttempts || 1),
      delayMs: normalizePositiveNumber(schedule.retry?.delayMs, 5_000),
    },
    nextRunAt: schedule.nextRunAt || new Date(Date.now() + normalizePositiveNumber(schedule.intervalMs, 60_000)).toISOString(),
    lastRunAt: schedule.lastRunAt || null,
    lastJobId: schedule.lastJobId || null,
    lastError: schedule.lastError || null,
    createdAt,
    updatedAt: schedule.updatedAt || createdAt,
  };
}

export class ScheduleStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "schedules.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ schedules: [] }, null, 2));
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules.map(normalizeSchedule) : [],
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  createSchedule(input = {}) {
    const data = this.read();
    const intervalMs = normalizePositiveNumber(input.intervalMs, 60_000);
    const now = new Date();
    const schedule = normalizeSchedule({
      ...input,
      intervalMs,
      nextRunAt: input.runNow ? now.toISOString() : input.nextRunAt || new Date(now.getTime() + intervalMs).toISOString(),
      retry: {
        maxAttempts: Number(input.retry?.maxAttempts || input.retryMaxAttempts || 1),
        delayMs: normalizePositiveNumber(input.retry?.delayMs || input.retryDelayMs, 5_000),
      },
    });
    data.schedules.push(schedule);
    this.write(data);
    return schedule;
  }

  listSchedules(limit = 50) {
    return this.read().schedules.slice(-limit).reverse();
  }

  getSchedule(scheduleId) {
    return this.read().schedules.find((schedule) => schedule.id === scheduleId) || null;
  }

  getDueSchedules(now = new Date()) {
    const nowMs = now.getTime();
    return this.read().schedules.filter((schedule) => {
      if (schedule.status !== "active" || !schedule.nextRunAt) {
        return false;
      }
      if (schedule.maxRuns > 0 && schedule.runCount >= schedule.maxRuns) {
        return false;
      }
      return Date.parse(schedule.nextRunAt) <= nowMs;
    });
  }

  updateSchedule(scheduleId, updates) {
    const data = this.read();
    const index = data.schedules.findIndex((schedule) => schedule.id === scheduleId);
    if (index === -1) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    data.schedules[index] = normalizeSchedule({
      ...data.schedules[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    this.write(data);
    return data.schedules[index];
  }

  recordRun(scheduleId, { jobId, at = new Date().toISOString() } = {}) {
    const schedule = this.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const runCount = schedule.runCount + 1;
    const completed = schedule.maxRuns > 0 && runCount >= schedule.maxRuns;
    return this.updateSchedule(scheduleId, {
      runCount,
      lastRunAt: at,
      lastJobId: jobId,
      nextRunAt: completed ? null : new Date(Date.parse(at) + schedule.intervalMs).toISOString(),
      status: completed ? "completed" : schedule.status,
    });
  }

  setStatus(scheduleId, status) {
    const nextStatus = String(status || "").trim() || "paused";
    const updates = {
      status: nextStatus,
    };
    if (nextStatus === "active") {
      const schedule = this.getSchedule(scheduleId);
      updates.nextRunAt = schedule?.nextRunAt || new Date(Date.now() + (schedule?.intervalMs || 60_000)).toISOString();
    }
    return this.updateSchedule(scheduleId, updates);
  }

  deleteSchedule(scheduleId) {
    const data = this.read();
    const index = data.schedules.findIndex((schedule) => schedule.id === scheduleId);
    if (index === -1) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    const [deleted] = data.schedules.splice(index, 1);
    this.write(data);
    return deleted;
  }
}
