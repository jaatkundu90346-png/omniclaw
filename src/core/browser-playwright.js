import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { normalizeBrowserScript } from "./browser-script.js";
import { publishBrowserAction } from "./browser-activity-bus.js";
import { probeCdp } from "./browser-launcher.js";

// Gate file:// targets so a browser tool can't exfiltrate arbitrary local files
// (secrets, source, anything outside the project). Local HTML the agent built
// under the project root stays previewable; everything else is blocked.
function assertSafeFileUrl(targetUrl, projectRoot) {
  let filePath;
  try { filePath = fileURLToPath(targetUrl); } catch { throw new Error("Invalid file:// URL."); }
  const root = path.resolve(projectRoot || process.cwd());
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("file:// blocked: path is outside the project root. Use http(s):// or a workspace file tool.");
  }
  if (/(^|\/)(\.env[^/]*|secrets\.json|[^/]*\.pem|[^/]*\.key)$/i.test(rel) ||
      /^(\.git|\.claude|\.mavis|node_modules|src|src-tauri|config|vendor)(\/|$)/i.test(rel) ||
      /^data\/(?!generated\/|browser-screenshots\/)/i.test(rel)) {
    throw new Error("file:// blocked: this path is sensitive and not previewable.");
  }
}

const BROWSER_SESSIONS = new Map();
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min idle timeout
// Hard cap on concurrent sessions. Each non-CDP session owns a WHOLE Chromium
// process tree, so an uncapped map meant a model that varied sessionId (or a
// long run that revived sessions) accumulated browsers until the machine was
// the bottleneck. Two is enough for any real task: the page being worked on and
// one to compare against.
const MAX_SESSIONS = 2;
// Last successfully opened URL per session — survives idle cleanup so
// view/screenshot can transparently reopen instead of failing the round with
// "No active browser session" (a top real-run failure).
const LAST_URLS = new Map();
let chromiumLoader = null;

// Load Playwright in BOTH `node` (source) and the packaged pkg exe. In the exe,
// dynamic `import("playwright")` throws "a dynamic import callback was not
// specified", so we createRequire() it from the REAL filesystem node_modules
// next to the exe (process.cwd()) — that require bypasses the pkg snapshot and
// resolves the real package. Dynamic import stays as the source-mode fallback.
async function loadPlaywright() {
  const cwd = process.cwd();
  const bases = [
    path.join(cwd, "index.js"),
    process.execPath,
    path.join(path.dirname(process.execPath), "index.js"),
  ];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const mod = req("playwright");
      if (mod?.chromium) return mod;
    } catch { /* try next base */ }
    try {
      const req = createRequire(base);
      const mod = req(path.join(path.dirname(base), "node_modules", "playwright"));
      if (mod?.chromium) return mod;
    } catch { /* try next base */ }
  }
  return import("playwright"); // plain `node` source mode
}

async function getChromium() {
  if (!chromiumLoader) {
    chromiumLoader = loadPlaywright()
      .then((mod) => mod.chromium)
      .catch((error) => {
        throw new Error(`Playwright browser automation is not available: ${error.message}`);
      });
  }
  return chromiumLoader;
}

function createSessionId() {
  return `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Laptop-friendliness tuning ──────────────────────────────────────────────
//
// The agent's browser is a real Chromium, and a heavy page (canvas, WebGL, a
// video, a long rAF loop) will happily saturate a core just by sitting open.
// These knobs trade a little wall-clock time for a lot of machine, and the
// defaults are deliberately gentle because automation must stay CORRECT first.
//
//   preferHeadlessShell  use chrome-headless-shell (same engine, no browser UI,
//                        no GPU stack) instead of full Chromium
//   cpuThrottlingRate    Emulation.setCPUThrottlingRate; 4 ≈ a quarter of the
//                        CPU for the same work. 1 disables. 0 = not set.
//   disableGpu           add --disable-gpu to the launch args (no GPU stack).
//   viewport             {width,height} for the automation context.
//   idleCloseMs          close a browser that has been idle this long.
//                        0 = never auto-close on idle (default).
// All of these come from tools.browserControl in config/default.json. The
// values below are the shipped defaults, so behavior is unchanged when the
// config omits them.
const BROWSER_TUNING = {
  preferHeadlessShell: true,
  cpuThrottlingRate: 4,
  disableGpu: true,
  viewport: { width: 1280, height: 720 },
  idleCloseMs: 0,
};

export function configureBrowserTuning(options = {}) {
  if (options.preferHeadlessShell !== undefined) {
    BROWSER_TUNING.preferHeadlessShell = options.preferHeadlessShell !== false;
  }
  if (options.cpuThrottlingRate !== undefined) {
    const rate = Number(options.cpuThrottlingRate);
    // Guard the range: <1 makes the page FASTER than the machine, and a huge
    // rate would stretch a normal page into minutes and trip tool timeouts.
    BROWSER_TUNING.cpuThrottlingRate = Number.isFinite(rate) ? Math.min(20, Math.max(0, rate)) : 0;
  }
  if (options.disableGpu !== undefined) {
    BROWSER_TUNING.disableGpu = options.disableGpu !== false;
  }
  if (options.viewport && typeof options.viewport === "object") {
    const width = Number(options.viewport.width);
    const height = Number(options.viewport.height);
    BROWSER_TUNING.viewport = {
      // A viewport must be a positive integer or Chromium rejects the context.
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1280,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : 720,
    };
  }
  if (options.idleCloseMs !== undefined) {
    const idle = Number(options.idleCloseMs);
    // 0 (or absent) = never auto-close. Negative values are treated as 0 so a
    // typo can never produce a timer that fires immediately and kills a session.
    BROWSER_TUNING.idleCloseMs = Number.isFinite(idle) && idle > 0 ? Math.round(idle) : 0;
  }
  return { ...BROWSER_TUNING };
}

export function getBrowserTuning() {
  return { ...BROWSER_TUNING };
}

// ── Drive the user's OWN browser ────────────────────────────────────────────
//
// Every browser_* tool (open, click, screenshot, snapshot, automate…) prefers
// the Chrome the user is already running with debugging exposed, so a site or
// game gets tested in the SAME browser they are looking at, with their logins
// intact — instead of Playwright's fresh, empty, invisible one.
//
// TWO endpoint shapes have to be handled, because the user's REAL profile only
// speaks one of them. Chrome 136+ ignores the debug-port command-line flag on
// the default user-data-dir, so their own browser is exposed from
// chrome://inspect/#remote-debugging — and that endpoint serves NO DevTools
// HTTP at all (every /json/* route 404s), only ws://host:port/devtools/browser.
// Probing HTTP alone therefore reports "no browser" for the one browser the
// user actually cares about, which is exactly the bug this handles.
//
// It is a preference, not a requirement: if neither endpoint answers we launch
// as before, so nothing regresses when the user has not enabled anything.

const REAL_BROWSER = {
  mode: "auto",       // "auto" (use it when reachable) | "always" | "off"
  host: "localhost",
  port: 9222,
};
let realBrowserPromise = null;   // shared Playwright Browser over CDP
let realBrowserKey = "";         // host:port the shared connection belongs to
let lastProbe = { key: "", at: 0, ok: false, transport: "" };

export function configureRealBrowser(options = {}) {
  const mode = String(options.mode ?? options.useRealBrowser ?? REAL_BROWSER.mode).toLowerCase();
  REAL_BROWSER.mode = ["auto", "always", "off"].includes(mode) ? mode : "auto";
  REAL_BROWSER.host = String(options.host || REAL_BROWSER.host);
  REAL_BROWSER.port = Number(options.port) || REAL_BROWSER.port;
  const key = `${REAL_BROWSER.host}:${REAL_BROWSER.port}`;
  // Re-pointing at a different browser must not keep handing out the old one.
  if (realBrowserKey && realBrowserKey !== key) {
    realBrowserPromise = null;
    realBrowserKey = "";
  }
  lastProbe = { key: "", at: 0, ok: false, transport: "" };
  return { ...REAL_BROWSER };
}

export function getRealBrowserSettings() {
  return { ...REAL_BROWSER, connected: Boolean(realBrowserPromise) };
}

// Cheap reachability probe. connectOverCDP against a dead port takes seconds to
// fail, which would tax every single browser_open on machines where the user
// never enabled debugging — this fails in under a second and is cached briefly.
// probeCdp tries HTTP first and then the WebSocket handshake, so a real profile
// exposed from chrome://inspect is found too.
async function probeDebugPort(host, port, timeoutMs = 800) {
  const probe = await probeCdp(host, port, timeoutMs).catch(() => ({ open: false, transport: "" }));
  return probe;
}

async function isRealBrowserReachable() {
  const key = `${REAL_BROWSER.host}:${REAL_BROWSER.port}`;
  // A negative result is cached for 10s so a burst of tool calls doesn't
  // re-probe every time; a positive one is not cached, because the user can
  // close Chrome at any moment and we would rather find out immediately.
  if (lastProbe.key === key && !lastProbe.ok && Date.now() - lastProbe.at < 10000) return false;
  const probe = await probeDebugPort(REAL_BROWSER.host, REAL_BROWSER.port);
  lastProbe = { key, at: Date.now(), ok: probe.open, transport: probe.transport };
  return probe.open;
}

const REAL_BROWSER_HINT =
  "Let OmniClaw use YOUR Chrome (with your logins): open chrome://inspect/#remote-debugging in it and turn local " +
  "debugging on — Chrome then serves DevTools on 127.0.0.1:9222 and no window has to be restarted. Do NOT tell the " +
  "user to relaunch Chrome with a debug-port flag: Chrome 136+ ignores that flag on the default profile. " +
  "Alternatively call browser_remote_launch for a separate OmniClaw profile (their existing logins won't be in it).";

async function connectRealBrowser() {
  const key = `${REAL_BROWSER.host}:${REAL_BROWSER.port}`;
  const existing = realBrowserPromise ? await realBrowserPromise.catch(() => null) : null;
  if (existing?.isConnected?.()) return existing;

  const chromium = await getChromium();
  realBrowserKey = key;
  // The ws endpoint is the user's real profile (chrome://inspect); the http one
  // is a browser started with the debug-port flag. Playwright takes either, but
  // handing it http:// when only the socket exists makes it fetch /json/version
  // and fail on the 404.
  let transport = lastProbe.key === key && lastProbe.ok ? lastProbe.transport : "";
  if (!transport) {
    const probe = await probeDebugPort(REAL_BROWSER.host, REAL_BROWSER.port);
    lastProbe = { key, at: Date.now(), ok: probe.open, transport: probe.transport };
    transport = probe.transport;
  }
  const endpoint = transport === "ws" ? `ws://${key}/devtools/browser` : `http://${key}`;
  realBrowserPromise = chromium
    .connectOverCDP(endpoint)
    .then((browser) => {
      // If the user quits Chrome, drop the cached connection so the next call
      // re-probes (and falls back to launching) instead of reusing a corpse.
      browser.on?.("disconnected", () => {
        realBrowserPromise = null;
        realBrowserKey = "";
      });
      return browser;
    })
    .catch((error) => {
      realBrowserPromise = null;
      realBrowserKey = "";
      throw error;
    });
  return realBrowserPromise;
}

