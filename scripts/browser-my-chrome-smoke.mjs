#!/usr/bin/env node
// Smoke test for driving the USER'S OWN Chrome — the profile their accounts are
// already signed into.
//
// Chrome 136+ ignores --remote-debugging-port on the default profile, so the only
// supported way in is the chrome://inspect/#remote-debugging toggle. That endpoint
// behaves NOTHING like the classic one:
//
//   /json/version  -> 404        (no HTTP discovery at all)
//   /json/list     -> 404
//   ws://host:port/devtools/browser -> ordinary CDP
//
// So there is no per-tab socket to dial and no tab list to read: tabs come from
// Target.getTargets and pages are driven through flat sessions
// (Target.attachToTarget + a sessionId on every message).
//
// This test stands up a fake endpoint with exactly those properties — 404 on all
// HTTP, CDP on the browser socket — and checks the client copes. A regression
// here means "OmniClaw can't use my browser" comes straight back.

import http from "node:http";
import { WebSocketServer } from "ws";
import BrowserRemoteControl from "../src/core/browser-remote-control.js";
import { probeCdp, isCdpSocketOpen, browserLaunchStatus, MY_CHROME_STEPS } from "../src/core/browser-launcher.js";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ── A stand-in for Chrome's local-debugging endpoint ────────────────────────
const TARGETS = [
  { targetId: "T-mail", type: "page", title: "Inbox", url: "https://mail.google.com/", attached: false },
  { targetId: "T-devtools", type: "page", title: "DevTools", url: "devtools://devtools/bundled/x.html", attached: true },
  { targetId: "T-worker", type: "service_worker", title: "sw", url: "https://x/sw.js", attached: false },
];

const seen = { attachParams: null, flatMessages: [], created: null, closed: null };

// 404 everything, like the real thing.
const server = http.createServer((req, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});
const wss = new WebSocketServer({ server, path: "/devtools/browser" });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    const reply = (result) => socket.send(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));

    // A message carrying sessionId is aimed at a page, not the browser.
    if (msg.sessionId) {
      seen.flatMessages.push({ method: msg.method, sessionId: msg.sessionId });
      if (msg.method === "Runtime.evaluate") {
        reply({ result: { value: { ok: true, x: 12, y: 34, found: true, inView: true } } });
        return;
      }
      reply({});
      return;
    }

    switch (msg.method) {
      case "Browser.getVersion":
        reply({ product: "Chrome/146.0.0.0", protocolVersion: "1.3", userAgent: "UA" });
        return;
      case "Target.getTargets":
        reply({ targetInfos: TARGETS });
        return;
      case "Target.attachToTarget":
        seen.attachParams = msg.params;
        reply({ sessionId: `S-${msg.params.targetId}` });
        // Chrome pushes page events with the sessionId attached; the client has
        // to route them to the flat child, not to the browser session.
        setTimeout(() => socket.send(JSON.stringify({
          method: "Page.frameNavigated",
          sessionId: `S-${msg.params.targetId}`,
          params: { frame: { url: "https://mail.google.com/u/0", id: "f1" } },
        })), 10);
        return;
      case "Target.createTarget":
        seen.created = msg.params;
        reply({ targetId: "T-new" });
        return;
      case "Target.closeTarget":
        seen.closed = msg.params;
        reply({ success: true });
        return;
      case "Target.detachFromTarget":
        reply({});
        return;
      default:
        reply({});
    }
  });
});

const port = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

console.log("my-chrome (real profile over CDP) smoke\n");

// ── Detection ──────────────────────────────────────────────────────────────
const probe = await probeCdp("127.0.0.1", port);
check("a WebSocket-only CDP endpoint is detected as reachable", probe.open === true, `transport=${probe.transport}`);
check("it is reported as the ws transport, not http", probe.transport === "ws");
check("the raw socket probe agrees", (await isCdpSocketOpen("127.0.0.1", port)) === true);

