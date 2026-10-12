# STREAM_EVENTS — every streaming event type (from real code, Phase 0)

> Chain: provider (`src/core/providers/openai-compatible-provider.js:353-606`, in-process `onDelta/onReasoning`
> callbacks, NOT browser SSE) → loop throttle (`src/core/omni-loop.js:2476-2629,3224-3263,3583-3591`) →
> delegation (`src/core/agent.js:5885-5920`, falls back to legacy loop on `omni_loop.failed`) →
> bus (`src/core/gateway-store.js:350-391` transient `emitTransient` vs persisted `addEvent`, cap 200, 250ms debounce) →
> SSE envelope (`server.js:273-298`).
> `POST /api/chat/stream` only forwards events matching
> `/^(agent|assistant|tool|model_tool_loop|auto_verification|provider|context|shell|terminal|approval|run|plan)\./`
> (`server.js:2745`); classic duplicates a narrower filter lacking `assistant|plan` (`public/app.js:1714`).
> Frontend: neo `fetch /api/chat/stream` + `handlePacket` (`public/neo.js:903,918-1057,1059-1070`),
> classic same + `EventSource /api/events` (`public/app.js:4945-4962,5014,6505`), browser frames
> `EventSource /api/browser/live` (`public/neo.js:2950-2965`).

## 1. Outer SSE envelope (`data:` JSON, one object per frame)

| `type` | Emitted at | Example payload (copied from code) | Consumed at |
|---|---|---|---|
| `start` | `server.js:2746-2751` | `{ "type": "start", "timestamp": "<startedMs ISO>", "status": "agent-loop", "message": "Agent manager accepted the request and is waiting for live loop events." }` | ignored (no branch) — `public/neo.js:918`, `public/app.js:5050,6527` |
| `heartbeat` | `server.js:827` (`/api/events`), `server.js:2752-2754` (`/chat/stream`, 15s), `server.js:2581` (browser) | `{ "type": "heartbeat", "timestamp": "<now ISO>" }` | no handler (keepalive); unknown types dropped `public/neo.js:1059-1069` |
| `event` | `server.js:2768` `writeSSE(res, { type: "event", record })` | `{ "type": "event", "record": { "seq": 12, "id": "event_…", "event": "tool.started", "payload": { "runId": "…", "sessionId": "…", "tool": "exec" }, "at": "2026-…", "transient": true } }` (`gateway-store.js:359-379`) | `public/app.js:5054-5055,6530-6531` → `trackLiveRunEvent`; `public/neo.js:919-1032` → `handlePacket` dispatch |
| `final` | `server.js:2809-2814` | `{ "type": "final", "content": "<result.reply or ''>", "metadata": { "mode": "…", "model": "…", "providerId": "…", "durationMs": 0, "stepCount": 0, "toolCallCount": 0, "totalTokens": 0, "stopReason": "completed", "fixedErrors": false, "failedToolCount": 0, "autoVerificationCount": 0, "pendingApprovalCount": 0 }, "data": "<compactResult>" }` | `public/app.js:5056-5071,6532-6534`; `public/neo.js:1034-1044` → `appendAssistant + loadRepoPanel` |
| `done` | `server.js:2815` | `{ "type": "done", "runId": "<streamRunId>", "sessionId": "<streamSessionId>", "data": "<compactResult>" }` | `public/app.js:5072-5091,6535-6537`; `public/neo.js:1045-1049` → save `sessionId`, `loadSessions()` |
| `error` | `server.js:2817` | `{ "type": "error", "error": "<error.message>" }` | `public/app.js:5094-5096,6538-6540`; `public/neo.js:1050-1056` → `appendAssistant("Run failed:…")` |
| `hello` | `server.js:823` (`GET /api/events`) | `{ "type": "hello", "at": "<now ISO>" }` | `public/app.js:4951` skips `hello`; neo: no `/api/events` client |
| `ready` | `server.js:2544-2551` (`GET /api/browser/live`) | `{ "type": "ready", "connection": {}, "tabId": "<id>", "url": "<tab.url>", "title": "<tab.title>", "tabs": [] }` | `public/neo.js:2950-2965` → `mbOnReady` |
| `action` | `server.js:2555,2558` (replay 8 + live `onBrowserAction`) | `{ "type": "action", "action": { "kind": "click\|type\|key\|navigate", "…": "…" } }` | `public/neo.js:2957` → `mbOnAction`; formatted `public/neo.js:2898-2913` |
| `frame` | `server.js:2573` | `{ "type": "frame", "data": "<jpeg base64>", "metadata": { "deviceWidth": 0, "deviceHeight": 0 } }` | `public/neo.js:2956` → `mbOnFrame` |
| `token` (stale — never emitted by server) | only `src/core/providers/mock-provider.js:283`: `controller.enqueue(...data: {"type":"token","content":reply.slice(i,i+8)})` | `{ "type": "token", "content": "<8 chars>" }` | dead branches `public/app.js:5051-5053,6527-6529` (live text arrives as `assistant.delta`) |
| `tools` (stale — no emitter) | none found | — | `public/app.js:5092-5093` `toolOutputs=event.toolOutputs`; neo: no branch |
| raw broadcast (no wrapper) | `server.js:287-296` `broadcastEvent(record)` → `GET /api/events` | `{ "seq": 1, "id": "event_…", "event": "agent.thinking", "payload": { "…": "…" }, "at": "…" }` | `public/app.js:4948-4954` `EventSource.onmessage` → `trackLiveRunEvent` |

