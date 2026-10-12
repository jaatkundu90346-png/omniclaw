# FRONTEND_API_MAP — OmniClaw current UI → backend (Phase 0 discovery, no UI code changed)

> B1 routes (additive, loopback-only, R12). Test instance: `npm run dev:test`
> (`OMNICLAW_DATA_DIR=./.tmp-test-data PORT=3199`). Tests: `tests/api/*.test.mjs`.

## B1.1 new routes (steps 1–4)

| Feature | Method + Route | Request shape | Response shape | Source | Notes |
|---|---|---|---|---|---|
| Test instance boot | env `OMNICLAW_DATA_DIR` + `PORT`, `npm run dev:test` | — | isolated empty data dir | `server.js` appDir, `scripts/dev-test.mjs` | R11; live untouched |
| Tool correlation id | events `tool.started/output/completed/failed`, `model_tool_loop.*` pair, transients `tool.diff/exec/read/screenshot`, transcript `toolOutputs[]` | — | `+ toolCallId: "tc_<runId>_<n>"` | `agent-loop-controller.js:nextToolCallId`, `omni-loop.js:executeRoundCall`, `agent.js` both flows | additive field; see STREAM_EVENTS.md |
| File tree | `GET /api/fs/tree?path=&depth=2&ignore=` | query; default = active workspace | `{path, entries:[{name,path,type,size,mtime,children?}], truncated}` | `server.js` /api/fs/tree | cap 5k, depth ≤5, skips symlinks |
| File read | `GET /api/fs/read?path=` | query, path required | `{path,size,mtime,encoding,content}` or `{binary:true,…}` | `server.js` /api/fs/read | 1MB cap → 413 ETOOBIG |
| File search | `GET /api/fs/search?q=&limit=50&path=` | query, q required | `{q,limit,path,entries:[…]}` | `server.js` /api/fs/search | substring + subsequence fuzzy, 20k scan cap |
| File write | `POST /api/fs/write` | `{path, content, expectedMtime?}` | `{ok,path,mtime,bytesWritten}` + event `fs.changed {path,mtime}` | `server.js` /api/fs/write | 2MB cap, 409 on mtime mismatch |
| Git status | `GET /api/git/status` | — (active workspace) | `{isRepo}` or `{isRepo,branch,ahead,behind,files[{path,status,staged}],summary{added,deleted}}` | `server.js` /api/git/status | unchanged legacy `/api/workspace/git` kept |
| Git diff | `GET /api/git/diff?path=&staged=0` | query | `{path,patch,added,deleted,binary,truncated}` | `server.js` /api/git/diff | untracked → `--no-index` whole-file (NUL on win) |
| Git stage/unstage | `POST /api/git/stage\|unstage` | `{path}` | `{ok,path}` | `server.js` | add / restore --staged |
| Git revert | `POST /api/git/revert` | `{path, confirm:true}` | `{ok,path}` | `server.js` /api/git/revert | confirm required, checkout -- |
| Policy (all B1 fs/git) | — | computer-access roots+blocked via `FileStore.resolveComputerPath` | errors `{error, code: EINVAL\|EPERM\|ENOENT\|ETOOBIG\|ENOTGIT}` | `file-store.js:43-64`, `tool-registry.js:5528` | loopback-only (`isLoopback`) |

## B1.1 new routes (steps 5–9)

| Feature | Method + Route | Request shape | Response shape | Source | Notes |
|---|---|---|---|---|---|
| Reveal in Explorer | `POST /api/system/reveal` | `{path}` | `{ok,path}` (spawn `explorer.exe /select,<path>`, no shell) | `server.js` /api/system/reveal | loopback-only; `OMNICLAW_TEST_NO_SPAWN=1` stubs `{stubbed,bin,args}` |
| Open path | `POST /api/system/open` | `{path, app:"vscode"\|"default"}` | `{ok,path,app}` (code via PATH lookup → 404 ENOENT if missing; default → explorer) | `server.js` /api/system/open | loopback-only; never `cmd /c start` |
| Session meta | `GET /api/sessions/:id` + list | — | `+ workspacePath, workspaceId, model, agentId` (legacy → nulls) | `session-store.js` normalize/summarize; import preserves meta | additive |
| Config keys | `POST /api/config` | `+ provider.label` (≤120), `+ ui{theme,fontSize,showSystemSessions,panelWidth}` (typed) | `{updated,config}`; unknown ui keys / `providerProfiles` → 400 | `customization-engine.js` whitelist | additive |
| Capabilities | `GET /api/capabilities` | — | `{…,approvalToolTimeoutMs,browser{managed,input,screencast},version}` (loopback-only) | `server.js` /api/capabilities | approvalToolTimeoutMs=300000 (4B.1); browser managed surface (4B.2) |
| Read tweak | `GET /api/fs/read?path=&maxBytes=` | maxBytes 1..1048576 | `+ lines` count | `server.js` /api/fs/read | >1MB → EINVAL |
| Status tweak | `GET /api/git/status` | — | `+ root` (rev-parse --show-toplevel) | `server.js` /api/git/status | for UI relative paths |

