# OmniClaw Improvement Loop — vs Claude Code & Hermes

Goal: OmniClaw ko Claude Code aur Hermes dono se behtar agent banana. Har iteration:
ek capability area chuno (chhota → bada) → Claude Code / vendor/hermes-agent se compare
karo → real gap fix karo → smoke test → yahan record karo. Loop khud bhi improve ho
sakta hai. Evidence source: PROGRESS.md ke real run logs (asli failures wahan dikhti hain).

## Comparison backlog (chhota → bada; [x] = done)

- [x] Bug-hunt / smoke-test discipline (2026-07-05, pre-loop)
- [x] Shell reliability: bash-ism auto-repair on Windows (iteration 1)
- [x] Browser tool reliability: startup-race retry + session auto-revive (iteration 2)
- [x] `process_status`/`process_kill` dead-end errors → self-healing auto-resolve (iteration 3)
- [ ] `model-empty-final` outcomes — audited iteration 3 mein: nudge machinery (act-now 3x + observation nudge + 2 summary retries + deterministic fallback) already solid hai; alag fix ki zaroorat nahi lagi, sirf monitor karna hai
- [x] File-path "did you mean" on read/edit ENOENT (iteration 4) — fuzzy-edit matcher audit mein already strong nikla (6 strategies + closest-snippet); asli gap wrong PATHS the
- [x] Context management audit + nearby-docs once-per-run dedup (iteration 5)
- [x] Hermes guardrails compare (iteration 5 audit): OmniClaw ke guards parity/aage hain — version-aware repeat budget, read-before-edit, stale-edit, edit-spin guard, stuck detection; koi port zaroori nahi
- [x] Sub-agent guards: identical-call budget + context bound (iteration 6)
- [x] Sub-agent file checkpoints — shared primitive, sub-agent writes ab rewindable (iteration 7)
- [x] Planning quality: inherited-plan WIP=1 normalization (iteration 8)
- [x] Self-evolution + playbook success metric fix — reasoning-model runs ab success ginte hain (iteration 9)
- [x] Tunable wiring audit — CLEAN: saare 4 tunables consume hote hain + saare 4 signals report mein increment (iteration 10, no fix)
- [x] Memory hybrid-search keyword-gating bug — semantic-only matches ab include (iteration 10)
- [x] Semantic index staleness — incremental backfill (iteration 11)
- [x] SemanticMemory dimension-mismatch — single-dimension guard, flap se index fragment nahi hota (iteration 13)
- [x] Session-summary quality gate — flaky compaction ab good summary overwrite nahi karta (iteration 14)
- [x] Heartbeat due-task clock — over-cap/in-flight tasks ab skip nahi hote (iteration 15)
- [x] code_act: checkpoint dedup (shared module) + wall-timer leak fix (iteration 16)
- [x] Retry-backoff + provider-error-classifier audit — CLEAN (iteration 17, no fix; Math.max resetMs is intended safe behavior)
- [x] Skill matching substring→whole-word — wrong-skill false positives fixed (iteration 17)
- [x] best_of_n scoring audit — CLEAN (iteration 18, no fix; status "completed" ⟺ exit 0)
- [x] Web research HTML-entity decoding — http-fetch text ab clean (iteration 18)
- [x] Tool verdict surfaces STDOUT on failure — tsc/eslint/jest errors ab verdict mein (iteration 19)
- [x] GoalManager autonomous-loop fix — sub-goal registration + addGoals + unique ids (iteration 20)
- [x] Browser click/type/scroll/etc. auto-revive dead session (user bug report) + goto retry hardening + screenshot/vision diagnosis (iteration 21)

## Iteration log

### Iteration 0 — 2026-07-05 — Bug-hunt + smoke-test capability (pre-loop, same session)
- Gap: OmniClaw sirf browser console-check karta tha; khud ka smoke/repro script likhne ka concept nahi tha.
- Fix: Debugging Protocol step 0 (hunt) + write-your-own-repro; loop contract "WRITE YOUR OWN VERIFICATION" rule; verification nudge fallback ab smoke script mangta hai; regression gate bina test-setup wale projects pe bhi firta hai (smoke-script tripwire); `discoverProjectVerification` ab `scripts/` ke smoke/verify/repro scripts auto-discover karta hai (mtime-recent first, cap 3); `VERIFY_CMD_RE` mein smoke|repro|verify.
- Files: src/core/omni-loop.js, src/core/file-store.js
- Evidence: 19/19 targeted checks + scripts/omni-loop-smoke.mjs PASSED.

