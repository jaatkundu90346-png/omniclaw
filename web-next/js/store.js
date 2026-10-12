// Pub/sub store. Persist theme/sidebarOpen/panel to localStorage "omniclaw.next.v1".

const LS_KEY = "omniclaw.next.v1";

// Appearance preferences (Settings → Appearance). Versioned + validated;
// invalid/outdated values recover to defaults. Fonts are local system stacks
// only — nothing is downloaded, nothing unavailable is advertised.
export const APPEARANCE_DEFAULTS = {
  v: 1,
  preset: "neutral", // neutral | ocean | grove | ember | iris | rose
  contrast: "standard", // standard | high — text/border emphasis, never a global dim
  opacity: 100, // 85–100 — translucent menus/dialogs/composer only, text stays solid
  uiFont: "system", // system | segoe | arial | georgia
  uiSize: 14, // 12–16px interface type
  monoFont: "cascadia", // cascadia | consolas | lucida
  monoSize: 12.5, // 11–15px code type
  wrapCode: false, // code blocks (terminal excluded — wraps on its own rules)
  wrapDiff: false, // diff views
  wrapFiles: true, // file previews
};

export const UI_FONTS = {
  system: { label: "System default", stack: `-apple-system, "Segoe UI", system-ui, Roboto, Arial, sans-serif` },
  segoe: { label: "Segoe UI", stack: `"Segoe UI", system-ui, Arial, sans-serif` },
  arial: { label: "Arial", stack: `Arial, Helvetica, sans-serif` },
  georgia: { label: "Georgia", stack: `Georgia, "Times New Roman", serif` },
};

export const MONO_FONTS = {
  cascadia: { label: "Cascadia Mono", stack: `"Cascadia Mono", Consolas, monospace` },
  consolas: { label: "Consolas", stack: `Consolas, "Cascadia Mono", monospace` },
  lucida: { label: "Lucida Console", stack: `"Lucida Console", Consolas, monospace` },
};

const APPEARANCE_ENUMS = {
  preset: ["neutral", "ocean", "grove", "ember", "iris", "rose"],
  contrast: ["standard", "high"],
  uiFont: Object.keys(UI_FONTS),
  monoFont: Object.keys(MONO_FONTS),
};

export function validateAppearance(raw) {
  const out = { ...APPEARANCE_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(APPEARANCE_ENUMS)) {
    if (APPEARANCE_ENUMS[key].includes(raw[key])) out[key] = raw[key];
  }
  const num = (v, min, max, fb) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fb);
  out.opacity = num(raw.opacity, 85, 100, 100);
  out.uiSize = num(raw.uiSize, 12, 16, 14);
  out.monoSize = num(raw.monoSize, 11, 15, 12.5);
  for (const key of ["wrapCode", "wrapDiff", "wrapFiles"]) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  out.v = 1;
  return out;
}

const state = {
  theme: "dark", // dark | light | system
  agentId: "main", // per-message agent (chat body carries it); default "main" (neo.js:12)
  showSystem: false, // P4: hide non-webchat sessions (heartbeat/cron) by default
  collapsedProjects: {}, // P4: wsId -> true (persisted)
  fontSize: 13.5, // legacy (migrated into appearance.uiSize on load)
  appearance: { ...APPEARANCE_DEFAULTS },
  caps: null, // Phase 4: GET /api/capabilities (null = old server, all B1 false)
  sidebarOpen: true,
  panel: { open: true, width: 320, tabs: [], activeTab: null },
  workspace: { activePath: "", activeId: "", activeName: "", recents: [], isDefault: true },
  sessions: [],
  activeSessionId: "",
  // 4B.1: global approvals summary (approvals.js pushes; sidebar dot reads it).
  appr: { count: 0, qcount: 0, bySession: {}, updated: 0 },
  gateway: { ok: null, text: "Connecting…", agents: 0, cron: 0, version: "", model: "" },
  config: {},
};

const listeners = new Set();