> Source of truth from real code. Server entry: `server.js` (raw `node:http`, no framework).
> Active frontend: **vanilla JS, no framework** — `public/index.html` + `public/neo.js` + `public/neo.css`
> (`public/index.html:8,513`, `public/neo.js:1-4` header "Vanilla JS, no framework").
> Legacy: `public/classic/index.html` + `public/classic/app.js` (orphan dup of `public/app.js`), shared `public/app.js`.
> Build: no frontend bundler. `npm run build` = `node --check server.js && node --check public/app.js` (`package.json:20`).
> Packaging: `esbuild` + `@yao-pkg/pkg` → exe (`package.json:73-81`, `scripts/build-windows-portable.mjs:134,156-167`).
> Port: `Number(process.env.PORT || 3147)` (`server.js:86`). Host loopback default (`server.js:2995-2998`).
> Static: `publicDir = <root>/public` (`server.js:72`), `GET /` → `public/index.html` (`server.js:2898-2901`),
> `GET /*` static fallback (`server.js:2903-2920`), `GET /preview/*` workspace files (`server.js:2871-2896`).
> Realtime: **no WebSocket in frontend**. `fetch POST /api/chat/stream` (readable-stream SSE-style) + 2× `EventSource`
> (`/api/events` in classic, `/api/browser/live` in neo). Raw WS exists server-side (`/ws` at `server.js:2925`
> via `src/core/ws-gateway.js:1326-1411`, `/ws/gateway` at `server.js:2927-2930` via `src/core/gateway-ws-protocol.js:186-246`)
> but **no UI uses it → effectively MISSING for frontend**.

## 0. Transport summary

| Layer | Where | Notes |
|---|---|---|
| HTTP + SSE (chat) | `POST /api/chat/stream` (`server.js:2734-2824`) | envelope `start → event* → final → done` / `error`, 15s `heartbeat`; filter `/^(agent\|assistant\|tool\|model_tool_loop\|auto_verification\|provider\|context\|shell\|terminal\|approval\|run\|plan)\./` (`server.js:2745`) |
| SSE (global) | `GET /api/events` (`server.js:821-838`) | `hello` + 15s `heartbeat` + raw gateway records via `broadcastEvent` (`server.js:287-298`) |
| SSE (browser) | `GET /api/browser/live` (`server.js:2526-2599`) | `ready` + replay 8 `action` + live `action\|frame` + 15s `heartbeat` |
| OpenAI-compat | `POST /v1/chat/completions` (`src/core/openai-api.js:246,325-336`) | `chat.completion.chunk` + `data: [DONE]`; UI never calls this |

## 1. Chat / sessions