### Iteration 1 — 2026-07-05 — Shell bash-ism auto-repair (Windows PowerShell 5.1)
- Evidence of gap: PROGRESS.md ka har entry — model `cd X && npm run build` chalata hai (PS 5.1 ParserError), fir agle round `;` se retry. Har task pe wasted rounds; Claude Code ye galti karta hi nahi.
- Fix: `translateBashismsForPowerShell()` in src/core/shell-executor.js — quote-aware; `A && B` → `A; if ($?) { B }` (short-circuit preserved, nested chains bhi), `A || B` → `if (-not $?)`, `/dev/null` → `$null`, `| head/tail -N` → `Select-Object -First/-Last N`. Result mein `syntaxRepairs` + `requestedCommand` + `harnessNote` — model ko dikhta hai kya repair hua taaki agli baar seedha PowerShell likhe. Original AUR repaired dono safety-analyze hote hain (policy bypass nahi).
- Evidence: scripts/shell-repair-smoke.mjs — 19/19 PASS including LIVE powershell.exe runs (short-circuit semantics verified: failing `cd` ke baad doosra command NahI chala). scripts/omni-loop-smoke.mjs PASSED (no regression).

### Iteration 2 — 2026-07-05 — Browser tool reliability (startup race + dead sessions)
- Evidence of gap: PROGRESS.md — `browser_open http://localhost:5173/5174/5175` aur `browser_view` bar-bar Failed/blocked. Do root causes: (1) model server start karke usi saans mein URL kholta hai, port abhi listen nahi kar raha (ERR_CONNECTION_REFUSED) — aur raw Playwright throw model ko milta tha; (2) 5-min idle timeout ke baad `browser_view` "No active browser session" pe mar jaata tha.
- Fix (src/core/browser-playwright.js): (a) local URLs (localhost/127.0.0.1) pe goto 4x retry (~4.5s window) — dev-server startup race absorb; (b) fail hone pe structured actionable error: process_status check karo, vite/next busy port pe DUSRA port pick karte hain, wahi URL kholo; (c) `LAST_URLS` map — session idle-cleanup ke baad `browser_view`/`browser_screenshot` last URL transparently auto-reopen karte hain (reviveSession), result message mein note ke saath.
- Evidence: scripts/browser-reliability-smoke.mjs — 9/9 PASS with REAL Chromium (2s-delayed server start succeeded via retry; killed session auto-revived with correct content; fresh instance still gets the clear "open first" error). scripts/omni-loop-smoke.mjs PASSED (no regression).

### Iteration 3 — 2026-07-05 — process_status/process_kill self-healing
- Evidence of gap: PROGRESS.md — `process_status` bar-bar Failed/blocked (15:50, 15:04 entries). Root cause: tool ko exact processId chahiye tha; weak model id bhool/galat karta hai aur bare "Process not found" dead-end milta tha — dev-server verify flow (start server → process_status → browser_open) wahin toot jaata tha.
- Audit bhi kiya: `model-empty-final` — nudge machinery already solid (act-now 3x, observation nudge, 2 summary retries, deterministic Hinglish fallback); koi fix nahi banaya.
- Fix: src/core/shell-executor.js — `getProcessStatus` ab missing/wrong id pe most-recent (running-first) process pe auto-resolve karta hai, note ke saath jo sahi id sikhata hai + `otherProcesses` list; empty registry pe actionable hint (exec {background:true}). `killProcess` wrong id pe running processes ki id list deta hai. tool-registry.js — process_status schema mein processId ab optional.
- Evidence: scripts/process-status-smoke.mjs — 11/11 PASS (real background process ke saath); shell-repair-smoke + omni-loop-smoke PASSED (no regression).

### Iteration 4 — 2026-07-05 — File-path "did you mean" (read/edit ENOENT self-healing)
- Evidence of gap: PROGRESS.md — `read_file neon-open-world/src/core/Game.ts` / `edit neon-open-world/...` Failed/blocked entries. Audit: fuzzy-edit matcher (Hermes-ported) already strong hai — 6 match strategies + closest-snippet did-you-mean. Asli gap: galat PATH pe raw Node ENOENT (absolute path ke saath cryptic) milta tha; model path variations guess karke spin karta tha.
- Fix: src/core/file-store.js — `findFilesByName()` (workspace walk, node_modules/.git/dist skip, exact basename pehle, phir stem-contains); `readText()` ab ENOENT pe friendly error: real candidate paths ("Did you mean: neon-open-world/src/core/Game.ts?") + list_files/search_text guidance + "do NOT retry guessed variations". EISDIR pe bhi clear message. Edit tool bhi readText use karta hai, toh dono covered.
- Evidence: scripts/path-didyoumean-smoke.mjs — 9/9 PASS (real repo pe exact log-wala case verify hua); omni-loop + process-status + shell-repair smokes PASSED.