// Which Chromium binary to drive.
//
// `chrome-headless-shell` is the SAME engine with the entire browser UI, GPU
// stack and window manager compiled out. On a heavy page that is the single
// biggest lever available: it typically costs a fraction of the RAM and CPU of
// full Chrome for identical DOM, JS and rendering behaviour, which is exactly
// the "my laptop heats up while the agent browses" complaint. It is only valid
// headless, so it is preferred ONLY when we are launching headless; otherwise
// full Chromium is required (it has to draw a real window).
function findChromiumExecutable({ preferHeadlessShell = false } = {}) {
  const explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }
  const localAppData = process.env.LOCALAPPDATA || "";
  const shell = path.join(localAppData, "ms-playwright", "chromium_headless_shell-1223", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
  const full = path.join(localAppData, "ms-playwright", "chromium-1223", "chrome-win64", "chrome.exe");
  // Ordered by preference, not by existence: whichever is listed first AND is
  // actually installed wins. A machine with only one of the two still works.
  const ordered = preferHeadlessShell ? [shell, full] : [full, shell];
  return ordered.find((candidate) => candidate && fs.existsSync(candidate)) || undefined;
}

function capArray(items, max = 200) {
  if (!Array.isArray(items)) return;
  while (items.length > max) items.shift();
}

function normalizeRef(ref) {
  const text = String(ref || "").trim();
  if (!text) return "";
  if (/^@e\d+$/i.test(text)) return `@e${text.replace(/^@e/i, "")}`;
  if (/^e\d+$/i.test(text)) return `@${text.replace(/^e/i, "e")}`;
  if (/^\d+$/.test(text)) return `@e${text}`;
  return text.startsWith("@") ? text : `@${text}`;
}

// Get a page to drive: a fresh tab in the user's real browser when that is
// available, otherwise a page in a freshly launched Playwright browser.
async function acquireTarget(options = {}) {
  if (REAL_BROWSER.mode !== "off") {
    const reachable = await isRealBrowserReachable();
    if (reachable) {
      try {
        const browser = await connectRealBrowser();
        // connectOverCDP hands back the browser's REAL default context — the
        // one holding the user's cookies and logins. Using newContext() here
        // would create an incognito-style profile and throw that away, which
        // is the whole reason we attached in the first place.
        const context = browser.contexts()[0] || (await browser.newContext());
        const page = await context.newPage();
        // The CDP target id is what the live view uses to stream THIS tab, so
        // "watch the agent test the game" can follow the agent automatically
        // instead of making the user hunt for the right tab in a dropdown.
        let cdpTargetId = null;
        try {
          const probe = await context.newCDPSession(page);
          const info = await probe.send("Target.getTargetInfo");
          cdpTargetId = info?.targetInfo?.targetId || null;
          await probe.detach().catch(() => {});
        } catch { /* streaming just falls back to manual tab choice */ }
        return { browser, context, page, overCDP: true, cdpTargetId };
      } catch (error) {
        if (REAL_BROWSER.mode === "always") {
          throw new Error(`Could not attach to your browser at ${REAL_BROWSER.host}:${REAL_BROWSER.port}: ${error.message}. ${REAL_BROWSER_HINT}`);
        }
        // mode "auto": fall through and launch, so the tools keep working.
      }
    } else if (REAL_BROWSER.mode === "always") {
      throw new Error(`Your browser is not exposing a debug port at ${REAL_BROWSER.host}:${REAL_BROWSER.port}. ${REAL_BROWSER_HINT}`);
    }
  }

  const headless = options.headless !== false;
  // The lighter binary, when we are running headless and the user has not
  // opted out. Same engine, no browser UI / GPU stack / window manager.
  const executablePath = findChromiumExecutable({ preferHeadlessShell: headless && BROWSER_TUNING.preferHeadlessShell !== false });
  const chromium = await getChromium();
  const browser = await chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // tools.browserControl.disableGpu (default true = unchanged from before).
      // Set false to let Chromium use the real GPU stack.
      ...(BROWSER_TUNING.disableGpu ? ["--disable-gpu"] : []),
      // Renderer processes are the expensive part: each is a full content
      // process that can burn a core on a heavy page. One is enough for a
      // single-page automation session and caps the worst case.
      "--renderer-process-limit=1",
      // Ownership marker. Chromium ignores unknown switches, but the flag stays
      // in the process command line, which is what lets a LATER OmniClaw run
      // recognise and reap a browser orphaned by a run that was killed before it
      // could clean up (on Windows a hard TerminateProcess skips every shutdown
      // hook). Without this, each crashed run permanently leaves a full browser
      // process tree running — the "laptop never cools down" symptom.
      // The user's own Chrome can never match it.
      `--omniclaw-agent-browser=1`,
    ],
  });

  const context = await browser.newContext({
    viewport: { width: BROWSER_TUNING.viewport.width, height: BROWSER_TUNING.viewport.height },
    userAgent: options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: options.locale || "en-US",
    timezoneId: options.timezone || "Asia/Kolkata",
  });

  const page = await context.newPage();

  // CPU throttling. A page like a Three.js/canvas app will otherwise run its
  // rAF loop flat out and saturate a core (or more) for as long as it is open,
  // which is what makes the whole laptop feel slow while the agent merely has a
  // tab open. Emulation.setCPUThrottlingRate makes the renderer believe the CPU
  // is N times slower, so it spreads the same work over more wall-clock time for
  // roughly 1/N of the CPU. The page still runs, still scripts, still renders —
  // it is just no longer allowed to starve the machine. Automation stays correct;
  // only wall-clock timings stretch, which the tool timeouts already absorb.
  let throttleCdp = null;
  const rate = Number(BROWSER_TUNING.cpuThrottlingRate) || 0;
  if (rate > 1) {
    try {
      throttleCdp = await context.newCDPSession(page);
      await throttleCdp.send("Emulation.setCPUThrottlingRate", { rate });
    } catch {
      // Older builds / non-Chromium: not fatal, we just run at full speed.
      throttleCdp = null;
    }
  }

  return { browser, context, page, overCDP: false, cdpTargetId: null, throttleCdp };
}

