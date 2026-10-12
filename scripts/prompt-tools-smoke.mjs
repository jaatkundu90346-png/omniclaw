// Prompt tool-claim contract (Part B): every tool name mentioned in the
// rendered system prompt is either in the live menu or accompanied by its
// load_toolset instruction (toolset catalog + explicit load call).
import { OmniLoop } from "../src/core/omni-loop.js";
import { CORE_ORDER, TOOLSETS } from "../src/core/tool-layers.js";

let failures = 0;
function assert(cond, label) {
  if (!cond) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

console.log("step 1: render prompt with the live core menu");
const menuIds = [...CORE_ORDER];
const runtime = {
  rootDir: "X",
  getWorkspaceRoot: () => "P",
  config: { getConfig: () => ({ provider: {}, app: {} }) },
  tools: { getRunPlan: () => null },
  gateway: { addEvent: () => {}, emitTransient: () => {} },
  sessions: { getEvidenceLedger: () => null },
  provider: { getInfo: () => ({ model: "test-model" }) },
  fileStore: { searchText: () => ({ matches: [] }) },
};
const loop = new OmniLoop({ agentRuntime: runtime });
const out = loop.buildSystemPrompt({
  agent: { id: "main" }, profile: { id: "balanced" },
  tools: menuIds.map((id) => ({ id })),
  contextBundle: { tools: [], skills: [], workspaceContext: { manifest: { selectedProject: "P", defaultWorkingDirectory: "P", agentWorkspace: "A", sharedWorkspace: "S" }, files: [] } },
  loopContract: {}, session: { id: "s1" }, run: { id: "r1" },
  message: "create a Mario-style platformer in a single HTML file, then verify in a browser",
  menuToolIds: menuIds,
});
const prompt = out.system;
const menu = new Set(menuIds);

// Tool universe: core + every toolset member. Single-word ids (message,
// process, browser, image, cron...) also occur as ordinary prose, so only
// underscore ids are checked — those are unambiguous tool references.
const ownerOf = new Map();
for (const id of CORE_ORDER) ownerOf.set(id, "core");
for (const [setName, set] of Object.entries(TOOLSETS)) {
  for (const id of set.members || []) {
    if (!ownerOf.has(id)) ownerOf.set(id, setName);
  }
}

console.log("step 2: every mentioned tool is in-menu or load_toolset-paired");
const mentioned = [...ownerOf.keys()]
  .filter((id) => id.includes("_"))
  .filter((id) => new RegExp(`\\b${id}\\b`).test(prompt));
console.log(`mentioned tool ids: ${mentioned.join(", ") || "(none)"}`);
assert(mentioned.length > 0, "prompt names at least the core tools (menu index)");
for (const id of mentioned) {
  if (menu.has(id)) continue;
  const owner = ownerOf.get(id);
  const paired = prompt.includes("load_toolset") && owner !== "core" && prompt.includes(`"${owner}"`);
  assert(paired, `'${id}' is menu-missing but paired with load_toolset {"name":"${owner}"}`);
}

console.log("step 3: catalog embedded — no discovery round needed");
for (const setName of Object.keys(TOOLSETS)) {
  assert(prompt.includes(setName), `catalog names the '${setName}' toolset`);
}
assert(prompt.includes("list_toolsets"), "list_toolsets is named (core discovery, free)");

console.log("step 4: browser task auto-resolves to the browser toolset");
import { toolsetsForIntent } from "../src/core/tool-layers.js";
const sets = toolsetsForIntent({ message: "create a Mario-style platformer in a single HTML file, then verify in a browser" });
assert(sets.includes("browser"), `browser intent auto-matches ('${sets.join(",")}') — auto-load needs no model round`);

console.log(failures ? `\nprompt-tools: ${failures} FAILURES` : "\nprompt-tools: ALL PASS");
process.exit(failures ? 1 : 0);
