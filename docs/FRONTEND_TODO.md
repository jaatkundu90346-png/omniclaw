# FRONTEND_TODO — Phase 0 MISSING items affecting UI + Phase 1 findings

> Machine-readable scope lives in `feature_list.json`; this file is the human-readable
> backlog for the `/next` (web-next) rebuild. "MISSING" = backend exists but neo UI
> never calls it, or no backend support at all (see `docs/FRONTEND_API_MAP.md` §7).

## From Phase 0 (still open, by area)

- Sessions: `GET /api/sessions/search?q=` unused (neo filters locally) — decide: server
  search in Phase 5 or drop. `GET /api/sessions/:id/export`, `POST /api/sessions/import`,
  `POST /api/sessions/compact` have no UI — needed for a future share/backup feature.
- Session create: NO endpoint — label is made client-side, server creates on first
  `POST /api/chat/stream`. Keep this flow in Phase 2 (do not invent `POST /api/sessions`).
- Runs: `POST /api/runs/:id/steer` unused — Phase 2+ decides if the thread view gets
  a nudge/steer control. No `POST /abort` — stop is `POST /api/runs/:id/stop` only.
- Plan/Act/Verify: NOT sent to backend (C1) — read-only stage line in Phase 2 thread view.
- Permission mode: global `POST /api/config` (C2) — composer "Approve for me" control
  arrives with the Phase 2/3 composer, never per-thread.
- Terminal: NO pty/create/input/resize endpoint — Phase 4 terminal can only render
  `tool.exec` stream cards (like neo) unless a backend pty is built first.
- Files: NO direct write endpoint in UI flow (writes go through the agent via chat).
  `GET /api/fs/browse` is workspace-picker-only, not a generic explorer.
- Browser: CDP remote flow exists (`browser_remote_*` via `POST /api/tools/run` +
  `GET /api/browser/live` SSE) — Phase 4 reuses neo's exact calls.
- Memory: `GET /api/memory/search` unused; promote/dream/insights are classic-only.
- Providers: `GET /api/provider/status`, `POST /api/provider/profile/delete` unused.
- MCP (`/api/mcp/*`), harness (`/api/harness/*`), autonomous, jobs-create, layers/v2,
  `POST /api/config/validate`, `POST /api/approvals/expire`, `/api/auth/*` aliases:
  no UI — only add surfaces when a phase explicitly needs them.
- Realtime: `/ws` + `/ws/gateway` exist server-side but NO UI uses them — `/next`
  stays on `fetch` + SSE like neo until a phase justifies WS.

## New findings from Phase 1 (must respect in later phases)

1. Rate limiter is 60 req/min/IP (`server.js:29-48`). Idle cost is ~3 API req/10s
   (`getStatus` = health+agents+schedules); boot is ~4 API + ~20 no-store static
   assets. Do NOT poll faster; batch status calls; never auto-retry in a tight loop
   (rapid reloads already return 429 and render a blank page).
2. Sidebar collapse MUST use 0-width grid tracks, never `display:none` on the grid
   item — removing it reassigns main/panel to the wrong tracks (found + fixed in
   `web-next/css/layout.css`, `web-next/js/ui/shell.js`).
3. Legacy sessions have keys WITHOUT the `:ws:<id>` suffix
   (`agent:main:webchat:<label>`); `workspaceIdFromSessionKey` returns null for them
   and the sidebar groups them under an "unknown workspace" row — never drop them.
4. Cold-server boot takes ~9s before the router renders (agent warmup + 4 API calls);
   keep a loading state in mind for Phase 2 thread view. Warm server is instant.
5. `public/` was already dirty (staged+unstaged edits to `index.html`/`neo.css`/`neo.js`
   from earlier work) BEFORE Phase 1 — Phase 1 made zero edits there. Do not mistake
   those diffs for `/next` changes; do not "fix" them in this rebuild.
6. No MASTER PROMPT token file exists in the repo — `web-next/css/tokens.css` (seeded
   from `docs/frontend-rebuild/reference-board.html` + screenshots) IS the token source now.

## Phase 2A findings (2026-09-04)

7. Vendor libs: `web-next/vendor/marked.min.js` (12.0.0, UMD global `marked`) +
   `purify.min.js` (DOMPurify 3.1.6, UMD factory — `window.DOMPurify.sanitize`
   works directly in-browser) were fetched via WebFetch because the shell has no
   external network. The fetched marked copy had ne→w corruptions (Lexer refs)
   plus a swapped d/x helper pair — repaired locally and verified with a 25-case
   battery in node + live XSS strip test in-browser. If vendor files are ever
   re-downloaded, re-run: `node --check`, `marked.parse` battery (bold/code/fence/
   table/link/list/blockquote), and the purify `<img onerror>` + `javascript:` test.
8. Provider free tier (`gpt-5.6-sol:free` via uno-router) is rate-limited (429/503,
   40–95s rounds). Live tool-call streaming + file creation could NOT be verified
   in EITHER UI — old-UI transcript for the same prompt shows 0 tool calls with
   `stoppedReason: provider-rate-limited`. Re-verify when quota resets or a paid/
   nvidia model is active. Do NOT "fix" the client for this — transcripts prove
   the client pipeline (history/steps/final/stop) is correct.
9. Test loads trip the 60 req/min limiter (no-store assets ≈20/load). Space
   Playwright navigations ≥45s apart or restart the server between stages.
10. Leaving a thread route destroys its controller and aborts the fetch (main.js
    teardownThread). Live re-attach stays out of scope; history shows a
    "run in progress" note when `activeRunId` is set.

## Phase 3 findings (hidden features — no backend, never faked)

11. Header "Open in Explorer / VS Code": NO open/reveal route exists — both
    hidden; only "Copy path" shows. The browser must never shell out.
12. Effort/reasoning-level submenu: NO such setting exists (config has
    temperature/maxTokens but neo never surfaces them) — omitted entirely.
13. "@" file search: NO dedicated endpoint. GET /api/fs/browse
    (server.js:1981) returns FOLDERS ONLY (workspace-store.js:185-217).
    /next lists files via POST /api/tools/run list tools
    (list_computer_directory → list_directory → list) with graceful fallback
    to folders-only when the tool call fails.
14. Workspace picker drive dropdown: NO roots/drives endpoint — typing "D:\"
    works (browse validates existence); no dropdown faked.
15. Approval countdowns: RESOLVED (4B.1) — records carry `expiresAt`
    (createdAt + 30-min TTL, `APPROVAL_TTL_MS` in gateway-store.js) and
    `caps.approvalToolTimeoutMs` (5 min); UI shows the shorter. Question
    countdowns still use arrival + tool timeout (no server question list).
16. "Allow for session": NO scope semantics (decision stored as free string,
    gateway-store.js:475-495) — Allow/Deny only.
17. History approval/question cards: approval/question records live in the
    gateway store, NOT the session transcript — history never renders live
    cards, only resolved step rows when present.

## Phase 3.5 lesson (provider-restore rule)

18. Provider-switch tests must snapshot/restore the FULL provider block
    (label/baseUrl/model/apiKeyProviderId/mode) — restoring only
    `{provider:{model}}` leaves a stale endpoint behind, and
    applyProviderProfile copies the profile wholesale but never clears a
    stale custom `label` (built-in profiles carry no label field).
    POST /api/config cannot write `label` (update_runtime_settings whitelist,
    customization-engine.js:11-80) — the only writers are profile save+apply.
    Incident: a tmp profile apply left label "tmp-verify-z" + bogus URL;
    repaired via applyProfile(nvidia) + setModel + one-field disk fix.
