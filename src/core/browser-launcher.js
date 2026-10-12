import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile, execFileSync } from "node:child_process";

/**
 * Starts a Chromium browser with the CDP debug port open, so OmniClaw can drive
 * a real browser the user can watch and take over.
 *
 * Why this exists: telling the user to run `chrome.exe --remote-debugging-port=9222`
 * DOES NOT WORK on Chrome 136+. Chrome silently ignores the flag when it runs on
 * the DEFAULT user data directory — a 2025 hardening change aimed at
 * cookie-stealing malware. Nothing appears on 9222 and the user gets an
 * ECONNREFUSED they cannot fix by following the instructions.
 *
 * TWO ways out, and OmniClaw supports both:
 *
 *  1. THE USER'S OWN CHROME (preferred — their accounts are already signed in
 *     there). In that browser: chrome://inspect/#remote-debugging → turn local
 *     debugging on. Chrome then serves CDP on 127.0.0.1:9222 over WebSocket only
 *     (every /json/* route 404s), which is why probing needs isCdpSocketOpen()
 *     and the client needs its ws transport. See MY_CHROME_STEPS.
 *
 *  2. A SEPARATE PROFILE that OmniClaw launches itself, which is what
 *     launchDebugBrowser() below does. That profile is PERSISTENT: sign into
 *     Google inside it once and it stays signed in. Use this when the user does
 *     not want to flip a switch in their main browser.
 *
 * Deliberately NOT done: copying cookies / "Login Data" / the Local State
 * encryption key out of the user's real profile. Route 1 reaches the same
 * logged-in sessions without putting a second copy of a credential store on
 * disk, which is exactly what Chrome's hardening exists to prevent.
 */

const WINDOWS = process.platform === "win32";

function candidateBrowsers() {
  const env = process.env;
  const pf = env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  // B5: explicit override wins (CI, portable installs, non-default paths).
  const override = String(env.OMNICLAW_CHROME_PATH || "").trim();
  const extra = override && fs.existsSync(override)
    ? [{ name: "Chrome", exe: path.basename(override), paths: [override] }]
    : [];

  if (WINDOWS) {
    return [
      ...extra,
      { name: "Chrome", exe: "chrome.exe", paths: [
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      ] },
      { name: "Edge", exe: "msedge.exe", paths: [
        path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      ] },
      { name: "Brave", exe: "brave.exe", paths: [
        path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ] },
    ];
  }

  if (process.platform === "darwin") {
    return [
      ...extra,
      { name: "Chrome", exe: "Google Chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
      { name: "Edge", exe: "Microsoft Edge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
      { name: "Brave", exe: "Brave Browser", paths: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] },
    ];
  }

  return [
    ...extra,
    { name: "Chrome", exe: "google-chrome", paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"] },
    { name: "Chromium", exe: "chromium", paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser"] },
  ];
}

/** The installed browser we would drive, or null. */
export function findBrowser(preferred = "") {
  // Test escape hatch (mirrors OMNICLAW_TEST_NO_SPAWN): Windows spawn cannot
  // override ProgramFiles in the child env, so "no Chrome" is otherwise
  // unsimulatable on machines that have it.
  if (process.env.OMNICLAW_NO_BROWSER === "1") return null;
  const wanted = String(preferred || "").toLowerCase();
  const all = candidateBrowsers();
  const ordered = wanted ? [...all.filter((b) => b.name.toLowerCase() === wanted), ...all] : all;
  for (const browser of ordered) {
    for (const exePath of browser.paths) {
      if (fs.existsSync(exePath)) return { name: browser.name, path: exePath, exe: browser.exe };
    }
  }
  return null;
}

/**
 * Where the debug-enabled profile lives. Stable across runs — that stability is
 * the entire reason a one-time sign-in is enough.
 */
export function debugProfileDir(browserName = "Chrome") {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "OmniClaw", `${String(browserName).toLowerCase()}-debug-profile`);
}

// ── Stale-browser reaping ────────────────────────────────────────────────────
//
// launchDebugBrowser() spawns the managed browser DETACHED so it survives this
// process and keeps the user's session warm. That is the point — and it is also
// the bug: on Windows a killed or crashed OmniClaw (child.kill('SIGTERM') is a
// hard TerminateProcess, so shutdown hooks never run) leaves the browser
// running forever. Every abnormal exit permanently costs the user a browser
// process until they reboot, which is exactly the "it heats up and never
// calms down" report.
//
// So ownership is tracked on disk instead of in a shutdown hook: the launcher
// records which pid owns the managed browser, and a new run reaps the browser
// ONLY if that owner is gone. A second live OmniClaw therefore keeps its own
// browser, while a dead run's leftovers are cleaned up automatically.
const OWNER_FILE = "managed-browser-owner.json";

function ownerFilePath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
  return path.join(base, "OmniClaw", OWNER_FILE);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);           // signal 0 = existence probe, sends nothing
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return error?.code === "EPERM";
  }
}

