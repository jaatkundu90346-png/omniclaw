// Picker STATE smoke: favorites persist + stale-fan guard. Mocked APIs only.
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

const A_MODELS = Array.from({ length: 12 }, (_, i) => ({ id: `a-model-${i + 1}` }));
const B_MODELS = Array.from({ length: 12 }, (_, i) => ({ id: `b-model-${i + 1}` }));
const config = {
  provider: { model: "a-model-1", baseUrl: "https://a.test/v1", apiKeyProviderId: "a-key", label: "Conn A" },
  providerProfiles: { B: { model: "b-model-1", baseUrl: "https://b.test/v1", apiKeyProviderId: "b-key" } },
  providerSecrets: [
    { providerId: "a-key", configured: true, masked: "sk-…a" },
    { providerId: "b-key", configured: true, masked: "sk-…b" },
  ],
};
let slowB = false;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  const send = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (u.pathname === "/harness") { res.setHeader("Content-Type", "text/html"); res.end(HARNESS); return; }
  if (u.pathname === "/api/config") return send(config);
  if (u.pathname === "/api/models") return send({ ok: true, models: A_MODELS });
  if (u.pathname === "/api/provider/models") {
    if (slowB) await new Promise((r) => setTimeout(r, 600));
    return send({ ok: true, models: B_MODELS });
  }
  try {
    const file = path.resolve(root, `.${u.pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const ct = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.setHeader("Content-Type", ct);
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
try {
  console.log("startup: isolated host, favorites + stale-fan checks");
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

  step = "favorite persists and sections on reopen"; console.log(step);
  await page.click("#pick");
  await page.waitForFunction(() => document.querySelector('.model-row[title^="a-model-3"]'), null, { timeout: 8000 });
  const wrap = page.locator(".model-row-wrap", { has: page.locator('.model-row[title^="a-model-3"]') });
  await wrap.locator(".row-icon", { hasText: "☆" }).click();
  await page.keyboard.press("Escape");
  await page.click("#pick");
  await page.waitForFunction(() => [...document.querySelectorAll(".popover .pop-label")].some((x) => x.textContent === "Favorites"), null, { timeout: 8000 });
  const favStored = await page.evaluate(() => JSON.parse(localStorage.getItem("omniclaw.next.favoriteModels.v1") || "[]"));
  assert.ok(favStored.some((r) => r.model === "a-model-3"));
  assert.ok(!JSON.stringify(favStored).includes("sk-"), "favorites hold no secrets");
  await page.keyboard.press("Escape");

  step = "stale fan cannot overwrite newer state"; console.log(step);
  slowB = true;
  await page.click("#pick"); // fan 1: B slow
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  slowB = false;
  await page.click("#pick"); // fan 2: fast
  await page.waitForFunction(() => /\d+ models?/.test(document.querySelector(".model-picker .pop-label[role=status]")?.textContent || ""), null, { timeout: 8000 });
  assert.ok((await page.locator(".model-row").count()) >= 20, "newest fan painted fully");
  await page.keyboard.press("Escape");

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: favorites, stale fan");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
