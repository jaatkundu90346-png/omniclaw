import fs from "node:fs";
import path from "node:path";

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

class StartupPhase {
  constructor(name) {
    this.name = name;
    this.startedAt = Date.now();
    this.completedAt = null;
    this.durationMs = null;
    this.status = "running";
    this.error = null;
    this.details = {};
  }

  complete(details = {}) {
    this.completedAt = Date.now();
    this.durationMs = this.completedAt - this.startedAt;
    this.status = "completed";
    this.details = details;
  }

  fail(error) {
    this.completedAt = Date.now();
    this.durationMs = this.completedAt - this.startedAt;
    this.status = "failed";
    this.error = error.message || String(error);
  }
}

export class StartupTracer {
  constructor() {
    this.phases = [];
    this.startedAt = Date.now();
    this.currentPhase = null;
  }

  startPhase(name) {
    if (this.currentPhase && this.currentPhase.status === "running") {
      this.currentPhase.complete();
    }
    this.currentPhase = new StartupPhase(name);
    this.phases.push(this.currentPhase);
    return this.currentPhase;
  }

  completePhase(details = {}) {
    if (this.currentPhase) {
      this.currentPhase.complete(details);
    }
  }

  failPhase(error) {
    if (this.currentPhase) {
      this.currentPhase.fail(error);
    }
  }

  getTimeline() {
    return this.phases.map((p) => ({
      name: p.name,
      status: p.status,
      startedAt: new Date(p.startedAt).toISOString(),
      completedAt: p.completedAt ? new Date(p.completedAt).toISOString() : null,
      durationMs: p.durationMs,
      error: p.error,
      details: p.details,
    }));
  }

  getSummary() {
    const totalMs = Date.now() - this.startedAt;
    const completed = this.phases.filter((p) => p.status === "completed").length;
    const failed = this.phases.filter((p) => p.status === "failed").length;
    const running = this.phases.filter((p) => p.status === "running").length;

    return {
      totalPhases: this.phases.length,
      completed,
      failed,
      running,
      totalDurationMs: totalMs,
      allCompleted: failed === 0 && running === 0,
      timeline: this.getTimeline(),
    };
  }
}

export class ConfigReloader {
  constructor({ configStore, rootDir }) {
    this.configStore = configStore;
    this.rootDir = rootDir;
    this.watching = false;
    this.watchers = [];
    this.reloadCallbacks = [];
    this.lastReloadAt = null;
    this.reloadCount = 0;
    this.debounceMs = 1000;
    this.debounceTimer = null;
  }

  startWatching() {
    if (this.watching) return;
    this.watching = true;

    const configPaths = [
      path.join(this.rootDir, "opencode.json"),
      path.join(this.rootDir, "opencode.jsonc"),
      path.join(this.rootDir, ".env"),
    ];

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const watcher = fs.watch(configPath, (eventType) => {
            if (eventType === "change") {
              this.scheduleReload();
            }
          });
          this.watchers.push({ path: configPath, watcher });
        } catch {}
      }
    }
  }

  stopWatching() {
    this.watching = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const { watcher } of this.watchers) {
      try { watcher.close(); } catch {}
    }
    this.watchers = [];
  }

  scheduleReload() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.reload();
    }, this.debounceMs);
  }

  async reload() {
    try {
      if (this.configStore?.loadConfig) {
        this.configStore.loadConfig();
      }
      this.lastReloadAt = new Date().toISOString();
      this.reloadCount++;

      for (const callback of this.reloadCallbacks) {
        try {
          await callback();
        } catch {}
      }

      return { reloaded: true, at: this.lastReloadAt, count: this.reloadCount };
    } catch (error) {
      return { reloaded: false, error: error.message };
    }
  }

  onReload(callback) {
    this.reloadCallbacks.push(callback);
  }

  getStatus() {
    return {
      watching: this.watching,
      watchedFiles: this.watchers.map((w) => w.path),
      lastReloadAt: this.lastReloadAt,
      reloadCount: this.reloadCount,
      callbackCount: this.reloadCallbacks.length,
    };
  }
}

export async function bootstrapSequence(agent, options = {}) {
  const tracer = new StartupTracer();
  const configReloader = new ConfigReloader({
    configStore: agent.config,
    rootDir: agent.rootDir,
  });

  try {
    tracer.startPhase("config-load");
    const config = agent.config.getConfig();
    tracer.completePhase({ profile: config.runtime?.activeProfile || "default" });

    tracer.startPhase("provider-init");
    const providerInfo = agent.getProviderInfo();
    tracer.completePhase({ provider: providerInfo.id, model: providerInfo.model, ready: providerInfo.ready });

    tracer.startPhase("workspace-init");
    agent.workspace?.ensure?.();
    tracer.completePhase({ agents: agent.agents?.getAll?.()?.length || 0 });

    tracer.startPhase("gateway-init");
    const gatewayOverview = agent.gateway.getOverview();
    tracer.completePhase({ events: gatewayOverview.events?.length || 0 });

    tracer.startPhase("tools-init");
    const toolCount = agent.tools?.getAll?.({})?.length || 0;
    tracer.completePhase({ tools: toolCount });

    tracer.startPhase("memory-init");
    const memoryOverview = agent.memory?.getOverview?.() || {};
    tracer.completePhase({ notes: memoryOverview.notes?.length || 0 });

    tracer.startPhase("channels-init");
    tracer.completePhase({ channels: agent.connectors?.getAdapterStatus?.()?.length || 0 });

    tracer.startPhase("scheduler-init");
    agent.scheduler?.start?.();
    tracer.completePhase({ schedules: agent.schedules?.listSchedules?.()?.length || 0 });

    tracer.startPhase("config-watcher");
    configReloader.startWatching();
    tracer.completePhase({ watching: configReloader.getStatus() });

    tracer.startPhase("ready");
    tracer.completePhase({ uptime: Math.round(process.uptime()) });

    return {
      success: true,
      summary: tracer.getSummary(),
      configReloader: configReloader.getStatus(),
    };
  } catch (error) {
    tracer.failPhase(error);
    return {
      success: false,
      error: error.message,
      summary: tracer.getSummary(),
    };
  }
}
