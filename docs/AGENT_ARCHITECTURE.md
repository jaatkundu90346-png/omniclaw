# AGENT_ARCHITECTURE — OmniClaw subsystems (T0 audit, read-only, 2026-09-05)

> Every claim cites file:line verified against the working tree, live API
> output, or read-only transcript data (`data/sessions`, 167 transcripts).
> Status scale: works / partial / broken / unused.

## 1. Identity / Soul

- Files: `workspace/agents/<id>/*.md` — main has 23, builder/ops/research 19
  each (main alone carries `MEMORY.md`, `USER.md`, `PROFILE.md`,
  `OMNICLAW_SKILL_ROADMAP.md`, `omni-landing/`). Template set shared:
  `IDENTITY.md` (name billubaba, role), `PERSONALITY.md` (Hinglish voice),
  `SOUL.md` (values), `USER.md`/`PROFILE.md` (durable facts), `TOOLS.md`,
  `AGENT_LOOP.md`, `AGENT_RUNTIME.md`, `HARNESS.md`, `ACTIVE_MEMORY.md`,
  `HEARTBEAT.md`, `TELEGRAM.md`, `CHANNEL_DOCKING.md`, `SUBAGENTS.md`,
  `THINKING.md`, `AUTOREVIEW.md`, `MEMORY.md` + `memory/YYYY-MM-DD.md` dailies.
- Loading: `agent.js:2515-2539` builds `workspaceContext` (project files +
  agent files, per-file char budgets in `system-prompt.js:231-250`: runtime
  manuals 9000, project docs 6000, rest 2200); `formatIdentityMemorySection`
  (`system-prompt.js:323-366`) extracts latest `Assistant name:/User name:`
  into `## Agent/User Memory Snapshot`. Per-run evidence: transcript
  `workspace.manifest.loadedFiles` (25 files) and `contextManifest`.
- Per-agent differences (`config/default.json` agents): main/power,
  builder/power, ops/power **+ 84 allowedTools** (only allowlisted agent),
  research/balanced; others unrestricted (`allowedTools: []`).
- Status: **works** (identity answers + Hinglish matching observed in live
  transcripts). Debt: whole files injected every turn (see §2).

## 2. System prompt assembly

- Builder: `buildOmniClawPromptSections` (`system-prompt.js:498-535`), 17
  sections in fixed order: identity → creator → hard_constraints (MUST-lines
  pinned from docs, :169-197) → bootstrap → tooling (compact = id list,
  :103-107) → harness → execution_bias → safety → skills → openclaw_control →
  active_memory → identity_memory → workspace → documentation → sandbox →
  runtime → output_directives. Non-stream path duplicates the layout with
  compacted JSON blocks (`openai-compatible-provider.js:627-668`).
- Static skeleton measured (empty ctx): **9000 chars** (~2.3k tokens);
  biggest fixed: identity 1984, harness 1408.
- Real turn (live `promptTrace`, run 2026-09-05): **66720 chars** total —
  workspaceContext **45358 (68%)**, mcp 8983, loopContract 6236, plan 2729;
  tools[] schemas travel separately via native function calling (see
  TOOLS_AUDIT token section). Memory sections (notes/longTerm/recent/
  research) were **all omitted (0 kept)** — starved by workspace bulk.
