# AGENTS.md — OmniClaw

> A map for AI agents (and humans) working in this repo. Keep it ~100 lines — a directory page, not an encyclopedia. Deeper docs live in `docs/` and `notes/`.

## What this is

OmniClaw is a **local-first AI agent platform** for Windows (Node.js). The LLM is the brain; OmniClaw is the harness — agents, tools, memory, sessions, channels, approvals, runtime. Goal: match/beat Claude Code & Codex on coding and general agent tasks. Creator: Mankush (Haryana, India).

## Tech stack

- **Node.js ESM** (`"type": "module"`), Node 22+ runtime. No TypeScript — plain `.js`.
- HTTP server: `server.js` (no framework, raw `node:http`). SSE for streaming chat.
- Frontend: vanilla JS in `public/` (Neo UI = `public/neo.js` + `public/neo.css`; classic in `public/classic/`).
- Packaging: `@yao-pkg/pkg` → `OmniClaw.exe` (launcher) + `omniclaw-gateway.exe` (server). Bundled via `esbuild`.
- Provider: OpenAI-compatible (default OpenRouter). Native function calling.

## First-run / common commands

```
npm run dev            # run server from source (node server.js)
npm run build          # syntax check: node --check server.js + public/app.js
npm run portable:build # build Windows exes into dist/windows-portable + release ZIP
```

## Verification commands (feedback subsystem — run before claiming done)

```
npm run build               # must pass (syntax)
npm run test:omni-loop      # OmniLoop core, 12 assertions
npm run test:agent-loop     # agent loop contract
npm run test:tool-contract  # tool surface contract (model-callable cap)
npm run test:tool-execution # real file/edit/grep/git/browser execution
npm run test:menu-admission # intent-matched toolsets never evict CORE
npm run test:context-manifest # context tiers + map + pointer-collapse contract
npm run test:memory-hygiene # stored conversations are bounded digests, no secrets
npm run test:unblock        # blocked shell commands teach; backgrounded execs are checkable
npm run test:long-task      # round ceiling scales with the plan; max_rounds stamps a resume handoff
npm run test:checkpoint     # a healthy run checkpoints mid-flight; hard kills stay resumable
npm run test:packaged       # the SHIPPED bundle/exe really carries the R15/R16 fixes (pre-rebuild gate)
npm run test:packaged-e2e   # L3: boot the built exe, hang up mid-run, prove the run survives (slow, ~40s)
npm run context:audit       # read-only: where every prompt char + store char goes
npm run memory:compact      # dry run; --apply compacts + secret-scrubs the store
```
Run the relevant smoke(s) after touching core; run all before a release/exe rebuild.

## Context organization (the harness diet — why a weak model can work here)

Everything the model can see is tiered in `src/core/context-manifest.js`:
- **T0_CORE** always inline (identity, project root, tooling menu, loop contract, context map) — never collapsed.
- **T1_TASK** this run's working set (plan, evidence ledger, memory brief, instincts, playbooks) — capped; an oversized section collapses to a pointer line naming the exact refetch call.
- **T2_ON_DEMAND** named in the **Context Map**, never bulk-injected: manuals, skill bodies, extra toolsets (`load_toolset`), memory bodies (`memory_search`).
- **T3_STORE** persistent data (memory.json, sessions, artifacts) — reached only through T2.

- The **Context Map** is a single Zone-A block naming what is inline vs fetchable — the anti-re-discovery contract for weak models. Per-run cost is reported as `report.contextBoard` + a `context.board` gateway event.
- `buildMenu` (tool-layers): CORE is fixed; an intent-matched set gets a bounded slice (`INTENT_SET_SLOTS`), an explicitly loaded set keeps its canonical members. A focus hint can never evict core.
- `memory-store`: stored conversations are bounded digests (newest 12 tool outputs @600c, plan allowlist only). `npm run memory:compact -- --apply` shrinks an already-bloated store (measured 60MB → 7.9MB) and scrubs secrets from agent memory files.
- `system-prompt`: only AGENTS/SPRINT-style docs are always-inline; PROGRESS/DECISIONS are index-only; skills are one-line pointers (max 8).
- **Never put a credential in memory.** `writeStructuredMemory` redacts by value pattern, and `secret-redact.js` covers hyphenated `sk-live-…` keys.

