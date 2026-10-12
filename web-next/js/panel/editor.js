// Editor pane (right side of the Files tab): plain textarea, no highlighting
// (syntax highlighting is a later enhancement). Optimistic-lock saves via
// POST /api/fs/write {path, content, expectedMtime}.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { fsRead, fsWrite, systemOpen, systemReveal } from "../api.js";
import { toast } from "../ui/toast.js";
import { basename, display, middleEllipsis } from "../utils/path.js";

const MAX_OPEN = 8;

export function createEditor(host, opts = {}) {
  const { onRevealInTree, caps } = opts;
  const wrap = h("div", { class: "ed" });
  const tabRow = h("div", { class: "ed-tabs" });
  const crumbs = h("div", { class: "ed-crumbs" });
  const meta = h("div", { class: "ed-meta" });
  const actions = h("div", { class: "ed-actions" });
  const head = h("div", { class: "ed-head" }, crumbs);
  const sub = h("div", { class: "ed-sub" }, meta, actions);
  const warnBar = h("div", { class: "ed-warn", hidden: true });
  const body = h("div", { class: "ed-body" });
  const gutter = h("div", { class: "ed-gutter", "aria-hidden": "true" });
  const area = h("textarea", {
    class: "ed-area", spellcheck: "false", wrap: "off",
    "aria-label": "File editor",
  });
  body.append(gutter, area);
  wrap.append(tabRow, head, sub, warnBar, body);
  host.append(wrap);

  const state = {
    files: [], // [{path, content, savedContent, mtime, size, dirty}]
    active: "",
    dead: false,
  };

  const byPath = (p) => state.files.find((f) => f.path === p);

  function paintTabs() {
    tabRow.innerHTML = "";
    for (const f of state.files) {
      const b = h("button", {
        class: `ed-tab${f.path === state.active ? " active" : ""}${f.dirty ? " dirty" : ""}`,
        type: "button", title: display(f.path),
      }, h("span", { class: "truncate", text: `${basename(f.path)}${f.dirty ? " •" : ""}` }));
      b.addEventListener("click", () => activate(f.path));
      const x = h("button", { class: "ed-x", type: "button", title: "Close", "aria-label": `Close ${f.path}`, text: "×" });
      x.addEventListener("click", (e) => { e.stopPropagation(); closeFile(f.path); });
      const w = h("span", { class: "ed-tabwrap" }, b, x);
      tabRow.append(w);
    }
    if (!state.files.length) {
      tabRow.append(h("div", { class: "muted small", text: "No file open." }));
    }
  }

  function paintGutter() {
    const f = byPath(state.active);
    const n = f ? f.content.split("\n").length : 1;
    let s = "";
    for (let i = 1; i <= n; i++) s += `${i}\n`;
    gutter.textContent = s;
  }

  function syncGutter() {
    gutter.scrollTop = area.scrollTop;
  }

  function paintHead() {
    const f = byPath(state.active);
    crumbs.innerHTML = "";
    meta.innerHTML = "";
    actions.innerHTML = "";
    warnBar.hidden = true;
    warnBar.innerHTML = "";
    if (!f) {
      crumbs.append(h("span", { class: "muted small", text: "Select a file from the tree." }));
      area.value = "";
      area.disabled = true;
      paintGutter();
      return;
    }
    area.disabled = false;
    // Breadcrumb: clickable segments reveal in tree.
    const parts = String(f.path).split(/[/\\]/).filter(Boolean);
    let acc = /^[A-Za-z]:$/.test(parts[0] || "") ? "" : "";
    parts.forEach((part, i) => {
      if (i > 0 || !/^[A-Za-z]:$/.test(part)) {
        const sep = acc ? "\\" : "";
        const full = `${acc}${sep}${part}`;
        const b = h("button", { class: "crumb", type: "button", text: part });
        b.title = full;
        b.addEventListener("click", () => { try { onRevealInTree && onRevealInTree(full); } catch {} });
        if (i > 0) crumbs.append(h("span", { class: "crumb-sep", text: "/" }));
        crumbs.append(b);
        acc = full;
      } else {
        acc = `${part}\\`;
        const b = h("button", { class: "crumb", type: "button", text: part });
        b.title = acc;
        b.addEventListener("click", () => { try { onRevealInTree && onRevealInTree(acc); } catch {} });
        crumbs.append(b);
      }
    });
    const sizeKb = f.size != null ? `${(f.size / 1024).toFixed(1)} KB` : "";
    meta.append(
      h("span", { class: "muted small", text: sizeKb }),
      f.dirty ? h("span", { class: "dot-dirty", title: "Unsaved changes" }) : null,
    );
    const saveBtn = h("button", { class: "mini-btn", type: "button", text: "Save", title: "Save (Ctrl+S)" });
    saveBtn.disabled = !f.dirty;
    saveBtn.addEventListener("click", () => save(false));
    const reloadBtn = h("button", { class: "mini-btn", type: "button", text: "Reload" });
    reloadBtn.addEventListener("click", () => load(f.path, true));
    actions.append(saveBtn, reloadBtn);
    if (caps && caps.systemOpen && caps.systemOpen.vscode) {
      const vs = h("button", { class: "mini-btn", type: "button", text: "Open in VS Code" });
      vs.addEventListener("click", async () => {
        try {
          await systemOpen(f.path, "vscode");
          toast("Opened in VS Code", "success");
        } catch (e) {
          toast(`VS Code failed: ${e.message}`, "error");
        }
      });
      actions.append(vs);
    }
    if (caps && caps.systemOpen && caps.systemOpen.reveal) {
      const rv = h("button", { class: "mini-btn", type: "button", text: "Reveal in Explorer" });
      rv.addEventListener("click", async () => {
        try {
          await systemReveal(f.path);
        } catch (e) {
          toast(`Reveal failed: ${e.message}`, "error");
        }
      });
      actions.append(rv);
    }
    const cp = h("button", { class: "mini-btn", type: "button", text: "Copy path" });
    cp.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(f.path); } catch {}
    });
    actions.append(cp);
  }

  function paintBody() {
    const f = byPath(state.active);
    if (document.activeElement !== area) {
      area.value = f ? f.content : "";
    }
    paintGutter();
  }

  function paintAll() {
    paintTabs();
    paintHead();
    paintBody();
  }

  async function load(absPath, force) {
    let f = byPath(absPath);
    if (f && !force) {
      activate(absPath);
      return f;
    }
    try {
      const data = await fsRead(absPath);
      if (data.binary) {
        if (!f) {
          f = { path: absPath, content: "", savedContent: "", mtime: data.mtime, size: data.size, dirty: false, binary: true };
          state.files.push(f);
        }
        f.binary = true;
        state.active = absPath;
        paintAll();
        area.value = "";
        area.disabled = true;
        crumbs.innerHTML = "";
        crumbs.append(h("span", { class: "muted small", text: `Binary file — preview not available (${((data.size || 0) / 1024).toFixed(1)} KB).` }));
        return f;
      }
      if (!f) {
        f = { path: absPath, content: "", savedContent: "", mtime: 0, size: 0, dirty: false };
        state.files.push(f);
        while (state.files.length > MAX_OPEN) {
          const evict = state.files.find((x) => x.path !== absPath && !x.dirty) || state.files.find((x) => x.path !== absPath);
          if (!evict) break;
          state.files.splice(state.files.indexOf(evict), 1);
        }
      }
      f.content = data.content || "";
      f.savedContent = f.content;
      f.mtime = data.mtime;
      f.size = data.size;
      f.dirty = false;
      f.binary = false;
      state.active = absPath;
      paintAll();
      return f;
    } catch (e) {
      if (e.message && /413|too large|ETOOBIG/i.test(e.message)) {
        toast("File too large (1MB cap).", "error");
      } else {
        toast(`Open failed: ${e.message}`, "error");
      }
      throw e;
    }
  }

  function activate(absPath) {
    if (!byPath(absPath)) return;
    state.active = absPath;
    paintAll();
  }

  function closeFile(absPath) {
    const f = byPath(absPath);
    if (f && f.dirty && !window.confirm(`Close ${basename(absPath)} without saving?`)) return;
    state.files = state.files.filter((x) => x.path !== absPath);
    if (state.active === absPath) {
      state.active = state.files.length ? state.files[state.files.length - 1].path : "";
    }
    paintAll();
  }

  async function save(force) {
    const f = byPath(state.active);
    if (!f || !f.dirty) return;
    try {
      const res = await fsWrite(f.path, f.content, force ? undefined : f.mtime);
      f.mtime = res.mtime;
      f.savedContent = f.content;
      f.dirty = false;
      f.size = res.bytesWritten;
      paintAll();
      toast("Saved", "success");
    } catch (e) {
      // 409 = expectedMtime mismatch → Reload / Overwrite dialog.
      if (/409|changed on disk/i.test(e.message)) {
        warnBar.hidden = false;
        warnBar.innerHTML = "";
        const msg = h("span", { text: "File changed on disk." });
        const rl = h("button", { class: "mini-btn", type: "button", text: "Reload" });
        rl.addEventListener("click", () => load(f.path, true));
        const ow = h("button", { class: "mini-btn", type: "button", text: "Overwrite" });
        ow.addEventListener("click", () => {
          warnBar.hidden = true;
          warnBar.innerHTML = "";
          save(true);
        });
        warnBar.append(msg, rl, ow);
      } else {
        toast(`Save failed: ${e.message}`, "error");
      }
    }
  }

  area.addEventListener("input", () => {
    const f = byPath(state.active);
    if (!f || f.binary) return;
    f.content = area.value;
    const was = f.dirty;
    f.dirty = f.content !== f.savedContent;
    if (was !== f.dirty) paintAll();
    else paintGutter();
  });
  area.addEventListener("scroll", syncGutter, { passive: true });
  area.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = area.selectionStart;
      const end = area.selectionEnd;
      area.setRangeText("  ", start, end, "end");
      area.dispatchEvent(new Event("input"));
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save(false);
    }
  });

  function markClean(path, mtime) {
    const f = byPath(path);
    if (f && !f.dirty) {
      load(path, true).catch(() => {});
      if (mtime) f.mtime = mtime;
    }
  }

  function agentBar(path) {
    const f = byPath(path);
    if (!f || !f.dirty) return;
    warnBar.hidden = false;
    warnBar.innerHTML = "";
    const msg = h("span", { text: "Agent changed this file." });
    const rl = h("button", { class: "mini-btn", type: "button", text: "Reload" });
    rl.addEventListener("click", () => load(path, true));
    const keep = h("button", { class: "mini-btn", type: "button", text: "Keep mine" });
    keep.addEventListener("click", () => { warnBar.hidden = true; warnBar.innerHTML = ""; });
    warnBar.append(msg, rl, keep);
  }

  const onBeforeUnload = (e) => {
    if (!state.dead && state.files.some((f) => f.dirty)) {
      e.preventDefault();
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  paintAll();

  return {
    open: (absPath) => load(absPath, false),
    reloadIfClean: (absPath, mtime) => markClean(absPath, mtime),
    agentChanged: (absPath) => agentBar(absPath),
    files: () => state.files.map((f) => f.path),
    isDirty: (absPath) => { const f = byPath(absPath); return !!(f && f.dirty); },
    destroy() {
      state.dead = true;
      window.removeEventListener("beforeunload", onBeforeUnload);
    },
  };
}
