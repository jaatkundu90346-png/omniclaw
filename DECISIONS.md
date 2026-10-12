# DECISIONS — Why-we-did-it log

## 2026-10-10 — Bots feature deleted, agent-to-agent delegation kept
- **Decision A:** the Bots product is gone from UI and backend, but `delegation-bridge.js` + `delegate_task`'s agent-handoff mode stay.
  - **Reason:** a delegation record is created by `delegate_task` with a `targetAgentId`, which works for ANY agent. Deleting the bridge would have removed a coding-agent capability (hand a self-contained subtask to another agent) that has nothing to do with bots. Only the *vocabulary* said "bot"; it now says "agent". The bots-only entry points (`/api/bots/:id/tasks`, `/api/bots/:id/tasks/omniclaw`, the composer `@Bot ...` prefix and `ask_omniclaw`) are gone with the feature.
- **Decision B:** delete the bots *data* files' consumers but leave `data/bots.json` + `data/bots/` on disk.
  - **Reason:** they are user data (per-bot chats, MEMORY.md, workspaces), not code. Nothing reads them any more, so they are inert; removing them is a separate, deliberate user-data decision, not a side effect of a code change. `npm run memory:compact` / a manual delete can clear them whenever the user wants.
- **Decision C:** renamed rather than left bot-flavoured. `normalizeBotLabel` → `normalizeAgentLabel` etc., `?botId=` → `?agentId=`, `botChip` → `ui/agent-chip.js`.
  - **Reason:** a helper named `normalizeBot*` that every agent passes through is exactly the naming blur that made bots and agents look like one product. The chip had to become avatar-free because its only data source was `GET /api/bots`; keeping an avatar lookup would have meant keeping a dead request.

## 2026-09-26 - Context Organization Layer: tiers + one map, plus tool-admission fairness
- **Decision A:** every context source is tiered in `src/core/context-manifest.js` - T0_CORE (always inline, never collapsed), T1_TASK (this run, capped, collapses to a pointer naming the exact refetch call), T2_ON_DEMAND (named in the map, never bulk-injected), T3_STORE (persistent, reached only via T2). A new **Context Map** block is rendered into Zone A naming what is inline vs fetchable.
  - **Reason:** the harness had ~30 prompt sections with caps invented in three different files, so the model got a flat wall with no map of what existed. Weak models then re-discover, re-plan and stall. The map is the cheapest possible fix for "bhoot think, kaam zero": scattered "read it with read_file" hints become one contract, and it is cache-stable (deterministic, no timestamps).
- **Decision B:** in `buildMenu`, an intent-MATCHED toolset gets a bounded slice (`INTENT_SET_SLOTS=6`; browser keeps its 8 canonical) out of the budget left after CORE and explicitly loaded sets; only a genuinely oversized *explicit* set may still evict core-tail.
  - **Reason (measured):** a browser-style message matched browser+progress (53 members); the 30-cap then evicted `memory_search`/`memory_write`/`ask_user`/`web_search`/`web_fetch` and finally the whole browser set, so a browser task ran with zero browser tools and no memory/web search. A focus hint is not an operator command; it must never cost the model its core tools.
- **Decision C:** stored conversations are bounded **digests** (newest 12 tool outputs at 600c each, plan reduced to an allowlist - no `toolsAvailable`/`modelToolLoop`, user/assistant capped).
  - **Reason:** nothing downstream reads the rest - `compactConversation` keeps user/assistant/intents/plan-summary plus a tool *count*, and the session transcript is the real record. Measured 60.3MB store -> 7.9MB with all 755 conversations' user text intact.
- **Decision D:** `writeStructuredMemory` redacts by value pattern, and `secret-redact.js` now also matches hyphenated `sk-live-...` keys.
  - **Reason:** a memory file is indexed in MEMORY.md and can be read into context (and shipped to a provider). A real `sk-live-...` key was found in `workspace/agents/main/memory/`. Durable memory must never be a credential store.
