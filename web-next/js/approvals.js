// Global pending-approval + question store (4B.1) — approvals must be
// impossible to miss, so they are GLOBAL (not per-thread).
//
// Sources (in order of freshness):
//   1. persistent GET /api/events subscription (sse.js subscribeGatewayEvents,
//      backend fan-out is unfiltered: server.js agent.gateway.onEvent(
//      broadcastEvent)) — filtered HERE to approval.* + run.question* only.
//   2. GET /api/approvals?status=pending (backend: server.js:1786) on boot,
//      on visibilitychange, on reconnect, and every 5s while any run is active
//      anywhere (any session with activeRunId, or a recent local poke).
//   3. live chat-stream records, handed to ingestRecord by the thread.
//
// Thread cards hydrate from THIS store, so a thread opened mid-run or after a
// reload still shows its cards. Live-turn cards (thread.js) dedupe against the
// store via has/adoptLive/releaseLive — exactly one home per card.
// Questions ride the same store from events; the server keeps no question
// list, so questions cannot hydrate after a reload (documented gap).

import { h } from "./utils/dom.js";
import { store, isSessionRunning } from "./store.js";
import { getApprovals, resolveApproval, answerQuestion, getPendingQuestions } from "./api.js";
import { subscribeGatewayEvents } from "./sse.js";
import { renderApprovalCard, renderQuestionCard } from "./ui/cards.js";
import { sessionTitle } from "./ui/sidebar.js";
import { toast } from "./ui/toast.js";

const POLL_MS = 5000;
const FALLBACK_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

const approvals = new Map(); // id -> {id,type,tool,summary,command,sessionId,runId,createdAt,expiresAt}
const questions = new Map(); // questionId -> {questionId,question,options,allowOther,runId,sessionId,arrivedAt}
const adopted = new Map(); // id -> liveToken (card rendered in a live turn; tray skips it)
const owned = new Map(); // liveToken -> Set(id)
const listeners = new Set();

let eventsSub = null;
let pollTimer = null;
let tickTimer = null;
let lastPoke = 0;
let baseTitle = "OmniClaw Next";
let bannerCtl = null;

function toolTimeoutMs() {
  const caps = store.get().caps || {};
  const v = Number(caps.approvalToolTimeoutMs);
  return Number.isFinite(v) && v > 0 ? v : FALLBACK_TOOL_TIMEOUT_MS;
}

// Effective user deadline: the tool gives up after its own wait even if the
// server keeps the approval pending longer (tool-registry.js
// awaitShellApproval/ask_user vs 30-min sweeper).
export function effectiveDeadline(item) {
  const created = Date.parse(item.createdAt || item.arrivedAt || "") || Date.now();
  const toolEnd = created + toolTimeoutMs();
  const exp = Date.parse(item.expiresAt || "") || Infinity;
  return Math.min(toolEnd, exp);
}

export function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "time up";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  if (m <= 0) return `${s}s`;
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function snapshot() {
  const bySession = {};
  for (const a of approvals.values()) {
    const k = a.sessionId || "";
    bySession[k] = (bySession[k] || 0) + 1;
  }
  for (const q of questions.values()) {
    const k = q.sessionId || "";
    bySession[k] = (bySession[k] || 0) + 1;
  }
  return {
    count: approvals.size,
    qcount: questions.size,
    bySession,
    updated: Date.now(),
  };
}

function emit(removed) {
  try {
    store.set({ appr: snapshot() });
  } catch {}
  updateTitle();
  for (const fn of listeners) {
    try { fn({ approvals, questions, removed: removed || [] }); } catch (e) { console.error(e); }
  }
  if (bannerCtl) bannerCtl.paint();
  armTick();
}

