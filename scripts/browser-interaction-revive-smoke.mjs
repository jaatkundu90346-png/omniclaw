// Smoke test: browser INTERACTION tools auto-revive a dead session (iteration 21).
// Bug: iteration 2 gave view()/screenshot() auto-reopen, but click/type/press/
// scroll/wait/evaluate/back/forward still hard-failed with "No active browser
// session" the moment the 5-min idle cleanup fired — so the model could open a
// page, then error on the very next click. Uses the REAL Playwright Chromium.
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

const PORT = 39514;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end('<html><head><title>revive-test</title></head><body><h1>Hi</h1><button id="b" onclick="document.title=\'clicked\'">go</button><input id="t"/></body></html>');
});
await new Promise((r) => server.listen(PORT, r));

const browser = new BrowserPlaywright({ rootDir: ROOT, headless: true, sessionId: `rev_${Date.now()}` });
const url = `http://localhost:${PORT}/`;

// Open, then simulate the idle-timeout by closing the session.
let opened = await browser.open({ url });
check("initial open succeeded", opened?.success === true, JSON.stringify(opened).slice(0, 150));

// ── click after session death → auto-revives, does not hard-fail ────────────
await browser.close({});
let r = await browser.click({ selector: "#b" });
check("click after session death auto-revived (no 'open first' error)", r?.success === true, JSON.stringify(r).slice(0, 200));

// ── type after session death → auto-revives ─────────────────────────────────
await browser.close({});
r = await browser.type({ selector: "#t", text: "hello" });
check("type after session death auto-revived", r?.success === true, JSON.stringify(r).slice(0, 200));

// ── scroll after session death → auto-revives ───────────────────────────────
await browser.close({});
r = await browser.scroll({ direction: "down", amount: 100 });
check("scroll after session death auto-revived", !r?.error, JSON.stringify(r).slice(0, 200));

// ── evaluate after session death → auto-revives ─────────────────────────────
await browser.close({});
r = await browser.evaluate({ script: "document.title" });
check("evaluate after session death auto-revived", !r?.error, JSON.stringify(r).slice(0, 200));

// ── A fresh instance that NEVER opened still gives the clear error ──────────
const fresh = new BrowserPlaywright({ rootDir: ROOT, headless: true, sessionId: `fresh_${Date.now()}` });
r = await fresh.click({ selector: "#b" });
check("never-opened click still returns clear 'open first' error", /No active browser session/.test(String(r?.error)), JSON.stringify(r));

await browser.close({});
server.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
