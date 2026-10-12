# OmniClaw Architecture Report (read-only survey)

Scope: product code only (`server.js`, `src/core/`, `public/`, `scripts/`, `tests/`, `skills/`, `config/`, `data/` as state). Root also contains user-generated demo sites/games (see §1); those are content, not product. All claims cite a file path (+ function where relevant). Token estimates use chars/4. "Measured" = computed by script during this survey; "UNVERIFIED" = not confirmed.

## 1. Overview

### Tech stack / runtime / entry

| Item | Fact |
|---|---|
| Language | Node.js ESM, `"type": "module"` (`package.json:6`); plain `.js`, no TypeScript |
| Runtime | Node 22+ per `AGENTS.md`; raw `node:http` server, no framework (`server.js:5`) |
| Deps | `playwright`, `ws` (`package.json:102-105`); devDeps `@tauri-apps/cli`, `@yao-pkg/pkg`, `esbuild` |
| Entry point | `server.js` — first import `./src/core/network-bootstrap.js` (`server.js:3`); constructs `OmniClawAgent` (`server.js:117`), `agent.start()`, `server.listen(port)` (`server.js:4263`), port `3147` default (`server.js:130`, `PORT` env) |
| State root | `OMNICLAW_DATA_DIR` env or process cwd (`server.js:116`); static UI from `public/` and `web-next/` (`server.js:110-111`) |
| Packaging | `@yao-pkg/pkg` → `OmniClaw.exe` + `omniclaw-gateway.exe`, bundled via `esbuild` (per `AGENTS.md`); `scripts/build-windows-portable.mjs`, `scripts/build-gateway-sidecar.mjs`; Tauri shell in `src-tauri/` |
| Run | `npm run dev` / `npm start` = `node server.js` (`package.json:8-9`) |
| Syntax check | `npm run build` = `node --check server.js && node --check public/app.js` (`package.json:20`) |
| Tests | `npm test` = `node scripts/health-smoke.mjs && node --test <11 files in tests/api>` (`package.json:22`); ~124 `scripts/*-smoke.mjs` verifiers; `npm run test:<area>` per area |

### Top-level folders (2 levels)

Product code:

| Folder | Purpose |
|---|---|
| `src/core/` | All backend runtime: agent, loop, tools, providers, memory, sessions, channels (110 files, ~72.6k lines, measured js/mjs/cjs/json) |
| `src/core/providers/` | Provider adapters: `openai-compatible-provider.js`, `codex-cli-provider.js`, `mock-provider.js` |
| `public/` | Web UI: classic `app.js` (6219 lines) + `styles.css`, Neo `neo.js` (3105 lines) + `neo.css`, `classic/`, `ui/` |
| `web-next/` | Alternate/next web client (`index.html`, `js/`, `css/`, `vendor/`) |
| `scripts/` | ~124 `.mjs` smoke/verification scripts + build scripts |
| `tests/api/` | HTTP API tests (`node:test`); 11 run by `npm test` + `provider-select.test.mjs` (not in `npm test`) + `_helpers.mjs` |
| `skills/` | Bundled skills: 7 `SKILL.md` dirs + 16 `.skill` pointer files |
| `config/` | `default.json` (all defaults), `mcp-servers.json` |
| `data/` | LIVE runtime state, not source: `sessions.json`, `gateway.json`, `memory.json`, `MEMORY.md`, `secrets.json`, `model-registry.json`, `usage.json`, `schedules.json`, `tasks.json`, `checkpoints/`, `sessions/transcripts/`, `semantic-memory/`, logs |
| `workspace/` | Agent home manuals (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, …) + `agents/<id>/` per-agent dirs + user project content |
| `plugins/` | `omni-core/`, `omni-hello/` plugin packages |
| `connectors/adapters/` | Channel connector adapters |
| `sidecar/` | `omniclaw-gateway.mjs` |
| `vendor/` | Reference imports: `hermes-agent/`, `openclaw/` |
| `src-tauri/` | Tauri desktop shell (`Cargo.toml`, `tauri.conf.json`) |
| `docs/`, `notes/` | Design docs, plans |
| `logs/`, `tmp/`, `uploads/` | Server logs; tool results/parse-failures/subagents; chat attachments |
| `dist/` | Packaged exes + releases |
| `.hermes/`, `.mavis/`, `.omniclaw/`, `.claude/`, `.freebuff/`, `.playwright-cli/`, `.research/` | Tool/agent state dirs |
| `agents/` | UNVERIFIED (contains `main/`; not inspected) |