## Unblock contract (why the agent stops spinning)

Two harness rules exist purely to stop a weak model burning rounds in "Thinking…":
- **A blocked shell command must teach.** `shellBlockHint` turns a bare regex refusal into the safe alternative (recursive delete → ask the user or `delete_computer_path`; `Stop-Process -Name node` → that kills OmniClaw itself, use `process_kill`). The block itself is unchanged.
- **A backgrounded command must be checkable.** `exec` returns a pid, not a result, and `process_status` lives in the `computer` toolset. `annotateBackgroundProcess` admits `process_status` into the live menu and names the exact follow-up call, so the model reads the outcome instead of polling `Test-Path` forever.

## Long-task contract (why a 2-hour build does not die at round 18)

- The default `maxRounds: 18` and `runTokenBudget: 600000` (both shipped in `config/default.json`) are SHORT-task budgets. `longTaskRoundBudget` (+6 rounds per step past the 2-step threshold, ceiling 96) and `longTaskTokenBudget` (+300k per step, clamp 2M) scale them with the plan the run committed to. **The gate is `config.readUserConfig()` — a shipped default may not pin the ceiling, only an explicit user override may** (`config/default.json` ships both keys, so gating on the merged `getConfig()` silently disables the whole feature). Reported as `report.longTaskBudget` + an `omni_loop.long_task_budget` event, including which values the user pinned.
- A round-ceiling stop is a **stop, not a reset**: `omni_loop.max_rounds_handoff` stamps the same durable resume state as a budget stop (session plan + `run.resume` event), so "continue"/"retry" picks the unfinished plan up instead of re-exploring from scratch. The run token budget remains the independent hard ceiling.

## Checkpoint contract (why a CRASH costs minutes, not the whole run)

R16 covers every *stop* path, but a hard kill (OOM, laptop sleep, crash, force-closed exe) never reaches one. So a healthy running run also checkpoints: `checkpointProgress` (in `omni-loop.js`) persists the run's **committed** plan to the SESSION plan + a `run.resume` transcript event, throttled by BOTH `checkpointEveryRounds` (default 3) and `checkpointEveryMs` (default 45s) so it never hammers disk. Two rules: it checkpoints only a plan the run itself committed (synthesizing one mid-run would pre-empt `writeBudgetHandoff`'s stop-time synthesis), and it must never touch `PROGRESS.md` — that is the human stop-time log, not a mid-run one. Verified by `npm run test:checkpoint`.

## Architecture (where things live)

- `src/core/omni-loop.js` — **the core loop** (Claude Code/Codex-style persistent transcript, native tools, streaming, parallel tools, plan injection, smart compaction, verification gate). Most coding-behavior changes go here.
- `src/core/agent.js` — OmniClawAgent orchestrator (~9k lines): handleMessage, context bundle, workspace/project-context loading, post-loop guards. `runModelToolLoop` delegates to OmniLoop.
- `src/core/tool-registry.js` — all tools (~215). Tool = `{ description, permission, group, schema, run }`. Add new tools here; add to `CODEX_GRADE_MODEL_TOOLS` to make model-callable.
- `src/core/context-engine.js` — context bundle assembly under the v2 diet (priority allocator, caps).
- `src/core/context-manifest.js` — **context organization contract**: T0/T1/T2/T3 tiers, per-section caps + refetch pointers, the Context Map renderer. Read this before adding a prompt section.
- `src/core/memory-store.js` — long-term/structured memory, memory index, bounded conversation digests.
- `src/core/file-store.js` — workspace file ops, grep (`searchText`), recursive list, verification discovery.
- `src/core/system-prompt.js` — system prompt sections (identity, creator, tooling, contract).
- `src/core/providers/openai-compatible-provider.js` — provider + streaming.
- `src/core/gateway-store.js` — event log (debounced writes), runs, SSE source.
- `config/default.json` — defaults; user overrides in `data/config.json`.

