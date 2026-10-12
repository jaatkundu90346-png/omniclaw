// Files tab: left tree (GET /api/fs/tree, lazy children) + search
// (GET /api/fs/search, 200ms debounce), right = editor pane.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { fsTree, fsSearch } from "../api.js";
import { toast } from "../ui/toast.js";
import { basename, display, middleEllipsis } from "../utils/path.js";
import { createEditor } from "./editor.js";

const EXT_ICON = {
  js: "terminal", mjs: "terminal", cjs: "terminal", ts: "terminal",
  json: "settings", md: "message", txt: "message", log: "message",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
};

function iconFor(name, isDir) {
  if (isDir) return "folder";
  const ext = String(name || "").split(".").pop().toLowerCase();
  return EXT_ICON[ext] || "message";
}

function normFs(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

export function mountFilesTab(el, ctx, arg = {}) {
  el.innerHTML = "";
  const wrap = h("div", { class: "files" });
  const head = h("div", { class: "tab-head" },
    h("span", { class: "tab-title", text: "Files" }),
    h("span", { class: "tab-actions" }));
  const split = h("div", { class: "files-split" });
  const left = h("div", { class: "files-tree" });
  const search = h("input", {
    type: "text", placeholder: "Search files…", "aria-label": "Search files",
  });
  const treeHost = h("div", { class: "tree-host" });
  left.append(search, treeHost);
  const right = h("div", { class: "files-ed" });
  split.append(left, right);
  wrap.append(head, split);
  el.append(wrap);

  const state = { dead: false, root: "", query: "", expanded: new Set(), tree: [], fetched: new Set() };

  function findEntry(entries, np) {
    for (const e of entries || []) {
      if (normFs(e.path) === np) return e;
      if (e.children) {
        const hit = findEntry(e.children, np);
        if (hit) return hit;
      }
    }
    return null;
  }

  function paintTree() {
    treeHost.innerHTML = "";
    renderTree(state.tree, 0, treeHost);
    if (!state.tree.length) {
      treeHost.append(h("div", { class: "muted small", text: "Empty folder." }));
    }
  }

  async function ensureChildren(entry) {
    const np = normFs(entry.path);
    if (Array.isArray(entry.children) || state.fetched.has(np)) return;
    state.fetched.add(np);
    try {
      const data = await fsTree(entry.path, 2);
      if (state.dead) return;
      const target = findEntry(state.tree, np);
      if (target) target.children = data.entries || [];
      paintTree();
    } catch (e) {
      toast(`Folder failed: ${e.message}`, "error");
    }
  }

  const editor = createEditor(right, {
    caps: ctx.caps,
    onRevealInTree: (absPath) => reveal(absPath),
  });

  function nodeRow(entry, depth) {
    const isDir = entry.type === "directory";
    const row = h("div", {
      class: "tree-row", role: "treeitem", tabindex: "0",
      "aria-expanded": isDir ? String(state.expanded.has(normFs(entry.path))) : undefined,
      title: display(entry.path),
    });
    row.style.paddingLeft = `${6 + depth * 14}px`;
    if (isDir) {
      const open = state.expanded.has(normFs(entry.path));
      row.append(h("span", { class: "chev", html: icons.chevronRight }));
      if (open) row.querySelector(".chev svg").style.transform = "rotate(90deg)";
    } else {
      row.append(h("span", { class: "chev-sp" }));
    }
    row.append(
      h("span", { class: "t-ic", html: icons[iconFor(entry.name, isDir)] }),
      h("span", { class: "truncate", text: entry.name }),
    );
    const activate = () => {
      if (isDir) {
        const k = normFs(entry.path);
        if (state.expanded.has(k)) {
          state.expanded.delete(k);
          paintTree();
        } else {
          state.expanded.add(k);
          // Lazy-load children past the initial depth, then repaint.
          ensureChildren(entry).then(() => paintTree());
          paintTree();
        }
      } else {
        editor.open(entry.path).catch(() => {});
      }
    };
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
    return row;
  }

  function renderTree(entries, depth, host) {
    for (const e of entries || []) {
      host.append(nodeRow(e, depth));
      if (e.type === "directory" && state.expanded.has(normFs(e.path)) && Array.isArray(e.children)) {
        renderTree(e.children, depth + 1, host);
      }
    }
  }

  async function loadRoot() {
    if (state.dead) return;
    const root = (ctx.workspace && ctx.workspace.activePath) || "";
    state.root = root;
    if (!root) {
      treeHost.innerHTML = "";
      treeHost.append(h("div", { class: "panel-empty small", text: "No workspace selected." }));
      return;
    }
    treeHost.innerHTML = "";
    treeHost.append(h("div", { class: "muted small", text: "Loading…" }));
    try {
      const data = await fsTree(root, 2);
      if (state.dead) return;
      state.tree = data.entries || [];
      paintTree();
    } catch (e) {
      if (state.dead) return;
      treeHost.innerHTML = "";
      treeHost.append(h("div", { class: "panel-empty small", text: `Tree failed: ${e.message}` }));
    }
  }

  let searchTimer = null;
  let searchGen = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = search.value;
    if (!q.trim()) {
      state.query = "";
      loadRoot();
      return;
    }
    searchTimer = setTimeout(async () => {
      const my = ++searchGen;
      state.query = q;
      treeHost.innerHTML = "";
      treeHost.append(h("div", { class: "muted small", text: "Searching…" }));
      try {
        const data = await fsSearch(q.trim(), 50, state.root);
        if (state.dead || my !== searchGen) return;
        treeHost.innerHTML = "";
        for (const e of data.entries || []) {
          const row = h("div", { class: "tree-row", role: "treeitem", tabindex: "0", title: display(e.path) });
          row.append(
            h("span", { class: "chev-sp" }),
            h("span", { class: "t-ic", html: icons[iconFor(e.name, false)] }),
            h("span", { class: "truncate", text: middleEllipsis(e.path, 48) }),
          );
          const open = () => editor.open(e.path).catch(() => {});
          row.addEventListener("click", open);
          row.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
          });
          treeHost.append(row);
        }
        if (!(data.entries || []).length) {
          treeHost.append(h("div", { class: "muted small", text: "No matches." }));
        }
      } catch (e) {
        if (state.dead || my !== searchGen) return;
        treeHost.innerHTML = "";
        treeHost.append(h("div", { class: "panel-empty small", text: `Search failed: ${e.message}` }));
      }
    }, 200);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      search.value = "";
      state.query = "";
      loadRoot();
    }
  });

  function reveal(absPath) {
    // Best-effort: expand the ancestor chain, reload, scroll the row into
    // view when present. The file itself always opens in the editor.
    const np = normFs(absPath);
    const parts = np.split("/");
    let acc = "";
    for (const part of parts.slice(0, -1)) {
      acc = acc ? `${acc}/${part}` : part;
      state.expanded.add(acc);
    }
    editor.open(absPath).catch(() => {});
    loadRoot().then(() => {
      const rows = [...treeHost.querySelectorAll(".tree-row")];
      const hit = rows.find((r) => normFs(r.title || "") === np);
      if (hit) hit.scrollIntoView({ block: "nearest" });
    }).catch(() => {});
  }

  // Agent edits: silent reload when clean (+toast), yellow bar when dirty.
  // Paths may be relative (model input) or absolute (tree) — match by suffix.
  function sameFile(a, b) {
    const na = normFs(a);
    const nb = normFs(b);
    if (!na || !nb) return false;
    return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
  }
  const onFsChanged = (e) => {
    const p = e && e.detail && e.detail.path;
    if (!p) return;
    const open = editor.files().find((f) => sameFile(f, p));
    if (!open) return;
    if (editor.isDirty(open)) editor.agentChanged(open);
    else {
      editor.reloadIfClean(open);
      toast("Reloaded: agent edited this file", "success");
    }
  };
  window.addEventListener("oc:fs-changed", onFsChanged);

  // Open a file from thread step rows / review tab.
  if (arg && arg.path) {
    loadRoot().then(() => editor.open(arg.path).catch(() => {}));
  } else {
    loadRoot();
  }

  return {
    update(c) {
      if (c && c.arg && c.arg.path) {
        editor.open(c.arg.path).catch(() => {});
      }
    },
    unmount() {
      state.dead = true;
      clearTimeout(searchTimer);
      window.removeEventListener("oc:fs-changed", onFsChanged);
      try { editor.destroy(); } catch {}
    },
  };
}
