// Slice 1 smoke: welcome prompts, sidebar search, composer IME guard.
// Isolated static host + mocked /api/* (never touches live config/sessions).
// R14: progress before each step, cleanup in finally, process.exit, 24s cap.
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
const HARNESS = "<!doctype html><html><body><div id=e></div><div id=s></div><div id=c></div></body></html>";
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://local").pathname;
  if (pathname === "/harness") {
    res.setHeader("Content-Type", "text/html");
    res.end(HARNESS);
    return;
  }
  try {
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
try {
  console.log("startup: isolated host, mocked APIs only");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = {
      "/api/config": { provider: { model: "openai/gpt-test", baseUrl: "https://example.test/v1" }, providerProfiles: {} },
      "/api/git/status": { isRepo: false },
      "/api/sessions": { sessions: [] },
      "/api/health": { provider: { ready: true }, version: "0.0-test" },
      "/api/agents": { agents: [] },
      "/api/schedules": { schedules: [] },
    }[url.pathname] ?? {};
    await route.fulfill({ json });
  });
  await page.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });

  step = "welcome cards carry useful prompts"; console.log(step);
  const empty = await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    store.setWorkspace({ activePath: "C:\\proj\\demo", activeId: "testws", activeName: "demo", recents: [], isDefault: false });
    const { mountEmpty } = await import("/js/ui/empty.js");
    mountEmpty(document.querySelector("#e"));
    const cards = [...document.querySelectorAll(".suggest-card")];
    let got = "";
    window.addEventListener("oc:suggest", (e) => { got = e.detail.prompt; }, { once: true });
    cards[0].click();
    return { n: cards.length, prompts: cards.map((c) => c.dataset.prompt || ""), got };
  });
  assert.equal(empty.n, 4);
  assert.ok(empty.prompts.every((p) => p.length > 20));
  assert.ok(empty.got.length > 20);

  step = "sidebar search filters, active marked"; console.log(step);
  const side = await page.evaluate(async () => {
    const { store } = await import("/js/store.js");
    const { workspaceIdForPath } = await import("/js/utils/path.js");
    const wsId = workspaceIdForPath("C:\\proj\\demo");
    const now = new Date().toISOString();
    store.set({
      sessions: [
        { id: "s1", label: "Alpha task", key: `agent:main:webchat:chat-a:ws:${wsId}`, channel: "webchat", updatedAt: now },
        { id: "s2", label: "Beta task", key: `agent:main:webchat:chat-b:ws:${wsId}`, channel: "webchat", updatedAt: now },
        { id: "s3", label: "hb", key: `agent:main:heartbeat:hb-1:ws:${wsId}`, channel: "heartbeat", updatedAt: now },
      ],
      activeSessionId: "s1",
      showSystem: false,
    });
    store.setWorkspace({ activePath: "C:\\proj\\demo", activeId: wsId, activeName: "demo", recents: [{ path: "C:\\proj\\demo" }], isDefault: false });
    const { mountSidebar } = await import("/js/ui/sidebar.js");
    mountSidebar(document.querySelector("#s"));
    // NOTE: mountSidebar re-ids its host to #sidebar.
    const before = document.querySelectorAll("#sidebar .sess-row").length;
    document.querySelector('#sidebar [aria-label="Search conversations"]').click();
    const input = document.querySelector("#sidebar .sb-search input");
    input.value = "alpha";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const after = [...document.querySelectorAll("#sidebar .sess-row")].map((r) => r.textContent.trim());
    const active = document.querySelector("#sidebar .sess-row.active")?.getAttribute("aria-current");
    return { before, after, active };
  });
  assert.equal(side.before, 2);
  assert.deepEqual(side.after, ["Alpha task"]);
  assert.equal(side.active, "true");

  step = "composer IME Enter does not send"; console.log(step);
  const comp = await page.evaluate(async () => {
    const { mountComposer } = await import("/js/ui/composer.js");
    const calls = [];
    const c = mountComposer(document.querySelector("#c"), { onSend: (t) => calls.push(t) });
    const ta = c.textarea;
    ta.value = "hello";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    const kept = ta.value;
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return { kept, calls };
  });
  assert.equal(comp.kept, "hello");
  assert.deepEqual(comp.calls, ["hello"]);

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: welcome prompts, sidebar search, IME guard");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
