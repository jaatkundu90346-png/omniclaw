// Boot (F5): paint shell + sidebar skeleton in <200ms BEFORE any network
// response, then load workspace/sessions/config/status IN PARALLEL and render
// each as it resolves. Timings exposed on window.__ocNext for measurement.
//
// Phase 2A: thread view + minimal composer wired here. agentId is "main" —
// the neo default (public/neo.js:12 state init); no agent picker in /next yet.

import { store, initStore, applyTheme, applyAppearance } from "./store.js";
import { getWorkspace, listSessions, getConfig, getStatus, getCapabilities } from "./api.js";
import { mountShell } from "./ui/shell.js";
import { startRouter } from "./router.js";
import { mountEmpty } from "./ui/empty.js";
import { mountPlugins } from "./ui/plugins.js";
import { placeholderPage } from "./ui/placeholder.js";
import { mountSettings } from "./ui/settings.js";
import { mountTools } from "./ui/tools.js";
import { mountThread, generateLabel } from "./ui/thread.js";
import { mountComposer } from "./ui/composer.js";
import { mountPanel } from "./ui/panel.js";
import { attachSlash } from "./ui/slash.js";
import { attachMentions } from "./ui/mention.js";
import { isPopoverOpen } from "./ui/popover.js";
import { renderApprovalCard, renderQuestionCard } from "./ui/cards.js";
import { initApprovals, mountApprovalBanner, pokeActivity } from "./approvals.js";
// One global feed for delegation records; cards subscribe to it.
import { start as startDelegations } from "./delegations.js";
import { toast } from "./ui/toast.js";
import { h } from "./utils/dom.js";

// Dev-console hook for 2B verification replays (documented in report):
// __ocNext.cards.renderQuestionCard(hostEl, payload, {onSettled, onTimeout})
window.__ocNext = window.__ocNext || { t0: performance.now(), firstPaint: 0, populated: 0 };
window.__ocNext.cards = { renderApprovalCard, renderQuestionCard };

async function boot() {
  initStore();
  applyTheme();
  applyAppearance();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);
  }

  const root = document.getElementById("app");
  const { view, composerHost, panelHost, apprBanner, setTitle } = mountShell(root);
  // 4B.1: global approvals — banner + (N) title + persistent /api/events feed.
  mountApprovalBanner(apprBanner);
  initApprovals();
  startDelegations();
  const panelCtl = mountPanel(panelHost);
  // Sidebar "Changes" + step rows reach the panel through here.
  window.__ocNext.openPanel = (kind, arg) => {
    try { return panelCtl.open(kind, arg || {}); } catch { return null; }
  };

  let thread = null;
  let threadSession = "";
  let composer = null;
  let wasRunning = false;
  // A message typed while the composer is visible but no thread is mounted yet
  // (you opened a chat, then visited #/tools or #/changes, which tear the thread
  // down but leave activeSessionId set). Setting location.hash only QUEUES a
  // hashchange task, so the thread is still null on the next line — the message
  // used to be silently dropped. It is parked here and flushed by renderRoute
  // once loadHistory has the thread mounted and ready.
  let pendingSend = null;

  // Phase 4 §8: step rows open panel tabs (files/review/terminal/browser).
  function stepOpenToPanel(info) {
    if (!info) return;
    const caps = store.get().caps || {};
    try {
      if ((info.kind === "edit" || info.kind === "read") && info.path && caps.fs) {
        window.__ocNext.openPanel("files", { path: info.path });
      } else if (info.kind === "edit" && info.path && caps.git) {
        window.__ocNext.openPanel("review", { path: info.path });
      } else if (info.kind === "exec" && caps.terminal !== false) {
        window.__ocNext.openPanel("terminal", { command: info.command || "" });
      } else if (info.kind === "screenshot" && (info.path || info.command)) {
        window.__ocNext.openPanel("browser", { shot: { path: info.path || "", url: "" } });
      }
    } catch {}
  }

  function teardownThread() {
    // Leaving the route aborts a live run (destroy aborts its fetch).
    if (thread) {
      try { thread.destroy(); } catch {}
      thread = null;
      threadSession = "";
    }
    wasRunning = false;
  }

  function showComposer(show) {
    try { composerHost.style.display = show ? "" : "none"; } catch {}
  }

  // Settings routes hide the composer (draft DOM is kept, so nothing is
  // lost). An ACTIVE run is preserved, not aborted: the thread keeps
  // streaming detached, and returning to the chat re-attaches live.
  function leaveForSettings() {
    if (thread && thread.running) {
      thread = null;
      threadSession = "";
      toast("Run continues in the background — return to the chat to follow it", "success");
    } else {
      teardownThread();
    }
    showComposer(false);
  }

  // Shared thread callbacks: pulse on pending cards; refresh the sidebar
  // (running-dot off) when a run ends.
  function threadCallbacks() {
    return {
      onRunState: (r) => {
        composer && composer.setRunning(r);
        if (wasRunning && !r) {
          listSessions(200).then(
            (data) => store.set({ sessions: (data && data.sessions) || [] }),
            () => {},
          );
        }
        wasRunning = r;
      },
      onCardsPending: (n) => composer && composer.setPulse(n > 0),
    };
  }

  function threadTitle(id) {
    const s = (store.get().sessions || []).find((x) => x.id === id);
    return (s && (s.label || s.lastUserMessagePreview)) || "Thread";
  }

  function wireSuggestionCards() {
    for (const card of view.querySelectorAll(".suggest-card")) {
      card.addEventListener("click", () => {
        const prompt = (card.dataset && card.dataset.prompt) || "";
        const label = card.querySelector("span:last-child");
        if (composer) {
          composer.setText(prompt || (label ? label.textContent.trim() : ""));
          composer.focus();
        }
      });
    }
  }

  // A thread belongs to the agent its SESSION was created with, not to
