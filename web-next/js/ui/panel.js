// Right panel: browser-like tabs (Review · Files · Terminal · Browser ·
// Walkthrough). Shortcut menu when empty; "+" reopens it. Tabs + active +
// width persisted per workspaceId. Ctrl+Shift+G / Ctrl+E / Ctrl+` / Ctrl+T /
// Ctrl+Alt+W open/focus; on the open tab the shortcut toggles the panel.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import * as api from "../api.js";
import { openPopover, closePopover } from "./popover.js";
import { mountReviewTab } from "../panel/review.js";
import { mountFilesTab } from "../panel/files.js";
import { mountTerminalTab } from "../panel/terminal.js";
import { mountBrowserTab } from "../panel/browser.js";
import { mountWalkthroughTab } from "../panel/walkthrough.js";

const TAB_DEFS = [
  { kind: "review", label: "Review", icon: "diff", key: "Ctrl+Shift+G" },
  { kind: "files", label: "Files", icon: "folder", key: "Ctrl+E" },
  { kind: "terminal", label: "Terminal", icon: "terminal", key: "Ctrl+`" },
  { kind: "browser", label: "Browser", icon: "globe", key: "Ctrl+T" },
  { kind: "walkthrough", label: "Walkthrough", icon: "pencil", key: "Ctrl+Alt+W" },
];

const MOUNT = {
  review: mountReviewTab,
  files: mountFilesTab,
  terminal: mountTerminalTab,
  browser: mountBrowserTab,
  walkthrough: mountWalkthroughTab,
};

const LS_KEY = "ocPanelTabs.v1";
let tabSeq = 0;

// U1(a): the Browser tab is offered only when the backend speaks the managed
// surface (caps.browser.managed, 4B.2). Old servers never see it.
function supportedTabs() {
  const caps = (store.get() && store.get().caps) || {};
  const managed = caps.browser && caps.browser.managed === true;
  return TAB_DEFS.filter((d) => d.kind !== "browser" || managed);
}

function readPersisted() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

function wsKey() {
  return (store.get().workspace && store.get().workspace.activeId) || "default";
}

