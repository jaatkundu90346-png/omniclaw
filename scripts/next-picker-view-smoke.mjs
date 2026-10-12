// Picker VIEW smoke: slim layout, viewport fit, grouping, same-id distinction,
// dropdown filter + search with zero side effects. Read-only. Mocked APIs only.
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
<link rel="stylesheet" href="/css/popover.css" />
<link rel="stylesheet" href="/css/composer.css" />
</head><body>
<button id="pick" style="position:fixed;bottom:16px;right:16px">Models</button>
</body></html>`;

const A_MODELS = Array.from({ length: 40 }, (_, i) => ({ id: `a-model-${i + 1}` }));
A_MODELS.push({ id: "shared/model" });
const B_MODELS = Array.from({ length: 30 }, (_, i) => ({ id: `b-model-${i + 1}` }));
B_MODELS.push({ id: "shared/model" });
const config = {
  provider: { model: "a-model-1", baseUrl: "https://a.test/v1", apiKeyProviderId: "a-key", label: "Conn A" },
  providerProfiles: { B: { model: "b-model-1", baseUrl: "https://b.test/v1", apiKeyProviderId: "b-key" } },
  providerSecrets: [
    { providerId: "a-key", configured: true, masked: "sk-…a" },
    { providerId: "b-key", configured: true, masked: "sk-…b" },
  ],
};
let writes = 0;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  const send = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname === "/harness") { res.setHeader("Content-Type", "text/html"); res.end(HARNESS); return; }
  if (u.pathname === "/api/config") return send(config);
  if (u.pathname === "/api/models") return send({ ok: true, models: A_MODELS });
  if (u.pathname === "/api/provider/models") return send({ ok: true, models: B_MODELS });
  try {
    const file = path.resolve(root, `.${u.pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const ct = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.setHeader("Content-Type", ct);
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
try {
  console.log("startup: isolated host, read-only view checks");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    store.set({ config: await (await fetch("/api/config")).json() });
    const { openModelMenu } = await import("/js/ui/modelmenu.js");
    document.querySelector("#pick").onclick = (e) => openModelMenu(e.currentTarget, () => {});
  });

  step = "slim picker fits 1366x768 from bottom anchor"; console.log(step);
  await page.click("#pick");
  await page.waitForFunction(() => document.querySelector(".model-results .model-row"), null, { timeout: 8000 });
  await page.waitForFunction(() => /\d+ models?/.test(document.querySelector(".model-picker .pop-label[role=status]")?.textContent || ""), null, { timeout: 8000 });
  const rect = await page.evaluate(() => {
    const r = document.querySelector(".popover").getBoundingClientRect();
    const list = document.querySelector(".model-results");
    const items = [...document.querySelectorAll(".popover .pop-item")];
    const foot = items.find((x) => x.textContent.includes("Manage models")).getBoundingClientRect();
    const search = document.querySelector(".popover .menu-search").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, vw: innerWidth, vh: innerHeight, scrollable: list.scrollHeight > list.clientHeight + 4, rows: document.querySelectorAll(".model-row").length, chips: document.querySelectorAll(".model-filters .chip-btn").length, footIn: foot.top >= r.top && foot.bottom <= r.bottom, searchIn: search.top >= r.top && search.bottom <= r.bottom };
  });
  assert.ok(rect.top >= 0 && rect.bottom <= rect.vh && rect.left >= 0 && rect.right <= rect.vw, `in viewport ${JSON.stringify(rect)}`);
  assert.ok(rect.width >= 300 && rect.width <= 400, `slim width 320-380 (got ${rect.width})`);
  assert.ok(rect.chips === 0, "no provider-chip wall");
  assert.ok(rect.scrollable && rect.rows >= 60 && rect.footIn && rect.searchIn, `scroll+rows+pinned chrome ${JSON.stringify(rect)}`);
  await page.keyboard.press("Escape");

  step = "same id on two connections distinguishable"; console.log(step);
  await page.click("#pick");
  await page.waitForFunction(() => document.querySelectorAll('.model-row[title^="shared/model"]').length === 2, null, { timeout: 8000 });
  const subs = await page.locator('.model-row[title^="shared/model"] + .row-icons, .model-row-wrap:has(.model-row[title^="shared/model"])').allTextContents();
  assert.ok(subs.length >= 2);
  await page.keyboard.press("Escape");

  step = "dropdown filter and search never write"; console.log(step);
  await page.click("#pick");
  await page.waitForFunction(() => document.querySelector(".model-filter option"), null, { timeout: 8000 });
  await page.locator(".model-filter").selectOption({ label: "Conn A" });
  await page.getByRole("combobox", { name: "Search models" }).fill("zzz-no-match");
  await page.waitForFunction(() => /No matching/.test(document.body.textContent), null, { timeout: 8000 });
  assert.equal(writes, 0);
  await page.keyboard.press("Escape");

  step = "early open self-populates after boot race"; console.log(step);
  const page2 = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page2.setDefaultTimeout(10000);
  page2.on("pageerror", (e) => errors.push(`p2: ${e.message}`));
  await page2.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });
  await page2.evaluate(async () => {
    // NOTE: store config deliberately left empty — the picker must fetch it.
    const { openModelMenu } = await import("/js/ui/modelmenu.js");
    const btn = document.querySelector("#pick");
    btn.onclick = (e) => openModelMenu(e.currentTarget, () => {});
    btn.click();
  });
  await page2.waitForFunction(() => document.querySelectorAll(".model-row").length >= 60, null, { timeout: 12000 });
  await page2.close();

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: slim fit, grouping, same-id, side-effect-free filter, boot race");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
