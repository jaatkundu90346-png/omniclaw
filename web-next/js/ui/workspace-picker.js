// Workspace picker modal — restyle of neo's flow, SAME endpoints
// (browseFs = GET /api/fs/browse?path=, server.js:1981;
// selectWorkspace = POST /api/workspace/select, server.js:1927).
// Typing "D:\" works (browse validates existence only); no drive dropdown
// exists server-side, so none is faked here.

import { h } from "../utils/dom.js";
import { store } from "../store.js";
import { browseFs, selectWorkspace, listSessions } from "../api.js";
import { basename } from "../utils/path.js";
import { toast } from "./toast.js";

function crumbs(path) {
  // Split "C:\a\b" or "/a/b" into clickable segments.
  const parts = String(path || "").split(/[/\\]+/).filter(Boolean);
  let acc = /^[A-Za-z]:$/.test(parts[0] || "") ? "" : (/^[\\/]/.test(path) ? "/" : "");
  const out = [];
  if (/^[A-Za-z]:$/.test(parts[0] || "")) {
    acc = `${parts[0]}\\`;
    out.push({ label: parts[0], path: acc });
    parts.shift();
  }
  for (const part of parts) {
    acc = acc ? `${acc.replace(/[/\\]+$/, "")}/${part}` : `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

export async function openWorkspacePicker() {
  const s = store.get();
  const back = h("div", { class: "modal-back" });
  const modal = h("div", { class: "modal ws-modal", role: "dialog", "aria-label": "Select workspace" },
    h("h2", { text: "Select workspace" }));
  const crumbRow = h("div", { class: "ws-crumbs" });
  const input = h("input", { type: "text", placeholder: "C:\\path\\to\\project", "aria-label": "Folder path" });
  const goBtn = h("button", { class: "btn", type: "button", text: "Go" });
  const cols = h("div", { class: "ws-cols" });
  const listPane = h("div", { class: "ws-list" });
  const recPane = h("div", { class: "ws-recents" });
  const err = h("p", { class: "small", style: "color: var(--down)" });
  const cancelBtn = h("button", { class: "btn", type: "button", text: "Cancel" });
  const selectBtn = h("button", { class: "btn primary", type: "button", text: "Select this folder" });
  cols.append(listPane, recPane);
  modal.append(crumbRow,
    h("div", { class: "row" }, input, goBtn),
    cols, err,
    h("div", { class: "row", style: "justify-content: flex-end" }, cancelBtn, selectBtn));
  back.append(modal);
  document.body.append(back);

  // Focus trap (simple): keep Tab inside the modal.
  const focusables = () => [...modal.querySelectorAll("button, input")].filter((n) => !n.disabled);
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      back.remove();
    }
  });

  let cwd = s.workspace.activePath || "";
  if (!cwd && s.workspace.recents.length) cwd = s.workspace.recents[0].path;

  function paintCrumbs(path) {
    crumbRow.innerHTML = "";
    for (const c of crumbs(path)) {
      const b = h("button", { class: "crumb", type: "button", text: c.label });
      b.title = c.path;
      b.addEventListener("click", () => renderBrowse(c.path));
      crumbRow.append(b, h("span", { class: "crumb-sep", text: "/" }));
    }
  }

  async function renderBrowse(path) {
    listPane.innerHTML = "";
    err.textContent = "";
    try {
      const data = await browseFs(path);
      cwd = data.path || path;
      input.value = cwd;
      paintCrumbs(cwd);
      const up = h("button", { class: "ws-row", type: "button", text: "… (up)" });
      up.addEventListener("click", () => {
        const parent = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).slice(0, -1).join("\\") || cwd;
        renderBrowse(parent === cwd ? cwd : parent);
      });
      listPane.append(up);
      for (const d of data.directories || []) {
        const b = h("button", { class: "ws-row", type: "button" },
          h("span", { text: `📁 ${d.name || basename(d.path)}` }));
        b.title = d.path;
        b.addEventListener("click", () => {
          input.value = d.path;
          cwd = d.path;
          paintCrumbs(cwd);
        });
        b.addEventListener("dblclick", () => renderBrowse(d.path));
        listPane.append(b);
      }
    } catch (e) {
      err.textContent = e.message;
    }
  }

  recPane.append(h("div", { class: "pop-label", text: "Recent" }));
  for (const r of s.workspace.recents || []) {
    const active = r.path === s.workspace.activePath;
    const b = h("button", { class: "ws-row", type: "button" },
      h("span", { text: `${basename(r.path)}${active ? " ✓" : ""}` }));
    const sub = h("div", { class: "small muted truncate", text: r.path });
    const wrap = h("div", null, b, sub);
    b.title = r.path;
    b.addEventListener("click", () => {
      input.value = r.path;
      cwd = r.path;
      paintCrumbs(cwd);
      renderBrowse(r.path);
    });
    recPane.append(wrap);
  }

  const close = () => back.remove();
  goBtn.addEventListener("click", () => renderBrowse(input.value.trim()));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") renderBrowse(input.value.trim()); });
  input.addEventListener("click", (e) => e.stopPropagation());
  cancelBtn.addEventListener("click", close);
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  selectBtn.addEventListener("click", async () => {
    err.textContent = "";
    selectBtn.disabled = true;
    try {
      const result = await selectWorkspace((input.value || cwd || "").trim());
      const sel = result.selection || {};
      store.setWorkspace({
        activePath: sel.activePath || input.value,
        activeId: sel.activeId || "",
        activeName: sel.activeName || basename(input.value),
        recents: sel.recents || s.workspace.recents,
        isDefault: !!sel.isDefault,
      });
      try {
        const data = await listSessions(200);
        store.set({ sessions: data.sessions || [] });
      } catch {}
      toast(`Workspace: ${store.get().workspace.activeName}`, "success");
      close();
    } catch (e) {
      err.textContent = e.message;
      toast(`Workspace switch failed: ${e.message}`, "error");
    } finally {
      selectBtn.disabled = false;
    }
  });

  input.focus();
  renderBrowse(cwd);
}
