# OmniClaw Root-Cause Report (evidence-based, no fixes)

Method: read-only scan of `data/gateway.json` (120 runs), `data/sessions.json` (207 sessions),
`data/sessions/transcripts/*.jsonl` (207 files, 708 assistant run-reports), `data/*.json`,
`tmp/parse-failures/` (29 files); plus `scripts/diagnostics/run-stats.mjs` (new, read-only;
output in `docs/diagnostics/`). Code cites are file:line. Excerpts ≤15 lines.
Note: root `PROGRESS.md` already holds developer postmortems of Sept runs (fixes for idle
timeout, model-aware budget, project-context root, update_plan loop-breaker have LANDED in code
since); verdicts below describe observed runs, not current code.

## 1. Verdict table

| Hypothesis | Verdict | Key evidence (1–2 lines) | Impact |
|---|---|---|---|
| H1 finish invisible yet referenced | PARTIAL | `finish` defined (`tool-registry.js:1237`) but absent from `CODEX_GRADE_MODEL_TOOLS` allowlist (verified by search); contract never says "call finish" — it says "reply with final text only" (`omni-loop.js:2940`). Result: `finish-tool` 1/120 runs, real finish calls 0/47 embedded reports; model ends by text (`model-final-ready` 40/120) | High |
| H2 HEARTBEAT.md failure harness-induced | CONFIRMED | `heartbeatPrompt` set unconditionally (`agent.js:7314-7315`) → every prompt carries "Read HEARTBEAT.md if it exists"; file absent in user folders → 12 `File not found: HEARTBEAT.md` hits across 4 transcripts; deep-dive round 2 burned a call on it | Med |
| H3 load_toolset failure cause | CONFIRMED | Exact error: `Unknown toolset: popular-web-designs. Call list_toolsets for names.` (transcript, 4× same name + 14 `Unknown toolset` hits corpus-wide). Valid names at that moment: the 12 `TOOLSETS` keys (`tool-layers.js:18`); model mapped injected SKILL name `popular-web-designs` → toolset | High |
| H4 nudge/guard overload + contradictions | PARTIAL | 18 injectable nudges inventoried (`omni-loop.js:3037-5988`); but last-50 runs: only 9/47 reports nudged (reasoningLengthCuts 5, budgetWarned 3, 4 others ×1; spin/diagnose/verify/reverify 0). Real contradictions found in static instructions (C1–C3 below), not nudge volume | Med |
| H5 evolution non-determinism | REFUTED (now) | `data/evolution/state.json`: `tunables:{spinNudgeThreshold:4}` (= code default), `activeExperiment:null`; only experiment (2026-07-05→09) `reverted`. Tunables CAN change `compactAtPercent`/thresholds when an experiment runs — none active | Low |
| H6 history budget → frequent compaction | REFUTED as stated | Histories are large (10.6k–35k chars, n=68) but compaction is RARE: truncate 0/50, LLM summary 0/50 AND 0 `Earlier work summary` hits in all 207 transcripts; digest 15/50. Large windows (up to 1M) keep meter at 2–30%, so nothing compacts — cost is token spend, not compaction churn | Med |
| H7 compaction-model lossy summaries | UNVERIFIED | Zero real summaries exist to compare (see H6). Structural risk only: 900-token cap + flatten caps (tool 1200/call-args 200/other 1200, input 24k; `omni-loop.js:3236-3257`), original-task pin mitigates goal loss | Low |
| H8 auto-learning pollution | PARTIAL | `instincts.json`: 8 entries, all generic, none wrong (all ≤8 injected/run). `playbooks.json`: `coding` + `website-build` entries contain leaked meta-text ("Let me analyze the latest run…", "Draft bullets:", "That's already 10 lines. I need max") now injected via `playbooks.buildSection`; website-build refs `neox-agent/...` paths. `data/memory.json`: 2 trivial greeting notes (June) | Med |
| H9 repo-context leak + wrong-folder PROGRESS.md | CONFIRMED | 21 runs inject repo-root `AGENTS.md/SPRINT.md/feature_list.json/arch_rules.json/PROGRESS.md/DECISIONS.md` as project scope (e.g. `run_1788624524440_sg6peq`); 187/207 sessions have `workspacePath:null` → fallback scans repo root (`agent.js:7195-7228`, whose own comment admits the 2026-09-23 failure). `writeAutoProgress` writes `path.join(runtime.rootDir,"PROGRESS.md")` (`omni-loop.js:1606`) — always the repo root, never the user project | High |
| H10 omni→legacy fallthrough | REFUTED (now) | 8/708 assistant reports lack `loopEngine` (~1%, all June, e.g. `run_1782219553483_us3mxc`); `omni_loop.failed` events in store: 0. Behavior delta if hit: maxRounds 50 vs 18, JSON-prompt loop, legacy repair/verify passes | Low |
| H11 write/edit failure categories | CONFIRMED | Last-50 fails: `update_plan` missing-steps ×4, `apply_patch` missing Begin/End ×4, `write_file` read-before-edit ×2, `edit` find-miss ×1; `tmp/parse-failures/` holds 29 captures (mostly `edit` raw-args). No length-cut write failures observed in window | Med |
| H12 codex-cli default vs real usage | CONFIRMED | Default `codex-cli` (`config/default.json`) unused: live `data/config.json` overrides to `openai-compatible`; last-50 providers 100% `openai-compatible` free models (ling-flash 12+10, nex-pro 9, nemotron-ultra 7…). Native calls WORK (toolCallCount p90 26); text-recovery 1 call/50 runs; argRepairs 0 | High |