export function subscribeApprovals(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function updateTitle() {
  const n = approvals.size + questions.size;
  try {
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
  } catch {}
}

// --- ingestion -------------------------------------------------------------

function normApproval(p) {
  const id = p.approvalId || p.id || "";
  if (!id) return null;
  return {
    id,
    type: p.type || "",
    tool: p.tool || "",
    summary: p.summary || "",
    // M3: who is asking (stamped server-side). Absent on pre-M3 records and on
    // POST /api/tools/run approvals -> the chip renders "System".
    agentId: p.agentId || null,
    command: p.command || (p.payload && (p.payload.command || p.payload.path)) || "",
    sessionId: p.sessionId || "",
    runId: p.runId || "",
    createdAt: p.createdAt || new Date().toISOString(),
    expiresAt: p.expiresAt || "",
  };
}

export function ingestApproval(payload, source = "event") {
  const item = normApproval(payload || {});
  if (!item) return null;
  if (!approvals.has(item.id)) {
    const prev = approvals.get(item.id);
    approvals.set(item.id, { ...(prev || {}), ...item, source });
    emit();
  } else {
    // Enrich thin event records with poll fields (summary/command/expiresAt).
    const merged = { ...approvals.get(item.id) };
    let changed = false;
    for (const k of ["summary", "command", "tool", "type", "expiresAt", "createdAt", "sessionId", "runId"]) {
      if (!merged[k] && item[k]) { merged[k] = item[k]; changed = true; }
    }
    if (changed) { approvals.set(item.id, merged); emit(); }
  }
  return item.id;
}

export function removeApproval(id, decision = "") {
  if (!approvals.has(id)) return false;
  approvals.delete(id);
  for (const [, set] of owned) set.delete(id);
  adopted.delete(id);
  emit([{ kind: "approval", id, decision }]);
  return true;
}

export function ingestQuestion(payload, source = "event") {
  const qid = payload.questionId || payload.id || "";
  if (!qid) return null;
  if (!questions.has(qid)) {
    questions.set(qid, {
      questionId: qid,
      question: payload.question || payload.text || "",
      // M3: same attribution as approvals.
      agentId: payload.agentId || null,
      options: Array.isArray(payload.options) ? payload.options : [],
      allowOther: payload.allowOther !== false,
      runId: payload.runId || "",
      sessionId: payload.sessionId || "",
      arrivedAt: new Date().toISOString(),
      createdAt: payload.createdAt || "",
      expiresAt: payload.expiresAt || "",
      source,
    });
    emit();
  } else if (source === "poll") {
    // Enrich event records with server fields (createdAt/expiresAt).
    const merged = { ...questions.get(qid) };
    let changed = false;
    for (const k of ["question", "text", "createdAt", "expiresAt", "sessionId", "runId"]) {
      const v = k === "question" ? (payload.question || payload.text) : payload[k];
      if (k === "question" ? !merged.question && v : !merged[k] && v) {
        if (k === "question") merged.question = v; else merged[k] = v;
        changed = true;
      }
    }
    if (changed) { questions.set(qid, merged); emit(); }
  }
  return qid;
}

export function removeQuestion(qid, info = {}) {
  if (!questions.has(qid)) return false;
  questions.delete(qid);
  for (const [, set] of owned) set.delete(qid);
  adopted.delete(qid);
  emit([{ kind: "question", id: qid, ...info }]);
  return true;
}

// Live-turn dedupe: has() → thread skips its own card (tray owns it);
// adoptLive() → tray skips it (live turn owns it). Released on settle,
// thread destroy, or store removal.
export function hasPending(id) {
  return approvals.has(id) || questions.has(id);
}

export function adoptLive(id, token) {
  if (!id || !token) return;
  adopted.set(id, token);
  let set = owned.get(token);
  if (!set) { set = new Set(); owned.set(token, set); }
  set.add(id);
}

export function releaseLive(token) {
  const set = owned.get(token);
  if (!set) return;
  for (const id of set) {
    if (adopted.get(id) === token) adopted.delete(id);
  }
  owned.delete(token);
}

export function pendingForSession(sessionId) {
  const list = [...approvals.values()].filter((a) => (a.sessionId || "") === (sessionId || ""));
  const qs = [...questions.values()].filter((q) => (q.sessionId || "") === (sessionId || ""));
  const byTime = (x, y) => Date.parse(x.createdAt || x.arrivedAt || 0) - Date.parse(y.createdAt || y.arrivedAt || 0);
  list.sort(byTime);
  qs.sort(byTime);
  return { approvals: list, questions: qs };
}

// --- backend polling --------------------------------------------------------

export async function refresh() {
  let list = [];
  try {
    const data = await getApprovals("pending");
    list = (data && data.approvals) || [];
  } catch {
    return;
  }
  const seen = new Set();
  for (const raw of list) {
    const id = ingestApproval(raw, "poll");
    if (id) seen.add(id);
  }
  // Removals need a status lookup (poll lists pending only): one extra fetch,
  // only when something vanished silently (missed events).
  const gone = [...approvals.keys()].filter((id) => !seen.has(id));
  if (gone.length) {
    let full = [];
    try {
      const data = await getApprovals("");
      full = (data && data.approvals) || [];
    } catch { full = []; }
    const byId = new Map(full.map((a) => [(a.id || a.approvalId), a]));
    for (const id of gone) {
      const rec = byId.get(id);
      if (!rec) { removeApproval(id, "unknown"); continue; }
      if (rec.status && rec.status !== "pending") removeApproval(id, rec.status);
    }
  }
  // Q1: questions hydrate the same way (server 404 on old builds → keep
  // event-driven behavior, skip reconcile).
  const qdata = await getPendingQuestions();
  if (qdata) {
    const qseen = new Set();
    for (const raw of qdata.questions || []) {
      const qid = ingestQuestion(raw, "poll");
      if (qid) qseen.add(qid);
    }
    for (const qid of [...questions.keys()]) {
      if (!qseen.has(qid) && !adopted.has(qid)) removeQuestion(qid, { timedOut: true });
    }
  }
  pokeTick();
}

function anyActiveRun() {
  try {
    return (store.get().sessions || []).some(isSessionRunning);
  } catch { return false; }
}

export function pokeActivity() {
  lastPoke = Date.now();
}

function armPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (anyActiveRun() || Date.now() - lastPoke < 15000) refresh().catch(() => {});
  }, POLL_MS);
}

