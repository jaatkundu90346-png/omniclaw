// Isolated L3 browser smoke for the focused Code workspace layout.
// Uses a fresh data directory and port; never touches the user's live config/session.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
const PORT = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP_ROOT = process.env.OC_TMP_ROOT || "C:\\Users\\PATEL COMPUTERS\\AppData\\Local\\Temp\\opencode";
const deadline = setTimeout(() => {
  console.error("TIMEOUT at Code workspace browser smoke");
  void cleanup(2);
}, 25000);

let tempDir = "";
let server = null;
let browser = null;
let passed = 0;
let failed = 0;
let cleaning = false;
const serverOutput = [];
function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function cleanup(exitCode) {
  if (cleaning) return;
  cleaning = true;
  clearTimeout(deadline);
  console.log("STEP cleanup: close browser, stop isolated server, remove isolated data");
  if (browser) {
    try { await Promise.race([browser.close(), delay(1000)]); } catch {}
  }
  if (server && server.exitCode == null) {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], {
        timeout: 1500, windowsHide: true, stdio: "ignore",
      });
    } else {
      server.kill();
    }
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      delay(1000),
    ]);
  }
  if (tempDir) {
    try { await rm(tempDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}

try {
  console.log("STEP 1: create isolated test data directory");
  await mkdir(TEMP_ROOT, { recursive: true });
  tempDir = await mkdtemp(path.join(TEMP_ROOT, "omniclaw-code-ui-"));

  console.log(`STEP 2: start isolated OmniClaw server on port ${PORT}`);
  server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, OMNICLAW_DATA_DIR: tempDir, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
  server.on("error", (error) => serverOutput.push(`spawn error: ${error.message}`));

  let ready = false;
  for (let attempt = 0; attempt < 15 && !ready; attempt++) {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 400);
    try {
      const response = await fetch(`${BASE}/api/health`, { signal: controller.signal });
      ready = response.ok;
      await response.body?.cancel();
    } catch { /* server is still starting */ }
    finally { clearTimeout(abort); }
    if (!ready) await delay(150);
  }
  check("isolated server starts", ready, serverOutput.join("").slice(-1000));
  if (!ready) throw new Error(`isolated server did not become ready; exit=${server.exitCode}; ${serverOutput.join("").slice(-1000)}`);

  console.log("STEP 3: open the actual /next UI");
  console.log("STEP 3a: launch browser");
  browser = await chromium.launch({ timeout: 6000 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await context.addInitScript(() => {
    // This smoke tests UI layout only. Prevent opening a persistent global SSE stream.
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 1; }
      close() { this.readyState = 2; }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  console.log("STEP 3b: navigate to UI");
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 5000 });
  await page.waitForSelector('.sb-nav a[href="#/code"]', { timeout: 5000 });

  console.log("STEP 4: enter Code workspace without changing the chat route");
  const routeBefore = await page.evaluate(() => location.hash);
  await page.locator('.sb-nav a[href="#/code"]').click();
  await page.waitForSelector(".shell.code-mode", { timeout: 3000 });
  check("Code workspace opens", await page.locator(".shell.code-mode").count() === 1);
  check("Files editor panel opens", await page.locator(".panel-tab.active").innerText().then((s) => /Files/i.test(s)).catch(() => false));
  check("chat route is preserved", (await page.evaluate(() => location.hash)) === routeBefore);

  console.log("STEP 5: exit Code workspace and verify narrow layout controls");
  await page.locator(".panel-mode-exit").click();
  await page.waitForFunction(() => !document.querySelector(".shell")?.classList.contains("code-mode"), {}, { timeout: 3000 });
  check("return-to-chat exits Code mode", await page.locator(".shell.code-mode").count() === 0);
  const layoutCss = await readFile(path.join(process.cwd(), "web-next/css/layout.css"), "utf8");
  check("narrow Code mode switches to an editor-first full-screen pane", /max-width:\s*760px[\s\S]*?\.shell\.code-mode[\s\S]*?grid-template-columns:\s*0\s+minmax\(0,\s*1fr\)\s+0/.test(layoutCss));
  check("mobile editor has a visible return-to-chat control", /panel-mode-exit/.test(await readFile(path.join(process.cwd(), "web-next/css/panel.css"), "utf8")));
  check("no uncaught browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} catch (error) {
  failed++;
  console.error(`SMOKE ERROR: ${error.stack || error.message}`);
} finally {
  await cleanup(failed ? 1 : 0);
}
