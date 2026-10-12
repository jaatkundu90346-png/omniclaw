// Plugins slice smoke: real /next page against mocked /api/apps + /api/plugins.
// Never touches live config/secrets. R14: progress per step, cleanup, 24s cap.
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
const HARNESS = "<!doctype html><html><body><main id=p></main></body></html>";

let catalog = {
  apps: [
    { id: "gmail", name: "Gmail", accent: "#ea4335", description: "Mail", configured: false, connected: false, account: null, scopes: ["openid", "email"], connectedAt: "", tokenExpiresAt: "", callbackUrl: "http://localhost:3147/api/apps/oauth/callback/gmail" },
    { id: "github", name: "GitHub", accent: "#24292f", description: "Repos", configured: true, connected: false, account: null, scopes: ["read:user", "repo"], connectedAt: "", tokenExpiresAt: "", callbackUrl: "http://localhost:3147/api/apps/oauth/callback/github" },
  ],
  computerUse: { enabled: false, allowWrite: false, allowDelete: false, allowedRoots: [] },
};
const calls = [];
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  const send = (obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const body = await new Promise((r) => { let s = ""; req.on("data", (c) => { s += c; }); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); });
  if (u.pathname === "/harness") { res.setHeader("Content-Type", "text/html"); res.end(HARNESS); return; }
  if (u.pathname === "/api/apps" && req.method === "GET") return send(catalog);
  if (u.pathname === "/api/apps/oauth/config" && req.method === "POST") {
    calls.push({ route: "oauth-config", body });
    catalog.apps.find((a) => a.id === body.provider).configured = true;
    return send(catalog);
  }
  if (u.pathname === "/api/apps/disconnect" && req.method === "POST") {
    calls.push({ route: "disconnect", body });
    const app = catalog.apps.find((a) => a.id === body.provider);
    app.connected = false; app.account = null;
    return send(catalog);
  }
  if (u.pathname === "/api/apps/computer-use" && req.method === "POST") {
    calls.push({ route: "computer-use", body });
    catalog.computerUse.enabled = body.enabled === true;
    return send(catalog);
  }
  if (u.pathname === "/api/plugins" && req.method === "GET") {
    return send({ plugins: [{ id: "p1", name: "P One", description: "demo plugin", tools: ["a", "b"], enabled: true }] });
  }
  if (u.pathname === "/api/plugins/toggle" && req.method === "POST") {
    calls.push({ route: "plugin-toggle", body });
    return send({ ok: true });
  }
  if (u.pathname === "/api/tools/run" && req.method === "POST") {
    calls.push({ route: "tool-run", body });
    if (body.tool === "github_list_repositories") return send({ result: { repositories: [{ name: "octo/demo" }] } });
    if (body.tool === "gmail_search_messages") return send({ result: { messages: [{ subject: "Hi", from: "a@b.c" }], count: 1 } });
    return send({ result: {} });
  }
  try {
    const file = path.resolve(root, `.${u.pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
try {
  console.log("startup: isolated host, mocked apps backend");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const mount = () => page.evaluate(async () => {
    const { mountPlugins } = await import("/js/ui/plugins.js");
    mountPlugins(document.querySelector("#p"));
  });

  step = "setup-required states + save shape"; console.log(step);
  await page.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });
  await mount();
  await page.waitForSelector(".connected-app-card");
  const badges = await page.locator(".connected-app-card .badge").allTextContents();
  assert.ok(badges.includes("setup needed") && badges.includes("ready to connect"));
  await page.locator('[data-app-card="gmail"] input[aria-label="OAuth client ID"]').fill("test-client-id");
  await page.locator('[data-app-card="gmail"] input[aria-label="OAuth client secret"]').fill("s3cr3t-value");
  await page.locator('[data-app-card="gmail"] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('[data-app-card="gmail"] .badge')?.textContent === "ready to connect");
  const saved = calls.find((c) => c.route === "oauth-config");
  assert.deepEqual(saved.body, { provider: "gmail", clientId: "test-client-id", clientSecret: "s3cr3t-value", scopes: "openid email" });
  const leaked = await page.evaluate(() => JSON.stringify(localStorage).includes("s3cr3t-value"));
  assert.equal(leaked, false);
  assert.equal(await page.locator('[data-app-card="gmail"] input[aria-label="OAuth client secret"]').inputValue(), "");

  step = "connected: test (read-only) + disconnect"; console.log(step);
  catalog.apps.find((a) => a.id === "github").connected = true;
  catalog.apps.find((a) => a.id === "github").account = { login: "octo" };
  await page.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });
  await mount();
  await page.waitForSelector(".connected-app-card");
  assert.ok((await page.locator('[data-app-card="github"]').textContent()).includes("octo"));
  await page.locator('[data-app-card="github"] button', { hasText: "Test connection" }).click();
  await page.waitForFunction(() => document.querySelector('[data-app-card="github"] [role="status"]')?.textContent.includes("octo/demo"));
  const toolCall = calls.find((c) => c.route === "tool-run");
  assert.deepEqual({ tool: toolCall.body.tool, input: toolCall.body.input }, { tool: "github_list_repositories", input: { limit: 1 } });
  await page.locator('[data-app-card="github"] button', { hasText: "Disconnect" }).click();
  await page.waitForFunction(() => document.querySelector('[data-app-card="github"] .badge')?.textContent === "ready to connect");
  assert.ok(calls.some((c) => c.route === "disconnect" && c.body.provider === "github"));

  step = "computer-use + installed + search"; console.log(step);
  await page.locator(".seg-tab", { hasText: "Computer Use" }).click();
  await page.locator(".computer-use-card button").click();
  assert.ok(calls.some((c) => c.route === "computer-use" && c.body.enabled === true));
  await page.waitForFunction(() => document.querySelector(".computer-use-card .badge")?.textContent === "enabled");
  await page.locator(".seg-tab", { hasText: "Installed" }).click();
  await page.locator(".catalog-row button", { hasText: "Disable" }).click();
  assert.ok(calls.some((c) => c.route === "plugin-toggle" && c.body.pluginId === "p1" && c.body.enabled === false));
  await page.locator(".seg-tab", { hasText: "Connected apps" }).click();
  await page.getByLabel("Search apps and plugins").fill("git");
  assert.equal(await page.locator('[data-app-card="gmail"]:visible').count(), 0);
  assert.equal(await page.locator('[data-app-card="github"]:visible').count(), 1);

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: setup states, save shape, read-only test, disconnect, computer-use, toggle, search");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
