// #/settings — left rail (General · Providers & Models · Permissions · About).
// Providers flows mirror neo's settings panel exactly (public/neo.js:2296-2541):
// profiles from GET /api/config providerProfiles, key state masked-only,
// save/test/models/key/delete/apply routes as neo calls them.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store, applyTheme, applyAppearance } from "../store.js";
import { renderAppearance } from "./appearance.js";
import {
  getHealth, getConfig, setConfig, getProviderStatus,
  saveProfile, deleteProfile, keyStatus,
  testProfile, fetchProviderModels, validateConfig, applyProfile,
  testProviderModel, getModelRegistry,
} from "../api.js";
import { MODES, detectMode } from "./composer.js";
import { openManageModels, openConnectProvider } from "./model-manager.js";
import { fetchConnectionModels } from "../discovery.js";
import { toast } from "./toast.js";

const TABS = [
  ["general", "General"],
  ["appearance", "Appearance"],
  ["providers", "Providers & Models"],
  ["permissions", "Permissions"],
  ["about", "About"],
];

export function mountSettings(root, tab = "providers") {
  root.innerHTML = "";
  const wrap = h("div", { class: "set-wrap" });
  const rail = h("nav", { class: "set-rail", "aria-label": "Settings" });
  const page = h("div", { class: "set-page" });
  for (const [id, label] of TABS) {
    const b = h("button", {
      class: `set-tab${id === tab ? " active" : ""}`, type: "button", text: label,
    });
    b.addEventListener("click", () => { window.location.hash = `#/settings/${id}`; });
    rail.append(b);
  }
  wrap.append(rail, page);
  root.append(wrap);
  if (tab === "general") renderGeneral(page);
  else if (tab === "appearance") renderAppearance(page, () => mountSettings(page.closest(".view") || page.parentElement, "appearance"));
  else if (tab === "permissions") renderPermissions(page);
  else if (tab === "about") renderAbout(page);
  else renderProviders(page);
}

// ── General ──
function renderGeneral(page) {
  page.append(h("h2", { text: "General" }));
  const s = store.get();

  const themeRow = h("div", { class: "set-group" }, h("div", { class: "set-label", text: "Theme" }));
  for (const [id, label] of [["dark", "Dark"], ["light", "Light"], ["system", "System"]]) {
    const b = h("button", {
      class: `chip-btn${s.theme === id ? " active" : ""}`, type: "button", text: label,
      "aria-pressed": String(s.theme === id),
    });
    b.addEventListener("click", () => {
      store.set({ theme: id });
      applyTheme();
      renderGeneralRefresh(page);
    });
    themeRow.append(b);
  }
  page.append(themeRow);

  const fsRow = h("div", { class: "set-group" }, h("div", { class: "set-label", text: "Font size" }));
  const curSize = Math.round((s.appearance || {}).uiSize || s.fontSize || 14);
  for (const n of [13, 14, 15]) {
    const b = h("button", {
      class: `chip-btn${curSize === n ? " active" : ""}`, type: "button", text: String(n),
      "aria-pressed": String(curSize === n),
    });
    b.addEventListener("click", () => {
      store.setAppearance({ uiSize: n });
      applyFontSize();
      renderGeneralRefresh(page);
    });
    fsRow.append(b);
  }
  page.append(fsRow);
  page.append(h("p", { class: "muted small", text: "More type, theme, and layout controls live under Appearance." }));

  const sysRow = h("div", { class: "set-group" });
  const sysBtn = h("button", {
    class: `chip-btn${s.showSystem ? " active" : ""}`, type: "button",
    text: `Show system sessions: ${s.showSystem ? "on" : "off"}`,
    "aria-pressed": String(!!s.showSystem),
  });
  sysBtn.addEventListener("click", () => {
    store.set({ showSystem: !store.get().showSystem });
    renderGeneralRefresh(page);
  });
  sysRow.append(h("div", { class: "set-label", text: "Sidebar" }), sysBtn);
  page.append(sysRow);
}

function renderGeneralRefresh(page) {
  mountSettings(page.closest(".view") || page.parentElement, "general");
}

export function applyFontSize() {
  applyAppearance();
}

