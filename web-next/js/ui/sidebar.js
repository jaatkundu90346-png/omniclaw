// Sidebar: brand + nav + projects/sessions (real data) + gateway footer.
// Sessions group under projects via workspaceIdFromSessionKey(session.key);
// unmatched sessions go under a last row labelled with their raw workspaceId.

import { h } from "../utils/dom.js";
import { icons, brand as brandSvg } from "../icons.js";
import { store, applyTheme, isSessionRunning } from "../store.js";
import { getHealth, getAgents, getSchedules, listSessions, renameSession, archiveSession, selectWorkspace, getSessionSummary } from "../api.js";
import { basename, workspaceIdForPath, workspaceIdFromSessionKey } from "../utils/path.js";
import { formatRelativeTime } from "../utils/dom.js";
import { openPopover, closePopover } from "./popover.js";
import { parseRoute } from "../router.js";
import { toast } from "./toast.js";

// P4a: auto labels look like "chat-09-03-09-29" (neo.js:730 pattern) — show the
// user's first message instead. Full title + relative time in the tooltip.
const AUTO_LABEL = /^chat-\d{2}-\d{2}-\d{2}-\d{2}$/;
export function sessionTitle(session) {
  const label = String(session.label || "");
  if (AUTO_LABEL.test(label) || !label) {
    const preview = String(session.lastUserMessagePreview || "")
      .replace(/\s+/g, " ").trim().slice(0, 48);
    return preview || "New chat";
  }
  return label;
}

export function sessionTooltip(session) {
  const full = String(session.label && !AUTO_LABEL.test(session.label)
    ? session.label
    : (session.lastUserMessagePreview || session.label || session.id));
  const when = formatRelativeTime(session.updatedAt || session.createdAt);
  return when ? `${full} · ${when}` : full;
}

// Short disambiguator appended to DISPLAY titles only when siblings share a
// label (time-based auto labels collide across days). Stored labels untouched.
function shortDate(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PAGE_SIZE = 8;
const expanded = new Set(); // project keys with "show more" expanded
// Part C4: child-chat ids expanded by the user (default: collapsed).
const expandedKids = new Set();
let filter = ""; // local session filter (sidebar search)

let statusTimer = null;
let lastSig = "";

function themeLabel(t) {
  return t === "light" ? "Light" : t === "system" ? "System" : "Dark";
}

function openBrandMenu(anchor) {
  const s = store.get();
  const body = h("div", null);
  // F4: per-row icon sun/moon/monitor; selected row shows check right-aligned.
  const addTheme = (key, label, icon) => {
    const selected = s.theme === key;
    const b = h("button", { class: "pop-item", role: "menuitemradio", "aria-checked": String(selected) },
      h("span", { html: icons[icon] }), h("span", { text: label }));
    if (selected) b.append(h("span", { class: "check", html: icons.check }));
    b.addEventListener("click", () => {
      store.set({ theme: key });
      applyTheme();
      closePopover();
    });
    body.append(b);
  };
  body.append(h("div", { class: "pop-label", text: "Theme" }));
  addTheme("light", "Light", "sun");
  addTheme("dark", "Dark", "moon");
  addTheme("system", "System", "monitor");
  // P4b: system sessions (channel !== "webchat": heartbeat/cron — channel is
  // part of the session key and summary, src/core/session-store.js:161,251-254).
  body.append(h("div", { class: "pop-sep" }));
  const sys = h("button", {
    class: "pop-item", role: "menuitemcheckbox",
    "aria-checked": String(!!s.showSystem),
  }, h("span", { html: icons.clock }), h("span", { text: "Show system sessions" }));
  if (s.showSystem) sys.append(h("span", { class: "check", html: icons.check }));
  sys.addEventListener("click", () => {
    store.set({ showSystem: !store.get().showSystem });
    closePopover();
  });
  body.append(sys);
  body.append(h("div", { class: "pop-sep" }));
  const settings = h("button", { class: "pop-item", text: "Settings" });
  settings.addEventListener("click", () => { closePopover(); window.location.hash = "#/settings"; });
  const about = h("button", {
    class: "pop-item",
    text: `About — OmniClaw v${s.gateway.version || "…"}`,
    // Version source = GET /api/health version, same as neo footer "v0.1.0" (neo.js:480).
    title: `Version v${s.gateway.version || "?"} · model ${s.gateway.model || "?"}`,
  });
  about.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(`OmniClaw v${s.gateway.version || ""}`); } catch {}
    closePopover();
  });
  body.append(settings, about);
  openPopover(anchor, body);
}