export function mountPanel(root) {
  root.innerHTML = "";
  root.className = "panel";
  const s = store.get();
  root.style.width = `${s.panel.width}px`;
  document.documentElement.style.setProperty("--panel-w", `${s.panel.width}px`);

  const grip = h("div", { class: "panel-resize", title: "Resize panel", "aria-hidden": "true" });
  const tabsEl = h("div", { class: "panel-tabs", role: "tablist", "aria-label": "Panel tabs" });
  const host = h("div", { class: "panel-host" });
  root.append(grip, tabsEl, host);

  let tabs = [];
  let activeId = null;
  let mounted = null; // {id, kind, unmount, update, arg}

  function persist() {
    try {
      const all = readPersisted();
      all[wsKey()] = { tabs: tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title, arg: t.arg || null })), activeId };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch {}
  }

  function ctx() {
    return {
      workspace: store.get().workspace,
      caps: store.get().caps,
      api,
      sse: null, // panel follows runs via oc:* CustomEvents, not its own streams
      store,
      activeSessionId: store.get().activeSessionId,
      panel: api2panel(),
    };
  }

  function api2panel() {
    return {
      openFiles: (path) => openTab("files", { path }),
      openReview: (path) => openTab("review", { path }),
      openTerminal: (command) => openTab("terminal", { command }),
      openBrowser: (shot) => openTab("browser", { shot }),
    };
  }

  function titleFor(kind, arg) {
    const def = TAB_DEFS.find((d) => d.kind === kind);
    const base = def ? def.label : kind;
    if (kind === "files" && arg && arg.path) {
      const parts = String(arg.path).split(/[/\\]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : base;
    }
    return base;
  }

  function paintStrip() {
    tabsEl.innerHTML = "";
    for (const t of tabs) {
      const def = TAB_DEFS.find((d) => d.kind === t.kind) || {};
      const b = h("button", {
        class: `panel-tab${t.id === activeId ? " active" : ""}`,
        type: "button", role: "tab", "aria-selected": String(t.id === activeId),
        title: t.title,
      }, h("span", { html: icons[def.icon] || icons.more }),
        h("span", { class: "truncate", text: t.title }));
      b.addEventListener("click", () => focusTab(t.id));
      const x = h("button", { class: "panel-x", type: "button", title: "Close tab", "aria-label": `Close ${t.title}`, text: "×" });
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
      const wrap = h("span", { class: "panel-tabwrap" }, b, x);
      tabsEl.append(wrap);
    }
    const plus = h("button", { class: "panel-tab plus", type: "button", title: "Open tab", "aria-label": "Open tab", text: "+" });
    plus.addEventListener("click", (e) => { e.stopPropagation(); openShortcutMenu(plus); });
    tabsEl.append(plus);
  }

  function unmountCurrent() {
    if (mounted) {
      try { mounted.unmount(); } catch {}
      mounted = null;
    }
    host.innerHTML = "";
  }

  function focusTab(id, arg) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (arg !== undefined) t.arg = { ...(t.arg || {}), ...arg };
    activeId = id;
    persist();
    paintStrip();
    unmountCurrent();
    const mount = MOUNT[t.kind];
    if (!mount) {
      host.append(h("div", { class: "panel-empty", text: "Unknown tab." }));
      return;
    }
    const el = h("div", { class: "panel-page" });
    host.append(el);
    const c = ctx();
    mounted = { id, kind: t.kind, ...(mount(el, c, t.arg || {}) || {}) };
    try { mounted.update && mounted.update({ ...c, arg: t.arg || {} }); } catch {}
  }

  function openTab(kind, arg = {}) {
    // Same kind+arg focuses instead of duplicating.
    const key = JSON.stringify(arg || {});
    const existing = tabs.find((t) => t.kind === kind && JSON.stringify(t.arg || {}) === key);
    store.setPanel({ open: true });
    if (existing) {
      focusTab(existing.id, arg);
      return existing.id;
    }
    const id = `tab-${++tabSeq}`;
    tabs.push({ id, kind, title: titleFor(kind, arg), arg });
    focusTab(id);
    persist();
    return id;
  }

  function closeTab(id) {
    tabs = tabs.filter((t) => t.id !== id);
    if (activeId === id) {
      activeId = tabs.length ? tabs[tabs.length - 1].id : null;
    }
    persist();
    paintStrip();
    if (!tabs.length) {
      unmountCurrent();
      showMenu();
    } else if (activeId) {
      focusTab(activeId);
    }
  }

  function openShortcutMenu(anchor) {
    const body = h("div", null);
    for (const sc of supportedTabs()) {
      const btn = h("button", { class: "shortcut-row", type: "button" },
        h("span", { html: icons[sc.icon] || icons.more }),
        h("span", { text: sc.label }),
        h("kbd", { text: sc.key }));
      btn.addEventListener("click", () => {
        closePopover();
        openTab(sc.kind);
      });
      body.append(btn);
    }
    openPopover(anchor, body, { align: "end" });
  }

  function showMenu() {
    host.innerHTML = "";
    const menu = h("div", { class: "panel-shortcuts" });
    for (const sc of supportedTabs()) {
      const btn = h("button", { class: "shortcut-row", type: "button" },
        h("span", { html: icons[sc.icon] || icons.more }),
        h("span", { text: sc.label }),
        h("kbd", { text: sc.key }));
      btn.addEventListener("click", () => openTab(sc.kind));
      menu.append(btn);
    }
    host.append(menu);
  }

  // Restore per-workspace tabs (only kinds that still exist).
  try {
    const saved = readPersisted()[wsKey()];
    if (saved && Array.isArray(saved.tabs)) {
      tabs = saved.tabs.filter((t) => MOUNT[t.kind]).slice(0, 8);
      for (const t of tabs) {
        const n = Number(String(t.id).split("-")[1]);
        if (Number.isFinite(n)) tabSeq = Math.max(tabSeq, n);
      }
      if (saved.activeId && tabs.some((t) => t.id === saved.activeId)) {
        activeId = saved.activeId;
      }
    }
  } catch {}

  paintStrip();
  if (tabs.length && activeId) focusTab(activeId);
  else showMenu();

  // Workspace switch → load that workspace's tabs.
  let lastWs = wsKey();
  let lastCapsManaged = null;
  store.subscribe(() => {
    // Caps arrive after first paint (cold boot); the shortcut menu is static,
    // so repaint it when managed-browser support becomes known.
    const capsNow = (store.get().caps && store.get().caps.browser && store.get().caps.browser.managed) || false;
    if (capsNow !== lastCapsManaged) {
      const becameManaged = capsNow && !lastCapsManaged;
      lastCapsManaged = capsNow;
      if (!tabs.length) {
        paintStrip();
        unmountCurrent();
        showMenu();
      } else if (becameManaged) {
        // The Browser tab may have mounted into its "checking support…" or
        // "needs a newer backend" state while caps were still in flight.
        // Remount it now that the real answer is known, otherwise a perfectly
        // capable backend keeps showing the unsupported notice for the whole
        // session with no way to recover.
        const active = tabs.find((t) => t.id === activeId);
        if (active && active.kind === "browser") focusTab(activeId);
      }
    }
    const k = wsKey();
    if (k === lastWs) return;
    lastWs = k;
    tabs = [];
    activeId = null;
    try {
      const saved = readPersisted()[k];
      if (saved && Array.isArray(saved.tabs)) {
        tabs = saved.tabs.filter((t) => MOUNT[t.kind]).slice(0, 8);
        if (saved.activeId && tabs.some((t) => t.id === saved.activeId)) activeId = saved.activeId;
      }
    } catch {}
    paintStrip();
    if (tabs.length && activeId) focusTab(activeId);
    else { unmountCurrent(); showMenu(); }
    persist();
  });

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const mod = e.ctrlKey || e.metaKey;
    // All tab chords carry Ctrl/Meta/Alt (never plain typing keys), so they
    // must ALSO fire from inside the composer textarea — the most common
    // context. Only unmodified keys defer to inputs. AltGraph (compose key)
    // is excluded so international layouts keep typing special chars.
    if (e.getModifierState && e.getModifierState("AltGraph")) return;
    if (!mod && !e.altKey) {
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      return;
    }
    const jump = (kind) => {
      // U1(a): no Browser tab without the managed backend.
      if (kind === "browser" && !supportedTabs().some((d) => d.kind === "browser")) return;
      const cur = tabs.find((x) => x.id === activeId);
      if (store.get().panel.open && cur && cur.kind === kind) {
        store.setPanel({ open: false }); // toggle on the open tab
      } else {
        openTab(kind);
      }
    };
    // Spec chords first. Chrome reserves Ctrl+T/E/N at browser level, so each
    // tab also answers an Alt-based mirror that browsers always deliver.
    const k = (e.key || "").toLowerCase();
    if ((mod && e.shiftKey && k === "g") || (e.altKey && !mod && k === "g")) { e.preventDefault(); jump("review"); }
    else if ((mod && !e.shiftKey && !e.altKey && (k === "e" || e.key === "`")) || (e.altKey && !mod && (k === "e" || e.key === "`"))) {
      e.preventDefault();
      jump(e.key === "`" ? "terminal" : "files");
    } else if ((mod && !e.shiftKey && !e.altKey && k === "t") || (e.altKey && !mod && k === "t")) { e.preventDefault(); jump("browser"); }
    else if ((mod && e.altKey && k === "w") || (e.altKey && !mod && k === "w")) { e.preventDefault(); jump("walkthrough"); }
  });

  // Drag handle: clamp 30%–60% of viewport width, persist via store.
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.classList.add("dragging");
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const w = window.innerWidth - ev.clientX;
      const min = Math.round(window.innerWidth * 0.3);
      const max = Math.round(window.innerWidth * 0.6);
      const clamped = Math.max(200, Math.min(800, Math.max(min, Math.min(max, w))));
      store.setPanel({ width: clamped });
      root.style.width = `${clamped}px`;
      document.documentElement.style.setProperty("--panel-w", `${clamped}px`);
    };
    const up = () => {
      grip.classList.remove("dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  return {
    open: (kind, arg) => openTab(kind, arg || {}),
    focus: (id) => focusTab(id),
    close: () => store.setPanel({ open: false }),
  };
}
