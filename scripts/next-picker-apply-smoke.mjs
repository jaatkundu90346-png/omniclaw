// Picker APPLY smoke: atomic select commits exact connection+model in ONE call,
// keyboard selection, focus restore. Mocked APIs only, never live config.
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
let config = {
  provider: { model: "a-model-1", baseUrl: "https://a.test/v1", apiKeyProviderId: "a-key", label: "Conn A" },
  providerProfiles: { B: { model: "b-model-1", baseUrl: "https://b.test/v1", apiKeyProviderId: "b-key" } },
  providerSecrets: [
    { providerId: "a-key", configured: true, masked: "sk-…a" },
    { providerId: "b-key", configured: true, masked: "sk-…b" },
  ],
};
const calls = [];
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  const send = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const body = req.method === "POST"
    ? await new Promise((r) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); })
    : {};
  if (u.pathname === "/harness") { res.setHeader("Content-Type", "text/html"); res.end(HARNESS); return; }
  if (u.pathname === "/api/config") return send(config);
  if (u.pathname === "/api/provider/select" && req.method === "POST") {
    calls.push(body);
    if (body.profileId) {
      const p = { B: { baseUrl: "https://b.test/v1" } }[body.profileId];
      if (!p) return send({ ok: false, stage: "validate", error: "no such profile", scope: "global" }, 400);
      config.provider = { ...config.provider, baseUrl: p.baseUrl, model: body.model };
    } else {
      config.provider = { ...config.provider, model: body.model };
    }
    return send({ ok: true, stage: "done", scope: "global", applied: body, provider: config.provider });
  }
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
  console.log("startup: isolated host, atomic-apply checks");
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

  step = "profile row commits exact pair in one call"; console.log(step);
  await page.click("#pick");
  await page.waitForFunction(() => document.querySelector('.model-row[title^="b-model-5"]'), null, { timeout: 8000 });
  await page.locator('.model-row[title^="b-model-5"]').click();
  await page.waitForFunction(() => !document.querySelector(".popover"), null, { timeout: 8000 });
  assert.equal(config.provider.model, "b-model-5");
  assert.equal(config.provider.baseUrl, "https://b.test/v1");
  assert.deepEqual(calls, [{ profileId: "B", model: "b-model-5" }]);

  step = "keyboard Enter selects, Escape restores focus"; console.log(step);
  await page.click("#pick");
  await page.waitForFunction(() => document.querySelector(".model-row"), null, { timeout: 8000 });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".popover"), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.activeElement.id), "pick");
  assert.equal(calls.length, 2);

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: atomic routing, keyboard apply, focus restore");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