function writeOwnerRecord(port = 0) {
  try {
    const file = ownerFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, at: new Date().toISOString() }));
  } catch { /* best effort: the reaper just falls back to "no record" */ }
}

/**
 * Claim ownership of any browser reaping for as long as THIS process lives.
 *
 * Called at startup, not only when the managed browser is launched. The reaper
 * kills both the managed window AND the agent's Playwright Chromium, so without
 * a record from a live-but-idle instance, starting a second OmniClaw (a dev
 * server beside the packaged exe is a normal setup) would reap the FIRST
 * instance's live browser out from under it.
 */
export function claimBrowserOwnership() {
  writeOwnerRecord(0);
  const release = () => {
    // Only clear the record if it is still OURS; a newer instance that already
    // claimed it must not have its ownership deleted by our exit.
    const current = readOwnerRecord();
    if (current && Number(current.pid) === process.pid) clearOwnerRecord();
  };
  process.once("exit", release);
  return release;
}

function clearOwnerRecord() {
  try { fs.unlinkSync(ownerFilePath()); } catch { /* already gone */ }
}

function readOwnerRecord() {
  try { return JSON.parse(fs.readFileSync(ownerFilePath(), "utf8")); } catch { return null; }
}

/**
 * Kill managed browsers left behind by a run that is no longer alive.
 * @returns {Promise<{killed:number, skipped:boolean, reason:string}>}
 */
export async function reapStaleManagedBrowsers() {
  const result = { killed: 0, skipped: false, reason: "" };
  if (process.platform !== "win32") { result.reason = "non-windows"; return result; }

  const owner = readOwnerRecord();
  if (owner && processAlive(Number(owner.pid))) {
    // A live OmniClaw already owns a managed browser (e.g. the user is running
    // the dev server and the packaged exe side by side). Leave it alone.
    result.skipped = true;
    result.reason = `owned by live pid ${owner.pid}`;
    return result;
  }

  // Match ONLY browsers this product launched:
  //   * the persistent managed window (OmniClaw debug profile)
  //   * the agent's own Playwright Chromium — either via the marker we pass on
  //     launch, or the bundled-browser path it always uses
  // The user's normal Chrome/Edge is installed under Program Files and never
  // matches any of these, so their tabs can never be closed by this.
  //
  // The whole block is already gated on "no LIVE OmniClaw owns browsers" above,
  // which is what makes the bundled-path match safe: if a sibling instance is
  // running (dev server beside the packaged exe), nothing is reaped at all.
  // One line on purpose — joining a multi-line Where-Object with ";" produces
  // "-and;" which PowerShell refuses to parse, and the reaper then silently
  // matches nothing (and reports success).
  const ps = "$p=@(Get-CimInstance Win32_Process | Where-Object { " +
    "($_.Name -match '^(chrome|msedge|brave)\\.exe$') -and (" +
    "(($_.CommandLine -like '*-debug-profile*') -and ($_.CommandLine -like '*OmniClaw*')) -or " +
    "($_.CommandLine -like '*--omniclaw-agent-browser*') -or " +
    "($_.CommandLine -like '*ms-playwright*')" +
    ") }); " +
    "$n=0; foreach($x in $p){ Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n";
  result.killed = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 15000 },
      (error, stdout) => resolve(error ? 0 : (Number(String(stdout).trim()) || 0)));
  });
  clearOwnerRecord();
  result.reason = owner ? `owner pid ${owner.pid} is gone` : "no owner record";
  return result;
}

/** Has the user already signed in inside the OmniClaw profile? */
export function profileHasSession(profileDir) {
  try {
    return ["Default/Network/Cookies", "Default/Cookies"].some((rel) => {
      const file = path.join(profileDir, rel);
      return fs.existsSync(file) && fs.statSync(file).size > 20 * 1024;
    });
  } catch {
    return false;
  }
}