// whatever agent happens to be selected globally. Without this, opening a chat
// that reuses an existing session would keep sending the previously selected
// agentId and the reply would come from the wrong agent. Fall back to the
// global selection only when the session is not in the store (deep link, or a
// reload that has not fetched the list yet).
function agentIdForSession(sessionId) {
    const found = (store.get().sessions || []).find((s) => s.id === sessionId);
    return (found && found.agentId) || store.get().agentId || "main";
  }

  function renderRoute() {
    const hash = window.location.hash || "#/";
    // A parked message belongs to ONE route. If the user navigated somewhere
    // else before it could be flushed, drop it — otherwise typing a message and
    // immediately hitting "Settings" would send that message minutes later the
    // moment they come back to that chat.
    if (pendingSend && hash !== `#/t/${encodeURIComponent(pendingSend.id)}`) {
      pendingSend = null;
    }
    if (hash === "#/" || hash === "#" || hash === "") {
      teardownThread();
      showComposer(true);
      setTitle(store.get().workspace.activeName || "OmniClaw");
      mountEmpty(view);
      wireSuggestionCards();
    } else if (hash.startsWith("#/t/")) {
      const id = decodeURIComponent(hash.slice("#/t/".length));
      if (thread && threadSession === id) {
        setTitle(threadTitle(id));
        return;
      }
      teardownThread();
      showComposer(true);
      setTitle(threadTitle(id));
      thread = mountThread(view, {
        sessionId: id,
        agentId: agentIdForSession(id),
        onSession: () => {},
        onStepOpen: stepOpenToPanel,
        ...threadCallbacks(),
      });
      threadSession = id;
      // §6: /api/events delivers the full record stream (transients included),
      // so a session with activeRunId re-attaches live instead of a note.
      thread.loadHistory(id, { liveNote: false }).then((sess) => {
        if (sess && sess.activeRunId && thread && threadSession === id) {
          thread.attachLive(sess.activeRunId);
        }
        // Resume (sidebar menu): after history is in, send "continue" so the
        // server inherits unfinished plan/run.resume and picks the work back up.
        let resumeId = "";
        try {
          resumeId = sessionStorage.getItem("oc:resume-session") || "";
          if (resumeId === id) sessionStorage.removeItem("oc:resume-session");
        } catch {}
        if (resumeId === id && thread && threadSession === id && !(sess && sess.activeRunId)) {
          setTimeout(() => {
            if (thread && threadSession === id && !thread.running) thread.send("continue");
          }, 250);
        }
        // Flush a message that was typed while this thread was not mounted.
        // Resume wins if both are pending: "continue" is the newer intent.
        if (pendingSend && pendingSend.id === id && thread && threadSession === id
          && resumeId !== id && !thread.running) {
          const parked = pendingSend;
          pendingSend = null;
          setTimeout(() => {
            if (thread && threadSession === id && !thread.running) {
              thread.send(parked.text, { workspacePath: parked.workspacePath });
            }
          }, 250);
        }
      }).catch(() => {});
    } else if (hash === "#/settings" || hash.startsWith("#/settings/")) {
      leaveForSettings();
      const tab = hash === "#/settings" ? "providers" : hash.slice("#/settings/".length);
      setTitle("Settings");
      mountSettings(view, ["general", "appearance", "providers", "permissions", "about"].includes(tab) ? tab : "providers");
    } else if (hash === "#/plugins") {
      teardownThread();
      showComposer(true);
      setTitle("Plugins");
      mountPlugins(view);
    } else if (hash === "#/tools") {
      // T2.2: Skills & Tools page (Core / Toolsets / Operator + health).
      teardownThread();
      showComposer(true);
      setTitle("Skills & Tools");
      mountTools(view);
    } else if (hash === "#/scheduled") {
      teardownThread();
      showComposer(true);
      setTitle("Scheduled");
      view.innerHTML = "";
      view.append(placeholderPage("Scheduled"));
    } else if (hash === "#/changes") {
      // Phase 4 §8: Changes opens the panel Review tab, not a placeholder.
      teardownThread();
      showComposer(true);
      setTitle(store.get().workspace.activeName || "OmniClaw");
      mountEmpty(view);
      wireSuggestionCards();
      try { window.__ocNext.openPanel("review"); } catch {}
    } else {
      teardownThread();
      showComposer(true);
      setTitle("OmniClaw");
      mountEmpty(view);
      wireSuggestionCards();
    }
  }

  // Sidebar "Resume" on the ALREADY-open session: hash doesn't change, so
  // listen for the direct event and continue in place.
  window.addEventListener("oc:resume-session", (e) => {
    const sid = (e && e.detail && e.detail.sessionId) || "";
    if (!thread || !sid || threadSession !== sid || thread.running) return;
    setTimeout(() => { if (thread && threadSession === sid && !thread.running) thread.send("continue"); }, 100);
  });

  // Attachment note: EXACT neo format (public/neo.js:712-715). /api/chat/stream
  // takes no attachments[] — uploads go via POST /api/uploads first.
  function attachNote(atts) {
    if (!atts.length) return "";
    return `\n\n[Attached by user — files saved in the project root:${atts.map((att) => `\n- ${att.relPath}${att.isImage ? " (image — analyze/view it)" : ""}`).join("")}]`;
  }

  // Slash ctx: backend routes + client actions (slash.js).
  const slashCtx = {
    newChat: () => { window.location.hash = "#/"; },
    clearView: () => { if (thread) thread.clearView(); },
    note: (text) => { if (thread) thread.note(text); else toast("Open a chat first", "error"); },
    renamed: (label) => {
      setTitle(label);
      listSessions(200).then((data) => store.set({ sessions: (data && data.sessions) || [] }), () => {});
    },
    deleted: () => {
      store.set({ activeSessionId: "" });
      window.location.hash = "#/";
      listSessions(200).then((data) => store.set({ sessions: (data && data.sessions) || [] }), () => {});
    },
  };

  // Per-chat project bind: an existing chat sends the folder stored on its
  // own session record (so it survives sidebar switches); a new chat sends
  // the currently selected project folder. The server prefers the stored
  // session folder over this value over global active, in that order.
  function sendWorkspacePath() {
    const sid = threadSession || store.get().activeSessionId || "";
    const sess = (store.get().sessions || []).find((x) => x && x.id === sid);
    return (sess && sess.workspacePath) || store.get().workspace.activePath || "";
  }

  composer = mountComposer(composerHost, {
    onSend: (text) => {
      // §5: running run + runId → steer; otherwise a normal send.
      if (thread && thread.running && thread.runId) {
        thread.steer(text);
        return;
      }
      const atts = composer.drainAttachments();
      const outgoing = text + attachNote(atts);
      const workspacePath = sendWorkspacePath();
      // No active thread (home or placeholder route): start a pending thread
      // in the current view. New chats carry a neo-style label (thread.js
      // generateLabel, port of neo.js:730); the server creates the session.
      if (!thread) {
        const activeId = store.get().activeSessionId;
        if (activeId) {
          // Park it. renderRoute() mounts the thread on the hashchange task and
          // flushes this as soon as loadHistory resolves.
          pendingSend = { id: activeId, text: outgoing, workspacePath };
          window.location.hash = `#/t/${encodeURIComponent(activeId)}`;
          return;
        }
        teardownThread();
        const label = generateLabel();
        setTitle(label);
        thread = mountThread(view, {
          sessionId: "",
          agentId: store.get().agentId || "main",
          onStepOpen: stepOpenToPanel,
          onSession: (id) => {
            store.set({ activeSessionId: id });
            threadSession = id;
            try {
              window.history.replaceState(null, "", `#/t/${encodeURIComponent(id)}`);
            } catch {}
            setTitle(threadTitle(id) === "Thread" ? label : threadTitle(id));
            listSessions(200).then(
              (data) => store.set({ sessions: (data && data.sessions) || [] }),
              () => {},
            );
          },
          ...threadCallbacks(),
        });
        threadSession = "";
        thread.setPendingLabel(label);
        view.scrollTop = 0;
      }
      thread.send(outgoing, { workspacePath });
    },
    onStop: () => {
      if (thread) thread.stop();
    },
  });
  composer.addEnterHook(attachSlash(composer.textarea, slashCtx));
  composer.addEnterHook(attachMentions(composer.textarea));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && thread && thread.running && !isPopoverOpen()) {
      e.preventDefault();
      thread.stop();
    }
  });

  // Workspace switch while on home: refresh the empty state (title/activeName).
  // Sidebar regroups via its own subscription; the main column needs this one.
  let lastWsPath = store.get().workspace.activePath;
  store.subscribe(() => {
    const p = store.get().workspace.activePath;
    if (p !== lastWsPath) {
      lastWsPath = p;
      const hash = window.location.hash || "#/";
      if (!thread && (hash === "#/" || hash === "#" || hash === "")) renderRoute();
    }
  });

  startRouter({ onMain: renderRoute });

  requestAnimationFrame(() => {
    window.__ocNext.firstPaint = performance.now();
  });

  // Parallel loads; each renders on resolve. Thread views manage their own DOM:
  // late arrivals only refresh titles/home, never an active thread.
  const refreshAfterLoad = () => {
    const hash = window.location.hash || "#/";
    if (thread) {
      if (hash.startsWith("#/t/")) {
        setTitle(threadTitle(decodeURIComponent(hash.slice("#/t/".length))));
      }
      return;
    }
    renderRoute();
  };

  getWorkspace().then((ws) => {
    const sel = (ws && ws.selection) || {};
    store.setWorkspace({
      activePath: sel.activePath || "",
      activeId: sel.activeId || "",
      activeName: sel.activeName || "",
      recents: sel.recents || [],
      isDefault: sel.isDefault !== false,
    });
    refreshAfterLoad();
  }).catch((e) => console.error("workspace:", e));

  listSessions(200).then((data) => {
    store.set({ sessions: (data && data.sessions) || [] });
    refreshAfterLoad();
  }).catch((e) => console.error("sessions:", e));

  getConfig().then((cfg) => {
    store.set({ config: cfg || {} }); // C2: global permission mode source
  }).catch(() => {});

  // Phase 4 §0: capabilities gate every panel feature (null = old server).
  getCapabilities().then((caps) => {
    store.set({ caps: caps || null });
  }).catch(() => {});

  getStatus().then((st) => {
    store.set({
      gateway: {
        ok: st.gateway.ok, text: st.gateway.text,
        agents: st.agents, cron: st.cron,
        version: st.version, model: st.model,
      },
    });
  }).catch(() => {
    store.set({ gateway: { ...store.get().gateway, ok: false, text: "Gateway offline" } });
    const banner = document.getElementById("banner");
    if (banner) banner.classList.add("show");
  });
}

boot().catch((e) => {
  console.error(e);
  document.getElementById("app").textContent = `Failed to start: ${e.message}`;
});
