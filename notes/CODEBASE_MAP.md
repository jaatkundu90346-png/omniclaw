# OmniClaw Codebase Map (full read — 2026-06-10)

Purpose: complete understanding of every module so the new clean agent loop (OmniLoop)
can connect to ALL existing features. Updated incrementally during the full read.

## Totals
- ~57,848 lines JS (src/core + server.js + public)
- Big files: agent.js 9269, app.js 6562, tool-registry.js 5767, connector-store.js 3003,
  planner.js 2782, server.js 2381, ws-gateway.js 1411, workspace-bootstrap.js 1310,
  coding-agent-harness.js 1148, memory-store.js 1078, session-store.js 1050

## Foundation layer
- **config-store.js**: ConfigStore. default.json + data/config.json deep-merge.
  getConfig/getProfile/getActiveProfile/updateUserConfig/applyProviderProfile/validateConfig.
- **secret-store.js**: SecretStore -> data/secrets.json. providerKeys + connectorSecrets.
  getProviderKey(providerId), setProviderKey, masked statuses.
- **event-bus.js**: tiny pub/sub. on/off/emit + "*" wildcard listeners.
- **file-store.js**: FileStore. Workspace-rooted (resolveWorkspacePath within rootDir,
  writableRoots check) + computer-wide ops (resolveComputerPath w/ allowedRoots + blockedPathPatterns).
  listDirectory/readText/writeText/listComputerDirectory/searchComputerFiles/readComputerText/
  writeComputerText/createComputerDirectory/copy/move/deleteComputerPath (trash by default).
- **task-store.js**: data/tasks.json. createTask (objective/plan/toolPlan/acceptanceCriteria/automation),
  listTasks(agentId), updateTask. Agent-scoped via agentId filter.
- **job-store.js**: data/jobs.json. queued/running jobs, retry {maxAttempts, delayMs},
  getNextQueuedJob, cancelJob.

## Memory layer
- **memory-store.js** (1078): data/memory.json {conversations, notes, research, artifacts,
  attachmentExtracts, longTerm, dreams} + data/MEMORY.md generated. mtime cache.
  - appendConversation, addNote, getRecentConversations(limit, agentId)
  - Layered memory (OpenClaw style): workspace/agents/<id>/memory/<date>.md daily,
    workspace/agents/<id>/MEMORY.md long-term, DREAMS.md. writeLayeredMemory(type long-term promotes).
  - promoteMemory (dedupe by sourceRef), getPromotionCandidates (notes/conversations/research/extracts
    heuristic scores), scoreCandidatesWithModel(provider JSON array), runDreamSweep -> promote >= minScore.
  - hybridSearch: keyword score (0.7) + semanticMemory.searchText similarity (x3), flattenMemoryItems
    over all layers. searchAll/searchNotes/etc plain substring.
  - Mavis-style: ~/.mavis/memory/user.md, ~/.mavis/agents/<id>/memory/MEMORY.md + topics/. 15/20KB limits.
  - prefetchAll: overview+recent+search bundle for active memory.
- **semantic-memory.js**: SimpleTextEmbedder (256-dim FNV hash bag-of-words, normalized) +
  SemanticMemory (data/semantic-memory/embeddings.json, cosine search, addText/searchText).
  NOT real embeddings — hash-based. searchText threshold 0.35.
- **active-memory.js**: ActiveMemory plugin-ish. getSettings from runtime.activeMemory config.
  run({message, agentId, session}) -> prefetchAll w/ timeout -> summary wrapped in
  <active_memory_plugin> fenced block as promptSection. Gateway events active_memory.*.
- **memory-sdk.js**: MemorySDK. textToVector 32-dim char-hash cosine search over
  conversations/longTerm/notes; citations jsonl; artifacts data/memory/artifacts/<id>.json.
- **summarization-engine.js**: per-session summary data/sessions/summaries/<sessionId>.json.
  Re-summarizes every 10 new messages via provider.complete. Events session.summarization_*.

