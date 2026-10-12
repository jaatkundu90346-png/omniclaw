// README screenshot capture.
//
// These are REAL captures of the running app — nothing here is mocked or
// hand-drawn. Each shot waits for a concrete, verifiable element before it
// fires, so a blank/half-painted frame can never end up in the README.
//
// Usage:  node scripts/capture-readme-shots.mjs [--url http://127.0.0.1:3199]
// Output: docs/images/*.png
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const outDir = path.join(rootDir, "docs", "images");

const urlArg = process.argv.indexOf("--url");
const BASE = (urlArg >= 0 ? process.argv[urlArg + 1] : process.env.OMNICLAW_URL) || "http://127.0.0.1:3199";
const APP = `${BASE}/next`;

let step = "startup";
let browser = null;
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 180000);

const consoleErrors = [];

try {
  step = "prepare output dir";
  fs.mkdirSync(outDir, { recursive: true });

  step = "launch chromium";
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e.message)));

  const shot = async (name, { route = "#/", waitFor, settle = 900 } = {}) => {
    step = `shot ${name}`;
    await page.goto(`${APP}/${route}`, { waitUntil: "domcontentloaded" });
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 15000 });
    }
    // Let fonts, the SSE poll and the panel layout settle so the frame is stable.
    await page.waitForTimeout(settle);
    const file = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`ok: ${name}.png (${kb} KB)  <- ${route}`);
  };

  // Settings deliberately HIDES the composer (draft DOM is kept but display:none),
  // so it needs its own wait target — `.composer` stays in the DOM but hidden,
  // and waiting for visibility there times out.
  await shot("home", { route: "#/", waitFor: ".composer" });
  await shot("tools", { route: "#/tools", waitFor: ".composer", settle: 1400 });
  await shot("settings", { route: "#/settings", waitFor: ".set-wrap", settle: 1400 });
  await shot("changes", { route: "#/changes", waitFor: ".composer", settle: 1600 });
  await shot("plugins", { route: "#/plugins", waitFor: ".composer", settle: 1400 });

  // The Skills & Tools page is the one that shows the real tool surface, so it
  // is worth a taller frame.
  step = "shot tools full page";
  await page.goto(`${APP}/#/tools`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".composer", { timeout: 15000 });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(outDir, "tools-full.png"), fullPage: true });
  console.log("ok: tools-full.png (full page)");

  step = "verdict";
  if (consoleErrors.length) {
    // Not fatal for a docs capture, but it must be visible rather than hidden.
    console.warn(`note: ${consoleErrors.length} page error(s) during capture:`);
    for (const e of [...new Set(consoleErrors)].slice(0, 5)) console.warn(`  - ${e}`);
  }
  clearTimeout(timer);
  console.log(`README shots written to ${outDir}`);
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  clearTimeout(timer);
  try { await browser?.close(); } catch {}
}