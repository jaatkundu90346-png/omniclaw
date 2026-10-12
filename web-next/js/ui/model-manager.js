// Manage-models dialog + Connect-provider flow (one modal at a time — step
// navigation replaces content, never stacks popups). Backends are the same
// verified routes the Providers settings page uses: GET /api/config,
// POST /api/provider/profile/save, POST /api/provider/test,
// POST /api/provider/models, POST /api/provider/select, key status (masked).
// Secrets are write-only (never read back, never logged). Provider creation
// always saves with apply:false — existing chats keep their model until the
// user explicitly presses "Use in chat".

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import { store } from "../store.js";
import {
  getConfig, saveProfile, testProfile, fetchProviderModels, keyStatus,
  selectProviderConnection,
} from "../api.js";
import {
  connectionsFromConfig, fetchConnectionModels, beginFan, isCurrent,
  connectionKey,
} from "../discovery.js";
import { providerBrand, connectionMark, shortHost } from "../brands.js";
import {
  isHidden, setHidden, setConnectionHidden, manualModels,
  addManualModel, removeManualModel,
} from "../visibility.js";
import { toast } from "./toast.js";

// ── modal shell ──────────────────────────────────────────────
function openModal(label) {
  const opener = document.activeElement;
  const veil = h("div", { class: "modal-veil" });
  const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": label });
  veil.append(box);
  document.body.append(veil);
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };
  const onHash = () => close();
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("hashchange", onHash);
  veil.addEventListener("pointerdown", (e) => { if (e.target === veil) close(); });
  function close() {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("hashchange", onHash);
    veil.remove();
    try { opener && opener.focus && opener.focus(); } catch {}
  }
  return { veil, box, close };
}

export function openManageModels(onChanged = null) {
  const { box, close } = openModal("Manage models");
  const changed = () => { try { onChanged && onChanged(); } catch {} };
  renderManage(box, close, changed);
}

// Direct entry to the Connect flow (Providers settings "Connect provider").
export function openConnectProvider(onChanged = null) {
  const { box, close } = openModal("Connect provider");
  const changed = () => { try { onChanged && onChanged(); } catch {} };
  renderConnect(box, close, () => close(), changed);
}

