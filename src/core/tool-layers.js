// T2.2 tool menu layers (design D3). Single source for CORE order, toolset
// membership, compat aliases, operator-only ids and drops. Pure data +
// tiny builders; no runtime deps (importable from registry, loop, server).

// CORE slots in menu order — Codex-sized always-on core.
// Everything else lives in a named toolset reachable via load_toolset.
// git_*, progress/verify, browser, skills-list are NOT core: they load on
// demand so the menu stays small and schemas can stay FULL.
// list_toolsets IS core: discovery must be free (one tiny tool schema costs
// ~300 chars; a wasted discovery round re-sends the full ~20k context).
export const CORE_ORDER = [
  "exec", "read_file", "write_file", "edit", "multi_edit", "list_files",
  "search_text", "web_search", "web_fetch", "delegate_task", "update_plan",
  "memory_search", "memory_write", "ask_user", "finish", "load_toolset",
  "list_toolsets",
];

export const TOOLSETS = {
  browser: {
    description: "Drive web pages: managed tabs, navigate, click, type, screenshots.",
    // Member order matters: the 28-slot menu cap truncates the tail, so the
    // canonical ~8 (+ close companions) come first, exotic/remote last.
    members: [
      "browser_open", "browser_snapshot", "browser_click", "browser_type",
      "browser_text", "browser_links", "browser_screenshot", "browser_evaluate",
      "browser_view", "browser_navigate", "browser_close", "browser_status",
      "browser", "browser_wait",
      "browser_remote_connect", "browser_remote_launch", "browser_remote_list_tabs",
      "browser_remote_state", "browser_remote_screenshot", "browser_remote_click",
      "browser_remote_type", "browser_remote_fill_form", "browser_remote_evaluate",
      "browser_remote_navigate", "browser_remote_disconnect",
      "browser_scroll", "browser_back",
      "browser_forward", "browser_press", "browser_get_images", "browser_console",
      "browser_cdp", "browser_dialog", "browser_tap", "browser_automate", "browser_sessions",
    ],
    keywords: ["browser", "youtube", "website", "webpage", "click", "login", "scrape", "page", "tab", "screenshot"],
  },
  computer: {
    description: "This laptop: files anywhere allowed, shell, processes, sandbox.",
    // Member order matters (see browser above): measured-use first.
    members: [
      "read_computer_file", "write_computer_file", "list_computer_directory",
      "process_status", "plan_shell_command", "time_now",
      "computer_access_status", "computer_system_status", "search_computer_files",
      "create_computer_directory", "copy_computer_path", "move_computer_path",
      "delete_computer_path", "run_terminal_command", "process", "process_list",
      "process_kill", "process_cleanup", "code_execution",
      "sandbox_status", "sandbox_run", "sandbox_apply", "exec_approval_status",
    ],
    keywords: ["file explorer", "pictures", "downloads", "documents", "disk", "install", "process", "terminal", "command prompt", "folder", "time", "clock"],
  },
  "git-write": {
    description: "Mutating git: commit (stage/unstage/revert wrappers land here).",
    members: ["git_commit"],
    keywords: ["commit", "push", "stage", "revert"],
  },
  git: {
    description: "Read-only git inspection: status, diff, log. Commit lives in git-write.",
    members: ["git_status", "git_diff", "git_log"],
    keywords: ["git", "status", "diff", "log", "branch", "changes"],
  },
  progress: {
    description: "Run progress + verification: plans, traces, handoffs, done-gate.",
    members: [
      "read_progress", "update_progress", "verify_done", "task_trace",
      "session_handoff", "sprint_contract", "read_sprint_contract",
      "feature_list", "feature_set", "feature_verify",
      "check_boundaries", "add_check", "evaluate_work",
      "log_decision", "read_decisions", "skills_list", "list_toolsets",
    ],
    keywords: ["progress", "plan", "verify", "done", "trace", "handoff", "sprint", "feature", "skill", "toolset"],
  },
  project: {
    description: "Repo + task + delegation ops: plans, sprints, features, harness, subagents, sessions, cron.",
    // Member order matters (see browser above): measured-use first.
    members: [
      "delegate_task", "read_progress", "update_progress", "task_trace",
      "feature_list", "code_act", "verify_html_artifact", "sessions_list",
      "sprint_contract", "subagents", "feature_set", "session_handoff",
      "session_status", "session_search", "evaluate_work", "harness_doctor",
      "log_decision", "read_decisions", "feature_verify", "restore_checkpoint",
      "auto_review", "read_sprint_contract", "check_boundaries", "add_check",
      "best_of_n", "init_project",
      "apply_patch", "multi_edit", "search_files", "git_log",
      "agent_harness_doctor", "agent_harness_spawn", "agent_harness_status",
      "agent_harness_sessions", "agent_harness_cancel",
      "acp_doctor", "acp_install", "acp_spawn", "acp_status", "acp_sessions",
      "acp_cancel", "acp_close", "acp_set_option",
      "sessions_history",
      "sessions_spawn", "sessions_yield", "create_task", "list_tasks", "run_task", "cron", "cronjob",
    ],
    keywords: ["build", "fix", "error", "test", "plan", "delegate", "subagent", "task", "schedule", "commit", "repo", "project", "code"],
  },
  comms: {
    description: "Messaging + media: telegram, mail, apps, attachments, images.",
    // Member order matters (see browser above): measured-use first.
    // (tts/image/configure_telegram stay listed but never enter the menu:
    // drop/alias/operator ids are skipped at build time.)
    members: [
      "describe_image", "telegram_status", "connected_apps_status",
      "telegram_send", "image_generate", "message",
      "channel_dock", "gmail_search_messages",
      "gmail_get_message", "github_list_repositories", "github_search_issues",
      "scan_file_drop", "analyze_attachment_media", "analyze_pending_media_attachments",
      "cleanup_attachment_cache", "video_generate",
      "image", "tts", "configure_telegram",
    ],
    keywords: ["telegram", "discord", "message", "send", "mail", "gmail", "email", "image", "video", "photo", "notify"],
  },
  "memory-admin": {
    description: "Memory surgery: promote, dream, forget, compact, inspect.",
    members: [
      "memory_get", "memory_forget", "memory_replace", "memory_compact",
      "promote_memory", "dream_memory_sweep", "list_long_term_memory",
      "list_notes",
    ],
    keywords: ["forget", "dream", "promote", "long-term", "memories list"],
  },
  mcp: {
    description: "External MCP servers (dynamic mcp_* tools once connected).",
    members: ["mcp_connect_all"],
    keywords: ["mcp", "composio", "connector server", "integration"],
  },
  web: {
    description: "Deep web research beyond a quick search (multi-source synthesis).",
    members: ["web_research", "deep_research"],
    keywords: ["research", "deep dive", "investigate", "comparison", "landscape", "state of"],
  },
  self: {
    description: "Provider self-service reads; switching needs an approval card.",
    members: ["provider_status", "list_provider_models", "switch_model", "test_provider_profile"],
    keywords: ["model", "provider", "switch", "change model", "which model", "nvidia", "openrouter"],
  },
  forge: {
    description: "Skill + tool forge (all writes approval-gated with diff).",
    // Member order matters (see browser above): measured-use first.
    members: [
      "build_tool", "test_tool", "list_custom_tools", "create_skill",
      "skill_read", "remove_custom_tool", "openclaw_skill_import", "openclaw_skill_pack_import",
      "self_build_plan",
    ],
    keywords: ["skill", "forge", "build tool", "automate", "shortcut"],
  },
};