| Feature | Method + Route OR Event | Request shape | Response / Event payload shape | Source file:line | Notes |
|---|---|---|---|---|---|
| Chat list (neo) | `GET /api/sessions?limit=40` | query `limit` | `{ sessions: [{ id, label, lastUserMessagePreview, … }] }` | `public/neo.js:517`, server `server.js:840` | sidebar, 40 limit |
| Chat open (neo) | `GET /api/sessions/:id` | path id | `{ session, messages: [...] }` | `public/neo.js:596`, server `server.js:1465` | transcript |
| Chat rename (neo) | `POST /api/sessions/rename` | `{ sessionId, label }` | `{ ok, session }` | `public/neo.js:553`, server `server.js:1478` | via prompt() |
| Chat delete (= archive) (neo) | `POST /api/sessions/reset` | `{ sessionId, reason: "archived-from-ui" }` | `{ ok }` | `public/neo.js:567`, server `server.js:1495` | no true delete endpoint |
| Chat create (neo) | local only | generates `chat-MM-DD-HH-mm` client-side | — | `public/neo.js:612-621` | server creates on first send; **no POST /sessions** |
| Chat search (neo) | local filter | input string | filtered list | `public/neo.js:585,518-522` | `label+lastUserMessagePreview.includes(needle)`; `GET /api/sessions/search?q=` exists (`server.js:2692`) but **UI never calls it** |
| Chat list (classic) | `GET /api/state` + `GET /api/gateway` | — | `{ sessions: [...] }` inside state | `public/app.js:4804`, server `server.js:587,625` | aggregated |
| Chat detail (classic) | `GET /api/sessions/:id?messageLimit=80` | query `messageLimit` | `{ session, messages }` | `public/app.js:4046,4828,4847` | |
| Chat summary (classic) | `GET /api/sessions/:id/summary` | path id | `{ summary }` | `public/app.js:5188`, server `server.js:1454` | |
| Chat reset (classic) | `POST /api/sessions/reset` | `{ sessionId, reason: "dashboard-reset" }` | `{ ok }` | `public/app.js:5530` | |
| Cleanup bad history (classic) | `POST /api/sessions/cleanup-problem-history` | `{ reason }` | `{ ok }` | `public/app.js:5553`, server `server.js:1516` | |
| Export / Import / Compact | `GET /api/sessions/:id/export`, `POST /api/sessions/import`, `POST /api/sessions/compact` | — | — | server `server.js:2659,2672,2844` | **MISSING — no UI calls them** |

## 2. Send message / streaming / stop / retry / continue / modes

| Feature | Method + Route OR Event | Request shape | Response / Event payload shape | Source file:line | Notes |
|---|---|---|---|---|---|
| Send message (neo) | `POST /api/chat/stream` (fetch + `reader.read()` loop, split `\n\n`) | `{ message, sessionId?, label, agentId }` | SSE `start/event/final/done/error` (see STREAM_EVENTS.md) | `public/neo.js:903,704,1059-1070`, server `server.js:2734` | main path |
| Send message (classic) | `POST /api/chat/stream` + `AbortController.signal` | `{ message, label, agentId, channel: "webchat", sessionId? }` | same envelope | `public/app.js:5014,5039-5100`, helper `public/app.js:6505,6517-6544` | 2 consumers (form + helper) |
| Send (non-stream, preview edit) | `POST /api/chat` | `{ message: "<path> file ko edit karo: ...", label: "preview-edit", agentId: "main" }` | `{ reply, sessionId, run }` | `public/app.js:6643`, server `server.js:2708` | classic only |
| Global live feed (classic) | `GET SSE /api/events` (`new EventSource`) | optional `?token=` | raw records `{ seq, id, event, payload, at }` | `public/app.js:4945-4948,4962`, server `server.js:821` | neo has no `/api/events` client |
| Stop (neo) | `POST /api/runs/:id/stop` | `{}` (id in path) | `{ ok }` + `run.cancel_requested` event | `public/neo.js:1091-1099`, server `server.js:706` → `agent.js:5824-5831` | cooperative cancel (round/tool boundaries, `omni-loop.js:2537-2545,3462-3464,2814-2816`) |
| Stop (classic) | client `AbortController.abort()` | — | local "Task stopped" | `public/app.js:4976,5117,5168,5179` | **no backend call**; classic never calls `/runs/:id/stop` |
| Steer (nudge running run) | `POST /api/runs/:id/steer` | `{ chars \| message }` | `{ ok }` | server `server.js:716-727`, `agent.js:5854` | **MISSING — no UI calls it** |
| Retry (neo) | reuse `POST /api/chat/stream` with `lastUserMessage` | same as send | same | `public/neo.js:1109-1112` | no dedicated endpoint |
| Continue (neo) | reuse `POST /api/chat/stream` with `"Continue the task..."` | same | same | `public/neo.js:1113-1116` | no dedicated endpoint |
| Delegation retry (classic) | `POST /api/delegations/retry` | `{ delegationId }` | `{ ok }` | `public/app.js:2713-2715,4764`, server `server.js:803` | |
| Plan/Act/Verify mode | local display state only | — | driven by stream events (`plan.updated` → PLANNING, `tool.diff/read` → WORKING, `tool.exec test\|verify\|check\|build\|lint` → VERIFYING) | `public/neo.js:27-31,38,148-151,722,951,961,1039-1055`, `/plan` slash template `public/neo.js:1816` | **MISSING — no mode endpoint** |
| Permission mode Full/Approvals/Readonly (neo) | `POST /api/config` + `GET /api/config` | `{ tools: { permissions: { allowFileWrite, allowShellExecution, allowComputerAccess, allowConnectorWrite, allowBrowserControl }, shellExecution: { approvalMode: auto\|always } } }` | `{ config }` | defs `public/neo.js:1120-1136`, apply `public/neo.js:1191`, detect `public/neo.js:1138,1200-1203,1478,3291`, server `server.js:2250,2239` | chip `#chip-mode` |
| Shell policy (classic) | `POST /api/shell/policy` | `{ mode, policy }` | `{ ok }` | `public/app.js:5350`, server `server.js:1564` | |
| Approval resolve (neo card) | `POST /api/approvals/resolve` | `{ approvalId, decision: approved\|denied, note: "" }` | `{ ok, approval }` | `public/neo.js:1559`, server `server.js:1827` | card data via `GET /api/approvals[?status=pending]` find by id (`public/neo.js:1544`, server `server.js:1786`; 4B.1: list items carry sessionId/runId/tool/summary/command/expiresAt) |
| Question answer (neo ask-card) | `POST /api/questions/answer` | `{ questionId, answer }` | `{ ok }` | `public/neo.js:1496`, server `server.js:1848` | |
| Approve latest (classic) | `POST /api/approvals/resolve` | `{ approvalId: latest.id, decision: "approved", note: "Approved from OmniClaw control UI." }` | same | `public/app.js:5632` | queue from `GET /api/state` (`public/app.js:2720`) |

