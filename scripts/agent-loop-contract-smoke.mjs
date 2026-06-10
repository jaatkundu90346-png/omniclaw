import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";
import { AgentLoopController, getAgentLoopSettings } from "../src/core/agent-loop-controller.js";
import { scoreSearchResult } from "../src/core/web-research.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-agent-loop-"));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
for (const dir of ["config", "workspace", "plugins"]) {
  const source = path.join(repoRoot, dir);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(rootDir, dir), { recursive: true, force: true });
  }
}

const agent = new OmniClawAgent({ rootDir });
agent.provider = {
  getInfo: () => ({ id: "test-provider", ready: true }),
  complete: async () => ({ text: "{\"toolCalls\":[],\"finalReady\":true}" }),
};

const failedOutputs = [
  {
    tool: "web_fetch",
    output: { error: true, message: "network failed" },
    toolSummary: { status: "failed", summary: "Fetch failed" },
  },
];

assert(agent.countFailedToolObservations(failedOutputs) === 1, "Failed tool observations should be counted.");
assert(
  agent.countFailedToolObservations([{ tool: "verify_html_artifact", output: { ok: false, issues: ["script"] } }]) === 1,
  "Failed verification observations should be counted even when they are not thrown errors.",
);
assert(
  agent.shouldRunModelToolLoop({
    forcedResponse: "",
    runtimeToolReply: "Tool failed.",
    profile: { allowToolExecution: true },
    toolOutputs: failedOutputs,
    intents: ["research"],
  }) === true,
  "A failed tool observation should trigger the model tool loop even when a runtime reply exists.",
);

const prompt = agent.buildModelToolLoopPrompt({
  message: "build and test a small app",
  intents: ["project-build"],
  tools: [
    { id: "read_file", description: "Read a file" },
    { id: "write_file", description: "Write a file" },
    { id: "run_terminal_command", description: "Run a command" },
  ],
  toolOutputs: failedOutputs,
  round: 1,
});

assert(prompt.includes("Self-correction rule"), "Model tool loop prompt should include self-correction rule.");
assert(prompt.includes("Review cycle rule"), "Model tool loop prompt should include review-cycle rule.");
assert(prompt.includes("verify/build/test"), "Model tool loop prompt should require verification.");
assert(prompt.includes("do not repeat the same web_search"), "Model tool loop prompt should forbid repeated same web search.");

const settings = agent.getModelToolLoopSettings();
assert(settings.maxRounds >= 2 && settings.maxRounds <= 100, "Model tool loop should have a bounded max round setting.");
assert(settings.maxToolCallsPerRound >= 1, "Model tool loop should have a per-round tool-call budget.");

const agentLoopSettings = getAgentLoopSettings({ runtime: { agentLoop: { maxSteps: 50, maxToolCallsPerStep: 5 } } });
assert(agentLoopSettings.maxSteps === 50, "AgentLoopController should expose the V2 default maxSteps contract.");
assert(agentLoopSettings.maxToolCallsPerStep === 5, "AgentLoopController should expose maxToolCallsPerStep.");

const emittedEvents = [];
const controller = new AgentLoopController({
  config: { runtime: { agentLoop: { maxSteps: 1, maxToolCallsPerStep: 5, maxRepeatedToolCalls: 1 } } },
  gateway: { addEvent: (event, payload) => emittedEvents.push({ event, payload }) },
  run: { id: "run_test" },
  session: { id: "session_test" },
  agent: { id: "main" },
  source: "test-loop",
});
assert(controller.startStep({ phase: "test" }) === true, "First controller step should run.");
assert(controller.startStep({ phase: "test" }) === false, "Controller should stop at maxSteps.");
controller.toolStarted({ tool: "read_file", input: { path: "README.md" }, reason: "test" });
controller.toolOutput({ tool: "read_file" }, { content: "hello" });
controller.toolCompleted({ tool: "read_file" }, { ok: true });
controller.done({ stopReason: "final", finalMetadata: { toolCallCount: 1 } });
assert(emittedEvents.some((item) => item.event === "agent.thinking"), "Controller should emit agent.thinking.");
assert(emittedEvents.some((item) => item.event === "tool.output"), "Controller should emit tool.output.");
assert(emittedEvents.some((item) => item.event === "agent.done"), "Controller should emit agent.done.");
assert(controller.getReport().stopReason === "final", "Controller report should expose stop reason.");

