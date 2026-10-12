// Skills & Tools page (T2.2): Core / Toolsets / Operator groups with health
// badges from GET /api/tools?view=layers (runtimeStatus). Read-only.
import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { getToolsLayers } from "../api.js";

function badge(status) {
  const s = String(status || "ready");
  const cls = s === "ready" ? "ok" : s === "partial" ? "warn" : "bad";
  return h("span", { class: `tool-badge ${cls}`, text: s, title: `runtime: ${s}` });
}

function toolRow(tool, muted) {
  const row = h("div", { class: `tool-row${muted ? " muted" : ""}` });
  row.append(
    h("span", { class: "tool-name", text: tool.id, title: tool.description || tool.id }),
    h("span", { class: "tool-desc truncate", text: tool.description || "" }),
    badge(tool.runtimeStatus),
  );
  if (tool.permission) row.title = `${tool.description || tool.id}\npermission: ${tool.permission}`;
  return row;
}

export function mountTools(view) {
  view.innerHTML = "";
  const root = h("div", { class: "tools-page" });
  root.append(h("h2", { text: "Skills & Tools" }));
  const note = h("p", { class: "muted small", text: "Loading…" });
  root.append(note);
  view.append(root);

  getToolsLayers().then((data) => {
    if (!root.isConnected) return;
    note.remove();
    const core = h("div", { class: "tools-group" },
      h("h3", { text: `Core (always in the menu, ${(data.core || []).length})` }));
    for (const t of data.core || []) core.append(toolRow(t));
    root.append(core);
    for (const [name, set] of Object.entries(data.toolsets || {})) {
      const g = h("div", { class: "tools-group" },
        h("h3", { text: `${name} (${(set.tools || []).length})` }),
        h("p", { class: "muted small", text: set.description || "" }));
      for (const t of set.tools || []) g.append(toolRow(t));
      root.append(g);
    }
    const op = h("div", { class: "tools-group" },
      h("h3", { text: `Operator — UI/API only (${(data.operator || []).length})` }),
      h("p", { class: "muted small", text: "The model cannot call these; it gets a directions error instead." }));
    for (const t of data.operator || []) op.append(toolRow(t, true));
    root.append(op);
    if ((data.alias || []).length) {
      const al = h("div", { class: "tools-group" },
        h("h3", { text: `Aliases — callable, never in menu (${data.alias.length})` }));
      for (const t of data.alias || []) al.append(toolRow(t, true));
      root.append(al);
    }
  }).catch((e) => {
    if (!root.isConnected) return;
    note.textContent = `Could not load tools: ${e.message}`;
  });
}