async function ensureBrowser(sessionId, options = {}) {
  let session = BROWSER_SESSIONS.get(sessionId);

  // The user can close our tab in their own browser at any time, so a live
  // browser connection alone is no longer proof the session is usable.
  if (session && session.browser && session.browser.isConnected() && !session.page?.isClosed?.()) {
    session.lastUsed = Date.now();
    noteBrowserActivity(sessionId);
    return session;
  }
  if (session) await closeSession(sessionId);

  // Make room BEFORE launching. Evicting the least recently used session is
  // what stops session count — and therefore browser process count — from
  // growing without bound over a long run.
  await evictOverflow();

  const { browser, context, page, overCDP, cdpTargetId, throttleCdp } = await acquireTarget(options);

  // Capture JS console/page/runtime signals. `consoleErrors` is kept for the
  // existing open() verifier; `consoleMessages` powers Hermes-style
  // browser_console so agents can inspect logs/warnings/errors on demand.
  const consoleErrors = [];
  const consoleMessages = [];
  const pushConsoleMessage = (entry) => {
    consoleMessages.push({ timestamp: new Date().toISOString(), ...entry });
    capArray(consoleMessages, 250);
  };
  page.on("console", (msg) => {
    try {
      const text = String(msg.text()).slice(0, 2000);
      const type = String(msg.type() || "log");
      pushConsoleMessage({ type, text, location: msg.location?.() || {} });
      if (type === "error") consoleErrors.push(text.slice(0, 300));
      capArray(consoleErrors, 80);
    } catch { /* ignore */ }
  });
  page.on("pageerror", (err) => {
    try {
      const text = `Uncaught: ${String(err?.message || err).slice(0, 2000)}`;
      pushConsoleMessage({ type: "pageerror", text, location: {} });
      consoleErrors.push(text.slice(0, 300));
      capArray(consoleErrors, 80);
    } catch { /* ignore */ }
  });

  // Track failed sub-resources (404'd CDN/library/asset, blocked module). A 3D
  // page frequently "loads with no console error" yet renders blank because its
  // Three.js/texture/module 404'd — this surfaces that. Reset per navigation.
  const failedRequests = [];
  page.on("requestfailed", (req) => {
    try {
      const u = String(req.url());
      if (/favicon\.ico($|\?)/i.test(u)) return;
      failedRequests.push(`${req.failure?.()?.errorText || "failed"} ${u.slice(0, 160)}`);
    } catch { /* ignore */ }
  });
  page.on("response", (resp) => {
    try {
      const s = resp.status();
      const u = String(resp.url());
      if (s >= 400 && !/favicon\.ico($|\?)/i.test(u)) failedRequests.push(`${s} ${u.slice(0, 160)}`);
    } catch { /* ignore */ }
  });

  const dialogs = [];
  const nextDialogActions = [];
  page.on("dialog", async (dialog) => {
    const planned = nextDialogActions.shift() || { action: "dismiss", auto: true };
    const normalizedAction = ["accept", "type"].includes(String(planned.action || "").toLowerCase()) ? "accept" : "dismiss";
    const record = {
      type: dialog.type?.() || "dialog",
      message: dialog.message?.() || "",
      defaultValue: dialog.defaultValue?.() || "",
      timestamp: new Date().toISOString(),
      handledAction: normalizedAction,
      auto: Boolean(planned.auto),
    };
    try {
      if (normalizedAction === "accept") {
        await dialog.accept(String(planned.text ?? planned.promptText ?? ""));
      } else {
        await dialog.dismiss();
      }
      record.handled = true;
    } catch (error) {
      record.handled = false;
      record.error = error.message;
    }
    dialogs.push(record);
    capArray(dialogs, 80);
  });

  session = {
    id: sessionId,
    browser,
    context,
    page,
    throttleCdp: throttleCdp || null,
    // True when this page lives in the user's OWN browser. closeSession leans
    // on it to avoid ever shutting down a browser we did not start.
    overCDP,
    // CDP target id of this tab when attached, so the live view can follow it.
    cdpTargetId: cdpTargetId || null,
    // Stable public id for the live panel. When the agent drives its OWN
    // Playwright Chromium there is no CDP target to point a screencast at, so
    // the panel had nothing to follow and the user saw a blank box for the
    // whole task. This id lets /api/browser/agent-stream find this exact page.
    liveTabId: `pw:${sessionId}`,
    consoleErrors,
    consoleMessages,
    failedRequests,
    dialogs,
    nextDialogActions,
    refMap: new Map(),
    refElements: [],
    cdpSession: null,
    lastUsed: Date.now(),
    createdAt: new Date().toISOString(),
    currentUrl: null,
    history: [],
  };

  BROWSER_SESSIONS.set(sessionId, session);
  
  // Setup idle cleanup
  scheduleCleanup(sessionId);
  
  return session;
}

/**
 * Close the least recently used sessions until we are back under MAX_SESSIONS.
 * A session currently being watched by the live panel is never evicted: the
 * user is looking at it, and swapping the page out from under them mid-task is
 * worse than holding one extra browser open.
 */
async function evictOverflow() {
  if (BROWSER_SESSIONS.size < MAX_SESSIONS) return;
  const watched = new Set(
    [...BROWSER_SESSIONS.entries()].filter(([, s]) => s?.liveStream?.viewers?.size).map(([id]) => id),
  );
  const candidates = [...BROWSER_SESSIONS.entries()]
    .filter(([id]) => !watched.has(id))
    .sort((a, b) => (a[1]?.lastUsed || 0) - (b[1]?.lastUsed || 0));
  const toClose = Math.max(0, BROWSER_SESSIONS.size - MAX_SESSIONS + 1);
  for (const [id] of candidates.slice(0, toClose)) {
    await closeSession(id).catch(() => {});
  }
}

// ── Idle auto-close (tools.browserControl.idleCloseMs, default 0 = off) ──
// Every browser action funnels through ensureBrowser()/reviveSession(), so
// restarting a single per-session timer there is enough to cover the whole
// tool surface without touching each action. A timer that fires closes only
// the session that went idle; other sessions are untouched.
const IDLE_CLOSE_TIMERS = new Map();

function clearIdleCloseTimer(sessionId) {
  const timer = IDLE_CLOSE_TIMERS.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  IDLE_CLOSE_TIMERS.delete(sessionId);
}

function noteBrowserActivity(sessionId) {
  const session = BROWSER_SESSIONS.get(sessionId);
  if (session) session.lastUsed = Date.now();
  clearIdleCloseTimer(sessionId);
  const idleCloseMs = Number(BROWSER_TUNING.idleCloseMs) || 0;
  if (idleCloseMs <= 0) return; // disabled (default) — do nothing at all
  const timer = setTimeout(() => {
    IDLE_CLOSE_TIMERS.delete(sessionId);
    const live = BROWSER_SESSIONS.get(sessionId);
    if (!live) return;
    // Re-check: the session may have been used during the timer's lifetime.
    const idleMs = Date.now() - (live.lastUsed || 0);
    if (idleMs < idleCloseMs) {
      noteBrowserActivity(sessionId);
      return;
    }
    closeSession(sessionId).catch(() => {});
  }, idleCloseMs);
  timer.unref?.();
  IDLE_CLOSE_TIMERS.set(sessionId, timer);
}

function scheduleCleanup(sessionId) {
  const timer = setTimeout(async () => {
    const session = BROWSER_SESSIONS.get(sessionId);
    if (!session) return;
    
    const idleMs = Date.now() - session.lastUsed;
    if (idleMs >= SESSION_TIMEOUT_MS) {
      await closeSession(sessionId);
    } else {
      scheduleCleanup(sessionId);
    }
  }, SESSION_TIMEOUT_MS);
  timer.unref?.();
}

