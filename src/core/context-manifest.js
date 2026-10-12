// Context Organization Layer (COL) — the ONE place that says what context
// exists, which tier it lives in, what it may cost, and how to fetch it.
//
// Why: the harness had grown ~30 prompt sections with per-section caps invented
// in different files, so a weak model got a flat wall (measured 2026-09-26:
// 59k chars / ~15k tokens of prompt, 50 MB memory store, 27 manuals, 84 memory
// files) with no map of what was inline vs fetchable. Result: re-discovery,
// re-planning, "bhoot think, kaam zero".
//
// Rules this module enforces:
//   T0_CORE      always inline, hard-capped, must never be dropped.
//   T1_TASK      this run's working set — capped, collapsible to a pointer.
//   T2_ON_DEMAND NOT injected: named in the Context Map with the exact call
//                that fetches it (read_file / load_toolset / memory_search).
//   T3_STORE     persistent (memory.json, sessions, artifacts) — never bulk
//                injected; reached through T2 discovery.
//
// Pure data + tiny builders, zero dependencies, deterministic (no timestamps)
// so it can live in the cacheable Zone A prefix.

export const CONTEXT_TIERS = {
  T0_CORE: { id: "T0_CORE", label: "always inline", mayDrop: false },
  T1_TASK: { id: "T1_TASK", label: "this run", mayDrop: true, collapseToPointer: true },
  T2_ON_DEMAND: { id: "T2_ON_DEMAND", label: "fetch on demand", mayDrop: true },
  T3_STORE: { id: "T3_STORE", label: "persistent store", mayDrop: true },
};

// id → organisation. `cap` = chars this section may spend; `how` = the exact
// call that retrieves the full thing when it is collapsed/omitted.
export const SECTION_ORG = {
  // T0_CORE — identity, boundaries, workspace truth, tools, loop contract.
  identity: { tier: "T0_CORE", cap: 2600 },
  creator: { tier: "T0_CORE", cap: 900 },
  hard_constraints: { tier: "T0_CORE", cap: 1300, how: "read_file the docs named in Project Context" },
  workspace: { tier: "T0_CORE", cap: 12500, how: "read_file \"<name>\" (paths resolve from the project root)" },
  tooling: { tier: "T0_CORE", cap: 2400, how: "load_toolset {\"name\":\"<set>\"} / list_toolsets" },
  active_memory: { tier: "T0_CORE", cap: 1900, how: "memory_search \"<query>\"" },
  identity_memory: { tier: "T0_CORE", cap: 1200 },
  runtime: { tier: "T0_CORE", cap: 900 },
  execution_bias: { tier: "T0_CORE", cap: 800 },
  safety: { tier: "T0_CORE", cap: 700 },
  output_directives: { tier: "T0_CORE", cap: 800 },
  sandbox: { tier: "T0_CORE", cap: 500 },
  documentation: { tier: "T0_CORE", cap: 900 },
  openclaw_control: { tier: "T0_CORE", cap: 700 },
  harness: { tier: "T0_CORE", cap: 1600, how: "agent_harness_status / mcp_connect_all" },
  environment: { tier: "T0_CORE", cap: 2000 },
  self_knowledge: { tier: "T0_CORE", cap: 1100 },
  loop_contract: { tier: "T0_CORE", cap: 3600 },
  context_map: { tier: "T0_CORE", cap: 1800 },

  // T1_TASK — this run's working set (collapses to a pointer when oversized).
  plan: { tier: "T1_TASK", cap: 1400, how: "update_plan (no args) returns the live plan" },
  session_work: { tier: "T1_TASK", cap: 1600, how: "task_trace / read PROGRESS.md" },
  project_state: { tier: "T1_TASK", cap: 2500, how: "read_file STARTUP.md / PROGRESS.md / TASKS.md" },
  continuation: { tier: "T1_TASK", cap: 1400, how: "task_trace / update_plan (no args) shows the inherited step" },
  debugging_protocol: { tier: "T1_TASK", cap: 1500, how: "load_toolset {\"name\":\"progress\"} (task_trace)" },
  instincts: { tier: "T1_TASK", cap: 1400, how: "read_file data/instincts.json (full learned patterns)" },
  playbooks: { tier: "T1_TASK", cap: 1500, how: "read_file data/playbooks.json (task playbooks)" },
  // The memory brief self-bounds around ~8.2KB (1.6KB index + 8 ranked
  // memories + 8 notes + capacity header), so the cap sits just above that:
  // a normal brief always stays inline (weak models rarely call memory_search
  // for themselves), and only a runaway one — e.g. a huge async hybrid-recall
  // override — collapses to its pointer.
  memory_brief: { tier: "T1_TASK", cap: 8500, how: "memory_search \"<query>\" / read_file workspace/agents/<agent>/memory/<file>.md" },
  recent_sessions: { tier: "T1_TASK", cap: 1800, how: "load_toolset {\"name\":\"project\"} / sessions list" },
  code_map: { tier: "T1_TASK", cap: 2200, how: "search_text \"<identifier>\"" },
  evidence_ledger: { tier: "T1_TASK", cap: 8000, how: "read_file the path (ledger entries stay valid)" },
};


