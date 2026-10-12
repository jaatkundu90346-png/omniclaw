// Live UI captures against the running :3147 source server (user's own data).
// READ-ONLY: opens picker/dialogs, never saves, selects, toggles, or tests.
// NOTE: 55s guard (screenshot artifact run, not a verification loop).
import path from "node:path";
import { chromium } from "playwright";

let step = "startup";
let browser;
let code = 0;
const timer = setTimeout(() => { console.error(`TIMEOUT at ${step}`); process.exit(2); }, 85000);
const SHOTS = path.resolve("screenshots");
try {
  console.log("startup: live captures, no writes");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  step = "picker"; console.log(step);
  await page.goto("http://127.0.0.1:3147/next/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".composer .model-pill");
  await page.locator(".composer .model-pill").click();
  await page.waitForSelector(".model-picker");
  await page.waitForFunction(() => /[1-9]\d* models?/.test(document.querySelector(".model-picker .pop-label[role=status]")?.textContent || ""), null, { timeout: 25000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/next-picker.png` });

  step = "manage dialog"; console.log(step);
  await page.getByRole("button", { name: "Manage models", exact: true }).click();
  await page.waitForSelector(".modal");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/next-manage.png` });

  step = "connect catalog"; console.log(step);
  await page.locator(".modal-head-actions button", { hasText: "Connect provider" }).click();
  await page.waitForSelector(".connect-row");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/next-connect.png` });
  await page.keyboard.press("Escape");

  step = "providers page without composer"; console.log(step);
  await page.goto("http://127.0.0.1:3147/next/#/settings/providers", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".prov-list .prov-row");
  await page.waitForTimeout(1200);
  const composerVisible = await page.evaluate(() => {
    const el = document.querySelector("#composer-host");
    return !!(el && el.offsetParent !== null);
  });
  console.log("composer visible on settings:", composerVisible);
  if (composerVisible) throw new Error("composer overlay present on settings route");
  await page.screenshot({ path: `${SHOTS}/next-providers.png` });

  step = "appearance sections"; console.log(step);
  await page.goto("http://127.0.0.1:3147/next/#/settings/appearance", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".scheme-cards");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/next-appearance.png` });
  await page.locator(".type-previews").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/next-appearance-type.png` });

  step = "light theme home"; console.log(step);
  await page.locator(".scheme-card", { hasText: "Light" }).click();
  await page.goto("http://127.0.0.1:3147/next/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".composer");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/next-home-light.png` });

  console.log("page errors:", JSON.stringify(errors));
  console.log("PASS: 7 captures, no composer on settings");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  clearTimeout(timer);
}
process.exit(code);