async function closeSession(sessionId) {
  const session = BROWSER_SESSIONS.get(sessionId);
  if (!session) return false;
  // Drop the idle timer first so a pending close can't fire on a dead session.
  clearIdleCloseTimer(sessionId);

  // Tear the live screencast down FIRST. A Page.startScreencast left running on
  // a page we are about to close keeps Chrome encoding frames for a target that
  // no longer exists, and the CDP session object leaks with the page.
  if (session.liveStream) {
    const stream = session.liveStream;
    session.liveStream = null;
    try { stream.cdp.off?.("Page.screencastFrame", stream.handler); } catch { /* ignore */ }
    await stream.cdp.send("Page.stopScreencast").catch(() => {});
    await stream.cdp.detach().catch(() => {});
  }

  // Release the CPU-throttling session. Without this the CDP handle outlives the
  // page it was attached to.
  if (session.throttleCdp) {
    const cdp = session.throttleCdp;
    session.throttleCdp = null;
    await cdp.detach().catch(() => {});
  }

  try {
    await session.page?.close?.();
    // When the page lives in the user's OWN browser, closing our tab is the
    // ONLY thing we may do. Closing that context would drop their cookies and
    // closing the browser would quit Chrome out from under them mid-task.
    // The shared CDP connection is intentionally left open for reuse.
    if (!session.overCDP) {
      await session.context?.close?.();
      await session.browser?.close?.();
    }
  } catch (e) {
    // Ignore close errors
  }

  BROWSER_SESSIONS.delete(sessionId);
  return true;
}

export class BrowserPlaywright {
  constructor(options = {}) {
    this.defaultSessionId = options.sessionId || createSessionId();
    this.projectRoot = options.rootDir ? path.resolve(options.rootDir) : path.resolve(process.cwd());
    // ONE ROOT: file:// gating must follow the SELECTED project, not the app
    // dir. projectRootFor() is consulted per call so workspace switches take
    // effect without reconstruction. Confinement is unchanged — only the root
    // it gates against moves with the selection.
    this.projectRootFor = typeof options.projectRootFor === "function" ? options.projectRootFor : null;
    this.screenshotDir = options.screenshotDir || path.join(os.tmpdir(), "omniclaw-screenshots");
    // headless: false opens a visible browser window (configured via
    // tools.browserControl.headless).
    this.defaultHeadless = options.headless === false ? false : true;
    // Laptop-friendliness knobs; falls back to the built-in defaults.
    if (options.tuning) configureBrowserTuning(options.tuning);
    // Prefer the user's own running browser for every browser_* tool.
    // tools.browserControl.realBrowser = { mode: "auto"|"always"|"off", host, port }
    if (options.realBrowser) configureRealBrowser(options.realBrowser);

    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  // "Are the browser_* tools driving the user's own browser right now?"
  // Probes live, so browser_status tells the truth after they open or quit
  // Chrome rather than reporting whatever was true at boot.
  currentProjectRoot() {
    try {
      const live = this.projectRootFor ? this.projectRootFor() : "";
      if (live) return path.resolve(live);
    } catch { /* fall back to construction root */ }
    return this.projectRoot;
  }
  async realBrowserStatus() {
    const settings = getRealBrowserSettings();
    const reachable = settings.mode === "off" ? false : await isRealBrowserReachable();
    return {
      ...settings,
      reachable,
      inUse: reachable && settings.mode !== "off",
      hint: reachable || settings.mode === "off" ? undefined : REAL_BROWSER_HINT,
    };
  }

  relativeScreenshotPath(absolutePath) {
    if (!absolutePath) return "";
    const relative = path.relative(this.projectRoot, absolutePath).replace(/\\/g, "/");
    return relative && !relative.startsWith("..") ? relative : "";
  }

  resolveSelector(session, input = {}, fallbackSelector = "") {
    const selector = String(input.selector || "").trim() || fallbackSelector;
    if (selector) {
      return { selector, ref: input.ref || "" };
    }
    const ref = normalizeRef(input.ref || input.elementRef || input.element || "");
    if (!ref) {
      return { error: "selector or Hermes-style ref (for example @e1 from browser_snapshot) is required." };
    }
    const element = session?.refMap?.get(ref);
    if (!element?.selector) {
      return { error: `Unknown browser ref ${ref}. Run browser_snapshot again, then retry with the fresh ref.` };
    }
    return { selector: element.selector, ref, element };
  }

  async snapshot({ sessionId, maxElements = 100 } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    const url = session.page.url();
    const title = await session.page.title().catch(() => "");
    // Keep the cached title fresh: a snapshot is what the agent uses to decide
    // what page it is on, and the panel labels the tab from this same value.
    session.currentTitle = title;
    const observed = await session.page.evaluate(`(() => {
      const cssEscape = (value) => (window.CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"));
      const attrQuote = (value) => '"' + String(value || '').replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"';
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const unique = (selector) => {
        try { return selector && document.querySelectorAll(selector).length === 1; } catch { return false; }
      };
      const nthPath = (el) => {
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
          const tag = cur.tagName.toLowerCase();
          let index = 1;
          let sib = cur;
          while ((sib = sib.previousElementSibling)) {
            if (sib.tagName === cur.tagName) index += 1;
          }
          parts.unshift(tag + ":nth-of-type(" + index + ")");
          cur = cur.parentElement;
        }
        return parts.length ? parts.join(" > ") : el.tagName.toLowerCase();
      };
      const selectorFor = (el) => {
        if (el.id) {
          const idSelector = "#" + cssEscape(el.id);
          if (unique(idSelector)) return idSelector;
        }
        for (const attr of ["data-testid", "data-test", "aria-label", "name", "placeholder", "title", "alt", "href"]) {
          const value = el.getAttribute(attr);
          if (!value) continue;
          const selector = el.tagName.toLowerCase() + "[" + attr + "=" + attrQuote(value) + "]";
          if (unique(selector)) return selector;
        }
        const path = nthPath(el);
        return unique(path) ? path : path;
      };
      const roleFor = (el) => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") return type === "checkbox" || type === "radio" ? type : "textbox";
        if (tag === "img") return "img";
        if (el.isContentEditable) return "textbox";
        return tag;
      };
      const nameFor = (el) => {
        const labelledBy = el.getAttribute("aria-labelledby");
        const fromLabelledBy = labelledBy
          ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim()
          : "";
        const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
        return (
          el.getAttribute("aria-label") ||
          fromLabelledBy ||
          label ||
          el.getAttribute("alt") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          (el.innerText || el.value || el.textContent || "") ||
          el.getAttribute("name") ||
          el.getAttribute("href") ||
          ""
        ).trim().replace(/\\s+/g, " ").slice(0, 180);
      };
      const elements = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,summary,img,[role],[contenteditable='true']"))
        .filter(isVisible)
        .slice(0, ${Number(maxElements) || 100})
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const selector = selectorFor(el);
          return {
            role: roleFor(el),
            name: nameFor(el),
            text: (el.innerText || el.value || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 180),
            selector,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || "",
            disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
            bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          };
        });
      const visibleText = ((document.body && document.body.innerText) || "").trim().replace(/\\s+/g, " ").slice(0, 2000);
      return { visibleText, elements };
    })()`);

    const elements = (Array.isArray(observed?.elements) ? observed.elements : []).map((element, index) => ({
      ref: `@e${index + 1}`,
      ...element,
    }));
    session.refMap = new Map(elements.map((element) => [element.ref, element]));
    session.refElements = elements;

    const lines = [
      `Page: ${title || "(untitled)"}`,
      `URL: ${url}`,
      observed?.visibleText ? `Text: ${observed.visibleText}` : "Text: (no visible text)",
      "Interactive elements:",
      ...elements.map((element) => `  [${element.ref}] ${element.role}${element.name ? ` \"${element.name}\"` : ""}${element.disabled ? " disabled" : ""} selector=${element.selector}`),
    ];

    return {
      success: true,
      sessionId: sid,
      url,
      title,
      textPreview: observed?.visibleText || "",
      elements,
      refs: Object.fromEntries(elements.map((element) => [element.ref, element.selector])),
      content: lines.join("\n"),
      message: `Snapshot captured ${elements.length} ref(s). Use refs like @e1 with browser_click/browser_type/browser_tap.`,
    };
  }

  async open({ url, sessionId, waitUntil = "domcontentloaded" }) {
    const targetUrl = String(url || "").trim();
    if (!targetUrl) {
      return { error: "URL is required. Use browser_open with a URL." };
    }
    const sid = sessionId || this.defaultSessionId;
    // Every other failure in open() comes back as a structured {error, hint};
    // acquiring the browser must too, or the actionable "start Chrome with
    // --remote-debugging-port" hint reaches the model as a raw stack trace.
    let session;
    try {
      session = await ensureBrowser(sid, { headless: this.defaultHeadless });
    } catch (error) {
      return { error: `Could not start a browser session: ${String(error?.message || error)}`, sessionId: sid };
    }
    if (Array.isArray(session.consoleErrors)) session.consoleErrors.length = 0;
    if (Array.isArray(session.consoleMessages)) session.consoleMessages.length = 0;
    if (Array.isArray(session.failedRequests)) session.failedRequests.length = 0;

    const hasScheme = /^(https?:|file:|data:|about:)/i.test(targetUrl);
    if (/^file:/i.test(targetUrl)) {
      try { assertSafeFileUrl(targetUrl, this.currentProjectRoot()); }
      catch (err) { return { error: err.message }; }
    }
    const normalizedUrl = hasScheme ? targetUrl : `https://${targetUrl}`;

    // Local dev servers (vite/next/serve) race their own startup: the model
    // starts the server and opens the URL in the same breath, so the first
    // goto often lands before the port listens (ERR_CONNECTION_REFUSED — the
    // top browser_open failure in real runs). Retry briefly for local URLs;
    // on final failure return an ACTIONABLE error instead of throwing a raw
    // Playwright stack at the model.
    const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i.test(normalizedUrl);
    const attempts = isLocalUrl ? 4 : 1;
    let response = null;
    let lastGotoError = null;
    await this.announceAction(session, sid, { type: "navigate", url: normalizedUrl, label: `open ${normalizedUrl}` });
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        response = await session.page.goto(normalizedUrl, { waitUntil, timeout: 30000 });
        lastGotoError = null;
        break;
      } catch (error) {
        lastGotoError = error;
        const msg = String(error?.message || "");
        // "interrupted by another navigation" happens when a prior failed goto
        // left Chromium loading chrome-error:// and the retry races with it —
        // also retryable, else the startup-race recovery flakes on the 3rd try.
        const retryable = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_SOCKET_NOT_CONNECTED|interrupted by another navigation/i.test(msg);
        if (!retryable || attempt === attempts) break;
        await session.page.waitForTimeout(1500).catch(() => {});
      }
    }
    if (lastGotoError) {
      const msg = String(lastGotoError?.message || lastGotoError).split("\n")[0].slice(0, 300);
      return {
        error: `Could not open ${normalizedUrl}: ${msg}`,
        sessionId: sid,
        hint: isLocalUrl
          ? `The local server is not answering on this port (retried ${attempts}x over ~${Math.round((attempts - 1) * 1.5)}s). Check process_status for the dev server's startup output — when a port is busy, vite/next pick ANOTHER port (5174, 5175, ...) and print the real URL there; open THAT URL. If no server process is running, start it in the background first, then re-open.`
          : "Check the URL is reachable (typo/DNS/network), or use web_fetch if you only need the page content.",
      };
    }
    // Let scripts run a beat so runtime JS errors surface before we report.
    await session.page.waitForTimeout(400).catch(() => {});

    session.currentUrl = normalizedUrl;
    session.history.push({ url: normalizedUrl, timestamp: new Date().toISOString() });
    session.lastUsed = Date.now();
    LAST_URLS.set(sid, normalizedUrl);

    const title = await session.page.title().catch(() => "");
    // Cached so the live panel can label the tab without an async call (see
    // liveTargets — page.title() returns a Promise, not a string).
    session.currentTitle = title;
    const consoleErrors = Array.isArray(session.consoleErrors) ? session.consoleErrors.slice(0, 15) : [];
    const failedRequests = Array.isArray(session.failedRequests) ? session.failedRequests.slice(0, 12) : [];

    // Render probe: real, text-based proof that a vision-less model can act on —
    // did the page actually render content, did a <canvas> get a live WebGL
    // context, did a 3D/animation library load? "No console error" alone is NOT
    // proof a 3D page works (a blank canvas throws nothing).
    let render = null;
    try {
      // String expression (not a function literal) so the render probe survives
      // pkg bytecode compilation — see the note in view() for why.
      render = await session.page.evaluate(`(() => {
        const count = (sel) => document.querySelectorAll(sel).length;
        const canvasEl = document.querySelector("canvas");
        // NOTE: deliberately do NOT call getContext() here — that would *create*
        // a context as a side effect and falsely imply the page uses 3D. We only
        // read what already exists: size + whether a 3D library actually loaded.
        const canvas = canvasEl
          ? { width: canvasEl.width, height: canvasEl.height, cssWidth: canvasEl.clientWidth, cssHeight: canvasEl.clientHeight }
          : null;
        return {
          visibleTextLength: ((document.body && document.body.innerText) || "").trim().length,
          sections: count("section,header,footer,main,nav,article"),
          headings: count("h1,h2,h3"),
          paragraphs: count("p,li"),
          links: count("a,button"),
          images: count("img"),
          canvases: count("canvas"),
          canvas,
          threeDLib: Boolean(window.THREE || window.BABYLON || window.PIXI || window.p5),
        };
      })()`);
    } catch { /* probe is best-effort; never fail the open on it */ }

    // Turn the probe into actionable warnings the model must fix before claiming done.
    const warnings = [];
    if (render) {
      if (render.canvases === 0 && render.visibleTextLength < 40) {
        warnings.push("page rendered almost no visible content — likely blank/broken");
      }
      if (render.canvas && (render.canvas.width === 0 || render.canvas.cssWidth === 0)) {
        warnings.push("canvas has zero size — nothing will be visible on screen");
      }
      if (render.canvases > 0 && !render.threeDLib) {
        warnings.push("a <canvas> exists but no 3D library (THREE/BABYLON/PIXI/p5) is loaded on window — the 3D library probably failed to load (check the script/CDN URL)");
      }
    }
    if (failedRequests.length) {
      warnings.push(`${failedRequests.length} resource(s) failed to load (e.g. ${failedRequests.slice(0, 2).join("; ")}) — a 404'd CDN/library silently breaks 3D/animation`);
    }

    const clean = consoleErrors.length === 0 && warnings.length === 0;
    const renderSummary = render
      ? `${render.sections} sections, ${render.headings} headings, ${render.canvases} canvas${render.canvas?.webgl ? " (WebGL ✓)" : ""}, ${render.visibleTextLength} chars visible${render.threeDLib ? ", 3D lib loaded ✓" : ""}`
      : "no render probe";

    // Which browser this actually opened in matters to the user (they can watch
    // it) and to the agent (a login-gated page only works in the real one).
    const inUserBrowser = Boolean(session.overCDP);
    const browserNote = inUserBrowser
      ? " Opened in the USER'S OWN browser (their real profile and logins), in a new tab they can see and use."
      : "";

    return {
      success: true,
      sessionId: sid,
      url: normalizedUrl,
      title,
      status: response?.status() || 200,
      browserTarget: inUserBrowser ? "user" : "playwright",
      consoleErrors,
      hasErrors: consoleErrors.length > 0,
      failedRequests,
      render,
      warnings,
      verified: clean,
      message: (clean
        ? `Opened ${normalizedUrl} — rendered OK: ${renderSummary}. (Judge the page from this render report + console errors. If you take browser_screenshot, the harness attaches the image for you to LOOK at when your model supports vision.)`
        : `Opened ${normalizedUrl} — NOT verified: ${[
            consoleErrors.length ? `${consoleErrors.length} console error(s): ${consoleErrors.slice(0, 2).join(" | ")}` : "",
            ...warnings,
          ].filter(Boolean).join("; ")}. Fix these before claiming the page is done.`) + browserNote,
    };
  }