## Hard constraints (non-negotiable)

- **Never use dynamic `await import("node:...")` in hot paths.** It throws inside the pkg `.exe` (works under `node` from source) and silently drops OmniLoop to the legacy loop. Use static top-of-file imports.
- **No duplicate object keys in `tool-registry.js`** — later keys silently overwrite earlier ones. Run the duplicate scan if adding tools.
- **Shell policy blocks the word `format`** — git uses `--pretty=%h...` not `--pretty=format:`.
- After editing a packaged-behavior file, **rebuild the exe and re-test live** — source-only tests pass even when the exe is broken (see dynamic-import bug). Verify `modelToolLoop.loopEngine === "omni-loop"` in a live run.
- Keep replies in the user's language/style (Hinglish stays Hinglish).
- Don't claim done without running verification (the loop enforces a one-time nudge).
- **R11. NEVER mutate live config, provider profiles, workspace selection or sessions during tests.** Verify against a SEPARATE data dir: `OMNICLAW_DATA_DIR=./.tmp-test-data PORT=3199` second instance. Never POST to `:3147` config endpoints during verification.
- **R12. Backend changes are ADDITIVE ONLY** — new routes, optional fields/events. Existing shapes frozen; `public/` keeps working. New routes: loopback-only unless auth exists, workspace path-containment, validation, size caps, JSON `{error, code}` errors.
- **R13. Every new route gets a `tests/api/*.test.mjs` smoke test** (`node:test`, no framework) against the test instance. `npm test` must pass.

## Work rules (WIP=1)

- Work on ONE feature/step at a time (`update_plan` with one step `in_progress`). Finish and **verify** it (run its verification command) before starting the next.
- Don't "also refactor B while implementing A" — out-of-scope ideas go in as `pending` steps, not done now.
- Done = behavior verification passes, not "code looks fine". Each plan step should carry a `verification`.
- **R14. A verification command may run at most ONCE per change.** If it fails or hangs, do NOT re-run — read the output, form a hypothesis, make a change, and only then run again. Never run the same failing command twice in a row. Any script that spawns a server or browser must: use an AbortController for every SSE/fetch, close all streams and kill all child processes in a `finally` block, call `process.exit()` at the end, and print progress lines BEFORE each step so a hang shows where it stuck. Prefer many small scripts over one big one. Max wall time per script 25s (`--test-timeout=25000` or a setTimeout that prints `TIMEOUT at step X` and exits 2).

## Feature list (multi-feature scope)

- `feature_list.json` is the machine-readable single source of truth for scope. Each feature = `{id, behavior, verification, state}` (states: not_started / active / blocked / passing).
- Define/update via `feature_set`; read/schedule via `feature_list`.
- A feature becomes **passing only via `feature_verify`** (its verification command actually runs and exits 0). You cannot self-mark a feature done — `feature_set` rejects a direct jump to passing.

## Definition of Done (three-layer check)

Agents are systematically overconfident — "code written, unit tests green" is NOT done. Before claiming a coding task complete, run `verify_done` (externalized termination check), in order, no shortcuts:
1. **L1 static** — build / lint / typecheck pass
2. **L2 runtime** — tests + startup checks pass (app actually runs)
3. **L3 end-to-end** — the full user flow runs correctly

Stop at the first failing layer and fix it. No refactoring/optimizing until core functionality is verified. For non-trivial or subjective work, use `evaluate_work` for an independent reviewer (worker ≠ checker) rather than self-assessing.

Only a real end-to-end run proves component-boundary correctness — unit tests are blind to interface/state/resource issues across components.

## Run lifetime contract (why 16 minutes of work isn't lost to a closed tab)

