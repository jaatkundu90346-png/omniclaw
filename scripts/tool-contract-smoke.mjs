import { ToolRegistry } from "../src/core/tool-registry.js";
import { ToolResolver } from "../src/core/tool-resolver.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const permissions = {
  allowNoteWrite: true,
  allowMemoryPromotion: true,
  allowDreamSweep: true,
  allowConnectorWrite: true,
  allowTaskWrite: true,
  allowDirectoryList: true,
  allowComputerAccess: true,
  allowFileRead: true,
  allowFileWrite: true,
  allowShellPlanning: true,
  allowWebResearch: true,
  allowBrowserControl: true,
  allowShellExecution: true,
  allowTaskRunner: true,
  allowSkillWrite: true,
  allowConfigWrite: true,
  allowBrowserEvaluate: true,
};

const configStore = {
  getConfig: () => ({
    tools: {
      permissions,
      filesystem: { maxReadBytes: 131072 },
      computerAccess: { maxReadBytes: 131072 },
    },
  }),
};

const memoryStore = {
  addNote: () => ({}),
  getNotes: () => [],
  getLongTermMemory: () => [],
  getDreams: () => [],
  getOverview: () => ({}),
  runDreamSweep: () => ({}),
};

const taskStore = {
  create: () => ({}),
  list: () => [],
};

const fileStore = {
  listFiles: () => [],
  readText: () => ({ path: "demo.txt", content: "demo", totalBytes: 4 }),
  writeText: () => ({ path: "demo.txt", bytesWritten: 4 }),
  appendText: () => ({ path: "demo.txt", bytesWritten: 4 }),
  searchComputerFiles: () => [],
  listComputerDirectory: () => ({ entries: [] }),
  readComputerFile: () => ({ content: "" }),
  writeComputerFile: () => ({ path: "demo.txt" }),
  createComputerDirectory: () => ({ path: "demo" }),
  copyComputerPath: () => ({ copied: true }),
  moveComputerPath: () => ({ moved: true }),
  deleteComputerPath: () => ({ deleted: true }),
};

const shellExecutor = {
  execute: () => ({ execution: { status: "completed" } }),
  getProcessStatus: () => ({}),
  listProcesses: () => [],
  killProcess: () => ({}),
  cleanupProcesses: () => ({}),
};

const browser = {
  open: () => ({}),
  view: () => ({}),
  screenshot: () => ({}),
  click: () => ({}),
  type: () => ({}),
  scroll: () => ({}),
  wait: () => ({}),
  evaluate: () => ({}),
  goBack: () => ({}),
  goForward: () => ({}),
  close: () => ({}),
  automate: () => ({}),
  listSessions: () => [],
};

const browserOperator = {
  getStatus: () => ({ available: true }),
  automate: () => ({}),
  readUrl: () => ({}),
  openUrl: () => ({}),
};

const webResearch = {
  search: () => ({ results: [] }),
  fetchUrl: () => ({ markdown: "" }),
};

const pluginRegistry = {
  getToolDefinitions: () => [
    {
      id: "fake_plugin_placeholder",
      description: "Fake plugin placeholder that must not reach the LLM schema.",
      run: async () => ({}),
    },
  ],
  runTool: async () => ({}),
};

const registry = new ToolRegistry({
  memoryStore,
  taskStore,
  configStore,
  fileStore,
  shellExecutor,
  webResearch,
  browserOperator,
  browser,
  pluginRegistry,
  agentRuntime: {},
});

const allTools = registry.getAll({ includeAllAgents: true });
const modelTools = registry.getAll({ includeAllAgents: true, modelCallableOnly: true });
const modelIds = new Set(modelTools.map((tool) => tool.id));

const bannedModelTools = [
  "fake_plugin_placeholder",
  "browser_console",
  "browser_cdp",
  "browser_dialog",
  "text_to_speech",
  "tts",
  "image_generate",
  "music_generate",
  "video_generate",
  "ha_list_entities",
  "ha_get_state",
  "ha_list_services",
  "ha_call_service",
  "kanban_show",
  "kanban_list",
  "kanban_complete",
  "kanban_block",
  "kanban_heartbeat",
  "kanban_comment",
  "kanban_create",
  "kanban_link",
  "kanban_unblock",
  "clarify",
  "computer_use",
  "mixture_of_agents",
];

const requiredModelTools = [
  "read_file",
  "write_file",
  "edit",
  "verify_html_artifact",
  "run_terminal_command",
  "exec_approval_status",
  "auto_review",
  "web_search",
  "brave_search",
  "exa_search",
  "web_fetch",
  "apply_patch",
  "browser",
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "search_computer_files",
  "read_computer_file",
  "write_computer_file",
  "configure_provider_brain",
  "list_provider_models",
  "configure_telegram",
  "channel_dock",
  "acp_doctor",
  "acp_spawn",
  "acp_sessions",
  "agent_harness_doctor",
  "agent_harness_spawn",
  "agent_harness_status",
  "delegate_task",
  "subagents",
  "memory_search",
  "sessions_history",
];

assert(allTools.length > modelTools.length, "Full operator registry should be larger than LLM-callable tool surface.");
assert(modelTools.length >= 40, "LLM-callable tool surface should expose a useful Codex-grade core.");
assert(modelTools.length <= 100, "LLM-callable tool surface should stay focused enough for reliable tool choice.");

for (const id of bannedModelTools) {
  assert(!modelIds.has(id), `${id} must be hidden from the LLM-callable tool surface.`);
}

for (const id of requiredModelTools) {
  assert(modelIds.has(id), `${id} must be available to the LLM-callable Codex-grade tool surface.`);
}

for (const tool of modelTools) {
  assert(tool.modelCallable !== false, `${tool.id} should not be marked non-callable.`);
  assert(tool.productReady !== false, `${tool.id} should not be a non-product-ready placeholder.`);
  assert(!/placeholder|not configured|not wired|not ready/i.test(`${tool.description} ${tool.readinessReason}`), `${tool.id} looks fake or unfinished.`);
}

const resolver = new ToolResolver({ toolRegistry: registry, configStore });
const schemas = resolver.getToolDefinitions();
const schemaNames = new Set(schemas.map((schema) => schema.function?.name));

for (const id of bannedModelTools) {
  assert(!schemaNames.has(id), `${id} must not be emitted in function-calling schemas.`);
}
for (const id of requiredModelTools) {
  assert(schemaNames.has(id), `${id} should be emitted in function-calling schemas.`);
}

console.log(`Tool contract smoke test passed: ${modelTools.length}/${allTools.length} tools are model-callable.`);
