// Slim chat picker — ONE job: choose a model quickly.
// Scope: ELIGIBLE connections only (see discovery.js). Visibility prefs hide
// rows; the active model always stays selectable. Selection commits through
// ONE atomic backend call (selectProviderConnection) and is verified from the
// response — never two racing writes, never a silent change. Filtering and
// search never touch the active model. Provider management lives in the
// Manage-models dialog + Providers settings, not here.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import { getConfig, selectProviderConnection, getModelRegistry } from "../api.js";
import {
  connectionsFromConfig, eligibleConnections, fetchConnectionModels,
  beginFan, isCurrent, connectionKey,
} from "../discovery.js";
import {
  providerBrand, modelFamily, familyMark, shortHost, prettyModel,
} from "../brands.js";
import { isHidden, manualModels } from "../visibility.js";
import { openManageModels } from "./model-manager.js";
import { openPopover, closePopover } from "./popover.js";
import { toast } from "./toast.js";

export { prettyModel, shortHost };

// Back-compat shims (composer pill). New code uses brands.js directly.
export function modelMark(id) {
  return familyMark(modelFamily(id));
}

export function modelBrand(id = "") {
  const fam = modelFamily(id);
  return fam === "claude" ? "Claude" : fam === "openai" ? "OpenAI"
    : fam === "gemini" ? "Gemini" : fam === "deepseek" ? "DeepSeek" : "Model";
}