// ── Manage models ────────────────────────────────────────────
async function renderManage(box, close, changed = () => {}) {
  box.innerHTML = "";
  box.classList.add("modal-wide");
  const head = h("div", { class: "modal-head" },
    h("div", null, h("h2", { text: "Manage models" }),
      h("p", { class: "muted small", text: "Choose which models appear in your chat picker. Newly discovered models appear automatically; hiding never disconnects or deletes anything." })),
    h("span", { class: "modal-head-actions" }));
  const connectBtn = h("button", { class: "btn", type: "button" }, h("span", { html: icons.plus }), h("span", { text: "Connect provider" }));
  connectBtn.addEventListener("click", () => renderConnect(box, close, () => renderManage(box, close, changed), changed));
  const xBtn = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", html: icons.x });
  xBtn.addEventListener("click", close);
  head.querySelector(".modal-head-actions").append(connectBtn, xBtn);
  const search = h("input", { class: "menu-search", type: "search", placeholder: "Search models", "aria-label": "Search models" });
  const status = h("div", { class: "small muted", role: "status", text: "Loading connections…" });
  const list = h("div", { class: "manage-list" });
  box.append(head, search, status, list);

  const fan = beginFan();
  const alive = () => box.isConnected && isCurrent(fan);
  let cfg = {};
  try {
    cfg = (await getConfig()) || {};
  } catch (e) {
    status.textContent = `Couldn't load providers: ${e.message}`;
    return;
  }
  store.set({ config: cfg });
  const conns = connectionsFromConfig(cfg);
  const active = (cfg.provider || {});
  const activeModel = active.model || "";
  const activeKey = (() => {
    const m = conns.find((c) => c.kind === "profile" && c.baseUrl === active.baseUrl)
      || conns.find((c) => c.kind === "profile" && c.keyState.split(":")[0] === active.apiKeyProviderId);
    return m ? connectionKey(m) : "active";
  })();

  const paint = (states) => {
    if (!alive()) return;
    list.replaceChildren();
    const needle = search.value.trim().toLowerCase();
    let shown = 0;
    let hiddenActive = null;
    for (const c of conns) {
      const key = connectionKey(c);
      const st = states.get(key);
      const brand = providerBrand(c);
      const group = h("section", { class: "manage-group" });
      const models = st && st.state === "ok"
        ? [...st.models.map((m) => ({ id: m.id, name: m.name, manual: false })),
          ...manualModels(key).map((id) => ({ id, name: id, manual: true }))]
        : manualModels(key).map((id) => ({ id, name: id, manual: true }));
      const visibleIds = models.filter((m) => !isHidden(key, m.id)).map((m) => m.id);
      const box0 = h("input", { type: "checkbox", "aria-label": `Show all models from ${c.name}` });
      const syncGroupBox = () => {
        box0.checked = models.length > 0 && visibleIds.length === models.length;
        box0.indeterminate = visibleIds.length > 0 && visibleIds.length < models.length;
      };
      syncGroupBox();
      box0.addEventListener("change", () => {
        setConnectionHidden(key, models.map((m) => m.id), !box0.checked);
        paint(states);
      });
      const refreshBtn = h("button", { class: "btn", type: "button", text: "Refresh" });
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        status.textContent = `Refreshing ${c.name}…`;
        states.set(key, await fetchConnectionModels(c, { force: true }));
        if (!alive()) return;
        status.textContent = "";
        paint(states);
      });
      const host = shortHost(c.baseUrl);
      const where = !host ? brand.name : (host === brand.name ? host : `${brand.name} · ${host}`);
      const ghead = h("div", { class: "manage-ghead" }, box0,
        connectionMark(c),
        h("span", { class: "manage-gtitle" }, h("strong", { text: c.name }), h("small", { class: "muted", text: `${where} · ${c.authLabel}` })),
        h("span", { class: "muted small", text: st && st.state === "ok" ? `${visibleIds.length}/${models.length} shown` : c.authLabel }),
        refreshBtn);
      group.append(ghead);

      if (!st || st.state === "loading") {
        group.append(h("div", { class: "muted small", text: "Loading models…" }));
      } else if (st.state === "failed") {
        group.append(h("div", { class: "manage-error" },
          h("span", { text: `Couldn't retrieve models: ${st.error}` }),
          h("button", { class: "btn", type: "button", text: "Retry", onclick: () => refreshBtn.click() })));
      } else if (st.state === "no-key") {
        group.append(h("div", { class: "muted small", text: "No key — add one in Providers settings, or add a model ID manually below." }));
      }
      let rows = 0;
      for (const m of models) {
        if (needle && !`${m.name} ${m.id}`.toLowerCase().includes(needle)) continue;
        const hidden = isHidden(key, m.id);
        if (m.id === activeModel && key === activeKey && hidden && !hiddenActive) {
          hiddenActive = { conn: c.name, model: m.id };
        }
        const tgl = h("button", {
          class: `switch${hidden ? "" : " on"}`, type: "button", role: "switch",
          "aria-checked": String(!hidden), "aria-label": `Show ${m.id} in picker`,
        }, h("span", { class: "knob" }));
        tgl.addEventListener("click", () => {
          setHidden(key, m.id, !hidden);
          paint(states);
        });
        const rm = m.manual ? h("button", { class: "mini-icon", type: "button", title: "Remove manual entry", "aria-label": `Remove ${m.id}`, text: "×" }) : null;
        if (rm) rm.addEventListener("click", () => { removeManualModel(key, m.id); paint(states); });
        group.append(h("div", { class: "manage-row" },
          h("span", { class: "manage-mname" }, h("strong", { text: m.name !== m.id ? m.name : m.id }),
            m.manual ? h("span", { class: "tool-badge", text: "Manual" }) : null,
            m.id !== m.name ? h("small", { class: "muted mono-id", text: m.id }) : null),
          h("span", { class: "manage-ractions" }, tgl, rm)));
        rows++;
        shown++;
      }
      if (needle && !rows) {
        // Hide the whole group on filtered emptiness — except keep error rows.
        if (st.state !== "failed") continue;
      }
      const addRow = h("div", { class: "manage-add" });
      const addInput = h("input", { type: "text", placeholder: "Add model ID (for endpoints without listing)", "aria-label": `Add model ID for ${c.name}`, spellcheck: "false" });
      const addBtn = h("button", { class: "btn", type: "button", text: "Add" });
      addBtn.addEventListener("click", () => {
        try {
          addManualModel(key, addInput.value);
          toast(`Added ${addInput.value.trim()} for ${c.name}`, "success");
          paint(states);
        } catch (e) { toast(e.message, "error"); }
      });
      addRow.append(addInput, addBtn);
      group.append(addRow);
      list.append(group);
    }
    if (hiddenActive) {
      status.textContent = "";
      list.prepend(h("div", { class: "manage-note" },
        h("span", { html: icons.warn }),
        h("span", { text: `Current model ${hiddenActive.model} is hidden from the picker but still active. Unhide it above or pick another model — nothing was switched.` })));
    } else if (!shown) {
      status.textContent = needle ? "No matches." : "";
      if (!needle) list.append(h("div", { class: "muted", text: "No models anywhere — connect a provider to get started." }));
    } else {
      status.textContent = `${shown} model${shown === 1 ? "" : "s"} listed`;
    }
  };

  search.addEventListener("input", () => paint(current));
  const current = new Map(conns.map((c) => [connectionKey(c), { models: [], state: "loading", error: "" }]));
  paint(current);
  search.focus();
  await Promise.all(conns.map(async (c) => {
    const key = connectionKey(c);
    // No-key connections: no fetch (nothing to send), manual entries still manage.
    if (!c.eligible) {
      if (!alive()) return;
      current.set(key, { models: [], state: "no-key", error: "" });
      paint(current);
      return;
    }
    const res = await fetchConnectionModels(c);
    if (!alive()) return;
    current.set(key, res);
    paint(current);
  }));
}