const nativeToolResult = agent.buildNativeToolResultMessage(
  { id: "call_read_1", tool: "read_file" },
  { path: "README.md", content: "hello" },
);
assert(nativeToolResult.role === "tool", "Native tool results should use the chat-completions tool role.");
assert(nativeToolResult.tool_call_id === "call_read_1", "Native tool results should preserve tool_call_id.");
assert(nativeToolResult.name === "read_file", "Native tool results should preserve tool name.");
assert(nativeToolResult.content.includes("README.md"), "Native tool result content should include serialized output.");

const metadata = agent.buildFinalMetadata({
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:02.000Z",
  profile: { id: "power" },
  provider: { id: "test-provider", model: "test-model" },
  modelToolLoop: {
    rounds: 2,
    stoppedReason: "completed",
    autoVerificationCount: 1,
    autoRepairAttempted: true,
    autoRepairReport: { toolCallCount: 2 },
  },
  toolOutputs: [
    { tool: "write_file", output: { path: "demo.html" } },
    { tool: "verify_html_artifact", output: { ok: true, issues: [] } },
  ],
  approvals: [],
});
assert(metadata.autoVerificationCount === 1, "Final metadata should include auto-verification count.");
assert(metadata.autoRepairAttempted === true, "Final metadata should include repair attempt state.");
assert(metadata.autoRepairToolCallCount === 2, "Final metadata should include repair tool call count.");
assert(metadata.verificationPassed === true, "Final metadata should expose verification pass state.");

const htmlVerificationPlan = agent.planAutoVerificationCalls([
  {
    tool: "write_file",
    input: { path: "workspace-app/index.html" },
    output: { path: "workspace-app/index.html", bytesWritten: 2200 },
  },
]);
assert(htmlVerificationPlan.length >= 1, "HTML writes should schedule automatic verification.");
assert(htmlVerificationPlan[0].tool === "verify_html_artifact", "HTML writes should be verified with verify_html_artifact.");
assert(
  htmlVerificationPlan.some((call) => call.tool === "browser_automate"),
  "HTML writes should schedule browser proof when browser tools are available.",
);

const alreadyVerifiedPlan = agent.planAutoVerificationCalls([
  {
    tool: "write_file",
    input: { path: "notes.txt" },
    output: { path: "notes.txt", bytesWritten: 20 },
  },
  {
    tool: "read_file",
    input: { path: "notes.txt" },
    output: { path: "notes.txt", content: "ok" },
  },
]);
assert(alreadyVerifiedPlan.length === 0, "A later read/verify should satisfy automatic verification.");

const readBeforeWritePlan = agent.planAutoVerificationCalls([
  {
    tool: "read_file",
    input: { path: "notes-later.txt" },
    output: { path: "notes-later.txt", content: "old" },
  },
  {
    tool: "write_file",
    input: { path: "notes-later.txt" },
    output: { path: "notes-later.txt", bytesWritten: 20 },
  },
]);
assert(readBeforeWritePlan.length === 1, "A read before a write should not count as post-write verification.");

const webSearchKeyA = agent.buildToolCallKey({
  tool: "web_search",
  input: { query: "  Manus AI Architecture  " },
});
const webSearchKeyB = agent.buildToolCallKey({
  tool: "web_search",
  input: { q: "manus ai   architecture" },
});
assert(webSearchKeyA === webSearchKeyB, "Equivalent web search queries should share one repeat key.");
assert(agent.getToolRepeatLimit("web_search", { maxRepeatedToolCalls: 3 }) === 1, "web_search should be one-shot per query.");

const repairedEmptySearch = agent.repairModelLoopToolCall({
  call: { tool: "web_research", input: { query: "" } },
  message: "kimi ai ka bara ma reaserach karo",
});
assert(repairedEmptySearch.repaired === true, "Empty model web_research query should be repaired from the user message.");
assert(repairedEmptySearch.call.input.query === "kimi ai", "Repaired research query should preserve the actual topic.");