## 3. Workspace / project / git

| Feature | Method + Route OR Event | Request shape | Response / Event payload shape | Source file:line | Notes |
|---|---|---|---|---|---|
| Current workspace + recents | `GET /api/workspace` | — | `{ selection: { activePath, activeName, recents, isDefault } }` | `public/neo.js:1317`, server `server.js:1919` | label → `#composer-workspace` |
| Browse folders | `GET /api/fs/browse?path=...` | query `path` | `{ path, directories[] }` | `public/neo.js:1394`, server `server.js:1945` | picker nav local (`public/neo.js:1459-1469`); screenshot-3 "Select workspace" modal = this |
| Select workspace | `POST /api/workspace/select` | `{ path }` | `{ ok, selection }` → reload workspace + sessions | `public/neo.js:1434`, server `server.js:1927` | "Agent sirf isi folder ke andar kaam karega" |
| Project name | via `GET /api/workspace` | — | `selection.activeName` | `public/neo.js:1323`, `public/index.html:74` | breadcrumb |
| Branch / repo / changes | `GET /api/workspace/git` | — | `{ isRepo, current, branches[], changes[{ path, kind }], path, error }` | `public/neo.js:420,1339,421-443`, server `server.js:1956` | `.branch-pill` |
| Workspace display (classic) | `GET /api/state` | — | `state.workspace.{ bootstrapFiles, agents[] }` | `public/app.js:3724` | classic never calls `/api/workspace` directly |

## 4. Providers / models / agents

