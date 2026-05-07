export const PROVIDER_PRESETS = {
  openai: { providerId: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { providerId: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-3-7-sonnet-latest" },
  gemini: { providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-1.5-pro" },
  groq: { providerId: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-70b-versatile" },
  openrouter: { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  nvidia: { providerId: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", model: "z-ai/glm-5.1" },
  "codex-cli": { providerId: "codex-cli", baseUrl: "", model: "account-default" },
  "local-compatible": { providerId: "local-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.2" },
  ollama: { providerId: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  mistral: { providerId: "mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-latest" },
  deepseek: { providerId: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  together: { providerId: "together", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" },
  fireworks: { providerId: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/llama-v3p1-8b-instruct" },
};

export function inferProfileFromProviderId(providerId = "") {
  const normalized = String(providerId || "").trim().toLowerCase();
  if (!normalized) {
    return "openai";
  }
  if (PROVIDER_PRESETS[normalized]) {
    return normalized;
  }
  return "openai";
}