const complexHarnessQuery = agent.extractResearchQueryForToolRecovery([
  "Bhai OmniClaw, real complex task karo:",
  "1. Web research karo: NVIDIA agent harness / agent = LLM + harness architecture ke latest public info ko samjho. Search/fetch karo, sirf URL list mat dena.",
  "2. Apne words me 8-12 bullet summary banao: agent harness kya hota hai, context/observe/reason/act loop ka role kya hai, tools/memory/security ka role kya hai, aur OmniClaw ke liye kya lessons hain.",
  "3. Is summary ko file me write karo: data/generated/omniclaw-real-user-task.md",
].join("\n"));
assert(
  /NVIDIA agent harness/i.test(complexHarnessQuery) && !/^act loop ka role$/i.test(complexHarnessQuery),
  "Complex research+write prompts should preserve the main research topic instead of a later explanatory sub-question.",
);

let synthesisMessages = null;
const originalProviderForSynthesis = agent.provider;
const synthesisToolOutputs = [
  {
    tool: "web_research",
    input: { query: "Kimi AI" },
    output: { query: "Kimi AI", results: [{ title: "Kimi", url: "https://example.test/kimi", snippet: "Kimi is an AI assistant." }] },
    toolSummary: { status: "completed", summary: "Found Kimi research observations." },
  },
];
agent.provider = {
  getInfo: () => ({ id: "synthesis-test-provider", ready: true, model: "test-model" }),
  complete: async (messages) => {
    synthesisMessages = messages;
    return { text: "Kimi is an AI assistant from Moonshot AI, synthesized from the collected observations.", model: "test-model" };
  },
};
const synthesis = await agent.synthesizeFinalWithProvider({
  message: "research Kimi AI",
  intents: ["research"],
  agent: { id: "main" },
  profile: {},
  contextBundle: {},
  session: { id: "session_synthesis" },
  run: { id: "run_synthesis" },
  toolOutputs: synthesisToolOutputs,
});
agent.provider = originalProviderForSynthesis;
assert(synthesis.reply.includes("Moonshot AI"), "Provider final synthesis should return the LLM-written answer.");
assert(synthesis.providerDiagnostics.reason === "final-synthesis", "Provider synthesis should be recorded as final-synthesis.");
assert(JSON.stringify(synthesisMessages).includes("web_research"), "Provider synthesis must receive tool observations.");
assert(
  agent.buildGroundedSynthesisFallback({ response: "", intents: ["research"], toolOutputs: synthesisToolOutputs, providerDiagnostics: { ok: false } }) === "",
  "Failed provider synthesis must not be replaced by local fallback.",
);

let repeatedSearchProviderCalls = 0;
let repeatedSearchToolRuns = 0;
const originalProvider = agent.provider;
const originalToolRun = agent.tools.run.bind(agent.tools);
agent.provider = {
  getInfo: () => ({ id: "repeat-test-provider", ready: true }),
  complete: async () => {
    repeatedSearchProviderCalls += 1;
    return {
      text: JSON.stringify({
        thought: "I should search the same thing again.",
        toolCalls: [
          {
            tool: "web_search",
            input: { query: "Manus AI architecture" },
            reason: "research",
          },
        ],
      }),
    };
  },
};
agent.tools.run = async (tool, input) => {
  if (tool === "web_search") {
    repeatedSearchToolRuns += 1;
    return {
      ok: true,
      query: input.query,
      results: [
        {
          title: "Manus AI",
          url: "https://example.test/manus",
          snippet: "Test result.",
        },
      ],
    };
  }
  return originalToolRun(tool, input, {});
};
const repeatLoop = await agent.runModelToolLoop({
  message: "research Manus AI architecture",
  intents: ["research"],
  profile: { allowToolExecution: true },
  agent: { id: "main" },
  tools: [{ id: "web_search", description: "Search the web" }, { id: "web_fetch", description: "Fetch a page" }],
  toolOutputs: [],
  forcedResponse: "",
  session: { id: "session_repeat_guard" },
  run: { id: "run_repeat_guard" },
});
agent.provider = originalProvider;
agent.tools.run = originalToolRun;
assert(repeatedSearchProviderCalls >= 2, "Repeat-guard test should make the provider ask twice.");
assert(repeatedSearchToolRuns === 1, "Repeated identical web_search calls should only execute once.");
assert(repeatLoop.report.repeatedToolCallsSkipped >= 1, "Repeated identical web_search should be skipped and counted.");
assert(
  repeatLoop.toolOutputs.some((item) => item.output?.reason === "repeat-call-used-cached-result"),
  "Repeated identical successful web_search should reuse cached observation instead of returning a blocked observation.",
);
assert(
  repeatLoop.report.repeatedToolCallsSkipped >= 1,
  "Loop should record the repeated search without rerunning it.",
);
assert(repeatLoop.report.rounds <= 2, "Repeated cached search should stop early instead of looping through max rounds.");
assert(repeatLoop.report.stoppedReason === "cached-repeat-no-progress", "Cached-only repeated tool round should be treated as no progress.");

