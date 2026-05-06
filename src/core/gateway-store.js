import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class GatewayStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "gateway.json");
    this.emitter = new EventEmitter();
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ seq: 0, events: [], runs: [], approvals: [], delegations: [] }, null, 2),
      );
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      seq: Number(parsed.seq || 0),
      events: Array.isArray(parsed.events) ? parsed.events : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
      delegations: Array.isArray(parsed.delegations) ? parsed.delegations : [],
    };
  }

  write(data) {
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const nextJson = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, nextJson);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.renameSync(tmpPath, this.filePath);
        return;
      } catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt === 7) {
          try {
            fs.writeFileSync(this.filePath, nextJson);
            fs.rmSync(tmpPath, { force: true });
            return;
          } catch {
            throw error;
          }
        }
        sleepSync(25 * (attempt + 1));
      }
    }
  }

  onEvent(listener) {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  addEvent(event, payload = {}) {
    const data = this.read();
    const record = {
      seq: data.seq + 1,
      id: createId("event"),
      event,
      payload,
      at: new Date().toISOString(),
    };
    data.seq = record.seq;
    data.events.push(record);
    if (data.events.length > 200) {
      data.events = data.events.slice(-200);
    }
    this.write(data);
    this.emitter.emit("event", record);
    if (this.agentRef && this.agentRef.eventBus) {
      try { this.agentRef.eventBus.emit(event, record); } catch {}
    }
    return record;
  }

  listEvents(limit = 50) {
    return this.read().events.slice(-limit).reverse();
  }

  createRun(input) {
    const data = this.read();
    const run = {
      id: createId("run"),
      status: "accepted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    };
    data.runs.push(run);
    this.write(data);
    return run;
  }

  updateRun(runId, updates) {
    const data = this.read();
    const index = data.runs.findIndex((run) => run.id === runId);
    if (index === -1) {
      throw new Error(`Run not found: ${runId}`);
    }

    data.runs[index] = {
      ...data.runs[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.runs[index];
  }

  listRuns(limit = 50) {
    return this.read().runs.slice(-limit).reverse();
  }

  getRun(runId) {
    return this.read().runs.find((run) => run.id === runId) || null;
  }

  getApproval(approvalId) {
    return this.read().approvals.find((approval) => approval.id === approvalId) || null;
  }

  updateApproval(approvalId, updates) {
    const data = this.read();
    const index = data.approvals.findIndex((approval) => approval.id === approvalId);
    if (index === -1) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    data.approvals[index] = {
      ...data.approvals[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.approvals[index];
  }

  createApproval(input) {
    const data = this.read();
    const approval = {
      id: createId("approval"),
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...input,
    };
    data.approvals.push(approval);
    this.write(data);
    this.addEvent("approval.requested", {
      approvalId: approval.id,
      type: approval.type,
      sessionId: approval.sessionId,
      runId: approval.runId,
    });
    return approval;
  }

  resolveApproval(approvalId, decision, note = "") {
    const data = this.read();
    const index = data.approvals.findIndex((approval) => approval.id === approvalId);
    if (index === -1) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    data.approvals[index] = {
      ...data.approvals[index],
      status: decision,
      note,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    this.addEvent("approval.resolved", {
      approvalId,
      decision,
    });
    return data.approvals[index];
  }

  listApprovals(status = "") {
    const approvals = this.read().approvals;
    return (status ? approvals.filter((item) => item.status === status) : approvals)
      .slice(-50)
      .reverse();
  }

  createDelegation(input) {
    const data = this.read();
    const now = new Date().toISOString();
    const delegation = {
      id: createId("delegation"),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      ...input,
    };
    data.delegations.push(delegation);
    this.write(data);
    return delegation;
  }

  updateDelegation(delegationId, updates) {
    const data = this.read();
    const index = data.delegations.findIndex((delegation) => delegation.id === delegationId);
    if (index === -1) {
      throw new Error(`Delegation not found: ${delegationId}`);
    }

    data.delegations[index] = {
      ...data.delegations[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.write(data);
    return data.delegations[index];
  }

  getDelegation(delegationId) {
    return this.read().delegations.find((delegation) => delegation.id === delegationId) || null;
  }

  listDelegations({ limit = 50, status = "", agentId = "" } = {}) {
    const normalizedStatus = String(status || "").trim();
    const normalizedAgentId = String(agentId || "").trim();
    return this.read()
      .delegations.filter((delegation) => {
        if (normalizedStatus && delegation.status !== normalizedStatus) {
          return false;
        }
        if (
          normalizedAgentId &&
          delegation.sourceAgentId !== normalizedAgentId &&
          delegation.targetAgentId !== normalizedAgentId
        ) {
          return false;
        }
        return true;
      })
      .slice(-Number(limit || 50))
      .reverse();
  }

  getOverview() {
    const data = this.read();
    return {
      eventCount: data.events.length,
      runCount: data.runs.length,
      queuedRuns: data.runs.filter((run) => run.status === "queued").length,
      runningRuns: data.runs.filter((run) => run.status === "running").length,
      pendingApprovals: data.approvals.filter((item) => item.status === "pending").length,
      delegationCount: data.delegations.length,
      activeDelegations: data.delegations.filter((item) => ["queued", "running"].includes(item.status)).length,
      failedDelegations: data.delegations.filter((item) => item.status === "failed").length,
      lastEvent: data.events[data.events.length - 1] || null,
    };
  }

  // ─── Approval Timeout ─────────────────────────────────────────
  expireOldApprovals(timeoutMinutes = 30) {
    const data = this.read();
    const now = Date.now();
    let expired = 0;
    for (const approval of data.approvals) {
      if (approval.status !== "pending") continue;
      const age = (now - Date.parse(approval.createdAt || approval.updatedAt || 0)) / 60_000;
      if (age > timeoutMinutes) {
        approval.status = "expired";
        approval.expiredAt = new Date().toISOString();
        approval.updatedAt = new Date().toISOString();
        approval.expiryReason = `Auto-expired after ${timeoutMinutes} minutes`;
        expired++;
      }
    }
    if (expired > 0) {
      this.write(data);
      this.addEvent("approval.expired_batch", { count: expired, timeoutMinutes });
    }
    return { expired, checked: data.approvals.filter(a => a.status === "pending" || a.status === "expired").length };
  }
}