// ── Token diet ──────────────────────────────────────────────────────────
// Hard menu ceiling: core (~16) + guaranteed allocation for explicitly loaded
// toolsets (~14). A loaded toolset gets REAL slots, never core leftovers.
export const MENU_MAX_TOOLS = 30;
// Canonical browser set: the first 8 members are the load-bearing browser
// tools. load_toolset("browser") must ALWAYS surface at least these.
export const BROWSER_CANONICAL_IDS = [
  "browser_open", "browser_snapshot", "browser_click", "browser_type",
  "browser_text", "browser_links", "browser_screenshot", "browser_evaluate",
];
// No pinned extras: core already carries the loop essentials. Pinned ids eat
// the guaranteed toolset allocation, recreating the starvation bug.
export const PINNED_MENU_IDS = [];

// ── Intent-set admission budget ─────────────────────────────────────────
// An intent-MATCHED set is a focus hint, not an operator command. Measured
// 2026-09-26 (context-audit, browser-style message): browser+progress matched,
// all 36+17 members were pushed, the 30-cap then evicted core-tail tools
// (memory_search, memory_write, ask_user, web_search, web_fetch) and finally
// the whole browser set — so a browser task ran with ZERO browser tools and
// no memory/web search. Correct behaviour: core is fixed, matched sets share
// what is left, and everything beyond is one free load_toolset away.
export const INTENT_SET_SLOTS = 6;
export const INTENT_SET_FLOOR = 3;
export function intentSlotsFor(setName, memberCount = 0) {
  const n = Math.max(0, Number(memberCount) || 0);
  if (setName === "browser") return Math.min(n, Math.max(BROWSER_CANONICAL_IDS.length, INTENT_SET_SLOTS));
  return Math.min(n, INTENT_SET_SLOTS);
}

