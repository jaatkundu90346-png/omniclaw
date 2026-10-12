// Approval + question cards. Rendered inside the RUNNING turn, below the
// steps list, above the answer. On settle they are replaced by step rows
// (caller-owned via onSettled). Only Allow/Deny exist — the backend stores
// decision as a free string with no scope semantics (gateway-store.js:475-495),
// so there is deliberately no "Allow for session" button.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { getApprovals, resolveApproval, answerQuestion } from "../api.js";
import { markdownToHtml } from "./thread.js";
import { toast } from "./toast.js";
import { agentChip } from "./agent-chip.js";

// hostEl -> { approvals: Map(id -> handle), questions: Map(id -> handle) }
const registries = new WeakMap();

function regFor(host) {
  let r = registries.get(host);
  if (!r) { r = { approvals: new Map(), questions: new Map() }; registries.set(host, r); }
  return r;
}

function actionLine(type, summary) {
  const t = String(type || "").toLowerCase();
  if (t.includes("shell") || t.includes("exec") || t.includes("command")) return "Run command";
  if (t.includes("edit") || t.includes("write") || t.includes("patch")) return "Edit file";
  if (t.includes("browser")) return "Browser action";
  if (summary) return String(summary).split("\n")[0].slice(0, 80);
  return t ? String(type) : "Approval";
}

export function renderApprovalCard(host, payload, cbs = {}) {
  const reg = regFor(host);
  const approvalId = payload.approvalId || payload.id || "";
  if (!approvalId || reg.approvals.has(approvalId)) return null;

  const card = h("div", { class: "appr-card", role: "alert" });
  const head = h("div", { class: "appr-head" },
    h("span", { html: icons.warn }),
    h("span", { text: "Approval needed" }),
    // WHO is asking. Falls back to "System" for records with no agent.
    agentChip(payload.agentId));
  const body = h("div", { class: "appr-body" }, h("div", { class: "appr-action", text: actionLine(payload.type, payload.summary) }));
  const err = h("div", { class: "appr-error", hidden: true });
  const actions = h("div", { class: "appr-actions" });
  const allowBtn = h("button", { class: "btn primary", type: "button", text: "Allow" });
  const denyBtn = h("button", { class: "btn ghost", type: "button", text: "Deny" });
  actions.append(allowBtn, denyBtn);
  card.append(head, body, err, actions);
  host.append(card);
  allowBtn.focus();

  const handle = {
    id: approvalId,
    settled: false,
    summary: actionLine(payload.type, payload.summary),
    settle(decision) {
      // External settle (approval.resolved event from another client).
      if (handle.settled) return;
      handle.settled = true;
      finish(decision === "approved" ? "approved" : "denied", handle.summary);
    },
    expire() {
      if (handle.settled) return;
      handle.settled = true;
      if (cbs.onSettled) cbs.onSettled("expired", handle.summary);
      card.remove();
    },
  };

  function finish(decision, summary) {
    if (cbs.onSettled) cbs.onSettled(decision, summary);
    card.remove();
  }

  // Enrich with full record (command/path/reason) — same lookup neo does
  // (public/neo.js:1544 GET /api/approvals find by id).
  getApprovals().then((data) => {
    if (handle.settled) return;
    const full = ((data && data.approvals) || []).find((a) => a.id === approvalId);
    if (full && full.status !== "pending") {
      // Already resolved elsewhere before we rendered.
      handle.settle(full.status, "");
      return;
    }
    handle.summary = actionLine(full && full.type, (full && full.summary) || payload.summary);
    const cmd = (full && full.payload && full.payload.command)
      || (full && full.payload && full.payload.path)
      || (full && full.summary) || "";
    const reason = (full && (full.reason || (full.payload && full.payload.reason))) || "";
    body.querySelector(".appr-action").textContent = handle.summary;
    if (cmd) {
      const pre = h("pre", { class: "appr-mono", text: String(cmd).slice(0, 1000) });
      body.append(pre);
    }
    if (reason) body.append(h("div", { class: "appr-reason", text: `Reason: ${reason}` }));
  }).catch(() => {});

  const resolve = async (decision) => {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    allowBtn.innerHTML = "";
    allowBtn.append(h("span", { html: icons.spinner, class: "spin" }));
    try {
      await resolveApproval(approvalId, decision, "");
      if (handle.settled) return;
      handle.settled = true;
      finish(decision, handle.summary);
    } catch (e) {
      allowBtn.disabled = false;
      denyBtn.disabled = false;
      allowBtn.textContent = "Allow";
      err.hidden = false;
      err.textContent = `Resolve failed: ${e.message}`;
      toast(`Approval resolve failed: ${e.message}`, "error");
    }
  };
  allowBtn.addEventListener("click", () => resolve("approved"));
  denyBtn.addEventListener("click", () => resolve("denied"));

  reg.approvals.set(approvalId, handle);
  return handle;
}

