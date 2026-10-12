// Browser tab (4B.3, Codex look) on the 4B.2 managed routes.
// Routes (server.js managed block, all loopback-only):
//   GET  /api/browser/status → {running, profileDir, tabsCount, chromeVersion}
//   POST /api/browser/launch {} → {running, reused, port, tabs, chromePath}
//   GET  /api/browser/tabs → {tabs:[{id,title,url,active,attached,favicon:null}]}
//   POST /api/browser/tabs {url} → {tab} · :id/activate|close|navigate|back|
//        forward|reload · GET :id/stream (SSE frames) · POST :id/input
//   POST /api/system/reveal {path} (B1) for "Open profile folder".
// Action feed: GET SSE /api/browser/live replays 8 + streams live `action`
//   messages carrying the B6 tabId+label (server.js:3198 via onBrowserAction).
//   It is the ONLY carrier of CDP action events — gateway /api/events only
//   sees the coarse `browser.operation` Hermes records (tool-registry.js:6160,
//   no tabId). The feed's screencast is ignored here (own per-tab stream).
// Screenshots: NO route serves shot files (os.tmpdir, outside /preview), so a
//   static shot shows path + "Open in Files" unless shot.url is http(s)/data:.
// Host/port override (⚙) rides the 4B.2 ?host=&port= query / body fields
//   (server.js bHost/bPort) — no old attach route exists (attach was tool-only).

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import { openPopover, closePopover } from "../ui/popover.js";
import { toast } from "../ui/toast.js";

const POLL_MS = 2000;
const AGENT_FRESH_MS = 3000;
const MOVE_THROTTLE_MS = 33;
const LS_KEY = "ocBrowserUI.v1";

function readPersisted() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
}

function wsKey(ctx) {
  return (ctx.workspace && (ctx.workspace.activeId || ctx.workspace.activePath)) || "default";
}

function hostnameOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "about:") return "New tab";
    return u.host || String(url || "").slice(0, 40) || "New tab";
  } catch {
    return String(url || "").slice(0, 40) || "New tab";
  }
}

function clockOf(iso) {
  const d = new Date(iso || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function bFetch(path, { method = "GET", body, ep } = {}) {
  let url = `/api/browser${path}`;
  let payload = body;
  if (ep && (ep.host || ep.port)) {
    if (payload !== undefined) {
      payload = { ...payload, ...(ep.host ? { host: ep.host } : {}), ...(ep.port ? { port: ep.port } : {}) };
    } else {
      const q = new URLSearchParams({
        ...(ep.host ? { host: ep.host } : {}),
        ...(ep.port ? { port: String(ep.port) } : {}),
      }).toString();
      url += (url.includes("?") ? "&" : "?") + q;
    }
  }
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.hint)) || `HTTP ${res.status} for ${path}`);
    err.code = data && data.code;
    err.hint = data && data.hint;
    err.status = res.status;
    throw err;
  }
  return data;
}

