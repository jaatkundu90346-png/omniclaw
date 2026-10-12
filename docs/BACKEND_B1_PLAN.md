# BACKEND B1 plan — API foundation for the new UI (discovery, no code yet)

> B1.0 output. All file:line verified against the working tree. Rules R11–R13
> live in `AGENTS.md` (Hard constraints). No code changed in this phase.

## a) Data dir / config resolution today

Everything hangs off one `rootDir`:
- `server.js:102-104` — `runtimeDir = process.pkg ? process.cwd() : path.resolve(process.env.OMNICLAW_ROOT_DIR || sourceDir)`; `server.js:108-110` passes it as `new OmniClawAgent({ rootDir: runtimeDir })`.
- `src/core/agent.js:210-219` — fans out: `WorkspaceStore(rootDir, rootDir)` (:215), `ConfigStore(rootDir)` (:216, → `data/config.json` per config-store.js:27), `SecretStore(rootDir)` (:217, → `data/secrets.json` per secret-store.js:10), `DeviceTrustStore`, `MemoryStore`.
- `src/core/session-store.js:60-66` — `data/sessions.json` + `data/sessions/` transcripts under rootDir. `src/core/workspace-store.js:54-57` — `data/workspaces.json` under rootDir.
- `server.js:120` — `PORT` already env-driven (`process.env.PORT || 3147`).
- **No `OMNICLAW_DATA_DIR` exists today.** Only `OMNICLAW_ROOT_DIR` (repo root override).