- **Decision E:** the workspace ALWAYS-inline set is AGENTS/SPRINT only (PROGRESS.md and DECISIONS.md are auto-written logs; a 1.2KB slice of a 29.5KB decision log is noise, the index line plus purpose is the signal), and skills are one-line pointers capped at 8.
- **Rejected:** shrinking the tool menu below 30 (a wrong-argument round costs more than the tokens saved); collapsing a *normal* memory brief to a pointer (weak models rarely call `memory_search` unprompted - the cap sits just above the brief's natural ~8.2KB bound so only runaway sizes collapse); redacting the raw JSON text of memory.json (it can produce invalid JSON - redact after parsing, field by field).


## 2026-09-23 — Model-aware context budget + idle (not hard) round timeout
- **Decision A:** char budgets `provider.contextTokens` se scale hote hain (~0.5 chars/token; v2 ceiling 120k, v1 ceiling 160k), aur `buildV2` section caps total ke saath proportional scale hote hain. No contextTokens → legacy byte-identical.
- **Reason A:** live 1M-window model ko 28k chars (7k tokens) mil rahe the — 311 items/turn omitted → model state re-discover karta raha (over-thinking + zero writes ka root). Fixed section caps ko scale kiye kyunki total akela badhane se wahi items omit hote rehte (omission section-level tha, total-level nahi).
- **Decision B:** `roundTimeoutMs` = max silence between tokens (reset per chunk); `roundHardCapMs` (600s default, configurable) = absolute per-attempt ceiling; provider fetch timeout = hard cap.
- **Reason B:** live round 180s par exact cut hua while streaming — free models slow hain (1.5-8 min/round), "aliveness" hona chahiye deadline. Silence-based failover (first-token 45s + idle 180s + retries) intact hai.
- **Rejected:** unconditional roundTimeout badhana (silent stalls ko bhi slow kar deta); v2 band karna (diet ka focus feature hai — model-aware karke dono mil gaye).

## 2026-09-23 — Project context = selected folder only + update_plan empty call is a getter
- **Decision 1:** `loadWorkspaceContext` ke project-docs scan ka root `chatProjectDir` (selected workspace) hai, app dir nahi. **Reason:** rootDir/cwd scan karne se OmniClaw ke apne AGENTS.md/SPRINT.md/feature_list.json user ke empty project me inject hote the — model galat repo ka playbook follow karke 13 rounds jala gaya (live evidence). Selected folder = app repo ho toh behavior unchanged, toh dogfooding safe.
- **Decision 2:** `update_plan` ko bina args call karna ab "current plan dikhao" getter hai (error nahi). **Reason:** weak models plan dobara dekhne ke liye `update_plan {}` emit karte hain; teaching block × 4 bhi unhe rok nahi paya (stuck-no-progress tak gaya). Getter spiral ko forward motion me badalta hai — honest hai (kuch fake nahi, bas current state return hota hai).
- **Decision 3:** required-args teaching example ab schema-type-shaped hai (array → real item skeleton) + spin≥2 pe explicit "tool chhod do" escalation. **Reason:** `"<array>"` placeholder weak model ko string bhejne pe majboor karta tha; escalate na karne se stuck detector hi aakhri rok thi.
- **Rejected:** empty-args auto-synthesize (model ke intent ka guess = jhootha plan); provider slowness ka harness workaround (free-tier latency provider-side hai — user ko model switch suggest kiya).

## 2026-09-23 — Menu starvation: write-tools protected + intent matches capped at 3
- **Decision:** `buildMenu` ke PROTECTED_CORE me write/observe essentials (`write_file, edit, multi_edit, list_files, search_text`) permanent protect kiye; `resolveMenuToolsets` me intent-matched toolsets top-3 capped (explicit pins exempt).
- **Reason:** Live run evidence — 8 intent-matched toolsets ne 30-cap ke andar write_file/edit evict kar diye; model ne sahi pehchana "no write_file" aur shell hacks plan kiye. Eviction order "core tails first" theek hai, lekin write tools kabhi "tail" nahi ho sakte — woh coding agent ki definition hain. Intent cap isliye kyunki lamba brief sab keywords hit karta hai; discovery (`load_toolset`/`list_toolsets`) free hai, toh top-3 se focus badhta hai, capability ghatti nahi.
- **Rejected:** cap badhana (30 → zyada) — weak models ke liye menu focus hi feature hai; minScore>=2 filter — "youtube kholo" jaise single-keyword legit intents toot jaate.
- **Reusable rule:** model jab kahe "mere paas tool X nahi hai", pehle `toolset.menu` event + `buildMenu` repro se verify karo — weak model bhi menu ke baare me sach bol sakta hai.

## 2026-09-23 — Workspace awareness: stronger ONE ROOT line + name-only Zone C pointer
- **Decision:** Model ko selected workspace folder ka sense dene ke liye (a) `Project root:` line ko explicit kiya (`formatProjectRootLine` — "you are working INSIDE this folder", date-like folder name ka pre-emption), (b) identity section me behavioral rule, (c) Zone C volatile tail me folder ka **naam-only** pointer line (path nahi).
- **Reason:** ONE ROOT invariant (path exactly 1 jagah, `one-root-smoke` + `zone-stability-smoke` enforce karte hain) ko todna nahi tha — isliye Zone C me path ke bajaye sirf basename + pointer. Zone C har turn fresh hai, toh mid-session folder switch bhi sahi dikhta hai; Zone A cache-stable rehta hai. Weak/free models prompt ke END wali line sabse zyada attend karte hain.
- **Rejected:** Zone C me full path (ONE ROOT rule tootta, 2 smokes fail); naya filesystem-location section (wahi rule).
- **Reusable rule:** exe pe string-search se verify mat karo — pkg V8 bytecode me compile karta hai, plain strings nahi dikhti. Bundle (`dist/sidecar/omniclaw-gateway.cjs`) pe search karo — wahi proof hai ki naya code exe me gaya.

## 2026-09-22 — Write tool UI verb is "Wrote", not "Edited"
- **Decision:** permanent UI (`web-next`) maps `write_file`/`write_computer_file` → **"Wrote"** in `HUMAN_TOOL` and derives `tool.diff` / history titles from `humanTool(p.tool)` instead of a hardcoded `Edited …`. `edit`/`multi_edit` stay "Edited". Walkthrough `humanTool` checks `/writ/` before `/edit|patch|append/`.
- **Reason:** user report — chat showed "Edited" for file writes and often without the path. The verb is part of the step title (`Started-line` + `tool.diff` both go through the verb map), so a wrong map wrongs every write row; hardcoding the verb in two title builders meant fixing the map alone would not stick.
- **Filename always shows:** both title builders keep `dispPath(path)` from the backend payload (`tool.diff` carries `tool` + `path`); the verb is the only thing that was wrong.
- **multi_edit:** already model-callable; no new tool. Contract smoke now requires it so it cannot silently drop off the menu.
- **Rejected:** renaming the backend event or changing `tool.diff` shape (UI-only bug; backend already correct).

## 2026-09-21 — `readFiles` is seeded from the session ledger, not reset per run
- **Decision:** at run start, `readFiles` (the read-before-edit gate) is seeded from the session's persisted evidence ledger, so a file read in an EARLIER turn of the same session keeps passing the guard. Seeding also emits `omni_loop.session_reads_seeded` + `report.seededReadFiles` so the effect is measurable, never silent.
- **Reason:** the live `write_file` failure the user reported ("aaj kal bahut fail ho raha hai") was NOT a filesystem error — `checkReadBeforeEdit` refused every `write_file` to an EXISTING file with `"index.html" already exists. Read it with read_file first`, because the file had been read in a previous run and `readFiles` is per-run state. After a mid-task model switch this fires on every write, burning rounds re-reading or spinning to `stuck-no-progress`.
- **Why the protection survives:** the guard's purpose is "never clobber content you have never seen". The ledger contains exactly the files this session actually read, so a seeded hit means the model has seen it. An externally changed file still trips the separate stale-file guard on the next edit.
- **Rejected:** relaxing the guard for `write_file` (that removes the protection the guard exists for), and auto-re-reading on the model's behalf (spends a round and hides the real cause).
- **Reusable rule:** any per-run "have I already done X" memo that protects a cross-run artifact must be seeded from the persisted state that spans runs, or the protection turns into a wall.

## 2026-09-21 — Empty tool arguments are a deterministic failure: teach, don't retry
- **Decision:** the MAIN loop pre-validates required args (like the sub-agent already did) and returns a teaching block naming the exact missing parameters plus one concrete example; no execution is attempted.
- **Reason:** live evidence — `write_file {}` blocked 3× with "path is required, content is required", then `exec {}`, then `stuck-no-progress`. `repairToolInput` fixes alias/coercion but cannot invent a missing `path`. Each silent block costs a full provider round, and the model has no way to learn what was wrong from a runtime-validator string.
- **Rejected:** raising retries/rounds (makes the failure slower, not rarer).
- **Reusable rule:** if the same call with the same args can only fail the same way, the harness must answer with the FIX (schema + example), not just the error.

## 2026-09-21 — Compaction is pressure-driven, never round-count-driven
- **Decision:** the in-run digest now fires only when the transcript exceeds ~55% of the effective budget (min of the hard char budget and the model-window token budget), keeps the newest 5 groups verbatim, and every digested read keeps a `⧉` excerpt of what the file contained.
- **Reason:** round-count compaction punished honest long runs — round 7 lost every file it had read even with a nearly empty 200k window, and a bare "read → ok" line forced the model to re-read files just to remember its own findings. Claude Code keeps tool results until the window is actually full; this matches that and then improves on it (the excerpt means a digested read is still usable knowledge).
- **Also:** `contextCharBudget` default 300k → 4M chars (≈1M tokens) so a 1M-token model is window-limited rather than artificially char-limited; small models are unaffected because the token-derived budget binds first.
- **Reusable rule:** compact on measured pressure, never on elapsed rounds. If a summary replaces content, it must carry the content's usable essence, or the agent will pay to re-derive it.

## 2026-09-21 — Failures get UI cards too
- **Decision:** the rich transient tool cards (read observation, diff, exec stdout) are emitted for blocked/failed calls as well; failures go through a `tool.output` card carrying the same formatted text the model receives.
- **Reason:** the cards were gated on success, so a blocked `write_file` showed the user a red chip and nothing else — the model's problem was invisible while it repeated the failure for several rounds.
- **Reusable rule:** anything the model can see and act on, the user must be able to see too. Silent failures read as "the agent is dumb" instead of "the harness blocked it".


## 2026-09-20 — Provider rotation lives INSIDE OmniLoop, not above it
- **Decision:** `OmniLoop.rotateProviderForRetry()` swaps `runtime.provider` and the round loop `continue`s on the SAME round index (with a fresh send budget), instead of throwing up to `agent.js` to let the legacy fallback chain handle it.
- **Reason:** OmniLoop *catches* its own provider errors and ends the run with `stoppedReason: "provider-error"` — it never throws, so `agent.js`'s fallback loop (which only runs when `!response`) was dead code on the default engine. The user's real session showed the cost: 11 manual "continue" messages across 14 runs for 429/402/401/404. Claude Code/Codex move to the next configured binding by themselves; this is that behaviour.
- **Also deliberately:** a model id pinned via the run/background scope (`settings.modelOverride`) is CLEARED on rotation — a model id valid on the old endpoint usually 404s on the new one, which would burn the entire rotation budget in one hop. The cleared value is recorded on the report (`modelOverrideClearedByRotation`) rather than silently dropped.
- **Bounded by construction:** each profile is tried at most once per run (`rotation.tried`), so rotation can never become an infinite retry loop; when the chain is exhausted the honest provider-error report stands.
- **Reusable rule:** if a subsystem catches an error and converts it to a *report* (rather than rethrowing), any recovery policy that lives in a caller is unreachable. Put the recovery where the error is caught.

## 2026-09-20 — Sub-agent: validate required args BEFORE executing, then fail loud
- **Decision:** the sub-agent loop pre-checks `schema.required` against the model's args, answers immediately with the exact missing set, and after 2 consecutive blocked rounds on the same tool returns `incomplete` (`schema-spin`) instead of continuing.
- **Reason:** `repairToolInput` fixes aliases/coercion but cannot invent a missing `path`/`content`/`command`. Live evidence: `exec {}` blocked 3× and `write_file {}` blocked 2×, each block costing a full provider round before the sub-agent died on the 300s timeout with a vague reason. A schema failure is deterministic — repeating it can only waste rounds.
- **Rejected:** raising `maxRounds`/`timeoutMs`. That makes the failure slower, not rarer, and hides a fixable model-contract problem behind a budget bump.
- **Companion fix:** `buildToolDefinitions` now annotates required params with a `type` (plus a hint and an example call). The empty-args failure was caused by bare `{type:"object"}` schemas — the model was never shown that `path` and `content` were required *strings*.
- **Reusable rule:** when a tool error is deterministic (same args ⇒ same failure), the harness must stop the loop, not retry it.

## 2026-09-20 — "Files read" belongs in the session work summary, not just the read cache
- **Decision:** `summarizeWorkDone` gained a `Files read` line (path + line window), rendered under the existing "This Session's Earlier Work" section.
- **Reason:** the evidence ledger + read-cache already prevent the *tool* from re-billing unchanged bytes, but a session resumed by a DIFFERENT model still had no visible statement of what had been inspected — the model re-explored by choice, not by necessity. Both mechanisms are needed: one blocks the waste mechanically, the other tells the model it is already informed.
- **Reusable rule:** a cache that prevents re-work does not communicate context; if the model must *decide* not to re-read, the decision inputs have to be in the prompt.

## 2026-09-20 — Every smoke script needs a wall clock and an explicit exit
- **Decision:** scripts that touch browser/provider/child-process handles get a `setTimeout` wall clock (25s) with a `__step` label, step markers before each phase, and `process.exit()` at the end.
- **Reason:** `scripts/tool-execution-smoke.mjs` printed its PASS line but never exited — Playwright handles kept the event loop alive, so `npm run test:tool-execution` hung and could not be used as a verification gate. A test that cannot fail loudly is worse than no test: it looks like an environment problem.
- **Reusable rule (R14):** if a verification command can hang, it is not a verification command. Print the current step before each phase so a timeout names where it stuck.


## 2026-09-02 — `rootDir` split: appDir (stable) vs workspaceDir (swappable)
- **Decision:** `rootDir` stays the app's own state dir. A separate `workspaceRoot` (managed by `WorkspaceStore`) is applied at runtime only to workspace-facing subsystems — `FileStore`, `ShellExecutor` (and later git/screenshots). Chose the "pragmatic split", not a full per-subsystem split.
- **Reason:** `rootDir` was doing two conflicting jobs: app state (`data/config.json`, `data/sessions.json`, secrets, skills) AND the agent's workspace sandbox. Pointing the workspace at a user's project would have dragged OmniClaw's own state along, or written junk into their project. A full split meant touching ~30 constructor sites across three giant files (`agent.js` 417 KB, `tool-registry.js` 404 KB, `omni-loop.js` 250 KB) — slow and regression-prone for no near-term gain.
- **Rejected:** Full appDir/workspaceDir split everywhere. Right architecture eventually, wrong cost right now. The pragmatic split keeps that door open — subsystems can migrate one at a time.
- **Reusable rule:** Before adding a workspace-scoped feature, ask "is this app state or user-project state?" If it's app state it goes in `rootDir`, no exceptions.
- **Safety note:** Drive roots and `/` are rejected as workspaces — picking `C:\` would hand the agent write access to the whole disk.

## 2026-09-03 — Chat history scoped per workspace folder
- **Decision:** `SessionStore` gained a mutable `workspaceId`; the session key became `agent:<agentId>:<channel>:<label>:ws:<workspaceId>`. `agent.applyWorkspace()` calls `sessions.setWorkspaceId()`.
- **Reason:** Requirement was per-folder chat history. A mutable id (rather than threading workspace into every call site) keeps the change to one file, because `resolveSession` already reads `this.workspaceId` as its default.
- **Migration:** Sessions created before this change carry the legacy key `agent:<agentId>:<channel>:<label>`. On first resolve in the default workspace they are adopted (key rewritten in place) instead of being orphaned — nobody loses history on upgrade. Verified by `test:session-scope`.
- **Reusable rule:** Any store holding "per project" data needs the same treatment. Check what it keys off before assuming it's folder-safe.

## 2026-09-03 — `git branch --list --no-color`, never `--format`
- **Decision:** Branch listing uses plain `git branch --list --no-color` and parses the leading `*` manually.
- **Reason:** The shell policy blocks the word `format` (same gotcha as the existing `--pretty=format:` rule in AGENTS.md). Both `git branch --format=` and `git for-each-ref --format=` would be rejected.
- **Known debt:** The implementation calls `execSync` directly, bypassing `ShellExecutor` — so it skips the approval/sandbox policy. Acceptable today because the command is hardcoded and read-only with no user input, but route it through `ShellExecutor` the moment the command becomes dynamic.
- **Reusable rule:** Before writing any shell command in this repo, scan it for the word `format`. If it's there, find a flag that avoids it.

## 2026-07-10 — Game-loop `dt` unit convention (flappy-bird fix)
- **Decision:** In game loops, normalize `dt` to frame units (`dt = dtMs / 16.667`) before feeding physics, never multiply raw milliseconds into position/velocity.
- **Reason:** Multiplying raw ms into physics made the bird fall ~200px/frame → instant game-over. User fixed this in flappy-bird; confirmed via browser test (fall time 952ms = playable).
- **Rejected:** Leaving `dt` in ms and tuning constants — brittle, frame-rate dependent.
- **Reusable rule:** Always assert the unit of `dt` at the top of any game loop. Mixing ms vs frame units is a silent instant-death bug.

## 2026-07-10 — Browser verification fallback path
- **Decision:** When `browser_view` / `browser_click` / `browser_open` block or return empty, fall back to `browser_open` + `browser_evaluate` (inject JS to read real game state: position, score, gameState).
- **Reason:** Multiple rounds (03:37, 03:40) had view/click blocked, but open+evaluate worked and gave real evidence (gravity fall 952ms, 28 flaps = 7s alive).
- **Rejected:** Relying on screenshots alone — model can't see images, and screenshot proves nothing about logic.
- **Reusable rule:** For UI/game verification, prefer reading live state via evaluate over visual screenshots.
## 2026-07-10: Use `=== undefined` instead of `!value` for Vec3 coordinate checks — `!0` is `true` in JS, so any position with x/y/z=0 silently fails the guard.
- Reason: Player spawns at origin (0,0,0). The `!targetPosition.x` / `!pos.x` checks in CameraController.updateCameraPosition() and PlayerController.updateGroundCheck() caused silent early-returns, freezing the camera at (0,0,0) and leaving isGrounded=false forever. This is a classic JS pitfall that bit the game at the exact spawn point.
- Rejected: Keeping `!value` and special-casing 0 — fragile, doesn't fix the underlying bug class. Using `Number.isFinite(value)` — works but more verbose than `=== undefined` for this codebase.

## 2026-09-09 — Per-chat project bind (not global selection)
- **Decision:** A chat is bound to the folder in its own session record
  (`workspacePath` set at create, never restamped); tools/prompt/git resolve
  the chat root per call via `getChatRoot(sessionId)` with global-active
  fallback. Scoped `FileStore` views per call instead of mutating the shared
  store's rootDir (race-free across concurrent runs).
- **Reason:** Global `applyWorkspace` switching moves every tool at once, so
  an old chat silently changes folders when the sidebar moves. The live
  transcript proved the deeper fault: the prompt named the agent home dir
  (`...\workspace\agents\main`) as cwd, so the model aimed absolute hlo
  paths while amanman was selected.
- **Rejected:** Rebinding FileStore rootDir per run (races concurrent runs);
  blocking computer_* tools at chat root (they are the policy-governed
  cross-folder mechanism with approvals + allowedRoots; heartbeat/Pictures
  flows depend on them); migrating old session keys (sidebar grouping fix
  covers history without touching data).
- **Reusable rule:** Any tool that takes a path/cwd must resolve it against
  the chat's project root and fail closed naming that root. Absolute paths
  are honored-then-confined, never joined onto a root.

## 2026-09-11 — Codex-grade tool layer (Parts A–E, uncommitted)
- **Decision:** CORE cut 23 → 16 (`exec, read_file, write_file, edit, multi_edit, list_files, search_text, web_search, web_fetch, delegate_task, update_plan, memory_search, memory_write, ask_user, finish, load_toolset`); git_*/progress/verify/browser moved to `git`, `progress`, `browser` toolsets; cap 28 → 30; param descriptions restored in `stripSchemaForMenu` (tool desc cap 220 → 500).
- **Reason:** The menu stripped the exact hints the model needs to shape calls (param descriptions, cwd/path conventions) — every guessed argument costs a full round. 16 tools × full schemas beats 23 tools × stripped schemas; measured schema chars stay ~6.9k (budget ~12k).
- **Decision:** Priority toolsets guarantee only the canonical subset (browser: 8 canonical), best-effort tail fills leftover slots without evicting core; load-bearing core (`exec/read_file/delegate_task/update_plan/finish/load_toolset`) is never evicted; drops are logged with reasons.
- **Reason:** Guaranteeing all 36 browser members evicted 12 core tools (incl. `delegate_task`) — a single `load_toolset` must never disarm the core.
- **Decision:** Shell parallelizes via `shellCallsConflict` (same-path writes, mutating verbs, background servers serialize; independent builds/tests/greps parallelize); write-family same-file never batches; `parallel_tool_calls:true` sent to the provider; round ceiling stays `contextCharBudget` (untouched, 120k).
- **Decision:** Subagent returns `completed|incomplete|failed` + reason; rounds/timeout/budget/cancel → `incomplete` (never success); transcript is JSONL truncated only at line boundaries with parse validation; parent gets ONLY the ≤2000-char structured report; `subagent.*` passes the chat-stream filter and renders in /next.
- **Decision:** Removed the uncommitted `enable_toolset → load_toolset` registry alias (it shadowed the real run-scoped tool and broke `toolset.enabled` + the session-toolsets suite); removed the matching `ALIAS_OF` line. Run scope and session scope are different contracts.
- **Honesty note:** `data/sessions/transcripts/*.jsonl` holds only session/run/message/event records — no per-tool error strings exist to mine, and `data/gateway.json` keeps the last 200 events (6 `tool.failed` observed live). The claimed historical error counts (read_file 169/1483 etc.) are not reproducible from repo data; schema fixes target the failure classes visible in validation/guard code instead (missing `browser` schema, undescribed path/cwd conventions, unordered browser flow).

## 2026-09-12 — Sub-agents first-class (Parts A–E, uncommitted)
- **A1 root causes (live gateway evidence):** (1) `delegate_task(model="nex-agi/...")` + dedicated nvidia endpoint → "not a valid model id" — model id traveling WITHOUT its endpoint. (2) `"(main model)"` NEVER reaches the provider — display fallback only in the spawner hint; the id actually sent was the dedicated profile default `meta/llama-3.1-70b-instruct`, retired (410). Second defect: "inherit" kept the dedicated ENDPOINT and dropped the model.
- **A2 fix:** binding = {endpoint, model} as one unit. `inherit` (default) = parent's full binding. Explicit model without provider: endpoint FOLLOWS the model (dedicated → parent, warn on retarget); invalid everywhere → immediate throw naming endpoint + 8 alternatives. Dedicated default used ONLY when it validates on its own list.
- **A5 ladder:** explicit/configured/dedicated-default → fallback (validation beats vendor heuristic; heuristic only when blind) → parent → probed loopback → throw. Call-time 404/410 marks registry-retired + steps down; actual rung recorded in events.
- **B:** child session (`sub: <task>`, parentSessionId, parent workspacePath, binding model) + startRun/finishRun; parent transcript gets `subagent.session` link; child emits real tool.* + agent.thinking with child AND parent ids; transcript mirrors main shape (assistant msgs + bounded toolOutputs); parent model context still sees ONLY the bounded report (SECRET-leak isolation test both sides).
- **C:** parent thread routes child-scoped events into a per-child card via proxy turn reusing main renderers; statuses color-distinct (incomplete amber, never green); Open = `#/t/<childId>` new tab; sidebar nests children collapsed by default; unhandled subagent.* warns + renders. Server filter passes parentRunId-matching events. Note: rapid programmatic hashchange navigation is flaky (pre-existing) — direct loads work.
- **D:** `test_provider_model` + model-test route (reachability → validity → tiny forced tool call; persists toolCalling/parallel; 404/410 → retired) + registry GET route; Settings per-model rows with Test; composer "Sub: Inherit" pill (retired disabled); main picker hides retired. Live: nex-agi ok+tools persisted; nvidia list works; profile llama default absent (stale, not retired); tencent/hy3:free absent on BOTH endpoints (compaction/fallback default stale — tell user).
- **E1:** exhausted budget was runTokenBudget (300k hit at 325k/round 14, 9/29 failed ≈ 31% waste). Round ceiling frozen + correctly sized; per-run raised 300k → 600k.
- **E2:** handoff went to PROGRESS.md (models never read it), session plans memory-only → setSessionPlan + durable `run.resume` transcript event (plan or synthesized) + transcript fallback at run start. Proven offline (plan-resume-smoke).
- **E3/E4:** reads were missing-file class (correct) but doubled-root invisible → errors now name resolved absolute path + root, classes stay distinct.
- **Live arg-encoding saga:** weak model double-encodes/mangles whole args JSON; fixed parse unwrap + brace-scan recovery + repair unwrap + parse-failure forensics capture (unverified-live). Truncated-mid-content args are unrecoverable by parse — length-cut guard + split-write nudge is the honest path.
- **E11 status:** resume works live (3 continues, no redo, to round 9+); files NOT yet produced — free-tier 429 stopped the last run; weak model ~1.5 rounds/min. Model-speed/quota-bound, not harness-bound. Do NOT auto-switch the user's provider.

## 2026-09-18 — Model-aware context window + 96% auto-compaction + composer goal-ring
- **Decision:** Model ka context window provider `/models` catalog se aata hai (`contextTokens` preserved end-to-end: catalog → picker → select → `provider.contextTokens` → omni-loop budget/meter), static default se nahi. `windowSource` (model/config/default) meter me visible hai taaki user hamesha jaan sake % kis window ke against hai.
- **Reason:** Static 128k/800k budget 227k model par jhooth bolta tha — overflow 100% se pehle, meter galat base par. Model-select par window persist karna ek additive optional field hai (existing shapes frozen, R12-safe); omni-loop ko per-run network fetch ki zaroorat nahi.
- **Decision:** Emergency auto-compaction 96% par (optional `autoCompactAtPercent`, default 0.96), normal 85%-style compaction ke BAAD sirf tab jab meter ab bhi threshold par ho — once per round, bounded, kabhi round fail nahi karta. Event `context.auto_compacted` (before→after %) + transient refresh.
- **Reason:** User demand (99/96 par apne-aap compaction) + context-overflow recovery ka existing pattern (compress, not failover). 96% default taaki 99–100% provider rejection se pehle jagah bane; recent tail protected rehta hai (summarize path wahi reuse hota hai).
- **Decision:** Composer ring thread se `window CustomEvent ("omniclaw:ctx")` par feed hota hai — no polling, no new backend route (R13 n/a), no store schema change.
- **Reason:** `context.usage` events pehle se har round emit hote hain; same-tick dispatch sabse sasta bridge hai. Ring idle state me model window dikhata hai (select ke baad config se), taaki "227k se start" visibly true ho.
- **Rejected:** Per-run `/models` fetch for window resolution (slow + quota waste); full `npm test` ko done ka gate banana (wall-time kill — targeted suites + isolated boot evidence use ki).
- **Pending:** exe rebuild + live re-test (packaged-behavior files touched) — user step.

## 2026-09-18 — /next UI permanent (exe rebuild + relaunch)
- **Decision:** `/` = web-next permanent default (source routing unchanged — already correct); fix stale `omniclaw-gateway.exe` (8/6/2026) ko rebuild karke tha, routing badalke nahi. `/next/` → 301 `/`, `/classic` = old UI fallback barkarar.
- **Reason:** User ko purana UI isliye dikh raha tha kyunki live exe `/next` routes se pehle ka tha — source-only test green hone ke baad bhi exe purana tha (wahi documented dynamic-import gotcha class). Rebuild + root copy + relaunch ke baad live `:3147` se verify: `/` = OmniClaw Next, ring code live.
- **Reusable rule:** UI routing complaint aaye to pehle root exe ki date check karo (`LastWriteTime`) — stale exe sabse probable cause hai, code nahi.