function pokeTick() {
  armTick();
}

function armTick() {
  const need = approvals.size + questions.size > 0;
  if (need && !tickTimer) {
    tickTimer = setInterval(() => {
      if (bannerCtl) bannerCtl.tick();
      document.querySelectorAll("[data-appr-deadline]").forEach((el) => {
        const t = Number(el.dataset.apprDeadline || 0);
        if (t) el.textContent = formatCountdown(t - Date.now());
      });
      if (approvals.size + questions.size === 0 && tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }, 1000);
  } else if (!need && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// --- gateway record intake ---------------------------------------------------

const INTEREST = /^(approval\.|run\.question)/;

export function ingestRecord(record) {
  const name = record.event || "";
  if (!INTEREST.test(name)) return;
  const p = record.payload || {};
  switch (name) {
    case "approval.requested":
      ingestApproval(p, "event");
      pokeActivity();
      break;
    case "approval.resolved":
      removeApproval(p.approvalId, p.decision || "");
      break;
    case "approval.expired":
      for (const id of p.approvalIds || p.ids || (p.approvalId ? [p.approvalId] : [])) {
        removeApproval(id, "expired");
      }
      break;
    case "approval.expired_batch":
    case "approval.auto_expired":
      refresh().catch(() => {});
      break;
    case "run.question":
      ingestQuestion(p);
      pokeActivity();
      break;
    case "run.question_answered":
      removeQuestion(p.questionId, { answered: true });
      break;
    case "run.question_timeout":
      removeQuestion(p.questionId, { timedOut: true });
      break;
    default:
      break;
  }
}

export function initApprovals() {
  try {
    baseTitle = String(document.title || "OmniClaw Next").replace(/^\(\d+\)\s+/, "");
  } catch {}
  refresh().catch(() => {});
  armPoll();
  if (!eventsSub) {
    eventsSub = subscribeGatewayEvents(ingestRecord);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh().catch(() => {});
  });
}

// --- banner ------------------------------------------------------------------

function newestItem() {
  let best = null;
  let bestAt = -1;
  for (const a of approvals.values()) {
    const t = Date.parse(a.createdAt || 0) || 0;
    if (t >= bestAt) { bestAt = t; best = { kind: "approval", ...a }; }
  }
  if (best) return best;
  for (const q of questions.values()) {
    const t = Date.parse(q.arrivedAt || 0) || 0;
    if (t >= bestAt) { bestAt = t; best = { kind: "question", ...q }; }
  }
  return best;
}

function sessionName(sid) {
  const s = (store.get().sessions || []).find((x) => x.id === sid);
  if (!s) return "another chat";
  try { return sessionTitle(s); } catch { return s.label || "another chat"; }
}

export function mountApprovalBanner(host) {
  host.innerHTML = "";
  const bar = h("div", { class: "appr-banner", hidden: true });
  const icon = h("span", { class: "appr-banner-ic", text: "⚠" });
  const text = h("span", { class: "appr-banner-tx" });
  const time = h("span", { class: "appr-banner-time" });
  const review = h("button", { class: "mini-btn", type: "button", text: "Review" });
  const allow = h("button", { class: "mini-btn primary", type: "button", text: "Allow" });
  const deny = h("button", { class: "mini-btn", type: "button", text: "Deny" });
  bar.append(icon, text, time, review, allow, deny);
  host.append(bar);

  let currentId = "";
  let busy = false;

  function scrollToTray() {
    // The thread mounts async (history fetch); retry briefly.
    const t0 = Date.now();
    const tryScroll = () => {
      const el = document.getElementById("pending-tray");
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "smooth" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 1600);
        return;
      }
      if (Date.now() - t0 < 6000) setTimeout(tryScroll, 400);
    };
    tryScroll();
  }

  review.addEventListener("click", () => {
    const item = newestItem();
    if (!item || !item.sessionId) return;
    const target = `#/t/${encodeURIComponent(item.sessionId)}`;
    if (window.location.hash !== target) window.location.hash = target;
    scrollToTray();
  });

  async function resolve(decision) {
    const item = newestItem();
    if (!item || item.kind !== "approval" || busy) return;
    busy = true;
    allow.disabled = true;
    deny.disabled = true;
    try {
      await resolveApproval(item.id, decision, "");
      toast(decision === "approved" ? "Approved — command runs" : "Denied", decision === "approved" ? "success" : "error");
    } catch (e) {
      toast(`Resolve failed: ${e.message}`, "error");
      busy = false;
      allow.disabled = false;
      deny.disabled = false;
    }
  }
  allow.addEventListener("click", () => resolve("approved"));
  deny.addEventListener("click", () => resolve("denied"));

  function paint() {
    const item = newestItem();
    const total = approvals.size + questions.size;
    if (!item) {
      bar.hidden = true;
      host.hidden = true;
      currentId = "";
      return;
    }
    bar.hidden = false;
    host.hidden = false;
    currentId = item.kind === "approval" ? item.id : item.questionId;
    const extra = total > 1 ? ` (+${total - 1} more)` : "";
    if (item.kind === "approval") {
      const label = item.summary || item.command || item.type || "approval";
      text.textContent = `1 approval waiting in ${sessionName(item.sessionId)}: ${label}${extra}`;
      allow.hidden = false;
      deny.hidden = false;
      if (!busy) { allow.disabled = false; deny.disabled = false; }
    } else {
      text.textContent = `Agent asked a question in ${sessionName(item.sessionId)}${extra}`;
      allow.hidden = true;
      deny.hidden = true;
    }
    tick();
  }

  function tick() {
    const item = newestItem();
    if (!item) return;
    const id = item.kind === "approval" ? item.id : item.questionId;
    if (id !== currentId) { paint(); return; }
    // Q1: server questions carry createdAt/expiresAt, so the shared deadline
    // covers both kinds (tool wait vs server expiry, whichever is shorter).
    const dl = effectiveDeadline(item);
    time.textContent = formatCountdown(dl - Date.now());
    time.title = item.kind === "approval"
      ? "Time left to answer (tool wait vs approval expiry, whichever is shorter)"
      : "Time left to answer (5-minute question wait)";
  }

  bannerCtl = { paint, tick };
  subscribeApprovals(paint);
  // Sessions arrive after the approvals snapshot on reload — repaint names then.
  // paint() never writes the store, so this cannot loop.
  try {
    store.subscribe(() => { if (newestItem()) paint(); });
  } catch {}
  paint();
  return {
    paint,
    unmount() {
      if (bannerCtl && bannerCtl.paint === paint) bannerCtl = null;
      host.innerHTML = "";
    },
  };
}