let priorSearchToolRuns = 0;
agent.provider = {
  getInfo: () => ({ id: "prior-repeat-test-provider", ready: true }),
  complete: async () => ({
    text: JSON.stringify({
      thought: "I will search with the exact same query that already exists in observations.",
      toolCalls: [
        {
          tool: "web_search",
          input: { query: "Manus AI architecture" },
          reason: "research",
        },
      ],
    }),
  }),
};
agent.tools.run = async (tool, input) => {
  if (tool === "web_search") {
    priorSearchToolRuns += 1;
    return { ok: true, query: input.query, results: [] };
  }
  return originalToolRun(tool, input, {});
};
const priorRepeatLoop = await agent.runModelToolLoop({
  message: "research Manus AI architecture",
  intents: ["complex-build"],
  profile: { allowToolExecution: true },
  agent: { id: "main" },
  tools: [{ id: "web_search", description: "Search the web" }, { id: "web_fetch", description: "Fetch a page" }],
  toolOutputs: [
    {
      tool: "web_search",
      input: { query: "Manus AI architecture" },
      output: { ok: true, query: "Manus AI architecture", results: [{ url: "https://example.test/manus" }] },
    },
  ],
  forcedResponse: "",
  session: { id: "session_prior_repeat_guard" },
  run: { id: "run_prior_repeat_guard" },
});
agent.provider = originalProvider;
agent.tools.run = originalToolRun;
assert(priorSearchToolRuns === 0, "A web_search already present in prior observations should not execute again.");
assert(
  priorRepeatLoop.report.repeatedToolCallsSkipped >= 1,
  "Prior web_search observations should seed the repeat budget for the model loop.",
);
assert(priorRepeatLoop.report.rounds <= 1, "Prior cached repeat should stop immediately instead of making many provider calls.");
assert(priorRepeatLoop.report.stoppedReason === "cached-repeat-no-progress", "Prior cached repeat should stop as no progress.");

let parallelActive = 0;
let parallelPeak = 0;
let parallelToolRuns = 0;
agent.provider = {
  getInfo: () => ({ id: "parallel-test-provider", ready: true }),
  complete: async () => ({
    text: JSON.stringify({
      toolCalls: [
        { tool: "read_file", input: { path: "AGENTS.md" }, reason: "inspect agent guidance" },
        { tool: "list_files", input: { path: "." }, reason: "inspect workspace files" },
      ],
    }),
  }),
};
agent.tools.run = async (tool, input) => {
  if (tool === "read_file" || tool === "list_files") {
    parallelToolRuns += 1;
    parallelActive += 1;
    parallelPeak = Math.max(parallelPeak, parallelActive);
    await new Promise((resolve) => setTimeout(resolve, 25));
    parallelActive -= 1;
    return { ok: true, tool, input, content: tool === "read_file" ? "agent guidance" : undefined, entries: [] };
  }
  return originalToolRun(tool, input, {});
};
const parallelLoop = await agent.runModelToolLoop({
  message: "inspect workspace guidance and files",
  intents: ["complex-build"],
  profile: { allowToolExecution: true },
  agent: { id: "main" },
  tools: [{ id: "read_file", description: "Read file" }, { id: "list_files", description: "List files" }],
  toolOutputs: [],
  forcedResponse: "",
  session: { id: "session_parallel_tools" },
  run: { id: "run_parallel_tools" },
});
agent.provider = originalProvider;
agent.tools.run = originalToolRun;
assert(parallelToolRuns === 2, "Model loop should execute multiple requested tools in one round.");
assert(parallelPeak >= 2, "Read-only model-loop tools should run in parallel batches.");
assert(parallelLoop.report.roundDetails.some((round) => round.parallelCallCount >= 2), "Round report should expose parallel tool count.");

assert(
  agent.parseModelToolLoopResponse("Main research kar raha hoon...", new Set(["web_research"]), 3).reason.startsWith("invalid-json"),
  "Natural-language tool claims should be invalid model-loop output, not real tool calls.",
);