// T2_ON_DEMAND — named in the map, never injected in bulk.
export const ON_DEMAND = {
  manuals: { how: "read_file \"<NAME>.md\"", note: "workspace + project manuals (AGENTS, TOOLS, PROGRESS, DECISIONS, ...)" },
  skills: { how: "read_file <skill path>", note: "full skill instructions live in the skill file" },
  toolsets: { how: "load_toolset {\"name\":\"<set>\"}", note: "extra tool groups outside the core menu" },
  memoryBodies: { how: "memory_search \"<query>\"", note: "full saved memories + older conversations" },
  notes: { how: "memory_search / list_notes", note: "short session notes" },
  research: { how: "load_toolset {\"name\":\"web\"} then web_research", note: "earlier research dumps" },
  artifacts: { how: "read_file <artifact path>", note: "generated files already on disk" },
  tasks: { how: "load_toolset {\"name\":\"project\"}", note: "task board state" },
  browser: { how: "load_toolset {\"name\":\"browser\"}", note: "page driving, screenshots, remote control" },
  computer: { how: "load_toolset {\"name\":\"computer\"}", note: "files outside the workspace, processes, sandbox" },
};

// T3_STORE — persistent, reachable only through T2 discovery.
export const STORES = {
  memoryJson: { path: "data/memory.json", how: "memory_search / memory_get / list_long_term_memory" },
  sessions: { path: "data/sessions.json", how: "task_trace / sessions list" },
  artifacts: { path: "workspace/** + data/generated/**", how: "list_files / read_file" },
  checkpoints: { path: "data/checkpoints/**", how: "read_file (per-run file snapshots)" },
};

/**
 * Collapse T1 sections that exceed their organisation cap into a pointer line.
 * T0 sections are NEVER collapsed — only trimmed by their own builder (a
 * dropped core rule is worse than a long core rule).
 * @returns {{kept: Array<{id:string,content:string}>, collapsed: Array<object>}}
 */
export function collapseOverBudget(sections = [], budgets = SECTION_ORG) {
  const kept = [];
  const collapsed = [];
  for (const section of sections) {
    const id = String(section?.id || "");
    const content = String(section?.content || "");
    if (!id || !content) continue;
    const org = budgets[id] || null;
    const cap = Number(org?.cap) || 0;
    const tier = org?.tier || "T1_TASK";
    if (tier === "T0_CORE" || cap <= 0 || content.length <= cap) {
      kept.push({ id, content, tier });
      continue;
    }
    const pointer = org?.how || "ask the harness";
    kept.push({
      id,
      tier,
      content: `[${id}: ${content.length} chars withheld to keep focus — ${pointer}]`,
    });
    collapsed.push({ id, chars: content.length, cap, pointer });
  }
  return { kept, collapsed };
}

/**
 * Render THE context map: one block that tells the model exactly what it has
 * inline, what exists on demand, and the call that fetches each. This is the
 * anti-re-discovery contract — for a weak model it is the single most useful
 * thing in the prompt, so it stays short and lives in the cacheable Zone A.
 */
export function renderContextMap({ inline = [], onDemand = [], menu = {}, toolsets = [], projectRoot = "" } = {}) {
  const lines = [
    "## Context Map (what you already have — and how to get the rest)",
    "",
    "Inline right now (do NOT re-discover these with commands):",
  ];
  const inlineItems = (Array.isArray(inline) ? inline : [])
    .filter((item) => item && item.id && !item.empty)
    .map((item) => `${item.id}${item.chars ? ` (${item.chars}c)` : ""}`);
  lines.push(inlineItems.length ? `- ${inlineItems.join(", ")}` : "- (nothing yet this turn)");
  if (menu && Number(menu.size) > 0) {
    lines.push(`- Tools: ${menu.size} callable now${Number(menu.cap) ? ` of ${menu.cap} slots` : ""}${Array.isArray(toolsets) && toolsets.length ? `, auto-loaded for this task: ${toolsets.join(", ")}` : ""}`);
  }
  const onDemandLines = [];
  const seenHow = new Set();
  for (const item of Array.isArray(onDemand) ? onDemand : []) {
    const how = String(item?.how || "").trim();
    if (!how || seenHow.has(how)) continue;
    seenHow.add(how);
    onDemandLines.push(`- ${item.note ? `${item.note} → ` : ""}${how}`);
  }
  if (onDemandLines.length) {
    lines.push("", "On demand — ONE tool call each, never ask the user to paste it:");
    lines.push(...onDemandLines);
  }
  lines.push(
    "",
    `Rules: if something is listed above it EXISTS now — fetch it instead of guessing or re-exploring. Relative paths resolve from the project root${projectRoot ? ` (${projectRoot})` : ""}. Platform, shell, and tool names come from this prompt, never from guesswork.`,
  );
  return lines.join("\n");
}

/** Section ids worth naming in the map for a given run (T0 + populated T1). */
export function contextMapInputs({ sections = [], onDemandIds = [], menu = {}, toolsets = [], projectRoot = "" } = {}) {
  const inline = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const id = String(section?.id || "");
    if (!id) continue;
    const content = String(section?.content || "");
    inline.push({ id, chars: content.length, empty: content.length === 0 });
  }
  const onDemand = onDemandIds.map((id) => ON_DEMAND[id]).filter(Boolean);
  return renderContextMap({ inline, onDemand, menu, toolsets, projectRoot });
}

/** Board summary for telemetry/report: tier totals + what got collapsed. */
export function summarizeContextBoard({ sections = [], collapsed = [] } = {}) {
  const tiers = {};
  for (const section of Array.isArray(sections) ? sections : []) {
    const tier = SECTION_ORG[String(section?.id || "")]?.tier || "T1_TASK";
    tiers[tier] = (tiers[tier] || 0) + String(section?.content || "").length;
  }
  return {
    tiers,
    totalChars: Object.values(tiers).reduce((a, b) => a + b, 0),
    collapsed: collapsed.map((c) => ({ id: c.id, chars: c.chars, cap: c.cap })),
  };
}
