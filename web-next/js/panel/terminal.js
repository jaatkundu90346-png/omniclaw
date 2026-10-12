// Terminal tab — caps.terminal is false, so this is honestly an OUTPUT LOG:
// "Terminal (agent output)". Feed = tool.exec stream events for the session +
// transcript toolOutputs of exec kind. No interactive shell in this build.

import { h } from "../utils/dom.js";
import { getSession } from "../api.js";
import { toast } from "../ui/toast.js";

function isExecTool(tool) {
  return /exec|run|shell|command|terminal/i.test(String(tool || ""));
}

// Minimal SGR parser: 30-37/90-97 foreground, 1 bold, 0 reset. Strips the rest.
function ansiToHtml(text) {
  const COLORS = {
    30: "#888", 31: "#f87171", 32: "#4ade80", 33: "#fbbf24",
    34: "#60a5fa", 35: "#c084fc", 36: "#22d3ee", 37: "#e5e5e5",
    90: "#777", 91: "#fca5a5", 92: "#86efac", 93: "#fcd34d",
    94: "#93c5fd", 95: "#d8b4fe", 96: "#67e8f6", 97: "#fff",
  };
  const frag = document.createDocumentFragment();
  let color = "";
  let bold = false;
  const push = (chunk) => {
    if (!chunk) return;
    const span = document.createElement("span");
    span.textContent = chunk;
    if (color) span.style.color = color;
    if (bold) span.style.fontWeight = "700";
    frag.append(span);
  };
  const parts = String(text || "").split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) {
      push(part.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
      continue;
    }
    for (const code of m[1].split(";").map(Number)) {
      if (code === 0) { color = ""; bold = false; }
      else if (code === 1) bold = true;
      else if (COLORS[code]) color = COLORS[code];
    }
  }
  return frag;
}