## Session/Gateway layer
- **session-store.js** (1050): data/sessions.json (v2) + transcripts data/sessions/transcripts/<id>.jsonl.
  Session: key agent:<agentId>:<channel>:<label>, status idle/running/queued/archived, activeRunId,
  queuedRunIds, deliveryContext (channel docking), previews.
  - resolveSession creates-or-finds by key; auto-reset on idle timeout (archive + new).
  - appendMessage writes transcript entry {type:message, role, text, toolOutputs, modelToolLoop,
    finalMetadata...}; startRun/markRunStage/finishRun transcript run phases; appendSystemEvent.
  - compactSession(maxEntries=80): keeps last 60%, writes type:compaction summary entry. NOTE: naive.
  - rotateSession(handoffPath): parse handoff MD sections (goal/progress/modifiedFiles/keyDecisions/
    openQuestions/nextSteps), archive old, new session with parentSessionId lineage, handoff entry.
  - cleanupProblemSessions regex purge. archiveSessionInData moves transcript to archive/.
- **gateway-store.js**: data/gateway.json {seq, events(cap 200), runs(cap 120), approvals, delegations}.
  EventEmitter onEvent + addEvent (also forwards to agentRef.eventBus). createRun/updateRun/getRun.
  createApproval/resolveApproval (events approval.*). createDelegation/updateDelegation.
  compactRun aggressively truncates run records on write (toolOutputs last 12, compacted).
  expireOldApprovals(30min). Atomic-ish write with rename retry (Windows EPERM).
- **agent-registry.js**: agents from config.agents (map or list). normalizeAgent: profileId,
  workspacePath, allowedTools/blockedTools/blockedPermissions/allowedSkillIds/fallbackChain/channels.
  filterTools/filterSkills/isToolAllowed (permission-based blocking). summarizeAgents stats.
  resolveAgentIdByWorkspacePath (longest-match).

## Provider layer
- **provider-factory.js**: createProvider(configStore, secretStore) by provider.mode:
  openai-compatible | codex-cli | mock. getProvider(profileId) builds temp provider from
  providerProfiles entry (returns null if key missing).
- **openai-compatible-provider.js** (504):
  - getResolvedApiKey: env var OR secretStore BYOK.
  - complete(messages, input): plain chat.completions, max_tokens defaults plannerMaxTokens||700 (!).
  - **completeWithTools(messages, {tools, toolChoice, maxTokens})**: native function calling,
    returns {text, toolCalls[{id,tool,input,type}], assistantMessage, usage, nativeTools:true}.
    KEY API for OmniLoop. Falls back to complete() when no tools.
  - respond(context, retries=2): legacy giant single-prompt synthesis (the weak path),
    429/5xx retry with retry-after.
  - testConnection / listModels.
- Headers: Authorization Bearer, HTTP-Referer, X-OpenRouter-Title.

## Tool layer (tool-registry.js, 5767 lines, partial so far)
- CACHEABLE_OBSERVATION_TOOLS: read-only tools cached per agent:run:tool:input key.
- SIDE_EFFECT_TOOLS: dedup guard (duplicateSideEffectKeys) for writes/exec/messaging.
- validateAgainstSimpleSchema: simple required+type check.
- apply_patch: Codex-style *** Begin Patch / Add File / Update File / Delete File / hunks
  with context matching (findLineSequence).
- OPENCLAW_COMPAT_SKILL_PACKS: imports vendor/openclaw skills (browser-automation, coding-agent,
  github, healthcheck, session-logs, skill-creator).
- HERMES_COMPAT_TOOLS: alias map (terminal->run_terminal_command etc). Many placeholders
  (kanban_*, ha_*, tts...). LIMITED_PRODUCT_TOOLS marks partial/placeholder w/ replacement.
- CODEX_GRADE_MODEL_TOOLS: ~110 ids whitelist of "model-callable" tools.
- ToolRegistry ctor deps: memoryStore, taskStore, configStore, fileStore, shellPlanner,
  shellExecutor, webResearch, browserOperator, browser(Playwright), sandboxRunner, systemMonitor,
  taskRunner, customizationEngine, pluginRegistry, agentRegistry, connectorStore, agentRuntime,
  subAgentSpawner, acpManager, codingHarness.
