import fs from "node:fs";
import path from "node:path";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function matchesQuery(record, query) {
  const value = String(query || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  return JSON.stringify(record).toLowerCase().includes(value);
}

export class ShellAuditStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "shell-audit.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ records: [] }, null, 2));
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  append(input = {}) {
    const data = this.read();
    const record = {
      id: createId("shell_audit"),
      at: new Date().toISOString(),
      ...input,
    };
    data.records.push(record);
    if (data.records.length > 500) {
      data.records = data.records.slice(-500);
    }
    this.write(data);
    return record;
  }

  list({ limit = 50, status = "", risk = "", query = "" } = {}) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    const normalizedRisk = String(risk || "").trim().toLowerCase();
    return this.read()
      .records.filter((record) => {
        if (normalizedStatus && String(record.status || "").toLowerCase() !== normalizedStatus) {
          return false;
        }
        if (normalizedRisk && String(record.risk || "").toLowerCase() !== normalizedRisk) {
          return false;
        }
        return matchesQuery(record, query);
      })
      .slice(-Number(limit || 50))
      .reverse();
  }

  getOverview() {
    const records = this.read().records;
    const executed = records.filter((record) => record.phase === "executed");
    return {
      total: records.length,
      planned: records.filter((record) => record.phase === "planned").length,
      executed: executed.length,
      blocked: records.filter((record) => record.status === "blocked").length,
      failed: records.filter((record) => record.status === "failed" || record.status === "timeout").length,
      highRisk: records.filter((record) => record.risk === "high" || record.risk === "blocked").length,
      lastExecutionAt: executed[executed.length - 1]?.at || null,
    };
  }
}
