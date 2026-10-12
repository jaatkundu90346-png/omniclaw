// ─── Model Pricing ──────────────────────────────────────────────
// Per-model token pricing in USD per 1,000,000 tokens. Prices change often and
// vary by provider, so treat these as defaults: override exact BYOK rates via
// config (`config.pricing[modelId] = { input, output }`). Unknown models return
// priced:false (cost 0) rather than a fabricated number.

export const DEFAULT_PRICING = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  // Anthropic
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
};

function normalizeOverrides(overrides) {
  const out = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === "object") {
      const input = Number(value.input ?? value.inputPer1M ?? value.in);
      const output = Number(value.output ?? value.outputPer1M ?? value.out);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        out[String(key).toLowerCase()] = { input, output };
      }
    }
  }
  return out;
}

// Match a possibly-prefixed/suffixed/dated model id (e.g. "minimaxai/minimax-m3",
// "openai/gpt-4o-2024-08-06") against the table: exact → bare (no provider
// prefix) → longest-substring match.
export function matchModelPricing(model, overrides = {}) {
  const id = String(model || "").toLowerCase().trim();
  if (!id) return null;
  const table = { ...DEFAULT_PRICING, ...normalizeOverrides(overrides) };
  if (table[id]) return table[id];
  const bare = id.includes("/") ? id.split("/").pop() : id;
  if (table[bare]) return table[bare];
  let best = null;
  let bestLen = 0;
  for (const [key, price] of Object.entries(table)) {
    if ((id.includes(key) || bare.includes(key)) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

export function computeCost(model, usage = {}, overrides = {}) {
  const price = matchModelPricing(model, overrides);
  const promptTokens = Number(usage.promptTokens ?? usage.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completionTokens ?? usage.completion_tokens ?? 0) || 0;
  if (!price) {
    return { costUsd: 0, priced: false, promptTokens, completionTokens, model: String(model || "") };
  }
  const costUsd = (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
  return {
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    priced: true,
    promptTokens,
    completionTokens,
    model: String(model || ""),
  };
}