- Tools defined as map this.tools = { id: {description, permission, group?, schema?, run(input, context)} }.
- (more tool defs + run() pipeline in lines 1200-5767 — see continuation below)

## Agent loop (agent.js — from earlier inspection)
- OmniClawAgent.executeMessageRun = the mega-path: intent engine -> planner -> heuristic tools ->
  runModelToolLoop (buildModelToolLoopPrompt giant JSON-in-text prompt, observations sliced 8000 chars,
  re-built every round, JSON tool_call parsing, nativeToolCalling:false default) -> synthesis
  (synthesizeFinalWithProvider) -> session/memory/gateway updates.
- Many compensation heuristics: getDynamicRequiredToolIds, buildFallbackToolCall,
  shouldPreferRuntimeToolReply, looksLikeUnexecutedToolClaim, pickBestResearchObservation.
- Session run queue: getSessionRunQueue/enqueueSessionRun/drainSessionRunQueue (busy guard).
- Delegations queue (queueDelegation/cancel/retry), webhooks, adapter attachments ingest.
- Run trace: buildPromptTrace, upsertRunToolTrace, getToolTrace, getPromptTrace.

## agent.js DETAILED (read 202-430, 2223-2922, 5577-6030)
- Constructor wires EVERYTHING: config, secrets, trust, memory, sessions, gateway(+agentRef),
  activeMemory, eventBus (process.output/status -> tool.output events), shellAudit, connectors,
  jobs, schedules, tasks, skills(SkillRegistry), workspace(WorkspaceBootstrap), agents(AgentRegistry),
  plugins, files, shellPlanner, shellExecutor, acp(AcpManager), codingHarness, webResearch,
  intentEngine, planner, provider(createProvider), embedder+semanticMemory, deepResearchAgent,
  multiProviderFallback, subAgentSpawner, taskRunner, customizationEngine, contextEngine,
  browserOperator, browserPlaywright, visualBrowserOperator, sandboxRunner, systemMonitor,
  v2Health, ToolRegistry, goalManager, reflectionEngine, autonomousCheckpoints, autonomousRuntime,
  worker(BackgroundWorker), scheduler, heartbeat (30min: memory dream sweep, approval expiry,
  session compaction >150 msgs), autonomousDaemon, mcp(McpRegistry), workspaceIdentity (root
  SOUL/USER/MEMORY/AGENTS/IDENTITY.md 10k chars), telegramWorker, discordWorker, summarizer,
  sessionRunQueues Map.
- executeMessageRun(job) flow:
  1. provider re-created each run. startRun busy-guard w/ stale recovery.
  2. events: intake, session_queue, agent.accepted; appendMessage user; contextEngine.ingest.
  3. resolveAgent, profile, loadWorkspaceContext, buildAgentLoopContract.
  4. tools.getAll({modelCallableOnly:true}); intentEngine.detect; skills.match.
  5. Bootstrap ritual (BOOTSTRAP.md) > greeting override > /acp / /harness / /mcp slash commands.
  6. forcedResponse (offline/greeting/onboarding) OR planner.buildPlanWithModel.
  7. If NOT providerFirst-eligible: deterministic plan tool steps executed via tools.run with
     tool.started/completed/failed events + toolTrace + shell approval/auto-approve handling.
  8. providerFirst skips heuristic tools when modelToolLoop.providerFirst && provider ready &&
     no deterministic intent (file-read/write, shell-plan, project-test, complex-build etc).
  9. runModelToolLoop: builds nativeMessages [system, user giant prompt]. Per round:
     - rebuilds giant JSON-text prompt with ALL observations (8000 chars cap) — loopMessages
     - if settings.nativeToolCalling && completeWithTools: native attempt with toolChoice
       required/auto, timeout min(roundTimeout, nativeToolTimeoutMs=8000!) -> fallback JSON on error
     - parse calls; required-tool recovery (getDynamicRequiredToolIds, buildFallbackToolCall,
       getNextWebFetchCandidate); final-ready heuristics; repeated-call caps; auto-verify;
       auto-repair pass.
  10. After loop: runRequiredToolRepair if still missing; synthesis path
      (shouldPreferRuntimeToolReply / synthesizeFinalWithProvider / provider.respond);
      memory.appendConversation; session appendMessage assistant; finishRun; agent.done.
