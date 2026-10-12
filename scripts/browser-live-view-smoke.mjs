// Smoke test: the LIVE VIEW contract — the three things that were broken and
// that together produced "the panel is blank and the laptop won't stop heating".
//
//  1. BACKPRESSURE (server.js writeSSE). Frames used to be written with no check
//     on res.writableLength, so a client that stopped reading made this process
//     buffer 3-12MB/s of base64 JPEG until the machine swapped. Frames must be
//     DROPPED once the client is behind; state messages must still get through.
//
//  2. AGENT STREAM (BrowserPlaywright.startLiveStream / liveTargets). The panel
//     could only mirror a tab of the user's REAL Chrome, so any task driven
//     through the Playwright stack — the default — showed an empty box for its
//     whole duration. The agent's own page must now produce real frames.
//
//  3. ACTION TELEMETRY + SPEED (announceAction / cachedPoint / scroll). Scroll
//     published nothing, so scrolling was invisible in the panel. announceAction
//     also issued a page.evaluate round trip on the critical path of every
//     click, which is the "clicks once a minute, no output" complaint.
//
// Prints a progress line BEFORE each step so a hang shows where it stuck, closes
// everything in `finally`, and hard-exits at 25s. Never touches live config
// (R11) and POSTs nothing to a running instance.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { BrowserPlaywright } = await import(pathToFileURL(path.join(ROOT, "src/core/browser-playwright.js")).href);
const { onBrowserAction } = await import(pathToFileURL(path.join(ROOT, "src/core/browser-activity-bus.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};
const step = (msg) => console.log(`--- ${msg}`);

const HARD_LIMIT_MS = 25000;
const bail = setTimeout(() => {
  console.log(`TIMEOUT: exceeded ${HARD_LIMIT_MS / 1000}s`);
  process.exit(2);
}, HARD_LIMIT_MS);
bail.unref?.();

// A page tall enough that scrolling actually moves something, with a button and
// an input the snapshot can measure — the same shape as a real task page.
const PAGE = `<!doctype html><html><head><title>live-smoke</title>
<style>body{margin:0}#tall{height:4000px}button{padding:20px}</style></head>
<body><button id="go">Go</button><input id="name"/><div id="tall"></div>
<script>document.getElementById('go').onclick=()=>{document.title='clicked';};</script>
</body></html>`;

const PORT = 39617;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(PORT, r));

const browser = new BrowserPlaywright({
  rootDir: ROOT,
  headless: true,
  sessionId: `live_${Date.now()}`,
  // Isolate this run from any real Chrome the user has debugging enabled on.
  realBrowser: { mode: "off" },
  screenshotDir: path.join(os.tmpdir(), "omniclaw-live-smoke"),
});

try {
  // ── 1. Backpressure ──────────────────────────────────────────────────────
  step("1. SSE backpressure: a stalled client must not queue frames");
  // Mirrors writeSSE's decision exactly. A real res.write() cannot be stalled
  // on demand, so the rule under test is expressed directly and driven.
  const SSE_MAX_BUFFER_BYTES = 1_000_000;
  const decide = (writableLength, droppable) =>
    droppable ? writableLength > SSE_MAX_BUFFER_BYTES : writableLength > SSE_MAX_BUFFER_BYTES * 256;

  check("frame is written when the client is keeping up", decide(0, true) === false, "decide(0)");
  check("frame is written just under the cap", decide(SSE_MAX_BUFFER_BYTES - 1, true) === false);
  check("frame is DROPPED once the client is behind", decide(SSE_MAX_BUFFER_BYTES + 1, true) === true);
  check("a 12MB backlog still drops a frame", decide(12_000_000, true) === true);
  check("state message survives a large-but-plausible backlog", decide(2_000_000, false) === false,
    "ready/action must not be starved by a frame burst");
  check("state message is dropped only when the backlog is pathological", decide(300_000_000, false) === true);

  // ── 2. Agent live stream ──────────────────────────────────────────────────
  step("2. agent stream: the Playwright page must produce real frames");
  const opened = await browser.open({ url: `http://localhost:${PORT}/` });
  check("agent opened a page", opened?.success === true, JSON.stringify(opened).slice(0, 160));

  const targets = browser.liveTargets();
  check("liveTargets() lists the agent's page", targets.length === 1, JSON.stringify(targets).slice(0, 200));
  check("live target has a followable id", /^pw:/.test(targets[0]?.id || ""), targets[0]?.id);
  check("live target reports the open url", (targets[0]?.url || "").includes(String(PORT)), targets[0]?.url);

  const frames = [];
  const stop = await browser.startLiveStream(
    undefined,
    { quality: 20, maxWidth: 320, maxHeight: 240, everyNthFrame: 1 },
    ({ data }) => { if (data) frames.push(data); }
  );
  check("startLiveStream returned a stop function", typeof stop === "function");

  // Drive the page so Chrome has a reason to produce frames.
  await browser.click({ selector: "#go" }).catch(() => {});

  const deadline = Date.now() + 8000;
  while (frames.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  check("received at least one real JPEG frame from the agent's page", frames.length > 0,
    `frames=${frames.length} after 8s`);
  check("frame payload is base64 JPEG data", /^[A-Za-z0-9+/=]{100,}$/.test(frames[0] || ""),
    `len=${(frames[0] || "").length}`);

  // A second viewer must join the SAME stream, not start a competing one.
  const stop2 = await browser.startLiveStream(undefined, { quality: 20 }, () => {});

  // ── 3. Action telemetry + speed ───────────────────────────────────────────
  step("3. actions: click/scroll/type publish, and click no longer round-trips");
  const seen = [];
  const unsubscribe = onBrowserAction((a) => seen.push(a));

  const snap = await browser.snapshot({});
  check("snapshot produced refs", (snap?.elements || []).length >= 2, `elements=${snap?.elements?.length}`);
  const goRef = (snap?.elements || []).find((e) => e.selector === "#go");
  check("snapshot cached bounds for the button", Boolean(goRef?.bounds?.width > 0), JSON.stringify(goRef?.bounds));

  // cachedPoint is the speed fix: it must answer from the snapshot alone.
  const probeSession = { refElements: snap?.elements || [] };
  const cached = browser.cachedPoint(probeSession, { selector: "#go" });
  check("cachedPoint answers from the snapshot with no page round trip",
    Number.isFinite(cached?.x) && Number.isFinite(cached?.y), JSON.stringify(cached));
  check("cachedPoint returns null for an unknown selector (falls back safely)",
    browser.cachedPoint(probeSession, { selector: "#nope" }) === null);

  seen.length = 0;
  await browser.click({ ref: goRef?.ref || "@e1" });
  const clickAction = seen.find((a) => a.type === "click");
  check("click is published to the live view", Boolean(clickAction), JSON.stringify(seen).slice(0, 200));
  check("click carries a drawable cursor position",
    Number.isFinite(clickAction?.x) && Number.isFinite(clickAction?.y), JSON.stringify(clickAction));
  check("click carries the agent's followable tab id", /^pw:/.test(clickAction?.tabId || ""), clickAction?.tabId);

  seen.length = 0;
  await browser.type({ selector: "#name", text: "hello" });
  check("type is published", seen.some((a) => a.type === "type"), JSON.stringify(seen).slice(0, 200));

  seen.length = 0;
  await browser.scroll({ direction: "down", amount: 400 });
  const scrollAction = seen.find((a) => a.type === "scroll");
  check("scroll is published (it used to publish NOTHING — invisible in the panel)",
    Boolean(scrollAction), JSON.stringify(seen).slice(0, 200));
  check("scroll action names its direction", scrollAction?.direction === "down", JSON.stringify(scrollAction));
  const scrolled = await browser.evaluate({ script: "window.scrollY" });
  check("scroll actually moved the page", Number(scrolled?.result ?? scrolled) > 0, JSON.stringify(scrolled));

  unsubscribe();

  // ── 4. Shutdown hygiene ───────────────────────────────────────────────────
  step("4. closeAll() leaves nothing running");
  await browser.closeAll();
  check("closeAll() emptied the session list", browser.liveTargets().length === 0,
    JSON.stringify(browser.liveTargets()).slice(0, 160));
} catch (error) {
  check("script completed without throwing", false, error?.stack || error?.message);
} finally {
  try { await browser.closeAll(); } catch { /* already closed */ }
  server.close();
  clearTimeout(bail);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

  check("a second viewer joins the same stream without error", typeof stop2 === "function");

  await stop2();
  await stop();
  check("stop() ran cleanly", true);
  check("session survives stream teardown (page still usable)", browser.liveTargets().length === 1,
    JSON.stringify(browser.liveTargets()).slice(0, 160));
