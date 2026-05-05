import { MockProvider } from "./providers/mock-provider.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { CodexCliProvider } from "./providers/codex-cli-provider.js";

export function createProvider(configStore, secretStore) {
  const config = configStore.getConfig();

  if (config.provider.mode === "openai-compatible") {
    const provider = new OpenAICompatibleProvider(configStore, secretStore);
    const info = provider.getInfo();
    if (info.ready === false || info.apiKeySource === "missing") {
      return new MockProvider(configStore, {
        fallbackFrom: "openai-compatible",
        message: `Remote provider ${info.apiKeyProviderId || "openai-compatible"} is missing a key, so OmniClaw is using the offline task engine.`,
      });
    }
    return provider;
  }

  if (config.provider.mode === "codex-cli") {
    return new CodexCliProvider(configStore);
  }

  return new MockProvider(configStore);
}
