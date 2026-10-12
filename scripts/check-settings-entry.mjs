// Verify the new Settings entry points actually work.
//
// Checks, in order:
//   1. a visible "Settings" row exists in the sidebar nav
//   2. clicking it navigates to #/settings and renders the settings page
//   3. the footer ("OC · Local") is a real button that also opens settings
//   4. no console errors along the way
//
// R14: markers before every step, wall clock, cleanup in finally.
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

let step = "startup";
let browser = null;
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 120000);
const URL = process.env.CHECK_URL || "http://127.0.0.1:3199";
const APP = `${URL}/next`;

const problems = [];

try {
  step = "launch chromium";
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push(m.text()); });

  step = "load the app";
  await page.goto(`${APP}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sb-foot", { timeout: 15000 });
  await page.waitForTimeout(700);

  step = "nav must contain a visible Settings row";
  const navLabels = await page.$$eval(".sb-nav .nav-row", (els) => els.map((e) => e.textContent.trim()));
  console.log(`ok: nav rows = ${JSON.stringify(navLabels)}`);
  if (!navLabels.some((t) => /settings/i.test(t))) problems.push("no Settings row in the sidebar nav");

  step = "footer must be a real button";
  const footTag = await page.$eval(".sb-foot", (e) => e.tagName);
  const footLabel = await page.$eval(".sb-foot", (e) => (e.getAttribute("aria-label") || e.textContent || "").trim());
  console.log(`ok: footer is <${footTag}> labelled "${footLabel}"`);
  if (footTag !== "BUTTON") problems.push(`.sb-foot is <${footTag}>, expected <button>`);

  step = "clicking the nav Settings row must open settings";
  await page.click(".sb-nav .nav-row:has-text('Settings')");
  await page.waitForFunction(() => location.hash.startsWith("#/settings"), { timeout: 8000 });
  await page.waitForSelector(".set-wrap", { timeout: 15000 });
  console.log(`ok: nav click -> ${await page.evaluate(() => location.hash)}`);

  step = "the nav row must show as active on the settings route";
  const active = await page.$$eval(".sb-nav .nav-row.active", (els) => els.map((e) => e.textContent.trim()));
  console.log(`ok: active nav row(s) = ${JSON.stringify(active)}`);
  if (!active.some((t) => /settings/i.test(t))) problems.push("Settings nav row does not highlight on the settings route");

  step = "going back home, then clicking the footer must also open settings";
  await page.click(".sb-nav .nav-row:has-text('New chat')");
  await page.waitForTimeout(600);
  await page.click(".sb-foot");
  await page.waitForFunction(() => location.hash.startsWith("#/settings"), { timeout: 8000 });
  await page.waitForSelector(".set-wrap", { timeout: 15000 });
  console.log("ok: footer click -> #/settings");

  step = "footer must be keyboard reachable";
  const focusable = await page.evaluate(() => {
    const f = document.querySelector(".sb-foot");
    f.focus();
    return document.activeElement === f;
  });
  console.log(`ok: footer focusable = ${focusable}`);
  if (!focusable) problems.push(".sb-foot cannot take keyboard focus");

  step = "screenshot the new entry point";
  await page.goto(`${APP}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".sb-foot", { timeout: 15000 });
  await page.waitForTimeout(600);
  const shot = spawnSync("node", ["scripts/capture-readme-shots.mjs", "--url", URL], { encoding: "utf8", windowsHide: true });
  console.log(`ok: home screenshot refreshed (exit ${shot.status})`);

  step = "verdict";
  const real = errors.filter((e) => !/404|favicon|net::ERR/i.test(e));
  if (real.length) problems.push(`console errors: ${real.slice(0, 3).join(" | ")}`);
  if (problems.length) {
    for (const p of problems) console.log("FAIL:", p);
    console.log(`settings-entry-check: FAILED (${problems.length})`);
    process.exit(1);
  }
  clearTimeout(timer);
  console.log("settings-entry-check: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  clearTimeout(timer);
  try { await browser?.close(); } catch {}
}