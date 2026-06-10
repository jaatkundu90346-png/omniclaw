import fs from "node:fs";
import path from "node:path";
import { parseInterval } from "./cron-interval-parser.js";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createNaturalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Parse schedule input, supporting natural language intervals.
 * Accepts: "5m", "1h", "2d", "1h30m", raw ms number, or cron expression.
 * Returns normalized schedule input with intervalMs and cron fields.
 */
export function normalizeScheduleInput(input = {}) {
  const result = { ...input };

  // If intervalMs is already a valid number, use it directly
  if (typeof input.intervalMs === "number" && input.intervalMs > 0) {
    result.intervalMs = input.intervalMs;
    return result;
  }

  // Parse natural interval string: "5m", "1h", "2d", "1h30m", etc.
  if (typeof input.interval === "string" && input.interval) {
    const parsed = parseInterval(input.interval);
    if (parsed.ms) {
      result.intervalMs = parsed.ms;
    } else if (parsed.cron) {
      // Cron expression: store as special intervalMs = -1, cron field holds expression
      result.intervalMs = -1;
      result.cron = parsed.cron;
    }
    return result;
  }

  // Parse cron field directly
  if (typeof input.cron === "string" && input.cron) {
    result.intervalMs = -1;
    return result;
  }

  // Default to 60s if nothing specified
  result.intervalMs = normalizePositiveNumber(input.intervalMs, 60_000);
  return result;
}

function normalizeSchedule(schedule) {
  const createdAt = schedule.createdAt || new Date().toISOString();
  const intervalMs = schedule.intervalMs === -1 ? 60_000 : normalizePositiveNumber(schedule.intervalMs, 60_000);
  return {
    id: String(schedule.id || createId("schedule")),
    name: String(schedule.name || "Scheduled tool job"),
    type: String(schedule.type || "tool"),
    status: String(schedule.status || "active"),
    source: String(schedule.source || "api"),
    tool: String(schedule.tool || ""),
    input: schedule.input && typeof schedule.input === "object" ? schedule.input : {},
    agentId: String(schedule.agentId || "main"),
    intervalMs,
    cron: schedule.cron || null, // Raw cron expression (intervalMs = -1 when using cron)
    maxRuns: Number(schedule.maxRuns || 0),
    runCount: Number(schedule.runCount || 0),
    failureCount: Number(schedule.failureCount || 0),
    retry: {
      maxAttempts: Number(schedule.retry?.maxAttempts || 1),
      delayMs: normalizePositiveNumber(schedule.retry?.delayMs, 5_000),
    },
    nextRunAt: schedule.nextRunAt || new Date(Date.now() + intervalMs).toISOString(),
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
    // Normalize input: parse natural intervals like "5m", "1h", "2d", "1h30m" or cron expressions
    const normalized = normalizeScheduleInput(input);
    const intervalMs = normalizePositiveNumber(normalized.intervalMs, 60_000);
    const hasCron = normalized.cron || (input.cron && input.intervalMs === -1);
    const now = new Date();

    const schedule = normalizeSchedule({
      ...input,
      ...normalized,
      intervalMs,
      cron: normalized.cron || input.cron || null,
      nextRunAt: input.runNow
        ? now.toISOString()
        : input.nextRunAt || (hasCron ? this._getNextCronRun(normalized.cron || input.cron, now) : new Date(now.getTime() + intervalMs).toISOString()),
      retry: {
        maxAttempts: Number(input.retry?.maxAttempts || input.retryMaxAttempts || 1),
        delayMs: normalizePositiveNumber(input.retry?.delayMs || input.retryDelayMs, 5_000),
      },
    });
    data.schedules.push(schedule);
    this.write(data);
    return schedule;
  }

  /**
   * Calculate next run time from cron expression using node-cron.
   * @param {string} cronExpr - Cron expression (5-field: min hour dom mon dow)
   * @param {Date} fromDate - Starting date
   * @returns {string} ISO date string of next run
   */
  _getNextCronRun(cronExpr, fromDate = new Date()) {
    try {
      // Simple cron parser for 5-field expressions
      // Format: minute hour day-of-month month day-of-week
      const parts = cronExpr.trim().split(/\s+/);
      if (parts.length !== 5) {
        return new Date(fromDate.getTime() + 60_000).toISOString();
      }

      const [min, hour, dom, month, dow] = parts;
      const now = fromDate;

      // Try next 365 days
      for (let i = 0; i < 365 * 24 * 60; i++) {
        const candidate = new Date(now.getTime() + i * 60_000);
        const m = candidate.getMinutes();
        const h = candidate.getHours();
        const d = candidate.getDate();
        const mo = candidate.getMonth() + 1;
        const wday = candidate.getDay();

        const minMatch = this._matchCronField(min, m, 0, 59);
        const hourMatch = this._matchCronField(hour, h, 0, 23);
        const domMatch = this._matchCronField(dom, d, 1, 31);
        const monthMatch = this._matchCronField(month, mo, 1, 12);
        const dowMatch = this._matchCronField(dow, wday, 0, 6);

        if (minMatch && hourMatch && domMatch && monthMatch && dowMatch) {
          // Advance to the exact minute
          candidate.setSeconds(0, 0);
          if (candidate.getTime() > now.getTime()) {
            return candidate.toISOString();
          }
        }
      }
    } catch (e) {
      // Fallback: 1 minute from now
    }
    return new Date(fromDate.getTime() + 60_000).toISOString();
  }

  /**
   * Match a cron field against a value.
   * Supports: asterisk, specific number, step intervals, ranges, and lists
   */
  _matchCronField(field, value, min, max) {
    if (field === "*") return true;
    if (field.includes(",")) return field.split(",").some(f => this._matchCronField(f.trim(), value, min, max));
    if (field.includes("/")) {
      const [range, stepStr] = field.split("/");
      const step = parseInt(stepStr, 10);
      if (range === "*") {
        return (value - min) % step === 0;
      }
      const [start, end] = range.split("-").map(Number);
      return value >= start && value <= end && (value - start) % step === 0;
    }
    if (field.includes("-")) {
      const [start, end] = field.split("-").map(Number);
      return value >= start && value <= end;
    }
    return parseInt(field, 10) === value;
  }

  /**
   * Calculate next run for a cron schedule after a given time.
   */
  _advanceCronSchedule(cronExpr, lastRunAt) {
    const lastRun = lastRunAt ? new Date(lastRunAt) : new Date();
    return this._getNextCronRun(cronExpr, lastRun);
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

    // Calculate next run: use cron expression if present, otherwise intervalMs
    let nextRunAt;
    if (schedule.cron && !completed) {
      nextRunAt = this._advanceCronSchedule(schedule.cron, at);
    } else if (!completed) {
      nextRunAt = new Date(Date.parse(at) + schedule.intervalMs).toISOString();
    } else {
      nextRunAt = null;
    }

    return this.updateSchedule(scheduleId, {
      runCount,
      lastRunAt: at,
      lastJobId: jobId,
      nextRunAt,
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
