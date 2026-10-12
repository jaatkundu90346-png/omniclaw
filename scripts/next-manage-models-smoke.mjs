// Manage-models + Connect-flow smoke: visibility, hidden-active, manual add,
// connect catalog→configure→save(apply:false)→use-in-chat. Mocked APIs only.
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
<link rel="stylesheet" href="/css/dialogs.css" />
<link rel="stylesheet" href="/css/settings.css" />
</head><body></body></html>`;

let config = {
  provider: { model: "m-1", baseUrl: "https://a.test/v1", apiKeyProviderId: "a-key", label: "Conn A" },
  providerProfiles: {
    B: { model: "m-1", baseUrl: "https://b.test/v1", apiKeyProviderId: "b-key" },
    NoKey: { model: "n-1", baseUrl: "https://nokey.test/v1", apiKeyProviderId: "nokey-key" },
  },
  providerSecrets: [{ providerId: "a-key", configured: true, masked: "sk-…a" }, { providerId: "b-key", configured: true, masked: "sk-…b" }],
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
  if (u.pathname === "/api/models") return send({ ok: true, models: [{ id: "m-1" }, { id: "m-2" }, { id: "m-3" }] });
  if (u.pathname === "/api/provider/models") {
    if (body.profileId === "B") return send({ ok: true, models: [{ id: "m-1" }, { id: "m-4" }] });
    if (body.profileId) return send({ ok: true, models: [{ id: "ollama-model" }] });
    return send({ ok: true, models: [{ id: "m-1" }] });
  }
  if (u.pathname === "/api/provider/profile/save") {
    calls.push({ route: "save", body });
    return send({ ok: true, profileId: "ollama-local" });
  }
  if (u.pathname === "/api/provider/select") {
    calls.push({ route: "select", body });
    config.provider = { ...config.provider, model: body.model };
    return send({ ok: true, stage: "done", scope: "global", applied: body, provider: config.provider });
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
  console.log("startup: isolated host, manage+connect checks");
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
    const { openManageModels } = await import("/js/ui/model-manager.js");
    window.__open = openManageModels;
  });

  step = "visibility toggles persist, hidden active stays valid"; console.log(step);
  await page.evaluate(() => window.__open());
  await page.waitForSelector(".manage-group");
  const groupA = page.locator(".manage-group", { hasText: "Conn A" });
  await groupA.locator(".manage-row .switch").first().click();
  const hidden = await page.evaluate(() => JSON.parse(localStorage.getItem("omniclaw.next.modelVisibility.v1") || "{}").hidden);
  assert.equal(hidden.length, 1);
  const indeterminate = await groupA.locator(".manage-ghead input[type=checkbox]").evaluate((el) => el.indeterminate);
  assert.equal(indeterminate, true);
  // Hide the ACTIVE model too (m-1 on active conn).
  await page.evaluate(() => window.__open && document.querySelector(".modal-veil")?.remove());
  await page.evaluate(() => window.__open());
  await page.waitForSelector(".manage-group");
  const note = await page.locator(".manage-note").textContent();
  assert.ok(/still active/.test(note), "hidden-active explained, not switched");
  assert.equal(config.provider.model, "m-1");

  step = "manual add on keyless connection"; console.log(step);
  const groupN = page.locator(".manage-group", { hasText: "NoKey" });
  await groupN.locator(".manage-add input").fill("typed-model-x");
  await groupN.locator(".manage-add button").click();
  await page.waitForSelector(".manage-row .tool-badge");
  assert.ok((await groupN.textContent()).includes("typed-model-x"));
  await page.keyboard.press("Escape");

  step = "connect flow saves apply:false then explicit use"; console.log(step);
  await page.evaluate(() => window.__open());
  await page.waitForSelector(".manage-group");
  await page.locator(".modal-head-actions button", { hasText: "Connect provider" }).click();
  await page.waitForSelector(".connect-row");
  await page.locator(".connect-row", { hasText: "Ollama" }).click();
  await page.locator(".connect-form button", { hasText: "Test" }).click();
  await page.waitForFunction(() => /Reachable/.test(document.querySelector(".connect-form")?.parentElement?.textContent || document.body.textContent), null, { timeout: 8000 });
  await page.locator(".connect-form button", { hasText: "Save connection" }).click();
  await page.waitForSelector(".connect-form [role=status]");
  const saved = calls.find((c) => c.route === "save");
  assert.equal(saved.body.apply, false);
  assert.ok(!("apiKey" in saved.body) || saved.body.apiKey === "", "no key invented for keyless");
  await page.waitForFunction(() => [...document.querySelectorAll(".btn-row button")].some((b) => b.textContent.includes("Use in chat")), null, { timeout: 8000 });
  assert.equal(config.provider.model, "m-1", "save alone never moves chats");
  await page.locator(".btn-row button", { hasText: "Use in chat" }).click();
  await page.waitForFunction(() => !document.querySelector(".modal-veil"), null, { timeout: 8000 });
  const sel = calls.find((c) => c.route === "select");
  assert.deepEqual(sel.body, { profileId: "ollama-local", model: "ollama-model" });

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: visibility, hidden-active, manual add, connect flow");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