// ── Connect provider flow ──────────────────────────────────────
const PRESETS = [
  { id: "openai", name: "OpenAI", desc: "GPT models via api.openai.com", baseUrl: "https://api.openai.com/v1", authStyle: "", keyLabel: "API key", keyHelp: "Create one at platform.openai.com → API keys." },
  { id: "anthropic", name: "Anthropic", desc: "Claude models via api.anthropic.com", baseUrl: "https://api.anthropic.com/v1", authStyle: "anthropic", keyLabel: "API key", keyHelp: "Create one at console.anthropic.com → API keys." },
  { id: "google", name: "Google", desc: "Gemini models via the OpenAI-compatible endpoint", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", authStyle: "", keyLabel: "API key", keyHelp: "Create one at Google AI Studio → Get API key." },
  { id: "openrouter", name: "OpenRouter", desc: "Many models through one endpoint", baseUrl: "https://openrouter.ai/api/v1", authStyle: "", keyLabel: "API key", keyHelp: "Create one at openrouter.ai → Keys." },
  { id: "deepseek", name: "DeepSeek", desc: "DeepSeek models via api.deepseek.com", baseUrl: "https://api.deepseek.com", authStyle: "", keyLabel: "API key", keyHelp: "Create one at platform.deepseek.com → API keys." },
  { id: "groq", name: "Groq", desc: "Fast inference via api.groq.com", baseUrl: "https://api.groq.com/openai/v1", authStyle: "", keyLabel: "API key", keyHelp: "Create one at console.groq.com → API Keys." },
  { id: "ollama", name: "Ollama (local)", desc: "Models on this machine — no key needed", baseUrl: "http://localhost:11434/v1", authStyle: "", keyLabel: "", keyHelp: "" },
];

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ""; }
}

