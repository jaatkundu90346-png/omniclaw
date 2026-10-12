// The delegation store.
//
// WHY A STORE, NOT PER-CARD POLLING: a delegation outlives the run that created
// it. The card that shows it is attached to the SOURCE session's transcript,
// but the work happens in a TARGET session, in a different turn, minutes later.
// So the record is owned here (keyed by delegationId, fed by the same global
// /api/events feed the approvals store already uses) and cards subscribe to it.
//
// LIVENESS: the gateway emits delegation.created / .done / .failed / .cancelled
// / .deduplicated, which is enough to know WHEN to refresh. It does NOT emit on
// every step of the child's loop, so while any task is open we also poll on a
// slow tick - that is what makes "step 3 of 18" move. The poll stops the moment
// nothing is open, so a settled milestone costs nothing.

import { subscribeGatewayEvents } from "./sse.js";
import { getDelegations } from "./api.js";

const OPEN = new Set(["queued", "running"]);
const listeners = new Set();
let byId = new Map();
let timer = null;
let poll = null;
let inflight = false;

function notify() {
  const snapshot = list();
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* one bad subscriber must not stop the rest */ }
  }
}

export function list() {
  return [...byId.values()].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

export function get(id) {
  return byId.get(id) || null;
}

/** Tasks this agent SENT or RECEIVED - its inbox + outbox. */
export function forAgent(agentId) {
  if (!agentId) return [];
  return list().filter((d) => d.sourceAgentId === agentId || d.targetAgentId === agentId);
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(list());
  return () => listeners.delete(fn);
}

export async function refresh(agentId = "") {
  if (inflight) return; // never stack requests; the next tick catches up
  inflight = true;
  try {
    const data = await getDelegations(agentId, 50);
    const next = new Map((data.delegations || []).map((d) => [d.id, d]));
    byId = next;
    notify();
  } catch {
    // A failed refresh keeps the last known state: a card that flickers to
    // "unknown" because one poll failed is worse than a slightly stale one.
  } finally {
    inflight = false;
    syncTimer();
  }
}

function anyOpen() {
  return [...byId.values()].some((d) => OPEN.has(d.status));
}

function syncTimer() {
  const wanted = anyOpen();
  if (wanted && !poll) poll = setInterval(() => refresh(), 3000);
  if (!wanted && poll) { clearInterval(poll); poll = null; }
}

export function start() {
  if (timer) return;
  let debounce = null;
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => refresh(), 400);
  };
  timer = subscribeGatewayEvents((record) => {
    const event = String((record && record.event) || "");
    if (event.startsWith("delegation.")) schedule();
  });
  refresh();
}