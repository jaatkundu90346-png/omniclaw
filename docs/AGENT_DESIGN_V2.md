# AGENT_DESIGN_V2 — context diet, real learning, toolsets (T1 design, no code)

> Implements decisions D1–D6 exactly. Boxes marked **Concern** are points
> where evidence argues against the decision — raised, not silently deviated.
> All numbers are measured (T0), not estimated, unless marked ~(approx).

## D1. Context diet — budget table (chars, priority order; cut from the END)

Total cap **≤ 28000** (from 66720 measured). Assembly walks priorities 1→8 and
stops adding when the cap would break; lower priorities truncate first. The
current user message is OUTSIDE the budget (never truncated).

| Pri | Section | Cap | Content rule |
|---|---|---|---|
| 1 | identity core | ≤ 3.5k | SOUL.md ≤1.2k + IDENTITY.md ≤0.8k + PERSONALITY.md ≤0.8k + USER.md ≤0.7k. Tail-window per file (durable facts accumulate at end); USER.md dated lines newest-last kept first |
| 2 | hard constraints | ≤ 1.2k | Existing MUST-line pinning (`system-prompt.js:169`), max 12 lines |
| 3 | memory (RESERVED ≥6k) | 6.0–6.5k | Active prefetch ≤2.5k (this message) + top long-term facts ≤2k + today's daily tail ≤1.5k. Never truncated for §4–8; if §1+§2+§3 alone exceed cap, shrink §1 tails first |
| 4 | plan + loop contract | ≤ 3k | loopContract ≤2k (stage chain + action-contract one-liners; lifecycle prose dropped — it is a manual, not a contract) + current plan steps ≤1k |
| 5 | skills matched | ≤ 1.5k | Names + one-liners, **top 5** (was 8) |
| 6 | workspace snapshot | ≤ 4k | Tree summary top-2 levels ≤2.5k + README head ≤1.5k. NO full project docs, NO agent manuals |
| 7 | mcp hints | ≤ 2k | Only when the mcp toolset is active: server names + tool counts, no schemas |
| 8 | session summary/recent | ≤ rest | Fills whatever remains (~6.8k at full allocation) |

- Truncation marker (everywhere): `[... N chars trimmed from <file>: read it with read_file for the rest]`.
- Agent manuals (AGENT_LOOP.md, AGENT_RUNTIME.md, HARNESS.md, TOOLS.md,
  AUTOREVIEW.md, SUBAGENTS.md, THINKING.md, CHANNEL_DOCKING.md, TELEGRAM.md,
  HEARTBEAT.md, OMNICLAW_SKILL_ROADMAP.md, omni-landing/) collapse to ONE line:
  `Manuals available via read_file: <comma names>`; injected only when a
  matched skill or intent references one (charged to §8, not §6).
- Heartbeat sessions (`channel: heartbeat`): HEARTBEAT.md only (+ §3 memory +
  pending approvals/questions/jobs per D6), rest skipped via `minimal:true`.
- promptTrace proof fields (extend `report`): `report.budget = { total, cap:
  28000, sections: [{id, chars, cap, truncated:bool}] }`. Target proof: a real
  turn with `total ≤ 28000` AND memory section `≥ 6000` kept (today: 66720 / 0).
- Compaction: `compactAtPercent` 0.8 → **0.85** (diet leaves headroom; later
  trigger = fewer mid-task re-summaries), `maxToolResultChars` 10k → **6k**
  with marker `[…truncated: read more via read_file {path, offset}]`.
  Reads keep the 30k window via offset paging. Why: observations are the
  second bloat source (10k × rounds); 6k + paging preserves evidence without
  the arithmetic that forces compaction today.

## D2. Learning loop — real, background, cheap, visible

a) Post-task reflection (RUNTIME, not a tool): after every run with ≥3 tool
   calls or any failure, `BackgroundWorker` enqueues `type:"reflect"` (same
   session, low priority; model = `config.provider.compactionModel` if set,
   else active; `maxTokens: 500`, timeout 20s, ≤1 per run, ≤2k tokens).
   Output `{lessons[], userFacts[], candidateSkill?}`. Writes: lessons →
   memory promotion candidates (`sourceType:"lesson"`); userFacts → `USER.md`
   append `YYYY-MM-DD: fact` (dedupe: skip if substring already present);
   candidateSkill → `data/skill-proposals/<id>.md` ONLY, never auto-persisted.
