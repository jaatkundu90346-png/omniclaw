# TOOLS_AUDIT — every tool, measured (T0 audit, read-only, 2026-09-05)

## Summary (25 lines)

1. Inventoried 252 static tool defs (`tool-registry.js` + `browser-remote-tools.js`,
   zero duplicate keys) + 21 live MCP tools + ~6 forged/plugin = ~279 reachable;
   isolated API lists 265 total / 184 model-callable. ("294" ≈ +product-mode variants.)
2. What works: workspace fs/shell/browser/memory/tasks core (4905 transcript calls
   across 167 transcripts, 80 tools used); approvals (4B.1); MCP Composio live (21);
   heartbeat autonomy; skill matching; dream sweep mechanics.
3. Aspirational: post-task reflection/skill-extraction (ReflectionEngine never runs
   in main loop), cron (0 schedules), messaging flows (~0 live traffic),
   `delegate_task` (14/15 failed), canvas/HA/kanban/TTS placeholders.
4. Problem #1 — context overload: workspaceContext is 68% of a 66.7k-char turn;
   ALL memory sections omitted 0-kept; model sees 64 tools max while 184 are callable.
5. Problem #2 — the 64-tool cap silently cuts 9 CORE_ORDER tools incl.
   `provider_status`, `provider_keys`, `switch_model`, `computer_access_status`.
6. Problem #3 — loop friction dominates failures: repeat/dedupe guards cause more
   blocks (exec 174) than approvals; PowerShell `&&` syntax errors; opaque `true` errors.
7. Problem #4 — 19 compat aliases + 17 placeholders inflate the menu and confuse
   discovery (`code_execution`/`process`/`open_browser_url` NEVER called).
8. Problem #5 — 10 self-modifying tools are model-callable (profiles/keys/config/
   skills/agents); no approval-gated self-change path exists.
9. Proposed layers: RUNTIME 0 (nothing fully automatic today) / CORE 23 (+3 alias
   shims) / TOOLSET browser 35, project 25, skills 13, shell 14, harness 14,
   messaging 10, memory 10, media 9, agents 9, computer 8, provider 4, tasks-auto 5,
   web 3, git 1, mcp 1+21 dynamic / OPERATOR 32 / ALIAS 19 / DROP 17.
10. Token win: menu today ~21.2k chars (~5.3k tok/round) → CORE-26 ~7.3k (~1.8k),
    CORE+browser ~14.5k (~3.6k). Static prompt skeleton is only 9.0k chars.
11. No code changed in this audit. Method: static parse (1 run) + live transcript
    counts (167 files, read-only) + 30 isolated health probes (29 OK) + route/API
    evidence. Per-tool health verdicts use those three sources only.

## Method & sources

- Inventory: static parse of `src/core/tool-registry.js` (this.tools map, 6-space
  entries with `run:`) + `src/core/browser-remote-tools.js` (11). 37 nested-key
  false positives excluded (no `run:`). Audience = live `GET /api/tools`
  `modelCallable` (isolated :3199: 265 total, 184 true).
- Usage: `data/sessions/transcripts/*.jsonl` (167 files, read-only): 4905 calls;
  ok = no error/blocked flags; blocked = `blocked`/pending-approval; else failed.
- Health: `POST /api/tools/run` on :3199 for 30 read-only tools (29 OK,
  `mcp_integration_status` ERR); otherwise `transcript-OK(n)` or `not run`.
- Token math replicates `omni-loop.js:buildToolSchemas` (description slice 1024 +
  full schema literal) over `CORE_TOOL_ORDER` (:732) with cap 64 (default,
  `:851`) — i.e. exactly what the model receives with no task boost.
- `calls` column format: `total/ok/blocked/failed`.

## B0. Full table (252 static rows; dynamic MCP/forged/plugin rows follow it)