### Iteration 5 — 2026-07-05 — Audits (context mgmt, Hermes guardrails) + nearby-docs dedup
- Audit 1 (context management): OmniClaw already Claude Code-parity — token-aware compaction budget, microcompact (duplicate-read dedup), LLM summarize stage jo file paths/decisions preserve karta hai, 2x overflow recovery, structured cross-session summaries (GOAL/DONE/STATE/NEXT). Koi fix nahi banaya.
- Audit 2 (Hermes tool_guardrails.py compare): OmniClaw ke guards parity ya aage (signature-hash repeat budget version-aware hai jo Hermes ka nahi). Koi port nahi.
- Real gap mila (Hermes/goose SubdirectoryHintTracker pattern): OmniClaw `findNearbyDocs` har read_file pe same module-doc excerpts re-attach karta tha — same folder ki 10 files padho toh wahi AGENTS.md excerpt 10x transcript mein (~2KB/read token bloat).
- Fix: src/core/omni-loop.js — exported `dedupeNearbyDocs()` + per-run `surfacedDocs` set; har doc excerpt run mein sirf PEHLI baar attach hota hai jab agent us area ko touch karta hai.
- Evidence: scripts/nearbydocs-dedupe-smoke.mjs — 6/6 PASS; omni-loop-smoke PASSED (no regression).

### Iteration 6 — 2026-07-05 — Sub-agent guards (parent-loop parity)
- Audit: sub-agent spawner core solid (env truth, arg repair, text-drift recovery, rate-limit model fallback, verdict-first results, rolling spawn budget). Do gaps mile jo parent loop mein the par sub-agent mein nahi:
  1. Koi repeat-call budget nahi — weak model 24 rounds tak same call same args pe spin kar sakta tha.
  2. Koi context bound nahi — file-heavy delegation provider context-overflow pe poori mar jaati thi.
- Fix (src/core/sub-agent-spawner.js): (a) identical-call budget — same tool+args max 3x execute, uske baad synthetic blocked result jo model ko redirect karta hai; (b) `boundSubAgentContext()` — budget cross hone pe oldest tool results stub hote hain (newest turns full fidelity), `runtime.subAgents.contextChars` config (default 240000, chhote local models ke liye ghatao); gateway event `subagent.context_bounded`.
- Naya backlog item mila: sub-agent writes ka pre-write checkpoint nahi hota (data-safety gap).
- Evidence: scripts/subagent-guards-smoke.mjs — 8/8 PASS (fake provider ke saath poora delegation loop); omni-loop-smoke PASSED.

### Iteration 7 — 2026-07-05 — Sub-agent file checkpoints (data-safety, /rewind parity)
- Evidence of gap (found in iteration 6): main loop har write se pehle file snapshot leta hai (saveFileCheckpoint → data/checkpoints/<runId>/), par sub-agent ke writes toolRegistry.run() ko seedha call karte the — koi snapshot nahi. Sub-agent ne file clobber ki toh restore_checkpoint use rewind nahi kar sakta tha (data loss risk, khaaskar delegate_task ke doran).
- Fix: nayi shared module src/core/file-checkpoint.js — `saveFileCheckpoint({rootDir, runId, filePath, tool})` + `WRITE_TOOLS` + `checkpointDir()`, existing behavior bit-for-bit port (2MB cap, 60/run bound, seq index, sanitized runId dir). omni-loop.js ab isi ko delegate karta hai (drift khatam). sub-agent-spawner.js executeToolCall write se pehle SAME per-run store mein snapshot leta hai (context.runId, warna sessionId) — toh parent restore_checkpoint sub-agent ke clobber ko bhi rewind kar sakta hai.
- Evidence: scripts/file-checkpoint-smoke.mjs — 11/11 PASS (index shape restore_checkpoint ke expectations se match, sub-agent clobber ke pehle ke bytes snapshot mein). Saari 6 regression smokes (omni-loop, subagent-guards, nearbydocs, process-status, shell-repair, path-didyoumean) PASSED — omni-loop refactor ne kuch nahi toda.

### REBUILD 1 — 2026-07-05 11:58 — Iterations 1-7 shipped to the exe
- `npm run sidecar:build` (esbuild bundle → pkg compile, Rust nahi chahiye — Windows fallback triple), phir `scripts/deploy-gateway.ps1` ne staged exe ko root omniclaw-gateway.exe mein swap kiya (backup: omniclaw-gateway.exe.bak-20260705-115841).
- Verified: naya exe test port 3199 pe boot hua, /api/health `{"ok":true, provider ready}`. Iterations 1-7 ke fixes ab LIVE hain.
- NOTE: iteration 8 (neeche) is rebuild ke BAAD aaya — agli rebuild mein include hoga.