| Feature | Method + Route OR Event | Request shape | Response / Event payload shape | Source file:line | Notes |
|---|---|---|---|---|---|
| Health / version / provider pill | `GET /api/health` | — | `{ provider: { model, id, ready }, version, uptime }` | `public/neo.js:469,480`, server `server.js:570` | → `#provider-pill-text`, `#status-version` (`v0.1.0`), footer "Gateway ready" |
| Models list (neo chip) | `GET /api/models` | — | `{ models[] }` fallback to profiles | `public/neo.js:1230`, server `server.js:2018` | |
| Apply model (neo) | `POST /api/config` | `{ provider: { model } }` | `{ ok }` | `public/neo.js:1248,1288` | |
| Apply profile (neo) | `POST /api/provider/profile` | `{ profileId }` | `{ ok }` | `public/neo.js:1263,2655`, server `server.js:2316` | chip `openai-compatible` in screenshots |
| Discover models | `POST /api/provider/models` | `{ baseUrl?, apiKey?, authStyle?, apiKeyProviderId?\|profileId? }` | `{ models[] }` | `public/neo.js:2455,2528,2617`, `public/app.js:5753,5975`, server `server.js:2385` | settings flow |
| Test provider | `POST /api/provider/test` | `{ baseUrl?, model, apiKey?, authStyle?, profileId?, live: true }` | `{ ok, latencyMs?, error? }` | `public/neo.js:2475,2551,2638`, `public/app.js:4707,5716`, server `server.js:2374` | |
| Save profile | `POST /api/provider/profile/save` | `{ name, baseUrl, model, apiKey, authStyle, apply: true }` | `{ ok, profile }` | `public/neo.js:2494`, server `server.js:2328` | |
| Save key / key status | `POST /api/provider/key` / `GET /api/provider/key/status?providerId=` | `{ providerId, apiKey }` | `{ ok }` / `{ configured }` | `public/neo.js:2598,2603`, `public/app.js:5712,5714,6031`, server `server.js:2352,2367` | |
| Sub-agents runtime | `POST /api/config` | `{ runtime: { subAgents: { provider, model, fallbackModel, maxConcurrent, maxPerHour } } }` | `{ ok }` | `public/neo.js:2566,2660` | |
| Codex login | `POST /api/provider/codex/login` | `{}` | `{ ok, started }` | `public/app.js:5834`, server `server.js:2396` | classic only |
| Provider status | `GET /api/provider/status` | — | — | server `server.js:2261` | **MISSING — no UI calls it** |
| Delete profile | `POST /api/provider/profile/delete` | — | — | server `server.js:2340` | **MISSING — no UI calls it** |
| Agents dropdown + count | `GET /api/agents` | — | `{ agents[] }` | `public/neo.js:489,501,2119`, server `server.js:592` | `#agent-select` ("Main Agent"), `#status-agents` ("Agents 4") |
| Agent inspector | `GET /api/agents/:id/inspector?sessionId=` | query `sessionId` | `{ inspector }` | `public/app.js:2643`, server `server.js:599` | classic only |
| Delegations create/cancel | `POST /api/delegations/create` / `POST /api/delegations/cancel` | `{ … }` | `{ ok }` | `public/app.js:4733,4751`, server `server.js:774,792` | list `GET /api/delegations` (`server.js:763`) **MISSING in UI** |
| Single agent | `GET /api/agents/:id` | — | — | server `server.js:614` | **MISSING — UI uses list + inspector only** |

## 5. Files / diff / editor / preview / terminal / browser / activity