const strictToolCall = agent.parseModelToolLoopResponse(
  JSON.stringify({ type: "tool_call", tool: "web_research", args: { query: "PicoClaw AI" } }),
  new Set(["web_research"]),
  3,
);
assert(strictToolCall.calls.length === 1 && strictToolCall.calls[0].tool === "web_research", "Strict type=tool_call JSON should parse.");

const strictFinal = agent.parseModelToolLoopResponse(
  JSON.stringify({ type: "final_answer", answer: "Done" }),
  new Set(["web_research"]),
  3,
);
assert(strictFinal.finalReady === true && strictFinal.calls.length === 0, "Strict type=final_answer JSON should finish without tools.");

const groundedResearchReply = agent.buildToolExecutionReply({
  toolOutputs: [
    {
      tool: "web_research",
      input: { query: "" },
      output: {
        error: true,
        blocked: true,
        message: "Tool input schema validation failed.",
      },
      toolSummary: { status: "blocked", summary: "Tool input schema validation failed." },
    },
    {
      tool: "web_search",
      input: { query: "Kimi AI Moonshot" },
      output: {
        query: "Kimi AI Moonshot",
        provider: "tinyfish-search",
        results: [
          {
            title: "Moonshot AI",
            url: "https://www.moonshot.ai/",
            snippet: "Moonshot AI is the company behind Kimi.",
            source: "TinyFish Search",
          },
          {
            title: "Kimi AI",
            url: "https://www.kimi.com/",
            snippet: "Kimi is an AI assistant and agent product by Moonshot AI. New Chat Slides Websites Docs Deep Research Sheets Agent Swarm Kimi Code Chat History Get App.",
            source: "TinyFish Search",
          },
        ],
        fetchedContent: [
          {
            url: "https://www.kimi.com/",
            provider: "tinyfish-fetch",
            text: "Kimi is an AI assistant from Moonshot AI. It can answer questions, browse, and help with documents.",
            totalChars: 96,
          },
          {
            url: "https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart",
            provider: "tinyfish-fetch",
            text: "Example Usage Here is a complete usage example to help you quickly get started with the Kimi K2.6 model. Install the OpenAI SDK. Verify the Installation. Kimi K2.6 is Kimi's latest and most intelligent model, with stronger long-term code writing, instruction compliance, self-correction, multimodal input, and agent task support.",
            totalChars: 320,
          },
        ],
        contentFetched: true,
      },
    },
  ],
});
assert(!/^Tool run complete\b/i.test(groundedResearchReply), "Research final answer should not be a generic tool status.");
assert(!/^Actual result\b/i.test(groundedResearchReply), "Research final answer should not be a raw trace dump when a later research call succeeded.");
assert(groundedResearchReply.includes("Kimi") && groundedResearchReply.includes("Moonshot"), "Research final answer should synthesize search/fetch evidence.");
assert(groundedResearchReply.includes("Sources"), "Research final answer should include source references.");
assert(
  !/Short answer:\s*Example Usage|complete usage example|Install the OpenAI SDK/i.test(groundedResearchReply),
  "Research final answer should not promote docs quickstart boilerplate as the short answer.",
);
assert(
  !/New Chat|Chat History|Get App|Slides Websites Docs/i.test(groundedResearchReply),
  "Research final answer should not include navigation/menu blobs.",
);
assert(
  !groundedResearchReply.includes("- Kimi is an AI assistant and agent product by Moonshot AI."),
  "Research final answer should synthesize/paraphrase facts instead of copying raw snippets.",
);
assert(
  !/\b(provider\s+tinyfish|tinyfish-search|Top\s+\d+\s+page|page\/snippet fetch|web_research|Tool run complete)\b/i.test(groundedResearchReply),
  "Research final answer should not leak provider/tool/debug metadata.",
);

const groundedFetchReply = agent.buildToolExecutionReply({
  toolOutputs: [
    {
      tool: "web_fetch",
      input: { url: "https://example.test/kimi" },
      output: {
        url: "https://example.test/kimi",
        finalUrl: "https://example.test/kimi",
        provider: "tinyfish-fetch",
        title: "Kimi overview",
        text: "Kimi is a Moonshot AI assistant. This fetched page gives enough content for a real final answer.",
        totalChars: 92,
      },
    },
  ],
});
assert(!/^Tool run complete\b/i.test(groundedFetchReply), "Direct web_fetch final answer should not be a generic tool status.");
assert(groundedFetchReply.includes("Kimi") && groundedFetchReply.includes("Sources"), "Direct web_fetch should produce a grounded final answer.");
assert(!/\bfetched page\(s\)|tinyfish-fetch|provider\b/i.test(groundedFetchReply), "Direct web_fetch final answer should hide fetch/provider internals.");

