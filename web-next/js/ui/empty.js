// Home empty state: "What should we build in <activeName>?" + 4 cards
// (no-op click for now, but focusable). Workspace picker if none selected.

import { h } from "../utils/dom.js";
import { icons, brand as brandSvg } from "../icons.js";
import { store } from "../store.js";
import { openWorkspacePicker } from "./workspace-picker.js";

const CARDS = [
  { icon: "search", text: "Explore and understand code", prompt: "Explore this project and explain the structure, key files, and how to run it." },
  { icon: "pencil", text: "Build a new feature, app, or tool", prompt: "Build a new feature in this project. First inspect the relevant files, then implement it step by step." },
  { icon: "diff", text: "Review code and suggest changes", prompt: "Review the current git changes and suggest concrete improvements." },
  { icon: "puzzle", text: "Fix issues and failures", prompt: "Find and fix the failing behavior. Reproduce first, then fix and verify." },
];

export function mountEmpty(root) {
  root.innerHTML = "";
  const s = store.get();
  const ws = s.workspace;

  if (!ws.activePath) {
    const title = h("h1", null, "Select a workspace to start");
    const openBtn = h("button", { class: "btn primary", text: "Choose a folder" });
    openBtn.addEventListener("click", () => openWorkspacePicker());
    root.append(h("div", { class: "empty" }, title,
      h("p", { class: "sub", text: "The agent only works inside the folder you pick." }), openBtn));
    return;
  }

  const wrap = h("div", { class: "empty" });
  const glyph = h("div", { class: "empty-mark", html: brandSvg });
  const title = h("h1", null, "What should we build in ", h("u", { text: ws.activeName || "this project" }), "?");
  wrap.append(glyph);
  title.addEventListener("click", (e) => {
    if (e.target.tagName === "U") openWorkspacePicker();
  });
  const underline = title.querySelector("u");
  underline.style.cursor = "pointer";
  underline.title = "Switch workspace";
  underline.tabIndex = 0;
  underline.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWorkspacePicker(); }
  });
  wrap.append(title, h("p", { class: "sub", text: "Pick a starting point, or describe a task below." }));
  const cards = h("div", { class: "cards" });
  for (const c of CARDS) {
    const btn = h("button", { class: "suggest-card", type: "button", title: c.text },
      h("span", { html: icons[c.icon] || icons.message }), h("span", { text: c.text }));
    if (c.prompt) btn.dataset.prompt = c.prompt;
    btn.addEventListener("click", () => {
      // NOTE: no "oc:suggest" dispatch here — nothing in the app listens for it,
      // so it was a no-op. The click is handled by main.js's
      // wireSuggestionCards(), which reads `data-prompt` off this same button.
      btn.focus();
    });
    cards.append(btn);
  }
  wrap.append(cards);
  root.append(wrap);
}
