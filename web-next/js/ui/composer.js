// Full composer island (Phase 3):
// Row 1: context strip (workspace · env · branch? · agent?) — real data only.
// Row 2: attach tray + textarea (draft per session, Enter/Ctrl+Enter send).
// Row 3: [+] · permission pill ··· model pill · stop · send.
// Enter ordering: registered enterHooks (slash/mention) run BEFORE send.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import {
  getConfig, setConfig, getAgents, getGit, gitStatus, uploadFile,
  pinSessionToolsets, setSubAgentModel, getModelRegistry,
} from "../api.js";
import { openPopover, closePopover } from "./popover.js";
import { openModelMenu, modelMark, modelPillText as pillText, modelPillTitle as pillTitle } from "./modelmenu.js";
import { openWorkspacePicker } from "./workspace-picker.js";
import { toast } from "./toast.js";

// EXACT port of neo.js:1120-1136 — the ONLY modes the selector shows.
// Exported for the Settings > Permissions page (same payloads, same writes).
export const MODES = {
  full: {
    label: "Full Access", icon: "unlock",
    desc: "All tools on · shell runs without asking",
    config: {
      tools: {
        permissions: {
          allowFileWrite: true, allowShellExecution: true,
          allowComputerAccess: true, allowConnectorWrite: true, allowBrowserControl: true,
        },
        shellExecution: { approvalMode: "auto" },
      },
    },
  },
  approvals: {
    label: "Approvals", icon: "pencil",
    desc: "All tools on · each shell command needs Allow",
    config: {
      tools: {
        permissions: {
          allowFileWrite: true, allowShellExecution: true,
          allowComputerAccess: true, allowConnectorWrite: true, allowBrowserControl: true,
        },
        shellExecution: { approvalMode: "always" },
      },
    },
  },
  readonly: {
    label: "Read-only", icon: "lock",
    desc: "File write, shell and computer off",
    config: {
      tools: {
        permissions: {
          allowFileWrite: false, allowShellExecution: false, allowComputerAccess: false,
        },
        shellExecution: { approvalMode: "auto" },
      },
    },
  },
};

// Port of neo.js:1138-1144 — GET /api/config maps back to the current mode.
export function detectMode(config) {
  const perms = (config && config.tools && config.tools.permissions) || {};
  const approvalMode = String((config && config.tools && config.tools.shellExecution && config.tools.shellExecution.approvalMode) || "auto");
  if (perms.allowShellExecution === false && perms.allowFileWrite === false) return "readonly";
  if (approvalMode === "always") return "approvals";
  return "full";
}

const SEND_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>';
const STEER_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h10M8.5 4.5L12.5 8l-4 3.5"/></svg>';
const DRAFT_KEY = "omniclaw.next.drafts.v1";
const UPLOAD_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "txt", "md", "csv", "json", "log", "mp3", "wav", "m4a", "ogg", "webm"];

function readDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; }
}

function draftKey() {
  return store.get().activeSessionId || `pending:${store.get().workspace.activeId || store.get().workspace.activePath || "default"}`;
}