## 2. Inner `record.event` values (ride inside `type:event` / raw `/api/events`)

### 2a. Transient — `emitTransient`, never persisted (`src/core/omni-loop.js`)

| `record.event` | Emitted at | Example payload (copied) | Consumed at |
|---|---|---|---|
| `assistant.delta` | `src/core/omni-loop.js:3256,3238-3244` (`makeDeltaEmitter`: flush ≥300 chars or 200ms) | `{ "runId": "<id>", "sessionId": "<id>", "agentId": "<id>", "round": 1, "text": "<buffer>" }` | `public/neo.js:933-949` live bubble (rAF throttle); classic **drops** it (`app.js:1714` regex lacks `assistant`) |
| `assistant.reasoning` | `src/core/omni-loop.js:3257` + fallback `3659-3665` (`text.slice(0,8000)`) | same shape `{ runId, sessionId, agentId, round, text }` | `public/neo.js:926-932` think bubble |
| `model.waiting` | `src/core/omni-loop.js:2550-2553` (every 5s in-flight) | `{ "runId": "<id>", "waitMs": 5000, "gotFirstToken": false }` | `public/neo.js:994-1001` ("Model connect ho raha hai… Ns"); **never via `/chat/stream`** (`model.` fails `interesting` regex — only `/api/events`) |
| `tool.diff` | `src/core/omni-loop.js:2976,2983` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "tool": "edit\|write\|append\|patch", "path": "<file>", "diff": "<≤4000ch>" }` | `public/neo.js:954-958` → `renderDiffCard + trackFileEvent` |
| `tool.exec` | `src/core/omni-loop.js:2986-2994` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "command": "…", "status": "…", "exitCode": 0, "stdout": "<≤4000ch>", "stderr": "<≤2000ch>", "durationMs": 0 }` | `public/neo.js:959-964` → `renderExecCard` (+ VERIFYING on `/test\|verify\|check\|build\|lint/`) |
| `tool.read` | `src/core/omni-loop.js:2998-3006` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "tool": "read_file", "path": "…", "lines": "lines a-b of n", "observation": "<≤6000ch>" }` | `public/neo.js:965-969` → `renderReadCard` |
| `tool.screenshot` | `src/core/omni-loop.js:3012` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "tool": "…", "path": "<shotPath>", "url": "<output.url or ''>" }` | `public/neo.js:970-972` → `renderScreenshotCard` |
| `context.usage` | `src/core/omni-loop.js:3505-3508` (per round) | `{ "runId": "…", "sessionId": "…", "agentId": "…", "round": 1, "tokensUsed": 0, "windowTokens": 0, "percentFull": 0 }` | `public/neo.js:1002-1012` meter (warn ≥70, hot ≥85) |

