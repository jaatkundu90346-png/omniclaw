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
      // Declarative plugin tool: only echoes its manifest `response` template,
      // so it must stay operator-only.
      id: "fake_plugin_placeholder",
      description: "Fake plugin placeholder that must not reach the LLM schema.",
      mode: "template",
      run: async () => ({}),
    },
    {
      // 2026-07-31: a plugin whose entry module loads runs REAL code, and earns
      // model-callability the same way a forged tool does.
      id: "real_plugin_tool",
      description: "Plugin tool backed by a loaded entry module; must reach the LLM schema.",
      mode: "code",
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

// image_generate/video_generate left this list on 2026-07-10: they are REAL
// now (MediaEngine backends), and are asserted in requiredModelTools below.
const bannedModelTools = [
  "fake_plugin_placeholder",
  "text_to_speech",
  "tts",
  "music_generate",
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
  // 2026-07-31: plugins were doubly inert — runTool only rendered a template,
  // and every plugin tool was hard-coded modelCallable:false. Code-backed
  // plugin tools must now reach the model.
  "real_plugin_tool",
  "telegram_status",
  "telegram_send",
  "read_file",
  "write_file",
  "edit",
  "multi_edit",
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
  // 2026-07-10 harness-connect audit: these being missing from the allowlist
  // was why the model told the user "image/video generate nahi kar sakta" and
  // could never open its own skills — they must stay model-callable.
  "image_generate",
  "describe_image",
  "video_generate",
  "skills_list",
  "skill_read",
  "create_skill",
  "memory_write",
  "switch_model",
];

assert(allTools.length > modelTools.length, "Full operator registry should be larger than LLM-callable tool surface.");
assert(modelTools.length >= 40, "LLM-callable tool surface should expose a useful Codex-grade core.");
// 2026-07-10: cap raised 135 -> 145 for the six Hermes-parity browser tools
// (snapshot/get_images/console/cdp/dialog/tap) that went from placeholder to native.
// 2026-07-10 (harness-connect audit): 145 -> 165 for media (image_generate/
// describe_image/video_generate/vision_analyze/video_analyze), skills
// (skills_list/skill_read/skill_view/create_skill), memory_write/memory_compact,
// and session/agent-harness ids that existed but were never allowlisted.
// The per-run model MENU stays capped at omniLoop.maxTools (64) regardless.
// 2026-07-10 (UI batch): 165 -> 175 for ask_user (mid-run question cards) and
// headroom — the cap sat EXACTLY at the count, so any new real tool failed here.
// 2026-07-31: 175 -> 185 for telegram_status/telegram_send. The "headroom" above
// was spent again, so this bumps by 10 rather than by 2 — the next real tool
// should not have to touch this file.
// 2026-08-02: 185 -> 200 for the ten browser_remote_* tools (drive the user's own
// logged-in Chrome over CDP). Landed at exactly 186, one past the cap, so the
// bump is 15 to leave real headroom. Tool-choice reliability is bounded by the
// per-run MENU (omniLoop.maxTools, 64), not by this total.
assert(modelTools.length <= 200, "LLM-callable tool surface should stay focused enough for reliable tool choice.");

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
