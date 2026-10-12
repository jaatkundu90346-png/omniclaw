import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { CodexCliProvider } from "./providers/codex-cli-provider.js";
import { REASONING_EFFORTS } from "./reasoning-effort.js";

export class CustomizationEngine {
  constructor({ configStore, skillRegistry, secretStore }) {
    this.configStore = configStore;
    this.skillRegistry = skillRegistry;
    this.secretStore = secretStore;
  }

  updateRuntimeSettings(input = {}) {
    const patch = {};
    // Accept both flat ({model, baseUrl, ...}) and nested ({provider:{model}})
    // shapes — the Settings UI sends the nested form, callers/tools the flat one.
    const p = input.provider && typeof input.provider === "object" ? input.provider : {};
    const profile = input.profile || input.activeProfile;
    const providerMode = input.providerMode || p.mode || p.providerMode;
    const model = input.model || p.model;
    const baseUrl = input.baseUrl || p.baseUrl;
    const apiKeyProviderId = input.apiKeyProviderId || p.apiKeyProviderId;
    const httpReferer = input.httpReferer || p.httpReferer;

    if (profile) {
      patch.runtime = {
        activeProfile: profile,
      };
    }

    if (providerMode) {
      patch.provider = {
        mode: providerMode,
      };
    }

    if (model) {
      patch.provider = {
        ...(patch.provider || {}),
        model,
      };
    }

    if (baseUrl) {
      patch.provider = {
        ...(patch.provider || {}),
        baseUrl,
      };
    }

    if (apiKeyProviderId) {
      patch.provider = {
        ...(patch.provider || {}),
        apiKeyProviderId,
      };
    }

    if (httpReferer) {
      patch.provider = {
        ...(patch.provider || {}),
        httpReferer,
      };
    }

    if (input.appTitle) {
      patch.provider = {
        ...(patch.provider || {}),
        appTitle: input.appTitle,
      };
    }

    // B1 step 7 (additive): provider display label (no API writer existed;
    // set on profile save+apply, never cleared — now directly settable).
    if (p.label !== undefined) {
      const label = String(p.label || "").trim().slice(0, 120);
      if (!label) throw new Error("provider.label must be a non-empty string.");
      patch.provider = {
        ...(patch.provider || {}),
        label,
      };
    }

    // B1 step 7 (additive): `ui` prefs object (theme, fontSize,
    // showSystemSessions, panelWidth). Unknown keys are REJECTED, as are
    // providerProfiles (managed exclusively via the dedicated
    // /api/provider/profile* routes — never through /api/config).
    if (input.providerProfiles !== undefined) {
      throw new Error("providerProfiles is managed via /api/provider/profile* routes, not /api/config.");
    }
    if (input.ui !== undefined) {
      if (!input.ui || typeof input.ui !== "object" || Array.isArray(input.ui)) {
        throw new Error("ui must be an object.");
      }
      const UI_KEYS = ["theme", "fontSize", "showSystemSessions", "panelWidth"];
      for (const key of Object.keys(input.ui)) {
        if (!UI_KEYS.includes(key)) {
          throw new Error(`Unknown ui key: ${key}. Allowed: ${UI_KEYS.join(", ")}.`);
        }
      }
      const uiPatch = {};
      if (input.ui.theme !== undefined) {
        const theme = String(input.ui.theme).toLowerCase();
        if (!["dark", "light", "system"].includes(theme)) {
          throw new Error('ui.theme must be "dark", "light" or "system".');
        }
        uiPatch.theme = theme;
      }
      if (input.ui.fontSize !== undefined) {
        const n = Number(input.ui.fontSize);
        if (!Number.isFinite(n) || n < 8 || n > 32) {
          throw new Error("ui.fontSize must be a number between 8 and 32.");
        }
        uiPatch.fontSize = n;
      }
      if (input.ui.showSystemSessions !== undefined) {
        if (typeof input.ui.showSystemSessions !== "boolean") {
          throw new Error("ui.showSystemSessions must be a boolean.");
        }
        uiPatch.showSystemSessions = input.ui.showSystemSessions;
      }
      if (input.ui.panelWidth !== undefined) {
        const n = Number(input.ui.panelWidth);
        if (!Number.isFinite(n) || n < 200 || n > 800) {
          throw new Error("ui.panelWidth must be a number between 200 and 800.");
        }
        uiPatch.panelWidth = n;
      }
      if (Object.keys(uiPatch).length > 0) {
        patch.ui = { ...((patch.ui && typeof patch.ui === "object") ? patch.ui : {}), ...uiPatch };
      }
    }

    // T2 feature flags (all default to OLD behaviour; see T2 RULES).
    // Booleans only — unknown keys elsewhere are still ignored/rejected.
    const FLAG_KEYS = [
      ["prompt", "v2"],
      ["tools", "menuV2"],
      ["loop", "guardsV2"],
      ["paths", "unified"],
      ["learning", "enabled"],
    ];
    for (const [top, key] of FLAG_KEYS) {
      const holder = input[top];
      if (holder && typeof holder === "object" && holder[key] !== undefined) {
        if (typeof holder[key] !== "boolean") {
          throw new Error(`${top}.${key} must be a boolean.`);
        }
        patch[top] = { ...(patch[top] || {}), [key]: holder[key] };
      }
    }

    // Cheap-model override for summaries/compaction/learning.
    const compactionModel = input.compactionModel ?? p.compactionModel;
    if (compactionModel !== undefined) {
      patch.provider = {
        ...(patch.provider || {}),
        compactionModel: String(compactionModel || ""),
      };
    }

    // Reasoning effort (Settings UI "Reasoning effort" row). Additive, and
    // deliberately validated against a fixed list rather than passed through:
    // this value goes straight into a provider request body, so an unvalidated
    // string from the browser would be an injection point into the API call.
    //
    // NOTE the `!== undefined` check is load-bearing. `null` is the MEANINGFUL
    // "off" value (stop asking the model to think harder), so it must survive
    // the patch — an `if (reasoning)` guard would silently drop it and the UI
    // would claim success while the setting never changed.
    const reasoning = input.reasoning !== undefined ? input.reasoning : p.reasoning;
    if (reasoning !== undefined) {
      if (reasoning === null || reasoning === false) {
        patch.provider = { ...(patch.provider || {}), reasoning: null };
      } else {
        const effort = typeof reasoning === "object" && reasoning !== null
          ? reasoning.effort
          : reasoning;
        const level = String(effort || "").trim().toLowerCase();
        if (!REASONING_EFFORTS.includes(level)) {
          throw new Error(
            `provider.reasoning must be one of: ${REASONING_EFFORTS.join(", ")} (or null to turn it off).`,
          );
        }
        patch.provider = { ...(patch.provider || {}), reasoning: level };
      }
    }

    // Sub-agent LIMITS (Settings UI "Sub-agents" card): maxConcurrent, maxPerHour,
// timeoutMs — sanitized here so arbitrary runtime keys still can't be written
    // through this endpoint.
    //
    // There is deliberately NO provider/model/fallbackModel writer any more.
    // Silently ignoring them is not enough on its own, so each is REJECTED
    // outright: a stale client that still sends {model: "x"} gets an error
    // naming the truth ("sub-agents always use the main model") instead of a
    // cheerful 200 that quietly discarded what it was told. A silent drop here
    // is how a removed setting comes back three versions later.
    const sub = input.runtime?.subAgents || input.subAgents;
    if (sub && typeof sub === "object") {
      for (const gone of ["provider", "model", "fallbackModel"]) {
        if (sub[gone] !== undefined) {
          throw new Error(
            `runtime.subAgents.${gone} was removed — sub-agents always run on the main agent's model and endpoint.`,
          );
        }
      }
      const subPatch = {};
      if (sub.maxConcurrent !== undefined) subPatch.maxConcurrent = Math.max(1, Math.min(8, Number(sub.maxConcurrent) || 3));
      if (sub.maxPerHour !== undefined) subPatch.maxPerHour = Math.max(1, Math.min(200, Number(sub.maxPerHour) || 30));
      if (sub.timeoutMs !== undefined) subPatch.timeoutMs = Math.max(30000, Math.min(1800000, Number(sub.timeoutMs) || 300000));
      if (Object.keys(subPatch).length > 0) {
        patch.runtime = {
          ...(patch.runtime || {}),
          subAgents: subPatch,
        };
      }
    }

    if (input.ownerMode === true || input.fullComputerAccess === true) {
      patch.tools = {
        ...(patch.tools || {}),
        permissions: {
          allowComputerAccess: true,
          allowShellExecution: true,
          allowShellPlanning: true,
          allowBrowserControl: true,
          allowFileRead: true,
          allowDirectoryList: true,
          allowFileWrite: true,
          allowConfigWrite: true,
          allowConnectorWrite: true,
        },
        computerAccess: {
          enabled: true,
          allowedRoots: ["~", "C:/", "D:/", "E:/", "F:/"],
          allowWrite: true,
          allowDelete: true,
          allowPermanentDelete: false,
          trashDir: "data/trash",
          maxReadBytes: 262144,
          blockedPathPatterns: [
            "^[A-Z]:/Windows(?:/|$)",
            "^[A-Z]:/Program Files(?:/|$)",
            "^[A-Z]:/Program Files \\(x86\\)(?:/|$)",
            "^[A-Z]:/ProgramData(?:/|$)",
          ],
        },
        shellExecution: {
          trustLevel: "full",
          allowlistMode: "advisory",
          allowExternalCwd: true,
          timeoutMs: 120000,
          maxOutputBytes: 256000,
        },
      };
    }

    if (input.computerAccess && typeof input.computerAccess === "object") {
      patch.tools = {
        ...(patch.tools || {}),
        computerAccess: input.computerAccess,
      };
    }

    if (input.shellExecution && typeof input.shellExecution === "object") {
      patch.tools = {
        ...(patch.tools || {}),
        shellExecution: {
          ...(patch.tools?.shellExecution || {}),
          ...input.shellExecution,
        },
      };
    }

    // Access-mode chip (chat composer): sanitized nested tools patch — only
    // KNOWN boolean permission keys and the approvalMode enum pass through,
    // so this endpoint still can't write arbitrary config.
    const chipPerms = input.tools?.permissions;
    if (chipPerms && typeof chipPerms === "object") {
      const PERMISSION_KEYS = [
        "allowFileWrite", "allowShellExecution", "allowComputerAccess",
        "allowConnectorWrite", "allowBrowserControl", "allowBrowserEvaluate",
        "allowConfigWrite", "allowSkillWrite", "allowTaskWrite", "allowTaskRunner",
      ];
      const sanitized = {};
      for (const key of PERMISSION_KEYS) {
        if (typeof chipPerms[key] === "boolean") sanitized[key] = chipPerms[key];
      }
      if (Object.keys(sanitized).length > 0) {
        patch.tools = {
          ...(patch.tools || {}),
          permissions: { ...(patch.tools?.permissions || {}), ...sanitized },
        };
      }
    }
    const chipApprovalMode = input.tools?.shellExecution?.approvalMode;
    if (chipApprovalMode !== undefined) {
      const mode = String(chipApprovalMode).toLowerCase();
      if (mode === "auto" || mode === "always") {
        patch.tools = {
          ...(patch.tools || {}),
          shellExecution: { ...(patch.tools?.shellExecution || {}), approvalMode: mode },
        };
      }
    }

    if (Object.keys(patch).length === 0) {
      return {
        updated: false,
        reason: "No runtime settings were provided.",
        config: this.configStore.getConfig(),
      };
    }

    return {
      updated: true,
      config: this.configStore.updateUserConfig(patch),
    };
  }

