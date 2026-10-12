// Hash router: #/  #/t/<sessionId>  #/settings  #/plugins  #/scheduled  #/changes #/tools.
// onChange re-renders MAIN ONLY (sidebar active classes updated in place).

import { store } from "./store.js";

let renderMain = () => {};
let onRoute = () => {};

export function parseRoute(hash) {
  const h = String(hash || "").replace(/^#/, "") || "/";
  const m = h.match(/^\/t\/([^/]+)\/?$/);
  if (m) return { name: "thread", sessionId: decodeURIComponent(m[1]) };
  if (h === "/" || h === "") return { name: "home" };
  if (h === "/settings" || h.startsWith("/settings/")) return { name: "settings" };
  if (h === "/plugins") return { name: "plugins" };
  if (h === "/scheduled") return { name: "scheduled" };
  if (h === "/changes") return { name: "changes" };
  if (h === "/tools") return { name: "tools" };
  return { name: "home" };
}

export function currentRoute() {
  return parseRoute(window.location.hash);
}

export function navigate(to) {
  if (window.location.hash === `#${to}`) {
    renderMain();
    return;
  }
  window.location.hash = `#${to}`;
}

function handle() {
  const route = currentRoute();
  if (route.name === "thread") {
    store.set({ activeSessionId: route.sessionId });
  } else if (route.name === "home") {
    store.set({ activeSessionId: "" });
  }
  renderMain();
  onRoute(route);
}

export function startRouter({ onMain, onChange }) {
  renderMain = onMain;
  if (onChange) onRoute = onChange;
  window.addEventListener("hashchange", handle);
  if (!window.location.hash) window.location.hash = "#/";
  handle();
}
