// Settings → Appearance: scheme cards, theme presets, contrast, surface
// opacity, typography + live local previews, word wrap, reset. Everything
// writes store.setAppearance (validated, persisted, applied immediately).
// Previews render LOCAL sample content only — never execution results.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store, applyTheme, APPEARANCE_DEFAULTS, UI_FONTS, MONO_FONTS } from "../store.js";
import { toast } from "./toast.js";

// Swatch triplets mirror web-next/css/tokens.css preset blocks (dark bg,
// accent, light bg). Keep in sync when palettes change.
const PRESETS = [
  { id: "neutral", name: "OmniClaw Neutral", desc: "The default balance.", dark: "#0f1011", accent: "#3b82f6", light: "#ffffff" },
  { id: "ocean", name: "Ocean", desc: "Cool blues, deep water sidebar.", dark: "#0b141b", accent: "#38bdf8", light: "#f2f8fc" },
  { id: "grove", name: "Grove", desc: "Quiet greens.", dark: "#0d1510", accent: "#4ade80", light: "#f3faf4" },
  { id: "ember", name: "Ember", desc: "Warm ambers.", dark: "#17110b", accent: "#fb923c", light: "#fdf6ef" },
  { id: "iris", name: "Iris", desc: "Soft violets.", dark: "#12121a", accent: "#a78bfa", light: "#f5f3ff" },
  { id: "rose", name: "Rose", desc: "Muted rose.", dark: "#180f13", accent: "#fb7185", light: "#fdf2f5" },
];

function section(page, title, desc) {
  const s = h("section", { class: "app-section" }, h("h3", { text: title }), h("p", { class: "muted small", text: desc }));
  page.append(s);
  return s;
}

function resetBtn(label, fn) {
  const b = h("button", { class: "btn", type: "button", text: label });
  b.addEventListener("click", fn);
  return b;
}