// --- per-thread pending tray ---------------------------------------------------

// Renders this session's pending cards ABOVE the transcript (top of view), so
// mid-run opens and reloads show them. Live-turn cards dedupe via adoptLive.
export function renderPendingTray(container, sessionId, hooks = {}) {
  container.innerHTML = "";
  // ADD, never assign. The host is created as `.pending-tray-host` and its one
  // stylesheet rule — `.pending-tray-host:empty { display: none }` — is what
  // hides the empty tray. Assigning className here replaced that class, so the
  // rule could never match again and the wrapper was left with no styles at all.
  container.classList.add("pending-tray-wrap");
  const render = () => {
    if (!container.isConnected) return;
    const { approvals: list, questions: qs } = pendingForSession(sessionId);
    const items = [
      ...list.filter((a) => !adopted.has(a.id)).map((a) => ({ kind: "approval", item: a })),
      ...qs.filter((q) => !adopted.has(q.questionId)).map((q) => ({ kind: "question", item: q })),
    ];
    container.innerHTML = "";
    try { hooks.onTrayCount && hooks.onTrayCount(items.length); } catch {}
    if (!items.length) {
      container.removeAttribute("id");
      return;
    }
    container.id = "pending-tray";
    const head = h("div", { class: "pending-tray-head", text: `Waiting for your approval (${items.length})` });
    container.append(head);
    for (const { kind, item } of items) {
      const row = h("div", { class: "pending-tray-row" });
      const dl = effectiveDeadline(item);
      const cd = h("div", { class: "pending-tray-cd" });
      const cdTime = h("span", {
        text: formatCountdown(dl - Date.now()),
        title: "Time left to answer",
      });
      cdTime.dataset.apprDeadline = String(dl);
      cd.append(cdTime);
      const host = h("div", { class: "pending-tray-cards" });
      row.append(cd, host);
      container.append(row);
      if (kind === "approval") {
        renderApprovalCard(host, item, {
          onSettled: (decision, summary) => {
            try { hooks.onSettled && hooks.onSettled(decision, summary, "approval", item.id); } catch {}
          },
        });
      } else {
        renderQuestionCard(host, item, {
          onSettled: (answer) => {
            try { hooks.onSettled && hooks.onSettled(answer, answer, "question", item.questionId); } catch {}
          },
          onTimeout: () => {
            try { hooks.onSettled && hooks.onSettled("", "", "question-timeout", item.questionId); } catch {}
          },
        });
      }
    }
  };
  const off = subscribeApprovals(render);
  render();
  return {
    update: render,
    unmount: () => {
      off();
      container.innerHTML = "";
      try { hooks.onTrayCount && hooks.onTrayCount(0); } catch {}
    },
  };
}
