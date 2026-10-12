#!/usr/bin/env node
// Smoke test for browser remote control (CDP against the user's real browser).
//
// Two modes:
//   node scripts/browser-remote-smoke.mjs          offline checks only
//   node scripts/browser-remote-smoke.mjs --live   also drive a real Chrome
//
// Live mode needs a browser on the debug port — run browser_remote_launch, or
// the Launch button in the My Browser pane. It creates its OWN tab, works only
// in that tab, and closes it — it never touches the user's existing tabs.

import fs from "node:fs";
import { createBrowserRemoteTools, BROWSER_REMOTE_TOOL_IDS } from "../src/core/browser-remote-tools.js";
import BrowserRemoteControl from "../src/core/browser-remote-control.js";
import { publishBrowserAction, onBrowserAction, recentBrowserActions } from "../src/core/browser-activity-bus.js";
import { findBrowser, debugProfileDir, browserLaunchStatus } from "../src/core/browser-launcher.js";

const LIVE = process.argv.includes("--live");
const PORT = Number(process.env.CDP_PORT || 9222);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

console.log("browser-remote smoke\n");
console.log("offline checks");

const tools = createBrowserRemoteTools();
check("tools build", Object.keys(tools).length === 11, `${Object.keys(tools).length} tools`);
check("agents can start the browser themselves", typeof tools.browser_remote_launch?.run === "function");
check(
  "id list matches implementation",
  BROWSER_REMOTE_TOOL_IDS.length === Object.keys(tools).length &&
    BROWSER_REMOTE_TOOL_IDS.every((id) => tools[id])
);
check(
  "every tool has description + run + browser permission",
  Object.values(tools).every(
    (t) => t.description && typeof t.run === "function" && t.permission === "allowBrowserControl"
  )
);
check(
  "required params declared",
  tools.browser_remote_fill_form.schema.required.includes("fields") &&
    tools.browser_remote_type.schema.required.includes("selector") &&
    tools.browser_remote_navigate.schema.required.includes("url")
);
check(
  "click takes selector OR a point, so neither is schema-required",
  !tools.browser_remote_click.schema.required &&
    tools.browser_remote_click.schema.properties.x &&
    tools.browser_remote_click.schema.properties.selector
);

// Argument validation must reject before any network call, so a malformed call
// returns a usable message instead of a connection error.
const noSelector = await tools.browser_remote_click.run({ selector: "" });
check("click without selector is rejected", Boolean(noSelector.error), noSelector.error?.slice(0, 60));
const noFields = await tools.browser_remote_fill_form.run({ fields: [] });
check("fill_form with no fields is rejected", Boolean(noFields.error), noFields.error?.slice(0, 60));
const noScript = await tools.browser_remote_evaluate.run({ script: "   " });
check("evaluate with blank script is rejected", Boolean(noScript.error));

// A dead port must produce the actionable launch hint, not a raw stack.
const dead = await tools.browser_remote_connect.run({ host: "127.0.0.1", port: 1 });
check("unreachable port yields hint", Boolean(dead.error && dead.hint), dead.hint ? "hint present" : "NO HINT");
// Chrome 136+ IGNORES --remote-debugging-port on the default profile, so a hint
// telling the user to add that flag is advice that can never work.
check(
  "hint points at the launcher, not the impossible chrome flag",
  /browser_remote_launch/.test(dead.hint || "") && !/--remote-debugging-port/.test(dead.hint || ""),
  dead.hint?.slice(0, 80)
);