  // If the session idle-timed-out but we know the last URL, transparently
  // reopen it instead of failing the round — what a human would do.
  async reviveSession(sid) {
    let session = BROWSER_SESSIONS.get(sid);
    if (session && session.page && !session.page.isClosed?.()) {
      noteBrowserActivity(sid);
      return { session, revived: false };
    }
    // In the user's own browser they can close our tab themselves. Treat that
    // exactly like an idle timeout — reopen — instead of surfacing a raw
    // "Target page, context or browser has been closed" from deep in an action.
    if (session) await closeSession(sid);
    const lastUrl = LAST_URLS.get(sid);
    if (!lastUrl) {
      return { error: "No active browser session. Use browser_open first." };
    }
    const reopened = await this.open({ url: lastUrl, sessionId: sid });
    if (reopened?.error) {
      return { error: `Browser session had expired and auto-reopen of ${lastUrl} failed: ${reopened.error}` };
    }
    session = BROWSER_SESSIONS.get(sid);
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    return { session, revived: true, revivedUrl: lastUrl };
  }

  async view({ sessionId, format = "markdown" }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;

    session.lastUsed = Date.now();
    
    const url = session.page.url();
    const title = await session.page.title().catch(() => "");
    session.currentTitle = title;
    
    // Get page content
    let content = "";
    let screenshotPath = null;
    
    if (format === "markdown" || format === "both") {
      // Pass a STRING expression (not a function literal) to page.evaluate.
      // The packaged pkg exe compiles functions to V8 bytecode, so
      // Function.prototype.toString() returns "[native code]" and Playwright
      // rejects the function with "Passed function is not well-serializable!".
      // A string is evaluated directly in the page and survives bundling.
      content = await session.page.evaluate(`(() => {
        const body = document.body;
        if (!body) return "";
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
        const chunks = [];
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent.trim();
          if (text && text.length > 1) {
            chunks.push(text);
          }
        }
        return chunks.join("\\n");
      })()`);
    }
    
    if (format === "screenshot" || format === "both") {
      const filename = `screenshot_${Date.now()}.png`;
      screenshotPath = path.join(this.screenshotDir, filename);
      await session.page.screenshot({ path: screenshotPath, fullPage: false });
    }

    return {
      success: true,
      sessionId: sid,
      url,
      title,
      content: format !== "screenshot" ? content : undefined,
      screenshotPath,
      screenshotRelPath: this.relativeScreenshotPath(screenshotPath),
      message: (format === "screenshot" ? "Screenshot saved" : "Page content extracted") +
        (revival.revived ? ` (idle browser session auto-reopened at ${revival.revivedUrl})` : ""),
    };
  }