  applyProviderProfile(profileId) {
    const config = this.configStore.getConfig();
    const profile = config.providerProfiles?.[profileId];
    if (!profile) {
      throw new Error(`Provider profile not found: ${profileId}`);
    }
    this.validateProviderProfile(profileId, profile);
    return {
      updated: true,
      config: this.configStore.applyProviderProfile(profileId),
    };
  }

  // Atomic model selection: switch connection (optional profileId) AND set the
  // exact model in ONE backend operation, then verify the committed pair.
  // Replaces the racy applyProfile-then-setModel pair: no message can observe
  // a half-applied state, and partial failure reports its stage instead of
  // pretending nothing changed. Scope is global (all chats) — per-chat scope
  // does not exist backend-side, so callers must label it honestly.
  selectProviderConnection(input = {}) {
    const profileId = String(input.profileId || "").trim();
    const model = String(input.model || "").trim();
    const contextTokensRaw = Number(input.contextTokens);
    const contextTokens = Number.isFinite(contextTokensRaw) && contextTokensRaw > 0
      ? Math.round(Math.max(8000, Math.min(2000000, contextTokensRaw)))
      : 0;
    if (!model) {
      return { ok: false, stage: "validate", error: "model is required.", scope: "global" };
    }
    const fail = (stage, error) => ({
      ok: false, stage, error, scope: "global",
      applied: { profileId: profileId || null, model },
    });
    try {
      if (profileId) {
        const profile = this.configStore.getConfig().providerProfiles?.[profileId];
        if (!profile) return fail("validate", `Provider profile not found: ${profileId}`);
        try {
          this.validateProviderProfile(profileId, profile);
        } catch (err) {
          return fail("validate", err.message);
        }
        try {
          this.configStore.applyProviderProfile(profileId);
        } catch (err) {
          return fail("apply-profile", err.message);
        }
      }
      let committed;
      try {
        committed = this.configStore.updateUserConfig({
          provider: { model, ...(contextTokens > 0 ? { contextTokens } : {}) },
        });
      } catch (err) {
        return fail("apply-model", err.message);
      }
      const got = (committed && committed.provider) || {};
      if (got.model !== model) {
        return fail("verify", "model did not persist — check provider settings.");
      }
      if (profileId) {
        const want = this.configStore.getConfig().providerProfiles?.[profileId] || {};
        if (got.baseUrl !== want.baseUrl) {
          return fail("verify", `connection did not switch to ${profileId}.`);
        }
      }
      return {
        ok: true, stage: "done", scope: "global",
        provider: {
          model: got.model, baseUrl: got.baseUrl || "",
          apiKeyProviderId: got.apiKeyProviderId || "", label: got.label || "",
          ...(Number.isFinite(Number(got.contextTokens)) && Number(got.contextTokens) > 0
            ? { contextTokens: Number(got.contextTokens) }
            : (contextTokens > 0 ? { contextTokens } : {})),
        },
        applied: { profileId: profileId || null, model, ...(contextTokens > 0 ? { contextTokens } : {}) },
      };
    } catch (err) {
      return fail("unknown", err.message);
    }
  }

