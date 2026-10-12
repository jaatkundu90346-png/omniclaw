// Appearance smoke: scheme/preset/contrast/opacity/fonts/wrap/reset/invalid.
// Local DOM + localStorage only — no backend. R14: progress, cleanup, 24s cap.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

let step = "startup";
let browser;
let code = 0;
const timer = setTimeout(() => { console.error(`TIMEOUT at ${step}`); process.exit(2); }, 24000);
const root = path.resolve("web-next");
const HARNESS = `<!doctype html><html><head>
<link rel="stylesheet" href="/css/tokens.css" />
<link rel="stylesheet" href="/css/base.css" />
<link rel="stylesheet" href="/css/settings.css" />
<link rel="stylesheet" href="/css/thread.css" />
<link rel="stylesheet" href="/css/panel.css" />
</head><body><main class="view" id=s></main></body></html>`;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  if (u.pathname === "/harness") { res.setHeader("Content-Type", "text/html"); res.end(HARNESS); return; }
  try {
    const file = path.resolve(root, `.${u.pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const ct = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.setHeader("Content-Type", ct);
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
try {
  console.log("startup: isolated host, appearance checks");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { mountSettings } = await import("/js/ui/settings.js");
    mountSettings(document.querySelector("#s"), "appearance");
  });

  step = "scheme applies immediately"; console.log(step);
  await page.locator(".scheme-card", { hasText: "Light" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");

  step = "preset + contrast + opacity"; console.log(step);
  await page.locator(".preset-card", { hasText: "Ocean" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.preset), "ocean");
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  assert.ok(accent.length > 0, "accent token resolves");
  await page.getByRole("button", { name: "High", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.contrast), "high");
  await page.locator(".opacity-row input").fill("90");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.translucent), "1");
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--sur-alpha")), "0.9");

  step = "fonts + sizes apply"; console.log(step);
  await page.getByLabel("Interface font").selectOption("georgia");
  assert.ok((await page.evaluate(() => document.documentElement.style.getPropertyValue("--font"))).includes("Georgia"));
  await page.getByLabel("Interface size").fill("16");
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue("--fs")), "16px");
  await page.getByLabel("Monospace font").selectOption("consolas");
  assert.ok((await page.evaluate(() => document.documentElement.style.getPropertyValue("--font-mono"))).includes("Consolas"));

  step = "wrap toggles flip root classes"; console.log(step);
  await page.getByRole("button", { name: /^Code blocks/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("wrap-code")), true);
  await page.getByRole("button", { name: /^Diff views/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("wrap-diff")), true);

  step = "persistence across reload"; console.log(step);
  await page.reload({ waitUntil: "domcontentloaded" });
  const persisted = await page.evaluate(async () => {
    const { initStore, applyTheme, applyAppearance, store } = await import("/js/store.js");
    initStore();
    applyTheme();
    applyAppearance();
    return {
      preset: document.documentElement.dataset.preset,
      theme: document.documentElement.dataset.theme,
      uiSize: store.get().appearance.uiSize,
    };
  });
  assert.equal(persisted.preset, "ocean");
  assert.equal(persisted.theme, "light");
  assert.equal(persisted.uiSize, 16);

  step = "invalid prefs recover to defaults"; console.log(step);
  const recovered = await page.evaluate(async () => {
    // Garbage types/unknown enums → defaults; out-of-range numbers clamp.
    localStorage.setItem("omniclaw.next.v1", JSON.stringify({ appearance: { v: 99, preset: "neon", opacity: "opaque", uiSize: "huge", wrapCode: "yes" } }));
    const { initStore, applyAppearance, store } = await import("/js/store.js");
    initStore();
    applyAppearance();
    const first = { preset: document.documentElement.dataset.preset, opacity: store.get().appearance.opacity, uiSize: store.get().appearance.uiSize, wrap: document.documentElement.classList.contains("wrap-code") };
    localStorage.setItem("omniclaw.next.v1", JSON.stringify({ appearance: { v: 1, opacity: 3, uiSize: 99 } }));
    initStore();
    const clamped = { opacity: store.get().appearance.opacity, uiSize: store.get().appearance.uiSize };
    return { first, clamped };
  });
  assert.deepEqual(recovered.first, { preset: "neutral", opacity: 100, uiSize: 14, wrap: false });
  assert.deepEqual(recovered.clamped, { opacity: 85, uiSize: 16 });

  step = "reset all restores defaults"; console.log(step);
  await page.evaluate(async () => {
    const { mountSettings } = await import("/js/ui/settings.js");
    mountSettings(document.querySelector("#s"), "appearance");
  });
  await page.getByRole("button", { name: "Reset all appearance" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.preset), "neutral");

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: scheme, preset, contrast, opacity, fonts, wrap, persist, recover, reset");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