User content at root (not product — demo sites, games, experiments): `ai-dub-studio`, `airforce-website`, `amazon-site`, `clawcore`, `computer-control`, `cursor-clone`, `cyber-tutor`, `fitness-site`, `fitness-website`, `flappy-bird`, `gta6-clone`, `haryana-computer`, `neon-open-world`, `neox-agent`, `neuralcore-ai`, `novamind-ai`, `omni-landing`, `omniclaw-site`, `omniclaw-website`, `omnifit-ai`, `pillow-store`, `restaurant-website`, `snake-game`, `watch-store`, `watchstore`, `you-bot-adapter`, plus `output/`, `screenshots/`, `test-output/`, `scratch/`, `dev/`. Many `omniclaw-gateway.exe.bak-*` / `OmniClaw.exe.bak-*` at root are build backups.

### Approximate size (measured, js/mjs/cjs/json/md where noted)

| Area | Files | Lines |
|---|---|---|
| `src/core/` (+`providers/`) | 110 | ~72,600 |
| `server.js` | 1 | 4,037 |
| `scripts/` | 124 | ~15,950 |
| `tests/` | 13 | 1,395 |
| `public/` (js only; +css/html not counted) | 7 | ~16,770 |
| `skills/` (all files) | 79 | ~14,380 |
| `config/` | 2–3 | ~683–1,349 |
| Key files | `agent.js` 9,586 / `tool-registry.js` 9,371 / `omni-loop.js` 6,085 / `planner.js` ~2,600 / `connector-store.js` ~2,800 | — |

## 2. The agent loop

One user message end to end (chat/SSE → reply):