const fileDriftFallback = agent.buildGroundedSynthesisFallback({
  response: "Sure, I can create that file for you.",
  intents: ["file-write"],
  providerDiagnostics: { ok: true },
  toolOutputs: [
    {
      tool: "write_file",
      output: { path: "demo.txt", bytesWritten: 5 },
      toolSummary: { status: "completed", summary: "Wrote 5 byte(s) to demo.txt." },
    },
    {
      tool: "read_file",
      output: { path: "demo.txt", content: "hello", bytesRead: 5, totalBytes: 5 },
      toolSummary: { status: "completed", summary: "Read demo.txt: hello" },
    },
  ],
});
assert(fileDriftFallback === "", "Provider future-tense drift must not be replaced by a local final answer.");

const picoClawReply = agent.buildToolExecutionReply({
  toolOutputs: [
    {
      tool: "web_search",
      input: { query: "PicoClaw AI" },
      output: {
        query: "PicoClaw AI",
        provider: "bing-rss",
        results: [
          {
            title: "PicoClaw",
            url: "https://picoclaw.ai",
            snippet: "PicoClaw is an ultra-efficient AI assistant.",
            source: "Bing RSS",
          },
          {
            title: "Introduction | PicoClaw",
            url: "https://docs.picoclaw.io/docs",
            snippet: "PicoClaw documentation explains setup, tools, and agent behavior.",
            source: "Bing RSS",
          },
        ],
        fetchedContent: [
          {
            url: "https://picoclaw.ai",
            provider: "http-fetch",
            text: "PicoClaw is an ultra-efficient AI assistant focused on lightweight local agent workflows.",
            totalChars: 91,
          },
        ],
        contentFetched: true,
      },
    },
  ],
});
assert(!picoClawReply.includes("OpenClaw - Research Overview"), "PicoClaw research must not use the OpenClaw hardcoded template.");
assert(picoClawReply.includes("PicoClaw"), "PicoClaw research should synthesize the requested entity.");
assert(
  !/\b(provider\s+bing|bing-rss|http-fetch|Top\s+\d+\s+page|page\/snippet fetch|web_research|Tool run complete)\b/i.test(picoClawReply),
  "PicoClaw research should not leak internal research/debug metadata.",
);

const noisyPicoClawReply = agent.buildToolExecutionReply({
  toolOutputs: [
    {
      tool: "web_search",
      input: { query: "PicoClaw AI" },
      output: {
        query: "PicoClaw AI",
        provider: "tinyfish-search",
        results: [
          {
            title: "PicoClaw",
            url: "https://picoclaw.ai",
            snippet: "PicoClaw is a lightweight local AI agent project.",
            source: "TinyFish Search",
          },
        ],
        fetchedContent: [
          {
            url: "https://picoclaw.ai",
            provider: "tinyfish-fetch",
            text: "ä¸­æ–‡ | æ—¥æœ¬èªž | í•œêµ­ì–´ | English Subscribe Sign in PicoClaw is a lightweight local AI agent project for automation. provider tinyfish-search Top 3 page(s) fetched Security note: users should protect API tokens and credentials.",
            totalChars: 220,
          },
        ],
        contentFetched: true,
      },
    },
  ],
});
assert(noisyPicoClawReply.includes("PicoClaw"), "Noisy fetched content should still produce a useful PicoClaw answer.");
assert(
  !/(provider tinyfish|Top\s+\d+\s+page|tinyfish-fetch|TinyFish Search)/i.test(noisyPicoClawReply) &&
    !noisyPicoClawReply.includes("中文") &&
    !noisyPicoClawReply.includes("日本語") &&
    !noisyPicoClawReply.includes("한국어") &&
    agent.validateCleanResearchAnswer(noisyPicoClawReply).ok,
  "Cleaner should remove language selector and provider/debug metadata from final answer.",
);