// Keep model-facing argument hints: per-parameter descriptions, enums,
// required flags, and one usage example where present. Stripping them forces
// the model to guess arguments — every wrong guess costs a full round, which
// dwarfs any token saving. Registry untouched; this is send-time shaping only.
// No combinators (oneOf/anyOf/allOf) exist in the registry, so a structural
// whitelist cannot break a tool shape.
export const MENU_PARAM_DESC_CHARS = 300;
export function stripSchemaForMenu(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  const clean = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return node;
    const out = {};
    if (typeof node.type === "string") out.type = node.type;
    if (typeof node.description === "string" && node.description.trim()) {
      out.description = node.description.slice(0, MENU_PARAM_DESC_CHARS);
    }
    if (Array.isArray(node.required)) {
      out.required = node.required.filter((r) => typeof r === "string").slice(0, 64);
    }
    if (Array.isArray(node.enum)) out.enum = node.enum.slice(0, 64);
    if (typeof node.const === "string" || typeof node.const === "number" || typeof node.const === "boolean") {
      out.const = node.const;
    }
    if (typeof node.default === "string" || typeof node.default === "number" || typeof node.default === "boolean") {
      out.default = node.default;
    }
    if (typeof node.example === "string" || typeof node.example === "number" || typeof node.example === "boolean") {
      out.example = node.example;
    }
    if (Array.isArray(node.examples)) out.examples = node.examples.slice(0, 1);
    if (node.properties && typeof node.properties === "object") {
      out.properties = {};
      for (const [key, value] of Object.entries(node.properties)) {
        out.properties[key] = clean(value);
      }
    }
    if (node.items && typeof node.items === "object") out.items = clean(node.items);
    if (typeof node.additionalProperties === "boolean") {
      out.additionalProperties = node.additionalProperties;
    }
    return out;
  };
  const out = clean(schema);
  if (out.additionalProperties === undefined) out.additionalProperties = true;
  return out;
}

// Per-tool description cap at send time (registry untouched). 500 chars:
// enough to be unambiguous about paths/cwd/required-vs-optional.
export const MENU_DESC_CHARS = 500;

export function menuSchemaForSend(def = {}) {
  return {
    type: "function",
    function: {
      name: def.id,
      description: String(def.description || "").slice(0, MENU_DESC_CHARS),
      parameters: stripSchemaForMenu(def.schema),
    },
  };
}

// Compat aliases: callable (legacy transcripts) but never in the menu.
export const ALIAS_OF = {
  read: "read_file", write: "write_file/append_file", append_file: "write_file (append backend)",
  patch: "apply_patch", execute_code: "code_execution", computer_use: "computer_access_status",
  todo: "create_task", memory: "memory_get/memory_search multiplexer", image: "analyze_attachment_media",
  send_message: "message", sessions_send: "sessions_spawn", cronjob: "cron",
  web_search: "brave/exa_search+fetch", web_fetch: "read_url", web_extract: "read_url",
  read_url: "web_fetch", memory_recall: "memory_search",
  vision_analyze: "describe_image", video_analyze: "describe_image",
  open_browser_url: "browser_open (OS browser, uncontrolled)",
  brave_search: "web_search backend", exa_search: "web_search backend",
  x_search: "web_search backend",
};
export const ALIAS_IDS = new Set(Object.keys(ALIAS_OF));