export function isPortOpen(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: host, port, path: "/json/version", timeout: timeoutMs, headers: { Host: `${host}:${port}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * Is `ws://host:port/devtools/browser` a live CDP endpoint?
 *
 * The user's REAL Chrome — debugging switched on from chrome://inspect — answers
 * here and 404s every /json/* route, so an HTTP-only probe reports "no browser"
 * for the one browser the user actually cares about. Checked with a raw
 * handshake (101 Switching Protocols) rather than the `ws` package so this stays
 * dependency-free and usable from the packaged exe.
 */
export function isCdpSocketOpen(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.request({
        hostname: host,
        port,
        path: "/devtools/browser",
        timeout: timeoutMs,
        headers: {
          Host: `${host}:${port}`,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          // Any 16 random bytes, base64. Chrome only echoes it back.
          "Sec-WebSocket-Key": Buffer.from(String(Math.random()).padEnd(16, "0").slice(0, 16)).toString("base64"),
        },
      });
    } catch {
      done(false);
      return;
    }
    req.on("upgrade", (_res, socket) => {
      try { socket.destroy(); } catch { /* ignore */ }
      done(true);
    });
    // A plain response means the port answered but is not a CDP browser socket.
    req.on("response", (res) => { res.resume(); done(false); });
    req.on("error", () => done(false));
    req.on("timeout", () => { req.destroy(); done(false); });
    req.end();
  });
}

/**
 * Either endpoint shape, and which one it was.
 * @returns {Promise<{open: boolean, transport: "http"|"ws"|""}>}
 */
export async function probeCdp(host, port, timeoutMs = 900) {
  if (await isPortOpen(host, port, timeoutMs)) return { open: true, transport: "http" };
  if (await isCdpSocketOpen(host, port, timeoutMs)) return { open: true, transport: "ws" };
  return { open: false, transport: "" };
}

// 4B.2: where WE last launched the managed instance (B5 reuse step 1).
let lastManaged = null; // {host, port}

async function firstFreePort(host, start, tries = 16) {
  for (let port = start; port < start + tries; port++) {
    if (await isPortOpen(host, port)) continue;
    if (await isCdpSocketOpen(host, port)) continue;
    return port;
  }
  return 0;
}

function chromeNotFound() {
  return Object.assign(
    new Error("Chrome not found (looked for Chrome, Edge and Brave in the usual install locations)."),
    {
      status: 404,
      code: "ENOENT",
      hint: "Install Google Chrome or set OMNICLAW_CHROME_PATH",
    }
  );
}