**R15. The UI is an OBSERVER. It never owns run lifetime.** A client disconnect
(closed tab, navigation, laptop sleep) must NOT cancel a server-side run. Only
`POST /api/runs/:id/stop` may. This is the single most destructive class of bug
in the harness: the UI's stream watchdog (`web-next/js/sse.js IDLE_TIMEOUT_MS`)
is a DISPLAY concern, and giving it cancel authority means the shortest timeout
wins and kills the longest work. Keep the UI watchdog sized ABOVE the longest
legitimate silence (a single tool may run 900s — `shell-executor.js`), and treat
a watchdog trip as "this tab lost the stream", never as "the run failed".
Reconnection recovers the run via the global `/api/events` feed + session
transcript. A disconnect no longer risks credit leak either: the loop's own
ceilings (maxRounds / runTokenBudget / tool timeoutMs) still bound an abandoned run.

**R16. EVERY stop is a handoff.** A run may stop for many reasons (token
budget, round ceiling, cancel, stuck-no-progress, provider error, context
overflow). Every one of them MUST write the same durable resume state (session
plan + `run.resume` event) before returning, or the next "continue" re-explores
from scratch and the user's work is gone. A stop that writes no handoff is a bug
even when the stop itself was correct. Coverage lives in `omni-loop.js`
(`writeBudgetHandoff` on the budget/max-rounds/cancel paths).

Long-task scaling details (rounds/tokens grow with plan size) and the config gate
are in the "Long-task contract" section above.

## Session exit checklist (clean handoff)

Before ending a multi-step session, run `session_handoff` and leave a CLEAN STATE (all five):
- [ ] Build passes
- [ ] Tests pass (didn't break existing ones)
- [ ] Progress recorded (`update_progress` → PROGRESS.md)
- [ ] No stale artifacts (debug code, temp files like `*.tmp`/`debug-*.log` removed)
- [ ] Startup path works (`npm run dev`/build)

"Clean up later" = never. Entropy is the default — only active cleanup counteracts it. (This repo's own dev loop: stop the exe, `npm run portable:build`, copy exes to root, relaunch.)

## Observability

- **Process** (why a change should be accepted): agree a `sprint_contract` (SPRINT.md) up front for a work block — scope, files to change, **do-not-touch**, pass criteria, exclusions. `evaluate_work` scores work across dimensions (functionality/correctness/architecture/completeness) with evidence.
- **Runtime** (what actually happened): `task_trace` gives a run's replayable timeline (rounds, tools + status/duration, plan, verification, errors, tokens). Drive decisions from this evidence, not feelings.

## Architectural boundaries (executable)

`arch_rules.json` holds executable boundary rules (id, glob, forbidden regex, fix message). Run `check_boundaries` (also part of `verify_done` L1) and fix any violation per its `fix`. When a bug/review reveals a rule the repo should enforce, promote it with `add_check` — it becomes a permanent check. Current rules encode this repo's real gotchas (no dynamic `await import("node:...")` in src/core; no `--pretty=format:`).

## Initialization (new / under-specified repos)

For a fresh or messy repo, do a **dedicated initialization pass first** (separate from feature work): run `init_project` (scaffolds STARTUP.md + TASKS.md, detects run/test commands), make one example test pass, then `git_commit` a clean checkpoint. `harness_doctor` reports a `readyToHandOff` verdict.

## State (long / multi-session tasks)

- **Clock in:** read `PROGRESS.md` and `DECISIONS.md` (resume, don't re-explore or re-decide); confirm the repo is in a consistent state.
- **Clock out:** `update_progress` (done / in-progress / blocked / next step), `log_decision` for non-obvious choices (the "why" a future session loses), and `git_commit` a checkpoint after each atomic unit of work.
- Use `harness_doctor` to audit a repo's harness (instructions / tools / environment / state / feedback).

## More docs

`notes/CODEBASE_MAP.md`, `docs/`, `MASTER_BUILD_PLAN.md`, `AUTONOMOUS_AGENT_LOOP_DESIGN.md`.