// ── Launcher ────────────────────────────────────────────────────────────────
const launchStatus = await browserLaunchStatus({ host: "127.0.0.1", port: 1 });
check("launch status reports a closed port without throwing", launchStatus.portOpen === false);
check("launch status names a browser it can start", launchStatus.canLaunch === Boolean(launchStatus.browserPath));
const found = findBrowser();
check("a Chromium browser was located", Boolean(found?.path), found?.name || "none found");
check(
  "the debug profile is a DEDICATED dir, never the user's real one",
  Boolean(found) && /OmniClaw/i.test(debugProfileDir(found.name)) && !/User Data\\Default$/i.test(debugProfileDir(found.name)),
  found ? debugProfileDir(found.name) : "-"
);
// The dedicated profile means a one-time sign-in. The shortcut — cloning the
// real profile's Cookies / "Login Data" / Local State key — is exactly what
// Chrome's hardening exists to stop, so the launcher must never grow it back.
const launcherSource = fs.readFileSync(new URL("../src/core/browser-launcher.js", import.meta.url), "utf8");
check(
  "launcher never copies anything out of the user's real profile",
  !/copyFileSync|cpSync|createReadStream|copyFile\(/.test(launcherSource)
);
const writes = [...launcherSource.matchAll(/fs\.(writeFileSync|mkdirSync|rmSync)\(([^)]*)\)/g)];
check(
  "the only thing it writes is inside its own debug profile",
  writes.every((m) => /profile/i.test(m[2])),
  writes.map((m) => m[2].slice(0, 40)).join(" | ") || "no writes"
);

// ── Action bus (what draws the agent's cursor) ──────────────────────────────
const seen = [];
const unsubscribe = onBrowserAction((a) => seen.push(a));
publishBrowserAction({ type: "click", actor: "agent", x: 12, y: 34, label: "click #go" });
publishBrowserAction({ type: "type", actor: "agent", x: 1, y: 2, text: "hunter2", secret: true });
unsubscribe();
publishBrowserAction({ type: "click", actor: "agent", x: 0, y: 0 });
check("subscribers receive actions with coordinates", seen[0]?.x === 12 && seen[0]?.y === 34);
check("passwords are masked before they ever leave the bus", seen[1]?.text && !seen[1].text.includes("hunter2"), seen[1]?.text);
check("unsubscribe actually detaches", seen.length === 2);
check("recent actions replay for a panel opened mid-task", recentBrowserActions(5).length >= 2);

// ── Screencast (the live video itself) ──────────────────────────────────────
const controlSource = fs.readFileSync(new URL("../src/core/browser-remote-control.js", import.meta.url), "utf8");
check("client exposes a screencast", typeof BrowserRemoteControl.prototype.startScreencast === "function");
check(
  "every frame is acked, or Chrome sends exactly one and stops",
  /Page\.screencastFrameAck/.test(controlSource)
);
check(
  "the tab is brought to front first — background tabs emit no frames",
  /Page\.bringToFront/.test(controlSource)
);

const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const liveRoute = serverSource.slice(serverSource.indexOf('pathname === "/api/browser/live"'), serverSource.indexOf('pathname === "/api/browser/launch-status"'));
check("gateway streams frames + actions over SSE", liveRoute.length > 200 && /startScreencast/.test(liveRoute) && /onBrowserAction/.test(liveRoute));
check("the stream is torn down when the panel closes", /req\.on\("close", cleanup\)/.test(liveRoute) && /res\.on\("close", cleanup\)/.test(liveRoute));

// ── UI wiring (the "My Browser" dock pane in the real vanilla-JS shell) ──────
// The panel is plain DOM, so the only thing that can silently rot is an id
// getting renamed on one side. Cheap to check, and it caught nothing being
// mounted at all the first time round.
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../public/neo.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/neo.css", import.meta.url), "utf8");

check("dock has a My Browser tab and pane", /data-tab="mybrowser"/.test(html) && /id="pane-mybrowser"/.test(html));
check("dock is resizable", /id="dock-grip"/.test(html) && /\.dock-grip/.test(css) && /pointerdown/.test(js));

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = [...new Set([...js.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]))];
const missingIds = jsIds.filter((id) => !htmlIds.has(id));
check("every id neo.js queries exists in index.html", missingIds.length === 0, missingIds.join(", "));