1. **Intake.** HTTP route in `server.js` (routes at `server.js:839+`, e.g. `/api/*`, `/v1/*`, `/api/events` SSE at `server.js:1096`) → `OmniClawAgent.handleMessage` (`src/core/agent.js:1772`): `createProvider`, `agents.resolveAgent`, `sessions.resolveSession` (per-chat `workspacePath` bind), `gateway.createRun` (status accepted/queued), `enqueueSessionRun`.
2. **Session queue.** `enqueueSessionRun` → `drainSessionRunQueue` (`agent.js:2313/2330`): one serialized lane per session id; hard timeout `min(86.4M ms, runtime.agentLoop.timeoutMs || 3.6M ms)` (`agent.js:2344`); on timeout writes failed run + error message.
3. **Run setup.** `executeMessageRun` (`agent.js:2402`): parse slash control commands (`/think /fast /reasoning /steer` → `sessionControls`), `sessions.startRun` guard (busy/archived reject), `gateway.updateRun accepted`, stages `intake` → `session_queue`, append user message to transcript, `contextEngine.ingest`, `resolveAgent` + profile, `loadWorkspaceContext`, `buildAgentLoopContract`, stage `workspace_snapshot`/`system_prompt`.
4. **Tool/skill/memory prefetch.** `tools.getAll({agentId, modelCallableOnly:true})` unless `tools.menuV2===true` (then full registry; `agent.js:2561-2564`; default `menuV2:false`, `config/default.json:508`); `intentEngine.detect`; `skills.match` (or all on `capabilities` intent); `recordSkillsUsed`; `activeMemory.run`; bootstrap ritual check; `getAgentContext` (long-term memory/notes/recent/research/artifacts/tasks) → `modelToolLoopContext`.
5. **Loop.** `runModelToolLoop` (`agent.js:6142`) → `omniLoop.run` if `omniLoop.isEligible` else legacy JSON loop in same function (native-tool planner with `buildModelToolLoopPrompt`, `modelToolLoop.maxRounds` 50 per `config/default.json`). OmniLoop failure falls through to legacy (`agent.js:6168-6176`).
6. **`OmniLoop.run`** (`src/core/omni-loop.js:4284`, args `{message,intents,agent,profile,session,run,tools,contextBundle}`): copy settings; apply `sessionControls` (`/fast` → `maxRounds=min(n,14)`); evolution tunables; init `report` (`loopEngine:"omni-loop"`); seed `readFiles` from session evidence ledger; inherit unfinished session plan (or `run.resume` transcript event); `AgentLoopController`; `resolveMenuToolsets` + `buildMenu`; `buildMemoryBriefAsync` raced 4s; code-map pre-pass; `buildSystemPrompt` → `messages=[system(ZoneA+ZoneB+loopContract), ...history, system(ZoneC), user]`; `zoneAHash`; `omni_loop.started`.
7. **Each round** (`for round 1..maxRounds`): menu rebuild + zone-stability guard; cancel check (`cancelled`); steer drain; `loopController.startStep` (`max_steps`); `round_started`; microcompact → `summarizeOldTranscript` → `compactTranscript`; plan auto-seed at round 3; plan reminder re-inject; tool-budget guard; honest context meter; emergency auto-compaction; `callProvider`.
8. **Provider call.** `callProvider` (`omni-loop.js:3284`): rate-limit guard; attempts `0..providerRetries` (default 1, config up to 3); shared send budget ≤3/round; `AbortController`; first-token watchdog 45s (`firstTokenTimeoutMs`), idle timeout `roundTimeoutMs` (180s), hard cap `roundHardCapMs` (600s); 500ms cancel watcher; 5s UI heartbeat; `maxTokens*maxTokensBump` (cap 64k); `reasoning` override; prefix-cache breakpoints (≤4); `toolChoice required/auto` (downgrade on 400). Errors → vision-strip retry → context-overflow compact+retry (≤2) → `rotateProviderForRetry` (reasons rate_limit/auth/billing/model_not_found/model_retired/overloaded/server_error/unknown; chain = agent chain + `provider.fallbacks` + `fallbacks`, each once; clears `modelOverride`) → else `provider-error` stop with classified user message (`provider-error-classifier.js:132 classifyProviderError`).
9. **Thinking.** `completion.reasoning` (separate `reasoning_content` channel) → `assistant.reasoning` transient + `model_tool_loop.reasoning` event; never echoed into transcript (`omni-loop.js:5116-5149`); tokens counted reported-or-chars/4; per-round + run-total `thinkingToActionRatio` (`thinkingRatio`, `omni-loop.js:1010`); `<think>`-in-content streams scrubbed by `StreamingThinkScrubber` (`src/core/think-scrubber.js`).
10. **Tool parsing.** Native `toolCalls`; if empty, `extractTextModeToolCalls` JSON-text recovery (`omni-loop.js:5154-5176`); `finish_reason:length` + write-tools → block (3× → `length-cut-exhausted`); reasoning-only length-cut → budget double + nudge (3× → `reasoning-length-exhausted`); degenerate-text, action, reverify, regression, verification-gap, act-now (≤3, forces `toolChoice:required`), observation nudges; else final answer (reasoning fallback allowed → `model-final-from-reasoning`).
11. **Execution.** Normalize (`parseToolArguments` + `repairToolInput`; forensics to `tmp/parse-failures/`); cap `maxToolCallsPerRound` (default 6; excess parked in a user note); assistant message rebuilt with re-serialized args; parallel batches for `PARALLEL_SAFE_TOOLS` + shell conflict detector (`shellCallsConflict`/`writeCallsConflict`), write-family same-file never parallel, `maxParallelToolCalls` 8; `executeRoundCall` (`omni-loop.js:3725`) → `ToolRegistry.run` (permissions, approvals, observation cache, audit); results truncated per-tool budget, full text persisted `tmp/tool-results/<run>-r<round>-<id>.txt` (7-day/50-file prune); `role:tool` messages appended; pressure digest (`digestOldGroups`); `finish` tool with `finished:true` → `finish-tool` stop.
12. **Post-round guards.** Screenshots → vision message or `mediaEngine.describeImage` (45s race, "harness eyes"); edit-strategy switch (2 fails/file); build-verify cadence (round ≥10, ≤3); rework-churn (3 rewrites); gathering anti-spin; diagnose-first on error-fix tasks; 4 all-failed rounds → `stuck-no-progress`.
13. **Finish.** `max_rounds` if no reason; `cancelled` cleanup; budget-exhausted → no-tool summary attempt (`toolChoice:"none"`, flatten retry, transcript-echo guard) else deterministic `summarizeWorkDone`; `clearSteer`; `loopController.done`; `omni_loop.completed`; fire-and-forget `learnFromRun`, `captureDurableFacts`, `learnPlaybook`, `maybeRunSkillReview/Curator`, `evolution.recordRun`; `writeAutoProgress` (PROGRESS.md); return `{report, toolOutputs}`.
14. **Post-loop (agent.js).** Usage/cost record; required-tool repair + auto-verification SKIPPED for omni-loop (`agent.js:3170,3218`); context bundle assemble + `promptTrace`; provider-grounded synthesis fallbacks; guards; transcript persist; reply.

- **Max-rounds / stop:** loop `round <= settings.maxRounds` (18 default `config/default.json`, clamp 1–500 in `getOmniLoopSettings`, `/fast`→14); `AgentLoopController.startStep` maxSteps (`runtime.agentLoop.maxSteps` 1000); session hard timeout (§2.2); `runTokenBudget` 600k hard stop (+70% warn); stuck/budget/cancel/provider stops above; terminal `stoppedReason` values include `model-final-ready`, `finish-tool`, `max_rounds`, `stuck-no-progress`, `budget-exhausted`, `provider-*`, `cancelled`, `length-cut-exhausted`, `reasoning-length-exhausted`, `degenerate-output`, `model-empty-final`.
- **Provider error:** classify (`auth/billing/context_overflow/payload_too_large/model_not_found/model_retired/rate_limit/overloaded/server_error/format_error/timeout/unknown` + retry/compact policy, `provider-error-classifier.js:51`) → in-round rotation → terminal classified Hinglish `userMessage` + precise `stopReason` (never a generic blob).