export function mountComposer(container, opts = {}) {
  const { onSend, onStop } = opts;
  const enterHooks = [];
  const box = h("div", { class: "composer-zone" });
  const island = h("div", { class: "composer" });

  // Row 1: context strip.
  const strip = h("div", { class: "ctx-strip" });
  // Row 2: attach tray + textarea.
  const tray = h("div", { class: "attach-tray", hidden: true });
  const input = h("textarea", { placeholder: "Do anything", rows: "1", "aria-label": "Message" });
  // Row 3: controls.
  const row = h("div", { class: "composer-row" });
  const plusBtn = h("button", {
    class: "icon-btn", type: "button", title: "Add context", "aria-label": "Add context",
    "aria-haspopup": "menu", "aria-expanded": "false", html: icons.plus,
  });
  const modePill = h("button", {
    class: "mode-pill", type: "button", title: "Permission mode (applies to all chats)",
    "aria-haspopup": "menu", "aria-expanded": "false",
  });
  const spacer = h("div", { class: "spacer" });
  const subPill = h("button", {
    class: "model-pill sub-pill", type: "button", title: "Sub-agent model (applies to all chats)",
    "aria-haspopup": "menu", "aria-expanded": "false",
  });
  const modelPill = h("button", {
    class: "model-pill", type: "button", title: "",
    "aria-haspopup": "menu", "aria-expanded": "false",
  });
  const stopBtn = h("button", {
    class: "send-btn stop", type: "button", title: "Stop (Esc)", "aria-label": "Stop",
    html: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="1.5"/></svg>',
    hidden: true,
  });
  const sendBtn = h("button", {
    class: "send-btn", type: "button", title: "Send (Enter)", "aria-label": "Send", html: SEND_SVG,
  });
  row.append(plusBtn, modePill, spacer, subPill, modelPill, stopBtn, sendBtn);
  island.append(strip, tray, input, row);
  box.append(island);
  container.append(box);

  let running = false;
  let mode = detectMode(store.get().config);
  let branch = "";
  // Latest honest context meter for THIS window (fed by thread.js via the
  // "omniclaw:ctx" CustomEvent on every context.usage / auto_compacted).
  // Null until the first run streams — the ring then shows idle state.
  let ringCtx = null;
  let ringBtn = null;
  let agentsCache = null;
  let agentsAt = 0;
  const attachments = [];

  // ── Row 1 strip (real data only) ──
  function paintStrip() {
    strip.innerHTML = "";
    const ws = store.get().workspace;
    // Chat folder pill: the folder THIS thread's agent runs in — the open
    // chat's own stored folder when known, else the selected project. This
    // matches the server-side per-chat bind, not just the sidebar label.
    const sess = (store.get().sessions || []).find((x) => x && x.id === store.get().activeSessionId);
    const chatPath = (sess && sess.workspacePath) || ws.activePath || "";
    const baseName = (p) => String(p || "").split(/[/\\]/).filter(Boolean).pop() || "";
    const chatName = chatPath ? baseName(chatPath) : (ws.activeName || "workspace");
    const differs = Boolean(sess && sess.workspacePath && ws.activePath && sess.workspacePath !== ws.activePath);
    const wsBtn = h("button", {
      class: "ctx-pill", type: "button",
      title: chatPath
        ? `Chat folder: ${chatPath}${differs ? " (differs from selected project — this chat stays in its own folder)" : ""}`
        : "No workspace",
    },
      h("span", { text: "📁" }), h("span", { class: "truncate", text: chatName }),
      h("span", { html: icons.chevronDown }));
    wsBtn.addEventListener("click", () => openWorkspacePicker());
    strip.append(wsBtn);

    const envBtn = h("button", { class: "ctx-pill", type: "button", title: "Execution environment" },
      h("span", { text: "🖥" }), h("span", { text: "Local" }),
      h("span", { html: icons.chevronDown }));
    envBtn.addEventListener("click", () => {
      const body = h("div", null,
        h("button", { class: "pop-item", type: "button", disabled: true },
          h("span", { text: "Local (this machine)" }),
          h("span", { class: "check", html: icons.check })),
        h("div", { class: "pop-label", text: "Remote environments are not supported yet" }));
      openPopover(envBtn, body);
    });
    strip.append(envBtn);

    if (branch) {
      const b = h("span", { class: "ctx-pill static", title: `Branch: ${branch}` },
        h("span", { text: "⑂" }), h("span", { text: branch }));
      strip.append(b);
    }

    const agentId = store.get().agentId || "main";
    if (agentId !== "main" && agentId !== "default") {
      const a = h("button", { class: "ctx-pill", type: "button", title: `Agent: ${agentId}` },
        h("span", { text: "◎" }), h("span", { class: "truncate", text: agentName(agentId) }));
      a.addEventListener("click", () => openPlus("agent"));
      strip.append(a);
    }

    // Goal-ring: circular context meter (Claude Code style). Shows live %
    // of the ACTIVE model window; auto-compaction fires near 96% (server).
    ringBtn = h("button", { class: "ctx-ring", type: "button", "aria-label": "Context usage" });
    ringBtn.addEventListener("click", (e) => { e.stopPropagation(); openCtxPopover(); });
    strip.append(ringBtn);
    paintRing();
  }

  function ringState() {
    const cfg = (store.get().config || {}).provider || {};
    const win = (ringCtx && ringCtx.windowTokens) || Number(cfg.contextTokens) || 0;
    const used = (ringCtx && ringCtx.tokensUsed) || 0;
    const pct = ringCtx ? (Number(ringCtx.percentFull) || 0)
      : 0;
    const model = (ringCtx && ringCtx.model) || cfg.model || "";
    const src = (ringCtx && ringCtx.windowSource) || (cfg.contextTokens ? "model" : "");
    return { win, used, pct, model, src, auto: Boolean(ringCtx && ringCtx.autoCompacted) };
  }

  function paintRing() {
    if (!ringBtn) return;
    const s = ringState();
    const pct = Math.max(0, Math.min(100, s.pct));
    const C = 2 * Math.PI * 9;
    const off = C - (C * pct) / 100;
    const hot = pct >= 90 ? "hot" : pct >= 70 ? "warn" : "";
    ringBtn.className = `ctx-ring${hot ? ` ${hot}` : ""}`;
    ringBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">`
      + `<circle cx="11" cy="11" r="9" fill="none" stroke="var(--line-soft)" stroke-width="2.5"/>`
      + `<circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" `
      + `stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 11 11)"/>`
      + `</svg><span class="ctx-ring-pct">${s.win ? `${Math.round(pct)}` : "·"}</span>`;
    const usedK = s.used ? `${(s.used / 1000).toFixed(1)}k` : "0k";
    const winK = s.win ? `${Math.round(s.win / 1000)}k` : "—";
    ringBtn.title = s.win
      ? `Context ${usedK} / ${winK} tokens (${Math.round(pct)}% of ${s.model || "active model"}${s.src === "model" ? ", model window" : ""})${s.auto ? " · auto-compacted" : ""} — click for breakdown`
      : "Context idle — usage appears here while the agent works";
    ringBtn.setAttribute("aria-label", ringBtn.title);
  }

  function openCtxPopover() {
    const s = ringState();
    const pct = Math.round(Math.max(0, Math.min(100, s.pct)));
    const fmtK = (n) => (n ? `${(n / 1000).toFixed(1)}k` : "—");
    const body = h("div", null,
      h("div", { class: "pop-label", text: "Context window" }),
      h("div", { class: "ctx-pop-line", text: s.win ? `${fmtK(s.used)} / ${fmtK(s.win)} tokens (${pct}%)` : "No run yet — usage appears while the agent works." }));
    if (s.model) body.append(h("div", { class: "ctx-pop-line muted", text: `Model: ${s.model}${s.src === "model" ? " · live model window" : ""}` }));
    body.append(h("div", { class: "ctx-pop-line muted", text: "Auto-compaction fires near 96% — older turns summarize, recent work stays." }));
    if (s.auto) body.append(h("div", { class: "ctx-pop-line", text: "Last update followed an auto-compaction." }));
    openPopover(ringBtn, body);
  }

  function agentName(id) {
    const found = (agentsCache || []).find((a) => a.id === id);
    return (found && (found.name || found.id)) || id;
  }

  // Phase 4 §8: branch pill from GET /api/git/status (B1), refreshed with review.
  async function refreshBranch() {
    const path = store.get().workspace.activePath;
    if (!path) { branch = ""; paintStrip(); return; }
    try {
      const g = await gitStatus();
      const next = g && g.isRepo ? (g.branch || "") : "";
      if (next !== branch) { branch = next; paintStrip(); }
    } catch {
      try {
        // Old servers without /api/git/*: fall back to the legacy endpoint.
        const g = await getGit();
        const next = g && g.isRepo ? (g.current || "") : "";
        if (next !== branch) { branch = next; paintStrip(); }
      } catch {
        if (branch) { branch = ""; paintStrip(); }
      }
    }
  }

  // ── Mode pill ──
  function paintPill() {
    const m = MODES[mode] || MODES.full;
    modePill.innerHTML = "";
    modePill.append(
      h("span", { html: icons[m.icon] }),
      h("span", { text: m.label }),
      h("span", { html: icons.chevronDown }),
    );
  }

  function openModeMenu() {
    const body = h("div", null);
    for (const [key, m] of Object.entries(MODES)) {
      const b = h("button", {
        class: "pop-item mode-row", role: "menuitemradio",
        "aria-checked": String(mode === key),
      });
      const ic = h("span", { html: icons[m.icon] });
      const tx = h("span", { class: "mode-text" },
        h("strong", { text: m.label }), h("small", { text: m.desc }));
      b.append(ic, tx);
      if (mode === key) b.append(h("span", { class: "check", html: icons.check }));
      b.addEventListener("click", () => applyMode(key));
      body.append(b);
    }
    body.append(h("div", { class: "pop-sep" }));
    body.append(h("div", { class: "pop-label", text: "Applies to all chats" }));
    openPopover(modePill, body);
  }

  async function applyMode(key) {
    if (!MODES[key] || key === mode) { closePopover(); return; }
    const prev = mode;
    const prevTools = store.get().config?.tools;
    mode = key;
    paintPill();
    closePopover();
    try {
      await setConfig(MODES[key].config);
    } catch (e) {
      mode = prev;
      paintPill();
      toast(`Mode change failed: ${e.message}`, "error");
      return;
    }
    try {
      const cfg = await getConfig();
      store.set({ config: cfg || {} });
      mode = detectMode(store.get().config);
    } catch {
      const tools = JSON.parse(JSON.stringify(prevTools || {}));
      tools.permissions = { ...(tools.permissions || {}), ...MODES[key].config.tools.permissions };
      tools.shellExecution = { ...(tools.shellExecution || {}), ...MODES[key].config.tools.shellExecution };
      store.set({ config: { ...store.get().config, tools } });
      mode = key;
    }
    paintPill();
  }

  modePill.addEventListener("click", (e) => { e.stopPropagation(); openModeMenu(); });

  // ── Model pill ──
  function paintModel() {
    // Boot race: config arrives after first paint — show Loading, never a
    // stale "Choose model" that implies nothing is configured.
    const cfg = store.get().config || {};
    const loaded = !!(cfg.provider && (cfg.provider.model || cfg.provider.baseUrl || Object.keys(cfg.providerProfiles || {}).length));
    modelPill.innerHTML = "";
    modelPill.append(
      loaded ? modelMark(cfg.provider.model) : h("span", { class: "model-mark brand-custom", text: "…" }),
      h("span", { class: "truncate", text: loaded ? pillText() : "Loading…" }),
      h("span", { html: icons.chevronDown }));
    modelPill.title = loaded ? pillTitle() : "Loading providers…";
  }

  modelPill.addEventListener("click", (e) => {
    e.stopPropagation();
    openModelMenu(modelPill, (busy) => modelPill.classList.toggle("busy", !!busy), { running });
  });

  // ── Sub-agent model pill (D3) ──
  // Default reads "Inherit from main" (parent's full binding: endpoint AND
  // model). Explicit options come from saved profiles; registry-retired ids
  // are shown struck-out and disabled (D4), never selectable.
  function subModel() {
    const m = String(store.get().config?.runtime?.subAgents?.model || "").trim();
    return (!m || m.toLowerCase() === "inherit" || m.toLowerCase() === "auto") ? "" : m;
  }
  function paintSub() {
    const cur = subModel();
    subPill.innerHTML = "";
    subPill.append(
      h("span", { class: "model-mark brand-custom", text: "S" }),
      h("span", { class: "truncate", text: cur ? `Sub: ${cur}` : "Sub: Inherit" }),
      h("span", { html: icons.chevronDown }));
    subPill.title = cur
      ? `Sub-agents run on ${cur} (click to change; endpoint travels with the model)`
      : "Sub-agents inherit the main model + endpoint (click to change)";
  }
  function openSubMenu() {
    const cfg = store.get().config || {};
    const profiles = cfg.providerProfiles || {};
    const cur = subModel();
    getModelRegistry().catch(() => ({})).then((reg) => {
      const states = (reg && reg.models) || {};
      const body = h("div", null, h("div", { class: "pop-label", text: "Sub-agent model" }));
      const addRow = ({ value, label, hint, checked, disabled, disabledHint }) => {
        const b = h("button", {
          class: "pop-item", role: "menuitemradio", "aria-checked": String(!!checked),
          ...(disabled ? { disabled: true } : {}),
        }, h("span", { class: "truncate", text: label }));
        b.title = disabled ? (disabledHint || hint || label) : (hint || label);
        if (checked) b.append(h("span", { class: "check", html: icons.check }));
        if (disabled) b.classList.add("is-disabled");
        if (!disabled) {
          b.addEventListener("click", async () => {
            closePopover();
            try {
              await setSubAgentModel(value);
              const fresh = await getConfig();
              store.set({ config: fresh || {} });
              paintSub();
              toast(value === "inherit" ? "Sub-agents inherit the main binding" : `Sub-agent model: ${value}`, "success");
            } catch (e) {
              toast(`Sub-agent model failed: ${e.message}`, "error");
            }
          });
        }
        body.append(b);
      };
      addRow({ value: "inherit", label: "Inherit from main", hint: "Endpoint AND model follow the parent run (default)", checked: !cur });
      const seen = new Set();
      const consider = (id, base, via) => {
        const mid = String(id || "").trim();
        if (!mid || seen.has(mid)) return;
        seen.add(mid);
        const key = `${String(base || "").trim().replace(/\/+$/, "").toLowerCase()}::${mid}`;
        const st = states[key];
        const retired = Boolean(st && (st.retired || st.status === "retired"));
        addRow({
          value: mid, label: mid, hint: `${via}${st && st.status ? ` · registry: ${st.status}` : ""}`,
          checked: cur === mid, disabled: retired,
          disabledHint: retired ? `${mid} is retired on this endpoint — excluded` : undefined,
        });
      };
      if (cfg.provider && cfg.provider.model) consider(cfg.provider.model, cfg.provider.baseUrl, "main model");
      for (const [pid, p] of Object.entries(profiles)) {
        if (p && p.model) consider(p.model, p.baseUrl, `profile ${pid}`);
      }
      openPopover(subPill, body);
    });
  }
  subPill.addEventListener("click", (e) => { e.stopPropagation(); openSubMenu(); });

  // ── Agents ──
  async function getAgentList() {
    if (agentsCache && Date.now() - agentsAt < 60000) return agentsCache;
    const data = await getAgents();
    agentsCache = (data && data.agents) || [];
    agentsAt = Date.now();
    return agentsCache;
  }

  function openAgentSubmenu(anchor) {
    getAgentList().then((agents) => {
      const body = h("div", null, h("div", { class: "pop-label", text: "Agent" }));
      const current = store.get().agentId || "main";
      for (const a of agents) {
        const label = a.model ? `${a.name || a.id} · ${a.model}` : (a.name || a.id);
        const b = h("button", {
          class: "pop-item", role: "menuitemradio", "aria-checked": String(a.id === current),
        }, h("span", { class: "truncate", text: label }));
        b.title = a.id;
        if (a.id === current) b.append(h("span", { class: "check", html: icons.check }));
        b.addEventListener("click", () => {
          store.set({ agentId: a.id || "main" });
          closePopover();
          paintStrip();
        });
        body.append(b);
      }
      if (!agents.length) body.append(h("div", { class: "pop-label", text: "No agents" }));
      openPopover(anchor, body, { align: "start", child: true, side: "right" });
    }).catch((e) => toast(`Agents failed: ${e.message}`, "error"));
  }

  // ── + menu (only real capabilities; never fake items) ──
  const fileInput = h("input", { type: "file", multiple: true, hidden: true, "aria-hidden": "true" });
  island.append(fileInput);

  function openPlus(section = "") {
    const body = h("div", null);
    const attachBtn = h("button", { class: "pop-item", type: "button" },
      h("span", { html: icons.plus }), h("span", { text: "Attach files/images" }));
    attachBtn.addEventListener("click", () => { closePopover(); fileInput.click(); });
    const agentBtn = h("button", { class: "pop-item", type: "button", "aria-haspopup": "menu" },
      h("span", { html: icons.message }), h("span", { text: `Agent · ${agentName(store.get().agentId || "main")}` }),
      h("span", { html: icons.chevronRight }));
    const newBtn = h("button", { class: "pop-item", type: "button" },
      h("span", { html: icons.plus }), h("span", { text: "New chat in this project" }));
    newBtn.addEventListener("click", () => { closePopover(); window.location.hash = "#/"; });
    const copyBtn = h("button", { class: "pop-item", type: "button" },
      h("span", { html: icons.copy }), h("span", { text: "Copy session id" }));
    const toolsBtn = h("button", { class: "pop-item", type: "button", "aria-haspopup": "menu" },
      h("span", { html: icons.wrench }), h("span", { text: "Tools for this chat" }),
      h("span", { html: icons.chevronRight }));
    copyBtn.addEventListener("click", async () => {
      closePopover();
      const id = store.get().activeSessionId;
      if (!id) { toast("No active session", "error"); return; }
      try { await navigator.clipboard.writeText(id); toast("Session id copied", "success"); }
      catch { toast("Copy failed", "error"); }
    });
    agentBtn.addEventListener("click", () => openAgentSubmenu(agentBtn));
    agentBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); openAgentSubmenu(agentBtn); }
    });
    toolsBtn.addEventListener("click", () => openToolsSubmenu(toolsBtn));
    toolsBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); openToolsSubmenu(toolsBtn); }
    });
    body.append(attachBtn, agentBtn, toolsBtn, newBtn, copyBtn);
    openPopover(plusBtn, body);
    if (section === "agent") openAgentSubmenu(agentBtn);
  }

  // T2.2: per-chat toolset pins (POST /api/sessions/:id/toolsets). The menu
  // builder unions pins with intent detection every run.
  function openToolsSubmenu(anchor) {
    const sets = ((store.get().caps || {}).toolsets) || [];
    const sid = store.get().activeSessionId || "";
    const sess = (store.get().sessions || []).find((s) => s.id === sid);
    const pinned = new Set((sess && sess.pinnedToolsets) || []);
    const body = h("div", null, h("div", { class: "pop-label", text: "Tools for this chat" }));
    if (!sid) {
      body.append(h("div", { class: "pop-label", text: "Open a chat first" }));
    } else if (!sets.length) {
      body.append(h("div", { class: "pop-label", text: "No toolsets (old backend)" }));
    }
    for (const set of sets) {
      const on = pinned.has(set.name);
      const b = h("button", {
        class: "pop-item", role: "menuitemcheckbox", "aria-checked": String(on),
        title: set.description || set.name,
      }, h("span", { class: "truncate", text: set.name }));
      if (on) b.append(h("span", { class: "check", html: icons.check }));
      b.addEventListener("click", async () => {
        const next = new Set(pinned);
        if (next.has(set.name)) next.delete(set.name);
        else next.add(set.name);
        try {
          const res = await pinSessionToolsets(sid, [...next]);
          const list = (res && res.pinnedToolsets) || [...next];
          store.set({ sessions: (store.get().sessions || []).map((s) => (s.id === sid ? { ...s, pinnedToolsets: list } : s)) });
          closePopover();
          toast(next.has(set.name) ? `Pinned ${set.name}` : `Unpinned ${set.name}`, "success");
        } catch (e) {
          toast(`Pin failed: ${e.message}`, "error");
        }
      });
      body.append(b);
    }
    openPopover(anchor, body, { align: "start", child: true, side: "right" });
  }

  plusBtn.addEventListener("click", (e) => { e.stopPropagation(); openPlus(); });

  // ── Attachments (POST /api/uploads, then neo-style text note on send) ──
  function paintTray() {
    tray.innerHTML = "";
    tray.hidden = !attachments.length;
    for (const att of attachments) {
      const chip = h("span", { class: "att-chip" });
      if (att.isImage) {
        const img = h("img", { alt: att.name });
        img.src = `/preview/${att.relPath.split("/").map(encodeURIComponent).join("/")}`;
        chip.append(img);
      } else {
        chip.append(h("span", { text: att.name }));
      }
      const x = h("button", { type: "button", title: `Remove ${att.name}`, "aria-label": `Remove ${att.name}`, text: "×" });
      x.addEventListener("click", () => {
        const i = attachments.indexOf(att);
        if (i !== -1) attachments.splice(i, 1);
        paintTray();
      });
      chip.append(x);
      tray.append(chip);
    }
  }

  async function addFiles(files) {
    for (const file of files || []) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!UPLOAD_EXTS.includes(ext)) {
        toast(`.${ext || "?"} not allowed — images, pdf, text, audio only`, "error");
        continue;
      }
      if (file.size > 9 * 1024 * 1024) {
        toast(`${file.name}: too large (max ~9MB)`, "error");
        continue;
      }
      try {
        const dataBase64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
          fr.onerror = () => reject(new Error("read failed"));
          fr.readAsDataURL(file);
        });
        // backend: server.js:2487 POST /api/uploads {name, dataBase64}
        const res = await uploadFile(file.name, dataBase64);
        attachments.push({ relPath: res.relPath, name: file.name, isImage: res.isImage, bytes: res.bytes });
        paintTray();
      } catch (e) {
        toast(`Upload failed (${file.name}): ${e.message}`, "error");
      }
    }
  }

  fileInput.addEventListener("change", () => {
    addFiles([...fileInput.files]);
    fileInput.value = "";
  });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  island.addEventListener("dragover", (e) => e.preventDefault());
  island.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // ── Draft per session ──
  let draftTimer = null;
  let draftFor = draftKey();
  function saveDraft() {
    try {
      const all = readDrafts();
      all[draftFor] = input.value;
      localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
    } catch {}
  }
  function loadDraft() {
    draftFor = draftKey();
    try {
      input.value = readDrafts()[draftFor] || "";
    } catch { input.value = ""; }
    autogrow();
    paint();
  }

  // ── Send ──
  function autogrow() {
    input.style.height = "auto";
    const max = parseFloat(getComputedStyle(input).lineHeight || "21") * 8 + 4;
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  }

  function paint() {
    const hasText = !!input.value.trim();
    sendBtn.className = `send-btn${running ? " steer" : hasText ? " ready" : ""}`;
    sendBtn.innerHTML = running ? STEER_SVG : SEND_SVG;
    sendBtn.title = running ? "Steer the agent (Enter)" : "Send (Enter)";
    sendBtn.setAttribute("aria-label", running ? "Steer the agent" : "Send");
    sendBtn.disabled = !hasText && !running;
    input.placeholder = running ? "Steer the agent…" : "Do anything";
    stopBtn.hidden = !running;
  }

  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    saveDraftSoon(true);
    autogrow();
    paint();
    onSend && onSend(text);
  }

  function saveDraftSoon(now) {
    clearTimeout(draftTimer);
    if (now) { saveDraft(); return; }
    draftTimer = setTimeout(saveDraft, 300);
  }

  sendBtn.addEventListener("click", doSend);
  stopBtn.addEventListener("click", () => onStop && onStop());
  input.addEventListener("input", () => { autogrow(); paint(); saveDraftSoon(false); });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doSend();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Slash/mention menus consume Enter first (their own ordering).
      for (const hook of enterHooks) {
        try {
          if (hook && hook.handleEnter && hook.handleEnter()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        } catch {}
      }
      e.preventDefault();
      doSend();
    }
  });

  let branchFor = "";
  store.subscribe(() => {
    const next = detectMode(store.get().config);
    if (next !== mode && document.activeElement !== modePill) {
      mode = next;
      paintPill();
    }
    paintStrip();
    paintModel();
    paintSub();
    const wsPath = store.get().workspace.activePath || "";
    if (wsPath !== branchFor) {
      branchFor = wsPath;
      refreshBranch();
    }
    // Session switch → swap draft.
    const k = draftKey();
    if (k !== draftFor && document.activeElement !== input) {
      saveDraft();
      loadDraft();
    }
  });

  // Branch follows runs (review refreshes the same way).
  window.addEventListener("oc:run-done", refreshBranch);
  // Live context meter from the active thread (thread.js dispatches it on
  // every context.usage / auto_compacted record — no polling, no new route).
  window.addEventListener("omniclaw:ctx", (e) => {
    const d = (e && e.detail) || {};
    if (!Number.isFinite(Number(d.windowTokens))) return;
    ringCtx = {
      tokensUsed: Number(d.tokensUsed) || 0,
      windowTokens: Number(d.windowTokens) || 0,
      percentFull: Number(d.percentFull) || 0,
      windowSource: d.windowSource || "",
      model: d.model || "",
      autoCompacted: Boolean(d.autoCompacted),
    };
    paintRing();
  });

  paintStrip();
  paintPill();
  paintModel();
  paintSub();
  loadDraft();
  refreshBranch();

  return {
    textarea: input,
    addEnterHook(hook) { enterHooks.push(hook); },
    setRunning(r) { running = !!r; paint(); },
    setPulse(on) { island.classList.toggle("pulse", !!on); },
    setText(t) { input.value = t || ""; saveDraftSoon(true); autogrow(); paint(); },
    focus() { input.focus(); },
    get running() { return running; },
    getMode: () => mode,
    refreshMode() { mode = detectMode(store.get().config); paintPill(); },
    openPlus,
    drainAttachments() { return attachments.splice(0, attachments.length); },
  };
}
