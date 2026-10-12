// Header: sidebar toggle · title · "…" · right: panel toggle.
// No mode control (C1). No Connected/Working badges.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import { openPopover, closePopover } from "./popover.js";
import { systemReveal, systemOpen } from "../api.js";
import { toast } from "./toast.js";

export function mountHeader(root, { title = "" } = {}) {
  root.innerHTML = "";
  const s = store.get();

  const toggleBtn = h("button", {
    class: "icon-btn", title: "Toggle sidebar (Ctrl+B)", "aria-label": "Toggle sidebar", html: icons.panelLeft,
    onclick: () => store.set({ sidebarOpen: !store.get().sidebarOpen }),
  });

  const titleEl = h("div", { class: "title truncate", text: title });
  const spacer = h("div", { class: "spacer" });

  const moreBtn = h("button", {
    class: "icon-btn", title: "More actions", "aria-label": "More actions",
    "aria-haspopup": "menu", "aria-expanded": "false", html: icons.more,
  });
  moreBtn.addEventListener("click", () => {
    const body = h("div", null,
      h("button", { class: "pop-item", text: "Copy page URL", onclick: () => {} }),
    );
    body.querySelector("button").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(window.location.href); } catch {}
      closePopover();
    });
    openPopover(moreBtn, body, { align: "end" });
  });

  // "Open in ▾": Copy path always. Explorer/VS Code need a backend
  // open/reveal route — none exists (see docs/FRONTEND_TODO.md), so they
  // are hidden, never faked. The browser must never shell out.
  const openBtn = h("button", {
    class: "open-btn", type: "button", title: "Open workspace",
    "aria-haspopup": "menu", "aria-expanded": "false",
  }, h("span", { text: "Open in" }), h("span", { html: icons.chevronDown }));
  openBtn.addEventListener("click", () => {
    // Phase 4 §8: real POSTs, gated by caps (Explorer/VS Code need a backend
    // route — B1 provides both; hidden when caps say otherwise).
    const caps = store.get().caps || {};
    const sys = caps.systemOpen || {};
    const wsPath = (store.get().workspace || {}).activePath || "";
    const body = h("div", null);
    const cp = h("button", { class: "pop-item", type: "button", text: "Copy path" });
    cp.title = wsPath;
    cp.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(wsPath); } catch {}
      closePopover();
    });
    body.append(cp);
    if (sys.reveal) {
      const rv = h("button", { class: "pop-item", type: "button", text: "Reveal in Explorer" });
      rv.addEventListener("click", async () => {
        closePopover();
        try {
          await systemReveal(wsPath);
          toast("Revealed in Explorer", "success");
        } catch (e) {
          toast(`Reveal failed: ${e.message}`, "error");
        }
      });
      body.append(rv);
    }
    if (sys.vscode) {
      const vs = h("button", { class: "pop-item", type: "button", text: "Open in VS Code" });
      vs.addEventListener("click", async () => {
        closePopover();
        try {
          await systemOpen(wsPath, "vscode");
          toast("Opened in VS Code", "success");
        } catch (e) {
          toast(`VS Code failed: ${e.message}`, "error");
        }
      });
      body.append(vs);
    }
    openPopover(openBtn, body, { align: "end" });
  });

  const panelBtn = h("button", {
    class: "icon-btn", title: "Toggle panel", "aria-label": "Toggle panel", html: icons.panelRight,
    onclick: () => store.setPanel({ open: !store.get().panel.open }),
  });
  panelBtn.setAttribute("aria-pressed", String(s.panel.open));

  root.append(toggleBtn, titleEl, spacer, openBtn, moreBtn, panelBtn);
  return {
    setTitle(t) { titleEl.textContent = t; },
  };
}