## 3. Prompt & context assembly

### Section order (exact)

`buildOmniClawPromptSections` (`src/core/system-prompt.js:630`): `identity` → `creator` → `hard_constraints` → `bootstrap` → `tooling` → `harness` → `execution_bias` → `safety` → `skills` → `openclaw_control` → `active_memory` → `identity_memory` → `workspace` → `documentation` → `sandbox` → `runtime` → `output_directives`. Empty sections filtered. OmniLoop wraps (`omni-loop.js:2839 buildSystemPrompt`): Zone A = `provider.systemPrompt` + base + `buildEnvironmentSection` + `buildSelfKnowledgeSection`; Zone B = recent-sessions + session-work + project-state + continuation + debugging-protocol + instincts + playbooks + memory-brief + code-map + evidence-ledger + batch-instructions; then Agent Loop Contract; Zone C = separate trailing system message (date/UTC/session/run/agent/model + folder NAME only, `buildZoneCSection`, `omni-loop.js:2735`).

### Measured base sizes (empty context; chars → ~tokens)

identity 2323→581, creator 792→198, tooling-compact 639→160, harness 1281→320, execution_bias 579→145, safety 369→92, openclaw_control 312→78, identity_memory 671→168, workspace-empty 392→98, documentation 202→51, sandbox 262→66, runtime 641→160, output_directives 537→134. Base total ~9.0k chars (~2.3k tokens). On top: loop-contract (~5–8k chars, UNVERIFIED exact), workspace ≤18k chars (~4.5k), evidence ledger ≤8k (~2k, `omni-loop.js:2826`), active memory ≤1.8k, memory brief (top-8 hybrid, `rankMemoryItems`), history (`historyMessages`: code default 24 in `getOmniLoopSettings`, `config/default.json` sets 30; each ≤16k chars, `omni-loop.js:3076`), tool schemas (core-16 menu ~12.8k chars ≈3.2k tokens measured; 30-tool menu ~3.9k tokens measured with `project` toolset).

### Auto-read files (`agent.js:7118 loadWorkspaceContext`)

- Agent scope (claims names first) + shared scope fill gaps, from `fileNames`: `AGENTS.md IDENTITY.md PERSONALITY.md SOUL.md USER.md PROFILE.md TOOLS.md AGENT_LOOP.md AGENT_WORKSPACE.md AGENT_RUNTIME.md HARNESS.md ACTIVE_MEMORY.md CHANNEL_DOCKING.md SUBAGENTS.md THINKING.md CLAWHUB.md TELEGRAM.md AUTOREVIEW.md HEARTBEAT.md` + `BOOTSTRAP.md` if ritual active; plus daily `memory/<today>.md`.
- Project scope: `AGENTS.md AGENT.md CLAUDE.md ARCHITECTURE.md CONSTRAINTS.md CONVENTIONS.md CONTRIBUTING.md STARTUP.md SPRINT.md TASKS.md feature_list.json arch_rules.json PROGRESS.md DECISIONS.md .hermes.md HERMES.md .cursorrules`, walking up ≤8 levels to `.git`, from the chat's folder (never app dir). mtime+size cache skips re-reads.
- Missing: silently skipped (`existsSync`); manifest lists `missingRequiredFiles`; prompt prints `Missing expected workspace files: …` or `No workspace bootstrap files were injected for this turn.` (`system-prompt.js:280-287`). Injection diet: only `PROJECT/AGENT/SHARED:AGENTS.MD` (2500 chars each) + `SPRINT.MD` (1500) + `DECISIONS.MD` (1200) inline; everything else is a one-line on-demand index (`- name [scope, N chars]: purpose — read_file when needed`); section ceiling 18k chars; hard-constraint lines (MUST/NEVER/…) pinned to top (≤15).

### Compaction (all `src/core/omni-loop.js` unless noted)

