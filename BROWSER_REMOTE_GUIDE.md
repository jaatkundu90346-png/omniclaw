# Browser Remote Control

Lets OmniClaw agents drive **the browser you already use** — your real Chrome, your real profile, your Gmail already logged in — instead of a fresh empty Playwright browser.

You keep using the browser while the agent works. The agent can see when you navigate, and you can see and drive what the agent is doing from the side panel.

---

## Setup

Chrome only exposes its debug port at startup, so it must be **fully closed** first (check the tray — closing the window is not enough).

```bash
chrome.exe --remote-debugging-port=9222
```

Then in OmniClaw: right dock → **My Browser** → `localhost:9222` → **Connect**.

If the port does not open, Chrome was still running and simply opened a tab in the existing process. Quit it completely and retry.

> Anything that can reach port 9222 can drive your logged-in browser. Keep it on localhost; don't expose it to a network you don't trust.

---

## Tools available to agents

All ten are registered and model-callable. There is one implicit "current tab", so `tabIndex` is optional — omit it and the last-used tab is reused.

| Tool | Purpose |
|---|---|
| `browser_remote_connect` | Attach to the running browser, list tabs |
| `browser_remote_list_tabs` | Index, title, URL of each open tab |
| `browser_remote_state` | URL, title, visible text, interactive elements **with selectors** |
| `browser_remote_screenshot` | PNG saved to disk; returns the path |
| `browser_remote_click` | Click by CSS selector, or by `{x, y}` |
| `browser_remote_type` | Focus a field and type (handles emoji / Devanagari) |
| `browser_remote_fill_form` | Fill many fields, optionally submit, verify each |
| `browser_remote_evaluate` | Run JS in the page, return a value |
| `browser_remote_navigate` | Go to a URL, wait for load |
| `browser_remote_disconnect` | Close CDP sessions (browser stays open) |

The other tools auto-connect and auto-attach, so `browser_remote_connect` is only needed for discovery.

### Typical agent flow

```js
// 1. See what's on the page — never guess selectors
const state = await call("browser_remote_state");

// 2. Fill and submit in one call
const filled = await call("browser_remote_fill_form", {
  fields: [
    { selector: "#email", value: "me@example.com" },
    { selector: "#message", value: "नमस्ते 🎉" },
  ],
  submitSelector: "button[type=submit]",
});

// 3. Confirm it actually took
filled.results.forEach(r => r.matched === false && console.warn("rejected:", r.selector));
```

---

## Two things worth knowing

**Form fills are verified.** Every field is read back after typing. `matched: false` means the page reformatted or rejected the value (phone masks, validation) — the fill "succeeded" but the value is not what you asked for. Check it before assuming the form is correct.

**The agent is told when you navigate.** Every main-frame navigation is recorded and attributed to `agent` or `user`. When you move the tab yourself, the next `browser_remote_state` says so and warns that earlier selectors are stale — so the agent re-reads the page instead of clicking into a page nobody is on any more.

```
"Inbox — 42 interactive element(s), readyState=complete.
 NOTE: the user navigated this tab 1 time(s) since your last check
 (latest: https://mail.google.com/...). Selectors from before then are stale."
```

---

## The side panel

Right dock → **My Browser** tab. Drag the dock's left edge to resize it (280px to
`window − 420`); the width is remembered in `localStorage`.

- **Connect** — host/port, defaults `localhost:9222`
- **Live view** — refreshes every 1.5s; untick **Live** to freeze it, ↻ for a single frame
- **Click-through** — clicking the image dispatches a real click at that point in the page
- **Type bar** — click a field in the view, then type + Enter (`selector: ":focus"`)
- **URL bar** — Enter navigates the selected tab
- **Tab switcher** — dropdown of the open tabs

The panel calls the tools over `POST /api/tools/run`, i.e. the exact path the agent
uses — one connection, one current tab, no divergent state.

Two things the implementation depends on:

- **The poll loop screenshots; it never calls `browser_remote_state`.** `_state`
  *drains* the user-navigation log, so polling it in the UI would swallow the
  "the user moved this tab" warning before the agent ever saw it.