b) Skill extraction with approval (Hermes shape): reflection proposing a
   repeatable (≥2×) pattern emits gateway `skill.proposed` `{id, name,
   skillMd, diff, source}` → UI card "Agent wants to save a skill: \<name\>"
   with full SKILL.md diff + [Save] [Edit] [Dismiss]. `build_tool` persist
   uses the SAME card (tool code diff; sandbox+self-tests already gate).
c) Dream sweep stays in heartbeat; new nightly `02:00` cron `consolidate`
   (seeded once at first boot if absent): dupe-merge (exact + token-overlap
   ≥0.8, deterministic) + 30-day decay + promotion review — extends the
   existing curator (`omni-loop.js:1816`), no new engine.
d) Visibility: every learning write emits `learning.wrote` `{kind:
   lesson|userFact|skillProposed|dream|consolidation, text}` → thread muted
   step row ("Remembered: user prefers Hinglish") + Memory panel tab (Phase 5,
   reads memory stores + proposals dir).
- Kill-switch: `learning.enabled` (default true) gates a–c разом; reflection
  errors are best-effort silent (logged, never fail the run).
- Sharing: lessons carry `agentId` (isolated via existing `filterByAgent`);
  userFacts are GLOBAL (one user); skills use the global catalog with the
  ops 84-allowlist enforced at match time.

## D3. Tool menu — CORE-18 + 7 toolsets (dedupe rules in B1 apply)

Slot counting: `git_status/diff` is ONE slot ("git read-only", 2 tools);
all other slots are 1 tool → 18 slots, 19 tools. New tools: `memory_recall`
(hybridSearch wrapper), `enable_toolset`, `finish` (explicit result report;
final-answer JSON stays as compat). Descriptions ≤60 words, pattern:
what / when / when-NOT / Windows notes (`;` not `&&`).

CORE-18 (always sent, ~1.8k tok):
1. `read_file` — Read workspace file with offset/limit paging. Always read
   before editing; cite content in replies. NOT for full large dumps (page
   them) or outside-workspace paths (computer set).
2. `write_file` — Create or overwrite a workspace file (≤2MB). Read first
   (stale guard). NOT for appends-by-hand (it overwrites) or >2MB.
3. `edit` — Find→replace edit in a file you already read. One match per call;
   re-read after outside edits. NOT for new files or whole-file rewrites.
4. `list_files` — List the workspace tree. Start here for orientation. NOT
   for system-wide search (computer set).
5. `search_text` — Substring/fuzzy search inside the workspace. NOT for
   whole-disk search.
6. `exec` — Run a PowerShell command; Windows needs `;` never `&&`; use
   background:true for servers. Ask-mode needs Allow. NOT for interactive
   programs or pasting huge output (redirect to a file).
7. `process_status` — Read a background process's output. NOT for starting
   anything new.
8. `web_search` — Web search with top-result fetch. NOT for proving local
   files exist (use list/read).
9. `web_fetch` — Fetch a URL to markdown. NOT for login-walled pages.
10. `web_research` — Slow multi-source research with synthesis. NOT for quick
    lookups (use web_search).
11. `update_plan` — Track a multi-step plan; exactly one step in_progress.
    NOT for single actions.
12. `ask_user` — Ask the user mid-run (2–4 options, one recommended; 5-min
    timeout falls back to recommended). NOT for anything you can decide.
13. `memory_recall` — Recall relevant memories (hybrid keyword+semantic).
    Key facts auto-arrive too; call when history matters. NOT for fresh facts.
14. `memory_write` — Save a durable fact or note. NOT for session trivia.
15. `skill_read` — Open a matched skill's method file. NOT for guessing from
    the name alone.
16. `git read-only` (`git_status`, `git_diff`) — Inspect repo state. Never
    mutates; commits live in the project set.
17. `enable_toolset({name, reason})` — Load a toolset for this run; confirms
    with an "Enabled \<name\> tools" step row. NOT for core needs.
18. `finish({summary, ok})` — Report the final result and end the run. NOT a
    substitute for doing the verification first.

TOOLSETS (9: the 7 below + `self` + `forge`, T2 accepted A/B; intent attachment
§below; menu = CORE + active, no cap):
- `browser` (35): all `browser_remote_*` (11) + Hermes `browser_*` minus
  aliases/shims (open/evaluate/close/navigate/click/type/scroll/back/forward/
  wait/screenshot/snapshot/links/text/state/sessions/press/images/console/cdp/
  dialog/tap/automate + `browser`, `browser_status`) + `open_browser_url`
  (kept callable here, uncontrolled OS browser — flagged in description).