### 2b. Persistent — `addEvent` (forwarded if matching `interesting`)

| `record.event` | Emitted at | Example payload | Consumed at |
|---|---|---|---|
| `agent.thinking` | `src/core/agent.js:2754,2810,3105,4558,5518,6048` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "message": "…" }` | `public/neo.js:991-993`; classic timeline `public/app.js:1724` |
| `agent.started/accepted/queued/dequeued/completed/done/failed` | `src/core/agent.js:2450,2458,1771,2747,3446,3453,4005` | `{ runId, sessionId, agentId, … }` | `public/neo.js:990` `activityRow`; classic timeline |
| `tool.started/completed/failed/output` | `src/core/agent.js:2854,2881,2891,237,253`; `src/core/omni-loop.js:2883,2958` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "round": 1, "tool": "exec", "engine": "omni-loop" }` | `public/neo.js:1013-1032` chips + counts |
| `toolCallId` (B1, on all of the above + `model_tool_loop.*` pair + `tool.diff/exec/read/screenshot` + transcript `toolOutputs[]`) | minted per call via `nextToolCallId(run)` (`src/core/agent-loop-controller.js`), format `tc_<runId>_<n>` | `{ …, "toolCallId": "tc_run_abc_3" }` | new UI correlates exact-match; legacy `step`+FIFO fallback kept |
| `model_tool_loop.*` (`round_started/self_correction_started/native_fallback/tool_started/tool_completed`) | `src/core/agent.js:6040,6115,6140,6154,6237,6274,6308,6337,6353,6376,6400,6431,6466,6485,6554`; `src/core/omni-loop.js:3486,3637` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "round": 1, "maxRounds": 0, "engine": "omni-loop" }` | `public/neo.js:1013,1022` chips; rest `activityRow`; classic timeline + label map `public/app.js:444-477,1233-1312` |
| `provider.started/completed/failed` | `src/core/agent.js:3707,3749,3769,4565,4607,4646` | `{ runId, sessionId, … }` | generic rows |
| `context.compacted/summarized` | `src/core/agent.js:3568`; `src/core/omni-loop.js:3530,3548` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "engine": "omni-loop", "totalChars": 0 }` | generic rows |
| `approval.requested/resolved` | `src/core/gateway-store.js:466-472,490-494` (4B.1 constants at top) | requested `{ "approvalId", "type", "tool", "summary", "command" (≤500ch), "sessionId", "runId", "createdAt", "expiresAt" }`; resolved `{approvalId, decision, sessionId, runId}` | `public/neo.js:982-989` approval cards + `WAITING_FOR_APPROVAL`; `/next` global store (`web-next/js/approvals.js`) + tray/banner |
| `run.question` / `run.question_timeout` | `src/core/tool-registry.js:2467,2483` (+ `tool:"ask_user"`; open items mirrored in-memory for `GET /api/questions`, Q1 4B.2) | `{ "questionId": "…", "question": "…", "options": ["…","…"], "allowOther": true, "runId": "…", "sessionId": "…" }` | `public/neo.js:974-981` ask-cards |
| `plan.updated` | `src/core/tool-registry.js:1163-1173` | `{ "runId": "…", "sessionId": "…", "agentId": "…", "steps": [{ "title": "…", "status": "…" }], "note": "…", "completed": 0, "total": 0, "activeCount": 0, "wipViolation": false }` | `public/neo.js:950-953,886-900` plan checklist |
| `run.cancel_requested/steer_requested/question_answered/approvals_resolved` | `src/core/agent.js:5830,5854,5881,6829` | `{ "runId": "<id>" }` / `{ "runId": "…", "chars": 0 }` | `public/neo.js:1101` etc. |
| `agent.loop_stage` (observed live, not in Phase-0 list) | loop stage markers e.g. intake/session_queue/workspace_snapshot | `{ stage, at, runId, … }` | ignored by `/next` thread (default case) |
| `agent.accepted` (observed live) | run accepted into the queue | `{ runId, sessionId, queued, waitedMs }` | ignored (ticker only) |
| `agent.done` (observed live) | run finished (sibling of completed) | `{ runId, stopReason, steps, toolCallCount, finalMetadata }` | ignored (`done` envelope drives UI) |
| `agent.reviewing` (emitted, rarely streamed) | loop self-review note | `{ reason, remainingIssues[] }` (`agent-loop-controller.js:137-144`) | ignored |
| `model_tool_loop.reasoning` (observed live) | round reasoning size note | `{ runId, round, engine, chars }` | ignored (text comes via `assistant.reasoning`) |
| `shell.*/terminal.*` | `src/core/agent.js:2922,2946,6607,6713` | `{ … }` | pass filter → generic rows |
| `auto_verification.tool_started/completed` | `src/core/agent.js:5542,5573` | `{ … }` | pass filter → generic rows |
| `omni_loop.*` (`started/steered/plan_seeded`) | `src/core/omni-loop.js:3447,3474,1439` | `{ runId, sessionId, agentId, … }` | **dropped from `/chat/stream`** (no `omni_loop` in filter); only raw `/api/events` + `data/gateway.json` |
| `model.*`, `mcp.*`, `ws.*`, `client.*`, `autonomous.*`, `computer.*`, `browser.*` | `src/core/ws-gateway.js:269-948`, `src/core/agent-loop-runtime.js:75`, `src/core/tool-registry.js:1163-7754` | various | only raw `/api/events`, not `/chat/stream` |