// The single most damaging regression available here: browser_remote_state
// DRAINS the user-navigation log. If the panel ever calls it, the agent stops
// being told the user moved the tab — silently.
const panelBody = js.slice(js.indexOf("// ─── My Browser"), js.indexOf("// ─── Boot"));
check(
  "panel never calls browser_remote_state (it would drain the user-activity log)",
  panelBody.length > 1000 && !panelBody.includes('runTool("browser_remote_state')
);
check(
  "panel drives the same tools as the agent, via /api/tools/run",
  /\/api\/tools\/run/.test(js) && /browser_remote_launch/.test(js) && /browser_remote_click/.test(js)
);

// The whole point of the rewrite: pushed frames, not a screenshot slideshow.
check("panel streams live frames instead of polling screenshots", /new EventSource\(`\/api\/browser\/live/.test(js));
check("no polling loop survives", !/setInterval\(mbTick/.test(js) && !/browser_remote_screenshot/.test(panelBody));
check("frames are rendered as they arrive", /msg\.type === "frame"/.test(panelBody) && /data:image\/jpeg;base64/.test(panelBody));
check(
  "the agent's synthetic cursor is drawn from the action feed",
  /id="mb-cursor"/.test(html) && /mbShowCursor/.test(panelBody) && /\.mb-cursor/.test(css)
);
check("a click ripples so the user can see it land", /clicking/.test(panelBody) && /mb-ripple/.test(css));
check("panel can follow the agent into a new tab", /id="mb-follow"/.test(html) && /mb-follow/.test(panelBody));
check("one-click launch is wired", /id="mb-launch-btn"/.test(html) && /mbLaunch/.test(panelBody));
check(
  "click-through maps through screencast metadata (CSS px), no dpr maths",
  /meta\.deviceWidth/.test(panelBody) && !/viewport\.dpr/.test(panelBody)
);
check(
  "setup text no longer tells the user to add a flag Chrome ignores",
  !/--remote-debugging-port/.test(html)
);
// The user's own Chrome is the POINT of this pane: a separate profile has none
// of their logins. Route 1 must be the visible default, and the panel must wait
// for the toggle rather than dead-ending on a Connect button.
check(
  "the pane leads with the chrome://inspect route into the user's own Chrome",
  /chrome:\/\/inspect\/#remote-debugging/.test(html) && /id="mb-steps"/.test(html)
);
check(
  "it polls for the port so flipping the toggle connects hands-free",
  /mbWatch/.test(panelBody) && /id="mb-autowatch"/.test(html)
);
check(
  "the live view says WHOSE browser is on screen",
  /id="mb-profile"/.test(html) && /mbShowProfile/.test(panelBody)
);
check(
  "the separate-profile launch is demoted to a fallback, and says logins are missing",
  /mb-route-alt/.test(html) && /id="mb-launch-btn"/.test(html)
);

// ── The regular browser_* tools must prefer the user's own browser too ──────
// browser_open/click/screenshot/automate are what actually test a site or a
// game, so they attach over CDP when the debug port is open and fall back to
// launching Playwright when it is not.
const { BrowserPlaywright, configureRealBrowser } = await import("../src/core/browser-playwright.js");
const bp = new BrowserPlaywright({ rootDir: process.cwd() });

configureRealBrowser({ mode: "auto", host: "127.0.0.1", port: 1 });
const offStatus = await bp.realBrowserStatus();
check("dead debug port reports not-reachable with a launch hint", offStatus.reachable === false && Boolean(offStatus.hint));

configureRealBrowser({ mode: "off" });
const disabled = await bp.realBrowserStatus();
check("mode 'off' opts out entirely", disabled.mode === "off" && disabled.inUse === false && !disabled.hint);

configureRealBrowser({ mode: "always", host: "127.0.0.1", port: 1 });
const strict = await bp.open({ url: "https://example.com", sessionId: "smoke-strict" });
check(
  "mode 'always' refuses to silently launch a different browser",
  Boolean(strict.error) && /debug port|attach to your browser/i.test(strict.error),
  strict.error?.slice(0, 70)
);

// Never leave the module pointing at a dead port for the live section below.
configureRealBrowser({ mode: "auto", host: "localhost", port: PORT });

const bpSource = fs.readFileSync(new URL("../src/core/browser-playwright.js", import.meta.url), "utf8");
const closeBody = bpSource.slice(bpSource.indexOf("async function closeSession"), bpSource.indexOf("export class BrowserPlaywright"));
check(
  "closeSession never closes a browser we did not launch",
  /if \(!session\.overCDP\)/.test(closeBody) && /browser\?\.close/.test(closeBody)
);
check(
  "attaching reuses the real default context, so the user's logins survive",
  /browser\.contexts\(\)\[0\]/.test(bpSource)
);
// Playwright serialises a callback with fn.toString(), which returns nothing
// usable inside the packaged pkg snapshot: every function-form evaluate works
// from source and silently returns null from the exe. Strings only.
const callbackEvals = [...bpSource.matchAll(/\.(?:\$\$?eval|evaluate|evaluateHandle|waitForFunction)\(\s*(?:[^,)]+,\s*)?(\([^)]*\)\s*=>|function\s*\()/g)];
check(
  "page evaluation always passes a string, never a callback (pkg breaks toString)",
  callbackEvals.length === 0,
  callbackEvals.map((m) => m[0].slice(0, 40)).join(" | ")
);

if (!LIVE) {
  console.log(`\n${pass} passed, ${fail} failed  (offline only — pass --live to drive real Chrome)`);
  process.exit(fail ? 1 : 0);
}

console.log(`\nlive checks (port ${PORT})`);

const client = new BrowserRemoteControl("localhost", PORT);
let createdTargetId = null;

try {
  const version = await client.version();
  check("connect to browser", true, version["Browser"]);
} catch (error) {
  console.log(` FAIL  connect to browser — ${error.message}`);
  console.log("\nStart one with the Launch button in the My Browser pane, or:");
  console.log("  node -e \"import('./src/core/browser-launcher.js').then(m => m.launchDebugBrowser({}))\"");
  console.log("(Chrome 136+ ignores --remote-debugging-port on your default profile,");
  console.log(" so the launcher uses a dedicated OmniClaw profile instead.)");
  process.exit(1);
}

try {
  // Own tab, so the user's tabs are never touched.
  const created = await client.newTab("about:blank");
  createdTargetId = created?.id || null;
  check("create test tab", Boolean(createdTargetId));
} catch (error) {
  check("create test tab", false, error.message);
}

if (createdTargetId) {
  try {
    await client.attachTab(createdTargetId);
    check("attach tab", true);

    const nav = await tools.browser_remote_navigate.run({
      tabId: createdTargetId,
      url: "data:text/html,<title>Smoke</title><input id=a><input id=b><button id=go onclick=\"document.title='clicked'\">Go</button>",
    });
    check("navigate", !nav.error && nav.readyState === "complete", nav.error || `readyState=${nav.readyState}`);

    const state = await tools.browser_remote_state.run({ tabId: createdTargetId });
    check("read page state", !state.error && state.elements.length === 3, state.error || `${state.elements?.length} elements`);
    check(
      "agent's own navigation is recorded and attributed to the agent",
      state.activity?.some((a) => a.type === "navigated" && a.by === "agent"),
      JSON.stringify(state.activity?.map((a) => a.by))
    );
    check("agent navigation does not set userNavigated", state.userNavigated === false);

    const filled = await tools.browser_remote_fill_form.run({
      tabId: createdTargetId,
      fields: [
        { selector: "#a", value: "hello@example.com" },
        { selector: "#b", value: "नमस्ते 🎉" }, // non-ASCII: insertText, not per-char
      ],
    });
    check("fill form", filled.filled === 2, filled.error || `${filled.filled}/2`);
    check(
      "filled values read back correctly",
      filled.results?.every((r) => r.matched === true),
      JSON.stringify(filled.results?.map((r) => r.actual))
    );

    const clicked = await tools.browser_remote_click.run({ tabId: createdTargetId, selector: "#go" });
    check("click", !clicked.error, clicked.error);

    const title = await tools.browser_remote_evaluate.run({ tabId: createdTargetId, script: "document.title" });
    check("click had a real effect", title.result === "clicked", `title=${title.result}`);

    const shot = await tools.browser_remote_screenshot.run({ tabId: createdTargetId });
    check("screenshot to disk", !shot.error && shot.bytes > 1000, shot.error || `${shot.bytes} bytes`);
    check("screenshot not inlined as base64", !JSON.stringify(shot).includes("data:image"));

    const missing = await tools.browser_remote_click.run({ tabId: createdTargetId, selector: "#nope" });
    check("missing element errors clearly", Boolean(missing.error), missing.error?.slice(0, 50));

    // The live-view panel needs the inline data URL AND the viewport metrics to
    // map a click on the <img> back to a viewport coordinate.
    const inline = await tools.browser_remote_screenshot.run({ tabId: createdTargetId, inline: true });
    check("inline screenshot returns data URL", inline.dataUrl?.startsWith("data:image/png;base64,"));
    check("inline screenshot returns viewport + dpr", inline.viewport?.w > 0 && inline.viewport?.dpr > 0,
      JSON.stringify(inline.viewport));

    // Click-through: aim at the button's real centre and confirm it fired.
    await tools.browser_remote_evaluate.run({ tabId: createdTargetId, script: "document.title='reset', 1" });
    const box = await tools.browser_remote_evaluate.run({
      tabId: createdTargetId,
      script: "(() => { const r = document.querySelector('#go').getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()",
    });
    const byPoint = await tools.browser_remote_click.run({ tabId: createdTargetId, x: box.result.x, y: box.result.y });
    check("click by coordinates", !byPoint.error, byPoint.error);
    const afterPoint = await tools.browser_remote_evaluate.run({ tabId: createdTargetId, script: "document.title" });
    check("coordinate click hit the button", afterPoint.result === "clicked", `title=${afterPoint.result}`);

    const noTarget = await tools.browser_remote_click.run({ tabId: createdTargetId });
    check("click with neither selector nor point is rejected", Boolean(noTarget.error));

    // ── The live view, end to end ──────────────────────────────────────────
    // A screenshot poll could never show the agent's pointer: CDP dispatches
    // SYNTHETIC input, so no real cursor exists in the pixels. Frames come from
    // Chrome; the pointer comes from the action bus. Both have to work.
    const frames = [];
    const stop = await client.startScreencast(createdTargetId, { quality: 40, maxWidth: 640 }, (frame) => frames.push(frame));
    // Nudge the page so it definitely repaints — a static page emits nothing.
    await tools.browser_remote_evaluate.run({
      tabId: createdTargetId,
      script: "document.body.style.background = '#0af', 1",
    });
    await new Promise((r) => setTimeout(r, 1500));
    check("screencast pushes frames", frames.length > 0, `${frames.length} frame(s)`);
    check("frames carry base64 JPEG data", typeof frames[0]?.data === "string" && frames[0].data.length > 500);
    check(
      "metadata gives the viewport in CSS pixels, so click-through needs no dpr maths",
      frames[0]?.metadata?.deviceWidth > 0 && frames[0]?.metadata?.deviceHeight > 0,
      JSON.stringify(frames[0]?.metadata)
    );

    const liveActions = [];
    const offBus = onBrowserAction((a) => liveActions.push(a));
    await tools.browser_remote_click.run({ tabId: createdTargetId, selector: "#go", actor: "agent" });
    offBus();
    const clickAction = liveActions.find((a) => a.type === "click");
    check("a real tool call reaches the cursor feed", Boolean(clickAction), `${liveActions.length} action(s)`);
    check(
      "with coordinates the panel can actually draw",
      Number.isFinite(clickAction?.x) && Number.isFinite(clickAction?.y),
      clickAction ? `(${clickAction.x}, ${clickAction.y})` : "-"
    );

    await stop();
    const afterStop = frames.length;
    await tools.browser_remote_evaluate.run({ tabId: createdTargetId, script: "document.body.style.background = '#fa0', 1" });
    await new Promise((r) => setTimeout(r, 700));
    check("stopping the stream really stops it", frames.length === afterStop, `${afterStop} -> ${frames.length}`);

    // Selector containing quotes/backslashes must not break the injected JS.
    const tricky = await tools.browser_remote_evaluate.run({
      tabId: createdTargetId,
      script: 'document.querySelectorAll("input").length',
    });
    check("evaluate returns value", tricky.result === 2, `got ${tricky.result}`);

    // Simulate the human driving the tab. Chrome BLOCKS script-initiated
    // top-level navigation to data: URLs, so this must target a real scheme —
    // about:blank behaves like the click the user would have made.
    await tools.browser_remote_evaluate.run({
      tabId: createdTargetId,
      script: "location.assign('about:blank'), 1",
    });
    await new Promise((r) => setTimeout(r, 900));
    const afterUserNav = await tools.browser_remote_state.run({ tabId: createdTargetId });
    check("user navigation detected", afterUserNav.userNavigated === true, `activity=${JSON.stringify(afterUserNav.activity?.map((a) => a.by))}`);
    check("state message warns about stale selectors", /user navigated/i.test(afterUserNav.message || ""));
    // Draining must be idempotent, or every later call re-warns about the same move.
    const afterDrain = await tools.browser_remote_state.run({ tabId: createdTargetId });
    check("activity drains once", afterDrain.userNavigated === false);
  } catch (error) {
    check("live sequence", false, error.message);
  }

  try {
    await client.closeTab(createdTargetId);
    check("cleanup test tab", true);
  } catch (error) {
    check("cleanup test tab", false, error.message);
  }
}

// ── browser_* (the tools that test sites and games) in the user's browser ────
try {
  configureRealBrowser({ mode: "always", host: "localhost", port: PORT });
  const status = await bp.realBrowserStatus();
  check("browser_* sees the real browser as reachable", status.reachable === true && status.inUse === true);

  const before = (await client.listTabs()).length;
  const opened = await bp.open({
    url: "data:text/html,<title>Game</title><h1>hello</h1><p>a paragraph so the render probe is happy</p>",
    sessionId: "smoke-real",
  });
  check("browser_open attaches instead of launching", opened.browserTarget === "user", opened.error || opened.browserTarget);
  check("browser_open says so in its message", /USER'S OWN browser/.test(opened.message || ""));

  const after = (await client.listTabs()).length;
  check("it opened a tab in the user's actual browser", after === before + 1, `${before} -> ${after}`);

  const shot = await bp.screenshot({ sessionId: "smoke-real" });
  check("browser_screenshot works on a background tab", !shot.error && fs.existsSync(shot.screenshotPath), shot.error);

  const sessions = bp.listSessions();
  check("listSessions reports the target", sessions.some((s) => s.id === "smoke-real" && s.browserTarget === "user"));

  await bp.close({ sessionId: "smoke-real" });
  // The whole point: our tab goes, the user's browser and their other tabs stay.
  const survived = await client.version().then(() => true).catch(() => false);
  check("closing our session does NOT quit the user's browser", survived);
  check("only our tab was closed", (await client.listTabs()).length === before, `back to ${before}?`);
} catch (error) {
  check("browser_* over CDP", false, error.message);
}

await tools.browser_remote_disconnect.run({});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
