// Walkthrough tab: client-side markdown artifact from the session transcript
// (turn model equivalent): title, per-turn request quote + step checklist,
// files changed (Wrote/Edited rows), commands run, final answer. Copy as Markdown +
// Save to workspace (.omniclaw/walkthroughs/<sessionId>.md via fs/write).

import { h } from "../utils/dom.js";
import { getSession, fsWrite } from "../api.js";
import { markdownToHtml } from "../ui/thread.js";
import { toast } from "../ui/toast.js";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function humanTool(name) {
  const t = String(name || "");
  if (/^read/i.test(t)) return "Read";
  if (/writ/i.test(t)) return "Wrote";
  if (/edit|patch|append/i.test(t)) return "Edited";
  if (/exec|run|shell|command/i.test(t)) return "Ran";
  if (/list/i.test(t)) return "Listed";
  if (/search/i.test(t)) return "Searched";
  return t || "tool";
}

// toolSummary strings already carry a verb ("Wrote 138 bytes…") — use verbatim.
const VERBED_LEAD = /^(wrote|written|listed|list|read|reading|ran|running|created|updated|deleted|opened|found|searched|searching|edited|tool|failed|blocked|ok|completed|finished)\b/i;

function checkTitle(tool, summary) {
  const s = String(summary || "").trim().replace(/\s+/g, " ");
  if (s && (VERBED_LEAD.test(s) || s.toLowerCase().startsWith(humanTool(tool).toLowerCase()))) {
    return s.slice(0, 100);
  }
  return `${humanTool(tool)}${s ? ` ${s.slice(0, 90)}` : ""}`;
}

function buildMarkdown(session, entries) {
  const title = session.label || session.id || "Session";
  const lines = [`# Walkthrough: ${title}`, ""];
  const files = new Map();
  const commands = [];
  for (const e of entries) {
    if (!e || e.type !== "message") continue;
    if (e.role === "user") {
      lines.push(`> ${String(e.text || "").trim().split("\n").join("\n> ")}`, "");
      continue;
    }
    const checks = [];
    for (const item of e.toolOutputs || []) {
      const tool = item.tool || "tool";
      const output = item.output || {};
      const status = item.outputStatus && typeof item.outputStatus === "object" ? item.outputStatus : output;
      const failed = Boolean(status.error || status.blocked || status.ok === false);
      const summary = (item.toolSummary && item.toolSummary.summary)
        || output.outputSummary || output.path || output.command || "";
      checks.push(`- [${failed ? " " : "x"}] ${checkTitle(tool, summary)}`);
      if (/writ|edit|patch|append/i.test(tool)) {
        const p = output.path || (item.input && (item.input.path || item.input.file)) || "";
        if (p && !files.has(p)) files.set(p, { failed });
      }
      if (/exec|run|shell|command/i.test(tool)) {
        const cmd = output.command || (item.input && (item.input.command || item.input.cmd)) || "";
        if (cmd) commands.push(cmd);
      }
    }
    if (checks.length) lines.push(...checks, "");
    if (e.text && String(e.text).trim()) {
      lines.push(String(e.text).trim(), "");
    }
  }
  if (files.size) {
    lines.push("## Files changed", "");
    for (const [p, info] of files) lines.push(`- \`${p}\`${info.failed ? " (failed)" : ""}`);
    lines.push("");
  }
  if (commands.length) {
    lines.push("## Commands run", "");
    for (const c of [...new Set(commands)]) lines.push(`- \`${c.slice(0, 120)}\``);
    lines.push("");
  }
  return { md: lines.join("\n").trim() + "\n", files: [...files.keys()], commands };
}

export function mountWalkthroughTab(el, ctx, arg = {}) {
  el.innerHTML = "";
  const wrap = h("div", { class: "walk" });
  const head = h("div", { class: "tab-head" },
    h("span", { class: "tab-title", text: "Walkthrough" }),
    h("span", { class: "tab-actions" }));
  const body = h("div", { class: "walk-body" });
  wrap.append(head, body);
  el.append(wrap);
  const actions = head.querySelector(".tab-actions");

  const state = { dead: false, sessionId: ctx.activeSessionId || "", md: "", timer: null };

  const copyBtn = h("button", { class: "mini-btn", type: "button", text: "Copy as Markdown" });
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.md);
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = "Copy as Markdown"; }, 1200);
    } catch {
      toast("Copy failed", "error");
    }
  });
  const saveBtn = h("button", { class: "mini-btn", type: "button", text: "Save to workspace" });
  saveBtn.addEventListener("click", async () => {
    if (!state.md || !state.sessionId) return;
    try {
      await fsWrite(`.omniclaw/walkthroughs/${state.sessionId}.md`, state.md);
      toast("Walkthrough saved", "success");
    } catch (e) {
      toast(`Save failed: ${e.message}`, "error");
    }
  });
  const refBtn = h("button", { class: "icon-btn", type: "button", title: "Refresh", "aria-label": "Refresh", html: "⟳" });
  refBtn.addEventListener("click", () => rebuild());
  actions.append(copyBtn, saveBtn, refBtn);

  async function rebuild() {
    if (state.dead || !state.sessionId) {
      body.innerHTML = "";
      body.append(h("div", { class: "panel-empty small", text: "Open a chat to build its walkthrough." }));
      return;
    }
    try {
      const data = await getSession(state.sessionId);
      if (state.dead) return;
      const session = (data && data.session) || data || {};
      const entries = (session.transcript || []).filter((e) => e && e.type === "message");
      if (!entries.length) {
        body.innerHTML = "";
        body.append(h("div", { class: "panel-empty small", text: "No messages yet." }));
        return;
      }
      const { md } = buildMarkdown(session, entries);
      state.md = md;
      body.innerHTML = "";
      const rendered = h("div", { class: "answer walk-md" });
      try {
        rendered.innerHTML = markdownToHtml(md);
        for (const a of rendered.querySelectorAll("a[href]")) { a.target = "_blank"; a.rel = "noopener"; }
      } catch {
        rendered.textContent = md;
      }
      body.append(rendered);
    } catch (e) {
      if (state.dead) return;
      body.innerHTML = "";
      body.append(h("div", { class: "panel-empty small", text: `Walkthrough failed: ${e.message}` }));
    }
  }

  const onUpdate = () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => rebuild(), 1500);
  };
  window.addEventListener("oc:thread-update", onUpdate);
  window.addEventListener("oc:run-done", onUpdate);

  rebuild();

  return {
    update(c) {
      const sid = (c && c.activeSessionId) || "";
      if (sid && sid !== state.sessionId) {
        state.sessionId = sid;
        rebuild();
      } else if (c && c.arg && c.arg.refresh) {
        rebuild();
      }
    },
    unmount() {
      state.dead = true;
      clearTimeout(state.timer);
      window.removeEventListener("oc:thread-update", onUpdate);
      window.removeEventListener("oc:run-done", onUpdate);
    },
  };
}
