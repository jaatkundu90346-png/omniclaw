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
}