- NATIVE LOOP EXISTS but default off + 8s timeout makes it nearly always fall back to JSON mode.
- nativeMessages only grow in native mode (assistant tool_calls appended; tool results appended
  via buildNativeToolResultMessage) — but the user prompt inside is still the giant rebuilt blob.

## KEY PROBLEMS (why it loses to Claude Code)
1. No persistent message transcript to model — prompt rebuilt each round, observations JSON
   blob truncated to 8000 chars.
2. nativeToolCalling:false default -> fragile JSON-in-text parsing.
3. provider.maxTokens 1200 (default.json), plannerMaxTokens 450 — brain throttled.
4. complete() uses plannerMaxTokens||700 default — even worse for loop usage.
5. 80 tools shown per round w/ thin descriptions.
6. Intent engine (791 lines keyword matching) + planner (2782) run before model; synthesis layer
   rewrites model output.

## Remaining modules (full read pass 2026-06-10)
- **system-prompt.js** (446): buildOmniClawPromptSections(context) -> sectioned prompt:
  identity, bootstrap ritual, tooling (<available_tools> XML), harness/MCP, execution bias,
  safety, skills, openclaw control, active memory, identity/user memory snapshot, workspace files
  (sanitized w/ prompt-injection defense + invisible-unicode strip), documentation, sandbox,
  runtime (loop contract), output directives (Hinglish mirroring!). REUSE THIS for OmniLoop system prompt.
- **context-engine.js** (704): compaction helpers (compactConversation/Skill/Tool/ToolOutput/
  Research/Note/LongTerm/WorkspaceFile/Harness/Mcp) + budget assembly w/ report
  {usedChars, maxChars, omittedItems} + contextManifest ingredients. ingest() feeds entries.
- **shell-executor.js** (455): governed PowerShell/bash exec. getPolicy from config
  (allowlistMode advisory/enforce, trustLevel, blockedPatterns, allowExternalCwd + computer roots,
  blocked cwd patterns). executeSync (timeout max 15min, output truncate, taskkill tree),
  executeBackground -> processId registry + eventBus process.output/process.status events.
  listProcesses/getProcessStatus/killProcess/cleanupProcesses.
- **shell-policy.js**: analyzeShellCommand -> {risk, allowlisted, reasons}; DEFAULT_ALLOWLIST/BLOCKED.
- **web-research.js** (856): WebResearch.search(query, {maxResults, fetchTop, provider...})
  multi-provider (tinyfish/brave/exa/duckduckgo fallback), scoreSearchResult ranking
  (official-source boost), mergeRankedResults, fetchUrl(url, maxChars) -> page text.
- **sub-agent-spawner.js** (285): SubAgentSpawner.spawn({task, tools, timeoutMs}) — own messages[]
  transcript loop w/ provider.chat||complete, max 10 rounds, max 3 concurrent. BUG: executeToolCall
  uses tool.run from getAll() definitions (no run fn there) — broken for real tool exec;
  buildToolDefinitions emits empty parameters {}. OmniLoop should replace its inner loop.
- **skill-registry.js** (538): Mavis-style precedence: workspace-agent > workspace > personal-agent
  (~/.mavis) > managed (data/skills) > personal > bundled (skills/). SKILL.md dirs + .skill files.
  match() keyword+trigger scoring.
- **heartbeat.js** (268): interval ticks (default 30min), HEARTBEAT.md tasks (name/interval/prompt),
  activeHours gate, checks registered by agent ctor (dream sweep, approval expiry, session compaction).
- **scheduler.js/schedule-store.js**: 1s poll tick -> getDueSchedules -> enqueue jobs via
  BackgroundWorker; cron-interval-parser for every/cron/at.