| Stage | Trigger | Kept | Dropped | Model |
|---|---|---|---|---|
| microcompact (`3130`) | every round, free | newest read per path+window; tail 8 | older duplicate reads → `[superseded read …]` stub | none (deterministic) |
| `summarizeOldTranscript` (`3219`) | `total chars > contextCharBudget` (effective = `min(contextCharBudget, (contextTokens-maxTokens)*compactAtPercent*4)`) | system msg; ≥10 recent; safe non-tool boundary; original-task pin | oldest block → one user-message summary (flatten caps: tool 1200/call-args 200/other 1200; input 24k) | `provider.compactionModel` (default `tencent/hy3:free`, `config/default.json`) else main; `maxTokens:900`; failure → truncation |
| `compactTranscript` (`3170`) | same budget | head + tail 8 | tool msgs >700→180+note; text assistant >900→700+note | none |
| emergency auto-compact (`4904`) | meter ≥ `autoCompactAtPercent` (0.96) after normal pass | same | summarize + halve-budget truncate, re-meter | same as summarize |
| overflow recovery (`5043`) | provider `context_overflow`, ≤2/round, send budget <3 | same | aggressive summarize+truncate, re-run round | same |
| `digestOldGroups` (`2977`) | rounds > `digestAfterRounds` (6) AND pressure >0.55 | newest 5 assistant-tool groups verbatim; ≤6k digest | older groups → one line each (`tool target → ok/FAILED`, read excerpt ≤220) | none |
| session buffer (`context-engine.js:426 compact`) | >keep entries (24; 40 post-turn) | newest | oldest → 4k-char rolling summary | none |

## 4. Tool system

- **Defined/registered:** literals + `...createBrowserRemoteTools()` in `ToolRegistry` constructor (`src/core/tool-registry.js:1116`); + MCP (`getMcpTools`, `mcp_<server>_<tool>`), + forged (`ToolForge`, `workspace/tools/`, reloaded each boot), + plugins (`pluginRegistry`). Surfaced via `getAll(context)` (`tool-registry.js:6859`): merge → `getProductToolMetadata` → filter (`modelCallableOnly`/`productMode`: permission flags, `CODEX_GRADE_MODEL_TOOLS` allowlist ~215 ids at `tool-registry.js:849`, `mcp_`/`custom`/`plugin(code-mode)` passthrough) → `agentRegistry.filterTools` per agent. Measured (main, stub plugins): **276 total, 190 model-callable**.
- **Toolsets:** `TOOLSETS` 12 sets (`browser computer git-write git progress project comms memory-admin mcp web self forge`) + `CORE_ORDER` 17 (`tool-layers.js:11-18`). `buildMenu` = core + priority(explicit) + active, cap `MENU_MAX_TOOLS=30`, evicts core-tails first (write/observe core protected; browser canonical 8 guaranteed). `resolveMenuToolsets` (`omni-loop.js:1363`): keyword intent top-3 + `TYPE_TOOL_BOOSTS` + run/session pins. `list_toolsets` (counts menu-visible members), `load_toolset` (session pin + run enable, `toolset.session_pinned`), `enable_toolset` (run-only), `admitMenuMissTool` (pull one callable tool on demand).
- **Visible at start (default `menuV2:false`):** menu = CORE filtered to model-callable — measured **16**: `exec read_file write_file edit multi_edit list_files search_text web_search web_fetch delegate_task update_plan memory_search memory_write ask_user load_toolset list_toolsets`. `finish` (defined `tool-registry.js:1237`) is NOT in `CODEX_GRADE_MODEL_TOOLS` (absent from allowlist lines 849–1043, verified by search) so the default menu omits it; the loop still honors a `finish` call explicitly. Intent-matched sets (≤3) can add more up to the 30 cap.
- **Duplicates / overlaps** (tool → really calls → same impl?):

| Tool | Really calls | Same impl |
|---|---|---|
| `terminal` | `exec` | yes |
| `run_terminal_command` | shell executor (sibling of `exec`) | no (separate path) |
| `execute_code` | `code_execution` → `run_terminal_command` (python base64) | yes (chain) |
| `read` / `write` / `append_file`(alias note) | `read_file` / `write_file`+append backend | yes |
| `patch` | `apply_patch` | yes |
| `web_extract` | `web_fetch` | yes |
| `read_url` ↔ `web_fetch` | each other per `ALIAS_OF` | yes (alias pair) |
| `brave_search` / `exa_search` / `x_search` | `web_search` backends | yes |
| `send_message` / `sessions_send`(per `ALIAS_OF`) | `message` / `sessions_spawn` | yes |
| `cronjob` | `cron` | yes |
| `todo` | `create_task`/`list_tasks` | yes |
| `memory` | multiplexes `memory_search/memory_write/promote_memory/…` | yes |
| `vision_analyze` / `video_analyze` | `describe_image` per `ALIAS_OF` | yes |
| `image` | `analyze_attachment_media` | yes |
| `skill_view` | vendored Hermes files only | no (vs `skill_read` → registry) |
| `computer_use` | `computer_access_status` | yes |
| `open_browser_url` | OS browser, uncontrolled (NOT `browser_open`) | no |
| `process` | `systemMonitor.listProcesses` (vs `process_list` → shellExecutor registry) | no |