export function mountBrowserTab(el, ctx, arg = {}) {
  el.innerHTML = "";
  // U1(a): the managed surface is optional. BUT caps arrive ASYNCHRONOUSLY
  // (main.js fetches /api/capabilities after first paint), so at mount time
  // `caps` is legitimately still null. The old code treated that as "backend
  // too old", rendered the notice and returned for good — which is why a fully
  // capable server still showed "Browser needs a newer backend" on every cold
  // boot, with no way to recover.
  //
  // So: "not known yet" and "known not supported" are different states. The
  // first waits for the answer, the second stays permanent.
  const managedNow = () => {
    const c = (ctx && ctx.caps) || store.get().caps || {};
    return Boolean(c.browser && c.browser.managed === true);
  };
  const noteEl = (text) => el.append(h("div", { class: "panel-empty", text }));

  if (!managedNow()) {
    // No capability data at all yet → wait for it rather than declaring the
    // backend unsupported.
    if (!(store.get().caps || (ctx && ctx.caps))) {
      noteEl("Checking browser support…");
      let disposed = false;
      const unsubscribe = store.subscribe(() => {
        if (disposed) return;
        if (!managedNow()) return;         // still unknown, or genuinely absent
        disposed = true;
        unsubscribe();
        el.innerHTML = "";
        mountBrowserTab(el, ctx, arg);     // now it really does render the UI
      });
      return {
        update() {},
        unmount() { disposed = true; try { unsubscribe(); } catch {} },
      };
    }
    noteEl("Browser needs a newer backend (managed browser support).");
    return { update() {}, unmount() {} };
  }

  const persisted = readPersisted();
  const ws = wsKey(ctx);
  const saved = (persisted && persisted[ws]) || {};
  const persist = (patch) => {
    try {
      const all = readPersisted();
      all[wsKey(ctx)] = { ...((all && all[wsKey(ctx)]) || {}), ...patch };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch {}
  };

  const wrap = h("div", { class: "brw" });
  el.append(wrap);

  const state = {
    dead: false,
    paused: false,
    status: null,
    tabs: [],
    activeId: "",
    ep: null, // {host,port} override from ⚙ (null = managed default)
    stream: null,
    streamTab: "",
    streamFails: 0,
    streamTimer: null,
    actionsES: null,
    pollTimer: null,
    agentAt: 0,
    agentTab: "",
    log: [], // [{at, label, tabId, actor, key}]
    seenActions: new Set(),
    staticShot: (arg && arg.shot) || null,
    drawerOpen: saved.drawerOpen !== false,
    lastMove: 0,
    moveInflight: false,
    launching: false,
    imgW: 0,
    imgH: 0,
  };
  if (saved.lastTabId) state.activeId = saved.lastTabId;

  // ── shared bits ──────────────────────────────────────────────
  const errLine = h("div", { class: "brw-err", hidden: true });
  function showErr(e, sticky) {
    errLine.hidden = false;
    errLine.textContent = String((e && e.message) || e || "Failed");
    if (!sticky) setTimeout(() => { if (!state.dead) errLine.hidden = true; }, 6000);
  }

  function epOf() { return state.ep; }

  async function loadStatus() {
    const st = await bFetch("/status", { ep: epOf() });
    state.status = st;
    return st;
  }

  async function loadTabs() {
    const data = await bFetch("/tabs", { ep: epOf() });
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    // The agent usually drives its OWN Playwright Chromium, not the managed
    // window this panel lists. Without merging those in, the panel shows the
    // managed tabs (often none) while the agent works somewhere invisible —
    // which is exactly "I can't see what it's doing". Agent targets come from
    // the agent-side route and are marked so the streamer knows which endpoint
    // to use for them.
    let agentTabs = [];
    if (!state.ep) {
      try {
        const a = await fetch("/api/browser/agent-targets");
        if (a.ok) {
          const j = await a.json();
          agentTabs = (Array.isArray(j.targets) ? j.targets : []).map((t) => ({
            id: t.id, title: t.title || "", url: t.url || "", active: false, attached: true, favicon: null, agent: true,
          }));
        }
      } catch { /* the agent route is optional; the managed list still stands */ }
    }
    // Managed tabs first (they are the user's own window), agent tabs after.
    state.tabs = [...tabs, ...agentTabs];
    // Reconcile by id: keep order, no flicker (U2).
    if (state.activeId && !state.tabs.some((t) => t.id === state.activeId)) state.activeId = "";
    if (!state.activeId) {
      // Prefer whatever the agent is actively driving — that is what the user
      // opened this panel to watch.
      const fresh = agentTabs.find((t) => Date.now() - (t.lastUsed || 0) < 30000);
      const active = fresh || tabs.find((t) => t.active) || tabs[0] || agentTabs[0];
      if (active) {
        state.activeId = active.id;
        persist({ lastTabId: active.id });
      }
    }
    paintStrip();
    paintToolbar();
    return state.tabs;
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeId) || null;
  }

  // ── empty state / main view ──────────────────────────────────
  const emptyEl = h("div", { class: "brw-empty" });
  emptyEl.append(
    h("span", { class: "brw-empty-ic", html: icons.globe }),
    h("strong", { text: "Start browsing" }),
    h("p", { class: "muted small", text: "Opens a real Chrome window on your OmniClaw profile. Sign in once — it stays signed in." }),
  );
  const openBtn = h("button", { class: "btn primary", type: "button", text: "Open browser" });
  const emptyErr = h("div", { class: "brw-err", hidden: true });
  emptyEl.append(openBtn, emptyErr);
  openBtn.addEventListener("click", async () => {
    if (state.launching) return;
    state.launching = true;
    openBtn.disabled = true;
    openBtn.innerHTML = "";
    openBtn.append(h("span", { html: icons.spinner, class: "spin" }), document.createTextNode(" Starting Chrome…"));
    emptyErr.hidden = true;
    try {
      const r = await bFetch("/launch", { method: "POST", body: {}, ep: epOf() });
      if (r && r.port && state.ep) {
        // Launched elsewhere than the override — follow the managed instance.
        state.ep = null;
      }
      await boot();
    } catch (e) {
      // ENOENT carries the server hint (Chrome path / OMNICLAW_CHROME_PATH).
      emptyErr.hidden = false;
      emptyErr.textContent = e.hint ? `${e.message} — ${e.hint}` : String(e.message || e);
    } finally {
      state.launching = false;
      openBtn.disabled = false;
      openBtn.textContent = "Open browser";
    }
  });

  const mainEl = h("div", { class: "brw-main" }, errLine);
  const stripEl = h("div", { class: "brw-strip", role: "tablist", "aria-label": "Browser tabs" });
  const toolbarEl = h("div", { class: "brw-toolbar" });
  const vpEl = h("div", { class: "brw-vp" });
  const imgEl = h("img", { class: "brw-img", alt: "Browser view" });
  const overlayEl = h("div", { class: "brw-overlay", tabindex: "0", role: "application", "aria-label": "Browser viewport. Click to capture keys, Esc to release." });
  const pillEl = h("div", { class: "brw-pill", text: "Agent is browsing…", hidden: true });
  const staticBadge = h("div", { class: "brw-static", text: "Static screenshot", hidden: true });
  const staticNote = h("div", { class: "brw-static-note", hidden: true });
  vpEl.append(imgEl, overlayEl, pillEl, staticBadge, staticNote);
  const drawerEl = h("div", { class: "brw-drawer" });
  const drawerHead = h("button", { class: "brw-drawer-head", type: "button", "aria-expanded": "true" });
  const drawerList = h("div", { class: "brw-drawer-list" });
  drawerEl.append(drawerHead, drawerList);
  mainEl.append(stripEl, toolbarEl, vpEl, drawerEl);

  function showEmpty(show) {
    emptyEl.remove();
    mainEl.remove();
    wrap.append(show ? emptyEl : mainEl);
  }

  async function boot() {
    let st = null;
    try {
      st = await loadStatus();
    } catch (e) {
      showErr(e, true);
      showEmpty(false);
      return;
    }
    if (!st || !st.running) {
      stopNet();
      showEmpty(true);
      return;
    }
    showEmpty(false);
    try {
      await loadTabs();
    } catch (e) {
      showErr(e, true);
      return;
    }
    startNet();
    if (state.staticShot) showStatic(state.staticShot);
    else if (state.activeId) openStream(state.activeId);
    paintDrawer();
  }

  // ── tab strip (U2) ───────────────────────────────────────────
  function paintStrip() {
    stripEl.innerHTML = "";
    for (const t of state.tabs) {
      const title = t.title || hostnameOf(t.url);
      const b = h("button", {
        class: `brw-tab${t.id === state.activeId ? " active" : ""}`,
        type: "button", role: "tab", "aria-selected": String(t.id === state.activeId),
        title: `${title}\n${t.url || ""}`,
      });
      b.append(h("span", { class: "brw-tab-ic", html: icons.globe }));
      b.append(h("span", { class: "brw-tab-ti", text: title }));
      if (t.id === state.agentTab && Date.now() - state.agentAt < AGENT_FRESH_MS) {
        b.append(h("span", { class: "brw-agent-dot", title: "Agent is using this tab" }));
      }
      const x = h("span", { class: "brw-tab-x", text: "×", title: "Close tab", role: "button", "aria-label": `Close ${title}` });
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
      b.append(x);
      b.addEventListener("click", () => pickTab(t.id));
      b.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
      stripEl.append(b);
    }
    const plus = h("button", { class: "brw-plus", type: "button", text: "+", title: "New tab", "aria-label": "New tab" });
    plus.addEventListener("click", addTab);
    stripEl.append(plus);
  }

  async function addTab() {
    try {
      const r = await bFetch("/tabs", { method: "POST", body: { url: "about:blank" }, ep: epOf() });
      await loadTabs();
      if (r && r.tab && r.tab.id) pickTab(r.tab.id);
      focusUrl();
    } catch (e) { showErr(e); }
  }

  async function closeTab(id) {
    try {
      await bFetch(`/tabs/${encodeURIComponent(id)}/close`, { method: "POST", body: {}, ep: epOf() });
    } catch (e) { showErr(e); }
    const i = state.tabs.findIndex((t) => t.id === id);
    if (state.activeId === id) {
      const rest = state.tabs.filter((t) => t.id !== id);
      const next = rest[Math.min(Math.max(0, i), rest.length - 1)] || null;
      state.activeId = next ? next.id : "";
      persist({ lastTabId: state.activeId });
    }
    try { await loadTabs(); } catch {}
    if (state.activeId) openStream(state.activeId);
    else { closeStream(); imgEl.removeAttribute("src"); }
  }

  function pickTab(id) {
    // User pick clears any static screenshot (U7).
    if (state.staticShot) {
      state.staticShot = null;
      staticBadge.hidden = true;
      staticNote.hidden = true;
      staticNote.innerHTML = "";
      imgEl.removeAttribute("src");
    }
    state.activeId = id;
    persist({ lastTabId: id });
    urlBar.readOnly = false; // static-shot mode (U7) locks the bar; live tabs unlock it
    paintStrip();
    paintToolbar();
    openStream(id);
  }

  // ── toolbar (U3) ─────────────────────────────────────────────
  const backBtn = h("button", { class: "icon-btn", type: "button", title: "Back", "aria-label": "Back", text: "‹" });
  const fwdBtn = h("button", { class: "icon-btn", type: "button", title: "Forward", "aria-label": "Forward", text: "›" });
  const reloadBtn = h("button", { class: "icon-btn", type: "button", title: "Reload", "aria-label": "Reload", html: icons.redo });
  const urlWrap = h("div", { class: "brw-urlwrap" });
  const schemeEl = h("span", { class: "brw-scheme" });
  const urlBar = h("input", { class: "brw-url", type: "text", placeholder: "Search or enter URL", "aria-label": "URL" });
  urlWrap.append(schemeEl, urlBar);
  const liveDot = h("span", { class: "brw-live off", title: "Stream idle" });
  const popBtn = h("button", { class: "icon-btn", type: "button", title: "Show window (raise Chrome)", "aria-label": "Show window", text: "⤢" });
  const gearBtn = h("button", { class: "icon-btn", type: "button", title: "Browser settings", "aria-label": "Browser settings", html: icons.settings });
  toolbarEl.append(backBtn, fwdBtn, reloadBtn, urlWrap, liveDot, popBtn, gearBtn);

  function paintToolbar() {
    const t = activeTab();
    const url = (t && t.url) || "";
    if (document.activeElement !== urlBar) urlBar.value = url;
    schemeEl.innerHTML = "";
    schemeEl.className = "brw-scheme";
    if (/^https:\/\//i.test(url)) {
      schemeEl.innerHTML = icons.lock;
      schemeEl.title = "Secure (https)";
    } else if (/^http:\/\//i.test(url)) {
      schemeEl.textContent = "Not secure";
      schemeEl.classList.add("warn");
      schemeEl.title = "Not secure (http)";
    }
  }

  function setLive(on) {
    liveDot.classList.toggle("off", !on);
    liveDot.classList.toggle("on", !!on);
    liveDot.title = on ? "Live" : "Stream idle";
  }

  async function hist(action) {
    const t = activeTab();
    if (!t) return;
    try {
      await bFetch(`/tabs/${encodeURIComponent(t.id)}/${action}`, { method: "POST", body: {}, ep: epOf() });
      setTimeout(() => { if (!state.dead) loadTabs().catch(() => {}); }, 800);
    } catch (e) { showErr(e); }
  }
  backBtn.addEventListener("click", () => hist("back"));
  fwdBtn.addEventListener("click", () => hist("forward"));
  reloadBtn.addEventListener("click", () => hist("reload"));

  function resolveUrlText(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t; // scheme present → server validates (B4)
    if (!t.includes(".")) return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
    return `https://${t}`;
  }

  urlBar.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const t = activeTab();
    if (!t) return;
    const url = resolveUrlText(urlBar.value);
    if (!url) return;
    e.preventDefault();
    try {
      const r = await bFetch(`/tabs/${encodeURIComponent(t.id)}/navigate`, { method: "POST", body: { url }, ep: epOf() });
      if (r) {
        const hit = state.tabs.find((x) => x.id === t.id);
        if (hit) { hit.url = r.url || url; hit.title = r.title || hit.title; }
        paintStrip();
        paintToolbar();
      }
    } catch (err) { showErr(err); }
  });

  function focusUrl() {
    try {
      urlBar.focus();
      urlBar.select();
    } catch {}
  }

  popBtn.addEventListener("click", async () => {
    const t = activeTab();
    if (!t) return;
    try {
      await bFetch(`/tabs/${encodeURIComponent(t.id)}/activate`, { method: "POST", body: {}, ep: epOf() });
      toast("Chrome window raised", "success");
    } catch (e) { showErr(e); }
  });

  gearBtn.addEventListener("click", () => {
    const body = h("div", null);
    body.append(h("div", { class: "pop-label", text: "Attach to an existing Chrome…" }));
    const hostI = h("input", { type: "text", placeholder: "host (localhost)", "aria-label": "Chrome host" });
    const portI = h("input", { type: "text", placeholder: "port (9222)", "aria-label": "Chrome port" });
    hostI.value = (state.ep && state.ep.host) || "";
    portI.value = (state.ep && state.ep.port) || "";
    const row = h("div", { class: "brw-gear-row" }, hostI, portI);
    const attachBtn = h("button", { class: "pop-item", type: "button", text: "Attach to host:port" });
    attachBtn.addEventListener("click", async () => {
      const host = hostI.value.trim();
      const port = portI.value.trim();
      state.ep = (host || port) ? { host: host || "localhost", port: port || "9222" } : null;
      closePopover();
      stopNet();
      await boot();
    });
    const managedBtn = h("button", { class: "pop-item", type: "button", text: "Use managed browser" });
    managedBtn.addEventListener("click", async () => {
      state.ep = null;
      closePopover();
      stopNet();
      await boot();
    });
    const relaunchBtn = h("button", { class: "pop-item", type: "button", text: "Relaunch managed browser (starts it if stopped)" });
    relaunchBtn.addEventListener("click", async () => {
      state.ep = null;
      closePopover();
      try {
        await bFetch("/launch", { method: "POST", body: {}, ep: null });
        stopNet();
        await boot();
      } catch (e) { showErr(e, true); }
    });
    body.append(row, attachBtn, managedBtn, relaunchBtn);
    const sys = (store.get().caps && store.get().caps.systemOpen) || {};
    if (sys.reveal && state.status && state.status.profileDir) {
      const prof = h("button", { class: "pop-item", type: "button", text: "Open profile folder" });
      prof.title = state.status.profileDir;
      prof.addEventListener("click", async () => {
        closePopover();
        try {
          const r = await fetch("/api/system/reveal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: state.status.profileDir }),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
          toast("Profile folder revealed", "success");
        } catch (e) { showErr(e); }
      });
      body.append(prof);
    }
    openPopover(gearBtn, body, { align: "end" });
  });

  // ── viewport + stream (U4) ───────────────────────────────────
  function imgBox() {
    const r = imgEl.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function closeStream() {
    if (state.stream) {
      try { state.stream.close(); } catch {}
      state.stream = null;
    }
    state.streamTab = "";
    setLive(false);
  }

  function openStream(tabId) {
    closeStream();
    if (!tabId || state.dead || state.paused) return;
    const tab = state.tabs.find((t) => t.id === tabId);
    // An agent-driven page lives behind a different route: the managed stream is
    // per CDP tab of the user's window, the agent's page is a Playwright session.
    const isAgent = Boolean(tab && tab.agent);
    const params = new URLSearchParams();
    if (state.ep && state.ep.host) params.set("host", state.ep.host);
    if (state.ep && state.ep.port) params.set("port", String(state.ep.port));
    const qs = params.toString();
    const url = isAgent
      ? "/api/browser/agent-stream"
      : `/api/browser/tabs/${encodeURIComponent(tabId)}/stream${qs ? `?${qs}` : ""}`;
    let es = null;
    try {
      es = new EventSource(url);
    } catch (e) {
      showErr(e);
      return;
    }
    state.stream = es;
    state.streamTab = tabId;
    es.onmessage = (ev) => {
      if (state.dead || state.stream !== es) return;
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        setLive(true);
        state.streamFails = 0;
        if (msg.url && document.activeElement !== urlBar) {
          const hit = state.tabs.find((x) => x.id === tabId);
          if (hit) { hit.url = msg.url; if (msg.title) hit.title = msg.title; paintStrip(); paintToolbar(); }
        }
        return;
      }
      // Two frame shapes on purpose: the managed stream sends a flat
      // {jpegBase64,w,h} record, the agent stream a {type:"frame",data,metadata}
      // envelope. Both must paint, or the panel is blank on one of them.
      if (msg.jpegBase64) {
        state.imgW = Number(msg.w) || 0;
        state.imgH = Number(msg.h) || 0;
        imgEl.src = `data:image/jpeg;base64,${msg.jpegBase64}`;
        setLive(true);
        state.streamFails = 0;
        return;
      }
      if (msg.type === "frame" && msg.data) {
        const md = msg.metadata || {};
        // An initial snapshot has no viewport numbers; keep the last known size
        // rather than collapsing the image to 0x0.
        const dw = Number(md.deviceWidth) || 0;
        const dh = Number(md.deviceHeight) || 0;
        if (dw) state.imgW = dw;
        if (dh) state.imgH = dh;
        imgEl.src = `data:image/jpeg;base64,${msg.data}`;
        setLive(true);
        state.streamFails = 0;
      }
    };
    es.onerror = () => {
      if (state.dead || state.stream !== es) return;
      try { es.close(); } catch {}
      if (state.stream === es) { state.stream = null; state.streamTab = ""; }
      setLive(false);
      // Backoff reconnect while the tab stays active + visible.
      state.streamFails++;
      const wait = Math.min(10000, 1000 * 2 ** Math.min(3, state.streamFails - 1));
      clearTimeout(state.streamTimer);
      state.streamTimer = setTimeout(() => {
        if (!state.dead && !state.paused && state.activeId === tabId && !state.staticShot) openStream(tabId);
      }, wait);
    };
  }

  // ── input forwarding (U4) ────────────────────────────────────
  async function postInput(payload) {
    const t = activeTab();
    if (!t || agentBusy()) return;
    try {
      await bFetch(`/tabs/${encodeURIComponent(t.id)}/input`, { method: "POST", body: payload, ep: epOf() });
    } catch (e) {
      showErr(e);
    }
  }

  function frameCoords(e) {
    // Pointer relative to the RENDERED <img> box, scaled to frame px.
    // Letterbox margins are outside the img → ignored (clientX outside box).
    const box = imgBox();
    const nw = imgEl.naturalWidth || state.imgW || 0;
    const nh = imgEl.naturalHeight || state.imgH || 0;
    if (!box.w || !box.h || !nw || !nh) return null;
    const rx = e.clientX - box.x;
    const ry = e.clientY - box.y;
    if (rx < 0 || ry < 0 || rx > box.w || ry > box.h) return null;
    return {
      cssX: Math.round((rx * nw) / box.w),
      cssY: Math.round((ry * nh) / box.h),
      frameW: nw,
      frameH: nh,
    };
  }

  function modsOf(e) {
    return { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey };
  }

  function btnOf(e) {
    return e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
  }

  async function sendClickPair(e, button) {
    const c = frameCoords(e);
    if (!c) return;
    const m = modsOf(e);
    await postInput({ type: "mouse", kind: "down", button, ...c, modifiers: m });
    await postInput({ type: "mouse", kind: "up", button, ...c, modifiers: m });
  }

  overlayEl.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll
    overlayEl.focus();
    const c = frameCoords(e);
    if (!c) return;
    postInput({ type: "mouse", kind: "down", button: btnOf(e), ...c, modifiers: modsOf(e) });
  });
  overlayEl.addEventListener("mouseup", (e) => {
    const c = frameCoords(e);
    if (!c) return;
    postInput({ type: "mouse", kind: "up", button: btnOf(e), ...c, modifiers: modsOf(e) });
  });
  overlayEl.addEventListener("click", (e) => {
    // Covered by down+up; the event only keeps focus deterministic.
    overlayEl.focus();
  });
  overlayEl.addEventListener("dblclick", (e) => {
    e.preventDefault();
    sendClickPair(e, btnOf(e)).then(() => sendClickPair(e, btnOf(e)));
  });
  overlayEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    sendClickPair(e, "right");
  });
  overlayEl.addEventListener("mousemove", (e) => {
    if (agentBusy() || state.moveInflight) return; // coalesce while one is out
    const now = performance.now();
    if (now - state.lastMove < MOVE_THROTTLE_MS) return;
    state.lastMove = now;
    const c = frameCoords(e);
    if (!c) return;
    state.moveInflight = true;
    postInput({ type: "mouse", kind: "move", button: "left", ...c, modifiers: modsOf(e) })
      .finally(() => { state.moveInflight = false; });
  });
  overlayEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const c = frameCoords(e) || {};
    postInput({
      type: "wheel",
      deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY),
      ...(c.cssX != null ? c : {}), modifiers: modsOf(e),
    });
  }, { passive: false });
  overlayEl.addEventListener("keydown", (e) => {
    // Esc releases focus; Ctrl+L jumps to the URL bar (never forwarded).
    if (e.key === "Escape") { overlayEl.blur(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      focusUrl();
      return;
    }
    if (agentBusy()) return;
    const m = modsOf(e);
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      // Printable (incl. space, digits, lofi…) → text path.
      postInput({ type: "key", text: e.key, modifiers: m });
    } else {
      // Enter, Backspace, Tab, arrows… → named-key path. Tab must not blur.
      e.preventDefault();
      postInput({ type: "key", key: e.key, code: e.code || "", modifiers: m });
    }
  });
  // keypress intentionally unhandled: keydown above already covers printable
  // keys, and handling both would double-send every character.

  // ── agent pill (U5) ──────────────────────────────────────────
  function agentBusy() {
    return Date.now() - state.agentAt < AGENT_FRESH_MS;
  }

  state.pillTimer = setInterval(() => {
    if (state.dead) return;
    const busy = agentBusy();
    pillEl.hidden = !busy;
    overlayEl.classList.toggle("agent-driving", busy);
    // Agent-dot freshness on the strip.
    if (state.agentTab) paintStrip();
  }, 500);

  // ── action feed + drawer (U6) ────────────────────────────────
  function pushLog(action) {
    const key = `${action.at || ""}|${action.tabId || ""}|${action.label || action.type || ""}`;
    if (state.seenActions.has(key)) return;
    state.seenActions.add(key);
    if (state.seenActions.size > 400) {
      const first = state.seenActions.values().next().value;
      state.seenActions.delete(first);
    }
    state.log.unshift({ at: action.at || new Date().toISOString(), label: action.label || action.type || "action", tabId: action.tabId || "", actor: action.actor || "agent" });
    while (state.log.length > 200) state.log.pop();
    paintDrawer();
  }

  function noteAgentAction(action) {
    if (!action || action.actor === "user") return; // our own viewport echoes
    state.agentAt = Date.now();
    if (action.tabId) {
      state.agentTab = action.tabId;
      // Auto-activate the agent's tab UI-side (not in Chrome) so the user
      // watches what the agent does.
      if (action.tabId !== state.activeId && state.tabs.some((t) => t.id === action.tabId)) {
        state.activeId = action.tabId;
        persist({ lastTabId: action.tabId });
        paintStrip();
        paintToolbar();
        if (!state.staticShot) openStream(action.tabId);
      } else {
        paintStrip();
      }
    }
    pillEl.hidden = false;
    overlayEl.classList.add("agent-driving");
  }

  function openActionsFeed() {
    closeActionsFeed();
    const params = new URLSearchParams();
    if (state.ep && state.ep.host) params.set("host", state.ep.host);
    if (state.ep && state.ep.port) params.set("port", String(state.ep.port));
    const qs = params.toString();
    let es = null;
    try {
      // Only `action` messages are consumed; `ready`/`frame` ignored here.
      es = new EventSource(`/api/browser/live${qs ? `?${qs}` : ""}`);
    } catch {
      return;
    }
    state.actionsES = es;
    es.onmessage = (ev) => {
      if (state.dead || state.actionsES !== es) return;
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || msg.type !== "action" || !msg.action) return;
      pushLog(msg.action);
      noteAgentAction(msg.action);
    };
    es.onerror = () => {
      if (state.dead || state.actionsES !== es) return;
      try { es.close(); } catch {}
      if (state.actionsES === es) state.actionsES = null;
    };
  }

  function closeActionsFeed() {
    if (state.actionsES) {
      try { state.actionsES.close(); } catch {}
      state.actionsES = null;
    }
  }

  function paintDrawer() {
    drawerHead.innerHTML = "";
    drawerHead.append(
      h("span", { html: icons.chevronDown }),
      h("span", { text: `Action log (${state.log.length})` }),
    );
    drawerHead.setAttribute("aria-expanded", String(state.drawerOpen));
    drawerEl.classList.toggle("closed", !state.drawerOpen);
    drawerList.innerHTML = "";
    if (state.drawerOpen) {
      for (const row of state.log) {
        drawerList.append(h("div", { class: "brw-logrow" },
          h("span", { class: "brw-logtime", text: clockOf(row.at) }),
          h("span", { class: "brw-loglabel", text: row.label, title: row.tabId ? `tab ${row.tabId}` : "" })));
      }
      if (!state.log.length) {
        drawerList.append(h("div", { class: "muted small", text: "No agent actions yet." }));
      }
    }
  }

  drawerHead.addEventListener("click", () => {
    state.drawerOpen = !state.drawerOpen;
    persist({ drawerOpen: state.drawerOpen });
    paintDrawer();
  });
  const clearBtn = h("button", { class: "mini-btn", type: "button", text: "Clear" });
  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.log = [];
    paintDrawer();
  });
  drawerHead.append(clearBtn);

  // ── static screenshot (U7) ───────────────────────────────────
  function showStatic(shot) {
    closeStream();
    setLive(false);
    staticBadge.hidden = false;
    staticNote.hidden = true;
    staticNote.innerHTML = "";
    const url = shot.url || "";
    if (/^(https?:|data:)/i.test(url)) {
      imgEl.src = url;
      urlBar.value = shot.path || url;
      urlBar.readOnly = true;
    } else {
      imgEl.removeAttribute("src");
      staticNote.hidden = false;
      staticNote.append(
        h("span", { class: "small", text: `Screenshot file: ${shot.path || "(unknown)"} — live frames aren't stored. ` }),
        h("button", {
          class: "mini-btn", type: "button", text: "Open in Files",
          onclick: () => { try { ctx.panel.openFiles(shot.path || ""); } catch {} },
        }),
      );
      urlBar.value = shot.path || "";
      urlBar.readOnly = true;
    }
  }

  // ── net lifecycle (U8) ───────────────────────────────────────
  function startNet() {
    stopNet();
    if (state.dead || state.paused) return;
    state.pollTimer = setInterval(() => {
      if (state.dead || state.paused || document.hidden) return;
      loadTabs().catch(() => {});
    }, POLL_MS);
    openActionsFeed();
    if (state.activeId && !state.staticShot) openStream(state.activeId);
  }

  function stopNet() {
    closeStream();
    closeActionsFeed();
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.streamTimer) { clearTimeout(state.streamTimer); state.streamTimer = null; }
    setLive(false);
  }

  const onStore = () => {
    const open = store.get().panel.open !== false;
    const paused = !open || document.hidden;
    if (paused === state.paused) return;
    state.paused = paused;
    if (paused) stopNet();
    else if (state.status && state.status.running) startNet();
  };
  const unsubStore = store.subscribe(onStore);
  const onVis = () => onStore();
  document.addEventListener("visibilitychange", onVis);
  if (document.hidden) state.paused = true;

  // ── go ───────────────────────────────────────────────────────
  paintDrawer();
  boot();

  return {
    update(c) {
      // A new static shot (thread step row) replaces the live view until the
      // user picks a tab.
      if (c && c.arg && c.arg.shot) {
        state.staticShot = c.arg.shot;
        showStatic(c.arg.shot);
      }
    },
    unmount() {
      state.dead = true;
      stopNet();
      if (state.pillTimer) { clearInterval(state.pillTimer); state.pillTimer = null; }
      try { unsubStore(); } catch {}
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}