- **coding-agent-harness.js** (1148): spawn external CLI coding agents (codex exec, claude -p,
  opencode run, gemini/qwen --prompt) OR internal omniclaw harness. TaskSpec w/ successCriteria,
  verificationCommands, requiredArtifacts; runVerification executes commands after; doctor() probes
  CLIs; sessions persisted; /harness slash commands.
- **acp-manager.js** (688): ACP protocol session control plane (spawn/cancel/status) for external
  agents w/ acpx; /acp slash commands.
- **mcp-client.js** (318): McpClient stdio/http JSON-RPC (initialize, tools/list, tools/call),
  McpRegistry from data/mcp-servers.json; getAllTools -> mcp_<server>_<tool> ids; callTool routing.
- **agent-loop-runtime.js** (80): buildAgentLoopContract (stage list) + emitAgentLoopStage events.
- **agent-loop-controller.js** (166): budget guard (maxSteps, toolBudget, repeat cap) + canonical
  events agent.thinking/tool.started/tool.output/tool.completed/tool.failed/agent.reviewing/agent.done.
  REUSE for OmniLoop event contract.
- **codex-cli-provider.js** (406): default provider! spawns codex CLI (exec --skip-git-repo-check),
  read-only sandbox, liveEnabled flag (default FALSE -> not ready). No native tools. Single-shot text.
- **multi-provider-fallback.js** (188): health-check /models 60s cache; executeWithFallback w/
  exponential backoff. NOTE: buildFallbackChain takes first 2 providerProfiles arbitrarily.
- **goal-manager.js / reflection-engine.js / autonomous-***: TAOR loop machinery (commit 6c7adfd),
  provider-prompted goal decomposition + outcome analysis w/ heuristic fallbacks.
- **deep-research-agent.js** (210): iterative search->analyze->refine, synthesizeFindings.
- **browser-playwright.js** (525): real Playwright sessions: open/view(markdown+screenshot)/click/
  type/scroll/wait/evaluate/press/automate/listSessions; screenshotDir data/browser-screenshots.
- **browser-operator.js** (662): non-Playwright fallback browser ops + openUrl default browser.
- **visual-browser-operator.js**: vision-provider-based click/type by description (vision not wired).
- **ws-gateway.js** (1411) + **gateway-ws-protocol.js** (596): ws://localhost:3147/ws req/res/events;
  methods: agent.send, sessions.*, approvals.*, cron.*, delegations.*, memory.*, tools.invoke,
  config.*, channels.*, gateway.events/status, health.check. Role-based scopes + device pairing.