  async screenshot({ sessionId, fullPage = false, selector, ref }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;

    session.lastUsed = Date.now();
    
    const filename = `screenshot_${Date.now()}.png`;
    const screenshotPath = path.join(this.screenshotDir, filename);
    
    const options = { path: screenshotPath, fullPage };

    // In the user's real (headed) browser our tab is often in the background,
    // where Chrome throttles rendering and the capture can hang. Activating it
    // first is also what the user wants: they get to watch the check happen.
    if (session.overCDP) await session.page.bringToFront().catch(() => {});

    const resolved = this.resolveSelector(session, { selector, ref });
    if (resolved.error && (selector || ref)) return { error: resolved.error };

    if (resolved.selector) {
      const element = await session.page.$(resolved.selector);
      if (element) {
        await element.screenshot(options);
      } else {
        return { error: `Element not found: ${resolved.selector}` };
      }
    } else {
      await session.page.screenshot(options);
    }
    
    return {
      success: true,
      sessionId: sid,
      url: session.page.url(),
      screenshotPath,
      screenshotRelPath: this.relativeScreenshotPath(screenshotPath),
      message: "Screenshot saved",
    };
  }

  /**
   * Announce an agent action on the shared bus so the live view can draw the
   * agent's cursor. Coordinates are the element's centre in CSS pixels — the
   * same space CDP screencast metadata reports — so the overlay lines up with
   * the streamed frame without any extra scaling.
   *
   * SPEED: this runs immediately BEFORE the click/type/press it describes, so
   * anything awaited here is dead time on every interaction. It used to issue a
   * `page.evaluate` round trip each time (40-120ms, far worse on a busy page)
   * purely to measure a rectangle. browser_snapshot already measured and cached
   * `bounds` for every ref, so the common path is now an in-memory lookup. The
   * evaluate survives only as a fallback for a raw CSS selector that never went
   * through a snapshot.
   *
   * Best-effort by design: a page that navigated away mid-action must not turn
   * a working click into an error just because we could not measure it.
   */
  async announceAction(session, sid, action = {}) {
    try {
      let point = action.selector ? this.cachedPoint(session, action) : null;
      if (!point && action.selector) {
        // A STRING expression, not a callback: Playwright serialises a callback
        // with fn.toString(), which returns nothing usable once the app is
        // packaged into a pkg bytecode snapshot — the probe then always failed
        // and the watcher saw an action with no cursor. Every other evaluate in
        // this file passes a string for the same reason.
        point = await session.page
          .evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(String(action.selector))});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              secret: el.type === "password",
            };
          })()`)
          .catch(() => null);
      }
      publishBrowserAction({
        source: "playwright",
        actor: "agent",
        sessionId: sid,
        // liveTabId is what the panel follows. cdpTargetId is kept as well so an
        // existing viewer attached to the user's real Chrome keeps working.
        tabId: session.liveTabId || session.cdpTargetId || undefined,
        cdpTargetId: session.cdpTargetId || undefined,
        browserTarget: session.overCDP ? "user" : "playwright",
        ...(point || {}),
        ...action,
      });
    } catch { /* telemetry for a human watcher; never worth failing a tool over */ }
  }

  /**
   * Centre of an element the last browser_snapshot already measured. Zero round
   * trips, which is the whole point: this runs on the critical path of a click.
   *
   * Returns null when the selector was never snapshotted, or when the cached
   * rect is unusable (zero-sized, or scrolled out of the viewport) — drawing a
   * cursor at a stale position would be worse than drawing none.
   */
  cachedPoint(session, action = {}) {
    const selector = String(action.selector || "");
    if (!selector) return null;
    for (const element of session?.refElements || []) {
      if (element?.selector !== selector) continue;
      const box = element.bounds;
      if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
      if (!(box.width > 0) || !(box.height > 0)) return null;
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    }
    return null;
  }

  async click({ sessionId, selector, ref, waitForNavigation = false }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    const resolved = this.resolveSelector(session, { selector, ref });
    if (resolved.error) return { error: resolved.error };
    
    try {
      await session.page.waitForSelector(resolved.selector, { timeout: 5000 });
      // Announce before the click: the watcher should see the cursor arrive and
      // then the page react, which is the order a human would perform it in.
      await this.announceAction(session, sid, {
        type: "click",
        selector: resolved.selector,
        label: `click ${resolved.ref || resolved.selector}`,
      });

      if (waitForNavigation) {
        await Promise.all([
          session.page.waitForNavigation({ timeout: 30000 }),
          session.page.click(resolved.selector),
        ]);
      } else {
        await session.page.click(resolved.selector);
      }
      
      session.currentUrl = session.page.url();
      
      return {
        success: true,
        sessionId: sid,
        url: session.currentUrl,
        ref: resolved.ref || undefined,
        selector: resolved.selector,
        message: `Clicked: ${resolved.ref || resolved.selector}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async type({ sessionId, selector, ref, text, pressEnter = false }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    const resolved = this.resolveSelector(session, { selector, ref });
    if (resolved.error) return { error: resolved.error };
    
    try {
      await session.page.waitForSelector(resolved.selector, { timeout: 5000 });
      await this.announceAction(session, sid, {
        type: "type",
        selector: resolved.selector,
        text: String(text ?? ""),
        label: `type into ${resolved.ref || resolved.selector}`,
      });
      await session.page.fill(resolved.selector, text);

      if (pressEnter) {
        await session.page.press(resolved.selector, "Enter");
      }
      
      return {
        success: true,
        sessionId: sid,
        ref: resolved.ref || undefined,
        selector: resolved.selector,
        message: `Typed "${text}" into ${resolved.ref || resolved.selector}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async press({ sessionId, selector, ref, key = "Enter" }) {
    const sid = sessionId || this.defaultSessionId;
    // Auto-revive: if the session idle-timed-out, transparently reopen the last
    // URL instead of hard-failing (parity with view/screenshot). Interaction
    // tools (click/type/press/scroll/wait/evaluate/back/forward) used to error
    // with "No active browser session" the moment the 5-min idle cleanup fired.
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    const resolved = this.resolveSelector(session, { selector, ref }, "body");
    if (resolved.error) return { error: resolved.error };

    try {
      await this.announceAction(session, sid, {
        type: "key",
        selector: resolved.selector || undefined,
        text: String(key || "Enter"),
        label: `press ${key || "Enter"}`,
      });
      await session.page.press(resolved.selector || "body", key || "Enter");
      return {
        success: true,
        sessionId: sid,
        ref: resolved.ref || undefined,
        selector: resolved.selector,
        message: `Pressed ${key || "Enter"} on ${resolved.ref || resolved.selector || "body"}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async scroll({ sessionId, direction = "down", amount = 500 }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    
    const scrollY = direction === "down" ? amount : -amount;
    // String expression (inlined number) — a function literal would fail in the
    // pkg exe with "Passed function is not well-serializable!". See view().
    // 'smooth' matches what a human wheel does: the page visibly moves instead
    // of teleporting, which is the difference between "a bot jumped" and "a
    // person scrolled" in the live panel.
    await session.page.evaluate(`window.scrollBy({ top: ${Number(scrollY) || 0}, behavior: "smooth" })`);

    // The live view could never show scrolling because this published nothing.
    // No coordinate means the overlay had nothing to draw, so scroll is
    // announced from the viewport centre and labelled with its direction.
    await this.announceAction(session, sid, {
      type: "scroll",
      direction,
      amount: Number(amount) || 0,
      x: null,
      y: null,
      label: `scroll ${direction} ${Number(amount) || 0}px`,
    });

    return {
      success: true,
      sessionId: sid,
      message: `Scrolled ${direction} by ${amount}px`,
    };
  }

  async wait({ sessionId, selector, timeout = 10000 }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    
    try {
      if (selector) {
        await session.page.waitForSelector(selector, { timeout });
      } else {
        await session.page.waitForTimeout(timeout);
      }
      
      return {
        success: true,
        sessionId: sid,
        message: selector ? `Element found: ${selector}` : `Waited ${timeout}ms`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async evaluate({ sessionId, script, expression: expr, code, js, fn, args = [] } = {}) {
    // Models routinely pass the JS under a different key (expression/code/js/fn)
    // — silently evaluating an EMPTY string then returned {success:true} with
    // no result, and the agent could never read page/game state. Accept the
    // common aliases and hard-error when there is genuinely no script.
    const source = script ?? expr ?? code ?? js ?? fn;
    const raw = typeof source === "string" ? source.trim() : "";
    if (!raw) {
      return { error: "script is required — pass the JavaScript as `script` (aliases accepted: expression/code/js). Return a JSON-serializable value (string/number/object/array) to read it in the tool result." };
    }
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    // Always evaluate a STRING in the page — never hand Playwright a JS
    // function, which the pkg exe can't serialize ("Passed function is not
    // well-serializable!"). page.evaluate takes an EXPRESSION, but models write
    // statement bodies (`return ...`, `const x = ...`, a bare `{a: 1}`) far more
    // often than expressions. normalizeBrowserScript parse-checks the source and
    // picks the wrapper that compiles — see browser-script.js for the exact
    // production failures this replaced. Declared outside the try so the catch
    // can report which wrapper was used.
    const { expression: expressionStr, mode } = normalizeBrowserScript(raw, args);

    try {
      const result = await session.page.evaluate(expressionStr);
      if (result === undefined) {
        // JSON.stringify would silently DROP an undefined key — the model then
        // sees bare {success:true} and cannot tell what happened. Make it loud.
        return {
          success: true,
          sessionId: sid,
          url: session.page.url(),
          result: null,
          scriptMode: mode,
          note: "Script ran but returned undefined — nothing to read. Return a JSON-serializable VALUE: end with an expression or `return {...}`. DOM nodes are not serializable; map them to plain data, e.g. ({score: document.querySelector('#score')?.textContent, startHidden: getComputedStyle(document.querySelector('#startPanel')).display === 'none'}).",
        };
      }
      return {
        success: true,
        sessionId: sid,
        url: session.page.url(),
        result,
        scriptMode: mode,
      };
    } catch (error) {
      return { error: error.message, scriptMode: mode };
    }
  }

  async getImages({ sessionId } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    const images = await session.page.evaluate(`Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src || "",
      alt: img.alt || "",
      title: img.title || "",
      width: img.width || img.clientWidth || 0,
      height: img.height || img.clientHeight || 0,
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
      complete: Boolean(img.complete),
    })).filter((img) => img.src).slice(0, 200)`);

    return {
      success: true,
      sessionId: sid,
      url: session.page.url(),
      count: images.length,
      images,
    };
  }

  async console({ sessionId, clear = false, expression } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    let result;
    let exception = null;
    if (expression !== undefined && expression !== null && String(expression).trim()) {
      try {
        const client = session.cdpSession || await session.context.newCDPSession(session.page);
        session.cdpSession = client;
        const evaluation = await client.send("Runtime.evaluate", {
          expression: String(expression),
          awaitPromise: true,
          returnByValue: true,
        });
        if (evaluation.exceptionDetails) {
          exception = evaluation.exceptionDetails.text || evaluation.exceptionDetails.exception?.description || "Evaluation failed.";
        } else {
          const value = evaluation.result || {};
          result = value.value !== undefined ? value.value : (value.unserializableValue !== undefined ? value.unserializableValue : value.description);
        }
      } catch (error) {
        exception = error.message;
      }
      await session.page.waitForTimeout(50).catch(() => {});
    }

    const messages = Array.isArray(session.consoleMessages) ? session.consoleMessages.slice() : [];
    const errors = messages.filter((message) => ["error", "pageerror", "requestfailed"].includes(message.type));
    if (clear) {
      if (Array.isArray(session.consoleMessages)) session.consoleMessages.length = 0;
      if (Array.isArray(session.consoleErrors)) session.consoleErrors.length = 0;
      if (Array.isArray(session.failedRequests)) session.failedRequests.length = 0;
    }

    return {
      success: !exception,
      sessionId: sid,
      url: session.page.url(),
      result,
      exception,
      messages,
      errors,
      message: exception ? `Browser console expression failed: ${exception}` : `Returned ${messages.length} console/runtime message(s).`,
    };
  }

  async cdp({ sessionId, method, params = {} } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    const cdpMethod = String(method || "").trim();
    if (!cdpMethod) {
      return { error: "CDP method is required, e.g. Runtime.evaluate." };
    }
    try {
      const client = session.cdpSession || await session.context.newCDPSession(session.page);
      session.cdpSession = client;
      const result = await client.send(cdpMethod, params && typeof params === "object" ? params : {});
      return {
        success: true,
        sessionId: sid,
        method: cdpMethod,
        result,
      };
    } catch (error) {
      return { error: error.message, sessionId: sid, method: cdpMethod };
    }
  }

  async dialog({ sessionId, action = "list", text, promptText } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    const normalized = String(action || "list").trim().toLowerCase();
    if (["list", "status", "get"].includes(normalized)) {
      return {
        success: true,
        sessionId: sid,
        dialogs: Array.isArray(session.dialogs) ? session.dialogs.slice() : [],
        armed: (session.nextDialogActions || []).length > 0,
        armedCount: (session.nextDialogActions || []).length,
      };
    }
    if (normalized === "clear") {
      if (Array.isArray(session.dialogs)) session.dialogs.length = 0;
      if (Array.isArray(session.nextDialogActions)) session.nextDialogActions.length = 0;
      return { success: true, sessionId: sid, dialogs: [], armed: false, message: "Dialog history and pre-armed actions cleared." };
    }
    if (!["accept", "dismiss", "type"].includes(normalized)) {
      return { error: "Unsupported dialog action. Use list, clear, accept, dismiss, or type." };
    }
    session.nextDialogActions ||= [];
    session.nextDialogActions.push({ action: normalized === "type" ? "accept" : normalized, text: text ?? promptText ?? "" });
    return {
      success: true,
      sessionId: sid,
      armed: true,
      action: normalized,
      armedCount: session.nextDialogActions.length,
      message: `${normalized} is armed for the next browser dialog. Trigger the page action now; it will not hang.`,
    };
  }

  async tap({ sessionId, selector, ref, x, y } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();

    try {
      let point = null;
      let resolved = null;
      if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
        point = { x: Number(x), y: Number(y) };
      } else {
        resolved = this.resolveSelector(session, { selector, ref });
        if (resolved.error) return { error: resolved.error };
        const locator = session.page.locator(resolved.selector).first();
        await locator.waitFor({ state: "visible", timeout: 5000 });
        const box = await locator.boundingBox();
        if (!box) return { error: `Element has no visible bounding box: ${resolved.selector}` };
        point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      }
      try {
        await session.page.touchscreen.tap(point.x, point.y);
      } catch {
        await session.page.mouse.click(point.x, point.y);
      }
      session.currentUrl = session.page.url();
      return {
        success: true,
        sessionId: sid,
        url: session.currentUrl,
        ref: resolved?.ref || undefined,
        selector: resolved?.selector || undefined,
        x: point.x,
        y: point.y,
        message: `Tapped ${resolved?.ref || resolved?.selector || `${point.x},${point.y}`}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async vision({ sessionId, fullPage = false, annotate = false, question = "" } = {}) {
    const sid = sessionId || this.defaultSessionId;
    const screenshot = await this.screenshot({ sessionId: sid, fullPage });
    if (screenshot.error) return screenshot;
    const snapshot = annotate ? await this.snapshot({ sessionId: sid }) : null;
    return {
      success: true,
      sessionId: sid,
      screenshotPath: screenshot.screenshotPath,
      screenshotRelPath: screenshot.screenshotRelPath,
      question: String(question || ""),
      annotated: Boolean(annotate),
      elements: snapshot?.elements || [],
      content: snapshot?.content || "",
      visionProvider: false,
      message: annotate
        ? "Screenshot captured with DOM refs overlay data. External vision provider is not configured, so use screenshotPath plus elements/content."
        : "Screenshot captured. External vision provider is not configured, so use screenshotPath for visual inspection.",
    };
  }

  async goBack({ sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    await session.page.goBack();
    session.currentUrl = session.page.url();
    
    return {
      success: true,
      sessionId: sid,
      url: session.currentUrl,
      message: "Navigated back",
    };
  }

  async goForward({ sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    const revival = await this.reviveSession(sid);
    if (revival.error) return { error: revival.error };
    const session = revival.session;
    session.lastUsed = Date.now();
    await session.page.goForward();
    session.currentUrl = session.page.url();
    
    return {
      success: true,
      sessionId: sid,
      url: session.currentUrl,
      message: "Navigated forward",
    };
  }

  async close({ sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    const closed = await closeSession(sid);
    
    return {
      success: closed,
      sessionId: sid,
      message: closed ? "Browser session closed" : "Session not found",
    };
  }

  /**
   * Close every session. Called on shutdown.
   *
   * A session we launched owns a real Chromium process tree, and a session over
   * CDP owns a tab in the user's own window. Neither is reaped by the process
   * exiting on its own, so without this an app restart leaves the previous run's
   * browsers running and the next run stacks another set on top.
   */
  async closeAll() {
    for (const id of [...BROWSER_SESSIONS.keys()]) {
      await closeSession(id).catch(() => {});
    }
    for (const id of [...IDLE_CLOSE_TIMERS.keys()]) clearIdleCloseTimer(id);
    BROWSER_SESSIONS.clear();
  }

  listSessions() {
    const sessions = [];
    for (const [id, session] of BROWSER_SESSIONS) {
      sessions.push({
        id,
        currentUrl: session.currentUrl,
        createdAt: session.createdAt,
        lastUsed: new Date(session.lastUsed).toISOString(),
        browserTarget: session.overCDP ? "user" : "playwright",
      });
    }
    return sessions;
  }

  // ── Live view of the AGENT's own browser ──────────────────────────────────
  //
  // The panel used to only understand CDP tabs of the user's real Chrome, so a
  // task driven through the Playwright stack (the default when no debug port is
  // exposed) showed an empty box for its entire duration — the user could not
  // see the agent click, scroll or type. Playwright drives Chromium over the
  // same DevTools protocol underneath, so a raw CDP screencast on its page
  // produces the identical stream the panel already knows how to render.
  //
  // One stream per session, multiplexed to every viewer, exactly like
  // BrowserRemoteControl.startScreencast — and bounded to ONE concurrent
  // screencast, because each one is a permanent CPU charge on the browser.

  /** Sessions the panel can currently follow, newest activity first. */
  liveTargets() {
    const targets = [];
    for (const [id, session] of BROWSER_SESSIONS) {
      if (!session?.page || session.page.isClosed?.()) continue;
      targets.push({
        id: session.liveTabId || `pw:${id}`,
        sessionId: id,
        url: session.currentUrl || session.page.url?.() || "",
        // session.currentTitle, NOT page.title(): that is ASYNC, so calling it
        // here stored a Promise, which JSON-serialised to `{}` and put a literal
        // "{}" in the panel's tab list. The title is captured where it is
        // already awaited (open/snapshot/view) and cached on the session.
        title: session.currentTitle || "",
        browserTarget: session.overCDP ? "user" : "playwright",
        lastUsed: session.lastUsed,
      });
    }
    return targets.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  }

  /**
   * Start (or join) the frame stream for a session's page.
   * @returns {Promise<() => void>} call to stop watching
   */
  async startLiveStream(sessionId, options = {}, onFrame) {
    if (typeof onFrame !== "function") throw new Error("startLiveStream requires an onFrame callback");
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    if (!session?.page || session.page.isClosed?.()) {
      throw new Error("No live browser session. The agent has not opened a page yet.");
    }

    if (!session.liveStream) {
      const cdp = await session.context.newCDPSession(session.page);
      const viewers = new Set();
      // Playwright's CDPSession re-emits protocol events under their own name
      // ("Page.screencastFrame"), NOT wrapped in a {method} envelope like the
      // hand-rolled CDPSession in browser-remote-control.js. Subscribing to
      // "message" here silently receives nothing, which is why the panel stayed
      // blank while the screencast was in fact running.
      const handler = (params) => {
        if (!params) return;
        if (session.liveStream) session.liveStream.gotFrame = true;
        // Ack or the stream delivers exactly one frame and looks frozen.
        cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        for (const viewer of viewers) {
          try { viewer({ data: params.data, metadata: params.metadata || {} }); }
          catch { /* one broken viewer must not kill the stream */ }
        }
      };
      cdp.on("Page.screencastFrame", handler);
      await cdp.send("Page.enable");
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: Math.min(90, Math.max(20, Number(options.quality) || 45)),
        maxWidth: Number(options.maxWidth) || 960,
        maxHeight: Number(options.maxHeight) || 720,
        // Every 3rd frame: the same throttle the CDP path uses. A human cannot
        // tell 20fps from 60fps in a mirrored view, and the CPU difference is
        // what keeps a laptop's fan quiet.
        everyNthFrame: Math.max(1, Number(options.everyNthFrame) || 3),
      });
      session.liveStream = {
        cdp, viewers, handler, gotFrame: false,
        quality: Math.min(90, Math.max(20, Number(options.quality) || 45)),
        maxWidth: Number(options.maxWidth) || 960,
        maxHeight: Number(options.maxHeight) || 720,
      };

      // Chrome only pushes a screencast frame when the page REPAINTS. A page
      // that has finished loading and sits still therefore produces nothing at
      // all, and the panel stays blank — which reads as "the feature is broken"
      // on exactly the ordinary pages a task starts from. If nothing has
      // arrived shortly after attaching, take one snapshot and hand it over, so
      // the viewer always shows the current page immediately.
      setTimeout(() => {
        const live = session.liveStream;
        if (!live || live.gotFrame) return;
        cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: live.quality,
          maxWidth: live.maxWidth,
          maxHeight: live.maxHeight,
        }).then((shot) => {
          if (!shot?.data) return;
          for (const viewer of live.viewers) {
            try {
              viewer({
                data: shot.data,
                metadata: { deviceWidth: 0, deviceHeight: 0, initial: true },
              });
            } catch { /* one broken viewer must not kill the stream */ }
          }
        }).catch(() => { /* page closed mid-capture */ });
      }, 700).unref?.();
    }

    const stream = session.liveStream;
    stream.viewers.add(onFrame);
    return () => { this.stopLiveStream(sid, onFrame).catch(() => {}); };
  }

  async stopLiveStream(sessionId, onFrame = null) {
    const session = BROWSER_SESSIONS.get(sessionId);
    if (!session?.liveStream) return;
    const stream = session.liveStream;
    if (onFrame) {
      stream.viewers.delete(onFrame);
      if (stream.viewers.size) return;   // another panel is still watching
    }
    session.liveStream = null;
    try { stream.cdp.off?.("Page.screencastFrame", stream.handler); } catch { /* ignore */ }
    await stream.cdp.send("Page.stopScreencast").catch(() => {});
    await stream.cdp.detach().catch(() => {});
  }

  // High-level automation: perform a task on a page
  async automate({ url, actions, sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    let openResult = null;

    if (url) {
      openResult = await this.open({ url, sessionId: sid });
      if (openResult.error) {
        return openResult;
      }
    }

    const results = [];
    const actionList = Array.isArray(actions) ? actions : [];

    for (const action of actionList) {
      let result;
      
      switch (action.type) {
        case "click":
          result = await this.click({ sessionId: sid, selector: action.selector, waitForNavigation: action.waitForNavigation });
          break;
        case "type":
          result = await this.type({ sessionId: sid, selector: action.selector, text: action.text, pressEnter: action.pressEnter });
          break;
        case "press":
          result = await this.press({ sessionId: sid, selector: action.selector, key: action.key });
          break;
        case "scroll":
          result = await this.scroll({ sessionId: sid, direction: action.direction, amount: action.amount });
          break;
        case "wait":
          result = await this.wait({ sessionId: sid, selector: action.selector, timeout: action.timeout });
          break;
        case "screenshot":
          result = await this.screenshot({ sessionId: sid, fullPage: action.fullPage });
          break;
        case "evaluate":
          result = await this.evaluate({ sessionId: sid, script: action.script });
          break;
        default:
          result = { error: `Unknown action: ${action.type}` };
      }
      
      results.push({ action: action.type, ...result });
      
      if (result.error) {
        break;
      }
    }
    
    return {
      success: !results.some((r) => r.error),
      sessionId: sid,
      url: openResult?.url || BROWSER_SESSIONS.get(sid)?.currentUrl || "",
      actions: results,
    };
  }
}

export default BrowserPlaywright;