function openSessionMenu(anchor, session) {
  const body = h("div", null);
  // Resume: open the session and send "continue" (plan/run.resume inherits
  // unfinished work server-side). Flag consumed by main.js after history load.
  const resume = h("button", { class: "pop-item", text: "Resume (continue work)" });
  resume.addEventListener("click", () => {
    closePopover();
    try { sessionStorage.setItem("oc:resume-session", session.id); } catch {}
    const target = `#/t/${encodeURIComponent(session.id)}`;
    if (window.location.hash === target) {
      window.dispatchEvent(new CustomEvent("oc:resume-session", { detail: { sessionId: session.id } }));
    } else {
      window.location.hash = target;
    }
  });
  // Summary: on-demand generate + show (GOAL/DONE/NEXT… from summarizer).
  const summary = h("button", { class: "pop-item", text: "Session summary" });
  summary.addEventListener("click", async () => {
    closePopover();
    toast("Building summary…", "success");
    try {
      const data = await getSessionSummary(session.id, { generate: true, force: true });
      const text = String((data && data.summary && data.summary.text) || "").trim();
      if (!text) { toast("No summary available for this session.", "error"); return; }
      const back = h("div", { class: "modal-back" });
      const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": "Session summary" },
        h("h2", { text: "Session summary" }),
        h("pre", { class: "summary-pre", text: text.slice(0, 4000), style: "white-space:pre-wrap;max-height:50vh;overflow:auto;font-size:12px;background:var(--bg-soft);padding:12px;border-radius:8px;border:1px solid var(--line-soft)" }),
        h("div", { class: "row", style: "justify-content:flex-end;margin-top:12px" },
          h("button", { class: "btn", type: "button", text: "Close", onclick: () => back.remove() })));
      back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
      back.append(modal);
      document.body.append(back);
    } catch (e) {
      toast(`Summary failed: ${e.message}`, "error");
    }
  });
  // Both routes exist (POST /api/sessions/rename server.js:1478 neo.js:553;
  // POST /api/sessions/reset server.js:1495 neo.js:567), so Rename/Delete show.
  const rn = h("button", { class: "pop-item", text: "Rename" });
  rn.addEventListener("click", async () => {
    closePopover();
    const next = window.prompt("Rename session:", session.label || "");
    if (!next || !next.trim() || next.trim() === session.label) return;
    try {
      await renameSession(session.id, next.trim());
      const data = await listSessions(200);
      store.set({ sessions: data.sessions || [] });
    } catch (e) { console.error(e); }
  });
  const del = h("button", { class: "pop-item", text: "Delete" });
  del.addEventListener("click", async () => {
    closePopover();
    if (!window.confirm("Archive this session?")) return;
    try {
      await archiveSession(session.id);
      const data = await listSessions(200);
      store.set({ sessions: data.sessions || [] });
    } catch (e) { console.error(e); }
  });
  const cp = h("button", { class: "pop-item", text: "Copy session id" });
  cp.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(session.id); } catch {}
    closePopover();
  });
  const sep = h("div", { class: "pop-sep" });
  body.append(resume, summary, sep, rn, del, cp);
  openPopover(anchor, body, { align: "end" });
}

function sessionRow(session, activeId, showSystem, dupSuffix = "") {
  const title = sessionTitle(session);
  const isActive = session.id === activeId;
  const row = h("div", {
    class: `sess-row${isActive ? " active" : ""}`,
    title: sessionTooltip(session),
    ...(isActive ? { "aria-current": "true" } : {}),
  });
  const main = h("button", { class: "sess-main", type: "button" });
  // P4b: clock prefix for system sessions when shown.
  if (showSystem && session.channel && session.channel !== "webchat") {
    main.append(h("span", { class: "sys-ic", html: icons.clock }));
  }
  // A session an agent was handed a task in is not a chat the user
  // started. Tag it, or the tab fills up with unexplained sessions.
  if (session.parentSessionId) {
    main.append(h("span", { class: "sess-from", text: "from agent", title: "This session was created for a task another agent handed over." }));
  }
  main.append(h("span", { class: "lbl truncate", text: dupSuffix ? `${title} · ${dupSuffix}` : title }));
  main.addEventListener("click", () => { window.location.hash = `#/t/${encodeURIComponent(session.id)}`; });
  row.append(main);
  const slot = h("span", { class: "sess-slot" });
  // 4B.1: amber dot when this session has pending approvals/questions.
  const pend = (store.get().appr && store.get().appr.bySession) || {};
  if (pend[session.id]) {
    slot.append(h("span", {
      class: "appr-dot", title: `${pend[session.id]} waiting for approval`,
      "aria-label": `${pend[session.id]} items waiting for approval`,
    }));
  }
  if (isSessionRunning(session)) {
    slot.append(h("span", { html: icons.spinner, class: "spin", title: "Running" }));
  } else {
    const more = h("button", {
      class: "more-btn icon-btn", type: "button", html: icons.more, title: "Session actions",
      "aria-label": `Actions for ${title}`,
    });
    more.addEventListener("click", (e) => { e.stopPropagation(); openSessionMenu(more, session); });
    slot.append(more);
  }
  row.append(slot);
  return row;
}