export function mountTerminalTab(el, ctx, arg = {}) {
  el.innerHTML = "";
  const wrap = h("div", { class: "term" });
  const head = h("div", { class: "tab-head" },
    h("span", { class: "tab-title", text: "Terminal (agent output)" }),
    h("span", { class: "tab-actions" }));
  const filter = h("input", {
    type: "text", placeholder: "Filter…", "aria-label": "Filter terminal",
    class: "term-filter",
  });
  const feed = h("div", { class: "term-feed" });
  const foot = h("div", { class: "term-foot" });
  const fake = h("input", {
    type: "text", disabled: true,
    placeholder: "Interactive terminal is not available in this build",
    "aria-label": "Interactive terminal unavailable",
  });
  foot.append(fake);
  wrap.append(head, filter, feed, foot);
  el.append(wrap);

  const state = {
    dead: false,
    blocks: [], // [{key, tool, command, cwd, output, exitCode, durationMs, failed}]
    sessionId: ctx.activeSessionId || "",
  };

  function keyFor(ev) {
    if (ev.toolCallId) return `id:${ev.toolCallId}`;
    return `cmd:${ev.tool || ""}\n${ev.command || ""}`;
  }

  function upsert(ev) {
    const key = keyFor(ev);
    let b = state.blocks.find((x) => x.key === key);
    if (!b) {
      b = { key, tool: ev.tool || "", command: ev.command || "", cwd: ev.cwd || "" };
      state.blocks.push(b);
    }
    if (ev.stdout !== undefined || ev.stderr !== undefined || ev.summary !== undefined) {
      b.output = [ev.stdout, ev.stderr].filter((x) => String(x || "").trim()).join("\n")
        || ev.summary || b.output || "";
    }
    if (ev.exitCode !== undefined && ev.exitCode !== null) b.exitCode = ev.exitCode;
    if (ev.durationMs != null) b.durationMs = ev.durationMs;
    if (ev.failed !== undefined) b.failed = !!ev.failed;
    else if (ev.exitCode != null) b.failed = Number(ev.exitCode) !== 0;
    paint();
  }

  function paint() {
    const needle = filter.value.trim().toLowerCase();
    feed.innerHTML = "";
    const list = state.blocks.filter((b) =>
      !needle || `${b.command}\n${b.output || ""}`.toLowerCase().includes(needle));
    if (!list.length) {
      feed.append(h("div", { class: "panel-empty small", text: "No agent commands yet." }));
      return;
    }
    for (const b of list) {
      const block = h("div", { class: "term-block" });
      const cmd = h("div", { class: "term-cmd", text: `$ ${b.command || b.tool}` });
      cmd.title = b.command || b.tool;
      const meta = h("div", { class: "term-meta" });
      if (b.cwd) meta.append(h("span", { class: "muted", text: b.cwd }));
      if (b.durationMs != null) {
        const ms = Number(b.durationMs);
        meta.append(h("span", {
          class: "muted",
          text: ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`,
        }));
      }
      if (b.exitCode !== undefined) {
        meta.append(h("span", {
          class: `exit-badge ${Number(b.exitCode) === 0 ? "ok" : "bad"}`,
          text: `exit ${b.exitCode}`,
        }));
      }
      const copy = h("button", { class: "mini-btn", type: "button", text: "Copy" });
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(`$ ${b.command || ""}\n${b.output || ""}`);
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy"; }, 1200);
        } catch {
          toast("Copy failed", "error");
        }
      });
      meta.append(copy);
      const pre = h("pre", { class: "term-out" });
      pre.append(ansiToHtml(b.output || "(no output)"));
      block.append(cmd, meta, pre);
      if (b.key) block.dataset.key = b.key;
      feed.append(block);
    }
    feed.scrollTop = feed.scrollHeight;
  }

  filter.addEventListener("input", paint);

  const clearBtn = h("button", { class: "mini-btn", type: "button", text: "Clear view" });
  clearBtn.addEventListener("click", () => {
    state.blocks = [];
    paint();
  });
  head.querySelector(".tab-actions").append(clearBtn);

  async function loadTranscript(sessionId) {
    if (!sessionId) return;
    try {
      const data = await getSession(sessionId);
      if (state.dead) return;
      const session = (data && data.session) || data || {};
      const entries = (session.transcript || []).filter((e) => e && e.type === "message");
      for (const e of entries) {
        for (const item of e.toolOutputs || []) {
          if (!isExecTool(item.tool)) continue;
          const output = item.output || {};
          upsert({
            tool: item.tool,
            command: output.command || (item.input && (item.input.command || item.input.cmd)) || "",
            cwd: (item.input && item.input.cwd) || "",
            stdout: output.stdout || "",
            stderr: output.stderr || "",
            summary: item.toolSummary ? item.toolSummary.summary : "",
            exitCode: output.exitCode,
            durationMs: output.durationMs,
            failed: Boolean(output.error || output.blocked || output.ok === false)
              || (item.toolSummary && item.toolSummary.status === "failed"),
            toolCallId: item.toolCallId || null,
          });
        }
      }
    } catch {}
  }

  const onExec = (e) => {
    const d = (e && e.detail) || {};
    if (d.sessionId && state.sessionId && d.sessionId !== state.sessionId) return;
    upsert({
      tool: d.tool || "",
      command: d.command || "",
      stdout: d.stdout || "",
      stderr: d.stderr || "",
      summary: d.summary || "",
      exitCode: d.exitCode,
      durationMs: d.durationMs,
      failed: d.failed,
      toolCallId: d.toolCallId || null,
    });
  };
  window.addEventListener("oc:tool-exec", onExec);

  paint();
  loadTranscript(state.sessionId);

  // Deep-link from a "Ran …" step row: open block with this command.
  if (arg && arg.command) {
    filter.value = String(arg.command).slice(0, 60);
    paint();
  }

  return {
    update(c) {
      const sid = (c && c.activeSessionId) || "";
      if (sid && sid !== state.sessionId) {
        state.sessionId = sid;
        state.blocks = [];
        loadTranscript(sid);
      }
      if (c && c.arg && c.arg.command) {
        filter.value = String(c.arg.command).slice(0, 60);
        paint();
        const hit = state.blocks.find((b) => (b.command || "") === c.arg.command);
        if (hit) {
          const elx = feed.querySelector(`[data-key="${CSS.escape(hit.key)}"]`);
          if (elx) elx.scrollIntoView({ block: "center" });
        }
      }
    },
    unmount() {
      state.dead = true;
      window.removeEventListener("oc:tool-exec", onExec);
    },
  };
}