## 2. Run stats (last 50; `docs/diagnostics/run-stats.{md,json,txt}`)

stoppedReason: model-final-ready 12 (24%), cancelled 7 (14%), rate-limited 6 (12%),
provider-error 6 (12%), auth-error 5 (10%), stuck-no-progress 4 (8%), NONE 3 (6%),
max_rounds 2 (4%), from-reasoning/budget/billing/model-not-found/finish-tool 1 each (2%).
Provider-fail stops: 19/50 (38%); last-120: 41/120 (34%).
Rounds med/p90/avg 2/16/5.4; toolCalls 1/26/6.8; failed 0/8/2.2.
Finish: real `finish` calls 0/47 embedded; `finish-tool` 1/50 (1/120).
Compaction: truncate 0, summary 0, digest 15, overflow-recovery 0.
Nudges (47 reports, 9 nudged): reasoningLengthCuts 5, budgetWarned 3,
action/actNow/observation/buildVerify ×1, all others 0.
Failing tools: read_file 39 (`File not found…`, incl PROGRESS.md ×4), load_toolset 7
(`Unknown toolset: popular-web-designs` ×4), apply_patch 4 (missing Begin/End),
update_plan 4 (missing `steps` array), write_file 2 (read-before-edit block),
edit 1 (find-text miss).
Recovery/reasoning: text-recovered calls 1, arg repairs 0; 31 runs used reasoning,
97,767 tokens total (~3.1k/run).
History sizes (n=68 reports): historyChars 10.6k–35k (med ~17k); prefixChars 31k–43k;
schemasChars 13.2k–21.4k. Round-1 payload already ~18k tokens with zero tool calls.

Deep-dive `session_1790150170356_c8kzpj` / `run_1790150170368_elangm` (NEXUS brief,
`nex-agi/nex-n2.5-pro:free`): 5 rounds, 10 calls, usages 80k/3.2k/83k tokens.
Round 1: `update_plan` (reasoning 434t, ratio 434). Round 2: 5 calls —
`list_files nexus-lab`→empty, `list_files .`→8 entries, `read_file HEARTBEAT.md`→
`❌ TOOL ERROR: File not found: HEARTBEAT.md (attempted absolute path:
C:\Users\PATEL COMPUTERS\Desktop\myNew folder\HEARTBEAT.md; project root: …).
Paths are relative to the project root — use list_files or search_text…`,
`load_toolset progress`→ok+pinned, `load_toolset popular-web-designs`→
`❌ TOOL ERROR: Unknown toolset: popular-web-designs. Call list_toolsets for names.`
Rounds 3–4: plan update, `feature_list`→empty, `load_toolset browser`→ok,
`list_toolsets`→catalog. Round ratios 434/41.4/925/180.7 (run total 210.8).
Round 5: `OmniLoop round timed out after 180000ms` → `provider-error`; final text =
generic message + "Failed/blocked: read_file HEARTBEAT.md ; load_toolset".
No compaction, no nudges, context meter 2% of 1M window. Menu final: 30 tools,
5169 tokens, sets [project browser git computer progress]. Legacy bundle in
promptTrace: 25054/28000 chars, **311 omitted**, tools 301→2 included
(`browser_remote_connect, browser_remote_launch`).

## 3. Prompt sizes + conflicts (dumps: `docs/diagnostics/prompt_round1.txt`, `prompt_late.txt`)

Base sections (empty-context, measured): identity 2323c, creator 792c, tooling 639c,
harness 1281c, exec-bias 579c, safety 369c, control 312c, identity-mem 671c,
workspace-empty 392c, docs 202c, sandbox 262c, runtime 641c, directives 537c
(~9k chars / ~2.3k tokens). Late-round measured: prefix 37917 + schemas 20677 +
history 16978 + toolResults 5527 + ledger 0 = 89938 chars (~22.5k tokens).
Conflicts found:
C1. Tooling "call load_toolset directly… never required first" (`system-prompt.js:128-129`)
  vs error "Call list_toolsets for names" → guess-and-fail (14 hits).
C2. Injected SKILL names (`popular-web-designs`) vs toolset namespace — no namespacing;
  model mapped skill→toolset (H3).
C3. "Reply with final text only and no tool calls" (`omni-loop.js:2940`) vs `finish`
  tool ("Report the final result and end the run", `tool-registry.js:1238`) absent from
  default menu → text endings, finish-tool 1/120.
