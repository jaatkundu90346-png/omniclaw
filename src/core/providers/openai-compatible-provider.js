import { buildOmniClawSystemPrompt } from "../system-prompt.js";
import { attachProviderHttpMeta } from "../retry-backoff.js";
import {
  DEFAULT_REASONING_EFFORT,
  reasoningRequestFragment,
  isUnsupportedReasoningError,
} from "../reasoning-effort.js";
import { StreamingThinkScrubber, scrubThinkTags } from "../think-scrubber.js";

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Let an external caller signal (e.g. user cancel) abort the in-flight request
  // too — not just our internal timeout — so we stop burning tokens immediately.
  const external = options.signal;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

function truncateText(value, maxChars = 4000) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

function compactJson(value, maxChars = 4000) {
  return truncateText(JSON.stringify(value || null, null, 2), maxChars);
}

// ── Prompt-cache support ────────────────────────────────────────────────
// Per-model capability matrix (pure — also used for the startup report).
// Anthropic routes take explicit ephemeral breakpoints; OpenAI qualifies
// automatically by stable-prefix length (no markers to send); everything
// else has no documented caching route.
export function describeCacheSupport(model = "", baseUrl = "") {
  const m = String(model || "").toLowerCase();
  const b = String(baseUrl || "").toLowerCase();
  if (b.includes("anthropic") || (b.includes("openrouter") && m.startsWith("anthropic/"))) {
    return { supported: true, mechanism: "cache_control", note: "Anthropic ephemeral breakpoints (up to 4)." };
  }
  if (b.includes("api.openai.com")) {
    return { supported: true, mechanism: "automatic", note: "OpenAI automatic prefix caching (no markers; long stable prefixes qualify)." };
  }
  return { supported: false, mechanism: "none", note: "No documented prompt-caching route for this endpoint." };
}

function isAnthropicCachePassthrough(providerConfig) {
  return describeCacheSupport(
    providerConfig?.provider?.model, providerConfig?.provider?.baseUrl,
  ).mechanism === "cache_control";
}
// Advancing breakpoints: mark the given message indices (Zone A head, then
// the frozen history tail) as ephemeral cache blocks. String content becomes
// a single text block; non-string content is left untouched.
function withZoneBreakpoints(messages, indices = []) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const wanted = new Set(
    (Array.isArray(indices) ? indices : [0])
      .map((i) => Number(i))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < messages.length),
  );
  if (wanted.size === 0) return messages;
  return messages.map((message, index) => {
    if (!wanted.has(index) || !message || typeof message.content !== "string") return message;
    return { ...message, content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }] };
  });
}

// One-time log guard for the clean no-op path below: unknown endpoints must
// never 400 on breakpoint fields and savings must never be faked.
let promptCacheNoopLogged = false;

// NOTE on breakpoint count: the loop sends Zone A head + the frozen history
// tail (advancing as the run grows); the volatile Zone C tail and live tool
// rounds are never marked. Provider-side cap applied at send time.
function resolvePromptCache(input = {}, providerConfig = {}) {
  const requested = input.promptCache === true
    || (input.promptCache && typeof input.promptCache === "object");
  const breakpoints = Array.isArray(input.promptCache?.breakpoints)
    ? input.promptCache.breakpoints.filter((i) => Number.isInteger(Number(i))).slice(0, 4)
    : [0];
  const optIn = providerConfig?.provider?.promptCaching === true;
  const described = describeCacheSupport(providerConfig?.provider?.model, providerConfig?.provider?.baseUrl);
  const supported = optIn && described.supported;
  if (requested && !supported && !promptCacheNoopLogged) {
    promptCacheNoopLogged = true;
    console.log(
      `[provider] prompt caching not supported for model ${providerConfig?.provider?.model || "?"} via ${providerConfig?.provider?.baseUrl || "?"} (needs provider.promptCaching:true plus a caching route: ${described.mechanism}) — sending without breakpoints.`,
    );
  }
  return { requested, supported, mechanism: described.mechanism, applied: requested && supported, breakpoints };
}
// Map provider-reported cache usage (OpenAI prompt_tokens_details /
// Anthropic cache_* fields) into one shape; all null when absent.
function extractCacheInfo(usage = {}) {
  const details = usage?.prompt_tokens_details || {};
  const cached = details.cached_tokens ?? usage?.cache_read_input_tokens ?? null;
  const created = usage?.cache_creation_input_tokens ?? null;
  if (cached == null && created == null) return { cachedInputTokens: 0, cacheWriteTokens: 0, reported: false };
  return {
    cachedInputTokens: Number(cached || 0) || 0,
    cacheWriteTokens: Number(created || 0) || 0,
    reported: true,
  };
}