| Feature | Method + Route OR Event | Request shape | Response / Event payload shape | Source file:line | Notes |
|---|---|---|---|---|---|
| Live diff cards | stream event `tool.diff` inside `POST /api/chat/stream` | — | `{ runId, sessionId, agentId, tool, path, diff (≤4000ch) }` | emit `src/core/omni-loop.js:2976,2983`, render `public/neo.js:954,813-828` | no separate diff fetch |
| Exec cards | stream event `tool.exec` | — | `{ command, status, exitCode, stdout≤4000, stderr≤2000, durationMs }` | emit `src/core/omni-loop.js:2986-2994`, render `public/neo.js:959-963,833-848` | e.g. screenshot-2 `list_computer_directory`, `write_computer_file` |
| Read cards | stream event `tool.read` | — | `{ tool, path, lines, observation }` | emit `src/core/omni-loop.js:2998-3006`, render `public/neo.js:965-969` | e.g. screenshot-1 `read_computer_file C:\Users\PATEL COMPUTERS\Downloads\hello.md` |
| Screenshot cards | stream event `tool.screenshot` | — | `{ tool, path, url }` | emit `src/core/omni-loop.js:3012`, render `public/neo.js:970-972` | |
| Editor open (dock `code`) | `POST /api/tools/run` | `{ tool: "read_file", input: { path, limit: 400 } }` | `{ ok, output: { content } }` | `public/neo.js:405,2838`, server `server.js:2500` | generic `runTool(tool,input)` |
| Changes list (dock `workspace`) | local `state.files` + `GET /api/workspace/git` | — | `{ changed/created/read }` sets | `public/neo.js:357-399,432-440` | click → `openFileInEditor` |
| Preview file (dock `browser`/iframe) | `GET /preview/<relPath>?t=...` (static, not `/api`) | path in URL | file bytes | `public/neo.js:2753-2778,873,636,1600`, `public/app.js:6609`, server `server.js:2871-2896` | screenshot-1 "PROJECT FILE:C:\Users\PATEL COMPUTERS\Downloads\hello.md", "Using Code" panel |
| File write from UI | none — only via chat prompt (`dock-edit-send` → `sendMessage("<path> file ko edit karo...")`) | — | — | `public/neo.js:2779` | **MISSING — no direct write endpoint in UI** (backend `tools/run` could but UI doesn't) |
| Directory listing generic | `GET /api/fs/browse` only for workspace picker | — | — | `public/neo.js:1394` | **no generic file explorer in UI** |
| Terminal pane (neo) | display-only from `tool.exec` stream events | — | — | `public/neo.js:228,280-285,834`, buttons local `public/neo.js:2694-2704` | **MISSING — no terminal create/input/resize endpoint; no pty in backend** |
| Terminal (classic) | `GET /api/shell/audit?...` + `POST /api/shell/policy` + `GET /api/jobs` + `POST /api/jobs/cancel` | — | audit/policy/jobs | `public/app.js:4073,5350,5668,5514`, server `server.js:1550,1564,2189,2196` | audit only, no live terminal; `POST /api/jobs` (create, `server.js:2212`) **MISSING in UI** |
| Browser — My Browser via CDP | `POST /api/tools/run` (`browser_remote_connect/launch/navigate/click/type/disconnect`) + `GET SSE /api/browser/live` + `GET /api/browser/launch-status?host&port` | `{ tool: "browser_remote_*", input: {...} }` | `{ ok, output }` + SSE `ready/action/frame` | `public/neo.js:3053,3118,3203,3221,3235,3245,2838,2950-2965,2971,3087,3144`, server `server.js:2500,2526,2603` | target parity with Codex "Browser / New tab / youtube.com" screenshots |
| Browser — managed 4B.2 (Codex-like) | `GET /api/browser/status` · `POST /api/browser/launch` · `GET/POST /api/browser/tabs` · `POST /api/browser/tabs/:id/activate\|close\|navigate\|back\|forward\|reload` · `GET SSE /api/browser/tabs/:id/stream` · `POST /api/browser/tabs/:id/input` · `GET /api/questions?status=pending` | launch `{port?,browser?,startUrl?}`; tabs `:id` in path; navigate `{url}`; input `{type:mouse\|key\|wheel, cssX/cssY/frameW/frameH or text/key/deltaX/deltaY}` | loopback-only; tab id = CDP targetId; B1 shapes; stream `{tabId,ts,w,h,jpegBase64,metadata}`; input mouse/key/wheel (B3 scaling); navigate http(s)/about:blank only (B4) | server `server.js` managed block; same CDP client as tools; `OMNICLAW_BROWSER_PORT` isolation knob; `OMNICLAW_CHROME_PATH`; `OMNICLAW_TEST_HEADLESS=1` |
| Editor split diff/original/modified | local view tabs | — | — | `public/neo.js:288-346,2707` | local only |
| Activity feed (dock `activity`) | local feed fed by stream events (cap 200) | — | — | `public/neo.js:683-692,990,1101,1196` | local only |

## 6. Skills / plugins / messaging / automations / memory / settings / gateway / misc

| Feature | Method + Route OR Event | Request shape | Response / Event payload shape | Source file:line | Notes |
|---|---|---|---|---|---|
| Skills list | `GET /api/skills?agentId=` + `GET /api/tools` | query `agentId` | `{ skills[] }`, `{ tools[] }` | `public/neo.js:1913-1914`, server `server.js:2410,2430` | Use button prefills composer (`public/neo.js:1987`, local) |
| Skill create (classic) | `POST /api/skills` | `{ name, triggers, description, instructions, agentId }` | `{ ok }` | `public/app.js:5611`, server `server.js:2417` | neo never creates |
| Plugins list | `GET /api/plugins` + `GET /api/apps` | — | `{ plugins[] }`, `{ apps }` | `public/neo.js:1997-1998`, server `server.js:2119,848` | |
| Plugin toggle | `POST /api/plugins/toggle` | `{ pluginId, enabled }` | `{ ok }` | `public/neo.js:2077`, `public/app.js:5874`, server `server.js:2150` | |
| Plugin detail / config / reload (classic) | `GET /api/plugins/:id`, `GET /api/plugins/config` (fetch POST?), `POST /api/plugins/reload`, `POST /api/plugins/config` | — | — | `public/app.js:4056,5855,5889`, `public/neo.js:—`, server `server.js:2127,2138,2171` | |
| OAuth save / start / disconnect / computer-use | `POST /api/apps/oauth/config`, `GET /api/apps/oauth/start?provider=` (redirect), `POST /api/apps/disconnect`, `POST /api/apps/computer-use` | `{ provider, clientId, clientSecret, scopes }` / `{ provider }` / `{ enabled }` | `{ ok }` | `public/neo.js:2096,2103,2107,2113`, server `server.js:853,863,891,901` | start via `location.assign`, not fetch |
| Messaging | `GET /api/connectors/adapters` | — | `{ adapters[] }` | `public/neo.js:2145`, server `server.js:936` | classic full suite `public/app.js:4286-4661` (scan/config/cleanup/media/setup/install-plan/token-rotate/test/poll/start/stop/dispatch/retry/cache/ingest/extract/analyze/inject) |
| Messaging save/test | `POST /api/connectors/adapters/config`, `POST /api/connectors/adapters/test` | `{ adapterId: "telegram-bot", enabled, secret, allowedUserIds }` / `{ adapterId }` | `{ ok }` | `public/neo.js:2191,2201`, server `server.js:953,971` | |
| Automations / cron | `GET /api/schedules` (+ classic `POST /api/schedules`, `POST /api/schedules/run\|toggle\|delete`) | `{ … }` | `{ schedules[] }` | `public/neo.js:2215,493`, `public/app.js:4417,5502,4777,4787,4797`, server `server.js:2034,2042,2071,2087,2103` | footer "Cron 0" |
| Memory list | `GET /api/memory` | — | `{ notes[], … }` | `public/neo.js:2234`, server `server.js:1393` | |
| Memory promote/dream/insights (classic) | `POST /api/memory/promote`, `POST /api/memory/dream`, `GET /api/memory/insights?agentId=` | `{ … }` | `{ ok }` | `public/app.js:4672,5456,4687,5203`, server `server.js:1415,1432,1407` | neo list-only |
| Memory search | `GET /api/memory/search?q=` | — | — | server `server.js:2826` | **MISSING — no UI calls it** |
| Settings | `GET /api/health` + `GET /api/config` + provider flows (§4) | — | — | `public/neo.js:2296,2455-2660` | |
| Gateway status (neo) | derived from `GET /api/health provider.ready` | — | dot `#status-gateway` | `public/neo.js:469,481,486` | **neo never calls `GET /api/gateway`** |
| Gateway status (classic) | `GET /api/gateway` + `GET /api/state` + `GET /api/auth/overview` | — | `{ gateway, sessions, … }` | `public/app.js:4804,6065`, server `server.js:625,587,1626` | rotates/approve/reject `public/app.js:4202,5288,4233,4248,4261,4276` |
| Version | via `GET /api/health` | — | `v${health.version}` | `public/neo.js:480` | footer `v0.1.0` |
| System status (classic) | `GET /api/system/status` | — | `{ … }` | `public/app.js:5218`, server `server.js:1532` | |
| Runs trace (classic) | `GET /api/runs/:id/prompt-trace` + `GET /api/runs/:id/tool-trace` | — | `{ trace }` | `public/app.js:1735,1777`, server `server.js:729,741` | |
| Design stitch (classic) | `GET /api/design/stitch` + `POST /api/design/stitch` | — | — | `public/app.js:4151,4174`, server `server.js:2277,2291` | |
| Uploads | `POST /api/uploads` (custom 14MB reader) | `{ name, dataBase64 }` | `{ relPath, isImage, bytes }` → served via `/preview/` | `public/neo.js:1620`, server `server.js:2451,2490` | attachment thumbs `public/neo.js:636,1600` |
| Harness / layers / v2 / MCP / autonomous / trust-auth aliases / jobs-create / provider-status / config-validate / approvals-expire / connectors-base | various (see §7) | — | — | server only | **all MISSING in UI** |

## 7. Backend routes with NO UI usage (MISSING)

`GET /api/harness/status` (`server.js:664`), `GET /api/harness/doctor` (`:675`),
`POST /api/harness/spawn` (`:682`), `POST /api/harness/cancel` (`:696`),
`POST /api/runs/:id/steer` (`:716`), `GET /api/layers` (`:753`), `GET /api/v2` (`:758`),
`GET /api/delegations` (`:763`), `GET /api/connectors` (`:911`),
`POST /api/connectors/adapters/attachments/analyze-pending` (`:1098`),
`GET /api/connectors/telegram/status` (`:1219`), `GET /api/connectors/discord/status` (`:1226`),
`GET /api/trust` (`:1616`), `POST /api/auth/*` aliases (`:1658,1701,1742,1782,1822,1855,1868` — UI uses `/api/trust/*`),
`GET /api/mcp/status` (`:1883`), `POST /api/mcp/connect/:id` (`:1887`), `POST /api/mcp/disconnect/:id` (`:1895`),
`GET /api/mcp/tools` (`:1905`), `POST /api/mcp/call` (`:1909`), `GET /api/agents/:id` (`:614`),
`POST /api/jobs` (`:2212`), `GET /api/provider/status` (`:2261`), `POST /api/provider/profile/delete` (`:2340`),
`POST /api/autonomous/execute` (`:2616`), `GET /api/autonomous/status` (`:2647`),
`GET /api/sessions/:id/export` (`:2659`), `POST /api/sessions/import` (`:2672`),
`GET /api/sessions/search` (`:2692`), `POST /api/sessions/compact` (`:2844`),
`GET /api/memory/search` (`:2826`), `POST /api/config/validate` (`:2835`), `POST /api/approvals/expire` (`:2856`).

## 8. Screenshots (user-provided, `http://localhost:3147` current UI = Neo)

1. Zoomed-out desktop: Codex window behind + OmniClaw `http://localhost:3147` foreground. OmniClaw dark theme:
   left `New task`, `Search chat history`, `chat-09-03-09-29` ("download folder ma hello mankush name sa 1 file bnao"),
   `PROJECT OmniClaw / Local workspace · main`, nav Chat/Skills & Tools/Plugins/Agents/Messaging/Automations/Memory,
   `WORKSPACE Settings`; center `Connected`, Plan/Act/Verify, `Main Agent`, thread `Working · download folder…`,
   `Retry/Continue`, tool chip `read_computer_file`, `THINKING` blocks, composer `workspace · Ask anything. @ to mention, / for actions`,
   chips `openai-compatible · Local · Full Access`; right tabs `Files & Changes/Browser/Preview/Terminal/Editor/Activity`,
   `PROJECT FILE:C:\Users\PATEL COMPUTERS\Downloads\hello.md`, `LIVE`, `READ001 read OK … (8 11…`; footer `Gateway ready Agents 4 Cron 0`, `openai-compatible v0.1.0`.
2. Same UI fullscreen: thread `Working · write_computer_file`, evidence chips `list_computer_directory {... "path": "C:\Users\PATEL COMPUTERS\Downloads" ...}`,
   `write_computer_file {... "bytesWritten": 138 ...}`, `THINKING` ×2, composer focused.
3. `Select workspace` modal ("Agent sirf isi folder ke andar kaam karega", ACTIVE, path input + Go, `Not found`, Cancel/Select this folder)
   over a `Completed · review ready` thread + Editor `Using Code …hello.md` panel.
4-8. **Target** Codex light UI (not ours): left `Codex / New chat / Pull requests / Scheduled / Plugins / Pinned / Projects
   (bharat smart desks, amanman ai agent, 2026-04-22-hlo)`; center `What should we build in 2026-04-22-hlo?`
   (Explore and understand code / Build a new feature / Review code and suggest changes / Fix issues and failures),
   `Do anything` composer + `Approve for me` + `5.6 Terra High`; thread `Working for 48s`, `Thinking`, skill/tool rows;
   right panels `Review` (Branch `+839,841 −3,704`, `omni-loop → origin/main`, `launch.json +17 −0` diff),
   `Browser / New tab / youtube.com` ("Import data from Chrome", "Start browsing", "Try searching to get started").
9. Antigravity "OmniClaw UI Modernization Walkthrough" (floating composer island, + context menu) — reference only.