- **Alias/operator separation:** `ALIAS_IDS` 23 — callable, never in menu (except `CORE_ORDER` names stay by design, e.g. `web_search`); `getToolLayer` precedence core > alias > drop > operator > toolset > unmapped (`tool-layers.js:291`). `OPERATOR_IDS` 58 — UI/API only; `ToolRegistry.run` fails closed (`EOPERATOR`, or `EPLACEHOLDER` + named alternative from `PLACEHOLDER_REDIRECT`) unless `{operator:true}` (`tool-registry.js:7263-7296`; gate armed when `tools.menuV2===true`). `DROP_IDS` 17 — out of menu, code retained.
- **Schema token size (measured):** core-16 menu ~12.8k chars ≈3.2k tokens; 30-tool menu (core+`project`) ≈3.9k tokens; all 190 model-callable ≈83.8k chars ≈21k tokens (never sent at once; cap is 30).

## 5. Memory system

| Store | Location / format | Writers | Readers |
|---|---|---|---|
| Notes JSON | `data/memory.json` (`{notes[]}`), `MemoryStore.filePath` (`memory-store.js:93`) | `memory_write`→`writeLayeredMemory`, `remember_note` | `memory_search`/`hybridSearch`, `getNotes` |
| Root digest | `data/MEMORY.md` (`memory-store.js:94`) | promotion/compaction flows | `memory_get` overview |
| Long-term per agent | `workspace/agents/<id>/MEMORY.md` (+`DREAMS.md`, `memory/<slug>.md` per-fact, `memory/<today>.md` daily) (`memory-store.js:176-188`) | `writeLayeredMemory`, `promote_memory`, `compactLayeredMemory`, `learnFromRun`/`captureDurableFacts` (fire-and-forget, `omni-loop.js:6056-58`), `updateProfileFromMessage` (USER.md/PROFILE.md) | `getLongTermMemory/getDreams/getLayeredMemory`, `loadWorkspaceContext` (IDENTITY/USER/PROFILE → identity snapshot), pre-loop `getAgentContext` |
| Vectors | `data/semantic-memory/embeddings.json` (`semantic-memory.js:106-133`); `AdaptiveEmbedder` (provider `embeddingsModel` or 256-dim FNV lexical fallback) | memory writes (indexing path) | `hybridSearch` semantic branch, `prefetchAll` |
| Transcripts | `data/sessions.json` + `data/sessions/transcripts/<id>.jsonl` (`session-store.js:109-111,268`) | every turn (`appendMessage`), `run.resume` events | history loader, plan-inherit fallback, `sessions_history`/`session_search` |
| Evidence ledger | via `sessions.getEvidenceLedger` (files/edits/commands/findings) | tool executions during run | `buildEvidenceLedgerSection` (≤8k chars), read-before-edit seeding |
| Runs/events | `data/gateway.json` (`{seq,events,runs,approvals,delegations}`, runs capped last 120; `gateway-store.js:228-287`) | `gateway.createRun/updateRun/addEvent` | UI, `/api/runs/:id/*`, `task_trace` |
| Checkpoints | `data/checkpoints/<runId>/` (`file-checkpoint.js`; `restore_checkpoint` tool) | pre-write snapshots (loop, sub-agents, code_act share impl) | `restore_checkpoint` |
| Overflow | `tmp/tool-results/<run>-r<round>-<id>.txt` (7-day/50-file prune, `omni-loop.js:40-78`); `tmp/parse-failures/` | truncation persist; write-arg forensics | model via `read_file` on saved path |
| Learning | `data/instincts.json`, `data/playbooks.json`, `data/*curator-state.json`, `data/skill-review-state.json` | `learnFromRun/learnPlaybook`, curators | `buildInstinctsSection`, playbooks section |
| Misc state | `data/usage.json` (costs, `usage-store.js`), `data/model-registry.json`, `data/schedules.json`, `data/jobs.json`, `data/acp-sessions.json`, `data/coding-agent-harness.json`, `data/shell-audit.json`, `data/trust.json`, `data/secrets.json` | respective stores | status/summary tools |

- **Auto-injected per turn:** `active_memory.promptSection` (≤900 chars, ≤8 hits, `active-memory.js:149-165`; skipped during bootstrap), identity snapshot (names/location/preferences), memory brief (relevance+recency top-8, `rankMemoryItems`), evidence ledger (≤8k), history tool-activity block (≤1.8k, `omni-loop.js:3091-3120`).
- **Write tools:** `memory_write remember_note promote_memory memory_replace memory_forget memory_compact dream_memory_sweep update_progress log_decision` (+ file tools for USER.md/PROFILE.md). **Read tools:** `memory_search memory_recall memory_get list_notes list_long_term_memory session_search sessions_history sessions_list read_progress read_decisions`.

## 6. Skills

