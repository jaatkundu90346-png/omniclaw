import { buildOmniClawSystemPrompt } from "../system-prompt.js";

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
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
      return {
        id: item?.id || item?.name || item?.model || "",
        ownedBy: item?.owned_by || item?.ownedBy || item?.provider || "",
        created: item?.created || item?.created_at || null,
      };
    })
    .filter((item) => item.id);
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

  getHeaders(config, apiKey) {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (config.provider.httpReferer) {
      headers["HTTP-Referer"] = String(config.provider.httpReferer);
    }

    if (config.provider.appTitle) {
      headers["X-OpenRouter-Title"] = String(config.provider.appTitle);
    }

    return headers;
  }

  async parseProviderError(response) {
    const text = await response.text().catch(() => "");
    const trimmed = text.trim().slice(0, 700);
    return trimmed ? `status ${response.status}: ${trimmed}` : `status ${response.status}`;
  }

  async testConnection(input = {}) {
    const config = this.configStore.getConfig();
    const providerConfig = {
      ...config,
      provider: {
        ...config.provider,
        baseUrl: input.baseUrl || config.provider.baseUrl,
        model: input.model || config.provider.model,
        apiKeyProviderId: input.apiKeyProviderId || config.provider.apiKeyProviderId,
        httpReferer: input.httpReferer || config.provider.httpReferer,
        appTitle: input.appTitle || config.provider.appTitle,
        timeoutMs: input.timeoutMs || config.provider.timeoutMs,
      },
    };
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
    const config = this.configStore.getConfig();
    const providerConfig = {
      ...config,
      provider: {
        ...config.provider,
        baseUrl: input.baseUrl || config.provider.baseUrl,
        apiKeyProviderId: input.apiKeyProviderId || config.provider.apiKeyProviderId,
        timeoutMs: input.timeoutMs || config.provider.timeoutMs,
      },
    };
    const apiKey = String(input.apiKey || "").trim() || this.getResolvedApiKey(providerConfig);
    if (!apiKey) {
      return {
        ok: false,
        endpoint: this.getModelsUrl(providerConfig),
        models: [],
        error: `API key missing for ${providerConfig.provider.apiKeyProviderId || providerConfig.provider.apiKeyEnv}.`,
      };
    }

    let response;
    try {
      response = await fetchWithTimeout(this.getModelsUrl(providerConfig), {
        method: "GET",
        headers: this.getHeaders(providerConfig, apiKey),
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
    const config = this.configStore.getConfig();
    const providerConfig = {
      ...config,
      provider: {
        ...config.provider,
        baseUrl: input.baseUrl || config.provider.baseUrl,
        model: input.model || config.provider.model,
        apiKeyProviderId: input.apiKeyProviderId || config.provider.apiKeyProviderId,
        httpReferer: input.httpReferer || config.provider.httpReferer,
        appTitle: input.appTitle || config.provider.appTitle,
        timeoutMs: input.timeoutMs || config.provider.timeoutMs,
      },
    };
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
      throw new Error(`Provider planner request failed with ${await this.parseProviderError(response)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    return {
      text,
      model: data.model || providerConfig.provider.model,
      usage: data.usage || null,
      raw: data,
    };
  }

  async completeWithTools(messages = [], input = {}) {
    const config = this.configStore.getConfig();
    const providerConfig = {
      ...config,
      provider: {
        ...config.provider,
        baseUrl: input.baseUrl || config.provider.baseUrl,
        model: input.model || config.provider.model,
        apiKeyProviderId: input.apiKeyProviderId || config.provider.apiKeyProviderId,
        httpReferer: input.httpReferer || config.provider.httpReferer,
        appTitle: input.appTitle || config.provider.appTitle,
        timeoutMs: input.timeoutMs || config.provider.timeoutMs,
      },
    };
    const apiKey = String(input.apiKey || "").trim() || this.getResolvedApiKey(providerConfig);
    if (!apiKey) {
      throw new Error(`API key missing for ${providerConfig.provider.apiKeyProviderId || providerConfig.provider.apiKeyEnv}.`);
    }

    const tools = Array.isArray(input.tools) ? input.tools : [];
    if (tools.length === 0) {
      return this.complete(messages, input);
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
          tool_choice: input.toolChoice || "auto",
          tools,
          messages: Array.isArray(messages) ? messages : [],
        }),
      }, Number(providerConfig.provider.timeoutMs || 45000));
    } catch (error) {
      throw new Error(`Provider native tool request failed: ${error.message}`);
    }

    if (!response.ok) {
      throw new Error(`Provider native tool request failed with ${await this.parseProviderError(response)}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id || "",
          tool: call.function?.name || call.name || "",
          input: call.function?.arguments || call.arguments || {},
          type: call.type || "function",
        }))
      : [];
    return {
      text: message.content || "",
      toolCalls,
      model: data.model || providerConfig.provider.model,
      usage: data.usage || null,
      raw: data,
      nativeTools: true,
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
                  "",
                  "Memory/context summary:",
                  compactJson(
                    {
                      contextReport: context.contextBundle?.report || null,
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
                  "Write the final human response now.",
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
      return data.choices?.[0]?.message?.content || "Provider returned an empty response.";
    }
    return `Provider connection failed after ${retries + 1} attempts: ${lastError?.message || "unknown error"}`;
  }}