function loadPersisted() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.theme) state.theme = saved.theme;
    if (typeof saved.agentId === "string" && saved.agentId) state.agentId = saved.agentId;
    if (typeof saved.showSystem === "boolean") state.showSystem = saved.showSystem;
    if (saved.collapsedProjects && typeof saved.collapsedProjects === "object") {
      state.collapsedProjects = saved.collapsedProjects;
    }
    if ([13, 14, 15].includes(Number(saved.fontSize))) state.fontSize = Number(saved.fontSize);
    state.appearance = validateAppearance(saved.appearance);
    // One-way migration: a legacy fontSize becomes the canonical uiSize.
    if (!saved.appearance && [13, 14, 15].includes(Number(saved.fontSize))) {
      state.appearance.uiSize = Number(saved.fontSize);
    }
    if (typeof saved.sidebarOpen === "boolean") state.sidebarOpen = saved.sidebarOpen;
    if (saved.panel && typeof saved.panel === "object") {
      if (typeof saved.panel.open === "boolean") state.panel.open = saved.panel.open;
      if (Number.isFinite(saved.panel.width)) {
        state.panel.width = Math.min(800, Math.max(200, saved.panel.width));
      }
    }
  } catch { /* corrupted storage: ignore */ }
}

function persist() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ theme: state.theme, agentId: state.agentId, showSystem: state.showSystem, collapsedProjects: state.collapsedProjects, fontSize: state.appearance.uiSize, appearance: state.appearance, sidebarOpen: state.sidebarOpen, panel: { open: state.panel.open, width: state.panel.width } }),
    );
  } catch { /* private mode etc. */ }
}

export const store = {
  get() { return state; },

  // Shallow-merge patch, notify, persist the persistent slice.
  set(patch) {
    Object.assign(state, patch);
    persist();
    for (const fn of listeners) {
      try { fn(state); } catch (e) { console.error(e); }
    }
  },

  setPanel(patch) {
    Object.assign(state.panel, patch);
    this.set({});
  },

  setWorkspace(ws) {
    state.workspace = { ...state.workspace, ...ws };
    this.set({});
  },

  // Appearance patch: validated merge, applied + persisted immediately.
  setAppearance(patch) {
    state.appearance = validateAppearance({ ...state.appearance, ...(patch || {}) });
    applyAppearance();
    this.set({});
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function applyTheme() {
  const pref = state.theme || "dark";
  let resolved = pref;
  if (pref === "system") {
    resolved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = resolved;
}

export function applyFontSize() {
  const a = store.get().appearance || {};
  document.documentElement.style.setProperty("--fs", `${a.uiSize || store.get().fontSize || 13.5}px`);
}

// Applies the whole appearance slice: preset/contrast datasets (CSS owns the
// palettes), translucency flag, font stacks + sizes, word-wrap classes.
// Called at boot (before first paint where possible) and on every change.
export function applyAppearance() {
  const a = validateAppearance(store.get().appearance);
  const root = document.documentElement;
  root.dataset.preset = a.preset;
  root.dataset.contrast = a.contrast;
  root.style.setProperty("--font", (UI_FONTS[a.uiFont] || UI_FONTS.system).stack);
  root.style.setProperty("--font-mono", (MONO_FONTS[a.monoFont] || MONO_FONTS.cascadia).stack);
  root.style.setProperty("--fs-mono", `${a.monoSize}px`);
  if (a.opacity < 100) {
    root.dataset.translucent = "1";
    root.style.setProperty("--sur-alpha", String(a.opacity / 100));
  } else {
    delete root.dataset.translucent;
    root.style.removeProperty("--sur-alpha");
  }
  root.classList.toggle("wrap-code", !!a.wrapCode);
  root.classList.toggle("wrap-diff", !!a.wrapDiff);
  root.classList.toggle("wrap-files", !!a.wrapFiles);
  applyFontSize();
}

export function initStore() {
  loadPersisted();
}

// Session helpers (C3): sidebar "running" dot from activeRunId.
export function isSessionRunning(session) {
  return session && session.activeRunId != null;
}
