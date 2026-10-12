// Global run gate.
//
// WHY: sessionRunQueues (agent.js) serializes runs PER SESSION only. Two agents
// on two different agent ids therefore run at the same time — and they then share
// ONE `this.provider` on the agent singleton, one shell executor, one browser
// and one port (AGENTS_AUDIT risk 2/3). With maxConcurrentRuns = 1 (the
// default) that is a latent bug; the gate turns it into "the second run waits".
//
// This is a plain counting semaphore with three properties that matter:
//
//  1. HANDOFF, NOT WAKE-UP. release() passes the slot straight to the first
//     waiter instead of freeing then re-acquiring. Otherwise two waiters can
//     both observe "a slot is free" in the same tick and both proceed.
//  2. THE SLOT IS NEVER HELD FOREVER. Every holder carries a deadline. If a run
//     crashes, is killed, or abandons its promise, sweep() force-releases it.
//     Without this a single hung run would wedge the gate and no agent could ever
//     run again — a far worse failure than the race it prevents.
//  3. TIMED-OUT WAITERS LEAVE. acquire() rejects after waitTimeoutMs so a
//     caller parked behind a dead run fails loudly instead of hanging a request.

const DEFAULT_MAX_CONCURRENT_RUNS = 1;
const MAX_CONCURRENT_RUNS_CEILING = 4;

export function resolveMaxConcurrentRuns(raw, fallback = DEFAULT_MAX_CONCURRENT_RUNS) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_CONCURRENT_RUNS_CEILING, Math.floor(value)));
}

export class RunGate {
  /**
   * @param {object} options
   * @param {number} [options.maxConcurrent]     slots (1..4)
   * @param {number} [options.waitTimeoutMs]     how long acquire() waits before giving up
   * @param {number} [options.slotTimeoutMs]     safety deadline for ONE holder
   */
  constructor({ maxConcurrent = DEFAULT_MAX_CONCURRENT_RUNS, waitTimeoutMs = 900_000, slotTimeoutMs = 3_600_000 } = {}) {
    this.maxConcurrent = resolveMaxConcurrentRuns(maxConcurrent);
    this.waitTimeoutMs = Math.max(1000, Number(waitTimeoutMs) || 900_000);
    this.slotTimeoutMs = Math.max(30_000, Number(slotTimeoutMs) || 3_600_000);
    // runId -> { runId, since, deadline }
    this.holders = new Map();
    // FIFO waiters, each { runId, resolve, reject, timer }
    this.waiters = [];
  }

  get activeCount() {
    return this.holders.size;
  }

  get waitingCount() {
    return this.waiters.length;
  }

  snapshot() {
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.activeCount,
      waiting: this.waitingCount,
      holders: [...this.holders.values()].map((h) => ({ runId: h.runId, since: h.since })),
    };
  }

  /** Force-release slots whose holder blew past its deadline. Safe to call often. */
  sweep(now = Date.now()) {
    const forced = [];
    for (const [runId, holder] of this.holders) {
      if (now >= holder.deadline) {
        this.holders.delete(runId);
        forced.push(runId);
      }
    }
    return forced;
  }

  _takeSlot(runId) {
    this.sweep();
    if (this.holders.size >= this.maxConcurrent) return false;
    this.holders.set(runId, { runId, since: new Date().toISOString(), deadline: Date.now() + this.slotTimeoutMs });
    return true;
  }

  _pump() {
    while (this.waiters.length > 0 && this.holders.size < this.maxConcurrent) {
      const waiter = this.waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      // Hand the slot over directly — see property (1) above.
      this.holders.set(waiter.runId, {
        runId: waiter.runId,
        since: new Date().toISOString(),
        deadline: Date.now() + this.slotTimeoutMs,
      });
      waiter.resolve({ ok: true, runId: waiter.runId, queued: true });
    }
  }

  /**
   * Take a slot, waiting if all are busy.
   * Resolves {ok:true} once the slot is held; rejects on wait timeout.
   */
  acquire(runId, { waitTimeoutMs } = {}) {
    this.sweep();
    const id = String(runId || "anon");
    if (this._takeSlot(id)) {
      return Promise.resolve({ ok: true, runId: id, queued: false });
    }
    const limit = Math.max(1000, Number(waitTimeoutMs) || this.waitTimeoutMs);
    return new Promise((resolve, reject) => {
      const waiter = { runId: id, resolve, reject, settled: false, timer: null };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        const error = new Error(`Timed out after ${limit}ms waiting for a run slot (maxConcurrentRuns=${this.maxConcurrent}).`);
        error.code = "EGATE";
        reject(error);
      }, limit);
      if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /** Give the slot back. Safe to call twice; safe to call for a run that never got one. */
  release(runId) {
    const id = String(runId || "");
    const had = this.holders.delete(id);
    this._pump();
    return had;
  }
}