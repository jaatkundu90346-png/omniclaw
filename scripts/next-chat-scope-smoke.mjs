// Chat-history scoping smoke: projects show only their own sessions; legacy
// rows live under pinned collapsed "Older chats"; duplicate labels get dates.
// Isolated static host, no backend, never touches live data. R14: 24s cap.
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
const HARNESS = "<!doctype html><html><body><div id=s></div></body></html>";
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  if (u.pathname === "/harness") { res.setHeader("Content-Type", "text/html"); res.end(HARNESS); return; }
  try {
    const file = path.resolve(root, `.${u.pathname}`);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "text/html");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
const AMAN = "C:\\proj\\aman";
const HLO = "C:\\proj\\hlo";
const SESSIONS = [
  { id: "a1", label: "aman task", key: "agent:main:webchat:aman-task:ws:c-proj-aman", workspacePath: AMAN, channel: "webchat", updatedAt: new Date().toISOString() },
  { id: "h1", label: "hlo task", key: "agent:main:webchat:hlo-task:ws:c-proj-hlo", workspacePath: HLO, channel: "webchat", updatedAt: new Date().toISOString() },
  { id: "l1", label: "chat-09-09-03-01", key: "agent:main:webchat:chat-09-09-03-01", channel: "webchat", createdAt: "2026-09-09T03:01:00.000Z", updatedAt: "2026-09-09T03:01:00.000Z" },
  { id: "l2", label: "chat-09-09-03-01", key: "agent:main:webchat:chat-09-08-02-00", channel: "webchat", createdAt: "2026-09-08T02:00:00.000Z", updatedAt: "2026-09-08T02:00:00.000Z" },
];
try {
  console.log("startup: isolated host, grouping checks");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/harness`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ AMAN, HLO, SESSIONS }) => {
    const { store } = await import("/js/store.js");
    store.set({ sessions: SESSIONS, activeSessionId: "", showSystem: false });
    store.setWorkspace({ activePath: AMAN, activeId: "c-proj-aman", activeName: "aman", recents: [{ path: AMAN }, { path: HLO }], isDefault: false });
    const { mountSidebar } = await import("/js/ui/sidebar.js");
    mountSidebar(document.querySelector("#s"));
  }, { AMAN, HLO, SESSIONS });
  const rowsIn = async (name) => page.evaluate((n) => {
    const rows = [...document.querySelectorAll("#sidebar .proj-row")];
    const row = rows.find((r) => r.textContent.trim().startsWith(n));
    if (!row) return null;
    const out = [];
    let el = row.nextElementSibling;
    while (el && !el.classList.contains("proj-row")) {
      out.push(...[...el.querySelectorAll(".sess-row .lbl")].map((x) => x.textContent.trim()));
      el = el.nextElementSibling;
    }
    return { collapsed: row.classList.contains("collapsed"), rows: out };
  }, name);

  step = "aman shows only its own chat"; console.log(step);
  let aman = await rowsIn("aman");
  assert.deepEqual(aman.rows, ["aman task"]);
  assert.equal(aman.collapsed, false);

  step = "legacy rows sit in collapsed Older chats with dates"; console.log(step);
  let older = await rowsIn("Older chats");
  assert.equal(older.collapsed, true);
  assert.equal(older.rows.length, 0);
  await page.locator("#sidebar .proj-row", { hasText: "Older chats" }).click();
  older = await rowsIn("Older chats");
  assert.equal(older.rows.length, 2);
  assert.ok(older.rows[0].includes("·") && older.rows[1].includes("·"), `dup labels dated: ${JSON.stringify(older.rows)}`);
  assert.ok(!older.rows.some((t) => /c-proj-|ws:|unknown workspace/i.test(t)), "no slugs leaked");

  step = "switching project never moves chats"; console.log(step);
  await page.evaluate(async ({ HLO }) => {
    const { store } = await import("/js/store.js");
    store.setWorkspace({ activePath: HLO, activeId: "c-proj-hlo", activeName: "hlo", recents: store.get().workspace.recents, isDefault: false });
  }, { HLO });
  aman = await rowsIn("aman");
  assert.deepEqual(aman.rows, [], "aman collapsed, chats stay inside");
  const hlo = await rowsIn("hlo");
  assert.deepEqual(hlo.rows, ["hlo task"]);

  step = "no page errors"; console.log(step);
  assert.deepEqual(errors, []);
  console.log("PASS: per-project lists, older bucket, dup dates, stable switch");
} catch (e) { console.error(`FAIL at ${step}`, e); code = 1; }
finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  clearTimeout(timer);
}
process.exit(code);