function renderConnect(box, close, backToManage, changed = () => {}) {
  box.innerHTML = "";
  box.classList.add("modal-wide");
  // Step 1: catalog (implemented integrations only + custom endpoint).
  const paintCatalog = () => {
    box.innerHTML = "";
    const head = h("div", { class: "modal-head" },
      h("div", null, h("h2", { text: "Connect provider" }),
        h("p", { class: "muted small", text: "Step 1 of 3 — choose a provider. Saved keys are reused; nothing is asked twice." })));
    const xBtn = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", html: icons.x });
    xBtn.addEventListener("click", close);
    head.append(xBtn);
    const search = h("input", { class: "menu-search", type: "search", placeholder: "Search providers", "aria-label": "Search providers" });
    const listEl = h("div", { class: "manage-list" });
    box.append(head, search, listEl);
    const cfg = store.get().config || {};
    const profiles = cfg.providerProfiles || {};
    const statusOf = (baseUrl) => {
      const hit = Object.entries(profiles).find(([, p]) => hostOf(p.baseUrl) === hostOf(baseUrl));
      if (!hit) return "Not added";
      const [, p] = hit;
      return p.apiKeyProviderId ? "Saved — key may be set" : "Saved";
    };
    const paint = () => {
      listEl.replaceChildren();
      const needle = search.value.trim().toLowerCase();
      for (const preset of PRESETS) {
        if (needle && !`${preset.name} ${preset.desc}`.toLowerCase().includes(needle)) continue;
        const row = h("button", { class: "connect-row", type: "button" },
          connectionMark({ baseUrl: preset.baseUrl, name: preset.name }),
          h("span", { class: "connect-main" }, h("strong", { text: preset.name }), h("small", { class: "muted", text: preset.desc })),
          h("span", { class: "muted small", text: preset.keyLabel || "No key" }),
          h("span", { class: "muted small", text: statusOf(preset.baseUrl) }));
        row.addEventListener("click", () => paintConfigure(preset, null));
        listEl.append(row);
      }
      const other = h("div", { class: "pop-label", text: "Other" });
      const custom = h("button", { class: "connect-row", type: "button" },
        h("span", { class: "model-mark brand-custom", text: "?" }),
        h("span", { class: "connect-main" }, h("strong", { text: "Custom OpenAI-compatible provider" }), h("small", { class: "muted", text: "Any endpoint that speaks the OpenAI API" })),
        h("span", { class: "tool-badge", text: "Custom" }));
      custom.addEventListener("click", () => paintConfigure(null, null));
      listEl.append(other, custom);
    };
    search.addEventListener("input", paint);
    paint();
    search.focus();
  };

  // Step 2: configure (nickname + credential, reused when saved).
  const paintConfigure = async (preset, existingPid) => {
    box.innerHTML = "";
    const isCustom = !preset;
    const head = h("div", { class: "modal-head" },
      h("div", null, h("h2", { text: isCustom ? "Custom provider" : `Connect ${preset.name}` }),
        h("p", { class: "muted small", text: "Step 2 of 3 — connection details. Secrets stay on this PC." })));
    const backBtn = h("button", { class: "icon-btn", type: "button", title: "Back", "aria-label": "Back", html: icons.arrow });
    backBtn.style.transform = "rotate(180deg)";
    backBtn.addEventListener("click", paintCatalog);
    const xBtn = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", html: icons.x });
    xBtn.addEventListener("click", close);
    head.append(h("span", { class: "modal-head-actions" }, backBtn, xBtn));
    box.append(head);
    const form = h("div", { class: "connect-form" });
    box.append(form);
    const status = h("div", { class: "small muted", role: "status" });
    box.append(status);

    const nick = h("input", { type: "text", value: (existingPid || (preset && preset.name) || ""), "aria-label": "Connection nickname", placeholder: "Connection nickname" });
    const urlInput = h("input", {
      type: "text", value: (preset && preset.baseUrl) || "", placeholder: "https://api.example.com/v1",
      "aria-label": "Base URL", spellcheck: "false", disabled: !!preset,
    });
    form.append(h("label", { class: "set-field" }, h("span", { text: "Nickname" }), nick));
    if (isCustom || !preset) form.append(h("label", { class: "set-field" }, h("span", { text: "Base URL" }), urlInput));

    // Saved-key reuse: masked presence check, never the secret itself.
    let savedKey = false;
    if (preset) {
      const cfg = store.get().config || {};
      const hit = Object.entries(cfg.providerProfiles || {}).find(([, p]) => hostOf(p.baseUrl) === hostOf(preset.baseUrl));
      if (hit) {
        const [, p] = hit;
        try {
          const ks = await keyStatus(p.apiKeyProviderId || hit[0]);
          savedKey = !!((ks.statuses || [])[0] || {}).configured;
        } catch {}
      }
    }
    const needsKey = !preset || !!preset.keyLabel;
    const keyInput = h("input", { type: "password", value: "", placeholder: savedKey ? "Key saved — leave blank to reuse" : "Paste API key", autocomplete: "new-password", "aria-label": "API key" });
    if (needsKey) {
      form.append(h("label", { class: "set-field" }, h("span", { text: preset ? preset.keyLabel : "API key (if required)" }), keyInput));
      if (preset && preset.keyHelp) form.append(h("p", { class: "muted small", text: preset.keyHelp }));
    } else {
      form.append(h("p", { class: "muted small", text: "This endpoint needs no key." }));
    }

    const modelInput = h("input", { type: "text", value: "", placeholder: "e.g. gpt-4o-mini — Test fills the first discovered ID", "aria-label": "Default model ID", spellcheck: "false" });
    form.append(h("label", { class: "set-field" }, h("span", { text: "Default model ID" }), modelInput));
    const btnRow = h("div", { class: "btn-row" });
    const testBtn = h("button", { class: "btn", type: "button", text: "Test & list models" });
    const saveBtn = h("button", { class: "btn primary", type: "button", text: "Save connection" });
    btnRow.append(testBtn, saveBtn);
    form.append(btnRow);
    form.append(h("p", { class: "muted small", text: "Test lists models without spending chat inference." }));

    const baseFor = () => (preset ? preset.baseUrl : urlInput.value.trim());
    const credsFor = () => ({
      baseUrl: baseFor(),
      ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
      authStyle: (preset && preset.authStyle) || undefined,
      apiKeyProviderId: "custom-adhoc",
    });
    testBtn.addEventListener("click", async () => {
      const baseUrl = baseFor();
      if (!baseUrl) { status.textContent = "Base URL is required."; return; }
      testBtn.disabled = true;
      status.textContent = "Listing models…";
      try {
        const res = await fetchProviderModels(credsFor());
        if (res && res.ok === false) {
          status.textContent = `✗ ${res.error || "endpoint refused"}`;
        } else {
          const ids = ((res && res.models) || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
          if (!modelInput.value.trim() && ids.length) modelInput.value = ids[0];
          status.textContent = ids.length ? `✓ Reachable — ${ids.length} models listed.` : "✓ Reachable — no models listed; enter a model ID manually.";
        }
      } catch (e) {
        status.textContent = `✗ Test failed: ${e.message}`;
      } finally {
        testBtn.disabled = false;
      }
    });
    saveBtn.addEventListener("click", async () => {
      const name = nick.value.trim() || (preset && preset.name) || "Custom";
      const baseUrl = baseFor();
      const model = modelInput.value.trim();
      if (!baseUrl) { status.textContent = "Base URL is required."; return; }
      if (!model) { status.textContent = "Default model ID is required — Test can fill it."; return; }
      saveBtn.disabled = true;
      status.textContent = "Saving…";
      try {
        // apply:false — creating a connection never moves existing chats.
        const res = await saveProfile({
          name, baseUrl, model,
          ...(keyInput.value.trim() ? { apiKey: keyInput.value.trim() } : {}),
          ...((preset && preset.authStyle) ? { authStyle: preset.authStyle } : {}),
          apply: false,
        });
        if (res && res.ok === false) throw new Error(res.error || "save failed");
        const fresh = (await getConfig()) || {};
        store.set({ config: fresh });
        changed();
        paintResult({ profileId: res.profileId, name, baseUrl, backToManage, changed });
      } catch (e) {
        status.textContent = `Save failed: ${e.message}`;
        toast(`Save failed: ${e.message}`, "error");
        saveBtn.disabled = false;
      }
    });
  };

  // Step 3: honest result + explicit next actions.
  const paintResult = async ({ profileId, name, baseUrl, backToManage, changed: changed3 = changed }) => {
    box.innerHTML = "";
    const head = h("div", { class: "modal-head" },
      h("div", null, h("h2", { text: "Connection saved" }),
        h("p", { class: "muted small", text: "Step 3 of 3 — verify, then choose what happens next." })));
    const xBtn = h("button", { class: "icon-btn", type: "button", title: "Close", "aria-label": "Close", html: icons.x });
    xBtn.addEventListener("click", close);
    head.append(xBtn);
    const bodyEl = h("div", { class: "connect-form" },
      h("div", { class: "connected-app-meta" },
        h("span", null, "Connection: ", h("strong", { text: name })),
        h("span", null, "Endpoint: ", h("code", { text: baseUrl })),
        h("span", { class: "muted small", role: "status", text: "Checking discovery…" })));
    box.append(head, bodyEl);
    const line = bodyEl.querySelector('[role="status"]');
    let countLine = "Discovery state unknown.";
    try {
      const res = await fetchProviderModels({ profileId });
      if (res && res.ok === false) {
        countLine = `Discovery failed: ${res.error || "endpoint refused"} — add model IDs manually in Manage models.`;
      } else {
        const n = ((res && res.models) || []).length;
        countLine = n ? `${n} models discovered.` : "Connected, but no models listed — add model IDs manually in Manage models.";
      }
    } catch (e) {
      countLine = `Discovery failed: ${e.message}`;
    }
    line.textContent = countLine;
    const row = h("div", { class: "btn-row" });
    const useBtn = h("button", { class: "btn primary", type: "button", text: "Use in chat" });
    useBtn.addEventListener("click", async () => {
      useBtn.disabled = true;
      try {
        const models = await fetchProviderModels({ profileId });
        const first = ((models && models.models) || [])[0];
        const modelId = first ? (typeof first === "string" ? first : first.id) : "";
        if (!modelId) throw new Error("No discovered model to use — add a model ID first.");
        await selectProviderConnection({ profileId, model: modelId });
        const fresh = (await getConfig()) || {};
        store.set({ config: fresh });
        changed3();
        toast(`Now chatting via ${name} · ${modelId}`, "success");
        close();
      } catch (e) {
        useBtn.disabled = false;
        toast(`Use in chat failed: ${e.message}`, "error");
      }
    });
    const manageBtn = h("button", { class: "btn", type: "button", text: "Manage models" });
    manageBtn.addEventListener("click", () => renderManage(box, close, changed3));
    const doneBtn = h("button", { class: "btn", type: "button", text: "Done" });
    doneBtn.addEventListener("click", () => { if (backToManage) backToManage(); else close(); });
    row.append(useBtn, manageBtn, doneBtn);
    bodyEl.append(row);
    bodyEl.append(h("p", { class: "muted small", text: "Existing chats keep their current model until you explicitly switch." }));
  };

  paintCatalog();
}
