import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { CodexCliProvider } from "./providers/codex-cli-provider.js";

export class CustomizationEngine {
  constructor({ configStore, skillRegistry, secretStore }) {
    this.configStore = configStore;
    this.skillRegistry = skillRegistry;
    this.secretStore = secretStore;
  }

  updateRuntimeSettings(input = {}) {
    const patch = {};

    if (input.profile) {
      patch.runtime = {
        activeProfile: input.profile,
      };
    }

    if (input.providerMode) {
      patch.provider = {
        mode: input.providerMode,
      };
    }

    if (input.model) {
      patch.provider = {
        ...(patch.provider || {}),
        model: input.model,
      };
    }

    if (input.baseUrl) {
      patch.provider = {
        ...(patch.provider || {}),
        baseUrl: input.baseUrl,
      };
    }

    if (input.apiKeyProviderId) {
      patch.provider = {
        ...(patch.provider || {}),
        apiKeyProviderId: input.apiKeyProviderId,
      };
    }

    if (input.httpReferer) {
      patch.provider = {
        ...(patch.provider || {}),
        httpReferer: input.httpReferer,
      };
    }

    if (input.appTitle) {
      patch.provider = {
        ...(patch.provider || {}),
        appTitle: input.appTitle,
      };
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
      const live = await provider.testConnection(candidate);
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

    const provider = new OpenAICompatibleProvider(this.configStore, this.secretStore);
    const live = await provider.testConnection(candidate);
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
    const provider = new OpenAICompatibleProvider(this.configStore, this.secretStore);
    return provider.listModels({
      ...candidate,
      apiKey: input.apiKey || "",
    });
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
      if (!String(profile?.baseUrl || "").trim()) {
        throw new Error(`Profile ${profileId} requires baseUrl.`);
      }
      if (!String(profile?.model || "").trim()) {
        throw new Error(`Profile ${profileId} requires model.`);
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
    return this.skillRegistry.createSkill({
      name: input.name || "Custom Skill",
      triggers: input.triggers || [],
      agentId: input.agentId || "",
      agents: input.agents,
      description: input.description || "",
      instructions: input.instructions || "",
    });
  }
}