### Iteration 8 — 2026-07-05 — Plan inheritance WIP=1 normalization
- Gap: jab pichla run mid-step marta hai aur step `in_progress` chhodta hai, next run use `in_progress` hi inherit karta tha — jabki koi use run nahi kar raha. Isse inheritance par WIP=1 pre-violate hota tha aur model samajhta tha kaam mid-flight hai.
- Fix: src/core/omni-loop.js — exported `normalizeInheritedPlan()` inherited plan ke har `in_progress` step ko `pending` karta hai (COPY banake — stored session plan mutate nahi hota); inheritance block ab isko use karta hai + note update ("activate the first open step"). Pure + isolated, isliye directly unit-testable.
- Evidence: scripts/plan-inheritance-smoke.mjs — 14/14 PASS (reset + copy-semantics + edge cases); omni-loop-smoke PASSED.

### Iteration 9 — 2026-07-05 — Self-evolution + playbook success metric (reasoning-model fix)
- Gap (real bug, DO jagah): `harness-evolution.js` recordRun aur `omni-loop.js:1663` playbook recordOutcome dono success ko sirf `stoppedReason === "model-final-ready"` maante the. Reasoning models clean completion pe `model-final-from-reasoning` deti hain — toh unka HAR successful run FAILURE count hota tha. Isse (a) evolution ka SUCCESS_GUARDBAND noise ban jaata (achhe experiment revert / bure kept), (b) playbook reinforcement asli success ko "failure" seekhata.
- Fix: shared `SUCCESS_STOP_REASONS` set (dono clean-completion reasons) export kiya harness-evolution.js se; recordRun + omni-loop dono usko use karte hain (drift-proof).
- Evidence: scripts/evolution-success-smoke.mjs — 13/13 PASS (reasoning run ab success, success rate 1/3→2/3 fix hua, failures abhi bhi failures; source-parity checks); omni-loop-smoke PASSED.

### Iteration 10 — 2026-07-05 — Tunable audit (clean) + memory hybrid-search bug
- Audit (evolution tunables): CLEAN. Saare 4 tunables consume hote hain (compactAtPercent:omni-loop 2927, editFailSwitchAt:3677, diagnoseGatherRounds:3756, spinNudgeThreshold:3788) aur saare 4 signals report mein increment hote hain (contextOverflowRecoveries:3251, editStrategySwitches:3679, diagnoseNudges:3763, spinNudges:3789, init 2968). Evolution loop fully wired — koi fix nahi.
- Real bug (memory-store.js hybridSearch): `merged` sirf keywordResults (keywordScore>0) pe iterate karta tha — semantic-only matches (relevant with NO shared keywords, embeddings ka poora point) silently drop hote the. "Hybrid" search asal mein keyword-gated tha; semantic scores sirf keyword hits ko re-rank karte the.
- Fix: `merged` ab keyword ∪ semantic candidate ids ka UNION hai; semantic-only ids allById se full item resolve hote hain; scoring same (keyword*0.7 + semantic*3 + recency + importance). Duplicate nahi (Set), both-match item ek hi baar dono scores ke saath.
- Evidence: scripts/memory-hybrid-search-smoke.mjs — 10/10 PASS (semantic-only match ab include, no dup, keyword-only + empty-query paths intact); omni-loop + harness-memory + memory-upgrade + learning smokes sab PASSED.