function buildProjectGroups(sessions, recents, activePath, activeId) {
  // Dedupe recents by path, active first.
  const seen = new Set();
  const projects = [];
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  const ordered = [...(recents || [])].sort((a, b) => {
    const aa = norm(a.path) === norm(activePath) ? 0 : 1;
    const bb = norm(b.path) === norm(activePath) ? 0 : 1;
    return aa - bb;
  });
  for (const r of ordered) {
    const key = norm(r.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    projects.push({ kind: "project", path: r.path, name: basename(r.path), wsId: workspaceIdForPath(r.path) });
  }
  // Grouping rule (no activeId fallback — switching projects must never move
  // a chat): explicit stored workspacePath wins, else the :ws: key suffix
  // matched against a known project. Anything unattributable (legacy rows
  // with neither) goes to "older", never under the active folder.
  const byDateDesc = (a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
  const byPath = new Map(projects.map((p) => [norm(p.path), p]));
  const byWs = new Map(projects.map((p) => [p.wsId, p]));
  const buckets = new Map(projects.map((p) => [p.wsId, []]));
  const synth = new Map(); // norm path -> project (folders fallen out of recents)
  const older = [];
  // Part C4: sub-agent child chats (parentSessionId set) never sit at top
  // level — they nest under their parent, collapsed by default.
  const children = new Map(); // parentSessionId -> [child summaries]
  for (const sess of sessions || []) {
    if (sess.parentSessionId) {
      const arr = children.get(sess.parentSessionId) || [];
      arr.push(sess);
      children.set(sess.parentSessionId, arr);
      continue;
    }
    const sessPath = sess.workspacePath ? norm(sess.workspacePath) : "";
    const suffix = workspaceIdFromSessionKey(sess.key);
    const proj = (sessPath && byPath.get(sessPath)) || (!sessPath && suffix && byWs.get(suffix)) || null;
    if (proj) {
      buckets.get(proj.wsId).push(sess);
    } else if (sessPath) {
      if (!synth.has(sessPath)) {
        synth.set(sessPath, {
          kind: "project", path: sess.workspacePath, name: basename(sess.workspacePath),
          wsId: workspaceIdForPath(sess.workspacePath), sessions: [],
        });
      }
      synth.get(sessPath).sessions.push(sess);
    } else {
      older.push(sess);
    }
  }
  const groups = projects.map((p) => ({ ...p, sessions: (buckets.get(p.wsId) || []).sort(byDateDesc) }));
  for (const g of synth.values()) {
    g.sessions.sort(byDateDesc);
    groups.push(g);
  }
  older.sort(byDateDesc);
  for (const arr of children.values()) arr.sort(byDateDesc);
  return { groups, older, children };
}


export function mountSidebar(root) {
  root.innerHTML = "";
  root.className = "sidebar";
  root.id = "sidebar";

  const top = h("div", { class: "sb-top" });
  const brand = h("button", { class: "sb-brand", "aria-haspopup": "menu", "aria-expanded": "false" },
    h("span", { class: "brand-mark", html: brandSvg }), h("span", { class: "brand-name", text: "OmniClaw" }), h("span", { class: "icon", html: icons.chevronDown }));
  brand.addEventListener("click", () => openBrandMenu(brand));
  const searchBtn = h("button", { class: "icon-btn", title: "Search conversations", "aria-label": "Search conversations", "aria-pressed": "false", html: icons.search });
  const bellBtn = h("button", { class: "icon-btn", title: "Notifications (coming soon)", disabled: true, "aria-label": "Notifications", html: icons.bell });
  top.append(brand, h("div", { class: "sb-icons" }, searchBtn, bellBtn));
  const searchWrap = h("div", { class: "sb-search", hidden: true });
  let searchOpen = false;
  const searchInput = h("input", { type: "search", placeholder: "Search conversations…", "aria-label": "Search conversations" });
  searchWrap.append(searchInput);
  searchBtn.addEventListener("click", () => {
    searchOpen = !searchOpen;
    searchWrap.hidden = !searchOpen;
    searchBtn.setAttribute("aria-pressed", String(searchOpen));
    if (!searchWrap.hidden) searchInput.focus();
    else {
      searchInput.value = "";
      filter = "";
      render();
    }
  });
  searchInput.addEventListener("input", () => {
    filter = searchInput.value.trim().toLowerCase();
    render();
  });

  const nav = h("nav", { class: "sb-nav", "aria-label": "Primary" });
  const navDefs = [
    { icon: "plus", label: "New chat", href: "#/" },
    { icon: "wrench", label: "Skills & Tools", href: "#/tools" },
    { icon: "diff", label: "Changes", href: "#/changes" },
    { icon: "clock", label: "Scheduled", href: "#/scheduled" },
    { icon: "puzzle", label: "Plugins", href: "#/plugins" },
    // Settings used to be reachable ONLY from the brand dropdown (and by typing
    // #/settings). Nothing in the nav pointed at it, so a new user had no way to
    // discover it — the single most-asked "where is settings?" path.
    { icon: "settings", label: "Settings", href: "#/settings" },
  ];
  const navBtns = navDefs.map((d) => {
    const a = h("a", { class: "nav-row", href: d.href }, h("span", { html: icons[d.icon] }), h("span", { text: d.label }));
    nav.append(a);
    return { ...d, el: a };
  });

  const projTitle = h("div", { class: "sb-section", text: "Projects" });
  const projWrap = h("div", { class: "proj" });
  const projScroll = h("div", { class: "proj-scroll" }, projTitle, projWrap);

  // The footer ("OC · Local · ●") is the app's own identity strip and it sits at
  // the very bottom, next to the connection light. Making it open Settings puts
  // the entry point exactly where people look for "local / app settings", and it
  // is a real button (tab-focusable, Enter/Space activated) rather than a
  // click handler on a div.
  const foot = h("button", {
    class: "sb-foot", type: "button", title: "Settings", "aria-label": "Open settings",
  });
  const avatar = h("span", { class: "avatar", text: "OC" });
  const local = h("span", { class: "sb-foot-label", text: "Local" });
  const dot = h("span", { class: "gw-dot down", title: "Connecting…" });
  foot.append(avatar, local, dot);
  foot.addEventListener("click", () => { window.location.hash = "#/settings"; });

  root.append(top, searchWrap, nav, projScroll, foot);
  function paintNav(route) {
    for (const n of navBtns) {
      const active = (n.href === "#/" && (route.name === "home" || route.name === "thread")) || (`#${routePath(route)}` === n.href);
      n.el.classList.toggle("active", !!active);
    }
  }

  function routePath(route) {
    if (route.name === "thread") return `/t/${encodeURIComponent(route.sessionId)}`;
    if (route.name === "settings") return "/settings";
    if (route.name === "plugins") return "/plugins";
    if (route.name === "scheduled") return "/scheduled";
    if (route.name === "changes") return "/changes";
    if (route.name === "tools") return "/tools";
    return "/";
  }

  // F5: idle polling budget is ONE request per 10s (server limiter: 60 req/min/IP,
  // server.js:29-48). Rotate health -> agents -> schedules; each refreshes every 30s.
  const pollKinds = ["health", "agents", "schedules"];
  let pollIdx = 0;
  async function refreshStatus() {
    const kind = pollKinds[pollIdx % pollKinds.length];
    pollIdx++;
    try {
      const g = { ...store.get().gateway };
      if (kind === "health") {
        const health = await getHealth();
        const provider = (health && health.provider) || {};
        g.ok = provider.ready !== false;
        g.text = provider.ready === false ? "Gateway degraded" : "Gateway ready";
        g.version = health.version || g.version;
        g.model = provider.model || provider.id || g.model;
      } else if (kind === "agents") {
        const agents = await getAgents();
        g.agents = ((agents && agents.agents) || []).length;
      } else {
        const schedules = await getSchedules();
        g.cron = ((schedules && schedules.schedules) || []).filter((x) => x.status === "active").length;
      }
      store.set({ gateway: g });
      paintFooter();
      const banner = document.getElementById("banner");
      if (banner) banner.classList.remove("show");
      refreshStatus.fails = 0;
    } catch {
      refreshStatus.fails = (refreshStatus.fails || 0) + 1;
      store.set({ gateway: { ...store.get().gateway, ok: false, text: "Gateway offline" } });
      paintFooter();
      if (refreshStatus.fails >= 2) {
        const banner = document.getElementById("banner");
        if (banner) banner.classList.add("show");
      }
    }
  }

  function paintFooter() {
    const g = store.get().gateway;
    dot.className = `gw-dot ${g.ok == null ? "degraded" : g.ok ? "ok" : "down"}`;
    dot.title = `${g.text || "Gateway"} · Agents ${g.agents || 0} · Cron ${g.cron || 0}`;
    foot.title = dot.title;
  }

  function render() {
    const s = store.get();
    const route = parseRoute(window.location.hash);
    paintNav(route);
    // `expanded` (show more/less) lives outside the store — include it or the
    // toggle silently no-ops behind the sig guard.
    const sig = JSON.stringify([
      s.workspace.activePath, s.workspace.recents, s.sessions, s.activeSessionId,
      s.showSystem, s.collapsedProjects, [...expanded].sort(), [...expandedKids].sort(),
      s.appr, filter, s.agentId,
    ]);
    if (sig !== lastSig) {
      lastSig = sig;
      projWrap.innerHTML = "";
      // Mirror neo's list filter (neo.js:520): archived sessions are gone from history.
      // P4b: system sessions (channel !== webchat) hidden unless toggled.
      // Part C4: child chats nest under parents — collect them first so the
      // text filter can match through them, then keep them out of top level.
      const kidsByParent = new Map();
      for (const x of (s.sessions || [])) {
        if (!x.parentSessionId) continue;
        if (x.lifecycleState === "archived") continue;
        if (s.showSystem || !x.channel || x.channel === "webchat") {
          const arr = kidsByParent.get(x.parentSessionId) || [];
          arr.push(x);
          kidsByParent.set(x.parentSessionId, arr);
        }
      }
      const kidMatches = (sess) => (kidsByParent.get(sess.id) || []).filter((k) => {
        if (!filter) return true;
        const hay = `${sessionTitle(k)} ${(k.lastUserMessagePreview || "")}`.toLowerCase();
        return hay.includes(filter);
      });
      const visible = (s.sessions || [])
        .filter((x) => !x.parentSessionId)
        .filter((x) => x.lifecycleState !== "archived")
        .filter((x) => s.showSystem || !x.channel || x.channel === "webchat")
        .filter((x) => {
          if (!filter) return true;
          const hay = `${sessionTitle(x)} ${(x.lastUserMessagePreview || "")}`.toLowerCase();
          return hay.includes(filter) || kidMatches(x).length > 0;
        });
      const { groups, older, children } = buildProjectGroups(visible, s.workspace.recents, s.workspace.activePath, s.workspace.activeId);
      // Pinned, collapsed "Older chats" bucket for sessions that predate
      // folder scoping (no workspacePath, no :ws: suffix). Not a project:
      // never switches workspace, never shows a raw wsId slug.
      groups.push({
        kind: "older", path: "", name: "Older chats", wsId: "older",
        sessions: older,
        title: "Chats from before folder scoping — not part of any project",
      });
      const collapsed = s.collapsedProjects || {};
      const setCollapsed = (key, val) => {
        // 4B.1 fix: store an explicit boolean. The old `delete on false`
        // fell back to the default (!isActive), so non-active/raw groups
        // could never expand — collapse toggles were dead for them.
        const next = { ...(store.get().collapsedProjects || {}) };
        next[key] = !!val;
        store.set({ collapsedProjects: next });
      };
      for (const g of groups) {
        const isActive = g.kind === "project" && g.path && String(g.path).replace(/\\/g, "/").toLowerCase() === String(s.workspace.activePath).replace(/\\/g, "/").toLowerCase();
        const key = g.kind === "project" ? g.wsId : "older";
        const list = g.sessions || [];
        // P4c: active project expanded by default, others collapsed with count.
        // "Older chats" is always collapsed unless explicitly expanded.
        const isCollapsed = collapsed[key] !== undefined ? !!collapsed[key] : (g.kind === "older" ? true : !isActive);
        const row = h("button", {
          class: `proj-row${isActive ? " is-active" : ""}${g.kind === "older" ? " raw-id" : ""}${isCollapsed ? " collapsed" : ""}`,
          type: "button", title: g.kind === "project" ? g.path : (g.title || g.name),
          "aria-expanded": String(!isCollapsed),
        }, h("span", { class: "chev", html: icons.chevronRight }),
          h("span", { html: g.kind === "older" ? icons.clock : icons.folder }),
          h("span", { class: "lbl truncate", text: g.name || "(unnamed)" }));
        if (isCollapsed && list.length) {
          row.append(h("span", { class: "count", text: String(list.length) }));
        }
        row.addEventListener("click", async (e) => {
          // Chevron toggles collapse. Body click on a non-active project
          // switches workspace (Phase 1 behavior); on the active project or
          // the Older chats group it toggles collapse.
          if (e.target.closest && e.target.closest(".chev")) {
            setCollapsed(key, !isCollapsed);
            render();
            return;
          }
          if (g.kind === "project" && !isActive) {
            setCollapsed(key, false);
            try {
              const result = await selectWorkspace(g.path);
              const sel = result.selection || {};
              store.setWorkspace({
                activePath: sel.activePath || g.path,
                activeId: sel.activeId || workspaceIdForPath(g.path),
                activeName: sel.activeName || basename(g.path),
                recents: sel.recents || s.workspace.recents,
                isDefault: !!sel.isDefault,
              });
              const data = await listSessions(200);
              store.set({ sessions: data.sessions || [] });
            } catch (err) { console.error(err); }
            return;
          }
          setCollapsed(key, !isCollapsed);
          render();
        });
        projWrap.append(row);
        if (!isCollapsed) {
          const shown = expanded.has(key) ? list : list.slice(0, PAGE_SIZE);
          const box = h("div", { class: "sess-list" });
          // Same auto label can repeat inside one group (chat-MM-DD-HH-mm):
          // disambiguate display titles with a short date. Stored labels kept.
          const titleCounts = new Map();
          for (const sess of list) {
            const t = sessionTitle(sess);
            titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
          }
          for (const sess of shown) {
            const dup = (titleCounts.get(sessionTitle(sess)) || 0) > 1
              ? shortDate(sess.updatedAt || sess.createdAt)
              : "";
            box.append(sessionRow(sess, s.activeSessionId, s.showSystem, dup));
            // Part C4: nested sub-agent chats, collapsed by default.
            const kids = kidMatches(sess);
            if (kids.length) {
              const isOpen = !!filter || expandedKids.has(sess.id);
              const toggle = h("button", {
                class: "kids-toggle", type: "button",
                text: `${isOpen ? "▾" : "▸"} ${kids.length} sub-chat${kids.length === 1 ? "" : "s"}`,
                title: "Sub-agent chats for this conversation",
                "aria-expanded": String(isOpen),
              });
              toggle.addEventListener("click", () => {
                if (expandedKids.has(sess.id)) expandedKids.delete(sess.id);
                else expandedKids.add(sess.id);
                render();
              });
              box.append(toggle);
              if (isOpen) {
                const kbox = h("div", { class: "sess-kids" });
                for (const k of kids) kbox.append(sessionRow(k, s.activeSessionId, s.showSystem, ""));
                box.append(kbox);
              }
            }
          }
          projWrap.append(box);
          if (list.length > PAGE_SIZE) {
            const more = h("button", {
              class: "show-more", type: "button",
              text: expanded.has(key) ? "Show less" : `Show ${list.length - PAGE_SIZE} more`,
            });
            more.addEventListener("click", () => {
              if (expanded.has(key)) expanded.delete(key);
              else expanded.add(key);
              render();
            });
            projWrap.append(more);
          }
        }
      }
      if (!groups.length) {
        projWrap.append(h("div", { class: "small muted", text: "No projects yet.", style: "padding: 4px 8px" }));
      }
      // F5 timing: first render that actually has sessions.
      if (s.sessions.length && window.__ocNext && !window.__ocNext.populated) {
        window.__ocNext.populated = performance.now();
      }
    }
    paintFooter();
  }

  store.subscribe(render);
  window.addEventListener("hashchange", () => paintNav(parseRoute(window.location.hash)));
  render();
  refreshStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 10000);
}