const status = await browserLaunchStatus({ host: "127.0.0.1", port });
check("launch-status marks this as the user's real profile", status.portOpen === true && status.realProfile === true);
check("launch-status ships the chrome://inspect steps for the UI", Array.isArray(status.useMyChrome?.steps) && status.useMyChrome.steps.length >= 3);
check("the steps point at chrome://inspect/#remote-debugging", MY_CHROME_STEPS.url === "chrome://inspect/#remote-debugging");

// A dead port must still read as unreachable — the fallback must not turn every
// closed port into a false positive.
const dead = await probeCdp("127.0.0.1", 1, 300);
check("a dead port is still unreachable", dead.open === false);

// ── Client behaviour ───────────────────────────────────────────────────────
const client = new BrowserRemoteControl("127.0.0.1", port);

const version = await client.version();
check("version() falls back to Browser.getVersion", version.Browser === "Chrome/146.0.0.0" && version.localDebugging === true);
check("transport resolved to ws", client.mode === "ws");

const tabs = await client.listTabs();
check("tabs come from Target.getTargets when /json/list 404s", tabs.length === 1 && tabs[0].id === "T-mail", `${tabs.length} tab(s)`);
check("devtools:// and non-page targets are filtered out", !tabs.some((t) => t.url.startsWith("devtools://") || t.id === "T-worker"));

const session = await client.attachTab("T-mail");
check("attach uses a flat session", seen.attachParams?.flatten === true && seen.attachParams?.targetId === "T-mail");
check("the session is connected and carries its sessionId", session.connected === true && session.sessionId === "S-T-mail");
check("only ONE socket is open for the browser + all its pages", wss.clients.size === 1);

// Every page-scoped call must be tagged, or Chrome applies it to the browser.
await client.click("T-mail", "#compose");
const tagged = seen.flatMessages.filter((m) => m.sessionId === "S-T-mail");
check("page commands are tagged with the sessionId", tagged.length > 0, `${tagged.length} tagged`);
check("no page command leaked out untagged", seen.flatMessages.every((m) => m.sessionId === "S-T-mail"));
check("input is dispatched through the flat session", tagged.some((m) => m.method === "Input.dispatchMouseEvent"));

// Events must reach the child, since that is what the navigation tracker and the
// live screencast both listen on.
await new Promise((r) => setTimeout(r, 60));
const navigations = session.activity.filter((a) => a.type === "navigated");
check("page events are routed to the flat session, not the browser one", navigations.length === 1, `${navigations.length} nav event(s)`);
check("the user's own navigation is attributed to the user", navigations[0]?.by === "user");

const created = await client.newTab("https://example.com");
check("newTab uses Target.createTarget", seen.created?.url === "https://example.com" && created.id === "T-new");

// Closing ONE page must not take the shared browser socket down with it.
await client.detachTab("T-mail");
check("detaching a page leaves the browser socket up", client.browser?.connected === true && wss.clients.size === 1);
check("the detached page is dropped from the session map", client.sessions.has("T-mail") === false);

await client.closeTab("T-new");
check("closeTab uses Target.closeTarget", seen.closed?.targetId === "T-new");

await client.closeAllSessions();
check("closeAllSessions closes the browser socket too", client.browser === null);

// ── The regular browser_* tools must see it too ─────────────────────────────
// browser_open / click / screenshot / automate go through the Playwright bridge,
// which used to probe /json/version only — so the user's own Chrome read as
// "no browser" and every one of those tools quietly launched a blank profile.
const { BrowserPlaywright, configureRealBrowser } = await import("../src/core/browser-playwright.js");
configureRealBrowser({ mode: "auto", host: "127.0.0.1", port });
const bridgeStatus = await new BrowserPlaywright({ rootDir: process.cwd() }).realBrowserStatus();
check("the Playwright bridge also sees a WebSocket-only endpoint", bridgeStatus.reachable === true && bridgeStatus.inUse === true);
check("so it does not fall back to a blank launched profile", bridgeStatus.hint === undefined);

await new Promise((resolve) => setTimeout(resolve, 50));
wss.close();
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