  // ─── Custom provider: name + URL + key → a persisted, selectable profile ──
  // Turn a user-supplied {name, baseUrl, model, apiKey, authStyle} into a saved
  // providerProfiles entry so it appears in the picker with the user's own name.
  async saveProviderProfile(input = {}) {
    const rawName = String(input.name || input.profileId || "").trim();
    if (!rawName) {
      return { ok: false, error: "Provider name is required." };
    }
    // Slug becomes both the profile id and the key-store id. Keep it readable.
    const profileId = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `custom-${Date.now()}`;
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
    const model = String(input.model || "").trim();
    const apiKey = String(input.apiKey || "").trim();
    const apiKeyProviderId = String(input.apiKeyProviderId || profileId).trim();
    const authStyle = String(input.authStyle || "").trim().toLowerCase(); // "" | "anthropic"

    const profile = {
      mode: "openai-compatible",
      baseUrl,
      model,
      apiKeyProviderId,
      label: rawName,
      custom: true,
      ...(authStyle ? { authStyle } : {}),
    };

    try {
      this.validateProviderProfile(profileId, profile);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // Store the key first so a later apply/test finds it.
    let keyStatus = this.secretStore.getProviderKeyStatus(apiKeyProviderId);
    if (apiKey) {
      keyStatus = this.secretStore.setProviderKey(apiKeyProviderId, apiKey);
    }

    const config = this.configStore.saveProviderProfile(profileId, profile);
    const applied = input.apply ? this.configStore.applyProviderProfile(profileId) : null;

    return {
      ok: true,
      profileId,
      profile,
      keySaved: Boolean(apiKey),
      keyStatus,
      applied: Boolean(applied),
      profiles: (applied || config).providerProfiles || config.providerProfiles || {},
    };
  }

  deleteProviderProfile(input = {}) {
    const profileId = String(input.profileId || input.name || "").trim();
    if (!profileId) return { ok: false, error: "profileId is required." };
    const result = this.configStore.deleteProviderProfile(profileId);
    if (result.removed && input.removeKey) {
      try { this.secretStore.setProviderKey(profileId, ""); } catch { /* best-effort */ }
    }
    return { ok: result.removed, ...result, profiles: this.configStore.getConfig().providerProfiles || {} };
  }

  setProviderKey(input = {}) {
    const providerId = String(input.providerId || "openai").trim();
    const apiKey = String(input.apiKey || "").trim();
    if (!providerId) {
      return {
        updated: false,
        reason: "providerId is required.",
        status: this.secretStore.getProviderKeyStatus(providerId),
      };
    }

    if (!apiKey) {
      this.secretStore.setProviderKey(providerId, "");
      return {
        updated: true,
        removed: true,
        status: this.secretStore.getProviderKeyStatus(providerId),
      };
    }

    return {
      updated: true,
      status: this.secretStore.setProviderKey(providerId, apiKey),
    };
  }

  async configureProviderBrain(input = {}) {
    const config = this.configStore.getConfig();
    const profileId = String(input.profileId || input.providerId || "").trim();
    const profile = profileId ? config.providerProfiles?.[profileId] : null;
    const providerKeyId = String(
      input.apiKeyProviderId ||
      profile?.apiKeyProviderId ||
      profileId ||
      config.provider?.apiKeyProviderId ||
      "openai-compatible",
    ).trim();
    const apiKey = String(input.apiKey || "").trim();

    let keyStatus = this.secretStore.getProviderKeyStatus(providerKeyId);
    if (apiKey) {
      keyStatus = this.secretStore.setProviderKey(providerKeyId, apiKey);
    }

    const providerPatch = {
      ...(profile || {}),
      mode: String(input.mode || profile?.mode || config.provider?.mode || "openai-compatible").trim(),
      baseUrl: String(input.baseUrl || profile?.baseUrl || config.provider?.baseUrl || "").trim(),
      model: String(input.model || profile?.model || config.provider?.model || "").trim(),
      apiKeyProviderId: providerKeyId,
      httpReferer: String(input.httpReferer || profile?.httpReferer || config.provider?.httpReferer || "").trim(),
      appTitle: String(input.appTitle || profile?.appTitle || config.provider?.appTitle || config.app?.name || "").trim(),
    };

    this.validateProviderProfile(profileId || providerKeyId || "active", providerPatch);
    const updatedConfig = this.configStore.updateUserConfig({ provider: providerPatch });
    const readiness = await this.testProviderProfile({
      ...providerPatch,
      live: input.live === false ? false : true,
      timeoutMs: input.timeoutMs || 45000,
    });

    let models = null;
    if (input.fetchModels) {
      models = await this.listProviderModels({
        ...providerPatch,
        timeoutMs: input.timeoutMs || 45000,
      });
    }

    return {
      updated: true,
      profileId: profileId || null,
      mode: providerPatch.mode,
      baseUrl: providerPatch.baseUrl,
      model: providerPatch.model,
      apiKeyProviderId: providerKeyId,
      keySaved: Boolean(apiKey),
      keyStatus,
      readiness,
      models,
      config: {
        provider: {
          mode: updatedConfig.provider?.mode,
          baseUrl: updatedConfig.provider?.baseUrl,
          model: updatedConfig.provider?.model,
          apiKeyProviderId: updatedConfig.provider?.apiKeyProviderId,
        },
      },
    };
  }

  getProviderKeyStatus(input = {}) {
    const providerId = String(input.providerId || "").trim();
    if (providerId) {
      return {
        statuses: [this.secretStore.getProviderKeyStatus(providerId)],
      };
    }
    return {
      statuses: this.secretStore.getAllStatuses(),
    };
  }

  async testProviderProfile(input = {}) {
    const config = this.configStore.getConfig();
    const profileId = String(input.profileId || "").trim();
    const profile = profileId ? config.providerProfiles?.[profileId] : null;
    const pick = (key, fallback = "") =>
      input[key] != null
        ? input[key]
        : profile && Object.prototype.hasOwnProperty.call(profile, key)
          ? profile[key]
          : config.provider?.[key] != null
            ? config.provider[key]
            : fallback;
    const candidate = {
      mode: String(pick("mode")).trim(),
      baseUrl: String(pick("baseUrl")).trim(),
      model: String(pick("model")).trim(),
      apiKeyProviderId: String(pick("apiKeyProviderId")).trim(),
      httpReferer: String(pick("httpReferer")).trim(),
      appTitle: String(input.appTitle || profile?.appTitle || config.provider.appTitle || config.app?.name || "").trim(),
      codexCommand: String(pick("codexCommand", "codex")).trim(),
      codexSandbox: String(pick("codexSandbox", "read-only")).trim(),
      timeoutMs: Number(input.timeoutMs || profile?.timeoutMs || config.provider.timeoutMs || 45000),
    };
    this.validateProviderProfile(profileId || "ad-hoc", candidate);
    const keyStatus = this.secretStore.getProviderKeyStatus(candidate.apiKeyProviderId || "openai");
    const endpoint = candidate.baseUrl ? `${candidate.baseUrl.replace(/\/+$/, "")}/chat/completions` : "";

    if (candidate.mode === "mock") {
      return {
        ok: true,
        liveOk: true,
        profileId: profileId || null,
        endpoint: null,
        candidate,
        keyStatus,
        message: "Mock provider is ready for offline replies.",
      };
    }

    if (candidate.mode === "codex-cli") {
      const provider = new CodexCliProvider(this.configStore);
      const live = await provider.testConnection({
        ...candidate,
        verifyAuth: input.verifyAuth === true,
        prompt: input.prompt || "",
        timeoutMs: input.timeoutMs || candidate.timeoutMs,
      });
      return {
        ok: Boolean(live.ok),
        liveOk: Boolean(live.ok),
        profileId: profileId || null,
        endpoint: null,
        candidate,
        keyStatus: { providerId: "codex-cli", configured: false, masked: "" },
        live,
        message: live.ok
          ? "Codex CLI bridge is ready. ChatGPT sign-in is handled by the official Codex CLI."
          : `Codex CLI bridge is not ready: ${live.error}`,
      };
    }

    if (!keyStatus.configured) {
      return {
        ok: false,
        liveOk: false,
        profileId: profileId || null,
        endpoint,
        candidate,
        keyStatus,
        message: `Provider key missing for ${candidate.apiKeyProviderId}.`,
      };
    }

    if (input.live === false) {
      return {
        ok: true,
        liveOk: null,
        profileId: profileId || null,
        endpoint,
        candidate,
        keyStatus,
        message: "Provider key is configured. Live API test was skipped.",
      };
    }

    this.assertStoredKeyTargetAllowed(candidate, Boolean(input.apiKey));
    const provider = new OpenAICompatibleProvider(this.configStore, this.secretStore);
    const live = await provider.testConnection({ ...candidate, apiKey: input.apiKey || undefined });
    return {
      ok: Boolean(live.ok),
      liveOk: Boolean(live.ok),
      profileId: profileId || null,
      endpoint,
      candidate,
      keyStatus,
      live,
      message: live.ok
        ? `Provider live test passed for ${candidate.model}.`
        : `Provider live test failed for ${candidate.model}: ${live.error}`,
    };
  }

  async listProviderModels(input = {}) {
    const config = this.configStore.getConfig();
    const profileId = String(input.profileId || "").trim();
    const profile = profileId ? config.providerProfiles?.[profileId] : null;
    const candidate = {
      mode: String(input.mode || profile?.mode || config.provider.mode || "").trim(),
      baseUrl: String(input.baseUrl || profile?.baseUrl || config.provider.baseUrl || "").trim(),
      apiKeyProviderId: String(input.apiKeyProviderId || profile?.apiKeyProviderId || config.provider.apiKeyProviderId || "").trim(),
      httpReferer: String(input.httpReferer || profile?.httpReferer || config.provider.httpReferer || "").trim(),
      appTitle: String(input.appTitle || profile?.appTitle || config.provider.appTitle || config.app?.name || "").trim(),
      timeoutMs: Number(input.timeoutMs || profile?.timeoutMs || config.provider.timeoutMs || 45000),
    };
    if (candidate.mode === "mock") {
      return {
        ok: true,
        endpoint: null,
        models: [{ id: "local-rule-engine", ownedBy: "omniclaw" }],
        count: 1,
        message: "Offline provider has one local rule-engine model.",
      };
    }
    if (candidate.mode === "codex-cli") {
      return {
        ok: true,
        endpoint: null,
        models: [{ id: "account-default", ownedBy: "codex-cli" }],
        count: 1,
        message: "Codex CLI uses the signed-in account model selection.",
      };
    }
    this.assertStoredKeyTargetAllowed(candidate, Boolean(input.apiKey));
    const provider = new OpenAICompatibleProvider(this.configStore, this.secretStore);
    return provider.listModels({
      ...candidate,
      apiKey: input.apiKey || "",
    });
  }

  // SSRF / key-exfil guard: the stored provider API key must NEVER be sent to an
  // arbitrary, caller-supplied baseUrl. Only allow the stored key when the target
  // host matches a host from a SAVED provider profile / config for that key. To
  // test a fresh baseUrl, the caller must pass a one-time `apiKey` (their own).
  assertStoredKeyTargetAllowed(candidate, hasExplicitKey) {
    let url;
    try { url = new URL(candidate.baseUrl); } catch { throw new Error(`Invalid provider baseUrl: ${candidate.baseUrl}`); }
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("Provider baseUrl must be http(s).");
    }
    if (hasExplicitKey) return; // caller supplied their own key → their choice of host
    const config = this.configStore.getConfig();
    const keyId = candidate.apiKeyProviderId || "";
    const allowedHosts = new Set();
    const collect = (p) => {
      if (p?.baseUrl && String(p.apiKeyProviderId || "") === keyId) {
        try { allowedHosts.add(new URL(p.baseUrl).host); } catch { /* ignore */ }
      }
    };
    Object.values(config.providerProfiles || {}).forEach(collect);
    collect(config.provider);
    const presetForKey = config.providerProfiles?.[keyId];
    if (presetForKey?.baseUrl) { try { allowedHosts.add(new URL(presetForKey.baseUrl).host); } catch { /* ignore */ } }
    if (!allowedHosts.has(url.host)) {
      throw new Error(`Refusing to send the stored '${keyId || "provider"}' API key to ${url.host} — it does not match a saved provider endpoint (SSRF/key-exfil guard). Pass a one-time apiKey to test an arbitrary baseUrl.`);
    }
  }

