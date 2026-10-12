# PHASE4_REPORT — Right panel for /next/ (R6 report, written 2026-09-05)

> Previous session implemented Phase 4 but left no R6 report; this file
> reconstructs it honestly from the working tree. Temp Playwright probes
> (`scripts/tmp-p4a..k.mjs`, headers marked "delete after run") were deleted
> during 4B housekeeping; their screenshots are kept at
> `docs/screenshots/phase4/`. Uncommitted at time of writing.

## Files changed (new, all under `web-next/`)

- `js/ui/panel.js` (312 lines) — shell: Review/Files/Terminal/Browser/
  Walkthrough tabs, per-workspace persistence (`ocPanelTabs.v1`), shortcuts
  (Ctrl+Shift+G / E / ` / T / Alt+W mirrors), 30–60% width resize.
- `js/panel/review.js` (360) — `GET /api/git/status` grouped file list,
  `GET /api/git/diff` hunk view, stage/unstage checkbox, revert (confirm),
  stage-all/unstage-all, prev/next file, "Open in editor".
- `js/panel/files.js` (271) + `js/panel/editor.js` (325) — lazy
  `GET /api/fs/tree` explorer + debounced `GET /api/fs/search`, 8-tab editor,
  `POST /api/fs/write` with mtime optimistic lock (409 → Reload/Overwrite),
  agent-changed silent-reload-or-yellow-bar, VS Code open / Explorer reveal
  gated on `caps.systemOpen`, `beforeunload` dirty guard.
- `js/panel/terminal.js` (233) — HONEST output log only ("Terminal (agent
  output)"): `tool.exec` stream events (`oc:tool-exec`) + transcript exec
  outputs, ANSI colors, filter, copy. No pty exists (`caps.terminal=false`);
  the input box is disabled with that explanation.
- `js/panel/browser.js` (204) — port of neo My Browser: host/port Connect/
  Disconnect, URL-bar navigate, `GET /api/browser/live` SSE frames + action
  log, static `tool.screenshot` frame mode.
- `js/panel/walkthrough.js` (181) — transcript-derived markdown artifact,
  Copy as Markdown + Save to `.omniclaw/walkthroughs/<session>.md`.
- Wiring: `main.js:stepOpenToPanel` (step rows open panel tabs),
  `thread.js` emits `oc:fs-changed` / `oc:tool-exec` / `oc:run-done` /
  `oc:thread-update` local events the tabs follow (no extra connections).

## Works (evidence: `docs/screenshots/phase4/*.png`, 1366×768)

Review list+diff, Files tree+editor save, Terminal exec log, Browser live
frame, Walkthrough render — each shot shows the tab populated with zero
console errors reported by the (since deleted) probes. `npm test` 39/39 green;
`GET /api/capabilities` gates every tab (`store.js:11`, `main.js:309`).

## Missing / known gaps (→ Phase 4B)

1. Approval cards are per-thread only — no banner, no global surface. Real
   incident 2026-09-05: ask-mode exec waited 5 min unseen (`approval.timeout`,
   run `run_1788592234902_66zvar`). → 4B.1.
2. Browser tab has no tab strip, no input forwarding, no agent-activity
   overlay; host/port form sits in the main view. → 4B.3 (backend per
   `docs/BROWSER_PLAN.md` → 4B.2).
3. `approval.requested` event carries no summary/command (enrichment only via
   `GET /api/approvals`). → 4B.1 backend.
4. No live re-verify was possible in this session (provider quota); re-verify
   thread+panel end-to-end after 4B.3.

## How to verify

1. `npm test` (39/39) + `GET /api/capabilities` on `:3147`.
2. `http://localhost:3147/next/` → open a session → `+` → open each tab;
   Review shows repo files, Files edits round-trip with mtime lock, Terminal
   fills after an agent exec, Browser connects to `localhost:9222`,
   Walkthrough renders Copy/Save.
3. Compare against `docs/screenshots/phase4/` shots.