// ── Permissions (same modes + payloads as the composer pill) ──
function renderPermissions(page) {
  page.append(h("h2", { text: "Permissions" }));
  page.append(h("p", { class: "muted small", text: "Global — applies to all chats. Same switch as the composer pill." }));
  const current = detectMode(store.get().config);
  for (const [key, m] of Object.entries(MODES)) {
    const card = h("button", {
      class: `perm-card${key === current ? " active" : ""}`, type: "button",
      "aria-pressed": String(key === current),
    }, h("span", { html: icons[m.icon] }),
      h("span", { class: "perm-text" }, h("strong", { text: m.label }), h("small", { text: m.desc })),
      key === current ? h("span", { class: "check", html: icons.check }) : null);
    card.addEventListener("click", async () => {
      try {
        await setConfig(m.config);
        const cfg = await getConfig();
        store.set({ config: cfg || {} });
        toast(`Permissions: ${m.label}`, "success");
        mountSettings(page.closest(".view") || page.parentElement, "permissions");
      } catch (e) {
        toast(`Permissions failed: ${e.message}`, "error");
      }
    });
    page.append(card);
  }
}

// ── About ──
async function renderAbout(page) {
  page.append(h("h2", { text: "About" }));
  const g = store.get().gateway;
  page.append(h("div", { class: "kv" },
    h("span", { text: "Version" }), h("span", { class: "mono", text: g.version ? `v${g.version}` : "…" })));
  page.append(h("div", { class: "kv" },
    h("span", { text: "Gateway" }), h("span", { text: `${g.text || "…"} · Agents ${g.agents || 0} · Cron ${g.cron || 0}` })));
  page.append(h("div", { class: "kv" },
    h("span", { text: "Model" }), h("span", { text: g.model || "…" })));
  page.append(h("h3", { text: "Known gaps" }));
  const ul = h("ul", { class: "muted small" });
  for (const t of [
    "No live terminal (PTY) — terminal shows tool output cards.",
    "No direct file write UI — writes go through the agent.",
    "No shell-out from the browser (no Open in Explorer / VS Code).",
    "Full list: docs/FRONTEND_TODO.md in the repo.",
  ]) ul.append(h("li", { text: t }));
  page.append(ul);
}

// ── Providers & Models ──
const keyProviderOf = (profiles, pid) => (profiles[pid] && profiles[pid].apiKeyProviderId) || pid;

