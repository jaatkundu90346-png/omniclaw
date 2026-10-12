// Shell: mounts sidebar + main (banner + header + view) + panel into #app.
// Keys: Ctrl+B sidebar, Ctrl+N new chat, Esc closes popover first.

import { h } from "../utils/dom.js";
import { store } from "../store.js";
import { mountSidebar } from "./sidebar.js";
import { mountHeader } from "./header.js";
import { closePopover, isPopoverOpen } from "./popover.js";

let headerApi = null;

export function mountShell(root) {
  root.innerHTML = "";

  const shell = h("div", { class: "shell" });
  const aside = h("aside", { id: "sidebar-host" });
  const main = h("main", { class: "main" });
  // 4B.1: global approval banner host (approvals.js mounts here; hidden when
  // nothing is pending). Separate from #banner (gateway offline).
  const apprBanner = h("div", { id: "appr-banner", hidden: true });
  const banner = h("div", { id: "banner", role: "status", text: "Reconnecting to OmniClaw gateway…" });
  const head = h("header", { class: "topbar" });
  const view = h("div", { class: "view", id: "view" });
  const composerHost = h("div", { id: "composer-host" });
  const panelHost = h("aside", { id: "panel-host" });
  main.append(apprBanner, banner, head, view, composerHost);
  shell.append(aside, main, panelHost);
  root.append(shell);

  mountSidebar(aside);
  headerApi = mountHeader(head, { title: "" });

  const syncChrome = () => {
    const s = store.get();
    shell.classList.toggle("sidebar-closed", !s.sidebarOpen);
    shell.classList.toggle("panel-closed", !s.panel.open);
  };
  store.subscribe(syncChrome);
  syncChrome();

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      store.set({ sidebarOpen: !store.get().sidebarOpen });
    } else if (mod && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      window.location.hash = "#/";
    } else if (e.key === "Escape" && isPopoverOpen()) {
      closePopover();
    }
  });

  return { view, composerHost, panelHost, apprBanner, setTitle: (t) => headerApi && headerApi.setTitle(t) };
}
