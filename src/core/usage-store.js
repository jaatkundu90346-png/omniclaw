// ─── Usage / Cost Store ─────────────────────────────────────────
// Records per-turn token usage + computed USD cost and rolls it up per session,
// per day, and per model. Persists to data/usage.json. Pairs with the token
// usage already aggregated by omni-loop (report.usage) and model-pricing.js.

import fs from "node:fs";
import path from "node:path";
import { computeCost } from "./model-pricing.js";

const MAX_TURNS = 5000;

export class UsageStore {
  constructor(rootDir, { pricingOverrides = {} } = {}) {
    this.filePath = path.join(rootDir, "data", "usage.json");
    this.pricingOverrides = pricingOverrides || {};
    this._cache = null;
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ turns: [] }, null, 2));
    }
  }

  read() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return { turns: [] };
    }
    if (this._cache && this._cache.mtimeMs === stat.mtimeMs && this._cache.size === stat.size) {
      return this._cache.data;
    }
    let data = { turns: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      data = { turns: Array.isArray(parsed.turns) ? parsed.turns : [] };
    } catch {
      data = { turns: [] };
    }
    this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    try {
      const stat = fs.statSync(this.filePath);
      this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    } catch {
      this._cache = null;
    }
  }

  setPricingOverrides(overrides) {
    this.pricingOverrides = overrides || {};
  }

  record({ model, usage = {}, sessionId = "", agentId = "" } = {}) {
    const cost = computeCost(model, usage, this.pricingOverrides);
    // Skip empty no-op turns (no tokens at all).
    if (!cost.promptTokens && !cost.completionTokens) {
      return null;
    }
    const now = new Date();
    const entry = {
      ts: now.toISOString(),
      day: now.toISOString().slice(0, 10),
      sessionId: String(sessionId || ""),
      agentId: String(agentId || ""),
      model: cost.model,
      promptTokens: cost.promptTokens,
      completionTokens: cost.completionTokens,
      costUsd: cost.costUsd,
      priced: cost.priced,
    };
    const data = this.read();
    data.turns.push(entry);
    if (data.turns.length > MAX_TURNS) {
      data.turns = data.turns.slice(-MAX_TURNS);
    }
    this.write(data);
    return entry;
  }

  summary({ sessionId = null, day = null } = {}) {
    let turns = this.read().turns;
    if (sessionId) turns = turns.filter((t) => t.sessionId === sessionId);
    if (day) turns = turns.filter((t) => t.day === day);
    const agg = turns.reduce(
      (acc, t) => {
        acc.turns += 1;
        acc.promptTokens += t.promptTokens || 0;
        acc.completionTokens += t.completionTokens || 0;
        acc.costUsd += t.costUsd || 0;
        if (t.priced === false) acc.unpricedTurns += 1;
        return acc;
      },
      { turns: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedTurns: 0 },
    );
    agg.costUsd = Math.round(agg.costUsd * 1e6) / 1e6;
    return agg;
  }

  rollup() {
    const byDay = {};
    const bySession = {};
    const byModel = {};
    const add = (bucket, key, t) => {
      const k = key || "unknown";
      const b = (bucket[k] = bucket[k] || { turns: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
      b.turns += 1;
      b.promptTokens += t.promptTokens || 0;
      b.completionTokens += t.completionTokens || 0;
      b.costUsd = Math.round((b.costUsd + (t.costUsd || 0)) * 1e6) / 1e6;
    };
    for (const t of this.read().turns) {
      add(byDay, t.day, t);
      add(bySession, t.sessionId, t);
      add(byModel, t.model, t);
    }
    return { total: this.summary(), byDay, bySession, byModel };
  }
}