  validateProviderProfile(profileId, profile) {
    const mode = String(profile?.mode || "").trim();
    if (!["mock", "openai-compatible", "codex-cli"].includes(mode)) {
      throw new Error(`Profile ${profileId} has unsupported mode "${mode}".`);
    }
    if (mode === "codex-cli") {
      if (!String(profile?.codexCommand || "codex").trim()) {
        throw new Error(`Profile ${profileId} requires codexCommand.`);
      }
      return;
    }
    if (mode === "openai-compatible") {
      const model = String(profile?.model || "").trim();
      if (!String(profile?.baseUrl || "").trim()) {
        throw new Error(`Profile ${profileId} requires baseUrl.`);
      }
      if (!model) {
        throw new Error(`Profile ${profileId} requires model.`);
      }
      if (model.startsWith("/") || model.includes(" ")) {
        throw new Error(`Profile ${profileId} has invalid model "${model}".`);
      }
      if (!String(profile?.apiKeyProviderId || "").trim()) {
        throw new Error(`Profile ${profileId} requires apiKeyProviderId.`);
      }
    }
  }

  updateShellPolicy(input = {}) {
    const patch = {};
    const shellExecution = {};

    if (input.allowlistMode != null) {
      const mode = String(input.allowlistMode || "").trim().toLowerCase();
      if (!["advisory", "enforce"].includes(mode)) {
        throw new Error("allowlistMode must be advisory or enforce.");
      }
      shellExecution.allowlistMode = mode;
    }

    if (input.trustLevel != null) {
      const trustLevel = String(input.trustLevel || "").trim().toLowerCase();
      if (!["protected", "balanced", "full"].includes(trustLevel)) {
        throw new Error("trustLevel must be protected, balanced, or full.");
      }
      shellExecution.trustLevel = trustLevel;
    }

    if (input.timeoutMs != null) {
      const timeoutMs = Number(input.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
        throw new Error("timeoutMs must be between 1000 and 120000.");
      }
      shellExecution.timeoutMs = Math.round(timeoutMs);
    }

    if (input.maxOutputBytes != null) {
      const maxOutputBytes = Number(input.maxOutputBytes);
      if (!Number.isFinite(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 256000) {
        throw new Error("maxOutputBytes must be between 1024 and 256000.");
      }
      shellExecution.maxOutputBytes = Math.round(maxOutputBytes);
    }

    if (input.allowlistPatterns != null) {
      shellExecution.allowlistPatterns = this.normalizePatternList(input.allowlistPatterns, "allowlistPatterns");
    }

    if (input.blockedPatterns != null) {
      shellExecution.blockedPatterns = this.normalizePatternList(input.blockedPatterns, "blockedPatterns");
    }

    if (Object.keys(shellExecution).length > 0) {
      patch.tools = {
        shellExecution,
      };
    }

    if (Object.keys(patch).length === 0) {
      return {
        updated: false,
        reason: "No shell policy settings were provided.",
        config: this.configStore.getConfig(),
      };
    }

    return {
      updated: true,
      config: this.configStore.updateUserConfig(patch),
    };
  }

  normalizePatternList(value, label) {
    const items = Array.isArray(value)
      ? value
      : String(value || "")
          .split(/\r?\n/)
          .map((item) => item.trim());
    const patterns = items.map((item) => String(item || "").trim()).filter(Boolean);

    if (patterns.length === 0) {
      throw new Error(`${label} must include at least one regex pattern.`);
    }

    for (const pattern of patterns) {
      try {
        new RegExp(pattern, "i");
      } catch (error) {
        throw new Error(`${label} contains invalid regex "${pattern}": ${error.message}`);
      }
    }

    return patterns;
  }

  createSkill(input = {}) {
    // SkillRegistry.createSkill(name, options) expects a STRING name first.
    // Passing the whole object made it `path.join(..., <object>)` → crash, so
    // create_skill was dead. Destructure into (name, options).
    const name = String(input.name || "Custom Skill");
    return this.skillRegistry.createSkill(name, {
      triggers: input.triggers || [],
      tags: input.tags || [],
      agentId: input.agentId || "main",
      description: input.description || "",
      content: input.instructions || input.content || "",
      scope: input.scope || (input.agentId ? "agent" : "global"),
    });
  }
}