- **Where:** `skills/` (bundled: 7 `SKILL.md` dirs e.g. `hermes_*`, `browser-game-testing` + 16 `.skill` pointers e.g. `memory-assistant.skill`); `workspace/skills/`; `workspace/agents/<id>/skills/`; `data/skills/` (managed); `~/.mavis/skills` + `~/.mavis/agents/<id>/skills` (personal). Precedence: workspace-agent > workspace > personal-agent > managed > personal > bundled (`skill-registry.js:76-117`, `skills_list` note).
- **Format:** directory with `SKILL.md` + frontmatter (`name/description/tags/triggers`, parsed by `parseSkillMetadata`, `skill-registry.js:228+`); `.skill` files are small id/name/triggers/description + body pointers. Vendored Hermes skills under `vendor/hermes-agent/`; importers `hermes-skill-importer.js`, `openclaw-skill-importer.js`; install-time guard `skills-guard.js` (`assertSkillContentAllowed`); forged tools auto-author a SKILL.md (`tool-registry.js:6807`).
- **Into context:** `skills.match(message)` (`skill-registry.js:128`): whole-word overlap over name+description+tags+triggers (stopwords incl. Hinglish dropped), trigger substring hit +5, score>0, top 8; `capabilities` intent → all filtered skills (`agent.js:2566-2572`); compacted (`compactSkill`: desc 500/triggers 12/instructions 1200) → `contextBundle.skills` → `## Skills` name/id/desc-420/location/triggers (`system-prompt.js:162`); full method opened on demand via `skill_read {name}` (`tool-registry.js:5169`); usage recorded for curator (`recordSkillsUsed`).

## 7. Models & providers

- **Supported:** `openai-compatible` (any `/chat/completions` endpoint; native `x-api-key`+version headers for `api.anthropic.com`, `openai-compatible-provider.js`); `codex-cli` (shells the `codex` CLI; **default mode**, `config/default.json` provider section); `mock/local-rule-engine` (`MockProvider`, no-network fallback). Chosen by `config.provider.mode` in `createProvider` (`provider-factory.js`).
- **Active model:** `config.provider.{model,baseUrl,apiKeyEnv,apiKeyProviderId}`; readiness = env key OR stored BYOK key (`getApiKeyReadiness`); `/models` catalog persists `provider.contextTokens` which drives the loop's window (`contextWindowSource: model/config/default`); `data/config.json` overrides defaults; per-run `run.model` override (background/heartbeat cheap model).
- **Fallback:** final-synthesis candidates = agent `fallbackChain` + `provider.fallbacks` + `fallbacks` (`agent.js:3702`); in-loop `rotateProviderForRetry` walks the same chain once each per run (`omni-loop.js:3600`); `switch_model`/`list_provider_models`/`test_provider_profile` tools are model-side; `MultiProviderFallback` (`multi-provider-fallback.js`: `/models` health, `selectProvider`, `executeWithFallback`) exists as a class — wiring into the main loop UNVERIFIED.
- **Sub-agent model:** `runtime.subAgents`: `model:"inherit"` default = inherit parent endpoint+model as one binding; explicit id validated against endpoint `/models` cache, ladder down (fallback→parent→local) on failure (`sub-agent-spawner.js:59-133`); `fallbackModel` or `provider.compactionModel` on rate-limit; caps `maxConcurrent` 3, `maxPerHour` 30, `timeoutMs` 300k, `contextChars` 240k.
- **Compaction model:** `provider.compactionModel` (default `tencent/hy3:free`) for transcript summarization + `summarization-engine.js` + heartbeat compression; `reviewerModel` else compaction model for `evaluate_work`.

## 8. Sub-agents & external harnesses