// OPERATOR: UI/API only. Model calls fail closed with EOPERATOR (registry).
export const OPERATOR_IDS = new Set([
  "runtime_summary", "prompt_trace", "prompt_assembly_status", "tool_trace",
  "v2_status", "v2_repair_plan", "capability_demo", "layer_status",
  "openclaw_vendor_status", "openclaw_code_study", "hermes_reference_status",
  "hermes_vendor_status", "hermes_skill_scan", "hermes_tool_catalog",
  "context_compression_status", "messaging_gateway_status", "trajectory_training_status",
  "closed_learning_loop_status", "hermes_use_cases_status", "design_principles_status",
  "openclaw_skill_scan", "update_runtime_settings", "apply_provider_profile",
  "save_provider_profile", "delete_provider_profile", "set_provider_key",
  "configure_provider_brain", "provider_keys",
  "get_provider_key_status", "gateway", "model_provider_status",
  "mcp_integration_status", "configure_telegram", "terminal_backends_status",
  "skill_system_status",
  // Namespace-rationalization additions (measured 0 task calls; diagnostics
  // the model cannot use productively — UI/API surfaces only):
  "cron_scheduler_status", "memory_lifecycle_status",
  "subagent_delegation_status", "harness_evolution_status",
  // Placeholders/partials: never model-productive. Calls fail closed in the
  // registry with an explicit working alternative (see PLACEHOLDER_REDIRECT),
  // never a fabricated success.
  "ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service",
  "kanban_show", "kanban_list", "kanban_complete", "kanban_block",
  "kanban_heartbeat", "kanban_comment", "kanban_create", "kanban_link",
  "kanban_unblock", "music_generate", "text_to_speech", "tts",
  "clarify", "browser_vision", "skill_manage",
]);
export const EOPERATOR = "This is an operator action; ask the user to do it in Settings";

// Placeholder → working alternative ("" = none exists). Used for the
// single-line explicit error when a placeholder is called anyway. Entries
// NOT listed here fall back to the registry's own replacement metadata.
export const PLACEHOLDER_REDIRECT = {
  clarify: "ask_user",
  browser_vision: "browser_screenshot + describe_image",
  skill_manage: "create_skill",
  music_generate: "",
  text_to_speech: "",
  tts: "",
  ha_list_entities: "",
  ha_get_state: "",
  ha_list_services: "",
  ha_call_service: "",
};
// DROP: removed from the menu; code stays until T2 ends (no deletions in T2.1–T2.2).
export const DROP_IDS = new Set([
  "ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service",
  "kanban_show", "kanban_list", "kanban_complete", "kanban_block",
  "kanban_heartbeat", "kanban_comment", "kanban_create", "kanban_link",
  "kanban_unblock", "clarify", "canvas", "tts", "mixture_of_agents",
]);

export function getToolLayer(id) {
  if (CORE_ORDER.includes(id)) return "core";
  // Aliases/drops/operator win over toolset membership (e.g. cronjob is a
  // project member for docs but never enters a menu).
  if (ALIAS_IDS.has(id)) return "alias";
  if (DROP_IDS.has(id)) return "drop";
  if (OPERATOR_IDS.has(id)) return "operator";
  for (const [name, set] of Object.entries(TOOLSETS)) {
    if (set.members.includes(id)) return `toolset:${name}`;
  }
  return "unmapped";
}

