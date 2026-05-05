export const PROVIDER_PRESETS = {
  openai: { providerId: "openai" },
  anthropic: { providerId: "anthropic" },
  gemini: { providerId: "gemini" },
  groq: { providerId: "groq" },
  openrouter: { providerId: "openrouter" },
  "codex-cli": { providerId: "codex-cli" },
  "local-compatible": { providerId: "local-compatible" },
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
