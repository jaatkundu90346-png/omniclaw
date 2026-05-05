import fs from "node:fs";
import path from "node:path";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class JobStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "jobs.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ jobs: [] }, null, 2));
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  createJob({ type, payload = {}, source = "api" }) {
    const data = this.read();
    const retry = payload.retry && typeof payload.retry === "object" ? payload.retry : {};
    const job = {
      id: createId("job"),
      type,
      payload,
      source,
      status: "queued",
      attempts: 0,
      retry: {
        maxAttempts: Number(retry.maxAttempts || 1),
        delayMs: Number(retry.delayMs || 5000),
      },
      scheduledFor: payload.runAt || new Date().toISOString(),
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    };
    data.jobs.push(job);
    this.write(data);
    return job;
  }

  listJobs(limit = 50) {
    return this.read().jobs.slice(-limit).reverse();
  }

  getJob(jobId) {
    return this.read().jobs.find((job) => job.id === jobId) || null;
  }

  getNextQueuedJob() {
    const now = Date.now();
    return (
      this.read().jobs.find((job) => {
        if (job.status !== "queued" || job.cancelRequested) {
          return false;
        }
        return Date.parse(job.scheduledFor || job.createdAt || 0) <= now;
      }) || null
    );
  }

  updateJob(jobId, updates) {
    const data = this.read();
    const index = data.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Job not found: ${jobId}`);
    }

    data.jobs[index] = {
      ...data.jobs[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.jobs[index];
  }

  cancelJob(jobId, reason = "manual-cancel") {
    const job = this.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status === "queued") {
      return this.updateJob(jobId, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: reason,
      });
    }

    if (job.status === "running") {
      return this.updateJob(jobId, {
        cancelRequested: true,
        error: reason,
      });
    }

    return job;
  }
}