C4. Budget "avoid re-reading files" (`omni-loop.js:5005`) vs read-before-edit BLOCK.
C5. "Batch ALL independent calls in ONE turn" vs 6-call cap parking excess ("re-issue
  next round", `omni-loop.js:5653`).
C6. Diagnose-first "STOP reading, run NOW" (`:5864`) vs spin "Stop gathering, DECIDE and
  build" (`:5880`) — opposite directives, stackable across rounds.
C7. "Read PROGRESS.md / record via update_progress" vs harness writing repo-root
  PROGRESS.md vs `File not found: PROGRESS.md` ×12 in user folders (H9).

## 4. Per-hypothesis notes (short)

H1: Booth sides verified: allowlist lacks `finish` (search of `tool-registry.js:849-1043`);
`CORE_TOOL_ORDER` (`omni-loop.js:924`) lists it, menu code protects it
(`tool-layers.js:392`), loop honors it (`omni-loop.js:5681-95`) — but the model never
sees its schema by default. "What it does instead": plain-text final
(`model-final-ready` 33%, `model-empty-final` 4/120) or silence→observation-nudge.
H2: Mechanism is the unconditional `heartbeatPrompt`, not a missing-file line or the
index. 12 hits/4 files; also drives PROGRESS.md reads (12 hits) via clock-in text.
H3: Name passed `popular-web-designs` (twice: design + verification reasons); valid =
12 `TOOLSETS` keys. Contributing: skill of same name injected that turn
(promptTrace.skills) + catalog saying "never required first".
H4: Full inventory with triggers — Budget(5005, spend≥70%), LengthCut(5200, len-cut +
write), ReasoningCut(5244), Degenerate(5262), Action(5283, 0 tools + actionable),
Reverify(5311), Regression(5337), DoD-verify(5364), ActNow(5400, ≤3 + force-required),
Observation(5421), RoundCap(5653), EditSwitch(5769, 2 fails/file), BuildVerify(5791,
round≥10 ≤3×), Churn(5814, 3 rewrites), Diagnose(5864), Spin(5880, 4 gather rounds
≤3×), Summary-request(5988), Digest-note(3037). Fired last-50: cuts 5, budget 3,
4×1, rest 0 — overload is potential, not observed, in this window.
H5: Only ever-changing knob persisted is `spinNudgeThreshold:4` (= default 4);
`maybeEvolve` last ran 2026-09-23 (`state.json lastCycleAt`) with no active experiment.
H6: Window sized from model (`contextTokens`, source `model` in deep-dive: 1048576),
so big-model runs never compact; small-model runs would compact at the same char
thresholds — measure per-model if pursued.
H7: No samples; session summaries dir holds empty shells (`{"text":""}`); risk is
forward-looking only.
H8: Instinct injection ≤8/run ranked relevance×confidence (`omni-loop.js:1996-2026`);
all 8 qualify today. Playbook leak is the concrete pollutant (2 entries).
H9: Fallback chain: `session.workspacePath(null)` → `getWorkspaceRoot()` → repo root
(`agent.js:7122,7195-7228`); 187/207 sessions null-pathed. Budget-handoff path
UNVERIFIED (likely same root file; `omni-loop.js:1642` references PROGRESS.md handoff).
H10: Legacy shape = report without `loopEngine` key (`agent.js:6181-6205`); 8/708, June.
H11: No length-cut/parse write failures in window; parse captures exist for `edit`
only (29 files, e.g. `run_1789792090639_1j7pe7-r11-…txt` raw `{"path":…Desktop\new
window\index.html","find":"  updateVehicles();…`). Empty-`update_plan` ×4 matches the
Sept postmortem (loop-breaker since landed).
H12: Override chain: `data/config.json provider.mode=openai-compatible` beats default
`codex-cli`; all 50 runs free-tier OpenRouter-style ids; rotation counter 0 in
deep-dive (timeout isn't rotatable). Native calling healthy; thinking is the cost
center (ratios to 925, 97.8k tokens/50 runs).

## 5. Top 5 root causes (ranked by reliability impact)

1. **Repo-context cross-contamination (H9)** — user-folder chats inherit OmniClaw's own
   playbook (21 runs) and all auto-progress lands in the repo root; 187/207 sessions
   lack a stored workspacePath. High.
2. **Free-tier provider fragility + timeout kills (H12)** — 34–38% of runs end
   provider-failed/rate-limited/auth; 180s kills mid-stream; models think hundreds of
   tokens per action (ratios 41–925) burning 80k+ prompt tokens for 0 writes. High.
3. **finish/menu + skill/toolset namespace confusion (H1+H3)** — invisible `finish`,
   skill-named toolset guesses, list-first contradiction; failed calls + wasted rounds
   in exactly the runs that then time out. High.
4. **First-round fixed cost + bundle starvation** — ~18k-token round-1 floor (prefix
   8–11k + schemas) with 311/28k legacy omissions forcing re-discovery loops. Med-High.
5. **Write-path failure cluster (H11)** — empty `update_plan`, unformatted
   `apply_patch`, read-before-edit blocks, find-miss + 29 parse captures; each costs
   rounds and feeds stuck-stops (6/120). Med.