const provider = () => store.get().config?.provider || {};
export function modelPillText() { return prettyModel(provider().model) || "Choose model"; }
export function fmtCtxTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, "")}k context`;
  }
  return `${Math.round(v)} tok context`;
}
export function modelPillTitle() {
  const p = provider();
  const ctx = fmtCtxTokens(p.contextTokens);
  return `${p.model || "No model selected"}\n${p.baseUrl || "Connect a provider"}${ctx ? `\n${ctx}` : ""}\nModel changes apply to all chats`;
}
export async function refreshProviderStatus() {
  return null; // status dots moved to Providers settings; picker shows models only.
}

const FAV_KEY = "omniclaw.next.favoriteModels.v1";
function readFavs() {
  try {
    const list = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(list) ? list.filter((r) => r && r.model).slice(0, 20) : [];
  } catch { return []; }
}
function toggleFav(connKey, model) {
  try {
    const has = readFavs().some((r) => r.conn === connKey && r.model === model);
    const list = has
      ? readFavs().filter((r) => !(r.conn === connKey && r.model === model))
      : [{ conn: connKey, model, at: Date.now() }, ...readFavs()].slice(0, 20);
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {}
  return !readFavs().every((r) => !(r.conn === connKey && r.model === model));
}

function activeConnKey(conns) {
  const active = (store.get().config || {}).provider || {};
  const match = conns.find((c) => c.kind === "profile" && c.baseUrl === active.baseUrl && c.keyState.split(":")[0] === active.apiKeyProviderId)
    || conns.find((c) => c.kind === "profile" && c.keyState.split(":")[0] === active.apiKeyProviderId);
  return match ? connectionKey(match) : "active";
}

const FAMILY_NAME = { openai: "OpenAI", claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek" };

export function openModelMenu(anchor, onBusy = () => {}, opts = {}) {
  const running = !!opts.running;
  const body = h("div", { class: "model-picker slim", role: "dialog", "aria-label": "Choose model" });
  const search = h("input", { class: "menu-search", type: "search", placeholder: "Search models…", "aria-label": "Search models", role: "combobox", "aria-expanded": "true", "aria-controls": "model-results" });
  const filterRow = h("label", { class: "model-filter-row" }, h("span", { text: "Provider:" }), h("select", { class: "model-filter", "aria-label": "Provider filter" }));
  const filterSel = filterRow.querySelector("select");
  const list = h("div", { class: "model-results", id: "model-results", role: "listbox", "aria-label": "Models" });
  const status = h("div", { class: "pop-label", role: "status", text: "Loading models…" });
  const manage = h("button", { class: "pop-item model-connect", type: "button" }, h("span", { html: icons.wrench }), h("span", { text: "Manage models" }));
  manage.addEventListener("click", () => { closePopover(); openManageModels(); });
  body.append(
    search, filterRow, status, list,
    h("div", { class: "pop-sep" }), manage,
    h("div", { class: "pop-label", text: "Applies to all chats" }));
  if (running) {
    body.insertBefore(h("div", { class: "pop-label", text: "Applies to the next message — the active run keeps its model" }), search);
  }
  const handle = openPopover(anchor, body, {
    align: "end", side: "auto", maxHeight: 460, repositionOnResize: true,
    onClose: () => { alive = false; beginFan(); },
  });

  let alive = true;
  let busy = false;
  let filterKey = "all";
  let openDetail = null; // "conn|model" with expanded inline details
  let scopeReady = false;
  const fan = beginFan();
  const storeHasScope = () => {
    const c = store.get().config || {};
    return !!(c.provider && (c.provider.model || c.provider.baseUrl || Object.keys(c.providerProfiles || {}).length));
  };
  let conns = [];
  let byKey = new Map();
  let activeKey = "active";
  let activeModel = "";
  const states = new Map();
  // D4: registry-retired ids are excluded from the picker (the active model
  // stays pinned with a visible "retired" note so the user is never stranded
  // on a dead id without knowing it).
  let retiredStates = {};
  const retiredKey = (baseUrl, id) => `${String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase()}::${String(id || "")}`;
  const isRetired = (conn, id) => {
    const st = retiredStates[retiredKey(conn && conn.baseUrl, id)];
    return Boolean(st && (st.retired || st.status === "retired"));
  };
  getModelRegistry().then((reg) => {
    if (!alive || !isCurrent(fan)) return;
    retiredStates = (reg && reg.models) || {};
    paint(); handle.reposition();
  }).catch(() => {});

  // Rebuild scope from the freshest store config (boot may still be loading
  // it when the picker opens early — see ensureConfig below).
  function rebuild() {
    const cfg = store.get().config || {};
    conns = eligibleConnections(connectionsFromConfig(cfg));
    byKey = new Map(conns.map((c) => [connectionKey(c), c]));
    activeKey = activeConnKey(conns);
    activeModel = provider().model || "";
    filterSel.replaceChildren();
    filterSel.append(h("option", { value: "all", text: "All connected" }));
    for (const c of conns) filterSel.append(h("option", { value: connectionKey(c), text: c.name }));
    filterKey = "all";
  }
  rebuild();
  scopeReady = storeHasScope();
  filterSel.addEventListener("change", () => { filterKey = filterSel.value; openDetail = null; paint(); });

  // Row line: main option button + favorite + info as SIBLINGS (a <button>
  // inside <button> is invalid HTML — the parser would split them anyway).
  function rowButton({ modelId, modelName, conn, connKey, selected, opts: rowOpts = {} }) {
    const key = `${connKey}|${modelId}`;
    const fav = readFavs().some((r) => r.conn === connKey && r.model === modelId);
    const ctxLabel = fmtCtxTokens(rowOpts.contextTokens);
    const subText = [rowOpts.sub, ctxLabel].filter(Boolean).join(" · ");
    const row = h("button", {
      class: "pop-item model-row slim", type: "button", role: "option",
      "aria-selected": String(selected), title: `${modelId} · ${conn.name}${ctxLabel ? ` · ${ctxLabel}` : ""}`,
    }, familyMark(modelFamily(modelId)),
      h("span", { class: "model-copy" },
        h("strong", { text: `${modelName}${rowOpts.manual ? " · Manual" : ""}` }),
        subText ? h("small", { text: subText }) : null));
    if (selected) {
      row.append(h("span", { class: "check", html: icons.check }));
      row.dataset.selected = "1";
    }
    row.addEventListener("click", () => applySelection({ modelId, conn, contextTokens: rowOpts.contextTokens || 0 }));
    const favBtn = h("button", {
      class: "row-icon", type: "button", title: fav ? "Remove favorite" : "Add favorite",
      "aria-label": `${fav ? "Remove" : "Add"} favorite ${modelId}`,
      "aria-pressed": String(fav), text: fav ? "★" : "☆",
    });
    favBtn.addEventListener("click", () => { toggleFav(connKey, modelId); paint(); });
    const infoBtn = h("button", {
      class: "row-icon", type: "button", title: "Model details", "aria-label": `Details for ${modelId}`,
      "aria-expanded": String(openDetail === key), text: "ⓘ",
    });
    infoBtn.addEventListener("click", () => {
      openDetail = openDetail === key ? null : key;
      paint();
      if (openDetail === key) {
        try { list.querySelector('[data-detail="open"]')?.scrollIntoView({ block: "nearest" }); } catch {}
      }
    });
    const wrap = h("div", { class: "model-row-wrap" },
      row, h("span", { class: "row-icons" }, favBtn, infoBtn));
    if (openDetail === key) {
      const fam = modelFamily(modelId);
      const ctxLabel = fmtCtxTokens(rowOpts.contextTokens);
      wrap.append(h("div", { class: "model-detail", "data-detail": "open" },
        h("div", null, h("span", { text: "ID: " }), h("code", { text: modelId })),
        h("div", { text: `Family: ${FAMILY_NAME[fam] || "Unknown"}` }),
        h("div", { text: `Connection: ${conn.name}` }),
        h("div", { text: `Context window: ${ctxLabel || "unknown for this catalog"}` }),
        h("div", { class: "muted", text: "Capabilities: unknown for this catalog" })));
    }
    return wrap;
  }

  // Single atomic commit. busy serializes; the button set is disabled during
  // the transition so no second selection can race it.
  async function applySelection({ modelId, conn, contextTokens = 0 }) {
    if (busy) return;
    busy = true;
    onBusy(true);
    for (const b of list.querySelectorAll("button")) b.disabled = true;
    status.textContent = `Switching to ${modelId}…`;
    try {
      await selectProviderConnection({
        ...(conn.kind === "profile" ? { profileId: conn.profileId } : {}),
        model: modelId,
        ...(Number.isFinite(Number(contextTokens)) && Number(contextTokens) > 0
          ? { contextTokens: Math.round(Number(contextTokens)) }
          : {}),
      });
      const fresh = (await getConfig()) || {};
      store.set({ config: fresh });
      if (alive) {
        closePopover();
        try { anchor.focus(); } catch {}
      }
      toast(`Model selected: ${modelId}`, "success");
    } catch (e) {
      toast(`Model switch failed: ${e.message}`, "error");
      if (alive) {
        status.textContent = e.message;
        for (const b of list.querySelectorAll("button")) b.disabled = false;
      }
    } finally { busy = false; onBusy(false); }
  }

  function collectRows() {
    // Returns [{kind:'fav'|'active-hidden'|'group', ...}] in display order.
    const needle = search.value.trim().toLowerCase();
    const keys = filterKey === "all" ? conns.map(connectionKey) : [filterKey];
    const match = (name, id, connName) => !needle || `${name} ${id} ${connName}`.toLowerCase().includes(needle);
    const out = [];
    const favs = readFavs().filter((r) => {
      const c = byKey.get(r.conn);
      const st = states.get(r.conn);
      if (!c || st?.state !== "ok") return false;
      if (isRetired(c, r.model)) return false;
      const found = (st.models || []).some((m) => m.id === r.model) || manualModels(r.conn).includes(r.model);
      return found && match(prettyModel(r.model), r.model, c.name) && !isHidden(r.conn, r.model);
    });
    // Active model stays selectable even when hidden — pinned with an explainer.
    const activeHidden = activeModel && isHidden(activeKey, activeModel)
      && (!needle || match(prettyModel(activeModel), activeModel, (byKey.get(activeKey) || {}).name || ""));
    return { needle, keys, match, out, favs, activeHidden };
  }

  function paint() {
    if (!alive || !isCurrent(fan)) return;
    list.replaceChildren();
    const { needle, keys, match, favs, activeHidden } = collectRows();
    let total = 0;
    let pending = 0;
    let failed = 0;
    let retiredHidden = 0;
    const activeConn = byKey.get(activeKey);

    if (activeHidden && activeConn) {
      list.append(h("div", { class: "pop-label pop-sticky", text: "Current (hidden from list)" }));
      list.append(rowButton({
        modelId: activeModel, modelName: prettyModel(activeModel),
        conn: activeConn, connKey: activeKey, selected: true,
        opts: { sub: `${activeConn.name} · still active` },
      }));
      total++;
    }
    if (favs.length && !needle && filterKey === "all") {
      list.append(h("div", { class: "pop-label pop-sticky", text: "Favorites" }));
      for (const r of favs.slice(0, 5)) {
        const c = byKey.get(r.conn);
        const found = (states.get(r.conn)?.models || []).find((x) => x.id === r.model);
        list.append(rowButton({
          modelId: r.model, modelName: prettyModel(r.model), conn: c, connKey: r.conn,
          selected: r.model === activeModel && r.conn === activeKey,
          opts: {
            ...(manualModels(r.conn).includes(r.model) ? { manual: true } : {}),
            ...(found && found.contextTokens ? { contextTokens: found.contextTokens } : {}),
          },
        }));
        total++;
      }
    }

    for (const key of keys) {
      const c = byKey.get(key);
      if (!c) continue;
      const st = states.get(key) || { models: [], state: "loading", error: "" };
      if (st.state === "loading") { pending++; continue; }
      if (st.state === "failed") { failed++; continue; } // retry lives in Manage models
      const brand = providerBrand(c);
      const ids = [...(st.models || []).map((m) => ({ id: m.id, name: m.name, manual: false, contextTokens: m.contextTokens || 0 })),
        ...manualModels(key).map((id) => ({ id, name: id, manual: true, contextTokens: 0 }))];
      const rows = [];
      for (const m of ids) {
        if (isHidden(key, m.id) && !(m.id === activeModel && key === activeKey)) continue;
        const retired = isRetired(c, m.id);
        const isActiveRow = m.id === activeModel && key === activeKey;
        if (retired && !isActiveRow) { retiredHidden++; continue; }
        if (!match(m.name !== m.id ? m.name : prettyModel(m.id), m.id, c.name)) continue;
        const dup = conns.some((o) => connectionKey(o) !== key && (states.get(connectionKey(o))?.models || []).some((x) => x.id === m.id));
        rows.push(rowButton({
          modelId: m.id, modelName: m.name !== m.id ? m.name : prettyModel(m.id),
          conn: c, connKey: key, selected: isActiveRow,
          opts: { ...(m.manual ? { manual: true } : {}), ...(dup && !retired ? { sub: c.name } : {}), ...(retired ? { sub: "retired on this endpoint — pick another" } : {}), ...(m.contextTokens ? { contextTokens: m.contextTokens } : {}) },
        }));
      }
      if (!rows.length) continue; // hide empty groups — never a wall of headings
      const head = h("div", { class: "pop-label pop-sticky", text: filterKey === "all" ? `${c.name} · ${brand.name}` : brand.name });
      list.append(head, ...rows);
      total += rows.length;
    }

    if (!scopeReady) {
      status.textContent = "Loading providers…";
    } else if (!conns.length) {
      status.textContent = "No connected providers";
      list.append(h("div", { class: "pop-label", text: "No connected providers with usable models." }));
      list.append(rowButtonNote("Open Manage models to connect a provider or unhide models."));
    } else if (!total && !pending) {
      const emptyText = needle
        ? "No matching models — try another search."
        : failed > 0 && failed >= keys.length
          ? "Couldn't retrieve models — open Manage models to retry."
          : "All models are hidden — open Manage models to unhide.";
      status.textContent = needle ? "No matches" : "Nothing to show";
      list.append(h("div", { class: "pop-label", text: emptyText }));
      if (!needle) list.append(rowButtonNote(failed > 0 ? "Open Manage models to retry" : "Open Manage models"));
    } else {
      const retiredNote = retiredHidden > 0 ? ` · ${retiredHidden} retired hidden` : "";
      status.textContent = pending ? `Loading… · ${total} so far` : `${total} model${total === 1 ? "" : "s"}${retiredNote}`;
    }
    handle.reposition();
    try { list.querySelector('[data-selected="1"]')?.scrollIntoView({ block: "nearest" }); } catch {}
  }

  function rowButtonNote(text) {
    const b = h("button", { class: "pop-item", type: "button" }, h("span", { text }));
    b.addEventListener("click", () => { closePopover(); openManageModels(); });
    return b;
  }

  search.focus();
  search.addEventListener("input", () => { openDetail = null; paint(); });
  paint();

  (async () => {
    // Boot race: the picker can open before GET /api/config lands. Then the
    // scope above is empty — fetch it here and rebuild instead of showing a
    // bogus "no providers" state.
    if (!scopeReady) {
      status.textContent = "Loading providers…";
      try {
        const fresh = (await getConfig()) || {};
        if (!alive || !isCurrent(fan)) return;
        store.set({ config: fresh });
        rebuild();
        scopeReady = true;
        paint();
        handle.reposition();
      } catch (e) {
        if (!alive || !isCurrent(fan)) return;
        status.textContent = `Couldn't load providers: ${e.message}`;
        return;
      }
    }
    await Promise.all(conns.map(async (c) => {
      const key = connectionKey(c);
      const res = await fetchConnectionModels(c);
      if (!alive || !isCurrent(fan)) return;
      states.set(key, res);
      paint(); handle.reposition();
    }));
    if (!alive || !isCurrent(fan)) return;
    paint(); handle.reposition();
  })().catch(() => {});
}