- `computer` (~21): `computer_access_status/system_status`, all
  `*_computer_*` file ops, `run_terminal_command`, `process`/`process_list`/
  `process_kill`/`process_cleanup`, `code_execution`, `plan_shell_command`,
  `sandbox_*`, `exec_approval_status` (`terminal_backends_status`→OPERATOR).
- `git-write` (1+future): `git_commit` today; stage/unstage/revert tool
  wrappers land here when built (routes exist).
- `project` (~50: audit project/agents/harness/task buckets): all
  `*_plan/sprint/feature/contract/decision/trace/
  handoff/boundary/review/*_act/checkpoint/patch/multi` ops +
  `agent_harness_*` + `acp_*` + `delegate_task/subagents/sessions_*/session_search`
  + `create/list/run_task` + `todo` shim note + `cron/cronjob/jobs` +
  `git_log`.
- `comms` (19): `message`, `telegram_*`, `channel_dock`, `connected_apps_*`,
  `gmail_*`, `github_*`, `scan_file_drop`, `analyze_attachment_media`,
  `analyze_pending_media_attachments`, `cleanup_attachment_cache`,
  `describe_image` stays CORE-adjacent? No — describe_image is media; put the
  9 media tools here: `image_generate/video_generate/vision+video ALIAS
  notes/describe_image/video_analyze ALIAS/image ALIAS/tts→DROP`.
- `memory-admin` (8): `promote_memory`, `dream_memory_sweep`,
  `list_long_term_memory`, `memory_replace`, `memory_forget`, `memory_compact`,
  `memory_get`, `list_notes`.
- `mcp` (dynamic): `mcp_connect_all` + live `mcp_composio_*` (prefix admission
  unchanged).
- `self` (T2 accepted A): provider self-service reads —
  `provider_status`, `test_provider_profile`, `list_provider_models`,
  `switch_model` (`switch_model` executes only via approval card). Keys,
  profile save/delete, brain config stay OPERATOR.
- `forge` (T2 accepted B): `create_skill`, `build_tool` family
  (build/test/list_custom/remove_custom), skill imports
  (`openclaw_skill_import`, `openclaw_skill_pack_import`, `hermes_skill_*`
  live ones), `self_build_plan`, `skill_manage` (all approval-gated
  per below).
Audit-bucket → D3 home (every bucket accounted for, no orphans): browser(35)→browser;
computer(8)+shell(14: run_terminal_command, process family, code_execution,
plan_shell_command, sandbox_*, exec_approval_status)+terminal bits→computer;
git(1)+git_commit→git-write (+future stage/unstage wrappers); project(25)+
agents(9: delegate_task, subagents, sessions_*, session_search)+harness(14)+
task tools (create/list/run_task)+cron/jobs+git_log→
project; messaging(10)+media(9)→comms (except configure_telegram→OPERATOR);
memory(10)→memory-admin except recall/write (CORE); provider reads →`self`
toolset (T2 accepted A; keys/profiles-save stay OPERATOR);
skill-forge files→`forge` toolset (T2 accepted B);
mcp_connect_all+dynamic mcp_*→mcp; web backends (brave/exa/x)→never in menu
(invoked only inside web_search mux); nodes/canvas/template-only→OPERATOR/
DROP per audit; memory mux + todo + compat shims→ALIAS; ha_/kanban_/clarify/
canvas/tts/mixture→DROP.
Model calling any OPERATOR id returns `{blocked:true, code:"EOPERATOR",
reason:"This is an operator action; ask the user to do it in Settings"}` —
registry-enforced, so hallucinated ids fail closed with directions.
Approval-gated self-change (model-invokable, card + diff):
`create_skill`, `build_tool` persist, `skill_manage`, `cron` create
(live in `forge`/`project` as mapped above).
DROP 17 + ALIAS 19 per audit; aliases stay callable (legacy transcripts;
`OMNICLAW_LEGACY_TOOLS=1` default keeps defs registered, `=0` unregisters)
but never enter the menu.

> Concern A — provider reads to OPERATOR is a user-facing regression.
> Evidence: `provider_status` has 12/12 transcript successes (the model adapts
> to provider state), and model switching was an explicit user feature request
> (Aug 2026, shipped as composer model pill + `switch_model`). Mitigation in
> this design: the UI model pill + Settings health cover the flows, and the
> EOPERATOR error points there. If model-driven provider repair proves needed,
> promote the 4 reads to a mini-set rather than reopening writes.
>
> ACCEPTED (T2): `self` toolset = `provider_status`, `test_provider_profile`,
> `list_provider_models`, `switch_model` (switch executes only via approval
> card). Keys, profile save/delete, brain config stay OPERATOR.