async function renderProviders(page) {
  page.append(h("h2", { text: "Providers & Models" }));
  page.append(h("p", { class: "provider-intro", text: "Your models. Your keys. Your workspace." }));
  page.append(h("p", { class: "muted small", text: "Connect a provider, discover its models, then choose from the composer. Provider changes apply to all chats. Connection tests may use tokens." }));
  const provActions = h("div", { class: "btn-row prov-actions" });
  const manageBtnTop = h("button", { class: "btn", type: "button", text: "Manage models" });
  manageBtnTop.addEventListener("click", () => openManageModels(() => mountSettings(page.closest(".view") || page.parentElement, "providers")));
  const connectBtnTop = h("button", { class: "btn primary", type: "button", text: "+ Connect provider" });
  connectBtnTop.addEventListener("click", () => openConnectProvider(() => mountSettings(page.closest(".view") || page.parentElement, "providers")));
  provActions.append(manageBtnTop, connectBtnTop);
  page.append(provActions);
  const loading = h("p", { class: "muted", text: "Loading providers…" });
  page.append(loading);
  let health, config;
  try {
    [health, config] = await Promise.all([getHealth(), getConfig()]);
  } catch (e) {
    loading.textContent = `Load failed: ${e.message}`;
    return;
  }
  loading.remove();
  const provider = (health && health.provider) || {};
  const profiles = (config && config.providerProfiles) || {};
  const secrets = (config && config.providerSecrets) || [];
  const keyStatusFor = (pid) => secrets.find((x) => x.providerId === pid) || { configured: false, masked: "" };
  const ids = Object.keys(profiles);
  // Active profile (neo.js:2304-2307): key-provider + model match, else key match, else first.
  const activeKeyProvider = provider.apiKeyProviderId || "";
  const activeId = ids.find((id) => profiles[id].apiKeyProviderId === activeKeyProvider && profiles[id].model === provider.model)
    || ids.find((id) => profiles[id].apiKeyProviderId === activeKeyProvider)
    || ids[0] || "";
  let readiness = null;
  try {
    const st = await getProviderStatus();
    readiness = st && st.readiness ? st.readiness.ok !== false : null;
  } catch {
    readiness = false;
  }

  const cols = h("div", { class: "prov-cols" });
  const listPane = h("div", { class: "prov-list" });
  const formPane = h("div", { class: "prov-form" });
  cols.append(listPane, formPane);
  page.append(cols);

  let selected = activeId;

  // Honest per-connection auth label (separate from "In use"): key state is
  // masked presence, env keys are named as externally managed, keyless modes
  // say so. "Verified" is only ever claimed right after a passing test.
  function authLabel(pid, p, isActive) {
    const mode = (p && p.mode) || "openai-compatible";
    if (mode === "mock") return "Built-in · no key needed";
    if (mode === "codex-cli") return "ChatGPT account (CLI)";
    const ks = keyStatusFor(keyProviderOf(profiles, pid));
    if (ks.configured) return `Key set${ks.masked ? ` ${ks.masked}` : ""}`;
    // Live info (merged by api.js getConfig) carries apiKeySource; /api/health
    // does not — read it from config, not health.
    const liveSrc = (config.providerInfo || {}).apiKeySource || "";
    const liveEnv = (config.providerInfo || {}).apiKeyEnv || "";
    if (isActive && liveSrc === "env") {
      return `Environment key ${liveEnv} (managed outside OmniClaw)`.trim();
    }
    if (/^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0)/i.test(p.baseUrl || "")) return "Local endpoint · no key needed";
    return "Needs key";
  }

  function paintList() {
    listPane.innerHTML = "";
    for (const pid of Object.keys(profiles)) {
      const p = profiles[pid] || {};
      const isActive = pid === activeId;
      const ks = keyStatusFor(keyProviderOf(profiles, pid));
      const dot = h("span", {
        class: `gw-dot ${isActive ? (readiness === false ? "down" : readiness ? "ok" : "degraded") : (ks.configured ? "ok" : "down")}`,
        title: isActive
          ? (readiness === false ? "Provider not ready" : "In use")
          : (ks.configured ? `Key set${ks.masked ? ` (${ks.masked})` : ""}` : "No key"),
      });
      const row = h("button", {
        class: `prov-row${pid === selected ? " active" : ""}${isActive ? " is-active" : ""}`,
        type: "button",
      }, dot,
        h("span", { class: "prov-main" },
          h("strong", { text: (p.label && p.label !== pid) ? `${p.label} (${pid})` : pid }),
          h("small", { class: "muted", text: `${p.baseUrl || "(local/cli)"}${p.model ? ` · ${p.model}` : ""}` }),
          h("small", { class: "muted", text: authLabel(pid, p, isActive) })),
        isActive ? h("span", { class: "tag-active", text: "In use" }) : null);
      row.addEventListener("click", () => { selected = pid; paintList(); paintForm(); });
      listPane.append(row);
    }
    const add = h("button", { class: "prov-row add", type: "button" },
      h("span", { html: icons.plus }), h("span", { text: "+ Add provider" }));
    add.addEventListener("click", () => { selected = ""; paintList(); paintForm(); });
    listPane.append(add);
  }

  function field(label, el) {
    return h("label", { class: "set-field" }, h("span", { text: label }), el);
  }

  async function refreshModelsInto(sel, status, opts) {
    status.textContent = "Fetching models…";
    try {
      const res = await fetchProviderModels(opts);
      if (res && res.ok === false) { status.textContent = `Fetch failed: ${res.error || "check URL/key"}`; return; }
      const models = (res && res.models) || [];
      const cur = sel.value || opts.model || "";
      const suggestions = sel.nextElementSibling;
      suggestions.replaceChildren(...models.map((m) => {
        const id = typeof m === "string" ? m : m.id;
        return h("option", { value: id, text: id });
      }));
      sel.value = cur || (typeof models[0] === "string" ? models[0] : models[0]?.id) || "";
      status.textContent = `${models.length} models loaded.`;
    } catch (e) {
      status.textContent = `Fetch failed: ${e.message}`;
    }
  }

  // D1: models section — live /models list merged with persisted health
  // states from the model registry. Each row: status dot, id, capability
  // note, Test button (D2 minimal real call, persisted). Retired rows are
  // marked excluded (D4).
  async function paintProfileModels(box, profileId, profile) {
    box.textContent = "Loading models…";
    let live = [];
    try {
      const res = await fetchProviderModels({ profileId });
      if (res && res.ok !== false) {
        live = (res.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
      } else {
        box.textContent = `List failed: ${(res && res.error) || "check URL/key"}`;
        return;
      }
    } catch (e) {
      if (box.isConnected) box.textContent = `List failed: ${e.message}`;
      return;
    }
    let registry = {};
    try {
      const reg = await getModelRegistry();
      registry = (reg && reg.models) || {};
    } catch { registry = {}; }
    if (!box.isConnected) return;
    const base = String(profile.baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
    box.innerHTML = "";
    if (!live.length) {
      box.append(h("div", { class: "small muted", text: "Connected, but no models listed." }));
      return;
    }
    for (const id of live) {
      const st = registry[`${base}::${id}`] || null;
      const retired = Boolean(st && (st.retired || st.status === "retired"));
      const dotCls = !st ? "degraded" : (st.status === "ok" ? "ok" : (retired ? "down" : "degraded"));
      const dotTitle = !st
        ? "Never tested"
        : `${st.status}${st.lastTested ? ` · tested ${new Date(st.lastTested).toLocaleString()}` : ""}${st.lastError ? ` · ${st.lastError}` : ""}`;
      const row = h("div", { class: "prov-model-row" },
        h("span", { class: `gw-dot ${dotCls}`, title: dotTitle }),
        h("span", { class: "prov-model-id truncate", text: id, title: dotTitle }),
        retired ? h("span", { class: "badge bad", text: "retired — excluded" }) : null,
        (st && st.toolCalling != null)
          ? h("span", { class: "small muted", text: `${st.toolCalling ? "tools ✓" : "no tools"}${st.parallel ? " · parallel ✓" : ""}` })
          : null);
      const testBtn = h("button", { class: "btn sm", type: "button", text: "Test" });
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        testBtn.textContent = "Testing…";
        try {
          const res = await testProviderModel({ profileId, model: id });
          if (res && res.ok) {
            toast(`✓ ${id}: tools ${res.toolCalling ? "✓" : "✗"} · parallel ${res.parallel ? "✓" : "–"}`, "success");
          } else {
            toast(`Model test failed: ${(res && (res.error || res.reason)) || "unknown"}`, "error");
          }
        } catch (e) {
          toast(`Model test failed: ${e.message}`, "error");
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = "Test";
          if (box.isConnected) paintProfileModels(box, profileId, profile);
        }
      });
      row.append(testBtn);
      box.append(row);
    }
    box.append(h("div", { class: "small muted", text: "Test runs one minimal real call and persists reachability, tool-calling, and parallel support. Retired models are excluded from pickers and the sub-agent ladder." }));
  }

  function paintForm() {
    formPane.innerHTML = "";
    const isNew = !selected || !profiles[selected];
    const p = (!isNew && profiles[selected]) || {};
    const kp = isNew ? "" : keyProviderOf(profiles, selected);
    formPane.append(h("h3", { text: isNew ? "Add provider" : selected }));
    if (!isNew) {
      const disco = h("div", { class: "small muted", role: "status", text: "Checking discovered models…" });
      const manageBtn = h("button", { class: "btn", type: "button", text: "Manage models" });
      manageBtn.addEventListener("click", () => openManageModels(() => mountSettings(page.closest(".view") || page.parentElement, "providers")));
      formPane.append(h("div", { class: "btn-row" }, manageBtn), disco);
      fetchConnectionModels({ kind: "profile", profileId: selected }).then((res) => {
        if (!formPane.isConnected) return;
        if (res.state === "ok") {
          const when = res.at ? new Date(res.at).toLocaleTimeString() : "";
          disco.textContent = `${res.models.length} models discovered${res.fromCache && when ? ` (cached ${when})` : ""}.`;
        } else if (res.state === "empty") {
          disco.textContent = "Connected, but no models listed.";
        } else {
          disco.textContent = `Discovery failed: ${res.error || "unknown error"} — Retry from Manage models.`;
        }
      }).catch((e) => {
        if (formPane.isConnected) disco.textContent = `Discovery failed: ${e.message}`;
      });
      // D1 models section (live list + persisted health + per-model Test).
      const modelsHead = h("h4", { text: "Models on this connection" });
      const modelsBox = h("div", { class: "prov-models" });
      formPane.append(modelsHead, modelsBox);
      paintProfileModels(modelsBox, selected, p);
    }

    const nameInput = h("input", { type: "text", value: isNew ? "" : selected, placeholder: "e.g. My Cerebras", disabled: !isNew });
    if (!isNew) nameInput.title = "Profile id (rename via delete + add)";
    const typeSel = h("select", null,
      h("option", { value: "", text: "OpenAI-compatible (Bearer)" }),
      h("option", { value: "anthropic", text: "Anthropic (x-api-key)" }));
    typeSel.value = p.authStyle || "";
    const urlInput = h("input", { type: "text", value: p.baseUrl || "", placeholder: "https://api.example.com/v1", spellcheck: "false" });
    const keyInput = h("input", { type: "password", value: "", placeholder: "paste API key (blank = keep saved)", autocomplete: "new-password" });
    const keyMeta = h("div", { class: "small muted", text: "…" });
    const modelSel = h("input", { type: "text", value: p.model || "", list: "provider-model-suggestions", placeholder: "Fetch models or enter a model ID", spellcheck: "false" });
    const suggestions = h("datalist", { id: "provider-model-suggestions" });
    const status = h("div", { class: "small muted", role: "status", "aria-live": "polite" });
    const btnRow = h("div", { class: "btn-row" });
    const fetchBtn = h("button", { class: "btn", type: "button", text: "Fetch models" });
    const testBtn = h("button", { class: "btn", type: "button", text: "Test connection" });
    const saveBtn = h("button", { class: "btn primary", type: "button", text: "Save" });
    btnRow.append(fetchBtn, testBtn, saveBtn);
    if (!isNew) {
      const setActive = h("button", { class: "btn", type: "button", text: "Set active" });
      setActive.disabled = selected === activeId;
      setActive.addEventListener("click", async () => {
        setActive.disabled = true;
        try {
          await applyProfile(selected);
          const cfg = await getConfig();
          store.set({ config: cfg || {} });
          toast(`Active provider: ${selected}`, "success");
          mountSettings(page.closest(".view") || page.parentElement, "providers");
        } catch (e) {
          setActive.disabled = false;
          toast(`Set active failed: ${e.message}`, "error");
        }
      });
      const del = h("button", { class: "btn danger", type: "button", text: "Delete" });
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete provider "${selected}"?`)) return;
        del.disabled = true;
        try {
          await deleteProfile(selected);
          const cfg = await getConfig();
          store.set({ config: cfg || {} });
          toast(`Deleted ${selected}`, "success");
          mountSettings(page.closest(".view") || page.parentElement, "providers");
        } catch (e) {
          del.disabled = false;
          toast(`Delete failed: ${e.message}`, "error");
        }
      });
      btnRow.append(setActive, del);
    }
    if (isNew) {
      const presets = h("div", { class: "provider-presets", "aria-label": "Provider presets" });
      for (const [name, url, auth] of [
        ["OpenRouter", "https://openrouter.ai/api/v1", ""],
        ["OpenAI", "https://api.openai.com/v1", ""],
        ["Anthropic", "https://api.anthropic.com/v1", "anthropic"],
        ["Ollama", "http://localhost:11434/v1", ""],
      ]) {
        const button = h("button", { class: "chip-btn", type: "button", text: name });
        button.addEventListener("click", () => {
          nameInput.value = name;
          urlInput.value = url;
          typeSel.value = auth;
          modelSel.value = "";
          suggestions.replaceChildren();
          status.textContent = "Add your key if required, then fetch models or enter a model ID.";
          keyInput.focus();
        });
        presets.append(button);
      }
      formPane.append(presets);
    }
    formPane.append(
      field(isNew ? "Name" : "Profile", nameInput),
      field("Type", typeSel),
      field("Base URL", urlInput),
      field("API key", keyInput),
      keyMeta,
      field("Default model", modelSel),
      btnRow, status,
    );
    modelSel.after(suggestions);

    // Key state: masked only, never echoed (server redacts by design).
    const paintKey = (st) => {
      keyMeta.textContent = "";
      keyMeta.append(
        h("span", { class: `badge ${st.configured ? "ok" : "bad"}`, text: st.configured ? "key set" : "no key" }),
        h("span", { text: st.configured && st.masked ? ` ${st.masked}` : " — paste a key above to set it" }),
      );
    };
    if (!isNew) {
      const cached = keyStatusFor(kp);
      paintKey(cached.configured ? cached : { configured: false, masked: "" });
      keyStatus(kp).then((fresh) => {
        const st = (fresh.statuses && fresh.statuses[0]) || cached;
        paintKey(st);
      }).catch(() => {});
    } else {
      paintKey({ configured: false, masked: "" });
    }

    const reveal = h("button", { class: "btn", type: "button", text: "Reveal" });
    reveal.addEventListener("click", () => {
      keyInput.type = keyInput.type === "password" ? "text" : "password";
      reveal.textContent = keyInput.type === "password" ? "Reveal" : "Hide";
    });
    keyInput.after(reveal);

    fetchBtn.addEventListener("click", () => {
      const baseUrl = urlInput.value.trim();
      const apiKey = keyInput.value.trim();
      const authStyle = typeSel.value;
      if (!baseUrl) { status.textContent = "Base URL first."; return; }
      refreshModelsInto(modelSel, status, { baseUrl, apiKey, authStyle,
        apiKeyProviderId: isNew ? "custom-adhoc" : kp, model: modelSel.value });
    });

    testBtn.addEventListener("click", async () => {
      const baseUrl = urlInput.value.trim();
      const model = modelSel.value;
      const apiKey = keyInput.value.trim();
      if (!baseUrl || !model) { status.textContent = "Base URL and model needed for test."; return; }
      status.textContent = `Testing ${model}…`;
      try {
        // Mirrors neo (neo.js:2475-2477) + profile context for stored keys.
        const res = await testProfile({
          ...(isNew ? {} : { profileId: selected }),
          baseUrl, model, apiKey, authStyle: typeSel.value,
          apiKeyProviderId: isNew ? "custom-adhoc" : kp, live: true,
        });
        status.textContent = res && res.ok
          ? `✓ Test passed: ${(res.candidate && res.candidate.model) || model}`
          : `✗ Test failed: ${(res && (res.message || res.error)) || "unknown"}`;
      } catch (e) {
        status.textContent = `Test failed: ${e.message}`;
      }
    });

    saveBtn.addEventListener("click", async () => {
      const name = (isNew ? nameInput.value : selected).trim();
      const baseUrl = urlInput.value.trim();
      const model = modelSel.value;
      const apiKey = keyInput.value.trim();
      if (!name || !baseUrl || !model) { status.textContent = "Name, Base URL and model are required."; return; }
      saveBtn.disabled = true;
      status.textContent = "Validating…";
      try {
        // Pre-save shape check (config-store.js:126-163); Test remains primary.
        const v = await validateConfig({ provider: { mode: "openai-compatible", baseUrl, model } });
        if (v && v.valid === false) {
          status.textContent = `Invalid: ${((v.errors || []).join("; ") || "check fields").slice(0, 160)}`;
          saveBtn.disabled = false;
          return;
        }
        status.textContent = "Saving…";
        // Exact neo save shape (neo.js:2494-2497). apply iff new or active —
        // saving a dormant profile must not yank the active provider.
        const res = await saveProfile({
          name, baseUrl, model,
          ...(apiKey ? { apiKey } : {}),
          ...(typeSel.value ? { authStyle: typeSel.value } : {}),
          apply: isNew || selected === activeId,
        });
        if (res && res.ok === false) { status.textContent = `Save failed: ${res.error || "check fields"}`; saveBtn.disabled = false; return; }
        const cfg = await getConfig();
        store.set({ config: cfg || {} });
        keyInput.value = "";
        status.textContent = `✓ Saved${isNew || selected === activeId ? " & applied" : ""}: "${name}".`;
        toast(`Provider saved: ${name}`, "success");
        mountSettings(page.closest(".view") || page.parentElement, "providers");
      } catch (e) {
        status.textContent = `Save failed: ${e.message}`;
        toast(`Save failed: ${e.message}`, "error");
        saveBtn.disabled = false;
      }
    });
  }

  paintList();
  paintForm();
}
