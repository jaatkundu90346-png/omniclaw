// "/" commands: ONLY route-backed commands + pure client actions.
// Backend-backed (server.js lines in comments); unknown /text → normal message.

import { h } from "../utils/dom.js";
import { store } from "../store.js";
import {
  compactSession, exportSession, renameSession, archiveSession, memorySearch,
} from "../api.js";
import { openPopover, closePopover } from "./popover.js";
import { toast } from "./toast.js";

// Populated per-open (needs session context); handlers set by composer host.
export function slashCommands(ctx) {
  const sid = () => store.get().activeSessionId;
  return [
    { name: "/new", desc: "New chat", hint: "client", run: () => ctx.newChat() },
    {
      name: "/clear-view", desc: "Clear thread view (local only)", hint: "client",
      run: () => { if (window.confirm("Clear the rendered thread? Server history is kept.")) ctx.clearView(); },
    },
    {
      name: "/compact", desc: "Compact session transcript", hint: "POST /api/sessions/compact (server.js:2880)",
      needsSession: true,
      run: async () => {
        // backend: server.js:2880 POST /api/sessions/compact {sessionId, maxEntries?}
        const r = await compactSession(sid());
        ctx.note(`Session compacted (${r.kept ?? "?"} kept).`);
      },
    },
    {
      name: "/export", desc: "Download session JSON", hint: "GET /api/sessions/:id/export (server.js:2695)",
      needsSession: true,
      run: async () => {
        // backend: server.js:2695 GET /api/sessions/:id/export
        const data = await exportSession(sid());
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${sid()}.json`;
        document.body.append(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        ctx.note("Session exported.");
      },
    },
    {
      name: "/rename", desc: "Rename chat: /rename <name>", hint: "POST /api/sessions/rename (server.js:1514)",
      needsSession: true, takesArg: true,
      run: async (arg) => {
        if (!arg) throw new Error("Usage: /rename <name>");
        // backend: server.js:1514 POST /api/sessions/rename {sessionId, label}
        await renameSession(sid(), arg);
        ctx.renamed(arg);
      },
    },
    {
      name: "/delete", desc: "Archive chat (confirm)", hint: "POST /api/sessions/reset (server.js:1531)",
      needsSession: true,
      run: async () => {
        if (!window.confirm("Archive this chat?")) return;
        // backend: server.js:1531 POST /api/sessions/reset (archive; no true delete)
        await archiveSession(sid());
        ctx.deleted();
      },
    },
    {
      name: "/memory", desc: "Search memory: /memory <query>", hint: "GET /api/memory/search (server.js:2862)",
      takesArg: true,
      run: async (arg) => {
        if (!arg) throw new Error("Usage: /memory <query>");
        // backend: server.js:2862 GET /api/memory/search?q=
        const r = await memorySearch(arg);
        const res = (r && r.results) || r || {};
        const counts = ["notes", "longTerm", "research", "artifacts"]
          .map((k) => `${k}: ${Array.isArray(res[k]) ? res[k].length : 0}`).join(", ");
        ctx.note(`Memory for "${arg}" — ${counts}.`);
      },
    },
  ];
}

export function attachSlash(textarea, ctx) {
  let open = false;

  const close = () => {
    if (open) { closePopover(); open = false; }
  };

  const isTrigger = () => {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    return /^\/[^\s\n]*$/.test(before);
  };

  const currentToken = () => {
    const pos = textarea.selectionStart;
    const before = textarea.value.slice(0, pos);
    const m = before.match(/\/([^\s\n]*)$/);
    return m ? `/${m[1]}` : "/";
  };

  function render() {
    const token = currentToken().toLowerCase();
    const all = slashCommands(ctx);
    const list = all.filter((c) => c.name.startsWith(token) || token === "/");
    const body = h("div", null);
    if (!list.length) { close(); return; }
    for (const cmd of list) {
      const b = h("button", { class: "pop-item", type: "button" },
        h("span", { class: "mono", text: cmd.name }),
        h("span", { class: "truncate", style: "color:var(--muted);font-size:12px", text: cmd.desc }));
      b.title = cmd.hint;
      b.addEventListener("click", () => choose(cmd));
      body.append(b);
    }
    // Anchor under the textarea (composer bottom sheet).
    openPopover(textarea, body, { align: "start", focusFirst: false });
    open = true;
  }

  // Take "/cmd args…" from the box, clear it, then execute.
  function takeLine() {
    const m = textarea.value.match(/^\s*\/(\S+)[ \t]*([^\n]*)$/);
    return m ? { cmd: `/${m[1]}`, arg: (m[2] || "").trim() } : null;
  }

  function clearBox() {
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Spec: selecting FILLS the textarea; Enter executes. takeLine parses
  // "/cmd args…" (args may contain spaces); unknown /text → not a command.
  function lookup(name) {
    return slashCommands(ctx).find((c) => c.name === name) || null;
  }

  async function choose(cmd) {
    // Fill "/cmd " and let the user add args, then Enter executes.
    close();
    textarea.value = `${cmd.name} `;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  async function exec(cmd, arg) {
    if (cmd.needsSession && !store.get().activeSessionId) {
      toast("Open a chat first — this command needs a session", "error");
      return;
    }
    try {
      await cmd.run(arg || "");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  const onInput = () => {
    if (isTrigger()) render();
    else close();
  };

  const onKey = (e) => {
    if (!open) return false;
    if (e.key === "Escape") { e.stopPropagation(); close(); return false; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...document.querySelectorAll(".popover .pop-item")];
      if (!items.length) return false;
      e.preventDefault();
      e.stopPropagation();
      const i = items.indexOf(document.activeElement);
      const next = e.key === "ArrowDown"
        ? items[(i + 1) % items.length]
        : items[(i - 1 + items.length) % items.length];
      next.focus();
      return true;
    }
    return false;
  };

  // handleEnter is called by the composer BEFORE its own send logic.
  // Menu open → activate focused row. Menu closed but line is a known
  // "/cmd args…" → execute it. Unknown /text → false (normal send).
  // Returns true when consumed.
  function handleEnter() {
    if (open) {
      const focused = document.activeElement;
      const items = [...document.querySelectorAll(".popover .pop-item")];
      const target = focused && focused.classList.contains("pop-item") ? focused : items[0];
      if (!target) return false;
      target.click();
      return true;
    }
    const taken = takeLine();
    if (!taken) return false;
    const cmd = lookup(taken.cmd);
    if (!cmd) return false;
    clearBox();
    close();
    exec(cmd, taken.arg).catch(() => {});
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
    isOpen: () => open,
    handleEnter,
  };
}