export function approvalSettled(host, approvalId, decision) {
  const handle = regFor(host).approvals.get(approvalId);
  if (handle) handle.settle(decision, "");
}

export function approvalExpired(host, ids) {
  const reg = regFor(host);
  if (Array.isArray(ids) && ids.length) {
    for (const id of ids) {
      const handle = reg.approvals.get(id);
      if (handle) handle.expire();
    }
    return;
  }
  // approval.expired_batch carries no ids — re-check statuses.
  getApprovals().then((data) => {
    const expired = ((data && data.approvals) || [])
      .filter((a) => a.status === "expired")
      .map((a) => a.id);
    for (const id of expired) {
      const handle = reg.approvals.get(id);
      if (handle) handle.expire();
    }
  }).catch(() => {});
}

export function renderQuestionCard(host, payload, cbs = {}) {
  const reg = regFor(host);
  const questionId = payload.questionId || "";
  if (!questionId || reg.questions.has(questionId)) return null;

  const card = h("div", { class: "q-card", role: "alert" });
  const head = h("div", { class: "q-head" },
    h("span", { html: icons.message }),
    h("span", { text: "Agent is asking" }),
    // M3: same attribution chip as approvals.
    agentChip(payload.agentId));
  const qtext = h("div", { class: "q-text" });
  try {
    qtext.innerHTML = markdownToHtml(payload.question || "");
    for (const a of qtext.querySelectorAll("a[href]")) { a.target = "_blank"; a.rel = "noopener"; }
  } catch {
    qtext.textContent = payload.question || "";
  }
  const opts = h("div", { class: "q-options", role: "group", "aria-label": "Options" });
  let selected = "";
  for (const opt of Array.isArray(payload.options) ? payload.options : []) {
    const label = typeof opt === "string" ? opt : opt.label || "";
    if (!label) continue;
    const desc = typeof opt === "object" ? opt.description || "" : "";
    const btn = h("button", { class: "q-opt", type: "button", "aria-pressed": "false" },
      h("span", { text: label + ((typeof opt === "object" && opt.recommended) ? " ★" : "") }));
    if (desc) btn.title = desc;
    btn.addEventListener("click", () => {
      selected = selected === label ? "" : label;
      for (const b of opts.querySelectorAll(".q-opt")) {
        const on = b === btn && selected !== "";
        b.classList.toggle("selected", on);
        b.setAttribute("aria-pressed", String(on));
      }
    });
    opts.append(btn);
  }
  const row = h("div", { class: "q-row" });
  const input = h("input", { type: "text", placeholder: "Type your answer…", "aria-label": "Your answer" });
  const send = h("button", { class: "btn primary", type: "button", text: "Send" });
  row.append(input, send);
  const err = h("div", { class: "appr-error", hidden: true });
  card.append(head, qtext, opts, row, err);
  host.append(card);
  (opts.querySelector(".q-opt") || input).focus();

  const handle = {
    id: questionId,
    settled: false,
    settle(answerText) {
      if (handle.settled) return;
      handle.settled = true;
      if (cbs.onSettled) cbs.onSettled(answerText || "");
      card.remove();
    },
    timeout() {
      if (handle.settled) return;
      handle.settled = true;
      if (cbs.onTimeout) cbs.onTimeout();
      card.remove();
    },
  };

  const submit = async () => {
    const answer = input.value.trim() || selected;
    if (!answer) return;
    for (const el of card.querySelectorAll("button, input")) el.disabled = true;
    try {
      await answerQuestion(questionId, answer);
      handle.settle(answer);
    } catch (e) {
      for (const el of card.querySelectorAll("button, input")) el.disabled = false;
      err.hidden = false;
      err.textContent = `Answer failed: ${e.message}`;
      toast(`Answer failed: ${e.message}`, "error");
    }
  };
  send.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  reg.questions.set(questionId, handle);
  return handle;
}

export function questionSettled(host, questionId, text) {
  const handle = regFor(host).questions.get(questionId);
  if (handle) handle.settle(text || "");
}

export function questionTimeout(host, questionId) {
  const handle = regFor(host).questions.get(questionId);
  if (handle) handle.timeout();
}

export function clearCards(host) {
  registries.delete(host);
}