- Status: **works but overweight**; hard-constraint pinning and reveal-on-
  demand truncation (`...more chars not shown. Read with read_file`) are the
  mitigations. Biggest quality lever: shrink workspaceContext (T0 problem #1).

## 3. Memory

- Store: `src/core/memory-store.js` (1390 lines), `data/memory.json`
  (notes/longTerm/research/dreams + promotion candidates) + generated
  `workspace/agents/main/MEMORY.md` (`syncMarkdown`, :163-231).
- Retrieval: `searchAll` (:987, BM25-lite) + `hybridSearch` (:1026, keyword ∪
  semantic via `semantic-memory.js` with incremental backfill, :1041-1057).
  Per-turn auto-inject: `ActiveMemory.prefetchAll` (`active-memory.js:127`)
  → `promptSection` (≤1800 chars) + keyword relevance scorer
  (`omni-loop.js:1011`). So: relevant memory IS auto-injected, but bounded
  small — and currently loses the budget fight (§2: 0 kept).
- Writers: model tools (`remember_note/memory_write/promote_memory`,
  10–25 transcript calls, all ok), heartbeat dream sweep, UI list-only
  (`GET /api/memory`; promote/dream/insights classic-only; `GET
  /api/memory/search` unused by UI).
- `runDreamSweep` (:890-935): takes promotion candidates ×3, optional model
  rescoring (`scoreCandidatesWithModel`, only if provider passed),
  threshold filter (default 0.65), promotes survivors (tags += dream),
  writes a dream record. No LLM required; heartbeat calls it limit 3 /
  minScore 0.7 (`agent.js:444`).
- Status: **partial** — write/recall/sweep all function (probe-OK + transcript
  evidence), but recall rarely reaches the prompt (budget starvation) and
  semantic index depends on backfill.

## 4. Learning loop — honest: mostly aspirational

- Implemented: `create_skill` model tool (12 transcript calls, 4 ok) →
  `customization-engine.js:731` writes skill files; forged tools via
  `build_tool` (12 calls) admitted after sandbox self-tests
  (`tool-registry.js:6769-6783`); task playbooks auto-refined best-effort
  (`omni-loop.js:1810-1814`); daily deterministic memory curator, decay +
  prune, piggybacked on runs with day-stamp (`omni-loop.js:1816-1839`);
  skill-use recording for a future curator (`agent.js:2527-2531`).
- Aspirational: `ReflectionEngine` is constructed (`agent.js:416`) but
  `reflect()` is called **only from `autonomous-runtime.js`** (3 sites) —
  never from the main loop. No post-task skill extraction exists anywhere
  (no Hermes-like step). `AUTOREVIEW.md` is a doc the model may read, not a
  runner. `SkillCurator` consolidation is LLM-prompt code
  (`skill-curator.js:194`) with no scheduled trigger found.
- Safe shape for future auto-skills (per brief): approval card + diff shown,
  mirroring how `build_tool` already gates (sandbox + self-tests).

## 5. Skills — 11 live (`GET /api/skills?agentId=main`)

- 7 bundled (`browser-game-testing, popular-web-designs, spike,
  subagent-driven-development, systematic-debugging, test-driven-development,
  writing-plans`), 2 workspace-agent (`coding-agent-harness,
  omniclaw-roadmap`), 1 workspace (`research`), 1 personal
  (`tool-desktop_control`, `.mavis/`). Format: `SKILL.md` + triggers/tags.
- Matching: keyword overlap + stopword/hinglish-stopword filtering, trigger
  bonus +5, score>0, top 8 (`skill-registry.js:128-164`); all intents
  `capabilities` bypass to full list. Injected as `<available_skills>`
  names+descriptions; model opens method via `skill_read`.
- Which fire: usage recorded via `recordSkillsUsed`; transcripts show
  `coding-agent-harness` + `tool-desktop_control` actually firing (memory
  files); bundled dev skills fire on coding tasks by trigger.
- Status: **works**; isolated instance sees only the personal skill (no
  workspace/bundled scan there — scope difference, not a bug).

## 6. Autonomy — what runs unattended today

- Heartbeat: `Heartbeat` (`heartbeat.js`, interval **1800000ms = 30min**,
  `agent.js:443`) runs `HEARTBEAT.md` as a full session
  (`channel: heartbeat`, key `agent:main:heartbeat:heartbeat:...`); checks:
  memory dream sweep, **approval expiry (30min)**, session auto-compact
  (>150 msgs). Nothing-to-report → `HEARTBEAT_OK` (observed across dozens of
  live transcripts). 4B.1 added the expiry sweeper it drives.
- Cron/automations: `scheduler.js` + `schedule-store.js`, `GET
  /api/schedules` — **0 schedules live**; routes + UI exist, unused.
- Tasks: `task-store.js` + `create/list/run_task`, `todo`; jobs:
  `job-store.js`, `GET/POST /api/jobs`, `POST /api/jobs/cancel`.
- Status: heartbeat **works**; cron/jobs **unused** (no evidence of any
  scheduled run in transcripts).

## 7. Channels / Messaging

- Workers exist (`telegram-polling-worker.js`, `telegram-api.js`,
  `discord-gateway-worker.js`, `channels.js`, `connector-store.js`);
  adapters live: **discord disabled, file-drop ready, http-webhook ready,
  telegram configured** (`GET /api/connectors/adapters`).
- Inbox: `scan_file_drop` tool + file-drop adapter dir present.
- Attachments: `analyze_attachment_media` (MediaEngine: image describe,
  audio/video via providers), `POST /api/uploads` (10MB); `caps.attachments
  = false` honest (no provider image parts — `FRONTEND_TODO`).
- Dependent tools: `configure_telegram/telegram_status/telegram_send`,
  `message/send_message`, `channel_dock`, `sessions_*` — model-callable,
  near-zero transcript usage (messaging flows untested end-to-end).
- Status: **partial** — wired + configured, no live traffic evidence.

## 8. Sub-agents / multi-agent

- `sub-agent-spawner.js`: maxConcurrent 3 (cap 8), hourly rolling budget,
  shared `memoryStore/taskStore`, direct `toolRegistry.run` (no tool events
  → no parentToolCallId needed, B1). Tools: `delegate_task` (15 calls,
  **14 failed** — top failure, see TOOLS_AUDIT), `subagents`, `sessions_spawn/
  yield`, `mixture_of_agents` (**dead-end**: returns ok:false, T0 DROP).
- 4 agents share memory/tools; `agentRegistry.filterTools` enforces ops'
  84-allowlist. Parallelism: concurrent spawns within budget.
- Status: **partial** — machinery works, `delegate_task` fails systematically.

## 9. Execution surfaces — every policy function today

- Workspace fs: `FileStore.resolveWorkspacePath` (containment,
  `file-store.js:66-73`) + `writableRoots` (`tool-registry.js:2059`).
- Computer fs: `FileStore.resolveComputerPath(input, policy)`
  (`file-store.js:43-64`) — `allowedRoots` (default `["~"]`) +
  `blockedPathPatterns`, via `config.tools.computerAccess/filesystem`.
- Shell: `analyzeShellCommand` + `normalizeShellPolicy`
  (`shell-policy.js:64-82`: blockedPatterns incl. disk-format guard,
  allowlist advisory, trustLevel protected) → `ShellExecutor` + audit
  (`shell-audit-store.js`) → approval gate (`awaitShellApproval`, 5min,
  `tool-registry.js:6257`) → `approval.requested` card.
- Browser: `allowBrowserControl` perm; CDP (own profile) vs Playwright
  (managed profile); B4 route scheme gate (http(s)/about:blank).
- Planned computer-use: `computer_use` tool = alias of
  `computer_access_status`; `POST /api/apps/computer-use` exists; full
  desktop control only via forged `desktop_control` plugin (loopback
  bridge). No OS-level driver in core.
- Status: **works**; policies overlap (3 path policies + shell + approvals).

## 10. Providers / routing / compaction

- Profiles: `providerProfiles` + activeProfile, BYOK keys in
  `SecretStore`, `apply/save/delete/test/list-models` flows;
  `MultiProviderFallback` (failover), `compactionModel` override.
- Loop: `model_tool_loop` (60 rounds, 180s round timeout), native calls →
  `executeRoundCall`, self-correction + auto-verify + menu-miss admission
  (`admitMenuMissTool`).
- Compaction: `compactAtPercent` **0.8 × contextTokens (128k default)** +
  300k-char budget; per-round usage events; why it "fires often":
  workspaceContext alone is ~45k chars/turn and rounds accumulate
  observations at 10k chars each (`maxToolResultChars`) — a 60-round run
  arithmetically must compact. Evidence: `context.compacted` rows live.
- Status: **works**.

## 11. MCP + harness routes

- `/api/mcp/status|tools|call` + `connect/disconnect` → `mcp-client.js`:
  adds live Composio (21 tools, `mcp_composio_*`, dynamic ids admitted by
  prefix, `tool-registry.js:6437-6442`). `mcp_integration_status` tool is
  **broken** (probe-ERR + 0/12 transcripts) while the routes work.
- `/api/harness/status|doctor|spawn|cancel` → `coding-agent-harness.js`:
  delegates repo tasks to external CLIs (codex/opencode/claude/gemini/qwen)
  with verification gates; tools `agent_harness_*` + `acp_*`.
- Status: **works** (MCP connected live; harness green in smoke tests).

## Turn diagram (single user message)

```
chat/stream → intake → session resolve → workspace snapshot
  → context assembly (ingredients: message→loopContract→workspaceContext→
    sessionSummary→[toolOutputs]→harness→mcp→skills(match top-8)→notes→
    longTerm→recent→research→artifacts→tasks→[tools: native 64]→plan;
    each capped, report+manifest recorded in promptTrace)
  → system prompt (17 sections, §2)
  → model_inference (native tool_calls ≤64-menu + boosts)
  → tool_execution (permission → policy → approval → run)
  → observation store (10k chars, 30k reads, dedupe/cache)
  → self_correction → persistence (transcript+toolOutputs)
  → final render → memory hooks (auto-progress, notes candidates)
  → learning hooks (playbook refine best-effort, daily curator gate,
     skill-use record; NO reflection, NO skill extraction)
```