- Screenshots go to disk and return a path — the model never receives base64. The
  panel opts into inline bytes with `{ inline: true }`, which also returns
  `viewport {w, h, dpr}`. The PNG is in **device** pixels and CDP's Input domain
  wants **CSS** pixels, so click-through divides the dpr back out.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ECONNREFUSED` | Chrome not started with the flag, or was already running |
| "no open page tabs" | Every tab closed; open one |
| Tab has no debugger URL | A DevTools window is already attached to that tab — close it |
| `Element not found` | Selector is stale — re-run `browser_remote_state` |
| Blank screenshot | Page still loading; screenshot again |
| Script error on a real site | Site CSP; evaluation already sets `allowUnsafeEvalBlockedByCSP` but some pages still block |

---

## Verifying

```bash
node scripts/browser-remote-smoke.mjs          # offline: schemas, validation, error hints
node scripts/browser-remote-smoke.mjs --live   # drives a real Chrome on :9222
```

Live mode creates its **own** tab, works only there, and closes it — your tabs are untouched. Currently **20 offline + 52 live** checks, all passing: navigation, form fill with read-back, click by selector and by coordinate, screenshot to disk, user-vs-agent activity attribution, the dock UI wiring, and `browser_open` attaching to a real Chrome and closing its tab **without quitting the browser**.

Point it at a throwaway profile so your own Chrome is never involved:

```bash
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:/tmp/omniclaw-cdp-test
```

---

## `browser_*` uses your browser too

The regular browser tools — `browser_open`, `browser_click`, `browser_screenshot`,
`browser_snapshot`, `browser_automate`, the ones the agent uses to test a site or a
game — now **prefer your running browser** as well. If port 9222 is open they attach
to it and work in a new tab you can watch; if it is not, they launch Playwright's own
browser exactly as before. `browser_open` reports which one it used:

```json
{ "browserTarget": "user", "message": "Opened … Opened in the USER'S OWN browser …" }
```

`browser_status` tells you live: `realBrowser: { mode, host, port, reachable, inUse }`.

Configure it under `tools.browserControl.realBrowser`:

| `mode` | Behaviour |
|---|---|
| `auto` *(default)* | Use your browser when reachable, otherwise launch |
| `always` | Use your browser or **fail** with the launch hint — never silently test in a different browser |
| `off` | Always launch Playwright's own |

Three rules the implementation follows, because getting them wrong is destructive:

- It attaches to `contexts()[0]`, your **real** context — `newContext()` would have
  created a blank incognito-style profile and thrown away the logins we attached for.
- Closing a session closes **only the tab we opened**. It never closes the context
  (your cookies) or the browser (your whole session, mid-task).
- If you close our tab yourself, the next call reopens instead of failing with
  "Target page … has been closed".

So when do you still reach for `browser_remote_*`? When you want the **existing** tabs —
listing them, reading the page you already have open, or filling a form on it. `browser_*`
always works in a fresh tab of its own.

| | `browser_*` | `browser_remote_*` |
|---|---|---|
| Tab | New tab (in your browser, or a launched one) | Any tab you already have open |
| Logins | Yours, when attached | Yours |
| Falls back when Chrome has no debug port | Yes — launches Playwright | No — tells you to start it |
| Sees that *you* navigated | No | Yes |

---

## Files

```
src/core/browser-remote-control.js    CDP client over WebSocket
src/core/browser-remote-tools.js      the 10 agent tools
src/core/browser-playwright.js        browser_* attach-or-launch (acquireTarget)
public/index.html                     "My Browser" dock tab + resize grip
public/neo.js                         panel logic + dock resize (search "My Browser")
public/neo.css                        .dock-grip and .mb-* styles
scripts/browser-remote-smoke.mjs      offline + live tests
```

Registered in `src/core/tool-registry.js`: spread into `this.tools`, ids added to `CODEX_GRADE_MODEL_TOOLS` (required, or agents can't see them) and the mutating four to `SIDE_EFFECT_TOOLS`. Depends on `ws`.