## 3. Stop / abort (no `POST /abort` exists)

1. Classic: `activeChatController.abort()` on submit/stop/Esc (`public/app.js:4975-4979,5018,5167-5179`);
   `AbortError` → "Task stopped" (`public/app.js:5117-5118`). Pure client cancel.
2. Neo: `POST /api/runs/:runId/stop` (`public/neo.js:1091-1106` → `server.js:706-712` →
   `agent.cancelRun` → `cancelledRuns.add` + `run.cancel_requested` in `src/core/agent.js:5824-5831`).
   `fetch /api/chat/stream` itself has **no `signal`** (`public/neo.js:903-912`).
3. Server polls cancel: 500ms `cancelWatcher` → `controller.abort("Run cancelled by user.")`
   (`src/core/omni-loop.js:2537-2545`), round top → `stoppedReason="cancelled"` (`:3462-3464`),
   before each tool (`:2814-2816`), `ask_user` loop (`src/core/tool-registry.js:2477`).
4. Provider abort chain: per-attempt `AbortController` + round/first-token timeouts + 60s idle watchdog
   (`src/core/omni-loop.js:2503,2523-2535,2550-2554,2568` →
   `src/core/providers/openai-compatible-provider.js:5-24,387-409,500-546`).

## 4. Provider-internal (not browser SSE — for implementers)

| Channel | Where | Shape |
|---|---|---|
| `choice.delta.content` | `src/core/providers/openai-compatible-provider.js:507-514` → `onDelta` | provider chunk → `contentScrubber.feed()` → `wrappedOnDelta` (`omni-loop.js:2517-2518`) → `assistant.delta` |
| `delta.reasoning_content/reasoning` | `openai-compatible-provider.js:500-505` → `onReasoning` | → `wrappedOnReasoning` (`omni-loop.js:2520-2521`) → `assistant.reasoning` |
| `delta.tool_calls[i]` | `openai-compatible-provider.js:516-528` → accumulated `[{ id, tool, input, type: "function" }]` | → `executeRoundCall` (`omni-loop.js:3677`) → `tool.started/completed` + `tool.diff/exec/read` cards |