- **server.js** (2381): HTTP routes (see /api/* list): /api/chat -> agent.handleMessage;
  /api/chat/stream SSE filters events ^(agent|tool|model_tool_loop|auto_verification|provider|
  context|shell|terminal|approval|run)\. ; /api/events SSE broadcast via gateway.onEvent;
  autonomous/execute|status; mcp, harness, connectors, memory, plugins, auth/pairing, design/stitch.
- **public/app.js** (6562): dashboard SPA — chat transcript + live-run-output (SSE events),
  panels for state/inspector/research/artifacts/memory/runtime/provider forms.
- **planner.js** (2782): buildPlan heuristics per intent (path/url/write extraction, generated
  web artifact templates 1300+ lines!), buildPlanWithModel merges model JSON plan but preserves
  heuristic tool steps. Used by chat path + TAOR think phase.
- **connector-store.js** (3003): telegram/discord/webhook adapters, deliveries, outbox,
  attachment cache + media analysis.
- **customization-engine.js**: createSkill, updateRuntimeSettings, configureProviderBrain
  (atomic profile+key+test), listProviderModels.
- **openai-api.js** (367): OpenAI-compatible /v1/chat/completions server endpoint exposing
  OmniClaw as a model (openclaw bridge).
- **channels.js**: channel descriptors; session-lifecycle.js: archive/reset rules;
  bootstrap-sequence.js: first-run flow; device-trust-store: pairing tokens/roles;
  v2-feature-health.js: feature scoring; tool-resolver.js: alias resolution;
  hermes/openclaw-skill-importer: vendor SKILL.md -> .skill conversion.

## OMNILOOP IMPLEMENTATION STATUS (2026-06-10)
DONE:
- src/core/omni-loop.js created: OmniLoop class + getOmniLoopSettings.
  Transcript messages[] (system + session history + user), native function calling via
  provider.completeWithTools, tool exec via toolRegistry.run (source: "omni-loop"),
  tool results as role:"tool" messages (per-result truncation maxToolResultChars),
  transcript compaction (oldest tool results collapsed first, tail 8 protected),
  AgentLoopController events + model_tool_loop.round_started/tool_started/tool_completed +
  omni_loop.started/completed gateway events, repeat-call cap, unknown-tool rejection,
  budget-exhausted honest summary via provider.complete, provider retry on 429/5xx/timeout.
  Returns {report, toolOutputs} matching runModelToolLoop contract; report.loopEngine="omni-loop".
- agent.js wiring: import + this.omniLoop in ctor; runModelToolLoop delegates at top when
  omniLoop.isEligible({forcedResponse}); letProviderChooseToolsFirst includes omniLoopTakesOver
  (skips heuristic plan tools); planner.buildPlanWithModel skipped (stub plan source:"omni-loop");
  post-final required-tool repair skipped for loopEngine==="omni-loop"; 4 answer-rewrite
  heuristics (normalizeAssistantReplyStyle etc.) bypassed for omni-loop replies.
- config/default.json: runtime.omniLoop block (enabled, maxRounds 60, maxTokens 8000,
  roundTimeoutMs 180000, maxToolResultChars 10000, historyMessages 24, contextCharBudget 300000,
  maxTools 64); provider.maxTokens 1200->8000, plannerMaxTokens 450->900, timeoutMs 45000->180000;
  modelToolLoop.nativeToolCalling true + nativeToolTimeoutMs 60000 (legacy fallback better too).
- scripts/omni-loop-smoke.mjs (npm run test:omni-loop): 12 offline assertions ALL PASS
  (transcript shape, truncation, multi-round, rejection, budget summary, repeat cap).
- npm run build passes. data/config.json switched: codex-cli -> openai-compatible OpenRouter
  (key stored in secrets as "openrouter"), stale nativeToolCalling:false override removed.
LIVE TEST STATUS: ALL PASSING (2026-06-10)
- OpenRouter paid models: 402 insufficient credits. Free models with tools: 19 available.
- WORKING MODEL: nvidia/nemotron-3-super-120b-a12b:free (1M ctx, native tool calls verified).
  data/config.json: openai-compatible + openrouter key + this model + maxTokens 4000.
- E2E test 1 (read task): list_files -> read_file -> correct Hinglish answer incl. NEW
  test:omni-loop script (proof of real read). 3 rounds, model-final-ready.
- E2E test 2 (write+exec+verify): wrote scratch/fib2.js, ran node, verified output
  0 1 1 2 3 5 8 13 21 34, clean final answer with evidence. 5 rounds, 4 tool calls.
- EXTRA GUARDS ADDED for omni-loop: runAutoVerificationPass skipped (model verifies itself);
  required-tool repair skipped; 4 answer-rewrite heuristics bypassed; repair loop consequently
  skipped. All legacy paths unchanged for codex-cli/mock/offline mode.

## OmniLoop design decisions (original plan)
- New module src/core/omni-loop.js: transcript messages[], native tool calling via
  provider.completeWithTools, per-tool-result truncation (not whole-history slicing),
  compaction via summarization when context budget hit.
- Reuse: ToolRegistry.run(id, input, {agentId, sessionId, runId}) for execution,
  agentRegistry.filterTools for permissions, gatewayStore.addEvent for UI events,
  sessionStore transcript for persistence, activeMemory promptSection for memory recall,
  workspace-bootstrap files for system prompt identity.
- Config flag: runtime.omniLoop.enabled to route executeMessageRun through new loop.