### REBUILD 2 — 2026-07-05 12:14 — Iterations 8+9+10 built + STAGED (deploy pending)
- `npm run sidecar:build` safal → staged at src-tauri/binaries/omniclaw-gateway-x86_64-pc-windows-msvc.exe (fresh, iterations 8-10 included).
- Deploy BLOCKED: OmniClaw abhi chal raha hai (PID 6048, running exe file-locked). deploy-gateway.ps1 ne sahi guard kiya — swap nahi hua. Live app abhi bhi REBUILD 1 exe (iterations 1-7) chala raha hai.
- ACTION NEEDED: OmniClaw fully quit karo (tray check), phir chalao:
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-gateway.ps1`
  (staged build root exe mein swap ho jaayega, purana bak ho jaayega). Restart → iterations 8-10 live.

### Iteration 12 — 2026-07-05 — Editable identity/personality bootstrap (PERSONALITY.md first-class)
- User ask: OmniClaw ki identity/soul/personality/user MD-editable ho aur "best" ho; PERSONALITY.md add karo.
- Finding: workspace MD files already har run pe fresh disk se load hote hain (agent.js loadWorkspaceContext:6800) — editability pehle se hai. Par PERSONALITY.md loaded list mein nahi tha; live identity files patle/generic the (IDENTITY 3 lines, SOUL = generic OpenClaw web template).
- Code: PERSONALITY.md ab first-class — agent.js loadWorkspaceContext fileNames mein, runtime-workspace.js REQUIRED_WORKSPACE_FILES mein (+ IDENTITY.md), workspace-bootstrap.js mein default PERSONALITY_TEMPLATE (shared + agent scope) + AGENTS.md reference.
- Content: live workspace/agents/main/ mein rich OmniClaw identity likha — IDENTITY (Mankush/Haryana creator, mission: beat Claude Code/Codex/Hermes, edge), PERSONALITY (voice/attitude/humor/hard-lines, Hinglish), SOUL (values/boundaries, OmniClaw-specific), USER (Mankush profile + working style).
- Evidence: scripts/personality-bootstrap-smoke.mjs — 12/12 PASS (bootstrap creation dono scope, required list, loader, live content); omni-loop-smoke PASSED.

### Iteration 11 — 2026-07-05 — Semantic index incremental backfill
- Gap: hybridSearch ka backfill sirf `embeddings.size < 5` hone par firta tha. Index 5 cross karne ke baad, naye memories (khaaskar `daily` notes aur non-promoted longTerm) kabhi semantic index mein nahi aate the — semantic recall time ke saath stale (sirf pehle ~5-200 seeded items searchable). onPromote hook sirf PROMOTED longTerm cover karta hai.
- Fix: src/core/memory-store.js — backfill trigger ab "koi bhi eligible (longTerm/daily) item unindexed hai" pe firta hai (incremental catch-up). backfillFromItems already indexed skip karta hai + `_backfilling` throttle + fire-and-forget, toh har search pe re-check sasta hai.
- Evidence: scripts/memory-backfill-incremental-smoke.mjs — 6/6 PASS (>5 items pe fire, sab indexed hone pe no re-fire, naya memory catch-up hota hai); hybrid-search + omni-loop smokes PASSED.

### REBUILD 3 — 2026-07-05 12:43 — Iterations 8-12 ALL LIVE
- User ne bola purana exe band karke rebuild. Fresh `npm run sidecar:build` → old exe (PID 6048) stop → `deploy-gateway.ps1` swap (backup: omniclaw-gateway.exe.bak-20260705-124310).
- Verified: naya exe test port 3198 pe boot, /api/health `{"ok":true, provider ready}`. Ab LIVE: iterations 1-12 (plan-inheritance, evolution/playbook success, memory hybrid-search + incremental backfill, editable PERSONALITY.md + rich identity files).
- Restart OmniClaw → naya identity/personality + saare fixes chal rahe honge.

### REBUILD 7 — 2026-07-06 12:50 — Iterations 19-20-21 shipped (1-21 ALL LIVE)
- build → stop exe → backup → swap (attempt 1 OK) → health verify PORT=3194 `{"ok":true, provider ready}`.
- LIVE: verdict stdout-on-failure (19), GoalManager autonomous fix (20), browser interaction auto-revive + goto retry hardening (21). User ka browser view/click bug ab restart pe theek.

### Iteration 21 — 2026-07-06 — Browser interaction auto-revive (USER BUG: "view/click nahi kar pata, errors")
- User report: OmniClaw screenshots dekh nahi pata + browser view/click pe errors.
- Diagnosis #1 (screenshots): active model `nvidia/nemotron-3-ultra-550b-a55b` TEXT-ONLY hai (vision "vl" variant nahi) → visionCapable() sahi se false → screenshots attach nahi hote. Yeh bug nahi, model hi images process nahi kar sakta. Sahi tarika: browser_open ka render report (sections/headings/canvas/consoleErrors) + browser_view (markdown text) se page judge karo.
- Real bug #2 (view/click errors): iteration 2 ne view()/screenshot() ko auto-revive diya tha, PAR click/type/press/scroll/wait/evaluate/goBack/goForward abhi bhi 5-min idle-cleanup ke baad "No active browser session" se hard-fail karte the — page kholo, phir agle click pe error. (Do formatting variants the — clean-blank aur trailing-space blank lines — dono replace kiye.)
- Fix (src/core/browser-playwright.js): saare 8 interaction methods ab reviveSession() use karte hain (dead session pe last URL transparently reopen). Plus open() ki retry regex mein "interrupted by another navigation" add kiya (chrome-error race — startup-race recovery ab flake nahi karti).
- Evidence: scripts/browser-interaction-revive-smoke.mjs — 6/6 PASS with REAL Chromium (click/type/scroll/evaluate session-death ke baad auto-revive, never-opened still clear error); browser-reliability-smoke (iteration 2) 9/9 PASS; omni-loop-smoke PASSED.

### Iteration 20 — 2026-07-06 — GoalManager autonomous-execution correctness (3 real bugs)
- Area: GoalManager (autonomous-runtime.js ke 24h TAOR loop ka core). Teen sanchay-toone-wale bugs:
  1. autonomous-runtime `this.goalManager.addGoals(newGoals)` call karta hai (daemon mode, naye goals mile toh) — par GoalManager mein `addGoals` method THA HI NAHI → runtime crash, task fail.
  2. Sub-goals `rootGoal.subGoals` pe attach hote the par `goalHistory` mein register nahi hote the; `completeGoal`/`failGoal` `goalHistory.find(id)` karte hain → sub-goal pe silent no-op → status kabhi "pending" se nahi badalta → `getNextSubGoal` wahi pehla sub-goal HAR iteration deta → autonomous task kabhi aage nahi badhta (maxIterations tak same sub-goal).
  3. Sub-goal ids `goal_${Date.now()}_1/_2` the — jab goal multiple heuristics match kare (jaise "research and build"), dono branches same-ms same id mint karte → DUPLICATE ids → completeGoal galat sub-goal pe act karta.
- Fix (src/core/goal-manager.js): `nextGoalId()` monotonic counter (collision-proof), `registerGoals()` (decomposeGoal ab apne sub-goals goalHistory mein register karta), naya `addGoals()` (current goal ke subGoals mein attach + register), saare Date.now ids `nextGoalId()` se replace.
- Evidence: scripts/goal-manager-autonomous-smoke.mjs — 12/12 PASS (multi-pattern unique ids, completeGoal loop ko advance karta, saare sub-goals eventually complete = no infinite loop, failGoal kaam karta, addGoals attach+pickable+completable); omni-loop-smoke PASSED.

### Iteration 19 — 2026-07-06 — Tool verdict surfaces STDOUT on failure
- Area: formatToolResultForModel (har tool result yahin se model ko dikhta hai — main loop + sub-agents). Mostly solid + well-tested. Real gap: failed command pe verdict SIRF stderr surface karta tha (line 174-175). Par tsc/eslint/jest/vite apne diagnostics STDOUT pe print karte hain, stderr khaali. Toh failing typecheck "❌ command FAILED (exit 1)" dikhta tha bina error detail ke — model ko JSON body khodna padta, jo weak models nahi karte. Debugging workflow (#1 use-case) mein direct friction.
- Fix (src/core/omni-loop.js): failure pe stdout tail bhi verdict mein pin karo (`stdout (tail): …<last 900>`) — compilers/test-runners error list + summary end mein rakhte hain. Success path untouched (stdout body mein hi rehta hai). stderr + stdout dono ho toh dono dikhte hain.
- Evidence: scripts/verdict-stdout-on-failure-smoke.mjs — 9/9 PASS (tsc errors ab verdict mein, long stdout tail-capped with … marker, both streams, success unchanged, empty-stdout no spurious line); tool-result-verdict-smoke 13/13 (no regression); omni-loop-smoke PASSED.

### REBUILD 6 — 2026-07-06 03:13 — Iterations 16-17-18 shipped (1-18 ALL LIVE)
- `npm run sidecar:build` → stop exe → backup → swap (attempt 1 OK) → health verify PORT=3195 `{"ok":true, provider ready}`.
- Ab LIVE: code_act dedup+timer (16), skill-match whole-word (17), web-research entity decode (18) + saare pichle.
- Note: deploy one-liner mein `"$i:"` PowerShell drive-variable parse error deta hai — `${i}` ya `-f` format use karo.

### Iteration 18 — 2026-07-05 — Web research HTML-entity decoding (+ best_of_n audit)
- Audit (best_of_n scoring): CLEAN. verify-command pass check `status === "completed"` sound hai — run_terminal_command → executeTerminalCommand → shellExecutor jahan `status="completed"` SIRF exitCode 0 pe hota hai, toh failing verify correctly fail score karta hai. `.execution?.status` term dead-but-harmless. Koi fix nahi.
- Real bug (web-research.js fetchUrl): http-fetch path tags strip karta tha par HTML entities decode NAHI karta tha — page text mein raw `&amp;`, `&#39;`, `&nbsp;`, `&rsquo;` reh jaate the (tokens waste + model comprehension garbled). Yeh TinyFish na hone par primary path hai (common case). Existing `decodeEntities` sirf RSS parsing mein use hota tha aur incomplete tha (5 entities, numeric nahi).
- Fix: naya `decodeHtmlEntities()` (named map + decimal `&#160;` + hex `&#xA0;`, unknown/out-of-range safe), fetchUrl http-fetch path mein wire kiya; `decodeEntities` (RSS) ab isi ko use karta hai + tag-strip pehle karta hai (entity-encoded `&lt;div&gt;` ab fake tag ki tarah nahi kate). Dono functions export kiye (testable).
- Evidence: scripts/web-entity-decode-smoke.mjs — 18/18 PASS (named+numeric+hex decode, unknown/bare-&/out-of-range preserved, tag-strip+decode order, CDATA, realistic page text mein koi raw entity nahi bacha); omni-loop-smoke PASSED.