**Design (B1.1 step 1):** `const appDir = path.resolve(process.env.OMNICLAW_DATA_DIR || runtimeDir)` in server.js, then `new OmniClawAgent({ rootDir: appDir })`. `publicDir`/`webNextDir` stay on sourceDir. Empty dir self-initializes (every store `mkdirSync`s + writes defaults: config-store.js:28, secret-store.js:25-26, workspace-store ensureStorage). Default workspace root becomes the test dir itself (WorkspaceStore(rootDir, rootDir), agent.js:215) — good isolation. `npm run dev:test` = `OMNICLAW_DATA_DIR=./.tmp-test-data PORT=3199 node server.js` (documented in README). Known leak: `uploads/` (server.js:2520 `runtimeDir/uploads`) and logs stay under runtimeDir — acceptable (tests don't upload); noted, not fixed in B1.

## b) toolCallId — exact diff plan (additive field, no shape breaks)

Emitters today (all WITHOUT any call id):
- `src/core/agent-loop-controller.js:96-104` `toolStarted({tool,input,reason})` → `tool.started {tool,input,reason,step}`; `:106-116` `toolOutput` → `tool.output {tool,step,preview,outputSummary,resultPreview,bytes}`; `:118-135` `toolCompleted` → `tool.completed|failed {tool,step,blocked,error,ok}`. `step` (`this.steps`, :65) is already identical across the three — keep it, ADD id.
- `src/core/omni-loop.js:2882` calls `loopController.toolStarted`, `:2956` toolOutput, `:2957` toolCompleted; `:2883-2890` emits `model_tool_loop.tool_started {round,tool,engine}`, `:2958-2969` `tool_completed {round,tool,engine,durationMs,…}`; transients `:2976` `tool.diff`, `:2986` `tool.exec`, `:2998` `tool.read`, `:3012` `tool.screenshot` (all `{runId,sessionId,agentId}` + tool + path/command, no id).
- Legacy flows emit the same names WITHOUT input/step: `agent.js:2854` started, `:2881/:2891` completed/failed, `:5745/:5776` model_tool_loop pair; exec-process `tool.output` at `agent.js:237,253` (has `processId`, no step).
- Subagents do NOT emit tool events — `sub-agent-spawner.js:558` calls `toolRegistry.run` directly; only lifecycle events (`subagent.spawned/completed/cancelled/failed`, sub-agent-spawner.js:175,194,221). So: **no `parentToolCallId` needed in B1** (nothing to parent to); if subagent tool events are ever added, the spawner already has the parent call context at :558 to thread one through.

**Diff plan (B1.1 step 2):**
1. `agent-loop-controller.js` — `toolStarted/call`: `const toolCallId = call.toolCallId || createId("toolcall")`; include `toolCallId` in all three `this.event(...)` payloads; return it. (`createId` pattern exists per-module, e.g. session-store.js:6; or `crypto.randomUUID()` — static import, no dynamic import per AGENTS.md constraint.)
2. `omni-loop.js` `executeRoundCall` — generate ONE `toolCallId` per call before `:2882`; pass into `loopController.toolStarted({tool,input,reason,toolCallId})` (controller reuses instead of minting — keeps id stable across its three events); stamp the same id on `model_tool_loop.tool_started/completed` (`:2883`, `:2958`) and on every transient of that call (`:2976,2983,2986,2998,3012`).
3. Legacy `agent.js` flows — same treatment at `:2854/:2881/:2891` and `:5745/:5776` (mint per call, reuse across its events). Exec-process `tool.output` (`:237,253`): add `processId`-paired `toolCallId` where known, else omit (never fake).
4. New UI switches correlation to `toolCallId` (exact match → step+wildcard fallback). Old UI ignores unknown fields (R12-safe).

## c) Path policy — the ONE function new routes must reuse

- Workspace-relative: `FileStore.resolveWorkspacePath()` (`src/core/file-store.js:66-73`) → strips leading slashes, `ensureWithinRoot` containment (`file-store.js:5-15`, throws "Path is outside the allowed workspace."). Used by `read_file` (`tool-registry.js:1990-2018` via `fileStore.readText`), `search_text` (`:2020-2043` via `fileStore.searchText`), `write_file` (`:2045+`, `writableRoots` at :2059).
- Absolute/Computer paths: `FileStore.resolveComputerPath(input, policy)` (`file-store.js:43-64`) — `allowedRoots` (default `["~"]`) + `blockedPathPatterns`, used with `config.tools.computerAccess` / `config.tools.filesystem` caps (`maxReadBytes`, tool-registry.js:2010).
- **Rule: new fs/git routes call `agent.fileStore.resolveWorkspacePath()` (+ `resolveComputerPath` ONLY where old tools already allow absolute — cite per route). No new policy code.**

## d) Git + Files & Changes today

- Server runs git via `execFileSync("git", …)` (no shell): branch list `server.js:1999`, status `server.js:2013`, response `{isRepo,current,branches[],changes[]}` (`server.js:2034-2037`).
- Neo Files & Changes calls `GET /api/workspace/git` (`public/neo.js:420`; panel render `:421-443`). No other git surface. New git routes reuse the same `execFileSync("git", …)` pattern (AGENTS.md shell-policy: never build shell strings).

## e) POST /api/config whitelist (customization-engine.js:11-206)

Accepts: `profile/activeProfile`, `providerMode/mode`, `model`, `baseUrl`, `apiKeyProviderId`, `httpReferer`, `appTitle`, `compactionModel`, `runtime.subAgents{provider,model,fallbackModel,maxConcurrent,maxPerHour,timeoutMs}` (:82-104), `ownerMode/fullComputerAccess` bulk (:106-143), `computerAccess{}` passthrough (:145-150), `shellExecution{}` spread (:152-160), `tools.permissions` 10 known booleans (:166-182), `approvalMode auto|always` (:183-192).
**Missing for UI: provider `label` (no API writer exists — set only via profile save+apply), and a `ui` object.** B1.1 step 7 adds both (additive; `ui{theme,fontSize,showSystemSessions}` free-form-safe keys only).

## f) Terminal

- `node-pty` NOT installed (package.json deps: esbuild/pkg/tauri/playwright/ws only) — needs node-gyp + C++ toolchain on Windows: **not feasible**. Plan: `child_process.spawn("powershell.exe"|cmd, cwd inside workspace)` + stdin/stdout over a new WS channel reusing `attachWsGateway({server, agent, pathname:"/ws/terminal", handler})` (`src/core/ws-gateway.js:1326-1411`, raw-upgrade + custom-protocol pattern). Cap 5 sessions, kill on WS close, cwd forced inside workspace root, loopback-only. Feasible — medium.

## g) Attachments → provider images

- Provider builds `content` as **plain strings** everywhere (`openai-compatible-provider.js:232-233, 627-654`; three `messages:` sites at :230, :329/:407 passthrough, :627). NO image parts today.
- Plan (B1.1 step 9, feasible — medium): `POST /api/chat/stream` accepts optional `attachments:[{name,mime,dataBase64}]` (cap ~10MB total, reuse uploads allow-list server.js:2510); server stores under `<dataDir>/uploads/` (R11: test-dir aware); provider layer converts to OpenAI `content:[{type:"text"…},{type:"image_url",image_url:{url:"data:<mime>;base64,…"}}]` blocks at the human-message site(s). Non-vision models: fall back to "[image: name]" text note (today's behavior).

## Proposed route list (all R12-compliant; tests per R13 in B1.1)

| # | Method + path | Req | Res | Policy/event |
|---|---|---|---|---|
| 1 | env only | `OMNICLAW_DATA_DIR`, `PORT=3199`, `npm run dev:test` | — | README |
| 2 | (events) | `toolCallId` added: started/output/completed/failed + model_tool_loop pair + 4 transients | old shapes + 1 field | none new |
| 3 | GET `/api/fs/tree?path=&depth=2` | validate, cap 5k entries, ignore node_modules/.git/dist/.venv | `{entries:[{name,path,type,size,mtime,children?}]}` | resolveWorkspacePath |
| 3 | GET `/api/fs/read?path=` | text only 1MB cap; binary→`{binary:true}` | `{path,size,mtime,encoding,content}` | resolveWorkspacePath + binaryReadGuard pattern (tool-registry.js:2004) |
| 3 | GET `/api/fs/search?q=&limit=50` | substring/fuzzy names via fileStore walk | `{entries:[…]}` | resolveWorkspacePath root |
| 3 | POST `/api/fs/write {path,content,expectedMtime?}` | optimistic-lock; size cap | `{ok,path,mtime}` + NEW optional event `fs.changed {path,mtime,runId?}` | resolveWorkspacePath + writableRoots check (tool-registry.js:2059) |
| 4 | GET `/api/git/status` | repo? else `{isRepo:false}` | `{isRepo,branch,ahead,behind,files[{path,status,staged}],summary}` | execFileSync git, cwd=workspace |
| 4 | GET `/api/git/diff?path=&staged=0` | caps | `{path,patch,added,deleted,binary}` | same |
| 4 | POST `/api/git/revert {path,confirm:true}` + `/stage` + `/unstage {path}` | confirm required | `{ok}` | same (no commit/push in B1) |
| 5 | POST `/api/system/reveal {path}` | loopback-only | `{ok}` via `explorer /select,` | containment; POST `/api/system/open {path,app}` → `code <path>` / default |
| 6 | (additive fields) | GET session detail + list summaries gain `workspacePath,workspaceId,model,agentId`; persist `workspacePath` in session meta | old shapes + 4 fields | — |
| 7 | (whitelist) | provider `label` + `ui{theme,fontSize,showSystemSessions}` | — | additive keys only |
| 8 | WS `/ws/terminal` | `{open,cwd}→{id}; {input}; {resize}` / `{output},{exit}` | cap 5, kill on close, cwd in workspace | loopback-only |
| 9 | POST field | `/api/chat/stream` gains optional `attachments[]` | stored under data dir; vision→image_url parts | 10MB cap, allow-list |

**STOP — waiting for "go" for B1.1.**