export function renderAppearance(page, refresh) {
  page.innerHTML = "";
  page.append(h("h2", { text: "Appearance" }));
  page.append(h("p", { class: "muted small", text: "Color, type, and layout for this device. Saved automatically in this browser." }));
  const a = { ...APPEARANCE_DEFAULTS, ...(store.get().appearance || {}) };
  const set = (patch) => {
    store.setAppearance(patch);
    refresh();
  };

  // ── A. color scheme ──
  {
    const s = section(page, "Color scheme", "System follows your OS while selected. Applies immediately, no flash on reload.");
    const cards = h("div", { class: "scheme-cards" });
    for (const [id, label, desc] of [["system", "System", "Follows OS"], ["light", "Light", "Always light"], ["dark", "Dark", "Always dark"]]) {
      const on = store.get().theme === id;
      const card = h("button", {
        class: `scheme-card scheme-${id}${on ? " active" : ""}`, type: "button",
        "aria-pressed": String(on),
      }, h("span", { class: "scheme-prev", "aria-hidden": "true" },
        h("span", { class: "sp-bar" }), h("span", { class: "sp-lines" }, h("i"), h("i"), h("i"))),
        h("strong", { text: label }), h("small", { class: "muted", text: desc }),
        on ? h("span", { class: "check", html: icons.check }) : null);
      card.addEventListener("click", () => {
        store.set({ theme: id });
        applyTheme();
        refresh();
      });
      cards.append(card);
    }
    s.append(cards);
  }

  // ── B. theme presets ──
  {
    const s = section(page, "Theme", "Coordinated palettes for every surface — sidebar, chat, menus, settings, code, and diffs all read the same tokens.");
    const grid = h("div", { class: "preset-grid" });
    for (const p of PRESETS) {
      const on = a.preset === p.id;
      const card = h("button", {
        class: `preset-card${on ? " active" : ""}`, type: "button", "aria-pressed": String(on),
      }, h("span", { class: "preset-swatches", "aria-hidden": "true" },
        h("i", { style: `background:${p.dark}` }), h("i", { style: `background:${p.accent}` }), h("i", { style: `background:${p.light}` })),
        h("span", { class: "preset-text" }, h("strong", { text: p.name }), h("small", { class: "muted", text: p.desc })),
        on ? h("span", { class: "check", html: icons.check }) : null);
      card.addEventListener("click", () => set({ preset: p.id }));
      grid.append(card);
    }
    s.append(grid, h("div", { class: "btn-row" }, resetBtn("Reset theme", () => set({ preset: "neutral" }))));
  }

  // ── C. contrast ──
  {
    const s = section(page, "Contrast", "Raises text, muted, and border contrast. Focus rings are unchanged. Never dims the app.");
    const row = h("div", { class: "seg-tabs", role: "group", "aria-label": "Contrast" });
    for (const [id, label] of [["standard", "Standard"], ["high", "High"]]) {
      const b = h("button", {
        class: `seg-tab${a.contrast === id ? " active" : ""}`, type: "button",
        "aria-pressed": String(a.contrast === id), text: label,
      });
      b.addEventListener("click", () => set({ contrast: id }));
      row.append(b);
    }
    s.append(row, h("div", { class: "btn-row" }, resetBtn("Reset contrast", () => set({ contrast: "standard" }))));
  }

  // ── D. surface opacity ──
  {
    const s = section(page, "Surface opacity", "Translucency for menus, dialogs, and the composer only. Text stays fully opaque; without backdrop-filter support surfaces render solid.");
    const val = h("span", { class: "mono", text: `${a.opacity}%` });
    const range = h("input", {
      type: "range", min: "85", max: "100", step: "1", value: String(a.opacity),
      "aria-label": "Surface opacity percent",
    });
    range.addEventListener("input", () => {
      val.textContent = `${range.value}%`;
      store.setAppearance({ opacity: Number(range.value) });
    });
    range.addEventListener("change", refresh);
    s.append(h("div", { class: "opacity-row" }, range, val),
      h("div", { class: "btn-row" }, resetBtn("Opaque (100%)", () => set({ opacity: 100 }))));
  }

  // ── E. typography + live previews ──
  {
    const s = section(page, "Typography", "Interface and code typefaces are local system stacks. Sizes stay within responsive bounds.");
    const mkSelect = (label, options, current, fn) => {
      const sel = h("select", { "aria-label": label });
      for (const [id, name] of options) sel.append(h("option", { value: id, text: name }));
      sel.value = current;
      sel.addEventListener("change", () => { fn(sel.value); refresh(); });
      return h("label", { class: "set-field" }, h("span", { text: label }), sel);
    };
    const mkSize = (label, min, max, step, current, fn) => {
      const out = h("span", { class: "mono", text: `${current}px` });
      const r = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(current), "aria-label": label });
      r.addEventListener("input", () => { out.textContent = `${r.value}px`; fn(Number(r.value), false); });
      r.addEventListener("change", () => { fn(Number(r.value), true); refresh(); });
      return h("div", { class: "set-field" }, h("span", null, h("span", { text: label }), h("span", null, " ", out)), r);
    };
    s.append(
      mkSelect("Interface font", Object.entries(UI_FONTS).map(([id, f]) => [id, f.label]), a.uiFont, (v) => store.setAppearance({ uiFont: v })),
      mkSize("Interface size", 12, 16, 1, a.uiSize, (v, done) => store.setAppearance({ uiSize: v })),
      mkSelect("Monospace font", Object.entries(MONO_FONTS).map(([id, f]) => [id, f.label]), a.monoFont, (v) => store.setAppearance({ monoFont: v })),
      mkSize("Monospace size", 11, 15, 0.5, a.monoSize, (v, done) => store.setAppearance({ monoSize: v })),
    );
    const prev = h("div", { class: "type-previews" }, h("div", { class: "pop-label", text: "Sample previews (local sample content)" }));
    const chatPrev = h("div", { class: "pv-chat" },
      h("p", null, "Pick a starting point, or describe a task below. "),
      h("p", null, h("span", { class: "ctx-pill static" }, h("span", { text: "◎ Sample chip" })), " Inline text follows the interface face and size."));
    const codePrev = h("div", { class: "codeblock" },
      h("div", { class: "codeblock-head" }, h("span", { class: "lang", text: "js" }), h("span", { text: "Copy" })),
      h("pre", null, h("code", { class: "language-js", text: "const total = items.filter((x) => x.visible).length;\nconsole.log(`showing ${total}`);" })));
    const diffPrev = h("div", { class: "hunk" },
      h("div", { class: "dl del" }, h("span", { class: "gutter", text: "12" }), h("span", { class: "gutter" }), h("span", { class: "code", text: "- const total = items.length;" })),
      h("div", { class: "dl add" }, h("span", { class: "gutter" }), h("span", { class: "gutter", text: "12" }), h("span", { class: "code", text: "+ const total = items.filter(visible).length;" })));
    const termPrev = h("div", { class: "term" }, h("pre", { class: "term-out", text: "$ omni --status\nprovider ready · model nemotron-3 · 0 errors" }));
    prev.append(chatPrev, codePrev, diffPrev, termPrev);
    s.append(prev);
    s.append(h("div", { class: "btn-row" }, resetBtn("Reset typography", () => set({ uiFont: "system", uiSize: 14, monoFont: "cascadia", monoSize: 12.5 }))));
  }

  // ── F. word wrap ──
  {
    const s = section(page, "Word wrap", "Wrap long lines in code blocks, diffs, and the file editor. The terminal wraps on its own rules and is unaffected.");
    const toggles = h("div", { class: "wrap-toggles" });
    for (const [key, label] of [["wrapCode", "Code blocks"], ["wrapDiff", "Diff views"], ["wrapFiles", "File editor"]]) {
      const on = !!a[key];
      const b = h("button", {
        class: `chip-btn${on ? " active" : ""}`, type: "button", "aria-pressed": String(on), text: `${label}: ${on ? "wrap" : "scroll"}`,
      });
      b.addEventListener("click", () => set({ [key]: !on }));
      toggles.append(b);
    }
    s.append(toggles);
  }

  // ── G. reset all ──
  {
    const s = section(page, "Reset", "Restore every Appearance section at once. Chat, providers, and credentials are untouched.");
    const all = h("button", { class: "btn danger", type: "button", text: "Reset all appearance" });
    all.addEventListener("click", () => {
      if (!window.confirm("Reset all Appearance settings to defaults?")) return;
      store.setAppearance({ ...APPEARANCE_DEFAULTS });
      toast("Appearance reset", "success");
      refresh();
    });
    s.append(all);
  }
}
