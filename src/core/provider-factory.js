import { MockProvider } from "./providers/mock-provider.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { CodexCliProvider } from "./providers/codex-cli-provider.js";

export function createProvider(configStore, secretStore) {
  const config = configStore.getConfig();
  if (config.provider.mode === "openai-compatible") {
    return new OpenAICompatibleProvider(configStore, secretStore);
  }
  if (config.provider.mode === "codex-cli") {
    return new CodexCliProvider(configStore);
  }
  return new MockProvider(configStore);
}

export function getProvider(configStore, secretStore, profileId) {
  const config = configStore.getConfig();
  const profiles = config.providerProfiles || {};
  const profile = profiles[profileId];
  if (!profile) {
    return null;
  }
  const mode = profile.mode || config.provider.mode;
  if (mode === "openai-compatible") {
    const tempConfig = {
      ...config,
      provider: { ...config.provider, ...profile },
    };
    const tempConfigStore = {
      getConfig: () => tempConfig,
    };
    const provider = new OpenAICompatibleProvider(tempConfigStore, secretStore);
    const info = provider.getInfo();
    if (info.ready === false || info.apiKeySource === "missing") {
      return null;
    }
    return provider;
  }
  if (mode === "codex-cli") {
    return new CodexCliProvider(configStore);
  }
  return null;
}
