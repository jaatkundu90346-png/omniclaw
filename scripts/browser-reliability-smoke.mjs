// Smoke test: browser tool reliability fixes (iteration 2 of the improvement loop).
//  1. browser_open on a dead local port → structured, actionable error (no raw throw)
//  2. dev-server startup race → open() retries until the port starts listening
//  3. view()/screenshot() after the session died → auto-reopen last URL (no
//     "No active browser session" round-waster)
// Uses the REAL Playwright Chromium — this is a live end-to-end proof.
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { BrowserPlaywright } = await import(pathToFileURL(path.join(ROOT, "src/core/browser-playwright.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const browser = new BrowserPlaywright({ rootDir: ROOT, headless: true });
const PORT = 39471; // unlikely to be in use

// ── 1. Dead local port → structured error with actionable hint ──────────────
let result = await browser.open({ url: `http://localhost:${PORT + 1}/` });
check("dead port: returns error object (no throw)", Boolean(result?.error), JSON.stringify(result).slice(0, 200));
check("dead port: hint names process_status + other-port behavior",
  /process_status/.test(String(result?.hint)) && /5174/.test(String(result?.hint)), result?.hint);

// ── 2. Startup race: server starts AFTER open() is called ────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><head><title>race-ok</title></head><body><h1>Dev server up</h1><p>content here so the render probe sees text on this page.</p><a href='#'>link</a></body></html>");
});
const openPromise = browser.open({ url: `http://localhost:${PORT}/` }); // port not listening yet
setTimeout(() => server.listen(PORT), 2000); // server comes up 2s later — inside the retry window
result = await openPromise;
check("startup race: open succeeded via retry", result?.success === true, JSON.stringify(result).slice(0, 250));
check("startup race: correct page title", result?.title === "race-ok", result?.title);

// ── 3. Session death → view()/screenshot() auto-reopen last URL ─────────────
await browser.close({}); // simulate the 5-min idle cleanup killing the session
let view = await browser.view({ format: "markdown" });
check("view after session death: auto-reopened", view?.success === true, JSON.stringify(view).slice(0, 250));
check("view: content actually extracted", String(view?.content || "").includes("Dev server up"), view?.content);
check("view: message says it auto-reopened", /auto-reopened/.test(String(view?.message)), view?.message);

await browser.close({});
let shot = await browser.screenshot({});
check("screenshot after session death: auto-reopened", Boolean(shot?.success && shot?.screenshotPath), JSON.stringify(shot).slice(0, 200));

// Fresh instance with NO last URL → still the clear old error (no phantom reopen).
const fresh = new BrowserPlaywright({ rootDir: ROOT, headless: true, sessionId: `fresh_${Date.now()}` });
view = await fresh.view({});
check("no-history view: clear 'open first' error", /No active browser session/.test(String(view?.error)), JSON.stringify(view));

await browser.close({});
server.close();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
