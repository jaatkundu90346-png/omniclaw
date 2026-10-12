// "@" mentions: browse the workspace with client-side navigation (no full-tree
// scan — GET /api/fs/browse, server.js:1981, returns folders ONLY). Files come
// from POST /api/tools/run list tools (api.listFilesWithTool) with graceful
// fallback to folders-only. Inserted verbatim as @relative/path (forward
// slashes fine — the text is for the model; no mentions[] field exists).

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import { browseFs, listFilesWithTool } from "../api.js";
import { openPopover, closePopover } from "./popover.js";

function caretCoords(textarea) {
  // Mirror div technique: copy styles, inject marker at caret, measure it.
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const props = ["font", "fontSize", "fontFamily", "lineHeight", "padding", "border",
    "boxSizing", "width", "whiteSpace", "wordWrap", "overflowWrap", "letterSpacing"];
  for (const p of props) {
    try { mirror.style[p] = style[p]; } catch {}
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  const upto = textarea.value.slice(0, textarea.selectionStart);
  mirror.textContent = upto;
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(marker);
  document.body.append(mirror);
  const tr = textarea.getBoundingClientRect();
  const mr = marker.getBoundingClientRect();
  const x = tr.left + (mr.left - mirror.getBoundingClientRect().left);
  const y = tr.top + (mr.top - mirror.getBoundingClientRect().top);
  mirror.remove();
  return { x, y };
}

function caretAnchor(textarea) {
  const { x, y } = caretCoords(textarea);
  const a = document.createElement("div");
  a.style.cssText = `position:fixed;left:${Math.round(x)}px;top:${Math.round(y + 20)}px;width:1px;height:1px;z-index:49;`;
  document.body.append(a);
  return a;
}

function splitAtQuery(textarea) {
  const pos = textarea.selectionStart;
  const before = textarea.value.slice(0, pos);
  const m = before.match(/(^|\s)@([^\s]*)$/);
  if (!m) return null;
  return { at: m.index + m[1].length, query: m[2] };
}

// Resolve "a/b/par" → { dirAbs, prefix } against the workspace root.
function resolveDir(activeRoot, query) {
  const parts = query.split("/");
  const prefix = parts.pop() || "";
  const rel = parts.join("/");
  const sep = activeRoot.includes("\\") ? "\\" : "/";
  const dirAbs = rel ? activeRoot.replace(/[/\\]+$/, "") + sep + rel.replace(/\//g, sep) : activeRoot;
  const relBase = rel ? `${rel}/` : "";
  return { dirAbs, prefix, relBase };
}

export function attachMentions(textarea) {
  // Returns cleanup. One popover at a time; re-rendered per keystroke.
  let session = null;
  let gen = 0;

  const close = () => {
    if (session) {
      session.anchor.remove();
      closePopover();
      session = null;
    }
  };

  async function render() {
    if (!session) return;
    const myGen = ++gen;
    const { activeRoot } = session;
    const parsed = splitAtQuery(textarea);
    if (!parsed) { close(); return; }
    const { dirAbs, prefix, relBase } = resolveDir(activeRoot, parsed.query);
    session.queryAt = parsed.at;

    let dirs = [];
    let files = [];
    try {
      const data = await browseFs(dirAbs);
      if (data) dirs = data.directories || data.entries || [];
    } catch {}
    try {
      files = await listFilesWithTool(dirAbs);
    } catch {
      files = [];
    }
    if (!session || myGen !== gen) return;

    const needle = prefix.toLowerCase();
    const matchName = (n) => !needle || String(n || "").toLowerCase().includes(needle);
    const dirRows = dirs
      .map((d) => (typeof d === "string" ? { name: d.split(/[/\\]/).pop() } : d))
      .filter((d) => d && matchName(d.name))
      .map((d) => ({ kind: "dir", name: d.name }));
    const fileRows = files
      .filter((f) => f && f.type !== "folder" && f.type !== "directory" && matchName(f.name))
      .map((f) => ({ kind: "file", name: f.name }));
    const rows = [...dirRows, ...fileRows].slice(0, 12);

    const body = h("div", null);
    if (!rows.length) {
      body.append(h("div", { class: "pop-label", text: "No matches" }));
    }
    for (const row of rows) {
      const rel = `${relBase}${row.name}${row.kind === "dir" ? "/" : ""}`;
      const b = h("button", { class: "pop-item", type: "button" },
        h("span", { html: row.kind === "dir" ? icons.folder : icons.message }),
        h("span", { class: "truncate", text: row.kind === "dir" ? `${row.name}/` : row.name }));
      b.title = rel;
      b.addEventListener("click", () => {
        if (row.kind === "dir") {
          // ▸ enters: keep the @query open at the deeper level.
          const pos = textarea.selectionStart;
          const before = textarea.value.slice(0, session.queryAt);
          const after = textarea.value.slice(pos);
          textarea.value = `${before}@${rel}${after}`;
          textarea.selectionStart = textarea.selectionEnd = (before + `@${rel}`).length;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.focus();
          return;
        }
        insertMention(rel);
      });
      body.append(b);
    }
    session.anchor.remove();
    session.anchor = caretAnchor(textarea);
    // focusFirst:false — the textarea keeps focus so typing continues;
    // arrows/Enter are handled by the textarea key handler below.
    openPopover(session.anchor, body, { focusFirst: false });
  }

  function insertMention(rel) {
    if (!session) return;
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, session.queryAt);
    const after = textarea.value.slice(pos);
    const ins = `@${rel} `;
    textarea.value = `${before}${ins}${after}`;
    textarea.selectionStart = textarea.selectionEnd = (before + ins).length;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    close();
  }

  let debounce = null;
  const onInput = () => {
    clearTimeout(debounce);
    const parsed = splitAtQuery(textarea);
    if (!parsed) { close(); return; }
    // Backspace at empty query goes up: navigate by re-render (parent shown
    // via "…" row below); the query text itself drives the level.
    if (!session) {
      const root = (store.get().workspace && store.get().workspace.activePath) || "";
      if (!root) return;
      session = { anchor: caretAnchor(textarea), activeRoot: root, queryAt: 0 };
    } else {
      session.anchor.remove();
      session.anchor = caretAnchor(textarea);
    }
    debounce = setTimeout(render, 150);
  };

  const onKey = (e) => {
    if (!session) return false;
    const items = () => [...document.querySelectorAll(".popover .pop-item")];
    if (e.key === "Escape") { e.stopPropagation(); close(); textarea.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = items();
      if (!list.length) return false;
      e.preventDefault();
      const i = list.indexOf(document.activeElement);
      const next = e.key === "ArrowDown"
        ? list[(i + 1) % list.length]
        : list[(i - 1 + list.length) % list.length];
      next.focus();
    } else if (e.key === "Tab") {
      // Tab is free (composer doesn't use it): insert first/focused row.
      const focused = document.activeElement;
      const target = focused && focused.classList.contains("pop-item") ? focused : items()[0];
      if (target) {
        e.preventDefault();
        target.click();
      }
    }
    return false;
  };

  // handleEnter is called by the composer BEFORE its own send logic.
  // An open mention UI ALWAYS consumes Enter (pick row, or dismiss when
  // empty) — typing "@AG" + Enter must never send "@AG" as a message.
  function handleEnter() {
    if (!session) return false;
    const focused = document.activeElement;
    const items = [...document.querySelectorAll(".popover .pop-item")];
    const target = focused && focused.classList.contains("pop-item") ? focused : items[0];
    if (target) target.click();
    else close();
    return true;
  }

  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKey);
  return {
    detach() {
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("keydown", onKey);
      close();
    },
    handleEnter,
  };
}