const repairedReport = agent.buildRequiredReportContent({
  message: [
    "Web research karo: NVIDIA agent harness / agent = LLM + harness architecture ke latest public info ko samjho.",
    "Is summary ko file me write karo: data/generated/omniclaw-real-user-task.md",
    "File ko read/verify karo, terminal ya file-read se confirm karo ki file exists aur heading \"OmniClaw Real User Task\" hai.",
  ].join("\n"),
  toolOutputs: [
    {
      tool: "web_research",
      input: { query: "act loop ka role" },
      output: {
        query: "act loop ka role",
        results: [
          { title: "Act! Documentation", url: "https://www.act.com/resources/documentation", snippet: "CRM documentation." },
        ],
      },
    },
    {
      tool: "web_research",
      input: { query: "NVIDIA agent harness LLM + harness architecture latest public info" },
      output: {
        query: "NVIDIA agent harness LLM + harness architecture latest public info",
        results: [
          {
            title: "Agent Harness",
            url: "https://nvidia.github.io/elements/docs/internal/guidelines/agent-harness",
            snippet: "An agent harness wraps a raw LLM model and makes it useful for sustained autonomous work.",
          },
          {
            title: "Add a Specialized Deep Research Skill to Agent Harnesses",
            url: "https://developer.nvidia.com/blog/add-a-specialized-deep-research-skill-to-agent-harnesses",
            snippet: "NVIDIA AI-Q packages research as a portable agent skill exposed to agent harnesses.",
          },
        ],
        fetchedContent: [
          {
            url: "https://nvidia.github.io/elements/docs/internal/guidelines/agent-harness",
            text: "An agent harness is the complete system that wraps a raw LLM model and makes it useful for sustained, autonomous work. The model itself only generates text; the harness provides tools, memory, context, permissions, constraints, and feedback loops.",
          },
        ],
      },
    },
  ],
});
assert(repairedReport.startsWith("# OmniClaw Real User Task"), "Required file repair should preserve the user-requested heading.");
assert(repairedReport.includes("NVIDIA") && repairedReport.includes("agent harness"), "Required file repair should use the latest relevant research observation.");
assert(!repairedReport.includes("Act! Documentation"), "Required file repair should not write from the first irrelevant research observation.");

const officialSourceScore = scoreSearchResult(
  {
    title: "Codex | OpenAI Developers",
    url: "https://developers.openai.com/codex",
    snippet: "Codex is OpenAI's coding agent for software development.",
  },
  "Codex AI OpenAI code generation model research overview 2024 2025",
);
const alternativesSourceScore = scoreSearchResult(
  {
    title: "Best OpenAI Codex Alternatives for Enterprise Teams",
    url: "https://example.com/openai-codex-alternatives",
    snippet: "A review of alternatives, comparisons, and other coding tools.",
  },
  "Codex AI OpenAI code generation model research overview 2024 2025",
);
assert(
  officialSourceScore > alternativesSourceScore,
  "Basic research queries should rank official/primary sources above alternatives/review pages.",
);

const minimaxHomeScore = scoreSearchResult(
  {
    title: "MiniMax AI",
    url: "https://www.minimax.io",
    snippet: "MiniMax has developed multimodal foundation models and AI-native products.",
  },
  "MiniMax AI official models API platform products",
);
const minimaxModelsScore = scoreSearchResult(
  {
    title: "Models - MiniMax API Docs",
    url: "https://platform.minimax.io/docs/guides/models-intro",
    snippet: "MiniMax model documentation for text, speech, video, image, and music APIs.",
  },
  "MiniMax AI official models API platform products",
);
const minimaxVideoNewsScore = scoreSearchResult(
  {
    title: "The Video-01 video generation API has officially been released",
    url: "https://www.minimax.io/news/video-generation-api",
    snippet: "MiniMax released a video generation API.",
  },
  "MiniMax AI official models API platform products",
);
assert(
  minimaxHomeScore > minimaxVideoNewsScore && minimaxModelsScore > minimaxVideoNewsScore,
  "Broad MiniMax research should rank official homepage/model docs above a specific video news page.",
);
const minimaxSynthesis = agent.paraphraseResearchFact(
  "MiniMax has independently developed a series of multimodal foundation models with powerful code and Agent capabilities, as well as ultra-long context processing.",
  "MiniMax AI official models API platform products",
);
assert(
  minimaxSynthesis.includes("multimodal foundation models") && !minimaxSynthesis.includes("relevant source ka key point"),
  "MiniMax research facts should be synthesized in cleaner Hinglish instead of raw source phrasing.",
);

console.log("Agent loop contract smoke test passed");
process.exit(0);
