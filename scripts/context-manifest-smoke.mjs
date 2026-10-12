// Context Organization Layer contract: every context source is TIERED, the
// model gets ONE map of inline-vs-on-demand, and an oversized T1 section
// collapses to a pointer instead of flooding a weak model's window.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";
import {
  CONTEXT_TIERS, SECTION_ORG, ON_DEMAND, STORES, collapseOverBudget,
  renderContextMap, contextMapInputs, summarizeContextBoard,
} from "../src/core/context-manifest.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

console.log("step 1: every tier exists and every section is assigned one");
{
  const tiers = Object.keys(CONTEXT_TIERS);
  assert(tiers.length === 4 && tiers.includes("T0_CORE") && tiers.includes("T2_ON_DEMAND") && tiers.includes("T3_STORE"), `4 tiers declared (${tiers.join(",")})`);
  const unknown = Object.entries(SECTION_ORG).filter(([, org]) => !CONTEXT_TIERS[org.tier]);
  assert(unknown.length === 0, `every section has a known tier (bad: ${unknown.map(([id]) => id).join(",") || "none"})`);
  const noHow = Object.entries(SECTION_ORG).filter(([, org]) => org.tier === "T1_TASK" && !org.how);
  assert(noHow.length === 0, `every collapsible T1 section names HOW to refetch it (bad: ${noHow.map(([id]) => id).join(",") || "none"})`);
  assert(Object.keys(ON_DEMAND).length >= 5 && Object.keys(STORES).length >= 3, "on-demand + store catalogues populated");
}

console.log("step 2: T0 is never collapsed, oversized T1 collapses to a pointer");
{
  const sections = [
    { id: "identity", content: "x".repeat(9000) },
    { id: "memory_brief", content: "y".repeat(9000) },
    { id: "code_map", content: "z".repeat(100) },
  ];
  const { kept, collapsed } = collapseOverBudget(sections);
  const byId = new Map(kept.map((s) => [s.id, s.content]));
  assert(byId.get("identity").length === 9000, "T0 core section kept whole (never dropped)");
  assert(collapsed.length === 1 && collapsed[0].id === "memory_brief", `only the oversized T1 collapsed (got ${collapsed.map((c) => c.id).join(",") || "none"})`);
  assert(/chars withheld/.test(byId.get("memory_brief")) && /memory_search|read_file/.test(byId.get("memory_brief")), "collapsed section states an actionable refetch pointer");
  assert(byId.get("code_map").length === 100, "under-cap section untouched");
}


console.log("step 3: the map names inline content AND the fetch call for on-demand");
{
  const map = renderContextMap({
    inline: [{ id: "identity", chars: 2323 }, { id: "memory_brief", chars: 6176 }, { id: "empty_one", chars: 0, empty: true }],
    onDemand: [ON_DEMAND.manuals, ON_DEMAND.toolsets, ON_DEMAND.memoryBodies, ON_DEMAND.manuals],
    menu: { size: 30, cap: 30 },
    toolsets: ["browser", "progress"],
  });
  assert(/## Context Map/.test(map), "map has its own heading");
  assert(map.includes("identity") && map.includes("memory_brief"), "map lists inline sections by name");
  assert(!map.includes("empty_one"), "empty sections are not advertised");
  assert(map.includes("load_toolset") && map.includes("memory_search") && map.includes("read_file"), "map names the real fetch calls");
  assert(map.includes("30 callable now") && map.includes("browser"), "map advertises the live menu + auto-loaded sets");
  assert(map.length < 2000, `map stays small (${map.length} chars)`);
  const dupes = (map.match(/read_file "<NAME>\.md"/g) || []).length;
  assert(dupes === 1, `duplicate on-demand hints deduped (got ${dupes})`);
  assert(contextMapInputs({ sections: [{ id: "identity", content: "abc" }], onDemandIds: ["manuals"] }).includes("identity"), "contextMapInputs feeds the real section list");
}

console.log("step 4: board summary reports per-tier cost");
{
  const board = summarizeContextBoard({
    sections: [
      { id: "identity", content: "a".repeat(100) },
      { id: "memory_brief", content: "b".repeat(50) },
      { id: "unknown_section", content: "c".repeat(10) },
    ],
    collapsed: [{ id: "memory_brief", chars: 9000, cap: 6000 }],
  });
  assert(board.tiers.T0_CORE === 100 && board.tiers.T1_TASK === 60, `tiers totalled correctly (${JSON.stringify(board.tiers)})`);
  assert(board.totalChars === 160, `total reported (${board.totalChars})`);
  assert(board.collapsed.length === 1 && board.collapsed[0].id === "memory_brief", "collapsed sections surfaced for the trace");
}

console.log("step 5: the live loop prompt carries the map in the cacheable head");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "col-"));
  const runtime = {
    rootDir: tmpRoot,
    getWorkspaceRoot: () => tmpRoot,
    config: { getConfig: () => ({ provider: { model: "t", systemPrompt: "" }, app: { creator: { name: "T", location: "L" } } }) },
    tools: { getRunPlan: () => null, getSessionPlan: () => null, getRunToolsets: () => [], getSessionToolsets: () => [] },
    gateway: { addEvent() {}, emitTransient() {} },
    sessions: { listSessions: () => [], getEvidenceLedger: () => null },
    memory: { getLongTermMemory: () => [], getNotes: () => [], readMemoryIndex: () => "" },
    provider: { getInfo: () => ({ model: "t" }) },
    skills: { getAll: () => [] },
    files: { rootDir: tmpRoot },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const menuIds = ["exec", "read_file", "write_file", "finish", "load_toolset"];
  const out = loop.buildSystemPrompt({
    agent: { id: "main" }, profile: { id: "balanced" },
    contextBundle: { workspaceContext: { files: [], manifest: { selectedProject: "P", defaultWorkingDirectory: "P" } }, skills: [], tools: [], longTermMemory: [], notes: [] },
    loopContract: {}, session: { id: "s1" }, run: { id: "r1" },
    message: "website banao", menuToolIds: menuIds, menuInfo: { size: menuIds.length, cap: 30, toolsets: ["browser"] },
  });
  assert(out.system.includes("## Context Map"), "map is present in the live prompt");
  assert(out.zoneA.includes("## Context Map"), "map lives in Zone A (cache-stable head)");
  assert(out.contextBoard && typeof out.contextBoard.totalChars === "number", "prompt returns contextBoard telemetry");
  assert(out.zoneB.length > 0, "working set still rendered");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(failures ? `\ncontext-manifest: ${failures} FAILURES` : "\ncontext-manifest: ALL PASS");
process.exit(failures ? 1 : 0);