> Concern B — skill-forge has no natural home in the 7 toolsets.
> `create_skill/build_tool-family/imports/self_build_plan` are filed under
> `project` above only because skill files live in the workspace. A dedicated
> 8th `forge` toolset would be cleaner (attach on build/fix intents); kept at
> 7 per D3, revisit if project-set precision drops.
>
> ACCEPTED (T2): 8th toolset `forge` approved — skill-forge files move out of
> `project` (see list above).

Activation: (1) intent classifier = `TYPE_TOOL_BOOSTS` generalized (keywords
+ last-tools-used recency + task-type verbs); (2) `enable_toolset` by model →
step row; (3) user pin in composer "+ → Tools", persisted per session
(`session.pinnedToolsets[]`); (4) agent allowlist intersect (ops keeps 84).
Remove the 64 cap: menu is always complete; log `report.menu =
{size, tokens, toolsets:[...]}` per round in promptTrace.

## D4. Loop friction fixes

a) Dedupe/repeat guard: block ONLY an identical call (same tool + same args
   JSON) within the SAME round; the block returns `{blocked:true,
   reason:"identical call already ran this round — result: <first 300 chars>",
   hint:"change args or use the result above"}`. Never block retries with
   different args, after an error, or across rounds. Expected: exec's 174
   guard-blocks → ~0 false positives (identical-same-round blocks remain BY
   DESIGN, now with the result attached so the round isn't wasted).
b) PowerShell rewrite (Windows, powershell backend only; skipped for cmd and
   inside single/double quotes or here-strings): `a && b` → `a; if ($?) { b }`,
   `a || b` → `a; if (-not $?) { b }`; result carries
   `note:"rewrote && for PowerShell"`. Edge cases: quote-tracking parser (skip
   inside `'...'`/`"..."`/backtick); already-PowerShell (`$?`, `;`) left alone;
   `cd X && npm run build` (top offender, 15×) becomes the canonical example.
c) Error contract for EVERY tool: `{ok:false, code, message (human,
   actionable), hint (what to try), details?}`. Bare `error:true` dies.
   Top sites → new messages:
   1. read_file miss → EENOENT "No such file: \<path>. Nearest match: \<fuzzy>. hint: list_files the folder."
   2. read stale-guard → ESTALE "Already read unchanged — content is above. hint: read_file {offset} for a slice."
   3. read/write schema → EINVAL naming the missing field + one valid example.
   4. edit miss → EEDITMISS "find-block not found (file changed? showing head). hint: re-read, copy exact text."
   5. exec non-zero → keep stdout/stderr, add EEXIT + "hint: fix the failing command, don't retry identical."
   6. exec timeout → ETIMEOUT with partial output + "hint: background:true then process_status."
   7. browser no-session → EBROWSER "No tab attached. hint: browser_open or enable browser set first."
   8. browser evaluate fail → EJS with page URL + expression snippet.
   9. browser_open file:// escape → keep (correct), append allowed roots.
   10. browser_open refused → ECONNREFUSED + "hint: is the dev server running? process_status."
   11. process stale pid → EGONE "Process ended (exit N). hint: re-run the command."
   12. delegate_task child error → EDELEGATE with child stopReason (see d).
   13. approval timeout → keep text + "hint: the approval banner shows pending items."
   14. mcp missing → EMCP "No MCP server connected. hint: mcp_connect_all."
   15. ask_user timeout → keep (recommended fallback stands).
   16. skill no-match → already silent (no card) — keep.
   17. session not found → ESESSION + "hint: sessions_list."
   18. model 429/503 → EBUSY "Provider busy (free-tier limits). hint: wait 60s or switch_model in Settings."
   19. compaction dropped context → note in summary, never silent.
   20. plugin template tool called → EPLUGIN "Template-only tool. hint: enable the plugin's code module."
d) delegate_task:

> Concern C — the brief's premise ("spawner contract mismatch") is not what
> the evidence shows. All 14 transcript failures are child-loop PROVIDER
> errors (5 rate-limit 429/503, 3 endpoint 404, 2 billing 402, 2 model 400,
> 1 timeout, 1 cancel) plus zero spawn rejections (`spawn:130` validates,
> `canSpawn` never tripped in the sample). Fix the real causes: (1) child
> inherits parent fallback chain + backoff (429 → wait/retry ×2, then
> EDELEGATE with stopReason), (2) child errors surface verbatim (kill bare
> `error:true`), (3) per-run subagent token/time budget + timeout config,
> (4) UI card fed by existing `subagent.spawned/completed/cancelled/failed`
> events (`sub-agent-spawner.js:175,194,221`): Antigravity-style pill "N
> subagents running" with per-agent spinner + expandable transcript tail
> (Phase 5; read-only subscription, no new events needed).
>
> ACCEPTED (T2 Checkpoint 2): implement exactly the four items above.

e) Stale-read + file:// guards stay; messages per (c2, c9) above.

## D5. Path/approval policy — one resolver, three roots

`resolvePath(input, {intent:"read"|"write"|"exec"})`: roots = workspace ∪
`computerAccess.allowedRoots` ∪ tool scratch dir (`data/tmp-runs/<runId>/`,
new, per-run, swept by heartbeat); blocked patterns GLOBAL (today's shell +
computer lists merged); errors name the nearest allowed root
(`ENOTINROOT: outside workspace; nearest allowed: C:\…`). Existing three
stay as thin wrappers: `resolveWorkspacePath` (intent read/write, root 1),
`resolveComputerPath` (intent read, root 2), `analyzeShellCommand` (intent
exec pre-check). Approval tiers: read = never; write inside workspace =
never; write outside = per session-mode card; exec = per shell policy;
destructive (delete outside `workspace/.trash/`, git push/reset --hard,
provider/config writes) = always card. Trash: `workspace/.trash/` auto-made,
heartbeat purges >30d (new surface, flagged here — no silent behavior).

## D6. Heartbeat & autonomy

- Heartbeat prompt = HEARTBEAT.md + §3 memory slice + pending
  approvals/questions/jobs counts (no full workspace, no tools dump). 30-min
  interval stays. Quiet hours config `heartbeat.quietHours = {start:"23:00",
  end:"07:00"}`: inside the window the model call is skipped (HEARTBEAT_OK
  assumed) but approval-expiry still sweeps.
- Cron stays as-is; UI Scheduled page (Phase 5) exposes create/toggle/run.
- Autonomous runtime (`autonomous-runtime.js`, daemon goal executor behind
  `POST /api/autonomous/execute`, home of the only `reflect()` calls): D2
  does NOT replace it — different jobs (unattended goals vs post-task
  learning). D2 reflection may reuse its model-call helper; document the
  split in code comments at both call sites.

## Deliverable extras

Events added: `skill.proposed {id,name,skillMd,diff,source}`,
`toolset.enabled {name,reason,menuSize,menuTokens}`,
`learning.wrote {kind,text,sessionId}` (existing `subagent.*`,
`approval.*`, `run.question*` unchanged).
Config keys: `learning.enabled=true`, `heartbeat.quietHours=null`,
`loop.compactAtPercent=0.85`, `loop.maxToolResultChars=6000`,
`session.pinnedToolsets=[]`, `OMNICLAW_LEGACY_TOOLS=1`.
Migration/compat: legacy transcripts render (aliases callable); old UI
ignores new events; menu change is server-side only; `promptTrace.report`
gains `budget` + `menu` (additive); trash/scratch dirs created lazily.
Before→after (measured→target): prompt 66720→≤28000 chars; memory kept
0→≥6000; menu 5293 tok (64, 9 silently cut)→CORE 1820 / +browser 3614,
always complete; exec guard-blocks 174→~0 FP; bare `error:true` sites→0.
Implementation order:
- T2.1 context diet (assembly+caps+trace fields; test: fixture turn asserts
  budget table + ≤28k).
- T2.2 menu/toolsets (CORE list, activation, cap removal, menu logging;
  test: menu snapshot per intent + completeness assert).
- T2.3 guard+error fixes (dedupe rule, PS rewrite, contract sweep top-20;
  test: repeat-matrix + PS corpus + error-shape assert).
- T2.4 resolver+tiers (resolvePath, wrappers, trash; test: roots matrix +
  tier matrix).
- T2.5 learning loop (reflect job, skill card event, consolidate cron,
  thread rows; test: ≥3-call run produces lesson; card event fires).
- T2.6 heartbeat/autonomy docs + quiet hours (test: quiet skip + sweep).
STOP for review.