| Tool (all `tool-registry.js`) | Backend (`*.run` delegates to) | Isolation / execution | Returns |
|---|---|---|---|
| `delegate_task` (`5613`, `allowTaskWrite`) | `subAgentSpawner.spawn` (`sub-agent-spawner.js:180`) | In-process child with OWN loop+context (reuses omni-loop format/repair/recovery), default 15 tools (`DEFAULT_SUBAGENT_TOOLS`), task ≥20 chars, timeout, optional tools/model/provider/systemPrompt; maxConcurrent/hour caps; parallel fan-out safe | Bounded `{status:completed/incomplete/failed, done, notDone, filesTouched, transcriptPath}`; incomplete ≠ success |
| `sessions_spawn` (`4923`) | `sessions.resolveSession` + full `agent.handleMessage` (`source:"sessions_spawn"`) | New child SESSION (parent-linked), full queued run — not a bounded worker | Child session/run ids immediately; result via events; `sessions_yield` contract (don't poll) |
| `acp_spawn` (`5003`, `allowShellExecution`) | `AcpManager.spawn` (`acp-manager.js:412`): probes CLI, builds shell command (`codex/opencode/claude/gemini/qwen/cursor…`, `taskArg` append/stdin/none) | EXTERNAL CLI subprocess; sessions in `acp-sessions.json` | Stored stdout/stderr/session metadata; companions `acp_doctor/status/sessions/cancel/close/set_option` |
| `agent_harness_spawn` (`5051`, `allowShellExecution`) | `CodingHarness.spawn` (`coding-agent-harness.js`): configured agents (`omniclaw-internal/codex/opencode/claude/gemini/qwen`, `config.codingHarness`) | EXTERNAL CLI subprocess with `successCriteria/verificationCommands/requiredArtifacts/constraints/context` | stdout/stderr/session + verification evidence; companions `agent_harness_doctor/status/sessions/cancel` |
| `best_of_n` (`5645`, `allowTaskWrite`) | `runBestOfN` (`tool-registry.js:7124`): N=2–3 `subAgentSpawner.spawn` in `outputDir/candidate-i` | Parallel isolated builds, deterministic scoring (completed 1 + entry 3 + substance 1 + files 1 + html checks 1+1 + verify 4) | Winner copied to `outputDir/best`; scratch-builds only |
| `evaluate_work` (`5663`) | `subAgentSpawner.spawn` (read-only+exec tools, skeptical reviewer prompt) | Independent reviewer agent; model = `reviewerModel` else `compactionModel` | A/B/C/D scores + PASS/FAIL verdict |

## 9. Tests & observability

- **Tests:** `tests/api/` — `fs git tool-events system sessions config caps approvals browser-managed session-toolsets subagent-models` (+ `provider-select` NOT in `npm test`, + `_helpers.mjs`). `npm test` = health-smoke + those 11 files. Result this survey: **health-smoke passed; `node --test` 72 pass / 0 fail / 16 suites (~33s)**. (Full `npm test` single invocation not run — parts run separately; `npm test` composition from `package.json:22`.) ~124 `scripts/*-smoke.mjs` + `test:<area>` scripts cover loop/contract/tools/browser/memory/budget/guards; `arch-scan.mjs` enforces `arch_rules.json`.
- **Logs/traces:** `data/gateway.json` (runs ≤120 + event log); `data/sessions/transcripts/*.jsonl`; `GET /api/runs/:id/prompt-trace` + `/tool-trace` (`server.js:1004-1026`); `GET /api/events` SSE; `task_trace` tool; `omni_loop.*` / `model_tool_loop.*` / `context.*` gateway events; `logs/` (server/dev); `tmp/tool-results/` + `tmp/parse-failures/`; `data/checkpoints/`; auto PROGRESS.md entries; `data/ctxmem*.log`, `data/usage.json`, `data/*.log`.

## 10. Honest observations (5 tangled parts)

1. **God-object agent + two loops** (`src/core/agent.js`, 9,586 lines): `handleMessage→executeMessageRun→runModelToolLoop→OmniLoop` plus a full legacy JSON loop, post-loop repair/verification/synthesis, and dozens of pre-loop prefetch steps live in one class; OmniLoop and legacy duplicate stop/repair/final logic, and readers must track which loop actually ran (`report.loopEngine`).
2. **Tool identity sprawl** (`src/core/tool-registry.js` + `src/core/tool-layers.js`): one capability under many ids (`read/read_file`, `write/write_file/append_file`, `exec/run_terminal_command/terminal`, `web_search/brave_search/exa_search/x_search`, `web_fetch/read_url/web_extract`); three overlapping alias layers (`ALIAS_OF`, HERMES compat rows, direct `this.tools.X.run` delegation); `finish` defined yet absent from the model-callable allowlist while the loop explicitly waits for it.
3. **Split-brain context budgets** (`src/core/context-engine.js` vs `src/core/omni-loop.js` vs `src/core/system-prompt.js`): bundle `maxChars`/`modelAwareCap` vs loop `contextCharBudget`/`compactAtPercent` vs 18k workspace ceiling, plus `prompt.v2` diet flag and `menuV2` flag — final prompt bytes are hard to predict without running.
4. **Model binding scattered** (`provider-factory.js`, `config/default.json`, `sub-agent-spawner.js`, `model-registry.js`, `multi-provider-fallback.js`): mode + profiles + 3 fallback lists + inherit-model + compaction/reviewer models + per-endpoint health registry; the code itself notes a model id is meaningless without its endpoint.
5. **State in two speeds** (`gateway-store.js`, `session-store.js`, `tool-registry.js` Maps): durable runs/transcripts/ledger vs in-memory `runPlans/sessionPlans/runToolsets/sessionToolsets` (lost on restart, with a `run.resume` transcript fallback); toolsets also in `session.pinnedToolsets` — three sources merged per round.
