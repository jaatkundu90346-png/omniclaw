export class BackgroundWorker {
  constructor({ jobStore, gatewayStore, toolRegistry }) {
    this.jobStore = jobStore;
    this.gatewayStore = gatewayStore;
    this.toolRegistry = toolRegistry;
    this.running = false;
    this.drainPromise = null;
  }

  enqueueToolJob({ tool, input = {}, source = "api", agentId = "main", scheduleId = "", retry = {}, runAt = "" }) {
    const job = this.jobStore.createJob({
      type: "tool",
      payload: { tool, input, agentId, scheduleId, retry, runAt },
      source,
    });
    this.gatewayStore.addEvent("job.queued", {
      jobId: job.id,
      type: job.type,
      tool,
      agentId,
      scheduleId,
    });
    void this.drain();
    return job;
  }

  cancelJob(jobId, reason = "manual-cancel") {
    const job = this.jobStore.cancelJob(jobId, reason);
    this.gatewayStore.addEvent("job.cancelled", {
      jobId: job.id,
      type: job.type,
      status: job.status,
      agentId: job.payload?.agentId || "main",
      reason,
    });
    return job;
  }

  async drain() {
    if (this.running) {
      return this.drainPromise;
    }

    this.running = true;
    this.drainPromise = (async () => {
      let job = this.jobStore.getNextQueuedJob();
      while (job) {
        await this.runJob(job);
        job = this.jobStore.getNextQueuedJob();
      }
    })();

    try {
      await this.drainPromise;
    } finally {
      this.running = false;
      this.drainPromise = null;
    }
  }

  async runJob(job) {
    if (job.cancelRequested) {
      return this.cancelJob(job.id, "cancel-requested-before-start");
    }

    const startedAt = new Date().toISOString();
    this.jobStore.updateJob(job.id, {
      status: "running",
      attempts: job.attempts + 1,
      startedAt,
    });
    this.gatewayStore.addEvent("job.started", {
      jobId: job.id,
      type: job.type,
      agentId: job.payload?.agentId || "main",
    });

    try {
      const result = await this.execute(job);
      const latest = this.jobStore.getJob(job.id);
      if (latest?.cancelRequested) {
        const cancelled = this.jobStore.updateJob(job.id, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          result,
          error: latest.error || "cancel-requested",
        });
        this.gatewayStore.addEvent("job.cancelled", {
          jobId: job.id,
          type: job.type,
          agentId: job.payload?.agentId || "main",
          reason: cancelled.error,
        });
        return cancelled;
      }

      const completed = this.jobStore.updateJob(job.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        result,
      });
      this.gatewayStore.addEvent("job.completed", {
        jobId: job.id,
        type: job.type,
        agentId: job.payload?.agentId || "main",
      });
      return completed;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const maxAttempts = Number(job.retry?.maxAttempts || job.payload?.retry?.maxAttempts || 1);
      if (attempts < maxAttempts) {
        const delayMs = Number(job.retry?.delayMs || job.payload?.retry?.delayMs || 5000);
        const retryAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
        const retryQueued = this.jobStore.updateJob(job.id, {
          status: "queued",
          scheduledFor: retryAt,
          error: error.message,
          startedAt: null,
          completedAt: null,
        });
        this.gatewayStore.addEvent("job.retry_queued", {
          jobId: job.id,
          type: job.type,
          attempt: attempts,
          maxAttempts,
          retryAt,
          agentId: job.payload?.agentId || "main",
        });
        setTimeout(() => void this.drain(), Math.max(0, delayMs));
        return retryQueued;
      }

      const failed = this.jobStore.updateJob(job.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message,
      });
      this.gatewayStore.addEvent("job.failed", {
        jobId: job.id,
        type: job.type,
        error: error.message,
        agentId: job.payload?.agentId || "main",
      });
      return failed;
    }
  }

  async execute(job) {
    if (job.type === "tool") {
      const tool = String(job.payload?.tool || "").trim();
      if (!tool) {
        throw new Error("tool is required");
      }
      return this.toolRegistry.run(tool, job.payload?.input || {}, {
        agentId: job.payload?.agentId || "main",
        jobId: job.id,
      });
    }

    throw new Error(`Unknown job type: ${job.type}`);
  }
}
