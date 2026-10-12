// Thread renderer: history + live streaming into the same turn model.
// Incremental DOM only — NEVER re-render the whole list per token.
// Event names: docs/STREAM_EVENTS.md ONLY.

import { streamChat } from "../sse.js";
import { getSession, stopRun, steerRun, getPromptTrace } from "../api.js";
import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { middleEllipsis, display } from "../utils/path.js";
import {
  renderApprovalCard, renderQuestionCard,
  approvalSettled, approvalExpired, questionSettled, questionTimeout,
} from "./cards.js";
import { mountDelegationCard } from "./delegation-card.js";
import {
  hasPending, adoptLive, releaseLive, removeApproval, removeQuestion,
  renderPendingTray, subscribeApprovals, pokeActivity, refresh as refreshApprovals,
} from "../approvals.js";
import { toast } from "./toast.js";

// Port of neo.js:730 (also :615): chat-MM-DD-HH-mm, UTC via toISOString.
export function generateLabel(date = new Date()) {
  return `chat-${date.toISOString().slice(5, 16).replace(/[T:]/g, "-")}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Fallback when vendor libs are absent (vendored marked 12.0.0 + DOMPurify 3.1.6
// are the real path; this is belt-and-braces, same grammar as neo.js:92-107).
export function basicMarkdown(text) {
  const blocks = [];
  let src = String(text || "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
    return `\u0000${blocks.length - 1}\u0000`;
  });
  src = esc(src)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^#{1,4} (.+)$/gm, "<strong>$1</strong>")
    .replace(/^[-*] (.+)$/gm, "&bull; $1")
    .replace(/\n/g, "<br/>");
  return {
    html: src.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const b = blocks[Number(i)];
      return `<pre><code class="language-${esc(b.lang)}">${esc(b.code)}</code></pre>`;
    }),
    codes: blocks,
  };
}

export function markdownToHtml(md) {
  const text = String(md || "");
  if (!text.trim()) return "";
  if (window.marked && window.DOMPurify) {
    try {
      return window.DOMPurify.sanitize(window.marked.parse(text), { ADD_ATTR: ["target", "rel"] });
    } catch (e) {
      console.warn("marked failed, fallback renderer", e);
    }
  }
  return window.DOMPurify
    ? window.DOMPurify.sanitize(basicMarkdown(text).html, { ADD_ATTR: ["target", "rel"] })
    : basicMarkdown(text).html;
}

function renderAnswerHtml(turn) {
  return markdownToHtml(turn.answerMd);
}

function postProcessAnswer(div) {
  for (const a of div.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  for (const pre of div.querySelectorAll("pre")) {
    if (pre.parentElement && pre.parentElement.classList.contains("codeblock")) continue;
    const code = pre.querySelector("code");
    const m = code && code.className.match(/language-(\S+)/);
    const lang = m ? m[1] : "";
    const wrap = document.createElement("div");
    wrap.className = "codeblock";
    const head = document.createElement("div");
    head.className = "codeblock-head";
    const lab = document.createElement("span");
    lab.className = "lang";
    lab.textContent = lang || "code";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      } catch {}
    });
    head.append(lab, copy);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

// Human tool names (spec §2).
const HUMAN_TOOL = new Map([
  ["read_computer_file", "Read"], ["read_file", "Read"],
  ["write_computer_file", "Wrote"], ["write_file", "Wrote"],
  ["edit_file", "Edited"], ["edit", "Edited"], ["multi_edit", "Edited"],
  ["list_computer_directory", "Listed"], ["list_directory", "Listed"], ["list", "Listed"],
  ["run_command", "Ran"], ["run_shell_command", "Ran"], ["shell", "Ran"], ["exec", "Ran"],
  ["web_search", "Searched the web for"], ["search_web", "Searched the web for"],
]);

function humanTool(name) {
  if (HUMAN_TOOL.has(name)) return HUMAN_TOOL.get(name);
  return String(name || "tool");
}

// S2 icons per kind.
const KIND_ICON = {
  thinking: "sparkles", read: "fileSearch", edit: "pencil", exec: "terminal",
  list: "folder", search: "globe", screenshot: "image", note: "info", tool: "wrench",
};

function trunc(s, n) {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Summaries that already carry a verb ("Wrote 138 bytes…", "Tool blocked…").
const VERBED_LEAD = /^(wrote|written|listed|list|read|reading|ran|running|created|updated|deleted|opened|found|searched|searching|edited|tool|failed|blocked|ok|completed|finished)\b/i;

// S1 title guard: a runId/sessionId/call id must NEVER appear in a step title,
// and empty titles never render. Warn once so regressions are visible.
let warnedTitle = false;
function guardTitle(tool, title) {
  const t = String(title || "").trim().replace(/\s+/g, " ");
  if (!t || /^(run|session)_/i.test(t)) {
    if (!warnedTitle) {
      warnedTitle = true;
      console.warn("thread: dropped id-ish step title", JSON.stringify(t.slice(0, 80)));
    }
    return humanTool(tool);
  }
  return t;
}

// S1: title source is ONLY explicit path/cmd/query fields — never a scan over
// arbitrary payload values (that leak runId/sessionId: the "Edited run_…" bug).
function pickArg(input, payload = {}) {
  const o = (input && typeof input === "object") ? input : {};
  const v = o.path ?? o.file ?? o.command ?? o.cmd ?? o.query ?? o.q ?? o.url
    ?? payload.path ?? payload.command ?? payload.url ?? "";
  const s = String(v ?? "").trim();
  if (!s || /^(run|session)_/i.test(s)) return "";
  return s;
}

function countLines(s) {
  const t = String(s ?? "");
  if (!t) return 0;
  return t.split("\n").length;
}

// T1: normalize both sides before matching transient ↔ started rows.
function normPath(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "").trim();
}

function normCmd(c) {
  return String(c || "").trim().replace(/\s+/g, " ");
}

// T4: every DISPLAYED path goes through display() (backslashes on Windows).
// Tooltip (full) too. URLs (scheme://) are NOT paths — keep them raw.
function isUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || ""));
}

function dispPath(p, max = 48) {
  const s = String(p || "");
  if (isUrl(s)) return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return middleEllipsis(display(s), max);
}

function fullPath(p) {
  const s = String(p || "");
  return isUrl(s) ? s : display(s);
}

// Started-line titles: Read/Wrote/Edited/Listed/Ran/Searched… + path/cmd/query.
// Returns {title, full} (full = tooltip). Write tools get "+N lines" from input.
function startedTitle(tool, input, payload) {
  const human = humanTool(tool);
  const arg = pickArg(input, payload);
  if (!arg) return { title: human, full: human };
  if (/search/i.test(tool)) return { title: `${human} "${trunc(arg, 60)}"`, full: arg };
  if (/exec|run|shell|command/i.test(tool) || (payload && payload.command)) {
    return { title: `${human} ${trunc(arg, 60)}`, full: arg };
  }
  if (/writ|edit|patch|append/i.test(tool) && input && typeof input === "object"
    && (input.content != null || input.patch != null)) {
    const n = countLines(input.content ?? input.patch);
    return { title: `${human} ${dispPath(arg)}${n ? ` +${n}` : ""}`, full: fullPath(arg) };
  }
  return { title: `${human} ${dispPath(arg)}`, full: fullPath(arg) };
}

function diffStat(diff) {
  let a = 0, d = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) a++;
    else if (line.startsWith("-")) d++;
  }
  return { a, d };
}

  function summarizeForTerminal(p) {
    const s = p.outputSummary || p.preview || p.resultPreview || "";
    return String(s || "").slice(0, 4000);
  }

  function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function mountThread(container, opts = {}) {
  const { sessionId = "", agentId = "main", onSession, onRunState, onCardsPending, onStepOpen } = opts;
  const view = container;
  // 4B.1: pending tray ABOVE the transcript — hydrates from the global store
  // (mid-run opens + reloads), independent of live SSE.
  const trayWrap = h("div", { class: "pending-tray-host" });
  const root = h("div", { class: "thread", role: "log", "aria-label": "Thread" });
  view.innerHTML = "";
  view.append(trayWrap, root);
  const liveToken = {};
  let trayCtl = null;
  let trayCount = 0;

  const jumpPill = h("button", { class: "jump-pill", type: "button", text: "↓ Jump to latest", hidden: true });
  view.append(jumpPill);
  let stick = true;
  const updateStick = () => {
    stick = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
    jumpPill.hidden = stick;
  };
  view.addEventListener("scroll", updateStick, { passive: true });
  jumpPill.addEventListener("click", () => {
    view.scrollTop = view.scrollHeight;
    updateStick();
  });
  const maybeStick = () => { if (stick) view.scrollTop = view.scrollHeight; };

  const turns = [];
  let seq = 0;
  let liveAbort = null;
  let liveRunId = "";
  let liveTurn = null;
  let liveES = null;
  let destroyed = false;
  let pendingCards = 0;

  const setRunning = (r) => { onRunState && onRunState(r); };
  // 4B.1: composer pulse = live cards + pending-tray cards.
  const emitCards = () => { onCardsPending && onCardsPending(pendingCards + trayCount); };
  const bumpCards = (d) => {
    pendingCards = Math.max(0, pendingCards + d);
    emitCards();
  };

  // 4B.1: tray cards settle step rows on the live turn when one is running.
  function traySettled(kind, decision, summary) {
    const target = (liveTurn && liveTurn.status === "running") ? liveTurn : null;
    if (!target) return;
    if (kind === "approval") {
      settleApprovalRow(target, decision, summary);
    } else if (kind === "question") {
      settleAnswerRow(target, summary, false);
    } else {
      settleAnswerRow(target, "", true);
    }
    if (target.status === "running") setStage(target, "WORKING");
  }

  function bindTray(sid) {
    try { trayCtl && trayCtl.unmount(); } catch {}
    trayCtl = renderPendingTray(trayWrap, sid || "", {
      onSettled: (decision, summary, kind) => traySettled(kind, decision, summary),
      onTrayCount: (n) => { trayCount = n; emitCards(); },
    });
  }
  bindTray(sessionId);

  // 4B.1: silent removals (poll/reconnect reconcile) settle live cards too.
  const apprOff = subscribeApprovals(({ removed }) => {
    if (destroyed || !removed || !removed.length) return;
    for (const turn of turns) {
      if (!turn.els || !turn.els.cards) continue;
      for (const r of removed) {
        if (r.kind === "approval") {
          if (r.decision === "expired") approvalExpired(turn.els.cards, [r.id]);
          else approvalSettled(turn.els.cards, r.id, r.decision);
        } else if (r.kind === "question") {
          if (r.timedOut) questionTimeout(turn.els.cards, r.id);
          else questionSettled(turn.els.cards, r.id, "");
        }
      }
    }
  });

  // S4: finished headers carry step + failure counts.
  function headerTextFor(ms, stepsEl) {
    const secs = fmtElapsed(ms);
    const rows = stepsEl ? stepsEl.children.length : 0;
    const failed = stepsEl ? stepsEl.querySelectorAll(".s-st .st-fail").length : 0;
    return { secs, tail: rows ? ` · ${rows} step${rows === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}` : "" };
  }

  function ctxMeterSuffix(turn) {
    const c = turn.liveCtx;
    if (!c || !c.windowTokens) return "";
    const usedK = (c.tokensUsed / 1000).toFixed(1);
    const winK = (c.windowTokens / 1000).toFixed(0);
    return ` · ctx ${usedK}k/${winK}k (${c.percentFull}%) · r${c.roundsUsed}·t${c.toolsPerRound}`;
  }

  function headerText(turn) {
    const ms = (turn.endedAt || Date.now()) - turn.startedAt;
    const meter = ctxMeterSuffix(turn);
    if (turn.status === "running") return `Working for ${fmtElapsed(ms)} · ${turn.stage}${meter}`;
    const { secs, tail } = headerTextFor(ms, turn.els.steps);
    if (turn.status === "stopped") return `Stopped after ${secs}${tail}${meter}`;
    if (turn.status === "error") return `Failed after ${secs}${tail}${meter}`;
    return `Worked for ${secs} ▸${tail}${meter}`;
  }

  function detailText(raw) {
    const str = typeof raw === "string" ? raw : JSON.stringify(raw, null, 1);
    return String(str).slice(0, 4000);
  }

  function paintHead(turn) {
    turn.els.head.querySelector(".ht").textContent = headerText(turn);
    const open = turn.status === "running" ? !turn.collapsedManual : !turn.collapsedDone;
    turn.els.steps.classList.toggle("collapsed", !open);
  }

  function newAssistantTurn() {
    const turn = {
      id: `t${++seq}`, role: "assistant", startedAt: Date.now(), endedAt: 0,
      stage: "Planning", openSteps: new Map(), lastClosed: new Map(),
      thinking: null, answerMd: "", status: "running", error: "",
      collapsedManual: false, collapsedDone: true, model: "",
      meta: null, // T2.1: {budget?, menu?, runId?} from final packet / history
      ctxOpen: false,
      subagents: new Map(), // Part C: subagentId -> child card state
      subagentsOpen: true,
    };
    const el = h("div", { class: "turn-assistant" });
    const head = h("button", { class: "turn-head", type: "button" }, h("span", { class: "ht", text: "" }));
    const ctx = h("div", { class: "turn-ctx", hidden: true });
    const steps = h("ul", { class: "turn-steps" });
    const subagents = h("div", { class: "turn-subagents", hidden: true });
    const cards = h("div", { class: "turn-cards" });
    const answer = h("div", { class: "answer" });
    head.addEventListener("click", () => {
      if (turn.status === "running") turn.collapsedManual = !turn.collapsedManual;
      else turn.collapsedDone = !turn.collapsedDone;
      paintHead(turn);
    });
    el.append(head, ctx, steps, subagents, cards, answer);
    turn.els = { el, head, ctx, steps, subagents, cards, answer };
    turn.renderQueued = false;
    turn.lastRender = 0;
    turns.push(turn);
    root.append(el);
    paintHead(turn);
    return turn;
  }

  function pushUser(text, attachments) {
    const turn = { id: `t${++seq}`, role: "user", text };
    const el = h("div", { class: "turn-user" }, h("div", { class: "user-bubble", text }));
    turn.els = { el };
    turns.push(turn);
    root.append(el);
    maybeStick();
    return turn;
  }

  // T5: round/text segmentation — each round's narration renders as its own
  // paragraph instead of gluing to the previous round's last line.
  function segmentAnswer(turn) {
    if (turn.answerMd && !turn.answerMd.endsWith("\n\n")) {
      turn.answerMd += "\n\n";
      scheduleAnswer(turn);
    }
  }

  function normWs(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  // Incremental answer render, ~30fps max.
  function scheduleAnswer(turn) {
    if (turn.renderQueued) return;
    turn.renderQueued = true;
    const wait = Math.max(0, 33 - (performance.now() - turn.lastRender));
    setTimeout(() => {
      requestAnimationFrame(() => {
        turn.renderQueued = false;
        if (destroyed) return;
        turn.lastRender = performance.now();
        turn.els.answer.innerHTML = renderAnswerHtml(turn);
        postProcessAnswer(turn.els.answer);
        maybeStick();
      });
    }, wait);
  }

  // ── S1+S2 step system: ONE step per tool call, grid rows, inline Details. ──
  // Correlation (S0): no toolCallId exists anywhere. Key = tool name + `step`
  // counter (agent-loop-controller.js:96-135 sets the same `step` on started →
  // output → completed); FIFO fallback when step is absent (legacy emitters).
  let stepSeq = 0;

  function openList(turn, tool) {
    let arr = turn.openSteps.get(tool);
    if (!arr) { arr = []; turn.openSteps.set(tool, arr); }
    return arr;
  }

  // Phase 4 §1: toolCallId is the primary key (B1). Legacy fallback chain
  // (no id on old events/transcripts): loop `step` counter, then FIFO.
  function stepByCallId(turn, tool, callId) {
    if (!callId) return null;
    const arr = turn.openSteps.get(tool) || [];
    return arr.find((r) => r.callId === callId) || null;
  }

  function findStep(turn, tool, callStep, callId) {
    return stepByCallId(turn, tool, callId)
      || (() => {
        const arr = turn.openSteps.get(tool) || [];
        if (callStep != null && callStep !== "") {
          const exact = arr.find((r) => r.callStep === callStep);
          if (exact) return exact;
        }
        return arr[0] || null;
      })();
  }

  function closeStep(turn, rec) {
    const arr = turn.openSteps.get(rec.tool) || [];
    const i = arr.indexOf(rec);
    if (i !== -1) arr.splice(i, 1);
    turn.lastClosed.set(rec.tool, rec);
  }

  // Render step detail: colored diff when the payload is a diff, else plain pre.
// Diff shapes we emit: buildEditDiff ("- a\\n+ b"), multi_edit ("# edit …\\n- a\\n+ b"),
// write_file (all "+line"), unified ("@@ -n +n @@").
function looksLikeDiff(text) {
  const s = String(text || "");
  if (!s) return false;
  if (s.includes("@@ -")) return true;
  let plus = 0;
  let minus = 0;
  for (const line of s.split("\n").slice(0, 80)) {
    if (line.startsWith("+") || line.startsWith("+ ")) plus += 1;
    else if (line.startsWith("-") || line.startsWith("- ")) minus += 1;
  }
  return (plus + minus) >= 2 && (plus + minus) >= Math.min(2, s.split("\n").length);
}

function renderDiffDetail(text) {
  const s = String(text || "").slice(0, 4000);
  const box = h("div", { class: "step-diff" });
  let oldN = 0;
  let newN = 0;
  let head = "";
  for (const raw of s.split("\n")) {
    const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      head = raw;
      oldN = Number(m[1]);
      newN = Number(m[2]);
      box.append(h("div", { class: "hunk-head", text: head }));
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("# ")) {
      box.append(h("div", { class: "hunk-head", text: raw.slice(2) }));
      continue;
    }
    let t = "";
    let line = raw;
    if (raw.startsWith("+")) { t = "add"; line = raw.slice(1).replace(/^ /, ""); newN += 1; }
    else if (raw.startsWith("-")) { t = "del"; line = raw.slice(1).replace(/^ /, ""); oldN += 1; }
    else if (raw.startsWith(" ") || raw.startsWith("\\\\")) { t = "ctx"; line = raw.slice(1); oldN += 1; newN += 1; }
    else if (raw.trim() === "") { t = "ctx"; line = ""; }
    else { t = "ctx"; line = raw; }
    const row = h("div", { class: `dl ${t}` });
    if (head) {
      row.append(
        h("span", { class: "gutter", text: t === "add" ? "" : String(oldN || "") }),
        h("span", { class: "gutter", text: t === "del" ? "" : String(newN || "") }),
      );
    }
    row.append(h("span", { class: "code", text: line || " " }));
    box.append(row);
  }
  return box;
}

function renderDetailNode(raw) {
  if (raw == null) return null;
  if (typeof raw !== "string") {
    if (raw.nodeType) return raw;
    return h("pre", { text: JSON.stringify(raw, null, 1).slice(0, 4000) });
  }
  const text = raw.slice(0, 4000);
  if (looksLikeDiff(text)) return renderDiffDetail(text);
  return h("pre", { text });
}

function setStepDetail(rec, detail) {
    rec.detail = detail == null ? null : detail;
    const { detBtn, de } = rec.els;
    detBtn.hidden = rec.detail == null;
    de.innerHTML = "";
    if (rec.detail == null) return;
    const node = renderDetailNode(rec.detail);
    if (node) de.append(node);
    // Edit/write/exec detail IS the user-facing context — open it so the
    // thread never shows only "Edited … ✓" / "Ran … ✓" with no body.
    const wantsOpen = rec.kind === "edit" || rec.kind === "exec"
      || (typeof rec.detail === "string" && looksLikeDiff(rec.detail));
    if (wantsOpen && de.hidden) {
      de.hidden = false;
      rec.els.li?.classList.add("open");
    }
  }

  function paintStepStatus(rec) {
    const st = rec.els.st;
    st.innerHTML = "";
    if (rec.status === "run") st.append(h("span", { html: icons.spinner, class: "spin" }));
    else if (rec.status === "done") st.append(h("span", { class: "st-ok", text: "✓" }));
    else if (rec.status === "fail") st.append(h("span", { class: "st-fail", text: "✗" }));
    // 'note' → reserved empty column (no shift, no icon).
  }

  // Panel bus (Phase 4): local CustomEvents so Review/Files/Terminal/
  // Walkthrough follow the run without extra connections.
  function emitLocal(type, detail) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: detail || {} }));
    } catch {}
  }

  function renderStepLi(turn, rec) {
    const li = h("li", { class: "step" });
    const ic = h("span", { class: "s-ic", html: icons[rec.icon] || icons.wrench });
    const ti = h("span", { class: "s-ti", text: rec.title });
    ti.title = rec.full || rec.title;
    // Phase 4 §8: step rows open Review/Files/Terminal per kind.
    if (onStepOpen && ["read", "edit", "exec", "screenshot", "list", "search", "tool"].includes(rec.kind)) {
      ti.classList.add("link");
      ti.addEventListener("click", (e) => {
        e.stopPropagation();
        try {
          onStepOpen({ kind: rec.kind, path: rec.path || "", command: rec.command || "", tool: rec.tool || "", title: rec.title });
        } catch {}
      });
    }
    const me = h("span", { class: "s-me" });
    const meta = h("span", { class: "s-meta", text: rec.meta || "" });
    const detBtn = h("button", { class: "det-btn", type: "button", text: "Details" });
    detBtn.hidden = rec.detail == null;
    me.append(meta, detBtn);
    const st = h("span", { class: "s-st" });
    const de = h("div", { class: "s-de" });
    de.hidden = true;
    detBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      de.hidden = !de.hidden;
      li.classList.toggle("open", !de.hidden);
    });
    li.append(ic, ti, me, st, de);
    rec.els = { li, ic, ti, meta, detBtn, st, de };
    if (rec.detail != null) setStepDetail(rec, rec.detail);
    paintStepStatus(rec);
    turn.els.steps.append(li);
    maybeStick();
    return rec;
  }

  // Create ONE step for a tool call (tracked while running). Empty/id-ish
  // titles never render (guardTitle falls back to the human tool name).
  function createStep(turn, { tool = "tool", kind = "tool", title = "", full = "", meta = "", status = "run", detail = null, callStep = null, callId = null, path = "", command = "", pathNorm = "", cmdNorm = "", noteKey = "" }) {
    const safe = guardTitle(tool, title);
    if (!safe) return null;
    const rec = {
      key: `s${++stepSeq}`, tool, kind, icon: KIND_ICON[kind] || "wrench",
      title: safe, full: full || safe, meta, status, detail: null, callStep, callId: callId || null, path, command,
      pathNorm: pathNorm || (path ? normPath(path) : ""),
      cmdNorm: cmdNorm || (command ? normCmd(command) : ""),
      noteKey,
    };
    renderStepLi(turn, rec);
    if (detail != null) setStepDetail(rec, detail);
    if (status === "run") openList(turn, tool).push(rec);
    else turn.lastClosed.set(tool, rec);
    turn.lastRow = rec;
    if (kind !== "thinking") turn.thinking = null;
    return rec;
  }

  // T3: consecutive identical notes merge ("Context compacted (3)").
  function noteStep(turn, { tool, title, detail = null, noteKey = "" }) {
    const key = noteKey || title;
    const last = turn.lastRow;
    if (last && last.status === "note" && last.noteKey === key) {
      last.noteCount = (last.noteCount || 1) + 1;
      const base = last.noteBase || last.title;
      last.noteBase = base;
      const label = `${base} (${last.noteCount})`;
      last.title = label;
      last.els.ti.textContent = label;
      last.els.ti.title = label;
      if (detail != null) setStepDetail(last, detail);
      maybeStick();
      return last;
    }
    const rec = createStep(turn, { tool, kind: "note", title, status: "note", detail, noteKey: key });
    if (rec) { rec.noteCount = 1; rec.noteBase = rec.title; }
    return rec;
  }

  function retitle(rec, title, full) {
    const safe = guardTitle(rec.tool, title);
    if (!safe) return;
    rec.title = safe;
    rec.full = full || safe;
    rec.els.ti.textContent = safe;
    rec.els.ti.title = rec.full;
  }

  function setMeta(rec, meta) {
    rec.meta = meta || "";
    rec.els.meta.textContent = rec.meta;
  }

  function setStatus(turn, rec, status) {
    rec.status = status;
    paintStepStatus(rec);
    if (status === "done" || status === "fail") closeStep(turn, rec);
  }

  // T2: thinking merges into the last VISIBLE row when it is a Thinking row
  // (hidden/ignored events between reasoning chunks don't break the merge).
  // Any other visible row breaks the group → a later chunk starts a new row
  // (never two ADJACENT Thinking rows: adoption reuses the neighbor).
  function thinkingAdd(turn, text) {
    let th = (turn.thinking && turn.lastRow === turn.thinking.rec) ? turn.thinking : null;
    if (!th && turn.lastRow && turn.lastRow.kind === "thinking") {
      const rec = turn.lastRow;
      th = {
        count: rec.mergeCount || 1,
        texts: rec.mergeTexts ? [...rec.mergeTexts] : [],
        rec,
      };
    }
    if (!th) {
      const rec = createStep(turn, { tool: "thinking", kind: "thinking", title: "Thinking…", status: "note" });
      if (!rec) return;
      th = { count: 0, texts: [], rec };
    }
    turn.thinking = th;
    th.count++;
    if (text) th.texts.push(text);
    th.rec.mergeCount = th.count;
    th.rec.mergeTexts = th.texts;
    const label = th.count > 1 ? `Thinking… (${th.count})` : "Thinking…";
    th.rec.title = label;
    th.rec.els.ti.textContent = label;
    th.rec.els.ti.title = label;
    setStepDetail(th.rec, th.texts.join("\n\n") || null);
  }

  function thinkingClose(turn) {
    turn.thinking = null;
  }

  const STAGE = { PLANNING: "Planning", WORKING: "Acting", VERIFYING: "Verifying", WAITING_FOR_APPROVAL: "Waiting for approval" };

  function setStage(turn, s) {
    if (turn.stage !== s) {
      turn.stage = STAGE[s] ? STAGE[s] : turn.stage;
      if (turn.status === "running") paintHead(turn);
    }
  }

  function kindForTool(tool) {
    const t = String(tool || "");
    if (/^read/i.test(t) || t === "read_file") return "read";
    if (/writ|edit|patch|append/i.test(t)) return "edit";
    if (/exec|run|shell|command/i.test(t)) return "exec";
    if (/screenshot|shot/i.test(t)) return "screenshot";
    if (/list/i.test(t)) return "list";
    if (/search/i.test(t)) return "search";
    return "tool";
  }

  // Transient enrichers (diff/read/exec/screenshot): exact toolCallId first,
  // then the open step with the same path/command, then newest open, then
  // just-closed. Null = create from the event itself (S1).
  function matchTransient(turn, tool, pred, callId) {
    const direct = stepByCallId(turn, tool, callId);
    if (direct) return direct;
    const arr = turn.openSteps.get(tool) || [];
    if (pred) {
      const hit = arr.find(pred);
      if (hit) return hit;
    }
    if (arr.length) return arr[arr.length - 1];
    const lc = turn.lastClosed.get(tool);
    if (lc && (!pred || pred(lc))) return lc;
    return null;
  }

  function screenshotImg(url) {
    const wrap = document.createElement("div");
    const img = document.createElement("img");
    img.src = url;
    img.alt = "agent screenshot";
    img.loading = "lazy";
    img.style.cssText = "max-width:220px;border-radius:8px;margin-top:4px;";
    wrap.append(img);
    return wrap;
  }

  // ── Part C: sub-agent group card ──────────────────────────────────────
  // A turn's child agents render as a collapsible "N sub-agents running"
  // group; each child expands to its live steps (SAME row renderers as the
  // main agent, via a proxy turn) plus the structured report on completion.
  // Incomplete is amber, failed red, completed green — never both green (C5).
  const SA_STATUS_LABEL = { running: "Running", completed: "Completed", incomplete: "Incomplete", failed: "Failed" };
  function saShort(id) {
    return String(id || "").replace(/^subagent-/, "").slice(-6) || "?";
  }
  function saTaskName(p, child) {
    const raw = String((p && (p.task || p.message)) || child.task || "").replace(/^sub-agent (started|done|working)[:\s]*/i, "");
    return trunc(raw, 90) || `Sub-agent ${saShort(child.id)}`;
  }
  function ensureSubagentCard(turn, subagentId, p = {}) {
    if (!turn.subagents) turn.subagents = new Map();
    let child = turn.subagents.get(subagentId);
    if (!child) {
      child = {
        id: subagentId, task: "", status: "running",
        childSessionId: "", childRunId: "",
        openSteps: new Map(), lastClosed: new Map(), lastRow: null, thinking: null,
        toolCount: 0, startedAt: Date.now(), report: null, open: true,
        stepsEl: null, cardEl: null, headTitleEl: null, pillEl: null,
        detailEl: null, reportEl: null,
      };
      turn.subagents.set(subagentId, child);
    }
    updateSubagentCard(turn, child, p);
    paintSubagentGroup(turn);
    return child;
  }
  function updateSubagentCard(turn, child, p = {}) {
    if (!child) return;
    if (p.task || (p.message && !child.task)) child.task = saTaskName(p, child);
    if (p.childSessionId) child.childSessionId = p.childSessionId;
    if (p.childRunId) child.childRunId = p.childRunId;
    if (typeof p.toolCallCount === "number") child.toolCount = p.toolCallCount;
    else if (typeof p.stepCount === "number") child.toolCount = Math.max(child.toolCount, p.stepCount);
    if (p.report && typeof p.report === "object") child.report = p.report;
    paintSubagentGroup(turn);
    maybeStick();
  }
  function setSubagentStatus(turn, subagentId, status, p = {}) {
    const child = ensureSubagentCard(turn, subagentId, p);
    child.status = SA_STATUS_LABEL[status] ? status : child.status;
    if (child.status !== "running") child.endedAt = child.endedAt || Date.now();
    updateSubagentCard(turn, child, p);
  }
  // Proxy turn sharing the main renderers (createStep/noteStep/thinkingAdd/
  // findStep/closeStep) but with the child's own step maps + steps container.
  function childProxy(turn, child) {
    return {
      ...turn,
      openSteps: child.openSteps,
      lastClosed: child.lastClosed,
      get lastRow() { return child.lastRow; },
      set lastRow(v) { child.lastRow = v; },
      get thinking() { return child.thinking; },
      set thinking(v) { child.thinking = v; },
      answerMd: "",
      renderQueued: false,
      lastRender: 0,
      els: { ...turn.els, steps: child.stepsEl || turn.els.steps, answer: turn.els.answer },
    };
  }
  function paintSubagentGroup(turn) {
    const host = turn.els && turn.els.subagents;
    if (!host) return;
    if (!turn.subagents || turn.subagents.size === 0) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    let groupHead = host.querySelector(":scope > .sa-group-head");
    let groupBody = host.querySelector(":scope > .sa-group-body");
    if (!groupHead) {
      host.innerHTML = "";
      groupHead = h("button", { class: "sa-group-head", type: "button" });
      groupHead.addEventListener("click", () => {
        turn.subagentsOpen = !turn.subagentsOpen;
        paintSubagentGroup(turn);
      });
      groupBody = h("div", { class: "sa-group-body" });
      host.append(groupHead, groupBody);
    }
    const kids = [...turn.subagents.values()];
    const running = kids.filter((k) => k.status === "running").length;
    groupHead.innerHTML = "";
    groupHead.append(
      h("span", { class: "chev", text: turn.subagentsOpen ? "▾" : "▸" }),
      h("span", { class: "sa-group-title", text: running > 0 ? `${kids.length} sub-agent${kids.length === 1 ? "" : "s"} (${running} running)` : `${kids.length} sub-agent${kids.length === 1 ? "" : "s"}` }),
    );
    groupBody.hidden = !turn.subagentsOpen;
    if (!turn.subagentsOpen) return;
    for (const child of kids) paintSubagentChild(turn, groupBody, child);
  }
  function paintSubagentChild(turn, groupBody, child) {
    if (!child.cardEl) {
      const card = h("div", { class: `sa-child sa-st-${child.status}` });
      const head = h("button", { class: "sa-child-head", type: "button" });
      const pill = h("span", { class: "sa-pill" });
      const title = h("span", { class: "sa-child-title truncate" });
      const meta = h("span", { class: "sa-child-meta" });
      head.append(pill, title, meta);
      head.addEventListener("click", () => {
        child.open = !child.open;
        paintSubagentGroup(turn);
      });
      const detail = h("div", { class: "sa-child-body" });
      const steps = h("ul", { class: "turn-steps sa-child-steps" });
      const report = h("div", { class: "sa-report", hidden: true });
      const actions = h("div", { class: "sa-actions" });
      const openBtn = h("button", { class: "btn", type: "button", text: "Open as chat" });
      openBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (child.childSessionId) window.open(`#/t/${encodeURIComponent(child.childSessionId)}`, "_blank", "noopener");
      });
      actions.append(openBtn);
      detail.append(steps, report, actions);
      card.append(head, detail);
      child.cardEl = card;
      child.headEl = head;
      child.pillEl = pill;
      child.titleEl = title;
      child.metaEl = meta;
      child.detailEl = detail;
      child.stepsEl = steps;
      child.reportEl = report;
      child.openBtn = openBtn;
      groupBody.append(card);
    }
    child.cardEl.className = `sa-child sa-st-${child.status}`;
    child.pillEl.textContent = SA_STATUS_LABEL[child.status] || child.status;
    child.pillEl.className = `sa-pill sa-pill-${child.status}`;
    child.titleEl.textContent = child.task || `Sub-agent ${saShort(child.id)}`;
    child.titleEl.title = child.task || child.id;
    const secs = Math.max(0, Math.round(((child.endedAt || Date.now()) - child.startedAt) / 1000));
    child.metaEl.textContent = `${child.toolCount} tool${child.toolCount === 1 ? "" : "s"} · ${secs}s${child.binding ? ` · ${child.binding}` : ""}`;
    child.metaEl.title = child.binding ? `Model binding: ${child.binding}` : "";
    child.detailEl.hidden = !child.open;
    child.openBtn.disabled = !child.childSessionId;
    child.openBtn.title = child.childSessionId ? `Open ${child.childSessionId} as its own chat` : "Session link arrives with the first progress event";
    // Structured report on completion (C5).
    if (child.report && child.status !== "running") {
      const r = child.report;
      child.reportEl.hidden = false;
      child.reportEl.innerHTML = "";
      const addRow = (k, v, cls = "") => {
        if (v === undefined || v === null || v === "") return;
        child.reportEl.append(h("div", { class: `sa-rep-row${cls ? ` ${cls}` : ""}` },
          h("span", { class: "sa-rep-k", text: k }),
          h("span", { class: "sa-rep-v", text: String(v) })));
      };
      addRow("status", r.status || child.status, r.status === "completed" ? "sa-ok" : "sa-bad");
      if (r.reason) addRow("reason", r.reason);
      if (r.done) addRow("done", trunc(String(r.done), 300));
      if (r.notDone) addRow("NOT done", trunc(String(r.notDone), 300), "sa-bad");
      if (Array.isArray(r.filesTouched) && r.filesTouched.length) addRow("files", r.filesTouched.slice(0, 6).join(", "));
      if (r.transcriptPath) addRow("transcript", r.transcriptPath);
      if (child.status !== "running") child.endedAt = child.endedAt || Date.now();
    } else {
      child.reportEl.hidden = true;
      child.reportEl.innerHTML = "";
    }
  }

  function handleRecord(turn, record) {
    const name = record.event || "";
    const p = record.payload || {};
    // Part C: a child's own steps ride the parent stream (the server passes
    // events whose parentRunId matches the parent run). Route them into the
    // child card via a proxy turn — never into the parent's own steps. In the
    // child's own view the same events render as normal steps (ids match).
    const childSubId = p.subagentId || "";
    const childScoped = Boolean(childSubId && p.parentSessionId && p.parentSessionId === sessionId && p.sessionId && p.sessionId !== sessionId);
    const childEntry = childScoped ? ensureSubagentCard(turn, childSubId, p) : null;
    const rt = childEntry ? childProxy(turn, childEntry) : turn;
    if (childEntry && (name === "tool.completed" || name === "tool.failed")) {
      childEntry.toolCount += 1;
      paintSubagentGroup(turn);
    }

    switch (name) {
      case "assistant.reasoning":
        thinkingAdd(turn, p.text || "");
        break;
      case "agent.thinking":
        thinkingAdd(rt, p.message || "");
        break;
      case "assistant.delta":
        thinkingClose(turn);
        turn.answerMd += p.text || "";
        scheduleAnswer(turn);
        break;
      case "plan.updated": {
        setStage(turn, "PLANNING");
        const steps = Array.isArray(p.steps) ? p.steps : [];
        const ul = h("ul", { class: "plan-list" });
        for (const s of steps) {
          const mark = s.status === "completed" ? "☑" : "☐";
          ul.append(h("li", { text: `${mark} ${s.title || ""}` }));
        }
        noteStep(turn, {
          tool: "plan", title: "Plan updated", detail: ul,
          noteKey: `plan:${JSON.stringify(steps.map((s) => [s.title, s.status]))}`,
        });
        break;
      }
      case "toolset.enabled": {
        // T2.2: model- or pin-enabled toolset for this run.
        noteStep(turn, {
          tool: "toolset",
          title: `Enabled ${p.name || "toolset"} tools${p.reason ? ` — ${trunc(p.reason, 80)}` : ""}`,
          noteKey: `toolset:${p.name || ""}`,
        });
        break;
      }
      case "toolset.menu": {
        // Menu snapshot (size/tokens) — recorded silently; counts surface in S4.
        break;
      }
      case "model_tool_loop.round_started":
        // T5: new round → new text segment (also on every tool.started below).
        segmentAnswer(turn);
        break;
      // S1: transients ENRICH the matching started step (same tool, same
      // path/command — omni-loop.js:2973-3014 emits them right AFTER that
      // call's completed with no call id). Alone, they create a proper row.
      case "tool.read": {
        setStage(turn, "WORKING");
        const path = p.path || pickArg(null, p);
        const np = normPath(path);
        let rec = matchTransient(turn, p.tool || "read", (r) => r.pathNorm && r.pathNorm === np, p.toolCallId);
        if (rec) {
          retitle(rec, `Read ${dispPath(path)}`, fullPath(path));
          setStepDetail(rec, p.observation || p);
        } else {
          rec = createStep(turn, {
            tool: p.tool || "read", kind: "read",
            title: `Read ${dispPath(path)}`, full: fullPath(path),
            status: "done", detail: p.observation || p, path, pathNorm: np,
            callId: p.toolCallId || null,
          });
        }
        break;
      }
      case "tool.diff": {
        setStage(turn, "WORKING");
        const path = p.path || pickArg(null, p);
        const np = normPath(path);
        const st = diffStat(p.diff || "");
        const title = `${humanTool(p.tool || "edit")} ${dispPath(path)} +${st.a} −${st.d}`;
        let rec = matchTransient(turn, p.tool || "edit", (r) => r.pathNorm && r.pathNorm === np, p.toolCallId);
        if (path) emitLocal("oc:fs-changed", { path, sessionId });
        if (rec) {
          retitle(rec, title, fullPath(path));
          setStepDetail(rec, p.diff || p);
        } else {
          rec = createStep(turn, {
            tool: p.tool || "edit", kind: "edit", title, full: fullPath(path),
            status: "done", detail: p.diff || p, path, pathNorm: np,
            callId: p.toolCallId || null,
          });
        }
        break;
      }
      case "tool.exec": {
        const cmd = String(p.command || pickArg(null, p));
        const nc = normCmd(cmd);
        setStage(turn, /test|verify|check|build|lint/i.test(cmd) ? "VERIFYING" : "WORKING");
        const bad = (p.status && p.status !== "completed") || (p.exitCode != null && p.exitCode !== 0);
        const meta = `${p.exitCode != null ? `exit ${p.exitCode} · ` : ""}${p.durationMs != null ? fmtDur(p.durationMs) : ""}`.replace(/ ·$/, "");
        const detail = [p.stdout, p.stderr].filter((x) => String(x || "").trim()).join("\n") || p;
        let rec = matchTransient(turn, p.tool || "exec", (r) => r.cmdNorm && r.cmdNorm === nc, p.toolCallId);
        emitLocal("oc:tool-exec", {
          tool: p.tool || "exec", command: cmd, status: p.status || "",
          exitCode: p.exitCode ?? null, stdout: p.stdout || "", stderr: p.stderr || "",
          durationMs: p.durationMs ?? null, sessionId, toolCallId: p.toolCallId || null,
        });
        if (rec) {
          retitle(rec, `Ran ${trunc(cmd, 60)}`, cmd);
          setMeta(rec, meta);
          setStepDetail(rec, detail);
          setStatus(turn, rec, bad ? "fail" : "done");
        } else {
          rec = createStep(turn, {
            tool: p.tool || "exec", kind: "exec",
            title: `Ran ${trunc(cmd, 60)}`, full: cmd, meta,
            status: bad ? "fail" : "done", detail, command: cmd, cmdNorm: nc,
            callId: p.toolCallId || null,
          });
        }
        break;
      }
      case "tool.screenshot": {
        const url = p.url || "";
        const path = p.path || "";
        const np = normPath(path);
        let rec = matchTransient(turn, p.tool || "screenshot", (r) => r.pathNorm && r.pathNorm === np, p.toolCallId);
        const extra = /^https?:/.test(url) ? screenshotImg(url) : null;
        if (rec) {
          if (path) retitle(rec, `Screenshot ${dispPath(path)}`, fullPath(path));
          if (extra) setStepDetail(rec, extra);
        } else {
          rec = createStep(turn, {
            tool: p.tool || "screenshot", kind: "screenshot",
            title: path ? `Screenshot ${dispPath(path)}` : "Screenshot", full: fullPath(path) || "Screenshot",
            status: "done", detail: extra || p, path, pathNorm: np,
            callId: p.toolCallId || null,
          });
        }
        break;
      }
      case "tool.started": {
        // THE creator: title from input path/cmd/query only (S1).
        segmentAnswer(rt);
        const tool = p.tool || "tool";
        const t = startedTitle(tool, p.input, p);
        createStep(rt, {
          tool, kind: kindForTool(tool), title: t.title, full: t.full,
          status: "run", callStep: p.step ?? null, callId: p.toolCallId || null,
          path: (p.input && (p.input.path || p.input.file)) || p.path || "",
          command: (p.input && (p.input.command || p.input.cmd)) || p.command || "",
        });
        break;
      }
      case "model_tool_loop.tool_started": {
        // Pair of tool.started for the same call (omni-loop.js:2882-2890):
        // same toolCallId → attach, never duplicate. A DIFFERENT id means a
        // parallel call → its own row. Solo (legacy flow) → create bare row.
        const tool = p.tool || "tool";
        if (p.toolCallId && stepByCallId(turn, tool, p.toolCallId)) break;
        const arr = turn.openSteps.get(tool) || [];
        if (!arr.length || p.toolCallId) {
          createStep(turn, {
            tool, kind: kindForTool(tool), title: humanTool(tool),
            status: "run", callStep: null, callId: p.toolCallId || null,
          });
        }
        break;
      }
      case "tool.output": {
        // UPDATE only — never creates (S1).
        const rec = findStep(rt, p.tool || "", p.step ?? null, p.toolCallId);
        if (rec) setStepDetail(rec, p.outputSummary || p.preview || p.resultPreview || p);
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        // UPDATE only — never creates (S1). Title stays (started/transient).
        const tool = p.tool || "tool";
        const failed = name === "tool.failed" || p.error || p.blocked;
        const rec = findStep(rt, tool, p.step ?? null, p.toolCallId);
        if (rec) {
          setStepDetail(rec, p.outputSummary || rec.detail || p);
          setStatus(rt, rec, failed ? "fail" : "done");
          if (rec.kind === "edit" && rec.path) {
            emitLocal("oc:fs-changed", { path: rec.path, sessionId });
          }
          if (rec.kind === "exec") {
            emitLocal("oc:tool-exec", {
              tool, command: rec.command || "", summary: summarizeForTerminal(p),
              failed, sessionId, toolCallId: rec.callId || p.toolCallId || null,
            });
          }
        }
        emitLocal("oc:thread-update", { sessionId });
        break;
      }
      case "model_tool_loop.tool_completed": {
        // Duration lives here (omni-loop.js:2958-2969). Update open or
        // just-closed row; never create, never pop (S1).
        const tool = p.tool || "tool";
        const rec = findStep(turn, tool, null, p.toolCallId) || turn.lastClosed.get(tool);
        if (rec && p.durationMs != null) {
          const d = fmtDur(p.durationMs);
          setMeta(rec, rec.meta ? `${rec.meta} · ${d}` : d);
        }
        break;
      }
      case "provider.started":
      case "provider.completed":
      case "provider.failed": {
        if (p.model) {
          turn.model = p.model;
          if (turn.els.head) turn.els.head.title = `Model: ${p.model}`;
        }
        // Fallback switches must never be silent: each failed attempt leaves
        // a visible row naming the model that failed and why.
        if (name === "provider.failed") {
          noteStep(turn, {
            tool: "provider",
            title: `Failed: ${trunc(p.model || p.providerId || "provider", 60)}${p.reason ? ` — ${trunc(p.reason, 80)}` : ""}`,
            noteKey: `provider-fail:${p.providerId || ""}:${p.model || ""}:${p.reason || ""}`,
          });
        }
        break;
      }
      case "context.compacted":
      case "context.summarized":
        noteStep(turn, { tool: "context", title: "Context compacted" });
        break;
      case "context.auto_compacted":
        noteStep(turn, {
          tool: "context",
          title: `Auto-compacted context (${p.beforePercent || "?"}% → ${p.afterPercent ?? "?"}%)`,
        });
        try {
          window.dispatchEvent(new CustomEvent("omniclaw:ctx", {
            detail: {
              tokensUsed: p.afterTokens || turn.liveCtx?.tokensUsed || 0,
              windowTokens: p.windowTokens || turn.liveCtx?.windowTokens || 0,
              percentFull: p.afterPercent ?? turn.liveCtx?.percentFull ?? 0,
              windowSource: turn.liveCtx?.windowSource || "",
              model: turn.liveCtx?.model || "",
              autoCompacted: true,
            },
          }));
        } catch {}
        break;
      case "context.usage": {
        // E3: visible live meter (used/budget + rounds/tools). Breakdown lives
        // in the expandable Context Details panel (paintCtx reads liveCtx).
        // The composer goal-ring also listens via window "omniclaw:ctx".
        turn.liveCtx = {
          tokensUsed: p.tokensUsed || 0,
          windowTokens: p.windowTokens || 0,
          percentFull: p.percentFull || 0,
          windowSource: p.windowSource || "",
          model: p.model || "",
          autoCompacted: Boolean(p.autoCompacted),
          prefixTokens: p.prefixTokens || 0,
          schemasTokens: p.schemasTokens || 0,
          historyTokens: p.historyTokens || 0,
          toolResultTokens: p.toolResultTokens || 0,
          ledgerTokens: p.ledgerTokens || 0,
          roundsUsed: p.roundsUsed ?? p.roundsPerMessage ?? 0,
          toolsPerRound: p.toolsPerRound ?? p.toolsLastRound ?? 0,
        };
        try {
          window.dispatchEvent(new CustomEvent("omniclaw:ctx", { detail: { ...turn.liveCtx } }));
        } catch {}
        paintHead(turn);
        if (turn.ctxOpen) paintLiveCtx(turn);
        break;
      }
      case "subagent.spawned":
        noteStep(turn, { tool: "subagent", title: `Sub-agent started: ${trunc(p.message || "", 110)}` });
        if (p.subagentId) setSubagentStatus(turn, p.subagentId, "running", p);
        break;
      case "subagent.binding":
        // Silent card enrichment (endpoint/model/link) — the spawned row and
        // progress rows already narrate; the card header shows the binding.
        if (p.subagentId) {
          const child = ensureSubagentCard(turn, p.subagentId, p);
          child.binding = p.providerId || p.baseUrl
            ? `${p.model || "default"} · ${p.providerId || p.baseUrl}`
            : (p.model || "");
          paintSubagentGroup(turn);
        }
        break;
      case "subagent.progress":
        noteStep(turn, {
          tool: "subagent",
          title: `${trunc(p.message || `Sub-agent round ${p.round || ""}`, 120)}`,
          noteKey: `subagent-progress:${p.subagentId || ""}:${p.round || ""}`,
        });
        if (p.subagentId) setSubagentStatus(turn, p.subagentId, "running", p);
        break;
      case "subagent.completed":
        noteStep(turn, { tool: "subagent", title: `Sub-agent done: ${trunc(p.message || "", 140)}` });
        if (p.subagentId) setSubagentStatus(turn, p.subagentId, "completed", p);
        break;
      case "subagent.incomplete":
        noteStep(turn, { tool: "subagent", title: `Sub-agent INCOMPLETE (${trunc(p.reason || p.status || "no reason", 60)}): ${trunc(p.message || "", 110)}` });
        if (p.subagentId) setSubagentStatus(turn, p.subagentId, "incomplete", p);
        break;
      case "subagent.failed":
        noteStep(turn, { tool: "subagent", title: `Sub-agent failed: ${trunc(p.message || "", 120)}` });
        if (p.subagentId) setSubagentStatus(turn, p.subagentId, "failed", p);
        break;
      case "approval.requested": {
        setStage(turn, "WAITING_FOR_APPROVAL");
        // 4B.1: the global store (tray) owns this card already → skip the
        // live copy. Otherwise render live and adopt it (tray skips adopted).
        if (p.approvalId && hasPending(p.approvalId)) break;
        const handle = renderApprovalCard(turn.els.cards, p, {
          onSettled: (decision, summary) => {
            bumpCards(-1);
            settleApprovalRow(turn, decision, summary);
            if (turn.status === "running") setStage(turn, "WORKING");
          },
        });
        if (handle) {
          bumpCards(1);
          adoptLive(p.approvalId, liveToken);
        }
        break;
      }
      case "approval.resolved":
        approvalSettled(turn.els.cards, p.approvalId, p.decision);
        removeApproval(p.approvalId, p.decision || "");
        if (turn.status === "running") setStage(turn, "WORKING");
        break;
      case "approval.expired_batch":
      case "approval.expired":
        approvalExpired(turn.els.cards, p.approvalIds || p.ids);
        for (const id of p.approvalIds || p.ids || (p.approvalId ? [p.approvalId] : [])) {
          removeApproval(id, "expired");
        }
        break;
      case "run.question": {
        setStage(turn, "WAITING_FOR_APPROVAL");
        if (p.questionId && hasPending(p.questionId)) break;
        const handle = renderQuestionCard(turn.els.cards, p, {
          onSettled: (answer) => {
            bumpCards(-1);
            settleAnswerRow(turn, answer, false);
            if (turn.status === "running") setStage(turn, "WORKING");
          },
          onTimeout: () => {
            bumpCards(-1);
            settleAnswerRow(turn, "", true);
            if (turn.status === "running") setStage(turn, "WORKING");
          },
        });
        if (handle) {
          bumpCards(1);
          adoptLive(p.questionId, liveToken);
        }
        break;
      }
      case "run.question_answered":
        questionSettled(turn.els.cards, p.questionId, "");
        removeQuestion(p.questionId, { answered: true });
        if (turn.status === "running") setStage(turn, "WORKING");
        break;
      case "run.question_timeout":
        questionTimeout(turn.els.cards, p.questionId);
        removeQuestion(p.questionId, { timedOut: true });
        if (turn.status === "running") setStage(turn, "WORKING");
        break;
      default: {
        // model_tool_loop.* visible only for self-correction/fallback lines.
        if (name.startsWith("model_tool_loop.") && /self.?correction|fallback|retry/i.test(name)) {
          noteStep(turn, {
            tool: "loop",
            title: `Retrying with ${name.replace("model_tool_loop.", "").replace(/_/g, " ")}`,
          });
        }
        // C6: subagent.* types must never be silently dropped — warn loudly
        // and leave a visible row so a missing handler is noticed, not lost.
        if (name.startsWith("subagent.")) {
          try { console.warn("[thread] unhandled subagent event:", name, p); } catch {}
          let dump = "";
          try { dump = JSON.stringify(p).slice(0, 120); } catch { dump = ""; }
          noteStep(turn, {
            tool: "subagent",
            title: `${name}: ${trunc(p.message || dump, 140)}`,
            noteKey: `subagent-unhandled:${name}:${p.subagentId || ""}`,
          });
          if (p.subagentId) ensureSubagentCard(turn, p.subagentId, p);
        }
        // agent.* lifecycle drives the ticker only; provider/context usage stay hidden.
        break;
      }
    }
  }

  // The per-turn 1 Hz "Working for ..." ticker.
  //
  // It must be stopped on EVERY exit path, not only in finishTurn(). clearView()
  // and destroy() both drop their turns WITHOUT finishing them, and an interval
  // that outlives its turn can never be stopped again: it is unreachable from
  // `turns` once that array is emptied, so it ticks once a second forever,
  // painting detached DOM. That leaked one timer per abandoned run.
  function stopTurnTicker(turn) {
    if (turn && turn.timer) { clearInterval(turn.timer); turn.timer = null; }
  }

  function stopAllTurnTickers() {
    for (const turn of turns) stopTurnTicker(turn);
  }

  function finishTurn(turn, status) {
    turn.status = status;
    turn.endedAt = Date.now();
    thinkingClose(turn);
    stopTurnTicker(turn);
    if (liveTurn === turn) liveTurn = null;
    paintHead(turn);
    renderActions(turn);
    updateStick();
    emitLocal("oc:run-done", { sessionId, status });
    emitLocal("oc:thread-update", { sessionId });
  }

  // Settled-card rows (spec §2/§3): approved/denied carry ✓/✗ for S4 counts.
  function settleApprovalRow(turn, decision, summary) {
    if (decision === "expired") {
      noteStep(turn, { tool: "approval", title: "⏱ Approval expired" });
      return;
    }
    const okDecision = decision === "approved";
    createStep(turn, {
      tool: "approval", kind: "note",
      title: `${okDecision ? "Approved" : "Denied"} · ${trunc(summary || "approval", 90)}`,
      status: okDecision ? "done" : "fail",
    });
  }

  function settleAnswerRow(turn, text, timedOut) {
    noteStep(turn, {
      tool: "question",
      title: timedOut ? "Question timed out · auto-continued" : `Answered: ${trunc(text || "", 90)}`,
    });
  }

  // §4 turn action row (Copy/Retry/Continue). Hover/focus-within reveals (CSS).
  // T2.1 Context Details: report.budget (total, memoryKept, per-section
  // kept/truncated) + report.menu (size, tokens, toolsets). Live turns read
  // the stream `final` metadata; history turns reuse the transcript's
  // modelToolLoop.menu and lazy-fetch budget via prompt-trace on first open.
  function fmtNum(n) {
    return Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "–";
  }

  // E3: live context meter line (used/budget + component breakdown as title
  // hover + rounds/tools). Rendered at the top of the expandable panel and
  // kept fresh on every context.usage event while the run is live.
  function paintLiveCtx(turn, insidePaintCtx = false) {
    const c = turn.liveCtx;
    if (!c || !c.windowTokens) return;
    const host = turn.els.ctx;
    if (!host) return;
    const line = h("div", {
      class: "ctx-line ctx-live",
      text: `Live ctx ${fmtNum(c.tokensUsed)} / ${fmtNum(c.windowTokens)} tok (${c.percentFull}%) · rounds ${c.roundsUsed} · tools/round ${c.toolsPerRound}`,
      title: `prefix ${fmtNum(c.prefixTokens)} · schemas ${fmtNum(c.schemasTokens)} · history ${fmtNum(c.historyTokens)} · tools ${fmtNum(c.toolResultTokens)} · ledger ${fmtNum(c.ledgerTokens)} (tokens)`,
    });
    if (insidePaintCtx) {
      host.append(line);
      return;
    }
    // Standalone refresh (panel already open): rebuild via paintCtx.
    paintCtx(turn);
    turn.els.ctx.hidden = !turn.ctxOpen;
  }

  function paintCtx(turn) {
    const host = turn.els.ctx;
    if (!host) return;
    host.innerHTML = "";
    // E3: live meter first (present during the run, before final metadata).
    paintLiveCtx(turn, true);
    const meta = turn.meta || {};
    const budget = meta.budget || null;
    const menu = meta.menu || null;
    if (!budget && !menu && !turn.liveCtx?.windowTokens) {
      host.append(h("div", { class: "ctx-empty", text: "No budget data (pre-v2 run)." }));
      return;
    }
    if (budget) {
      host.append(h("div", { class: "ctx-line",
        text: `Context ${fmtNum(budget.used)} / ${fmtNum(budget.cap)} chars · memory kept ${fmtNum(budget.memoryKept)}` }));
      const rows = (budget.sections || []).filter((s) => (s.kept || 0) > 0 || s.truncated);
      if (rows.length) {
        const ul = h("ul", { class: "ctx-secs" });
        for (const s of rows) {
          ul.append(h("li", {
            text: `${s.id} ${fmtNum(s.kept)}/${fmtNum(s.requested)}${s.truncated ? " ✂" : ""}`,
            title: `cap ${fmtNum(s.cap)}`,
          }));
        }
        host.append(ul);
      }
    }
    if (menu) {
      const tools = Array.isArray(menu.toolsets) ? menu.toolsets.join(", ") : "";
      host.append(h("div", { class: "ctx-line",
        text: `Menu ${fmtNum(menu.size)} tools · ~${fmtNum(menu.tokens)} tok${tools ? ` · ${tools}` : ""}` }));
    }
  }

  async function toggleCtx(turn, btn) {
    turn.ctxOpen = !turn.ctxOpen;
    const host = turn.els.ctx;
    if (!host) return;
    host.hidden = !turn.ctxOpen;
    if (btn) btn.classList.toggle("on", turn.ctxOpen);
    if (turn.ctxOpen && turn.meta && !turn.meta.budget && turn.meta.runId && !turn.meta.budgetTried) {
      turn.meta.budgetTried = true;
      try {
        const trace = await getPromptTrace(turn.meta.runId);
        const rep = trace && trace.promptTrace && trace.promptTrace.report;
        if (rep && rep.budget) {
          turn.meta.budget = rep.budget;
          paintCtx(turn);
        } else {
          paintCtx(turn);
        }
      } catch {
        paintCtx(turn);
      }
      maybeStick();
    }
  }

  function renderActions(turn) {
    if (turn.els.actions) turn.els.actions.remove();
    turn.els.actions = null;
    if (turn.status !== "done" && turn.status !== "stopped"
      && !(turn.status === "error" && turn.answerMd.trim())) return;
    const bar = h("div", { class: "turn-actions" });
    const addBtn = (icon, label, fn) => {
      const b = h("button", {
        class: "icon-btn", type: "button", title: label, "aria-label": label,
        html: icons[icon] || icons.more,
      });
      b.addEventListener("click", fn);
      bar.append(b);
      return b;
    };
    if (turn.answerMd.trim()) {
      addBtn("copy", "Copy answer as markdown", async (e) => {
        const btn = e.currentTarget;
        try {
          await navigator.clipboard.writeText(turn.answerMd);
          const old = btn.innerHTML;
          btn.innerHTML = icons.check;
          setTimeout(() => { btn.innerHTML = old; }, 1500);
        } catch {
          toast("Copy failed", "error");
        }
      });
    }
    if (turn.status === "done") {
      addBtn("redo", "Retry (new run, same message)", () => {
        const prev = previousUserText(turn);
        if (prev) send(prev);
      });
      addBtn("arrow", "Continue", () => send("continue"));
    }
    if (turn.status === "stopped") {
      addBtn("arrow", "Continue", () => send("continue"));
    }
    // T2.1: Context Details toggle — only when there is something to show
    // (live meter, final metadata, transcript menu, or a runId to lazy-fetch).
    {
      const meta = turn.meta || {};
      if (meta.budget || meta.menu || meta.runId || turn.liveCtx?.windowTokens) {
        const btn = addBtn("info", "Context & menu details", () => toggleCtx(turn, btn));
        if (turn.ctxOpen) btn.classList.add("on");
      }
    }
    if (!bar.children.length) return;
    turn.els.actions = bar;
    turn.els.el.append(bar);
  }

  function previousUserText(turn) {
    const i = turns.indexOf(turn);
    for (let k = i - 1; k >= 0; k--) {
      if (turns[k].role === "user" && turns[k].text) return turns[k].text;
    }
    return "";
  }

  function showError(turn, message, retryText) {
    finishTurn(turn, "error");
    const box = h("div", { class: "turn-error" },
      h("span", { text: message }),
      h("button", { class: "btn", type: "button", text: "Retry" }));
    box.querySelector("button").addEventListener("click", () => {
      box.remove();
      send(retryText);
    });
    turn.els.el.append(box);
    maybeStick();
  }

  function send(text, opts = {}) {
    const msg = String(text || "").trim();
    if (!msg || liveAbort) return null;
    pokeActivity();
    pushUser(msg);
    const turn = newAssistantTurn();
    liveTurn = turn;
    setStage(turn, "PLANNING");
    turn.timer = setInterval(() => { if (turn.status === "running") paintHead(turn); }, 1000);
    setRunning(true);

    const ctrl = new AbortController();
    liveAbort = ctrl;
    streamChat(
      { message: msg, sessionId: sessionId || undefined, label: pendingLabel || undefined, agentId, workspacePath: opts.workspacePath || undefined },
      {
        onRunId: (id) => { liveRunId = id; },
        onEvent: (record) => { if (!destroyed) handleRecord(turn, record); },
        onFinal: (packet) => {
          if (destroyed) return;
          const content = packet.content || "";
          // T5: identical modulo whitespace → keep the segmented live version.
          if (content && normWs(content) !== normWs(turn.answerMd)) {
            turn.answerMd = content;
            scheduleAnswer(turn);
          }
          const meta = packet.metadata || {};
          if (meta.model) turn.model = meta.model;
          // T2.1 proof block (present only when v2 paths ran; the bar paints
          // on finish via renderActions).
          if (meta.budget || meta.menu) {
            turn.meta = {
              budget: meta.budget || null,
              menu: meta.menu || null,
              runId: liveRunId || (turn.meta && turn.meta.runId) || "",
            };
            if (turn.ctxOpen) paintCtx(turn);
          }
        },
        onSession: (id) => {
          // 4B.1: server-assigned session → rebind the pending tray to it.
          try { bindTray(id); } catch {}
          onSession && onSession(id);
        },
        onDone: () => {
          liveAbort = null; liveRunId = "";
          setRunning(false);
          if (destroyed) return;
          // Flush a final synchronous render (scheduleAnswer is async).
          turn.els.answer.innerHTML = renderAnswerHtml(turn);
          postProcessAnswer(turn.els.answer);
          finishTurn(turn, "done");
        },
        onDetach: (e) => {
          // The run is STILL RUNNING server-side — the server no longer cancels on
          // disconnect. Say exactly that, and do NOT offer "Retry": retrying would
          // start a second concurrent run doing the same work.
          liveAbort = null; liveRunId = "";
          setRunning(false);
          if (destroyed) return;
          finishTurn(turn, "detached");
          const box = h("div", { class: "turn-error" },
            h("span", { text: e.message || "Connection lost — the agent is still working in the background." }));
          turn.els.el.append(box);
          maybeStick();
        },
        onError: (e) => {
          liveAbort = null; liveRunId = "";
          setRunning(false);
          if (destroyed) return;
          showError(turn, e.message || "Run failed", msg);
        },
        onAbort: () => {
          liveAbort = null; liveRunId = "";
          setRunning(false);
          if (destroyed) return;
          finishTurn(turn, "stopped");
        },
      },
      ctrl.signal,
    );
    maybeStick();
    return turn;
  }

  let pendingLabel = "";
  let attached = false;

  function stop() {
    if (liveES) {
      try { liveES.close(); } catch {}
      liveES = null;
    }
    if (liveAbort) {
      const id = liveRunId;
      liveAbort.abort();
      liveAbort = null;
      if (id) stopRun(id).catch(() => {});
    } else if (liveRunId) {
      // Attached (re-attached or finished-stream) run: server-side cancel only.
      const id = liveRunId;
      attached = false;
      stopRun(id).catch(() => {});
      if (liveTurn && liveTurn.status === "running") finishTurn(liveTurn, "stopped");
      liveRunId = "";
      setRunning(false);
    } else {
      attached = false;
    }
  }

  // §5 steer: inject into the RUNNING run; fall back to a normal send.
  async function steer(text) {
    const msg = String(text || "").trim();
    if (!msg) return { ok: false };
    const id = liveRunId;
    if (!id) return { ok: false, error: "no active run" };
    pokeActivity();
    try {
      const res = await steerRun(id, msg);
      if (res && res.ok === false) throw new Error(res.error || "steer rejected");
      const target = (liveTurn && liveTurn.status === "running") ? liveTurn : turns.filter((t) => t.role === "assistant").pop();
      if (target) {
        noteStep(target, { tool: "steer", title: `→ Steered: “${trunc(msg, 100)}”` });
      }
      return { ok: true };
    } catch (e) {
      toast("Run finished — sent as new message", "error");
      if (liveAbort) {
        try { liveAbort.abort(); } catch {}
        liveAbort = null;
      }
      if (liveES) {
        try { liveES.close(); } catch {}
        liveES = null;
      }
      attached = false;
      liveRunId = "";
      setRunning(false);
      send(msg);
      return { ok: false, fallback: true };
    }
  }

  // §6 re-attach: session opened with activeRunId. /api/events broadcasts the
  // FULL record stream including transients (gateway-store.js:358-369 emits on
  // the same emitter that server.js:298 broadcasts), so live cards work.
  function attachLive(runId) {
    const turn = newAssistantTurn();
    pokeActivity();
    turn.timer = setInterval(() => { if (turn.status === "running") paintHead(turn); }, 1000);
    setRunning(true);
    liveRunId = runId;
    liveTurn = turn;
    attached = true;
    turn.attached = true;
    const es = new EventSource("/api/events");
    liveES = es;
    let gotEvent = false;
    const quietTimer = setTimeout(() => {
      if (destroyed || liveES !== es || gotEvent || turn.status !== "running") return;
      turn.els.el.append(h("div", { class: "thread-note", text: "No live events arrived — the run may have finished elsewhere. Stop or send a new message." }));
    }, 20000);
    es.onmessage = (ev) => {
      if (destroyed || liveES !== es) return;
      let data = null;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (!data || data.type === "hello" || data.type === "heartbeat") return;
      const record = data.record || data;
      const q = record.payload || {};
      if (q.runId && q.runId !== runId) return;
      if (q.sessionId && sessionId && q.sessionId !== sessionId) return;
      gotEvent = true;
      clearTimeout(quietTimer);
      handleRecord(turn, record);
      if ((record.event === "agent.completed" || record.event === "agent.done")
        && (!q.runId || q.runId === runId)) {
        try { es.close(); } catch {}
        if (liveES === es) liveES = null;
        attached = false;
        liveRunId = "";
        setRunning(false);
        if (turn.status === "running") finishTurn(turn, "done");
      }
    };
    es.onerror = () => {};
    maybeStick();
    return turn;
  }

  function historyStep(item) {
    const tool = item.tool || "tool";
    const output = item.output || {};
    const status = item.outputStatus && typeof item.outputStatus === "object" ? item.outputStatus : output;
    const failed = Boolean(status.error || status.blocked || status.ok === false)
      || item.toolSummary?.status === "failed";
    const summary = item.toolSummary?.summary
      || output.outputSummary || output.path || output.command || output.url
      || pickArg(item.input, output) || "";
    const kind = kindForTool(tool);
    // Same title rules as live rows: verbed summary verbatim, else path/cmd
    // title; real diff stat for edits when available.
    let title, full;
    const path = output.path || (output.input && (output.input.path || output.input.file)) || "";
    if (/writ|edit|patch|append/i.test(tool) && output.diff && path) {
      const st = diffStat(output.diff);
      title = `${humanTool(tool)} ${dispPath(path)} +${st.a} −${st.d}`;
      full = fullPath(path);
    } else if (toolTitleVerbed(tool, summary)) {
      title = guardTitle(tool, trunc(summary, 80));
      full = title;
    } else {
      const t = startedTitle(tool, item.input, output);
      title = t.title;
      full = t.full;
    }
    let meta = "";
    if (/exec|run|shell|command/i.test(tool) && output.exitCode != null) {
      meta = `exit ${output.exitCode}${output.durationMs != null ? ` · ${fmtDur(output.durationMs)}` : ""}`;
    }
    return { kind, title, full, meta, status: failed ? "fail" : "done", detail: item };
  }

  // toolSummary-style strings ("Wrote 138 bytes…") are used verbatim.
  function toolTitleVerbed(tool, summary) {
    const s = String(summary || "").trim();
    if (!s) return false;
    return VERBED_LEAD.test(s) || s.toLowerCase().startsWith(humanTool(tool).toLowerCase());
  }

  async function loadHistory(id, opts = {}) {
    root.innerHTML = "";
    turns.length = 0;
    pendingCards = 0;
    // 4B.1: fresh pending snapshot so the tray is correct even before the
    // next poll/event (covers reload + mid-run open).
    refreshApprovals().catch(() => {});
    const skel = h("div", { class: "thread-skel" },
      h("div", { class: "skeleton-bar", style: "width:60%" }),
      h("div", { class: "skeleton-bar", style: "width:90%" }),
      h("div", { class: "skeleton-bar", style: "width:75%" }));
    root.append(skel);
    try {
      const data = await getSession(id);
      if (destroyed) return;
      skel.remove();
      const session = (data && data.session) || data || {};
      if (session.activeRunId && opts.liveNote !== false) {
        root.append(h("div", { class: "thread-note", text: "A run is in progress on the server — send a new message to start a fresh run." }));
      }
      const entries = (session.transcript || []).filter((e) => e && e.type === "message");
      if (!entries.length) {
        root.append(h("div", { class: "thread-note", text: "No messages yet." }));
        return;
      }
      let cur = null;
      for (const e of entries) {
        if (e.role === "user") {
          cur = { id: `h${++seq}`, role: "user", text: e.text || "", at: e.at || "" };
          const el = h("div", { class: "turn-user" }, h("div", { class: "user-bubble", text: e.text || "" }));
          cur.els = { el };
          turns.push(cur);
          root.append(el);
        } else {
          if (!cur || cur.role !== "user") {
            cur = { id: `h${++seq}`, role: "user", text: "", at: e.at || "" };
          }
          const turn = {
            id: `h${++seq}`, role: "assistant",
            startedAt: Date.parse(cur.at || e.at) || Date.now(),
            endedAt: Date.parse(e.at) || Date.now(),
            stage: "Acting",
            answerMd: e.text || "", status: "done", error: "",
            collapsedDone: true,
            subagents: new Map(),
            subagentsOpen: true,
            // T2.1: menu rides the transcript (modelToolLoop.report); budget
            // lazy-loads from prompt-trace on first Details open.
            meta: (e.modelToolLoop && e.modelToolLoop.menu) || e.runId
              ? { budget: null, menu: (e.modelToolLoop && e.modelToolLoop.menu) || null, runId: e.runId || "" }
              : null,
            ctxOpen: false,
          };
          const el = h("div", { class: "turn-assistant" });
          const head = h("button", { class: "turn-head", type: "button" }, h("span", { class: "ht", text: "" }));
          const ctx = h("div", { class: "turn-ctx", hidden: true });
          const steps = h("ul", { class: "turn-steps collapsed" });
          const answer = h("div", { class: "answer" });
          head.addEventListener("click", () => {
            turn.collapsedDone = !turn.collapsedDone;
            steps.classList.toggle("collapsed", turn.collapsedDone);
          });
          el.append(head, ctx, steps, answer);
          turn.els = { el, head, ctx, steps, answer };
          for (const item of e.toolOutputs || []) {
            const s = historyStep(item);
            const output = item.output || {};
            const rec = {
              key: `h${++seq}`, tool: item.tool || "tool", kind: s.kind,
              icon: KIND_ICON[s.kind] || "wrench",
              title: guardTitle(item.tool || "tool", s.title),
              full: s.full || s.title, meta: s.meta || "",
              status: s.status, detail: null,
              path: output.path || (item.input && (item.input.path || item.input.file)) || "",
              command: output.command || (item.input && (item.input.command || item.input.cmd)) || "",
            };
            const li = h("li", { class: "step" });
            const ic = h("span", { class: "s-ic", html: icons[rec.icon] || icons.wrench });
            const ti = h("span", { class: "s-ti", text: rec.title });
            ti.title = rec.full;
            if (onStepOpen && ["read", "edit", "exec", "screenshot", "list", "search", "tool"].includes(rec.kind)) {
              ti.classList.add("link");
              ti.addEventListener("click", (ev) => {
                ev.stopPropagation();
                try {
                  onStepOpen({ kind: rec.kind, path: rec.path, command: rec.command, tool: rec.tool, title: rec.title });
                } catch {}
              });
            }
            const me = h("span", { class: "s-me" });
            const meta = h("span", { class: "s-meta", text: rec.meta });
            const detBtn = h("button", { class: "det-btn", type: "button", text: "Details" });
            me.append(meta, detBtn);
            const st = h("span", { class: "s-st" });
            if (s.status === "done") st.append(h("span", { class: "st-ok", text: "✓" }));
            else if (s.status === "fail") st.append(h("span", { class: "st-fail", text: "✗" }));
            const de = h("div", { class: "s-de" });
            const detailNode = renderDetailNode(s.detail);
            const hasDetail = s.detail != null && String(typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail)).length > 0;
            de.hidden = !(hasDetail && (s.kind === "edit" || s.kind === "exec"));
            if (detailNode) de.append(detailNode);
            if (hasDetail && de.hidden) {
              // still keep Details toggle available for non-auto kinds
            }
            detBtn.hidden = !hasDetail;
            detBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              de.hidden = !de.hidden;
              li.classList.toggle("open", !de.hidden);
            });
            if (!de.hidden) li.classList.add("open");
            li.append(ic, ti, me, st, de);
            steps.append(li);
          }
          answer.innerHTML = renderAnswerHtml(turn);
          postProcessAnswer(answer);
          turns.push(turn);
          root.append(el);
          const { secs, tail } = headerTextFor(turn.endedAt - turn.startedAt, steps);
          head.querySelector(".ht").textContent = `Worked for ${secs} ▸${tail}`;
          renderActions(turn);
          cur = { role: "user", text: "" };
        }
      }
      maybeStick();
      if (window.__ocNext && !window.__ocNext.threadLoaded) {
        window.__ocNext.threadLoaded = performance.now();
      }
      return session;
    } catch (e) {
      if (destroyed) return null;
      skel.remove();
      root.append(h("div", { class: "turn-error" }, h("span", { text: `Could not load session: ${e.message}` })));
      return null;
    }
  }

  // /clear-view: wipe the rendered thread only (server history untouched).
  function clearView() {
    if (liveAbort) { try { liveAbort.abort(); } catch {} liveAbort = null; }
    if (liveES) { try { liveES.close(); } catch {} liveES = null; }
    attached = false;
    liveRunId = "";
    liveTurn = null;
    setRunning(false);
    // BEFORE the array is emptied, or these tickers lose their only handle.
    stopAllTurnTickers();
    root.innerHTML = "";
    turns.length = 0;
    pendingCards = 0;
  }

  // Append a plain note row (slash-command results).
  function note(text) {
    root.append(h("div", { class: "thread-note", text: String(text || "") }));
    maybeStick();
  }

  // Credit leak fix: tab close/navigation must stop the server run, not just
  // drop the local stream. Best-effort (the browser may kill the beacon);
  // the server res-on-close cancel is the reliable backstop.
  const onPageHide = () => { try { if (liveRunId) stop(); } catch {} };
  try { window.addEventListener("pagehide", onPageHide); } catch {}

  return {
    send,
    stop,
    steer,
    // A hand-off card is appended to the live transcript, with the
    // typed hand-off line as its note so the thread explains itself. The card
    // follows the delegation store from there - it does not poll.
    mountDelegation(delegationId, noteText) {
      // Its own turn: a hand-off is not part of a running answer, and reusing
      // one would collapse the card away when that answer settles.
      const turn = newAssistantTurn();
      if (noteText) pushUser(noteText, null);
      return mountDelegationCard(turn.els.cards, delegationId);
    },
    attachLive,
    loadHistory,
    clearView,
    note,
    setPendingLabel: (l) => { pendingLabel = l; },
    get running() { return !!liveAbort || attached; },
    get runId() { return liveRunId; },
    destroy() {
      destroyed = true;
      attached = false;
      try { window.removeEventListener("pagehide", onPageHide); } catch {}
      try { apprOff(); } catch {}
      try { trayCtl && trayCtl.unmount(); } catch {}
      try { trayWrap.remove(); } catch {}
      // Leaving a streaming thread goes through the abort below, which returns
      // early on `destroyed` and so never reaches finishTurn(). The tickers have
      // to be stopped here or every navigation mid-run leaks one.
      stopAllTurnTickers();
      releaseLive(liveToken);
      if (liveAbort) { try { liveAbort.abort(); } catch {} liveAbort = null; }
      if (liveES) { try { liveES.close(); } catch {} liveES = null; }
      liveRunId = "";
      view.removeEventListener("scroll", updateStick);
    },
  };
}