### Iteration 17 — 2026-07-05 — Skill matching whole-word (+ retry/classifier audit)
- Audit (retry-backoff.js + provider-error-classifier.js): CLEAN. jitteredBackoff, parseRateLimitHeaders, rateLimitGuard, aur category→policy→backoff mapping sound + well-tested. `resetMs = Math.max(...windows)` intended hai (sabhi reset windows tak wait = retry succeed hone ki guarantee; test line 49 confirm karta hai). Sirf ek misleading comment ("soonest" → actually "latest"); behavioral bug nahi, chhoda.
- Real bug (skill-registry.js match): token scoring `text.includes(token)` SUBSTRING match tha — description word "art" message "start the server" pe score karta tha (+1), "cat" "category" pe, galat skill inject. Comment khud "wrong skill injected" ko #1 problem kehta hai.
- Fix: message ka whole-word Set banao (`split(/[^a-z0-9_]+/)`), token scoring ab `messageWords.has(token)` membership pe. Triggers substring rehne diye (curated, specific, forgiving recall ke liye).
- Evidence: scripts/skill-match-wholeword-smoke.mjs — 7/7 PASS ('start'≠artwork, 'category'≠catalog, legit deploy/art/pdf matches intact, empty/unrelated khaali); omni-loop-smoke PASSED.