/** Is a process with this image name running? Windows-only detail, best-effort. */
export function isBrowserRunning(exeName) {
  if (!WINDOWS) return false;
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${exeName}`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    return out.toLowerCase().includes(String(exeName).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Launch the browser with the debug port open, and resolve only once the port
 * actually answers — "spawned" is not the same as "reachable", and returning
 * early is how the UI ends up showing ECONNREFUSED right after a success toast.
 */
export async function launchDebugBrowser(options = {}) {
  const {
    host = "localhost",
    port = 9222,
    browser: preferred = "",
    startUrl = "about:blank",
    timeoutMs = 25000,
    // 4B.2 B5: managed-route semantics. Tools (managed:false, default) keep
    // today's behavior, including adopting the user's own chrome://inspect
    // profile. The managed route (managed:true) NEVER auto-attaches to user
    // Chrome: ws-only listeners are skipped and we spawn on the next free port.
    managed = false,
    headless = false,
  } = options;

  if (managed) {
    // (1) our own earlier launch still listening → reuse.
    if (lastManaged && lastManaged.host === host && (await isPortOpen(host, lastManaged.port))) {
      return {
        success: true, alreadyRunning: true, reused: true,
        host, port: lastManaged.port,
        message: `Reusing the managed browser on ${host}:${lastManaged.port}.`,
      };
    }
    // (2) requested port http-open (a debug-profile listener, ours or older) → reuse.
    if (await isPortOpen(host, port)) {
      lastManaged = { host, port };
      return {
        success: true, alreadyRunning: true, reused: true,
        host, port,
        message: `A debuggable browser is already listening on ${host}:${port}.`,
      };
    }
    // (2b) ws-only = the user's OWN chrome://inspect profile: never adopt it
    // here (that stays behind the ⚙ advanced popover). Fall through to spawn
    // on the next free port.
  } else {
    if (await isPortOpen(host, port)) {
      return {
        success: true,
        alreadyRunning: true,
        host,
        port,
        message: `A debuggable browser is already listening on ${host}:${port}.`,
      };
    }
    // The user's real Chrome with local debugging on holds this port too, and it
    // is the BETTER target (their logins are in it). Launching a second browser
    // would fail on the port anyway.
    if (await isCdpSocketOpen(host, port)) {
      return {
        success: true,
        alreadyRunning: true,
        realProfile: true,
        host,
        port,
        message: `Your own Chrome is already exposing DevTools on ${host}:${port} — OmniClaw will drive that window, with your logged-in accounts.`,
      };
    }
  }

  const found = findBrowser(preferred);
  if (!found) {
    throw chromeNotFound();
  }

  // Managed spawns never fight over an occupied port: take the requested one
  // when fully free, else the next free port.
  let targetPort = port;
  if (managed) {
    const probe = await probeCdp(host, port);
    targetPort = probe.open ? await firstFreePort(host, port + 1) : port;
    if (!targetPort) {
      throw new Error(`No free debug port found near ${host}:${port} for the managed browser.`);
    }
  }

  const profile = debugProfileDir(found.name);
  const returning = profileHasSession(profile);
  fs.mkdirSync(profile, { recursive: true });
  // Without this Chrome opens its welcome wizard and the first screenshot an
  // agent takes is of a setup screen instead of the page it asked for.
  try { fs.writeFileSync(path.join(profile, "First Run"), ""); } catch { /* cosmetic */ }

  const args = [
    `--remote-debugging-port=${targetPort}`,
    `--user-data-dir=${profile}`,
    // Chrome 111+ rejects DevTools WebSocket upgrades carrying an Origin header
    // it does not recognise. Node's ws client sends none, but the check also
    // trips for other clients, and allowing it costs nothing on loopback.
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationGuideModelDownloading",
    // Headless is tests-only (OMNICLAW_TEST_HEADLESS=1): the managed window is
    // headed by design so the user can log in once.
    ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    startUrl,
  ];

  // Record ownership BEFORE spawning, not after. A second OmniClaw starting up
  // concurrently reads this file to decide whether a managed browser belongs to
  // a dead run. If the record were written after the spawn, that reader would
  // see "no live owner" during the gap and kill the browser we had just
  // launched — a real race, since the test suite (and a dev server beside the
  // packaged exe) starts servers in parallel.
  writeOwnerRecord(targetPort);

  const child = spawn(found.path, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();

  let spawnError = null;
  child.on("error", (error) => { spawnError = error; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start ${found.name}: ${spawnError.message}`);
    if (await isPortOpen(host, targetPort)) {
      if (managed) lastManaged = { host, port: targetPort };
      return {
        success: true,
        alreadyRunning: false,
        reused: false,
        browser: found.name,
        browserPath: found.path,
        profileDir: profile,
        signedIn: returning,
        host,
        port: targetPort,
        message: returning
          ? `Launched ${found.name} on ${host}:${targetPort} using your OmniClaw profile — the sites you signed into here before are still signed in.`
          : `Launched ${found.name} on ${host}:${targetPort}. This is a fresh OmniClaw profile: sign into Google (or turn on Chrome sync) in this window once, and it stays signed in for every later session.`,
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  throw new Error(
    `${found.name} started but never opened the debug port on ${host}:${targetPort} within ${Math.round(timeoutMs / 1000)}s. ` +
      "If a window did appear, close it and try again."
  );
}

/** Everything the UI needs to decide what to offer, in one call. */
export async function browserLaunchStatus({ host = "localhost", port = 9222 } = {}) {
  const found = findBrowser();
  const profileDir = found ? debugProfileDir(found.name) : null;
  const probe = await probeCdp(host, port);
  return {
    portOpen: probe.open,
    transport: probe.transport,
    // ws transport == the chrome://inspect toggle == the user's OWN profile,
    // logins included. http == a separate profile OmniClaw launched.
    realProfile: probe.transport === "ws",
    host,
    port,
    browser: found?.name || null,
    browserPath: found?.path || null,
    profileDir,
    signedIn: profileDir ? profileHasSession(profileDir) : false,
    running: found ? isBrowserRunning(found.exe) : false,
    canLaunch: Boolean(found),
    useMyChrome: MY_CHROME_STEPS,
  };
}

/**
 * The one-time-per-Chrome-restart ritual that exposes the user's REAL profile.
 * Kept here as data so the panel, the tool hint and the docs cannot drift apart.
 */
export const MY_CHROME_STEPS = {
  url: "chrome://inspect/#remote-debugging",
  steps: [
    "Apne normal Chrome me chrome://inspect/#remote-debugging kholo (jahan aapka account already logged in hai).",
    "\"Local debugging\" / \"Enable remote debugging\" toggle ON karo.",
    "Chrome jo prompt de use Allow karo — wo 127.0.0.1:9222 par DevTools khol dega.",
    "Yahan wapas aake Connect dabao. Aage OmniClaw usi window me kaam karega, aapke logins ke saath.",
  ],
  why: "Chrome 136+ --remote-debugging-port ko default profile par ignore karta hai (cookie-theft hardening). chrome://inspect ka toggle iska supported raasta hai — koi cookie copy nahi hoti.",
};

export default {
  findBrowser,
  launchDebugBrowser,
  browserLaunchStatus,
  isPortOpen,
  isCdpSocketOpen,
  probeCdp,
  debugProfileDir,
  profileHasSession,
  MY_CHROME_STEPS,
};
