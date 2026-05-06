import fs from "node:fs";
import path from "node:path";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      output[key] = mergeDeep(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export class ConfigStore {
  constructor(rootDir) {
    this.defaultPath = path.join(rootDir, "config", "default.json");
    this.userPath = path.join(rootDir, "data", "config.json");
    fs.mkdirSync(path.dirname(this.userPath), { recursive: true });
  }

  readDefaults() {
    return JSON.parse(fs.readFileSync(this.defaultPath, "utf8"));
  }

  readUserConfig() {
    if (String(process.env.OMNICLAW_DISABLE_USER_CONFIG || "").toLowerCase() === "1") {
      return {};
    }
    if (!fs.existsSync(this.userPath)) {
      return {};
    }

    return JSON.parse(fs.readFileSync(this.userPath, "utf8"));
  }

  getConfig() {
    return mergeDeep(this.readDefaults(), this.readUserConfig());
  }

  getPublicConfig() {
    const config = this.getConfig();
    return {
      ...config,
      provider: {
        ...config.provider,
        apiKeyConfigured: undefined,
      },
    };
  }

  getActiveProfile() {
    const config = this.getConfig();
    const profileId = config.runtime.activeProfile;
    return {
      id: profileId,
      ...(config.runtime.profiles[profileId] || {}),
    };
  }

  getProfile(profileId) {
    const config = this.getConfig();
    const resolvedId = String(profileId || config.runtime.activeProfile || "").trim();
    return {
      id: resolvedId,
      ...(config.runtime.profiles[resolvedId] || {}),
    };
  }

  writeUserConfig(nextConfig) {
    fs.writeFileSync(this.userPath, JSON.stringify(nextConfig, null, 2));
    return nextConfig;
  }

  updateUserConfig(patch) {
    const current = this.readUserConfig();
    const next = mergeDeep(current, patch);
    this.writeUserConfig(next);
    return this.getConfig();
  }

  applyProviderProfile(profileId) {
    const config = this.getConfig();
    const profile = config.providerProfiles?.[profileId];
    if (!profile) {
      throw new Error(`Provider profile not found: ${profileId}`);
    }

    const provider = { ...profile };
    return this.updateUserConfig({ provider });
  }

  // ─── Config Validation ────────────────────────────────────────
  validateConfig(config) {
    const errors = [];
    const warnings = [];
    if (!config || typeof config !== "object") {
      errors.push("Config must be an object");
      return { valid: false, errors, warnings };
    }
    // Provider validation
    if (config.provider) {
      const validModes = ["mock", "openai-compatible", "codex-cli"];
      if (!validModes.includes(config.provider.mode)) {
        errors.push(`provider.mode "${config.provider.mode}" is not valid. Use: ${validModes.join(", ")}`);
      }
      if (config.provider.mode === "openai-compatible" && !config.provider.baseUrl) {
        errors.push("provider.baseUrl is required for openai-compatible mode");
      }
      if (config.provider.temperature !== undefined && (config.provider.temperature < 0 || config.provider.temperature > 2)) {
        warnings.push("provider.temperature should be between 0 and 2");
      }
      if (config.provider.maxTokens !== undefined && config.provider.maxTokens < 1) {
        errors.push("provider.maxTokens must be positive");
      }
    }
    // Session validation
    if (config.session) {
      if (config.session.detailMessageLimit !== undefined && config.session.detailMessageLimit < 1) {
        errors.push("session.detailMessageLimit must be positive");
      }
    }
    // Tools validation
    if (config.tools?.shellExecution) {
      if (config.tools.shellExecution.timeoutMs !== undefined && config.tools.shellExecution.timeoutMs < 1000) {
        warnings.push("shellExecution.timeoutMs is very low (<1s), may cause premature timeouts");
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }
}