### Iteration 16 — 2026-07-05 — code_act checkpoint dedup + wall-timer leak
- Area: code_act tool (CodeAct — ek JS script jo kai tool calls compose karta hai; differentiator). Do gaps:
  1. `saveCheckpointForPath` iteration-7 wale shared file-checkpoint.js ka HAND-ROLLED DUPLICATE tha (same format, 2MB cap, 60/run bound, seq index) — exactly wahi drift jise iteration 7 mein eliminate karna tha. Shared changes se yeh copy diverge kar sakti thi.
  2. runCodeAct ka wall-clock `Promise.race` setTimeout kabhi clear nahi hota tha — fast-finishing script ke baad bhi timer up to `wall` ms (default 60s, max 120s) event loop pe pada rehta tha. Long-running gateway mein heavy code_act use par accumulate.
- Fix (src/core/tool-registry.js): saveCheckpointForPath ab shared `saveFileCheckpoint` ko delegate karta hai (import add kiya) — main-loop, sub-agent, code_act teeno ek hi checkpoint implementation share karte hain. Wall timer `wallTimer` variable mein capture + `finally { clearTimeout }` (catch return kare ya success, dono cover).
- Evidence: scripts/codeact-checkpoint-timer-smoke.mjs — 9/9 PASS (in-script write shared-format checkpoint banata hai + pre-write bytes restorable; process.getActiveResourcesInfo se confirm koi leaked Timeout nahi; syntax-error path clean). file-checkpoint (iteration 7) + omni-loop smokes PASSED.

### REBUILD 5 — 2026-07-05 18:37 — Iterations 13-14-15 shipped (1-15 ALL LIVE)
- `npm run sidecar:build` → deploy. Swap pehle attempt pe "user-mapped section open" se fail hua (AV/indexer ka transient lock freshly-built file par; koi gateway process nahi tha). Backup ban chuka tha (omniclaw-gateway.exe.bak-20260705-183750). Direct copy retry (5 attempts, 4s gap) — attempt 1 pe succeed (lock release ho gaya).
- Verified: naya exe PORT=3196 pe boot, /api/health `{"ok":true, provider ready}`. Iterations 1-15 ab LIVE: dimension guard (13), summary quality gate (14), heartbeat due-task clock (15) sab included.
- Lesson: deploy swap fail ho "user-mapped section" se toh few-second retry aksar kaam karta hai (transient AV/indexer lock), poora exe re-lock nahi.

### Iteration 15 — 2026-07-05 — Heartbeat due-task clock (mark-on-attempt)
- Gap: evaluateHeartbeatPrompt task ko DUE-EVALUATION time pe `taskRuns.set(key, now)` se "run" mark kar deta tha — par executeDueTasks sirf `dueTasks.slice(0,3)` chalata hai (3/tick cap) aur `if (this.taskRunning) return` pe poora batch drop karta hai. Toh 3 se zyada due tasks, ya jab pichla run in-flight ho — wo marked-run ho jaate the par kabhi execute nahi hote → poore interval ke liye silently skip (classic mark-before-do bug).
- Fix (src/core/heartbeat.js): clock advance ko executeDueTasks mein move kiya — har task ko tabhi mark karo jab actually run ke liye consume ho (loop ke andar, per task). Over-cap tasks stay due → agle tick pe pick hote hain. Mark-on-attempt (success par nahi) taaki persistently failing task har tick model ko hammer na kare. taskRunning guard pe kuch mark nahi hota (batch stays due).
- Evidence: scripts/heartbeat-due-tasks-smoke.mjs — 10/10 PASS (5 tasks: evaluate marks nothing, sirf 3 execute+mark, t4/t5 stay due aur agle tick pe execute, in-flight run kuch execute/mark nahi karta); omni-loop-smoke PASSED.

