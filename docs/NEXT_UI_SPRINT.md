# Next UI Work Block (2026-09-08 brief: /next → connected AI coding workspace)

## Audit (verified by reading code, not inferred)
- Frontend: vanilla JS ESM in `web-next/` ("Next" is a folder name, not Next.js).
  Legacy UIs in `public/` (neo, classic) untouched. Boot: `web-next/js/main.js`,
  chat: `ui/thread.js` + `sse.js` (POST /api/chat/stream envelope
  start→event→final→done), composer `ui/composer.js`, sidebar `ui/sidebar.js`.
- Backend: raw `node:http` `server.js`. Real routes already exist for
  `/api/chat/stream`, `/api/sessions`, `/api/models`, `/api/provider/*`,
  `/api/apps` (OAuth config/start/callback/disconnect/computer-use),
  `/api/git/*` (status/diff/stage/unstage/revert — NO commit/push),
  `/api/fs/*`, `/api/tools`, `/api/capabilities`, `/api/events`, managed
  `/api/browser/*`. Agent loop `src/core/omni-loop.js`; context V2 budget
  28k chars (`context-budget.js`); progressive tool menu CORE+toolsets
  (`tool-layers.js`, `enable_toolset`, per-session pins); skills top-5.
- OAuth core real: `src/core/app-connections.js` (GitHub + Gmail, state-token
  validation, server-side secrets via SecretStore, least-privilege defaults
  gmail.readonly / read:user+repo, refresh for Gmail). Neo UI (`public/neo.js`)
  already drives it; **`/next` `#/plugins` is still a placeholder** (root cause).
- Changes: panel `review.js` is real git status/diff/stage/unstage/revert with
  confirm on revert; but `#/changes` only opens the side-panel tab, no page,
  no commit route.

## Sequence (WIP=1, vertical slices)
1. DONE — chat/composer reliability + sidebar/welcome (frontend only).
2. DONE — real `/next` Plugins page on existing `/api/apps` (frontend only,
   verified with `scripts/next-plugins-smoke.mjs` against mocked APIs).
3. DONE — model picker fix + unified all-providers picker (frontend only).
   Diagnosis: popover measured pre-load height, opened below, never
   repositioned (clipping); backend routing already correct (fresh provider
   per message from persisted config, honest per-attempt events) — the gaps
   were single-provider scope, unverified apply, silent in-flight pin and
   subtle fallback attribution. Real bug found+fixed: applyProfile restores
   the profile's SAVED model, so profile rows now applyProfile+setModel.
   Verified: `next-picker-view/apply/state-smoke.mjs` (all PASS, mocked).
4. DONE — three-job split: slim picker (search + ONE provider dropdown,
   favorites, info details, visibility, atomic select) + Manage-models dialog
   (toggles, manual IDs, hidden-active guard) + Connect flow (catalog →
   configure → result, apply:false saves). Providers page upgraded (honest
   auth labels, In-use vs healthy, discovery summaries, Manage/Add). Settings
   routes hide the composer; active runs preserved via re-attach.
   Root-cause correction: api.js getConfig dropped top-level providerSecrets,
   so the UI believed NO keys existed (user has 16) — merged; eligibility now
   per adapter (stored/env/keyless-local/CLI/builtin). Boot race fixed
   (picker self-loads config; pill shows Loading).
   Verified: picker view/apply/state + manage smokes (all PASS, mocked) +
   LIVE: picker shows 1639 real models, 7 screenshots, zero page errors.
5. DONE — Appearance page (scheme cards, 6 presets, contrast, opacity,
   fonts+sizes, local previews, wrap toggles, reset; versioned prefs +
   invalid recovery). Verified: next-appearance-smoke PASS + live shots.
6. DEFERRED — Changes page + additive POST /api/git/commit (user priority).
7. NEXT — final regression (npm test in chunks: all green) + handoff.

## Standing rules
- R11: never touch live `:3147` config/sessions in tests (isolated host/mocks).
- R12: backend additive only; R13: new routes get `tests/api/*.test.mjs`.
- R14: one verification run per change; small scripts ≤25s with cleanup.
- Never claim parity/paid-provider verification without real credentials.
