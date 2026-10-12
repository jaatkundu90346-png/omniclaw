# BROWSER_PLAN — Codex-like browser for /next/ (Step 1 discovery, no code changed)

> IMPLEMENTED in 4B.2 (server.js managed block + tests/api/browser-managed.test.mjs).
> Deltas from plan: tab `active`/`attached` returned (no separate activate flag);
> stream adds a `type:"ready"` envelope (frames carry `jpegBase64`); input takes
> `cssX/cssY + frameW/frameH` (server scales via viewport); navigate also
> accepts bare hosts (https:// prefixed); `OMNICLAW_BROWSER_PORT` isolates the
> managed port per instance; `OMNICLAW_NO_BROWSER=1` simulates absence.
> Original discovery below — kept as architecture record.

> Read-only findings against the working tree. All new routes are ADDITIVE,
> loopback-only, `{error, code}` errors (R12); every route gets a
> `tests/api/*.test.mjs` smoke test (R13). No code changed in this phase.

## 1. What exists today (file:line)

- CDP client: `src/core/browser-remote-control.js` — raw WebSocket CDP, no
  puppeteer-core (`CDPSession`, :68; raw ws handshake in
  `src/core/browser-launcher.js:133-171`). A separate Playwright path
  (`src/core/browser-playwright.js`, dynamic-import w/ static fallback :37-60)
  backs the Hermes `browser_*` tools; the remote tools below use raw CDP.
- Launch: `launchDebugBrowser` (`browser-launcher.js:203`) — binary lookup
  Chrome/Edge/Brave (`candidateBrowsers`, :38-74); PERSISTENT profile
  `%LOCALAPPDATA%/OmniClaw/<browser>-debug-profile` (`debugProfileDir`, :93-96);
  flags `--remote-debugging-port / --user-data-dir / --remote-allow-origins=* /
  --no-first-run` (:249-260); headed visible window (`windowsHide:false`, :262);
  reuses a listener if present (:212-220), incl. the user's own
  `chrome://inspect` profile (:224-233). Logins survive relaunch. Never touches
  the user's default profile dir.
- Agent tools (via `POST /api/tools/run`, NOT HTTP routes):
  `browser_remote_{connect,launch,list_tabs,state,screenshot,click,type,
  fill_form,evaluate,navigate,disconnect}` (`browser-remote-tools.js:113-577`).
- HTTP routes: `GET /api/browser/live` (SSE `ready` + replay-8 `action` + live
  `action|frame` via multiplexed `Page.startScreencast`, `server.js:3139-3212`);
  `GET /api/browser/launch-status` (`server.js:3216-3226`). No HTTP routes for
  connect/disconnect/navigate/click/type/tabs — tools only.
- Sharing: `acquireLiveTab` reuses the SAME cached client + current tab as the
  tools (`browser-remote-tools.js:594-606`); agent actions publish to the
  activity bus (`publishBrowserAction`, e.g. `:558,:697,:724`) which the live
  view replays/streams. Agent and UI are already one instance.
- Current `/next/` tab (`web-next/js/panel/browser.js`, 204 lines): host/port +
  Connect/Disconnect, URL-bar navigate, static `tool.screenshot` frame. No tab
  strip, no input forwarding, no agent overlay.

## 2. CDP capability audit (`browser-remote-control.js`)

| Capability | Verdict | Evidence |
|---|---|---|
| List targets/tabs (`Target.getTargets`) | EXISTS | `listTabs`, :410-423 (ws + http paths) |
| Attach to a specific tab | EXISTS | `attachTab`/`attachFlat`/`attachOwnSocket`, :464-527 |
| `Page.startScreencast` (jpeg, multiplexed viewers) | EXISTS | :746-797 (q/maxW/maxH/everyNthFrame, ack loop) |
| `Page.captureScreenshot` | EXISTS | :563-573 |
| `Input.dispatchMouseEvent` (move/press/release) | EXISTS | `click` :660-699, `clickAt` :706-726 |
| Text input (`Input.insertText`) | EXISTS | `type` :810-847 (no per-key events) |
| Raw `Input.dispatchKeyEvent` / wheel | EASY TO ADD | no `dispatchKeyEvent`/wheel sends; session.send passthrough exists |
| `Page.navigate` | EXISTS | :545-560 (agent/user attribution) |
| Create tab (`Target.createTarget`) | EXISTS | `newTab`, :442-449 |
| Close tab (`Target.closeTarget`) | EXISTS | `closeTab`, :451-462 |
| Activate / bring-to-front | EXISTS | `bringToFront`, :729-733 |
| Back / forward / reload (remote stack) | EASY TO ADD | only Playwright has goBack/goForward (`browser-playwright.js:1346-1369`); add via `Page.getNavigationHistory`+traverse or `Runtime.evaluate(history.back())` |
| Favicons | EASY | `getPageState` returns `favicon` (:653) from tab record; populate from CDP `Page.getResourceTree` or `Target.getTargets` extra fields |
| Keyboard focus ring / Esc handling | UI-only | no backend needed |

## 3. Proposed additive routes (all loopback-only via `isLoopback`)

Shapes mirror the existing tools; no tool changes required (thin wrappers over
`browser-remote-control.js` + `browser-launcher.js`).

- `POST /api/browser/launch {}` → launches (or reuses) managed Chrome on the
  persistent profile. Returns `{port, wsUrl, tabs, alreadyRunning, profileDir,
  signedIn}`. Reuse-first (`isPortOpen` → return, like `:212-220`).
- `GET /api/browser/tabs` → `{tabs:[{id,title,url,favicon,active}]}` (from
  `listTabs` + `getPageState` favicon; `active` = last attached tab id).
- `POST /api/browser/tabs {url?}` → create (+ optional navigate);
  `{tab:{id,title,url}}`. `POST /api/browser/tabs/:id/activate` (bringToFront,
  best-effort OS window raise) and `.../close` (detach + closeTarget).
- `POST /api/browser/tabs/:id/navigate {url}` · `/back` · `/forward` ·
  `/reload` → `{ok,url,title,readyState}` (navigate polls readyState like
  `browser_remote_navigate`, `:523-533`).
- `GET /api/browser/tabs/:id/stream` (SSE frames via the existing multiplexed
  `startScreencast`: jpeg q60, maxWidth 1280, ≤10fps via `everyNthFrame`,
  only while a client is connected — stop on close like `:3198-3199`).
  Keep `/api/browser/live` untouched (legacy).
- `POST /api/browser/tabs/:id/input {type:"mouse"|"key"|"wheel", ...}` —
  CDP-shaped fields scaled client→device px using `viewport()` (:800-808):
  mouse → `clickAt`/move; key → `dispatchKeyEvent` (new, raw+`insertText`
  fallback for text); wheel → `dispatchMouseEvent mouseWheel`.
- `GET /api/browser/status` → `{running, profileDir, tabsCount,
  chromeVersion}` (from `browserLaunchStatus` + `version()`).

Agent actions already surface in the same view: every agent CDP op publishes
`action` events consumed by `/live` and the new `/stream` (same
`onBrowserAction` fan-out). No extra work.

## 4. Limits (R12)

Loopback-only; URL validation (http/https/file allow-list, block
`devtools://`); input coordinate clamping to viewport; screencast stops with
last viewer; launch refuses non-loopback hosts; errors `{error, code:
EINVAL|EPERM|ENOENT|EUNREACHABLE}`; Chrome-absent → `503 EUNREACHABLE` with the
install hint (`browser-launcher.js:236-240`), never a fake frame (R1).

## 5. Tests plan (R13, Chrome-absent CI → skip-with-reason)

`tests/api/browser-tabs.test.mjs` (+ launch/status/stream/input) against the
test instance (`npm run dev:test`, PORT=3199): launch→tabs→navigate→input→
stream-headers→close→status; each test probes the port first and
`t.skip("no Chrome")` when absent. `npm test` stays 39/39 + new files green.

**STOP — waiting for "go" for 4B.2/4B.3.**