| name | file:line | subsystem | audience | params (required) | purpose | policy | calls ok/blk/fail | health | proposed layer |
|---|---|---|---|---|---|---|---|---|---|
| time_now | tool-registry.js:1063 | misc | model | (0 opt) | Get the current local time in ISO format. | null | 6/5/1/0 | probe-OK (isolated, read-only) | CORE |
| connected_apps_status | tool-registry.js:1070 | connected-apps | model | (0 opt) | Show connected apps (GitHub, Gmail) and the current Computer Use permission. OAuth tokens are never  | null | 1/1/0/0 | transcript-OK (1) | TOOLSET:messaging |
| github_list_repositories | tool-registry.js:1076 | channels | model | (2 opt) | List repositories from the user's connected GitHub account. Requires a GitHub connection approved in | allowConnectorWrite | — | not run | TOOLSET:messaging |
| github_search_issues | tool-registry.js:1083 | channels | model | query | Search issues and pull requests in the user's connected GitHub account. Requires a GitHub connection | allowConnectorWrite | — | not run | TOOLSET:messaging |
| gmail_search_messages | tool-registry.js:1090 | channels | model | (2 opt) | Search message metadata from the user's connected Gmail account. Read-only: returns sender, subject, | allowConnectorWrite | — | not run | TOOLSET:messaging |
| gmail_get_message | tool-registry.js:1097 | channels | model | id | Read metadata and a short snippet for one Gmail message from a prior gmail_search_messages result. R | allowConnectorWrite | — | not run | TOOLSET:messaging |
| update_plan | tool-registry.js:1104 | sessions/ops | model | steps | Create or update your step-by-step plan for the current task (the scope surface). Pass the FULL plan | null | 292/288/4/0 | transcript-OK (292) | CORE |
| remember_note | tool-registry.js:1188 | memory | model | text | Save a short note into persistent memory. | allowNoteWrite | 2/2/0/0 | transcript-OK (2) | TOOLSET:memory |
| memory_write | tool-registry.js:1205 | memory | model | content | Save a memory. type='long-term' for DURABLE facts to remember across ALL future sessions (user ident | allowMemoryWrite | 2/2/0/0 | transcript-OK (2) | CORE |
| list_notes | tool-registry.js:1230 | memory | model | (0 opt) | List all saved notes. | null | — | probe-OK (isolated, read-only) | TOOLSET:memory |
| list_long_term_memory | tool-registry.js:1237 | memory | model | (0 opt) | List promoted long-term memories for the active agent. | null | — | probe-OK (isolated, read-only) | TOOLSET:memory |
| promote_memory | tool-registry.js:1246 | memory | model | (0 opt) | Promote a note, conversation, research item, or manual text into long-term memory. | allowMemoryPromotion | — | not run | TOOLSET:memory |
| memory_replace | tool-registry.js:1255 | memory | model | match,text | Fix or update an EXISTING long-term memory in place. Find it by a short substring of its title/text  | allowMemoryWrite | — | not run | TOOLSET:memory |
| memory_forget | tool-registry.js:1276 | memory | model | match | Delete a long-term memory that is stale, wrong, or no longer relevant. Find it by a short substring  | allowMemoryWrite | — | not run | TOOLSET:memory |
| dream_memory_sweep | tool-registry.js:1293 | memory | model | (0 opt) | Run a lightweight memory review that promotes high-value candidates. | allowDreamSweep | — | not run | TOOLSET:memory |
| scan_file_drop | tool-registry.js:1303 | channels | operator | (0 opt) | Scan the local data/inbox folder and process new text files as connector messages. | allowConnectorWrite | — | not run | TOOLSET:media |
| cleanup_attachment_cache | tool-registry.js:1316 | channels/media | operator | (0 opt) | Apply the attachment retention policy and purge old or oversized cached connector files. | allowConnectorWrite | — | not run | TOOLSET:media |
| analyze_attachment_media | tool-registry.js:1330 | channels/media | operator | (0 opt) | Run OCR/transcription media analysis for one cached media attachment extract. | allowConnectorWrite | — | not run | TOOLSET:media |
| analyze_pending_media_attachments | tool-registry.js:1347 | channels/media | operator | (0 opt) | Analyze recent pending image, PDF, audio, or video attachment metadata records. | allowConnectorWrite | — | not run | TOOLSET:media |
| create_task | tool-registry.js:1361 | autonomy | model | (0 opt) | Create a task in the local task list. | allowTaskWrite | — | not run | CORE |
| list_tasks | tool-registry.js:1390 | autonomy | model | (0 opt) | List tracked local tasks. | null | 5/5/0/0 | probe-OK (isolated, read-only) | CORE |
| todo | tool-registry.js:1397 | autonomy | model | (0 opt) | Hermes-compatible todo/task tool. | allowTaskWrite | — | not run | ALIAS (create_task) |
| runtime_summary | tool-registry.js:1409 | misc | operator | (0 opt) | Summarize current runtime profile and provider mode. | null | — | not run | OPERATOR |
| provider_status | tool-registry.js:1426 | providers/mcp | model | (0 opt) | Diagnose the active model/provider brain, auth readiness, command path, and next fix. | null | 12/12/0/0 | probe-OK (isolated, read-only) | TOOLSET:provider |
| prompt_trace | tool-registry.js:1474 | sessions/ops | operator | (0 opt) | Inspect the sanitized prompt/context trace for a completed run. | null | — | not run | OPERATOR |
| prompt_assembly_status | tool-registry.js:1492 | runtime | operator | (0 opt) | Hermes-style prompt assembly report: identity files, project context discovery, injection defense, a | null | — | not run | OPERATOR |
| tool_trace | tool-registry.js:1498 | sessions/ops | operator | (0 opt) | Inspect the per-run tool execution ledger with inputs, outputs, status, and timing. | null | — | not run | OPERATOR |
| v2_status | tool-registry.js:1516 | runtime | operator | (0 opt) | OmniClaw V2 feature health report with scores, weak features, evidence, and gaps. | null | — | probe-OK (isolated, read-only) | OPERATOR |
| v2_repair_plan | tool-registry.js:1527 | sessions/ops | operator | (0 opt) | Generate a prioritized OmniClaw V2 repair plan from the live feature health report. | null | — | not run | OPERATOR |
| capability_demo | tool-registry.js:1551 | runtime | operator | (0 opt) | Return a practical demo of the active agent's real tools, skills, and example tasks. | null | — | not run | OPERATOR |
| real_task_health | tool-registry.js:1619 | autonomy | model | (0 opt) | Run a product-grade real-task health probe across tools, skills, provider, files, terminal, browser, | null | — | probe-OK (isolated, read-only) | TOOLSET:tasks-auto |
| layer_status | tool-registry.js:1628 | misc | operator | (0 opt) | Report OmniClaw's OpenClaw-style layer 1-5 architecture status, gaps, and next upgrades. | null | — | probe-OK (isolated, read-only) | OPERATOR |
| self_build_plan | tool-registry.js:1638 | sessions/ops | operator | (0 opt) | Create a Codex + OpenClaw implementation plan for improving OmniClaw itself. | null | — | probe-OK (isolated, read-only) | TOOLSET:skills |
| list_files | tool-registry.js:1734 | execution/workspace | model | (4 opt) | List files in a workspace directory. Set recursive=true to map a whole subtree in one call (skips no | allowDirectoryList | 193/181/5/7 | transcript-OK (193) | CORE |
| computer_access_status | tool-registry.js:1756 | execution/shell-computer | model | (0 opt) | Show configured laptop/computer access roots, terminal policy, and browser capability. | null | — | probe-OK (isolated, read-only) | TOOLSET:shell |
| search_computer_files | tool-registry.js:1802 | execution/shell-computer | model | (5 opt) | Search file and folder names across configured laptop access roots. | allowComputerAccess | 2/2/0/0 | transcript-OK (2) | TOOLSET:computer |
| computer_access_audit | tool-registry.js:1825 | execution/shell-computer | operator | (0 opt) | List recent governed computer-access operations captured in the gateway audit feed. | allowComputerAccess | — | not run | TOOLSET:shell |
| list_computer_directory | tool-registry.js:1832 | execution/shell-computer | model | (1 opt) | List files from configured laptop access roots such as the user home folder. | allowComputerAccess | 10/10/0/0 | transcript-OK (10) | TOOLSET:computer |
| read_computer_file | tool-registry.js:1847 | execution/shell-computer | model | path | Read a text file from configured laptop access roots. | allowComputerAccess | 24/24/0/0 | transcript-OK (24) | TOOLSET:computer |
| write_computer_file | tool-registry.js:1870 | execution/shell-computer | model | path,content | Write or append a text file inside configured laptop access roots. | allowComputerAccess | 12/12/0/0 | transcript-OK (12) | TOOLSET:computer |
| create_computer_directory | tool-registry.js:1891 | execution/shell-computer | model | path | Create a directory inside configured laptop access roots. | allowComputerAccess | — | not run | TOOLSET:computer |
| copy_computer_path | tool-registry.js:1907 | execution/shell-computer | model | from,to | Copy a file or folder between configured laptop access roots. | allowComputerAccess | — | not run | TOOLSET:computer |
| move_computer_path | tool-registry.js:1930 | execution/shell-computer | model | from,to | Move or rename a file or folder inside configured laptop access roots. | allowComputerAccess | — | not run | TOOLSET:computer |
| delete_computer_path | tool-registry.js:1953 | execution/shell-computer | model | path | Delete a file or folder inside configured laptop access roots. By default it moves the item to data/ | allowComputerAccess | — | not run | TOOLSET:computer |
| read_file | tool-registry.js:1991 | execution/workspace | model | path | Read a text file from the workspace. Returns a line-numbered view by default so you can map an error | allowFileRead | 1469/1309/60/100 | transcript-OK (1469) | CORE |
| search_text | tool-registry.js:2021 | execution/workspace | model | pattern | Search file CONTENTS across the workspace with a regular expression (grep). Returns matching file pa | allowFileRead | 105/102/0/3 | transcript-OK (105) | CORE |
| write_file | tool-registry.js:2046 | execution/workspace | model | path,content | Write a text file inside protected writable roots. | allowFileWrite | 384/336/38/10 | transcript-OK (384) | CORE |
| append_file | tool-registry.js:2065 | misc | model | path,content | Append text to a file inside protected writable roots. | allowFileWrite | — | not run | ALIAS (write_file (append mode backend)) |
| create_directory | tool-registry.js:2084 | misc | model | path | Create a folder (and any missing parent folders) in the project workspace. Cross-platform — ALWAYS u | allowFileWrite | 11/11/0/0 | transcript-OK (11) | CORE |
| verify_html_artifact | tool-registry.js:2101 | misc | model | (0 opt) | Verify a generated HTML artifact is nonblank, structured, and has interactive app pieces. | allowFileRead | 6/2/0/4 | transcript-OK (6) | TOOLSET:project |
| plan_shell_command | tool-registry.js:2190 | execution/shell-computer | model | request | Prepare a shell-command request that requires later approval. | allowShellPlanning | 4/4/0/0 | transcript-OK (4) | TOOLSET:shell |
| exec_approval_status | tool-registry.js:2208 | execution/shell-computer | model | (0 opt) | Inspect OmniClaw terminal/exec approval policy: trust level, allowlist mode, safe defaults, and what | null | 1/1/0/0 | probe-OK (isolated, read-only) | TOOLSET:shell |
| web_research | tool-registry.js:2233 | web | model | query | Search the web, fetch/read the best result pages, and return grounded page text for the LLM to synth | allowWebResearch | 17/17/0/0 | transcript-OK (17) | CORE |
| read_url | tool-registry.js:2255 | execution/workspace | model | url | Fetch and read the text content of a specific public URL. | allowWebResearch | 4/4/0/0 | transcript-OK (4) | CORE |
| open_browser_url | tool-registry.js:2269 | misc | model | (0 opt) | Open a URL in the laptop's default browser. | allowBrowserControl | — | not run | ALIAS (browser_open (OS browser, uncontrolled)) |
| run_terminal_command | tool-registry.js:2281 | execution/shell-computer | model | command | Execute a terminal command through OmniClaw shell policy and audit logging. | allowShellExecution | 30/11/10/9 | transcript-OK (30) | CORE |
| sandbox_status | tool-registry.js:2305 | execution/shell-computer | model | (0 opt) | Show the governed temp-workspace sandbox status, limits, and capabilities. | null | — | probe-OK (isolated, read-only) | TOOLSET:shell |
| sandbox_run | tool-registry.js:2311 | execution/shell-computer | model | (0 opt) | Run a shell command in an isolated temp workspace copy and report changed files without touching the | allowShellExecution | — | not run | TOOLSET:shell |
| sandbox_apply | tool-registry.js:2317 | execution/shell-computer | model | (0 opt) | Apply selected changed files from a sandbox run into the real workspace. | allowFileWrite | — | not run | TOOLSET:shell |
| list_processes | tool-registry.js:2323 | execution/shell-computer | operator | (0 opt) | List currently running system processes (Windows). | allowShellExecution | — | not run | ALIAS |
| exec | tool-registry.js:2328 | execution/shell-computer | model | command | Execute a shell command with optional background mode. Use background=true for long-running commands | allowShellExecution | 1024/541/177/306 | transcript-OK (1024) | CORE |
| computer_system_status | tool-registry.js:2397 | execution/shell-computer | model | (0 opt) | Check laptop RAM, CPU, OS, and disk storage status. | null | — | probe-OK (isolated, read-only) | TOOLSET:shell |
| run_task | tool-registry.js:2402 | autonomy | model | (0 opt) | Run the latest open task or a task by id. | allowTaskRunner | — | not run | TOOLSET:tasks-auto |
| create_skill | tool-registry.js:2410 | skills/learning | model | (0 opt) | Create a new local skill file for OmniClaw. | allowSkillWrite | — | not run | TOOLSET:skills |
| ask_user | tool-registry.js:2424 | interaction | model | question,options | Ask the USER a decision question MID-RUN and wait for their answer (an interactive card appears in c | null | 4/4/0/0 | transcript-OK (4) | CORE |
| build_tool | tool-registry.js:2508 | skills/learning | model | name,description,code | BUILD YOUR OWN TOOL when no existing tool fits the task: write plain JS defining `async function run | allowSkillWrite | 12/4/1/7 | transcript-OK (12) | TOOLSET:skills |
| test_tool | tool-registry.js:2555 | skills/learning | model | name | Run one of YOUR self-built tools with a given input to verify its behavior (returns output + capture | null | 10/9/0/1 | transcript-OK (10) | TOOLSET:skills |
| list_custom_tools | tool-registry.js:2574 | skills/learning | model | (0 opt) | List the tools this agent has built for itself (name, description, when). | null | 10/9/1/0 | transcript-OK (10) | TOOLSET:skills |
| remove_custom_tool | tool-registry.js:2588 | skills/learning | model | name | Delete a self-built tool (its workspace/tools/<name> directory is removed). | allowSkillWrite | — | not run | TOOLSET:skills |
| openclaw_vendor_status | tool-registry.js:2599 | openclaw | operator | (0 opt) | Inspect the vendored OpenClaw reference checkout and license metadata. | null | — | probe-OK (isolated, read-only) | OPERATOR |
| openclaw_code_study | tool-registry.js:2608 | openclaw | operator | (0 opt) | Study the vendored OpenClaw source tree and produce an OmniClaw implementation map. | null | — | not run | OPERATOR |
| hermes_reference_status | tool-registry.js:2618 | hermes | operator | (0 opt) | Summarize Hermes Agent reference ideas and map them to OmniClaw's current runtime. | null | — | probe-OK (isolated, read-only) | OPERATOR |
| hermes_vendor_status | tool-registry.js:2688 | hermes | operator | (0 opt) | Inspect the vendored Hermes Agent reference copy and license metadata. | null | — | not run | OPERATOR |
| hermes_skill_scan | tool-registry.js:2694 | skills/learning | operator | (0 opt) | Scan vendored Hermes Agent SKILL.md files for possible OmniClaw imports. | null | — | not run | OPERATOR |
| hermes_tool_catalog | tool-registry.js:2700 | hermes | operator | (0 opt) | List Hermes Agent core tools and their OmniClaw compatibility/adaptation status. | null | — | not run | OPERATOR |
| context_compression_status | tool-registry.js:2706 | runtime | operator | (0 opt) | Hermes-style context compression status: head/middle/tail, summary framing, token budget awareness. | null | — | probe-OK (isolated, read-only) | OPERATOR |
| memory_lifecycle_status | tool-registry.js:2715 | memory | operator | (0 opt) | Hermes-style memory lifecycle status: prefetch, fenced memory block, sync, dream sweep, and session  | null | — | probe-OK (isolated, read-only) | TOOLSET:memory |
| skill_system_status | tool-registry.js:2725 | skills/learning | operator | (0 opt) | Hermes-style skills system status: progressive disclosure, agentskills compatibility, and self-impro | null | — | probe-OK (isolated, read-only) | TOOLSET:skills |
| messaging_gateway_status | tool-registry.js:2734 | sessions/ops | operator | (0 opt) | Hermes-style messaging gateway status: adapters, session routing, voice/media ingestion, and DM secu | null | — | probe-OK (isolated, read-only) | OPERATOR |
| configure_telegram | tool-registry.js:2743 | channels | model | (0 opt) | Connect Telegram: verify a bot token live against the Telegram API, save it, clear any webhook that  | allowConnectorWrite | 5/1/2/2 | transcript-OK (5) | TOOLSET:messaging |
| telegram_status | tool-registry.js:2753 | channels | model | (0 opt) | Live Telegram health check: is the saved bot token valid, which bot is it, is the polling worker run | null | 1/1/0/0 | transcript-OK (1) | TOOLSET:messaging |
| telegram_send | tool-registry.js:2762 | channels | model | (0 opt) | Send a Telegram message directly to a chat id or @channelusername using the configured bot. Use this | allowConnectorWrite | 1/0/0/1 | transcript-OK (1) | TOOLSET:messaging |
| terminal_backends_status | tool-registry.js:2771 | execution/shell-computer | operator | (0 opt) | Hermes-style terminal backend status: local/docker/ssh/cloud backends, process registry, and approva | null | — | probe-OK (isolated, read-only) | TOOLSET:shell |
| model_provider_status | tool-registry.js:2780 | providers/mcp | operator | (0 opt) | Hermes-style multi-provider model support status: API mode, credential pool, failover, and model dis | null | — | not run | OPERATOR |
| subagent_delegation_status | tool-registry.js:2789 | agents/harness | operator | (0 opt) | Hermes-style subagent delegation status: isolation, blocked child tools, concurrency, and shared bud | null | — | probe-OK (isolated, read-only) | TOOLSET:agents |
| mcp_integration_status | tool-registry.js:2798 | providers/mcp | model | (0 opt) | Hermes-style MCP integration status: configured servers, live tool registry, aliases, and ACP gap. | null | 12/0/3/9 | probe-ERR (MCP not found) | OPERATOR |
| mcp_connect_all | tool-registry.js:2807 | providers/mcp | model | (0 opt) | Connect all configured MCP servers and refresh their live tool registry. | allowConfigWrite | 2/0/1/1 | transcript-OK (2) | TOOLSET:mcp |
| cron_scheduler_status | tool-registry.js:2816 | autonomy | operator | (0 opt) | Hermes-style built-in cron scheduler status: schedules, background jobs, triggers, and delivery path | null | 2/2/0/0 | probe-OK (isolated, read-only) | TOOLSET:tasks-auto |
| trajectory_training_status | tool-registry.js:2826 | research | operator | (0 opt) | Hermes-style trajectory generation and RL training status for agent runs/tool traces. | null | — | probe-OK (isolated, read-only) | OPERATOR |
| closed_learning_loop_status | tool-registry.js:2835 | learning | operator | (0 opt) | Hermes-style closed learning loop status: session logging, memory nudges, skill promotion, and next  | null | — | probe-OK (isolated, read-only) | OPERATOR |
| hermes_use_cases_status | tool-registry.js:2844 | runtime | operator | (0 opt) | Map Hermes use-case categories to OmniClaw's current real capabilities and gaps. | null | — | not run | OPERATOR |
| design_principles_status | tool-registry.js:2853 | runtime | operator | (0 opt) | Report Hermes-style design principles and OmniClaw compliance/gaps. | null | — | not run | OPERATOR |
| openclaw_skill_scan | tool-registry.js:2862 | skills/learning | operator | (0 opt) | Scan vendored OpenClaw SKILL.md files for possible OmniClaw imports. | null | — | not run | OPERATOR |
| openclaw_skill_import | tool-registry.js:2872 | skills/learning | operator | (0 opt) | Import one vendored OpenClaw SKILL.md into OmniClaw's local .skill format. | allowSkillWrite | — | not run | TOOLSET:skills |
| openclaw_skill_pack_import | tool-registry.js:2878 | skills/learning | operator | (0 opt) | Import a curated OpenClaw compatibility skill pack into OmniClaw agents. | allowSkillWrite | — | not run | TOOLSET:skills |
| update_runtime_settings | tool-registry.js:2884 | misc | operator | (0 opt) | Update OmniClaw runtime profile or provider mode. | allowConfigWrite | — | not run | OPERATOR |
| apply_provider_profile | tool-registry.js:2889 | providers/mcp | model | (0 opt) | Apply a saved provider profile. | allowConfigWrite | — | not run | OPERATOR |
| save_provider_profile | tool-registry.js:2894 | providers/mcp | model | name,baseUrl,model | Add or update a CUSTOM named provider from a base URL + API key (any OpenAI-compatible endpoint). Th | allowConfigWrite | — | not run | OPERATOR |
| delete_provider_profile | tool-registry.js:2912 | providers/mcp | model | profileId | Delete a user-added custom provider profile (built-in defaults can't be removed). | allowConfigWrite | — | not run | OPERATOR |
| set_provider_key | tool-registry.js:2926 | providers/mcp | operator | (0 opt) | Store a BYOK provider key locally. | allowConfigWrite | — | not run | OPERATOR |
| configure_provider_brain | tool-registry.js:2931 | providers/mcp | model | (0 opt) | Atomically configure provider profile, base URL, model, API key, and readiness test. | allowConfigWrite | — | not run | OPERATOR |
| get_provider_key_status | tool-registry.js:2937 | providers/mcp | operator | (0 opt) | Read provider BYOK key status (masked only). | allowConfigWrite | — | not run | OPERATOR |
| test_provider_profile | tool-registry.js:2942 | providers/mcp | model | (0 opt) | Validate provider profile and key readiness. | allowConfigWrite | — | not run | TOOLSET:provider |
| list_provider_models | tool-registry.js:2947 | providers/mcp | model | (0 opt) | Fetch available models from the selected provider's /models endpoint. | allowConfigWrite | 2/2/0/0 | transcript-OK (2) | TOOLSET:provider |
| process_list | tool-registry.js:2958 | execution/shell-computer | model | (0 opt) | List background processes started by OmniClaw. | null | — | probe-OK (isolated, read-only) | TOOLSET:shell |
| process_status | tool-registry.js:2969 | execution/shell-computer | model | (1 opt) | Get detailed status and captured output for a background process. processId is optional — omitted or | null | 135/58/38/39 | transcript-OK (135) | CORE |
| process_kill | tool-registry.js:2981 | execution/shell-computer | model | processId | Kill a running background process by ID. | allowShellExecution | 5/5/0/0 | transcript-OK (5) | TOOLSET:shell |
| process_cleanup | tool-registry.js:2996 | execution/shell-computer | model | (0 opt) | Remove old completed/killed process entries from the registry. | null | — | not run | TOOLSET:shell |
| process | tool-registry.js:3002 | execution/shell-computer | model | (0 opt) | OpenClaw-compatible process inspection tool. | allowShellExecution | — | not run | TOOLSET:shell |
| code_act | tool-registry.js:3008 | runtime | model | script | CodeAct: run ONE JavaScript script that orchestrates MANY tool calls with loops, conditions, and var | allowFileWrite | 6/2/0/4 | transcript-OK (6) | TOOLSET:project |
| harness_evolution_status | tool-registry.js:3022 | agents/harness | model | (0 opt) | Self-evolving harness status: the evidence collected from past runs (guard-nudge rates, success rate | null | — | probe-OK (isolated, read-only) | TOOLSET:harness |
| restore_checkpoint | tool-registry.js:3028 | file | model | (3 opt) | Rewind a file to how it was BEFORE this run edited it (checkpoint rollback). The harness snapshots e | allowFileWrite | 1/1/0/0 | transcript-OK (1) | TOOLSET:project |
| code_execution | tool-registry.js:3078 | execution/shell-computer | model | (0 opt) | Run a small Python snippet through governed terminal execution. | allowShellExecution | — | not run | TOOLSET:shell |
| execute_code | tool-registry.js:3092 | execution/shell-computer | model | (0 opt) | Hermes-compatible Python code execution alias. | allowShellExecution | — | not run | ALIAS (code_execution) |
| auto_review | tool-registry.js:3098 | code | model | (0 opt) | Run a Codex/OpenClaw-style self-review pass: inspect git changes, run validation, and return actiona | allowShellExecution | — | not run | TOOLSET:project |
| browser_status | tool-registry.js:3266 | ui | model | (0 opt) | Check browser automation availability, current sessions, and whether browser_* is currently driving  | null | 1/1/0/0 | probe-OK (isolated, read-only) | TOOLSET:browser |
| browser_open | tool-registry.js:3281 | execution/browser-Hermes | model | url | Open a URL in a real browser session. Uses the USER'S OWN running browser (their profile and logins, | allowBrowserControl | 182/118/40/24 | transcript-OK (182) | CORE |
| browser_view | tool-registry.js:3299 | execution/browser-Hermes | model | (2 opt) | View current page content and/or screenshot. Format: markdown, screenshot, or both. | allowBrowserControl | 66/22/9/35 | transcript-OK (66) | TOOLSET:browser |
| browser_audit | tool-registry.js:3313 | ui | operator | (0 opt) | List recent governed browser actions captured in the gateway audit feed. | null | — | not run | TOOLSET:browser |
| browser_snapshot | tool-registry.js:3322 | execution/browser-Hermes | model | (3 opt) | Hermes-compatible browser snapshot: accessibility-style text tree plus stable @e refs for click/type | allowBrowserControl | 1/0/1/0 | transcript-OK (1) | TOOLSET:browser |
| browser_links | tool-registry.js:3341 | ui | model | (0 opt) | Extract visible links from the current automated browser page. | allowBrowserControl | 1/1/0/0 | transcript-OK (1) | TOOLSET:browser |
| browser_screenshot | tool-registry.js:3348 | execution/browser-Hermes | model | (4 opt) | Capture a screenshot from the current automated browser page. | allowBrowserControl | 47/37/8/2 | transcript-OK (47) | CORE |
| browser_text | tool-registry.js:3368 | ui | model | (0 opt) | Extract visible text from the current automated browser page. | allowBrowserControl | 4/0/4/0 | transcript-OK (4) | TOOLSET:browser |
| browser_navigate | tool-registry.js:3375 | execution/browser-Hermes | model | url | Hermes-compatible browser navigation tool. Must be called before other browser tools. | allowBrowserControl | 3/1/2/0 | transcript-OK (3) | TOOLSET:browser |
| browser_click | tool-registry.js:3390 | execution/browser-Hermes | model | (4 opt) | Click an element on the current browser page using a Hermes @e ref from browser_snapshot or a CSS se | allowBrowserControl | 15/4/3/8 | transcript-OK (15) | TOOLSET:browser |
| browser_type | tool-registry.js:3410 | execution/browser-Hermes | model | text | Type text into an input field using a Hermes @e ref from browser_snapshot or a CSS selector. Clears  | allowBrowserControl | 5/2/0/3 | transcript-OK (5) | TOOLSET:browser |
| browser_scroll | tool-registry.js:3432 | execution/browser-Hermes | model | (0 opt) | Hermes-compatible browser scroll tool. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_back | tool-registry.js:3443 | execution/browser-Hermes | model | (0 opt) | Hermes-compatible browser back tool. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_forward | tool-registry.js:3454 | execution/browser-Hermes | model | (0 opt) | Hermes-compatible browser forward tool. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_wait | tool-registry.js:3461 | execution/browser-Hermes | model | (3 opt) | Wait for a selector in the active browser session. | allowBrowserControl | 1/1/0/0 | transcript-OK (1) | TOOLSET:browser |
| browser_evaluate | tool-registry.js:3476 | execution/browser-Hermes | model | script | Evaluate JavaScript in the active browser session and READ the returned value in the tool result. En | allowBrowserEvaluate | 11/4/7/0 | transcript-OK (11) | TOOLSET:browser |
| browser_close | tool-registry.js:3492 | execution/browser-Hermes | model | (0 opt) | Close a browser session. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_automate | tool-registry.js:3499 | execution/browser-Hermes | model | (0 opt) | Perform multiple browser actions in sequence with Playwright. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_sessions | tool-registry.js:3506 | execution/browser-Hermes | model | (0 opt) | List active Playwright browser sessions. | null | — | not run | TOOLSET:browser |
| browser_press | tool-registry.js:3512 | execution/browser-Hermes | model | (4 opt) | Hermes-compatible browser key press tool. Defaults to pressing on body; can target a ref/selector. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_get_images | tool-registry.js:3532 | execution/browser-Hermes | model | (1 opt) | Hermes-compatible browser image discovery tool. Returns image URLs and alt text from the current pag | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_vision | tool-registry.js:3545 | execution/browser-Hermes | operator | (0 opt) | Hermes-compatible browser screenshot/vision bridge. Captures a screenshot and optional ref metadata  | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_console | tool-registry.js:3552 | execution/browser-Hermes | model | (3 opt) | Hermes-compatible browser console reader. Returns console/warn/error/pageerror messages and can eval | allowBrowserEvaluate | — | not run | TOOLSET:browser |
| browser_cdp | tool-registry.js:3567 | execution/browser-Hermes | model | method | Hermes-compatible raw Chrome DevTools Protocol escape hatch for the active page. | allowBrowserEvaluate | — | not run | TOOLSET:browser |
| browser_dialog | tool-registry.js:3583 | execution/browser-Hermes | model | (4 opt) | Hermes-compatible browser dialog control. Pre-arm accept/dismiss/type for the next alert/confirm/pro | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_tap | tool-registry.js:3599 | execution/browser-Hermes | model | (5 opt) | Tap an element by Hermes @e ref/CSS selector or by x/y coordinates (touchscreen tap with mouse fallb | allowBrowserControl | — | not run | TOOLSET:browser |
| web_search | tool-registry.js:3617 | web | model | query | OpenClaw-compatible web search alias that also fetches the best result pages when fetchTop is enable | allowWebResearch | 13/13/0/0 | transcript-OK (13) | ALIAS (brave/exa_search+fetch) |
| brave_search | tool-registry.js:3653 | web | model | (0 opt) | Search the web through Brave Search when a Brave key is configured; returns structured URL/title/sni | allowWebResearch | — | not run | TOOLSET:web |
| exa_search | tool-registry.js:3683 | web | model | (0 opt) | Search the web through Exa neural/keyword search when an Exa key is configured; can request highligh | allowWebResearch | — | not run | TOOLSET:web |
| web_extract | tool-registry.js:3708 | hermes-web | operator | (0 opt) | Hermes-compatible URL extraction/fetch alias. | allowWebResearch | — | not run | ALIAS (read_url) |
| x_search | tool-registry.js:3714 | web | model | (0 opt) | Search public web results scoped toward X/Twitter posts. | allowWebResearch | — | not run | TOOLSET:web |
| web_fetch | tool-registry.js:3720 | web | model | url | OpenClaw-compatible URL fetch alias. | allowWebResearch | 41/33/1/7 | transcript-OK (41) | ALIAS (read_url) |
| read | tool-registry.js:3734 | execution/workspace | operator | path | OpenClaw-compatible workspace file read alias. | allowFileRead | — | not run | ALIAS (read_file) |
| write | tool-registry.js:3747 | execution/workspace | operator | path,content | OpenClaw-compatible workspace file write alias. | allowFileWrite | — | not run | ALIAS (write_file/append_file) |
| edit | tool-registry.js:3763 | execution/workspace | model | path,find | Edit a workspace file by replacing text. Matching tolerates whitespace/indentation, smart-quote, and | allowFileWrite | 305/251/8/46 | transcript-OK (305) | CORE |
| multi_edit | tool-registry.js:3828 | fs | model | path,edits | Apply several find/replace edits to ONE file in a single atomic operation. All edits are validated f | allowFileWrite | 38/25/4/9 | transcript-OK (38) | TOOLSET:project |
| apply_patch | tool-registry.js:3901 | execution/workspace | model | (0 opt) | Apply an OpenClaw/Codex structured patch to workspace files, then return changed paths and verificat | allowFileWrite | — | not run | TOOLSET:project |
| update_progress | tool-registry.js:3907 | state | model | (5 opt) | Maintain a persistent PROGRESS.md at the project root for long or multi-session tasks (state subsyst | allowFileWrite | 11/11/0/0 | transcript-OK (11) | TOOLSET:project |
| read_progress | tool-registry.js:3957 | execution/workspace | model | (0 opt) | Read the project's PROGRESS.md (state subsystem) to resume a long/multi-session task. Call this at t | allowFileRead | 22/22/0/0 | transcript-OK (22) | TOOLSET:project |
| sprint_contract | tool-registry.js:3964 | sessions/ops | model | (6 opt) | Process observability: record the upfront agreement for the current work block BEFORE coding — scope | allowFileWrite | 4/4/0/0 | transcript-OK (4) | TOOLSET:project |
| read_sprint_contract | tool-registry.js:4017 | execution/workspace | model | (0 opt) | Read the current SPRINT.md (process observability) — the upfront scope/do-not-touch/pass-criteria ag | allowFileRead | — | not run | TOOLSET:project |
| feature_list | tool-registry.js:4031 | sessions/ops | model | (0 opt) | Read the project's feature_list.json — the machine-readable single source of truth for scope. Each f | allowFileRead | 9/9/0/0 | transcript-OK (9) | TOOLSET:project |
| feature_set | tool-registry.js:4055 | sessions/ops | model | features | Define or update features in feature_list.json (the scope spec). Each feature needs the TRIPLE: beha | allowFileWrite | 3/3/0/0 | transcript-OK (3) | TOOLSET:project |
| session_handoff | tool-registry.js:4126 | sessions/ops | model | (3 opt) | Run the end-of-session clean-state check (lecture 12) and return a clean-handoff verdict. Checks all | allowShellExecution | 2/1/1/0 | transcript-OK (2) | CORE |
| task_trace | tool-registry.js:4140 | autonomy | model | (1 opt) | Runtime observability: get a replayable decision-path timeline for a run (the current run by default | null | 3/3/0/0 | transcript-OK (3) | TOOLSET:project |
| check_boundaries | tool-registry.js:4183 | verification | model | (0 opt) | Run the project's architectural boundary rules (arch_rules.json) as executable checks — e.g. 'render | allowFileRead | — | not run | TOOLSET:project |
| add_check | tool-registry.js:4190 | verification | model | id,forbidden,fix | Review-feedback promotion: add (or update) an architectural boundary rule to arch_rules.json so a re | allowFileWrite | — | not run | TOOLSET:project |
| verify_done | tool-registry.js:4227 | verification | model | (4 opt) | Externalized three-layer termination check (run this BEFORE saying a coding task is done — don't tru | allowShellExecution | 4/4/0/0 | transcript-OK (4) | TOOLSET:project |
| feature_verify | tool-registry.js:4242 | sessions/ops | model | id | Pass-state gate for a feature: runs the feature's verification command and marks it 'passing' ONLY i | allowShellExecution | 1/0/0/1 | transcript-OK (1) | TOOLSET:project |
| log_decision | tool-registry.js:4312 | sessions/ops | model | decision | Append a design decision to DECISIONS.md at the project root — the WHY behind a choice (which option | allowFileWrite | 1/1/0/0 | transcript-OK (1) | TOOLSET:project |
| read_decisions | tool-registry.js:4351 | execution/workspace | model | (0 opt) | Read the project's DECISIONS.md (the 'why' log) to understand past design choices before changing re | allowFileRead | 1/1/0/0 | transcript-OK (1) | TOOLSET:project |
| harness_doctor | tool-registry.js:4358 | agents/harness | model | (0 opt) | Audit the current project's agent harness across the five subsystems (Instructions, Tools, Environme | allowFileRead | 1/1/0/0 | transcript-OK (1) | TOOLSET:project |
| init_project | tool-registry.js:4365 | agents/harness | model | (0 opt) | Run the dedicated INITIALIZATION phase for a repo (do this BEFORE feature work, separate from implem | allowFileWrite | — | not run | TOOLSET:project |
| git_status | tool-registry.js:4372 | execution/workspace | model | (1 opt) | Show git working-tree status: current branch and staged/unstaged/untracked files. Read-only. | allowShellExecution | 7/7/0/0 | transcript-OK (7) | CORE |
| git_diff | tool-registry.js:4393 | execution/workspace | model | (3 opt) | Show git diff of changes. By default the unstaged working-tree diff; set staged=true for the index d | allowShellExecution | — | not run | CORE |
| git_log | tool-registry.js:4415 | execution/workspace | model | (2 opt) | Show recent git commits (oneline: hash, subject). Read-only. | allowShellExecution | — | not run | TOOLSET:git |
| git_commit | tool-registry.js:4439 | execution/workspace | model | message | Create a git checkpoint: stage all changes and commit locally with a message. Use after completing a | allowShellExecution | 6/2/0/4 | transcript-OK (6) | TOOLSET:project |
| patch | tool-registry.js:4514 | execution/workspace | operator | (0 opt) | Hermes-compatible patch alias. | allowFileWrite | — | not run | ALIAS (apply_patch) |
| search_files | tool-registry.js:4520 | execution/workspace | operator | (0 opt) | Hermes-compatible search across memory and configured computer roots. | allowComputerAccess | — | not run | TOOLSET:project |
| send_message | tool-registry.js:4564 | channels | model | (0 opt) | Hermes-compatible cross-platform message send alias. | allowConnectorWrite | — | not run | ALIAS (message) |
| sessions_list | tool-registry.js:4570 | sessions/ops | model | (0 opt) | List OmniClaw sessions. | null | — | not run | TOOLSET:agents |
| sessions_history | tool-registry.js:4578 | sessions/ops | model | (0 opt) | Read transcript history for one session. | null | — | not run | TOOLSET:agents |
| sessions_send | tool-registry.js:4611 | sessions/ops | model | (0 opt) | OpenClaw-compatible session send alias. | allowConnectorWrite | — | not run | ALIAS (sessions_spawn?) |
| channel_dock | tool-registry.js:4617 | channels | model | (0 opt) | Move the current session reply route to a linked channel/peer without creating a new session. | allowConnectorWrite | — | not run | TOOLSET:messaging |
| sessions_spawn | tool-registry.js:4646 | sessions/ops | model | (5 opt) | Spawn an isolated background OmniClaw session and immediately return child session/run ids. | null | 1/1/0/0 | transcript-OK (1) | TOOLSET:agents |
| sessions_yield | tool-registry.js:4690 | sessions/ops | model | (0 opt) | Yield current turn after spawning/delegating work; wait for result event instead of polling. | null | — | not run | TOOLSET:agents |
| session_status | tool-registry.js:4702 | sessions/ops | model | (0 opt) | Lightweight /status-style readback for provider, queue, session, and active agent. | null | — | not run | TOOLSET:agents |
| acp_doctor | tool-registry.js:4714 | agents/harness | model | (0 opt) | Run ACP backend/harness readiness checks for Codex, OpenCode, Claude, Gemini, and other ACP agents. | null | — | not run | TOOLSET:harness |
| acp_install | tool-registry.js:4720 | agents/harness | model | (0 opt) | Return deterministic ACP/acpx install and permission setup instructions. | null | — | not run | TOOLSET:harness |
| acp_spawn | tool-registry.js:4726 | agents/harness | model | (0 opt) | Spawn a real external ACP/local CLI harness session for a task. | allowShellExecution | — | not run | TOOLSET:harness |
| acp_status | tool-registry.js:4732 | agents/harness | model | (0 opt) | Show ACP control-plane status and optionally inspect one ACP session. | null | — | not run | TOOLSET:harness |
| acp_sessions | tool-registry.js:4738 | agents/harness | model | (0 opt) | List recent ACP external harness sessions. | null | — | not run | TOOLSET:harness |
| acp_cancel | tool-registry.js:4744 | agents/harness | model | (0 opt) | Cancel a running ACP external harness session. | allowShellExecution | — | not run | TOOLSET:harness |
| acp_close | tool-registry.js:4750 | agents/harness | model | (0 opt) | Close an ACP session binding/record. | allowShellExecution | — | not run | TOOLSET:harness |
| acp_set_option | tool-registry.js:4756 | agents/harness | model | (0 opt) | Set ACP runtime option such as model, permissions, timeout, or cwd on a session/config. | allowConfigWrite | — | not run | TOOLSET:harness |
| agent_harness_doctor | tool-registry.js:4762 | agents/harness | model | (1 opt) | Check jcode-style coding agent harness readiness for Codex/OpenCode/Claude/Gemini/Qwen CLI agents. | null | — | not run | TOOLSET:harness |
| agent_harness_spawn | tool-registry.js:4774 | agents/harness | model | task | Spawn a real coding-agent harness session to work on a coding task and return stored stdout/stderr/s | allowShellExecution | — | not run | TOOLSET:harness |
| agent_harness_status | tool-registry.js:4816 | agents/harness | model | (5 opt) | Inspect one coding-agent harness session or get harness control-plane status. | null | — | probe-OK (isolated, read-only) | TOOLSET:harness |
| agent_harness_sessions | tool-registry.js:4832 | agents/harness | model | (3 opt) | List recent coding-agent harness sessions. | null | — | not run | TOOLSET:harness |
| agent_harness_cancel | tool-registry.js:4846 | agents/harness | model | (3 opt) | Cancel a running coding-agent harness session. | allowShellExecution | — | not run | TOOLSET:harness |
| agents_list | tool-registry.js:4860 | agents/harness | model | (0 opt) | List configured OmniClaw agents. | null | — | not run | TOOLSET:agents |
| skills_list | tool-registry.js:4868 | skills/learning | model | (0 opt) | List compact OmniClaw skills. Full SKILL.md content is intentionally omitted; use skill_read on dema | null | — | not run | TOOLSET:skills |
| skill_read | tool-registry.js:4892 | skills/learning | model | name | Read one OmniClaw SKILL.md on demand using skill precedence. | null | — | not run | TOOLSET:skills |
| skill_view | tool-registry.js:4917 | skills/learning | model | (0 opt) | Hermes-compatible skill read/view tool. | null | — | not run | TOOLSET:skills |
| skill_manage | tool-registry.js:4947 | skills/learning | operator | (0 opt) | Hermes-compatible skill management placeholder for reviewable imports. | allowSkillWrite | — | not run | TOOLSET:skills |
| memory_search | tool-registry.js:4958 | memory | model | query | Hybrid search across session transcripts, daily memory, long-term memory, notes, research, and artif | null | 10/10/0/0 | transcript-OK (10) | CORE |
| memory_get | tool-registry.js:4980 | memory | model | (2 opt) | Read memory layer files or memory overview. file can be MEMORY.md, daily, dreams, or overview. | null | — | not run | TOOLSET:memory |
| memory_compact | tool-registry.js:4997 | memory | model | (2 opt) | Compact daily/session memory into durable long-term memory candidates and refresh MEMORY.md. | allowMemoryPromotion | — | not run | TOOLSET:memory |
| memory | tool-registry.js:5013 | memory | model | (0 opt) | Hermes-compatible memory read/search/save/promote/replace/remove tool. | null | — | not run | ALIAS (memory_get/memory_search multiplexer) |
| session_search | tool-registry.js:5038 | memory | model | (0 opt) | Hermes-compatible session and memory search. | null | — | not run | TOOLSET:agents |
| clarify | tool-registry.js:5053 | sessions/ops | operator | (0 opt) | Hermes-compatible clarify placeholder. The assistant should ask the user directly. | null | — | not run | DROP |
| mixture_of_agents | tool-registry.js:5064 | agents/harness | operator | (0 opt) | Hermes-compatible multi-agent reasoning placeholder backed by OmniClaw subagents. | allowShellPlanning | — | not run | DROP |
| computer_use | tool-registry.js:5075 | execution/shell-computer | operator | (0 opt) | Hermes-compatible computer-use status backed by OmniClaw laptop access, browser, and terminal tools. | null | — | not run | ALIAS (computer_access_status) |
| ha_list_entities | tool-registry.js:5081 | hermes-homeassistant | operator | (0 opt) | Hermes-compatible Home Assistant placeholder. | allowConnectorWrite | — | not run | DROP |
| ha_get_state | tool-registry.js:5087 | hermes-homeassistant | operator | (0 opt) | Hermes-compatible Home Assistant placeholder. | allowConnectorWrite | — | not run | DROP |
| ha_list_services | tool-registry.js:5093 | hermes-homeassistant | operator | (0 opt) | Hermes-compatible Home Assistant placeholder. | allowConnectorWrite | — | not run | DROP |
| ha_call_service | tool-registry.js:5099 | hermes-homeassistant | operator | (0 opt) | Hermes-compatible Home Assistant placeholder. | allowConnectorWrite | — | not run | DROP |
| nodes | tool-registry.js:5105 | sessions/ops | operator | (0 opt) | Discover paired/trusted nodes and local host bindings. | null | — | not run | TOOLSET:messaging |
| canvas | tool-registry.js:5119 | sessions/ops | operator | (0 opt) | Canvas compatibility status. Full node canvas eval/snapshot is not yet enabled. | null | — | not run | DROP |
| cron | tool-registry.js:5128 | autonomy | model | (0 opt) | List schedules and background jobs. | null | 3/2/1/0 | transcript-OK (3) | TOOLSET:tasks-auto |
| cronjob | tool-registry.js:5137 | autonomy | model | (0 opt) | Hermes-compatible cron job listing/status alias. | null | — | not run | ALIAS (cron) |
| kanban_show | tool-registry.js:5143 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | null | — | not run | DROP |
| kanban_list | tool-registry.js:5149 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | null | — | not run | DROP |
| kanban_complete | tool-registry.js:5155 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | allowTaskWrite | — | not run | DROP |
| kanban_block | tool-registry.js:5161 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | allowTaskWrite | — | not run | DROP |
| kanban_heartbeat | tool-registry.js:5167 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | null | — | not run | DROP |
| kanban_comment | tool-registry.js:5173 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | allowTaskWrite | — | not run | DROP |
| kanban_create | tool-registry.js:5179 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | allowTaskWrite | — | not run | DROP |
| kanban_link | tool-registry.js:5185 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | allowTaskWrite | — | not run | DROP |
| kanban_unblock | tool-registry.js:5191 | hermes-kanban | operator | (0 opt) | Hermes-compatible kanban placeholder. | allowTaskWrite | — | not run | DROP |
| gateway | tool-registry.js:5197 | sessions/ops | operator | (0 opt) | Inspect OmniClaw gateway overview, events, runs, approvals, and provider status. | null | — | not run | OPERATOR |
| image | tool-registry.js:5212 | channels/media | operator | (0 opt) | Image analysis compatibility tool backed by attachment media analysis when configured. | allowConnectorWrite | — | not run | ALIAS (analyze_attachment_media) |
| image_generate | tool-registry.js:5218 | channels/media | model | (0 opt) | Generate a real image from a text prompt (configured image provider, or the free keyless fallback).  | allowConnectorWrite | 2/2/0/0 | transcript-OK (2) | TOOLSET:media |
| describe_image | tool-registry.js:5230 | channels/media | model | (0 opt) | SEE an image: a vision backend describes any image file (screenshot, generated image, photo) as text | null | 25/12/8/5 | transcript-OK (25) | TOOLSET:media |
| vision_analyze | tool-registry.js:5242 | channels/media | model | (0 opt) | Hermes-compatible image analysis alias (describe_image for paths, attachment analysis otherwise). | allowConnectorWrite | — | not run | ALIAS (describe_image) |
| video_analyze | tool-registry.js:5253 | channels/media | model | (0 opt) | Hermes-compatible video analysis alias. | allowConnectorWrite | — | not run | ALIAS (describe_image?) |
| text_to_speech | tool-registry.js:5259 | channels/media | operator | (0 opt) | Hermes-compatible text-to-speech placeholder. | allowConnectorWrite | — | not run | TOOLSET:media |
| music_generate | tool-registry.js:5271 | channels/media | operator | (0 opt) | Music generation compatibility placeholder. Requires adding a music provider plugin. | allowConnectorWrite | — | not run | TOOLSET:media |
| video_generate | tool-registry.js:5277 | channels/media | model | (0 opt) | Generate a video from a text prompt: scene keyframe images assembled with ffmpeg into an mp4 (or an  | allowConnectorWrite | 1/1/0/0 | transcript-OK (1) | TOOLSET:media |
| tts | tool-registry.js:5289 | channels/media | operator | (0 opt) | Text-to-speech compatibility placeholder. Requires adding a TTS provider plugin. | allowConnectorWrite | — | not run | DROP |
| delegate_task | tool-registry.js:5295 | autonomy | model | task | Delegate a self-contained subtask to a sub-agent with its OWN context and tool loop (files, shell, w | allowTaskWrite | 15/1/0/14 | transcript-OK (15) | TOOLSET:tasks-auto |
| best_of_n | tool-registry.js:5325 | delegation | model | task,outputDir,entryFile | Best-of-N: build the SAME deliverable N times in PARALLEL (independent sub-agents, separate candidat | allowTaskWrite | — | not run | TOOLSET:project |
| evaluate_work | tool-registry.js:5343 | verification | model | requirement | Get an INDEPENDENT, nitpicky review of work from a separate reviewer agent (worker != checker). The  | allowTaskWrite | 2/0/0/2 | transcript-OK (2) | TOOLSET:project |
| provider_keys | tool-registry.js:5405 | providers/mcp | model | (0 opt) | List which provider API keys are configured (MASKED — never full keys), the active provider/model, a | null | — | not run | OPERATOR |
| switch_model | tool-registry.js:5429 | providers/mcp | model | model | Switch the active model at runtime (same provider/key). scope 'main' = the primary agent model, 'sub | allowConfigWrite | — | not run | TOOLSET:provider |
| subagents | tool-registry.js:5467 | agents/harness | model | (0 opt) | List active and recently completed sub-agents (with limits + models), or cancel a running sub-agent. | null | — | not run | TOOLSET:agents |
| browser_remote_connect | browser-remote-tools.js:115 | execution/browser-CDP | model | (3 opt) | Connect to the user's ALREADY-RUNNING Chrome and list its tabs. Use this instead of browser_open whe | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_launch | browser-remote-tools.js:159 | execution/browser-CDP | model | (4 opt) | Start a real Chrome/Edge window with the debug port open, so the browser tools have something to att | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_list_tabs | browser-remote-tools.js:200 | execution/browser-CDP | model | (2 opt) | List the open page tabs in the connected real browser, with their index, title and URL. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_state | browser-remote-tools.js:230 | execution/browser-CDP | model | (3 opt) | Read the current page: URL, title, visible text, and the interactive elements with CSS selectors you | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_screenshot | browser-remote-tools.js:272 | execution/browser-CDP | model | (3 opt) | Screenshot the current tab of the real browser. Saves a PNG to disk and returns its path (the harnes | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_click | browser-remote-tools.js:316 | execution/browser-CDP | model | (6 opt) | Click an element in the real browser by CSS selector. Scrolls it into view first. Get selectors from | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_type | browser-remote-tools.js:357 | execution/browser-CDP | model | selector,text | Focus a field in the real browser and type text into it. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_fill_form | browser-remote-tools.js:390 | execution/browser-CDP | model | fields | Fill several form fields in the real browser in one call, then read each value back to confirm it st | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_evaluate | browser-remote-tools.js:459 | execution/browser-CDP | model | script | Run JavaScript in the real browser tab and return the value. Must evaluate to a JSON-serializable va | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_navigate | browser-remote-tools.js:497 | execution/browser-CDP | model | url | Navigate a tab of the real browser to a URL, waiting briefly for the load to start. | allowBrowserControl | — | not run | TOOLSET:browser |
| browser_remote_disconnect | browser-remote-tools.js:547 | execution/browser-CDP | model | (1 opt) | Close CDP sessions to the real browser. The browser itself and its tabs stay open. | allowBrowserControl | — | not run | TOOLSET:browser |

## Dynamic rows (not in static source)

| name | file:line | subsystem | audience | params | purpose | policy | calls | health | proposed layer |
|---|---|---|---|---|---|---|---|---|---|
| mcp_composio_* (21 live) | mcp-client.js (dynamic) | providers/mcp | model (prefix admission) | varies | Composio search/flights/maps/etc. | none (connect = opt-in) | — | transcript-OK (used) | TOOLSET:mcp (dynamic) |
| forged custom_* (~4 observed: crypto_prices, desktop_control, gmail_access, net_check) | workspace/tools/*.mjs | skills/learning | model (self-test gate) | varies | Agent-built tools | sandbox | — | probe-N/A | TOOLSET:skills (dynamic) |
| plugin template-only (hello_* etc.) | plugin-registry.js | compat | operator | — | Manifest echo, no execution | none | — | not run | OPERATOR |

## B1. Duplicate clusters — survivor first

- Shell exec: `exec` (1024 calls) vs `run_terminal_command` (30) vs `process` (0) vs `code_execution` (0) vs `execute_code` (ALIAS) vs `run_command` (no def). Survivor: **exec** (approval gate, background, dedupe); keep `run_terminal_command` (simpler contract) + `code_execution` (python-scoped) in TOOLSET:shell; DROP nothing (process = OS processes, distinct) except `execute_code` ALIAS.
- Workspace fs: `read_file` (1469) vs `read` (ALIAS, 0) vs `search_text` vs `search_files` (Hermes, computer roots) vs `search_computer_files`. Survivor per scope: **read_file/write_file/edit/list_files/search_text** (workspace), ***_computer_file** (computer). `read/write` → ALIAS confirmed delegates.
- Browser: CDP `browser_remote_*` (11, own profile, tabId) vs Hermes `browser_*` (~30, managed profile). NOT duplicates — different profiles/policies. Keep both in one TOOLSET:browser; long-term merge onto CDP client. `open_browser_url` (OS browser, uncontrolled, 0 calls) → ALIAS note.
- Memory: `memory_*` natives (10-25 calls) vs `memory` mux (0) vs `remember_note/list_notes` (notes lane). Survivor: natives; `memory` → ALIAS.
- Tasks: `create/list/run_task + todo` vs Hermes `todo` mux (ALIAS of create_task) — survivor natives; `update_plan` (292 calls) stays CORE.
- Web: `web_search/fetch/extract` are mux ALIASES over `brave/exa/x_search + read_url` — survivors are the backends; `web_research` (deep) stays CORE.
- Sessions: `sessions_*` natives vs `session_search` (never called) — survivor natives; `sessions_send` → ALIAS.
- Media: `describe_image` (25 calls) vs `vision_analyze/video_analyze` (ALIAS) vs `analyze_attachment_media` (backend) — survivor describe_image + backend.
- Provider: `provider_status` (12 ok) vs `model_provider_status` (OPERATOR) — survivor provider_status.

## B2. Model-callable self-modification — lock down

Model-callable today AND mutating the agent: `apply/save/delete_provider_profile`
(3), `set_provider_key`, `configure_provider_brain`, `update_runtime_settings`,
`create_skill`, `build_tool/test_tool/list_custom_tools/remove_custom_tool` (4),
`skill_manage`, `delegate_task/subagents/sessions_spawn` (spawn cost), `cron`
(create schedules), `configure_telegram`, `git_commit` (repo mutation, intended).
Recommend OPERATOR (UI/API-only, human clicks) for: profiles/keys/brain/settings/
telegram; approval-gated (card + diff, Hermes skill-creation shape) for:
`create_skill` (intended learning — show SKILL.md diff), `build_tool` (already
sandbox+self-test gated — keep, add human Allow before persist), `skill_manage`.
Keep model-callable: `git_commit` (explicit user ask), `cron` (move to
TOOLSET:tasks-auto behind intent), `test/list_provider_models` (reads).

## B3. Token cost — exact menu math

- Sent today (no boost): first 64 of CORE_TOOL_ORDER = **21170 chars ≈ 5293 tok**.
  Costliest in-menu: code_act 1015, build_tool 662, restore_checkpoint 558,
  best_of_n 539, ask_user 538 (descriptions dominate; schemas are small).
- Silently cut (positions 65-77): agent_harness_doctor/spawn/status,
  verify_html_artifact, provider_status, provider_keys, switch_model,
  list_provider_models, computer_access_status — the model can never see
  provider switching or harness delegation unless boosted.
- CORE-26 as defined: **7280 chars ≈ 1820 tok** (saves ~3.5k tok/round, -66%).
- CORE-26 + full browser toolset (34): **14455 chars ≈ 3614 tok**.
- Context dwarfs menu either way: real turn 66720 chars (workspace 45358).
  Menu savings matter per-round (×60 rounds), context savings matter per-turn.

## B4. Top 10 used / top 10 blocked+failed (root cause → policy line)

Used: read_file 1469, exec 1024, write_file 384, edit 305, update_plan 292,
browser 199, list_files 193, browser_open 182, process_status 135, search_text 105.
Friction (blocked+failed): exec 483 — loop anti-repeat guards
(`duplicateSideEffectKeys`/`repeat budget`, NOT approvals: 174) +
PowerShell `&&` syntax errors (`shell-policy` passes text through; Windows
needs `;`); read_file 160 — 100 opaque `error:true` + 51 stale-read guard
(by design) + 9 schema; browser 91 — Hermes evaluate/session errors;
process_status 77 — repeat-guard 38 + stale processIds; browser_open 64 —
repeat-guard 40 + file:// escapes (correct, `browser-playwright.js:10-24`);
edit 54 / write_file 48 — opaque + schema + dedupe; browser_view 44 — no
active session (ordering: model must `browser_open` first); run_terminal_command
19 — incl. 2 approval timeouts (4B.1 banner now covers); delegate_task 14/15
failed opaque — spawner contract mismatch, needs own investigation.
Fix priority: (1) loop-dedupe tuning + `&&` rewrite hint, (2) error message
quality (`error:true` tells nothing), (3) delegate_task contract.

## B5. Toolsets proposed (model-visible menu design)

CORE-23 (+3 alias shims todo/web_search/web_fetch) always sent (~1.8k tok).
Attach per intent/task (generalize `TYPE_TOOL_BOOSTS`): browser (35),
shell (14), git (1+), computer (8), web (3+read_url), memory (10), tasks-auto
(5), messaging (10), media (9), provider-reads (4), skills (13), agents (9),
project (25), harness (14), sessions (part of agents), mcp (dynamic).
OPERATOR (32) moves to UI/API surfaces; ALIAS (19) stays as compat shims but
leaves the menu; DROP (17) deleted: 4 ha_*, 9 kanban_*, clarify, canvas, tts,
mixture_of_agents. Net menu on a browser+coding turn: ~60 tools ≈ 3.6k tok
vs 64 mixed ≈ 5.3k today — smaller AND complete (no silent cuts).
