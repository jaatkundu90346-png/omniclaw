import { randomUUID } from "node:crypto";

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg) {
  let tokens = estimateTokens(msg.role) + estimateTokens(msg.content || "");
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function?.name || "") + estimateTokens(tc.function?.arguments || "");
    }
  }
  if (msg.tool_call_id) tokens += estimateTokens(msg.tool_call_id);
  return tokens;
}

function buildToolDefinitions(tools) {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.id,
      description: t.description || "",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  }));
}

function executeToolCall(toolName, toolArgs, toolRegistry) {
  if (!toolRegistry) return { error: "Tool registry unavailable." };
  const allTools = toolRegistry.getAll({});
  const tool = allTools.find((t) => t.id === toolName);
  if (!tool) return { error: `Tool "${toolName}" not found.` };
  try {
    return tool.run(typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs, {});
  } catch (error) {
    return { error: error.message };
  }
}

async function runChatCompletion(messages, model, tools, toolChoice, stream, agent) {
  const provider = agent?.provider;
  if (!provider) {
    throw new Error("No provider available for chat completions.");
  }

  const maxToolRounds = 10;
  let round = 0;
  const responseMessages = [...messages];
  const toolCalls = [];

  while (round < maxToolRounds) {
    const providerTools = tools && tools.length > 0 ? buildToolDefinitions(tools) : [];
    const response = await provider.chat(responseMessages, { model, tools: providerTools });

    const assistantMsg = {
      role: "assistant",
      content: response.content || "",
    };

    if (response.toolCalls && response.toolCalls.length > 0) {
      assistantMsg.tool_calls = response.toolCalls.map((tc) => ({
        id: tc.id || `call_${randomUUID()}`,
        type: "function",
        function: {
          name: tc.function?.name || tc.name || "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      }));
    }

    responseMessages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return {
        role: "assistant",
        content: assistantMsg.content,
        tool_calls: null,
      };
    }

    // Execute tool calls
    for (const tc of assistantMsg.tool_calls) {
      const toolName = tc.function.name;
      const toolArgs = tc.function.arguments;
      const result = await executeToolCall(toolName, toolArgs, agent?.tools);
      const toolMsg = {
        role: "tool",
        content: typeof result === "string" ? result : JSON.stringify(result),
        tool_call_id: tc.id,
      };
      responseMessages.push(toolMsg);
      toolCalls.push({ name: toolName, args: toolArgs, result });
    }

    round++;
  }

  return {
    role: "assistant",
    content: responseMessages[responseMessages.length - 1]?.content || "Max tool rounds reached.",
    tool_calls: null,
  };
}

function formatCompletionResponse(id, model, message, promptTokens, completionTokens) {
  const response = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: message.role,
          content: message.content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };

  if (message.tool_calls) {
    response.choices[0].message.tool_calls = message.tool_calls;
    response.choices[0].finish_reason = "tool_calls";
  }

  return response;
}

async function* streamCompletion(id, model, message, promptTokens) {
  const content = message.content || "";
  const chunks = content.split(/(\s+)/);
  let accumulated = "";

  yield `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`;

  for (const chunk of chunks) {
    accumulated += chunk;
    yield `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    })}\n\n`;
    await new Promise((r) => setTimeout(r, 10));
  }

  const completionTokens = estimateTokens(accumulated);
  yield `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`;

  yield "data: [DONE]\n\n";
}

export class OpenAICompatibleAPI {
  constructor(agent) {
    this.agent = agent;
  }

  async handleRequest(req, res, url, pathname) {
    // GET /v1/models
    if (req.method === "GET" && pathname === "/v1/models") {
      return this.listModels(res);
    }

    // GET /v1/models/:modelId
    if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
      const modelId = pathname.slice("/v1/models/".length);
      return this.getModel(res, modelId);
    }

    // POST /v1/chat/completions
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      return this.chatCompletions(req, res);
    }

    // POST /v1/completions (legacy)
    if (req.method === "POST" && pathname === "/v1/completions") {
      return this.legacyCompletions(req, res);
    }

    return null;
  }

  async listModels(res) {
    const providerInfo = this.agent?.getProviderInfo?.() || {};
    const models = [
      {
        id: providerInfo.model || "omniclaw-default",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: providerInfo.id || "omniclaw",
        ready: Boolean(providerInfo.ready),
      },
      {
        id: "omniclaw-local",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "omniclaw",
        ready: true,
      },
    ];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models }));
  }

  async getModel(res, modelId) {
    const providerInfo = this.agent?.getProviderInfo?.() || {};
    const model = {
      id: modelId,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: providerInfo.id || "omniclaw",
      ready: Boolean(providerInfo.ready),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(model));
  }

  async chatCompletions(req, res) {
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body.", type: "invalid_request_error" } }));
      return;
    }

    const { messages, model, tools, tool_choice, stream, max_tokens, temperature, top_p } = body;

    if (!messages || !Array.isArray(messages)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "'messages' is required and must be an array.", type: "invalid_request_error" } }));
      return;
    }

    const providerInfo = this.agent?.getProviderInfo?.() || {};
    const resolvedModel = model || providerInfo.model || "omniclaw-default";
    const isStream = stream === true;

    try {
      const promptTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
      const completion = await runChatCompletion(messages, resolvedModel, tools || [], tool_choice, isStream, this.agent);
      const completionTokens = estimateTokens(completion.content || "");
      const id = `chatcmpl-${randomUUID()}`;

      if (isStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const streamGen = streamCompletion(id, resolvedModel, completion, promptTokens);
        for await (const chunk of streamGen) {
          res.write(chunk);
        }
        res.end();
      } else {
        const response = formatCompletionResponse(id, resolvedModel, completion, promptTokens, completionTokens);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      }
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: error.message || "Internal server error.",
          type: "server_error",
          code: "completion_failed",
        },
      }));
    }
  }

  async legacyCompletions(req, res) {
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body." }));
      return;
    }

    const { prompt, model, max_tokens, temperature, stream } = body;

    if (!prompt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "'prompt' is required." }));
      return;
    }

    const messages = [{ role: "user", content: String(prompt) }];
    const providerInfo = this.agent?.getProviderInfo?.() || {};
    const resolvedModel = model || providerInfo.model || "omniclaw-default";

    try {
      const completion = await runChatCompletion(messages, resolvedModel, [], null, false, this.agent);
      const id = `cmpl-${randomUUID()}`;
      const promptTokens = estimateTokens(prompt);
      const completionTokens = estimateTokens(completion.content || "");

      const response = {
        id,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: resolvedModel,
        choices: [
          {
            text: completion.content || "",
            index: 0,
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }
}