// Menu = CORE (fixed order) + pinned essentials + explicit/priority toolsets
// + remaining active toolsets (fixed set order), deduped, hard-capped.
// GUARANTEE: explicitly loaded toolsets are NEVER truncated away by core
// tools. If total would exceed the cap, drop least-used CORE tails first and
// log which tools were dropped and why. defs: full registry defs
// ({id, description, schema...}). allowlist: optional agent allowedTools —
// intersected, never widened. priorityToolsets: explicitly enabled
// (mid-run enable_toolset / session pins) jump the queue. maxTools <= 0 = no
// cap (legacy behaviour).
export function buildMenu({ defs = [], activeToolsets = [], allowlist = null, priorityToolsets = [], maxTools = 0 } = {}) {
  const byId = new Map();
  for (const d of defs) {
    if (d && d.id && !byId.has(d.id)) byId.set(d.id, d);
  }
  const allowed = allowlist && allowlist.length
    ? new Set(allowlist.map(String))
    : null;
  const pass = (id) => !allowed || allowed.has(id);
  const ordered = [];
  const seen = new Set();
  const dropped = [];
  const push = (id, fromCore = false) => {
    if (seen.has(id) || !pass(id)) return;
    // Aliases/drops/operator tools never enter via toolsets (CORE_ORDER names
    // stay explicit per D3 even when aliased, e.g. web_search).
    if (!fromCore && (ALIAS_IDS.has(id) || DROP_IDS.has(id) || OPERATOR_IDS.has(id))) return;
    const def = byId.get(id);
    if (!def) return;
    seen.add(id);
    ordered.push(def);
  };
  for (const id of CORE_ORDER) push(id, true);
  for (const id of PINNED_MENU_IDS) push(id, true);
  const active = Array.isArray(activeToolsets) ? activeToolsets : [];
  const priority = new Set(Array.isArray(priorityToolsets) ? priorityToolsets : []);
  // Explicitly enabled sets first, then the rest in fixed set order.
  const orderedSets = [
    ...Object.keys(TOOLSETS).filter((name) => priority.has(name) && active.includes(name)),
    ...Object.keys(TOOLSETS).filter((name) => !priority.has(name) && active.includes(name)),
  ];
  // Collect priority ids FIRST so the cap can never hide what the operator
  // explicitly asked for (B1/B2). Guarantee = the canonical subset for large
  // sets (browser: 8 canonical; others: all members up to ~15 slots). The full
  // 36-member browser list stays callable via admission, but the menu only
  // guarantees the canonical tools — otherwise a single load_toolset would
  // evict the entire core.
  const priorityIds = [];
  const priorityBestEffort = [];
  for (const name of orderedSets) {
    if (!priority.has(name)) continue;
    const members = TOOLSETS[name].members.filter((id) =>
      !seen.has(id) && pass(id) && byId.has(id)
      && !ALIAS_IDS.has(id) && !DROP_IDS.has(id) && !OPERATOR_IDS.has(id));
    if (name === "browser") {
      for (const id of members) {
        if (BROWSER_CANONICAL_IDS.includes(id)) priorityIds.push(id);
        else priorityBestEffort.push(id);
      }
    } else if (members.length <= 15) {
      priorityIds.push(...members);
    } else {
      priorityIds.push(...members.slice(0, 15));
      priorityBestEffort.push(...members.slice(15));
    }
  }
  for (const id of priorityIds) push(id);
  // Intent-matched sets: bounded admission under the cap (see INTENT_SET_SLOTS).
  // Core + explicitly loaded sets are placed first, so a focus hint can never
  // evict them; leftovers stay callable via load_toolset / tool-call admission.
  const intentPlan = [];
  for (const name of orderedSets) {
    if (priority.has(name)) continue;
    if (!active.includes(name)) continue;
    const members = TOOLSETS[name].members.filter((id) => !seen.has(id) && pass(id) && byId.has(id)
      && !ALIAS_IDS.has(id) && !DROP_IDS.has(id) && !OPERATOR_IDS.has(id));
    intentPlan.push({
      name,
      members,
      desired: Number(maxTools) > 0 ? intentSlotsFor(name, members.length) : members.length,
      take: 0,
    });
  }
  const capped = Number(maxTools) > 0;
  if (capped && intentPlan.length) {
    let left = Math.max(0, maxTools - ordered.length - priorityBestEffort.length);
    // Pass 1: floor per matched set so no matched set is fully starved.
    const floor = Math.min(INTENT_SET_FLOOR, Math.floor(left / intentPlan.length));
    for (const plan of intentPlan) {
      plan.take = Math.max(0, Math.min(plan.desired, floor, left, plan.members.length));
      left -= plan.take;
    }
    // Pass 2: top up in set order while budget remains.
    for (const plan of intentPlan) {
      const room = Math.min(plan.desired, plan.members.length) - plan.take;
      const give = Math.max(0, Math.min(room, left));
      plan.take += give;
      left -= give;
    }
  } else {
    for (const plan of intentPlan) plan.take = plan.members.length;
  }
  for (const plan of intentPlan) {
    for (const id of plan.members.slice(0, plan.take)) push(id);
  }
  // Best-effort tail of an explicitly loaded set: fits only if cap allows
  // (never evicts core).
  for (const id of priorityBestEffort) {
    if (capped && ordered.length >= maxTools) break;
    push(id);
  }
  // Best-effort tail of the intent-matched sets (everything over its slice):
  // admitted only while the cap still has room, and logged when it does not.
  for (const plan of intentPlan) {
    for (const id of plan.members.slice(plan.take)) {
      if (capped && ordered.length >= maxTools) {
        dropped.push({ id, reason: "intent-set-over-budget" });
        continue;
      }
      push(id);
    }
  }
  if (Number(maxTools) > 0 && ordered.length > maxTools) {
    // Evict least-used CORE tails before touching any explicitly requested
    // tool. Load-bearing core is never evicted — and that now INCLUDES the
    // write/observe essentials (write_file/edit/multi_edit/list_files/
    // search_text): on 2026-09-23 a long website brief intent-matched 8
    // toolsets, the cap evicted write_file/edit/list_files, and the model
    // (correctly!) concluded it had no write tools and planned PowerShell
    // Set-Content hacks instead of building. A coding agent menu without
    // write tools is broken by definition — protect them. The middle
    // (memory/ask/web) still goes first. Priority ids are immune.
    const prioritySet = new Set(priorityIds);
    const PROTECTED_CORE = new Set(["finish", "load_toolset", "list_toolsets", "exec", "read_file", "write_file", "edit", "multi_edit", "list_files", "search_text", "delegate_task", "update_plan"]);
    const coreTailOrder = [...CORE_ORDER].reverse().filter((id) => !PROTECTED_CORE.has(id));
    for (const tailId of coreTailOrder) {
      if (ordered.length <= maxTools) break;
      if (prioritySet.has(tailId)) continue;
      const idx = ordered.findIndex((d) => d.id === tailId);
      if (idx >= 0) {
        const [rm] = ordered.splice(idx, 1);
        seen.delete(rm.id);
        dropped.push({ id: rm.id, reason: "core-tail-evicted-for-priority-toolset" });
      }
    }
    // Still over cap (huge explicit set): trim non-priority, non-core tail.
    while (ordered.length > maxTools) {
      const idx = ordered.findIndex((d) => !prioritySet.has(d.id) && !CORE_ORDER.includes(d.id));
      if (idx < 0) break;
      const [rm] = ordered.splice(idx, 1);
      seen.delete(rm.id);
      dropped.push({ id: rm.id, reason: "non-priority-toolset-trimmed-over-cap" });
    }
    // Absolute last resort: hard truncate non-priority tail (priority never cut).
    if (ordered.length > maxTools) {
      const keep = ordered.filter((d) => prioritySet.has(d.id) || PROTECTED_CORE.has(d.id));
      const cuttable = ordered.filter((d) => !prioritySet.has(d.id) && !PROTECTED_CORE.has(d.id));
      const room = Math.max(0, maxTools - keep.length);
      const keptCuttable = cuttable.slice(0, room);
      for (const rm of cuttable.slice(room)) dropped.push({ id: rm.id, reason: "hard-cap-truncate" });
      ordered.length = 0;
      for (const d of [...keep.slice(0, maxTools), ...keptCuttable].slice(0, maxTools)) ordered.push(d);
      // Re-add any priority ids lost (should not happen; safety net).
      for (const pid of prioritySet) {
        if (!ordered.some((d) => d.id === pid) && ordered.length < maxTools + prioritySet.size) {
          const def = byId.get(pid);
          if (def) ordered.push(def);
        }
      }
    }
  }
  let chars = 0;
  for (const d of ordered) {
    chars += JSON.stringify(menuSchemaForSend(d)).length;
  }
  if (dropped.length) {
    try { console.log(`[tool-menu] dropped ${dropped.length}: ${dropped.map((d) => `${d.id} (${d.reason})`).join(", ")}`); } catch { /* log-only */ }
  }
  return { defs: ordered, size: ordered.length, tokens: Math.round(chars / 4), toolsets: [...active], dropped };
}

// Intent → toolsets: keyword scoring over message+intents (deterministic).
// maxResults > 0 keeps only the top-scoring sets. Long detailed briefs
// keyword-match nearly every toolset (a website spec hit 8 sets live), and
// each active set eats menu slots under the cap — so callers building a
// real menu should cap intent matches and let the model pull anything else
// via load_toolset (discovery is free). Default 0 = unchanged (all matches).
export function toolsetsForIntent({ message = "", intents = [], maxResults = 0 } = {}) {
  const text = `${message} ${(intents || []).join(" ")}`.toLowerCase();
  const hit = [];
  for (const [name, set] of Object.entries(TOOLSETS)) {
    let score = 0;
    for (const kw of set.keywords) {
      if (kw && text.includes(kw.toLowerCase())) score++;
    }
    if (score > 0) hit.push({ name, score });
  }
  hit.sort((a, b) => b.score - a.score);
  const names = hit.map((h) => h.name);
  return maxResults > 0 ? names.slice(0, maxResults) : names;
}