### Iteration 14 — 2026-07-05 — Session-summary quality gate
- Gap: SummarizationEngine.summarizeSession compaction-model ka response seedha writeSummary ko deta tha — koi quality check nahi. Agar model empty/refusal/tiny fragment return kare (bina throw kiye), toh pichli accumulated GOOD summary garbage se overwrite ho jaati thi — session continuity silently wipe (agla resume isi summary pe depend karta hai). `return existing` sirf THROW pe firta tha, empty response pe nahi.
- Fix (src/core/summarization-engine.js): quality gate before write — summary trim karke reject agar `< 40` chars YA koi structured section label (GOAL/DONE/DECISIONS/STATE/NEXT/PREFS) nahi. Reject pe existing summary rakho + messageCountAtLastSummary advance mat karo (agle cycle retry) + `session.summarization_rejected` event.
- Evidence: scripts/summary-quality-gate-smoke.mjs — 7/7 PASS (good likhta hai, empty/label-less overwrite nahi karte, naya good replace karta hai, bad first summary null return); omni-loop-smoke PASSED.

### Iteration 13 — 2026-07-05 — SemanticMemory single-dimension guard
- Gap: AdaptiveEmbedder do source se vectors deta hai — real API (e.g. 1536-dim) aur lexical fallback (256-dim). API mid-session flap kare toh backfill/add mixed-dimension store bana deta tha. cosineSimilarity cross-dimension pe 0 deta hai, toh koi single query poore index ko span nahi kar sakti — aadhe memories silently unsearchable (partial recall loss). embeddingsModel configured hone par real bug.
- Fix (src/core/semantic-memory.js): store ab pehle embedding se canonical dimension pin karta hai. `addMemory` aur `backfillFromItems` conflicting-dim adds skip karte hain (count ke saath) — index single-dimension rehta hai, fully searchable; embedder consistent hone par item agle run mein index ho jaata hai. `search()` sirf same-dim vectors compare karta hai (perf + clean degradation). Naya `canonicalDimension()` + `dimensionInfo()` (fragmented flag + conflictsSkipped observability; badhta conflict = model change → embeddings.json clear karke reindex).
- Evidence: scripts/semantic-dimension-guard-smoke.mjs — 12/12 PASS (flap simulate: conflicting add skip, wrong-dim query khaali, recover pe skipped item index, store kabhi fragment nahi); hybrid-search + incremental-backfill + omni-loop smokes sab PASSED.

### REBUILD 4 — 2026-07-05 18:13 — Identity work re-applied + redeployed
- Context-compaction ke baad iteration-12 ke SOURCE edits revert ho gaye the (mere Edit calls old_string bina PERSONALITY.md ke match hue). Sab dobara apply kiya: agent.js loader, runtime-workspace.js REQUIRED, workspace-bootstrap.js PERSONALITY_TEMPLATE + AGENTS ref; live workspace/agents/main/{IDENTITY,PERSONALITY,SOUL,USER}.md rich content.
- Duplicate smoke test hata diya (canonical = scripts/personality-bootstrap-smoke.mjs, 12/12 PASS). User ne exe band karne ko authorize kiya → fresh `npm run sidecar:build` → deploy (backup: omniclaw-gateway.exe.bak-20260705-181246).
- Verified: naya exe PORT=3197 pe boot, /api/health `{"ok":true, provider ready}`. Deployed exe ab current verified source se match karta hai. Iterations 1-12 confirmed LIVE.

## Reminder
Running app = packaged omniclaw-gateway.exe — source fixes tabhi live honge jab rebuild+deploy hoga. Deploy ke liye app quit hona zaroori (running exe locked; ya explicitly Stop-Process se band karo). Fixes batch karo, ek rebuild. Iterations 1-21 ALL LIVE (REBUILD 7, health-verified PORT=3194). Restart OmniClaw → browser view/click fix + sab live. NOTE: active model nemotron-3-ultra TEXT-ONLY hai — screenshots dekh nahi sakta; browser_view (markdown) + render report se page judge hota hai. Vision chahiye toh vision-capable model (gpt-4o/claude/gemini/qwen-vl) laga. Restart OmniClaw → sab fixes + naya identity/personality chalega. Deploy "user-mapped section"/lock pe: Copy-Item few-second retry loop (transient AV/indexer lock). Restart OmniClaw → sab live fixes + naya identity/personality chalega. Deploy "user-mapped section" error pe: few-second retry karo (transient AV/indexer lock). Identity/personality ab MD-editable: workspace/agents/main/{IDENTITY,PERSONALITY,SOUL,USER}.md — edit karo, agle run mein live, rebuild nahi chahiye. Health verify: PORT env var hai (default 3147), OMNICLAW_PORT NAHI.