function pickContextTokens(item = {}) {
  const candidates = [
    item?.context_length,
    item?.context_window,
    item?.max_context_length,
    item?.contextLength,
    item?.contextWindow,
    item?.context_tokens,
    item?.top_provider?.context_length,
    item?.architecture?.context_length,
  ];
  for (const cand of candidates) {
    const n = Number(cand);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function pickMaxTokens(item = {}) {
  const candidates = [
    item?.max_tokens,
    item?.maxTokens,
    item?.top_provider?.max_completion_tokens,
  ];
  for (const cand of candidates) {
    const n = Number(cand);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function normalizeModelList(data) {
  const rawModels = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data?.items)
          ? data.items
          : [];
  return rawModels
    .map((item) => {
      if (typeof item === "string") {
        return { id: item, ownedBy: "" };
      }
      const contextTokens = pickContextTokens(item);
      const maxTokensOut = pickMaxTokens(item);
      return {
        id: item?.id || item?.name || item?.model || "",
        ownedBy: item?.owned_by || item?.ownedBy || item?.provider || "",
        created: item?.created || item?.created_at || null,
        ...(contextTokens > 0 ? { contextTokens } : {}),
        ...(maxTokensOut > 0 ? { maxTokens: maxTokensOut } : {}),
      };
    })
    .filter((item) => item.id);
}

function isLoopbackBaseUrl(baseUrl = "") {
  let host = "";
  try {
    host = new URL(String(baseUrl)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost")
    || /^127\./.test(host);
}

function summarizeToolOutputs(toolOutputs = []) {
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) {
    return "No runtime tools executed.";
  }
  return toolOutputs
    .map((item) => {
      const output = item.output || {};
      if (output.error || output.blocked) {
        return `${item.tool}: ${output.message || output.reason || "failed"}`;
      }
      if (item.tool === "computer_access_status") {
        return `${item.tool}: enabled=${output.enabled}, roots=${(output.allowedRoots || []).join(", ")}, terminal=${output.terminal?.enabled ? "on" : "off"}, browser=${output.browser?.openUrl ? "on" : "off"}`;
      }
      if (item.tool === "run_terminal_command") {
        return `${item.tool}: ${output.command || "command"} -> ${output.status || "unknown"}${output.exitCode == null ? "" : ` exit ${output.exitCode}`}`;
      }
      if (item.tool === "write_computer_file" || item.tool === "delete_computer_path" || item.tool === "open_browser_url") {
        return `${item.tool}: ${truncateText(JSON.stringify(output), 500)}`;
      }
      return `${item.tool}: ok`;
    })
    .join("; ");
}

export class OpenAICompatibleProvider {
  constructor(configStore, secretStore) {
    this.configStore = configStore;
    this.secretStore = secretStore;
    // Set once, the first time this endpoint 400s on the reasoning param, so we
    // stop sending it. Per-provider instance, so switching providers re-tests it.
    this.reasoningUnsupported = false;
  }

  getApiKeyReadiness(config = this.configStore.getConfig()) {
    const apiKeyEnv = config.provider.apiKeyEnv || "OPENAI_API_KEY";
    const apiKeyProviderId = config.provider.apiKeyProviderId || "openai-compatible";
    const envConfigured = Boolean(process.env[apiKeyEnv]);
    const stored = this.secretStore?.getProviderKeyStatus(apiKeyProviderId) || {
      providerId: apiKeyProviderId,
      configured: false,
      masked: "",
    };
    return {
      ready: envConfigured || Boolean(stored.configured),
      apiKeyConfigured: envConfigured || Boolean(stored.configured),
      apiKeySource: envConfigured ? "env" : stored.configured ? "stored" : "missing",
      apiKeyEnv,
      apiKeyProviderId,
      storedKeyConfigured: Boolean(stored.configured),
      storedKeyMasked: stored.masked || "",
      message: envConfigured
        ? `Using ${apiKeyEnv} from the local environment.`
        : stored.configured
          ? `Using stored BYOK key ${stored.masked}.`
          : `Provider key missing for ${apiKeyProviderId}.`,
    };
  }

  getResolvedApiKey(config = this.configStore.getConfig()) {
    return (
      process.env[config.provider.apiKeyEnv] ||
      this.secretStore?.getProviderKey(config.provider.apiKeyProviderId || "openai-compatible") ||
      ""
    );
  }

  getModelsUrl(config = this.configStore.getConfig()) {
    const baseUrl = String(config.provider.baseUrl || "").replace(/\/+$/, "");
    return `${baseUrl}/models`;
  }

  getInfo() {
    const config = this.configStore.getConfig();
    const readiness = this.getApiKeyReadiness(config);
    return {
      id: "openai-compatible",
      mode: "remote",
      baseUrl: config.provider.baseUrl,
      model: config.provider.model,
      apiKeyEnv: config.provider.apiKeyEnv,
      apiKeyProviderId: config.provider.apiKeyProviderId,
      ...readiness,
    };
  }

  getChatCompletionsUrl(config = this.configStore.getConfig()) {
    const baseUrl = String(config.provider.baseUrl || "").replace(/\/+$/, "");
    return `${baseUrl}/chat/completions`;
  }

  // Anthropic's API is not OpenAI-compatible on its auth surface: it
  // authenticates with an `x-api-key` header plus a required `anthropic-version`,
  // not `Authorization: Bearer`. Detect it by host or by the configured provider
  // id so model discovery against api.anthropic.com sends the native headers
  // instead of getting a 401.
  isAnthropicProvider(config = {}) {
    const baseUrl = String(config.provider?.baseUrl || "").toLowerCase();
    const providerId = String(config.provider?.apiKeyProviderId || "").toLowerCase();
    const authStyle = String(config.provider?.authStyle || "").toLowerCase();
    return authStyle === "anthropic" || providerId === "anthropic" || baseUrl.includes("api.anthropic.com");
  }

  getHeaders(config, apiKey) {
    const headers = { "Content-Type": "application/json" };

    if (this.isAnthropicProvider(config)) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = String(config.provider?.anthropicVersion || "2023-06-01");
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    if (config.provider.httpReferer) {
      headers["HTTP-Referer"] = String(config.provider.httpReferer);
    }

    if (config.provider.appTitle) {
      headers["X-OpenRouter-Title"] = String(config.provider.appTitle);
    }

    return headers;
  }

  // 30-line -> 3-line: 4 identical providerConfig merges collapsed into one helper.
  buildProviderConfig(input = {}) {
    const base = this.configStore.getConfig();
    const p = base.provider || {};
    return {
      ...base,
      provider: {
        ...p,
        baseUrl: input.baseUrl || p.baseUrl,
        model: input.model || p.model,
        apiKeyProviderId: input.apiKeyProviderId || p.apiKeyProviderId,
        httpReferer: input.httpReferer || p.httpReferer,
        appTitle: input.appTitle || p.appTitle,
        timeoutMs: input.timeoutMs || p.timeoutMs,
      },
    };
  }

  async parseProviderError(response) {
    const text = await response.text().catch(() => "");
    const trimmed = text.trim().slice(0, 700);
    return trimmed ? `status ${response.status}: ${trimmed}` : `status ${response.status}`;
  }

  async testConnection(input = {}) {
    const providerConfig = this.buildProviderConfig(input);
    const apiKey = this.getResolvedApiKey(providerConfig);

    if (!apiKey) {
      return {
        ok: false,
        endpoint: this.getChatCompletionsUrl(providerConfig),
        model: providerConfig.provider.model,
        error: `API key missing for ${providerConfig.provider.apiKeyProviderId || providerConfig.provider.apiKeyEnv}.`,
      };
    }

    let response;
    try {
      response = await fetchWithTimeout(this.getChatCompletionsUrl(providerConfig), {
        method: "POST",
        headers: this.getHeaders(providerConfig, apiKey),
        body: JSON.stringify({
          model: providerConfig.provider.model,
          temperature: 0,
          max_tokens: 16,
          stream: false,
          messages: [
            {
              role: "user",
              content: input.prompt || "Reply with exactly: ok",
            },
          ],
        }),
      }, Number(providerConfig.provider.timeoutMs || 45000));
    } catch (error) {
      return {
        ok: false,
        endpoint: this.getChatCompletionsUrl(providerConfig),
        model: providerConfig.provider.model,
        error: `request failed: ${error.message}`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        endpoint: this.getChatCompletionsUrl(providerConfig),
        model: providerConfig.provider.model,
        error: await this.parseProviderError(response),
      };
    }

    const data = await response.json();
    return {
      ok: true,
      endpoint: this.getChatCompletionsUrl(providerConfig),
      model: data.model || providerConfig.provider.model,
      responsePreview: String(data.choices?.[0]?.message?.content || "").slice(0, 140),
      usage: data.usage || null,
    };
  }

  async listModels(input = {}) {
    const providerConfig = this.buildProviderConfig(input);
    const apiKey = String(input.apiKey || "").trim() || this.getResolvedApiKey(providerConfig);
    // Keyless local runtimes (Ollama and friends) serve /models with no auth.
    // No secret is involved, so loopback hosts may be listed without a key;
    // every other host keeps the previous key-required behavior.
    const keylessLoopback = !apiKey && isLoopbackBaseUrl(providerConfig.provider.baseUrl);
    if (!apiKey && !keylessLoopback) {
      return {
        ok: false,
        endpoint: this.getModelsUrl(providerConfig),
        models: [],
        error: `API key missing for ${providerConfig.provider.apiKeyProviderId || providerConfig.provider.apiKeyEnv}.`,
      };
    }

    const headers = this.getHeaders(providerConfig, apiKey);
    if (keylessLoopback) {
      delete headers.Authorization;
      delete headers["x-api-key"];
    }
    let response;
    try {
      response = await fetchWithTimeout(this.getModelsUrl(providerConfig), {
        method: "GET",
        headers,
      }, Number(providerConfig.provider.timeoutMs || 45000));
    } catch (error) {
      return {
        ok: false,
        endpoint: this.getModelsUrl(providerConfig),
        models: [],
        error: `request failed: ${error.message}`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        endpoint: this.getModelsUrl(providerConfig),
        models: [],
        error: await this.parseProviderError(response),
      };
    }

    const data = await response.json();
    const models = normalizeModelList(data);
    return {
      ok: true,
      endpoint: this.getModelsUrl(providerConfig),
      models,
      count: models.length,
    };
  }

  async complete(messages = [], input = {}) {
    const providerConfig = this.buildProviderConfig(input);
    const apiKey = String(input.apiKey || "").trim() || this.getResolvedApiKey(providerConfig);
    if (!apiKey) {
      throw new Error(`API key missing for ${providerConfig.provider.apiKeyProviderId || providerConfig.provider.apiKeyEnv}.`);
    }

    let response;
    try {
      response = await fetchWithTimeout(this.getChatCompletionsUrl(providerConfig), {
        method: "POST",
        headers: this.getHeaders(providerConfig, apiKey),
        body: JSON.stringify({
          model: providerConfig.provider.model,
          temperature: Number(input.temperature ?? 0),
          max_tokens: Number(input.maxTokens || providerConfig.provider.plannerMaxTokens || 700),
          stream: false,
          messages: Array.isArray(messages) ? messages : [],
        }),
      }, Number(providerConfig.provider.timeoutMs || 45000));
    } catch (error) {
      throw new Error(`Provider planner request failed: ${error.message}`);
    }

    if (!response.ok) {
      throw attachProviderHttpMeta(new Error(`Provider planner request failed with ${await this.parseProviderError(response)}`), response);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    // Reasoning models can leave content empty with the substance in the
    // reasoning field; fall back so summaries/planner calls are never blank.
    const text = scrubThinkTags(message.content || message.reasoning_content || message.reasoning || "");
    return {
      text,
      model: data.model || providerConfig.provider.model,
      usage: data.usage || null,
      cacheInfo: extractCacheInfo(data.usage || {}),
      raw: data,
    };
  }

  async completeWithTools(messages = [], input = {}) {
    const providerConfig = this.buildProviderConfig(input);
    const apiKey = String(input.apiKey || "").trim() || this.getResolvedApiKey(providerConfig);
    if (!apiKey) {
      throw new Error(`API key missing for ${providerConfig.provider.apiKeyProviderId || providerConfig.provider.apiKeyEnv}.`);
    }

    const tools = Array.isArray(input.tools) ? input.tools : [];
    if (tools.length === 0) {
      return this.complete(messages, input);
    }

    const cache = resolvePromptCache(input, providerConfig);
    // cache_control routes get explicit advancing breakpoints; automatic
    // routes need no markers (stable-prefix ordering already does the work).
    const outboundMessages = (cache.applied && cache.mechanism === "cache_control")
      ? withZoneBreakpoints(messages, cache.breakpoints)
      : messages;

    const streaming = Boolean(input.stream) && typeof input.onDelta === "function";

    // OpenRouter only reports token usage on streamed responses when asked;
    // other OpenAI-compatible servers may reject the param, so gate it.
    const wantsStreamUsage = streaming && /openrouter\.ai/i.test(String(providerConfig.provider.baseUrl || ""));

    // Reasoning/thinking request. The wire SHAPE is provider-dialect specific
    // (`reasoning:{effort}` on OpenRouter, `reasoning_effort` on OpenAI), so
    // reasoningRequestFragment owns both the dialect choice and the shipped
    // default. input.reasoning === false is the "/no-think" sentinel: force it
    // off even if config sets one. Otherwise: per-call override, then config,
    // then the shipped default.
    //
    // `reasoningUnsupported` is the safety net that makes a HIGH default safe:
    // a plain non-reasoning endpoint 400s on an unknown request param, which
    // would otherwise kill every message. When that happens we remember it for
    // the process and stop sending the param, so the user pays one failed
    // request once rather than forever. (Reasoning CAPTURE below works
    // regardless — thinking models stream reasoning without any request flag.)
    // `resolveReasoningEffort` owns the three-state logic (unset -> default,
    // "off" -> nothing, level -> level). It is deliberately NOT `??`-chained
    // here: `x ?? y` treats null as absent, and null means "no preference",
    // which must resolve to the shipped default rather than to "off".
    const configured = input.reasoning !== undefined ? input.reasoning : providerConfig.provider.reasoning;
    // Only the "did the user express a preference?" decision is resolved here.
    // An OBJECT value is deliberately passed through UNRESOLVED: the object form
    // is how a config states its own wire shape (`reasoning:{effort}`), and
    // flattening it to a bare string first would silently rewrite that config
    // into the OpenAI dialect and 400 on a gateway that only accepts the nested
    // shape. normalizeReasoningEffort does that flattening, so it belongs
    // INSIDE reasoningRequestFragment — not on the way to it.
    const reasoningOption = input.reasoning === false
      ? null
      : (configured === undefined || configured === null ? DEFAULT_REASONING_EFFORT : configured);
    const reasoningFragment = this.reasoningUnsupported
      ? null
      : reasoningRequestFragment({ effort: reasoningOption, baseUrl: providerConfig.provider.baseUrl });

    let response;
    // Inner controller so THIS layer can abort the in-flight request on a
    // mid-stream stall, while still honoring the caller's signal (user cancel /
    // round timeout). Linked one-way: caller abort -> inner abort.
    const inner = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) inner.abort(input.signal.reason);
      else input.signal.addEventListener("abort", () => inner.abort(input.signal?.reason), { once: true });
    }
    try {
      response = await fetchWithTimeout(this.getChatCompletionsUrl(providerConfig), {
        method: "POST",
        headers: this.getHeaders(providerConfig, apiKey),
        signal: inner.signal,
        body: JSON.stringify({
          model: providerConfig.provider.model,
          temperature: Number(input.temperature ?? 0),
          max_tokens: Number(input.maxTokens || providerConfig.provider.plannerMaxTokens || 700),
          stream: streaming,
          ...(wantsStreamUsage ? { stream_options: { include_usage: true } } : {}),
          ...(reasoningFragment || {}),
          tool_choice: input.toolChoice || "auto",
          // C5: explicitly ask for parallel tool calls. OpenAI-compatible
          // endpoints that support it return multiple tool_calls in one round;
          // endpoints that don't simply ignore it and return one call (the
          // loop still works — just serially). Per-model support is reported
          // by the loop via maxToolCallsPerRound/parallelToolBatches.
          parallel_tool_calls: input.parallelToolCalls !== false,
          tools,
          messages: Array.isArray(outboundMessages) ? outboundMessages : [],
        }),
      }, Number(input.timeoutMs || providerConfig.provider.timeoutMs || 45000));
    } catch (error) {
      throw new Error(`Provider native tool request failed: ${error.message}`);
    }

    if (!response.ok) {
      const errText = await this.parseProviderError(response);
      // One stripped retry: the endpoint rejected the reasoning PARAMETER (not
      // the request). Without this a shipped "high" default would hard-fail
      // every message on any endpoint that doesn't accept it. We retry once
      // immediately — the caller already treats a thrown error as a dead round,
      // so paying a single round here beats failing the whole conversation.
      if (reasoningFragment && response.status === 400
          && isUnsupportedReasoningError(errText) && !this.reasoningUnsupported) {
        this.reasoningUnsupported = true;
        return this.completeWithTools(input);
      }
      throw attachProviderHttpMeta(new Error(`Provider native tool request failed with ${errText}`), response);
    }

    if (streaming) {
      return this.consumeToolCallStream(response, providerConfig, input.onDelta, input.onReasoning, { stallAbort: inner, cache });
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    // Surfaced so the loop can detect output-token truncation ("length") —
    // a length-cut tool call carries incomplete arguments and must not run.
    const finishReason = String(data.choices?.[0]?.finish_reason || "");
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id || "",
          tool: call.function?.name || call.name || "",
          input: call.function?.arguments || call.arguments || {},
          type: call.type || "function",
        }))
      : [];
    // Reasoning-capable models (DeepSeek-R1/reasoner, OpenRouter :thinking,
    // QwQ, o-series via gateways) return their chain-of-thought in a separate
    // field. Surface it so the loop can show/preserve the model's thinking
    // instead of discarding it. NOTE: never send this back as a request field —
    // it is output-only and some APIs 400 if echoed.
    const reasoning = String(message.reasoning_content || message.reasoning || "");
    // Some models put their chain-of-thought INLINE in content as <think>...</think>
    // (not the separate reasoning field) — strip it so it never leaks into the
    // answer or the transcript echoed back next round.
    const rawContent = typeof message.content === "string" ? message.content : "";
    const cleanedContent = rawContent ? scrubThinkTags(rawContent) : rawContent;
    return {
      text: cleanedContent,
      reasoning,
      toolCalls,
      assistantMessage: rawContent && cleanedContent !== rawContent
        ? { ...message, content: cleanedContent }
        : message,
      model: data.model || providerConfig.provider.model,
      usage: data.usage || null,
      cacheInfo: extractCacheInfo(data.usage || {}),
      cache,
      finishReason,
      raw: data,
      nativeTools: true,
    };
  }

  // Parse a streaming chat-completions response (SSE "data:" lines),
  // forwarding content deltas to onDelta and accumulating tool calls by index.
  // Returns the same shape as the non-streaming completeWithTools path.
  // A stall watchdog aborts the request when NO data arrives for
  // STREAM_IDLE_TIMEOUT_MS — free-tier gateways sometimes go silent mid-stream,
  // and without this the read() would hang until the caller's round timeout.
  async consumeToolCallStream(response, providerConfig, onDelta, onReasoning, options = {}) {
    const STREAM_IDLE_TIMEOUT_MS = 60000;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoning = "";
    let model = providerConfig.provider.model;
    let usage = null;
    let finishReason = "";
    const toolCallsAcc = [];
    // Strip inline <think>...</think> reasoning from the visible content stream,
    // holding back partial tags split across deltas so reasoning never leaks.
    const contentScrubber = new StreamingThinkScrubber();

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        return; // Partial or keep-alive line; ignore.
      }
      if (json.model) model = json.model;
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0] || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      // Reasoning/thinking arrives before content on reasoning models; stream it
      // on its own channel so the UI can show "thinking..." distinctly.
      const reasoningChunk = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningChunk === "string" && reasoningChunk) {
        reasoning += reasoningChunk;
        if (typeof onReasoning === "function") {
          try { onReasoning(reasoningChunk); } catch { /* UI callback must not kill the stream */ }
        }
      }
      if (typeof delta.content === "string" && delta.content) {
        const visible = contentScrubber.feed(delta.content);
        if (visible) {
          text += visible;
          if (typeof onDelta === "function") {
            try { onDelta(visible); } catch { /* UI callback must not kill the stream */ }
          }
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls) {
          const index = Number.isInteger(part.index) ? part.index : 0;
          if (!toolCallsAcc[index]) {
            toolCallsAcc[index] = { id: "", name: "", arguments: "" };
          }
          if (part.id) toolCallsAcc[index].id = part.id;
          if (part.function?.name) toolCallsAcc[index].name = part.function.name;
          if (typeof part.function?.arguments === "string") {
            toolCallsAcc[index].arguments += part.function.arguments;
          }
        }
      }
    };

    try {
      while (true) {
        // Stall watchdog: race each read() against an idle timer. Any chunk
        // (even a keep-alive comment) resets it by re-entering the loop.
        let idleTimer = null;
        let value;
        let done;
        try {
          const idleGuard = new Promise((_, reject) => {
            idleTimer = setTimeout(() => {
              const err = new Error(`Provider stream stalled (idle timeout): ${STREAM_IDLE_TIMEOUT_MS}ms se koi data nahi aaya`);
              options.stallAbort?.abort(err);
              reject(err);
            }, STREAM_IDLE_TIMEOUT_MS);
            idleTimer.unref?.();
          });
          ({ value, done } = await Promise.race([reader.read(), idleGuard]));
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          handleLine(line);
        }
      }
      if (buffer) handleLine(buffer);
      // Flush any held-back partial-tag tail that turned out not to be a tag.
      const tail = contentScrubber.flush();
      if (tail) {
        text += tail;
        if (typeof onDelta === "function") {
          try { onDelta(tail); } catch { /* UI callback must not kill the stream */ }
        }
      }
    } catch (error) {
      throw new Error(`Provider stream read failed: ${error.message}`);
    }

    const toolCalls = toolCallsAcc
      .filter(Boolean)
      .map((call, index) => ({
        id: call.id || `stream_call_${index}`,
        tool: call.name || "",
        input: call.arguments || {},
        type: "function",
      }))
      .filter((call) => call.tool);

    return {
      text,
      reasoning,
      toolCalls,
      assistantMessage: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.tool, arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input) },
              })),
            }
          : {}),
      },
      model,
      usage,
      cacheInfo: extractCacheInfo(usage || {}),
      cache: options.cache || { requested: false, supported: false, applied: false },
      finishReason,
      raw: null,
      nativeTools: true,
      streamed: true,
    };
  }


  async respond(context, retries = 2) {
    const config = this.configStore.getConfig();
    const apiKey = this.getResolvedApiKey(config);
    if (!apiKey) {
      return `OpenAI-compatible provider is configured, but no API key is available from ${config.provider.apiKeyEnv} or stored BYOK provider ${config.provider.apiKeyProviderId}.`;
    }
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let response;
      try {
        response = await fetchWithTimeout(this.getChatCompletionsUrl(config), {
          method: "POST",
          headers: this.getHeaders(config, apiKey),
          body: JSON.stringify({
            model: config.provider.model,
            temperature: config.provider.temperature,
            max_tokens: Number(config.provider.maxTokens || 1600),
            stream: false,
            messages: [
              {
                role: "system",
                content: [config.provider.systemPrompt, "", buildOmniClawSystemPrompt(context)].join("\n"),
              },
              {
                role: "user",
                content: [
                  `User message: ${context.message}`,
                  `Detected intents: ${(context.intents || []).join(", ") || "general"}`,
                  `Agent profile: ${context.profile?.id || "unknown"}`,
                  "",
                  "Workspace identity and operating files:",
                  compactJson(context.contextBundle?.workspaceContext || context.workspaceContext || null, 5000),
                  "",
                  "Active agent:",
                  compactJson(context.contextBundle?.agent || context.agent || null, 1800),
                  "",
                  "Visible skills:",
                  compactJson(context.contextBundle?.skills || context.skills || [], 2500),
                  "",
                  "Visible tools:",
                  compactJson(context.contextBundle?.tools || context.tools || [], 3500),
                  "",
                  "Tool observations:",
                  compactJson(context.contextBundle?.toolOutputs || context.toolOutputs || [], 5000),
                  "Tool observations are ground truth. If a list_files/list_computer_directory observation includes names or containsPackageJson, answer from that evidence instead of guessing from a truncated preview.",
                  "Never claim a tool ran unless its tool id appears in Tool observations. If a tool failed, say it failed. For laptop/local file questions, web_search/web_research cannot prove local files exist or do not exist.",
                  "For web research observations, synthesize from fetchedContent/text/snippets into a clean answer. Do not dump URLs only. Do not mention provider names, raw tool ids, JSON, or internal trace labels.",
                  "For file/shell observations, state exactly what was done and include the read-back/stdout proof. Do not say you can do it later if the observation already proves it ran.",
                  "If observations are weak or failed, say the blocker honestly instead of inventing facts.",
                  "",
                  "Memory/context summary:",
                  compactJson(
                    {
                      contextReport: context.contextBundle?.report || null,
                      contextManifest: context.contextBundle?.contextManifest || null,
                      recentConversations: context.contextBundle?.recentConversations || context.recentConversations,
                      notes: context.contextBundle?.notes || context.notes,
                      longTermMemory: context.contextBundle?.longTermMemory || context.longTermMemory,
                      research: context.contextBundle?.research || context.research,
                      artifacts: context.contextBundle?.artifacts || context.artifacts,
                      tasks: context.contextBundle?.tasks || context.tasks,
                    },
                    5000,
                  ),
                  "",
                  "Write the final human response now in the user's language/style. Keep it concise, grounded, and source-aware.",
                ].join("\n"),
              },
            ],
          }),
        }, Number(config.provider.timeoutMs || 45000));
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return `Provider connection failed: ${error.message}. Tool execution and local memory still completed inside OmniClaw.`;
      }
      if (!response.ok) {
        const errText = await this.parseProviderError(response);
        // Retry on 429 and 5xx
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000 || 2000 * (attempt + 1);
          await new Promise(r => setTimeout(r, retryAfter));
          continue;
        }
        return [
          `Provider request failed with ${errText}.`,
          `Local OmniClaw tool loop still completed.`,
          `Tool summary: ${summarizeToolOutputs(context.contextBundle?.toolOutputs || context.toolOutputs || [])}`,
        ].join(" ");
      }
      const data = await response.json();
      return scrubThinkTags(data.choices?.[0]?.message?.content || "") || "Provider returned an empty response.";
    }
    return `Provider connection failed after ${retries + 1} attempts: ${lastError?.message || "unknown error"}`;
  }}
