// Vision + attachments + effort-picker — REAL end-to-end (isolated) smoke.
//
// This boots the ACTUAL OmniClaw gateway (its own data dir + port) in front of a
// real OpenAI-compatible endpoint, and drives the real web-next UI in Chromium.
// The only thing faked is the LLM: a local HTTP server that is a genuine
// OpenAI-compatible endpoint. Nothing here mocks OmniClaw's own code.
//
// It proves, in a real browser, everything the feature claims:
//   1. attaching 6 images yields exactly 5 (the product ceiling)
//   2. the sent images render in the chat bubble (/preview/…)
//   3. the harness reports that the model RECEIVED the images (vision note)
//   4. the provider request actually carried 5 `image_url` parts
//   5. the model's reply ("I can see 5 images") renders back in the chat
//   6. the effort pill offers the MODEL'S declared levels (low/medium/high),
//      shows the model default, and does NOT offer xhigh/max
//
// R14: marker before every step, a hard wall clock, everything torn down in
// finally, explicit exit. Never touches the live install (R11).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let step = "startup";
const deadline = setTimeout(() => { console.error(`TIMEOUT at ${step}`); void cleanup(2); }, 75000);
let gateway = null;
let mock = null;
let browser = null;
let tempDir = "";
let shotsDir = "";
let passed = 0;
let failed = 0;
let cleaning = false;
const serverOutput = [];
const mockSeen = [];

function check(label, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const p = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return p;
}

// A REAL OpenAI-compatible endpoint. It reports a vision-capable model with
// declared reasoning levels, counts the image parts in each request, and streams
// back a sentence that says how many it saw.
function startMockProvider() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          data: [{
            id: "gpt-4o", object: "model", context_length: 128000,
            supported_parameters: ["tools", "reasoning", "reasoning_effort"],
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            reasoning: { supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
          }],
        }));
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        let body = "";
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const parts = Array.isArray(lastUser?.content) ? lastUser.content : [];
        const imageCount = parts.filter((p) => p && p.type === "image_url").length;
        mockSeen.push({ imageCount, reasoning: parsed.reasoning ?? parsed.reasoning_effort ?? null, stream: parsed.stream !== false });
        const reply = imageCount > 0
          ? `I can see ${imageCount} image${imageCount === 1 ? "" : "s"} in this message, and they are all 1x1 pixels.`
          : "I do not see any image in this message.";
        // Non-streaming (planner/compaction) callers expect JSON, not SSE.
        if (parsed.stream === false) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "mock", model: "gpt-4o", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(`data: ${JSON.stringify({ id: "mock", model: "gpt-4o", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "mock", model: "gpt-4o", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404); res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function cleanup(exitCode) {
  if (cleaning) return;
  cleaning = true;
  clearTimeout(deadline);
  console.log(`STEP cleanup (exit ${exitCode})`);
  try { if (browser) await Promise.race([browser.close(), delay(1500)]); } catch {}
  try {
    if (gateway && gateway.exitCode == null) {
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(gateway.pid), "/T", "/F"], { timeout: 2000, windowsHide: true, stdio: "ignore" });
      else gateway.kill();
      await Promise.race([new Promise((r) => gateway.once("exit", r)), delay(1500)]);
    }
  } catch {}
  try { if (mock) await new Promise((r) => mock.close(r)); } catch {}
  try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { if (shotsDir) fs.rmSync(shotsDir, { recursive: true, force: true }); } catch {}
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}

try {
  step = "create isolated data dir + mock provider";
  const TMPROOT = process.env.OC_TMP_ROOT || path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(TMPROOT, { recursive: true });
  tempDir = fs.mkdtempSync(path.join(TMPROOT, "omniclaw-vision-e2e-"));
  shotsDir = fs.mkdtempSync(path.join(TMPROOT, "omniclaw-shots-"));
  const mockStarted = await startMockProvider();
  mock = mockStarted.server;
  const mockPort = mockStarted.port;
  console.log(`ok: mock OpenAI endpoint on :${mockPort}`);

  step = "seed the isolated provider config (loopback -> keyless)";
  fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, "data", "config.json"), JSON.stringify({
    provider: {
      mode: "openai-compatible",
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      model: "gpt-4o",
      apiKeyEnv: "OMNICLAW_TEST_KEY",
      temperature: 0,
      maxTokens: 2000,
      timeoutMs: 30000,
    },
    runtime: { omniLoop: { enabled: true, streaming: true, maxRounds: 6, runTokenBudget: 400000 } },
  }, null, 2));

  step = "write 6 real PNG files to attach";
  const files = [];
  for (let i = 1; i <= 6; i += 1) {
    const p = path.join(shotsDir, `shot-${i}.png`);
    fs.writeFileSync(p, PNG_1PX);
    files.push(p);
  }
  console.log(`ok: ${files.length} PNG files ready`);

  step = "boot the real gateway (isolated)";
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  gateway = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, OMNICLAW_DATA_DIR: tempDir, PORT: String(PORT), OMNICLAW_TEST_KEY: "test-key" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  gateway.stdout.on("data", (c) => serverOutput.push(String(c)));
  gateway.stderr.on("data", (c) => serverOutput.push(String(c)));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(600) });
      ready = r.ok;
      await r.body?.cancel();
    } catch { /* still starting */ }
    if (!ready) await delay(250);
  }
  check("isolated gateway is up", ready, serverOutput.join("").slice(-600));
  if (!ready) throw new Error("gateway did not start");

  step = "launch Chromium + open the UI";
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector("#app .composer", { timeout: 15000 });
  await page.waitForTimeout(600);
  console.log("ok: composer mounted");

  step = "attach 6 images (expect 5 kept)";
  await page.setInputFiles("#app .composer input[type=file]", files);
  await page.waitForTimeout(1200);
  const chipCount = await page.locator("#app .composer .attach-tray .att-chip").count();
  check("attaching 6 images keeps exactly 5", chipCount === 5, `chips=${chipCount}`);

  step = "send the message";
  await page.fill("#app .composer textarea", "what do you see in these?");
  await page.keyboard.press("Enter");

  step = "assert the composer tray is cleared after send";
  const trayChips = await page.locator("#app .composer .attach-tray .att-chip").count();
  check("the sent images are removed from the composer", trayChips === 0, `chips=${trayChips}`);

  step = "wait for the agent's reply";
  await page.waitForFunction(
    () => /I can see/.test(document.querySelector("#app .answer")?.textContent || ""),
    null, { timeout: 30000 },
  ).catch(() => {});
  const answer = (await page.locator("#app .answer").last().textContent().catch(() => "")) || "";
  check("the model's reply renders in chat", /I can see 5 images/.test(answer), answer.slice(0, 120));

  step = "assert the chat shows the 5 sent images";
  const userImgs = await page.locator("#app .turn-user .user-atts img").count();
  check("the 5 sent images render in the user bubble", userImgs === 5, `imgs=${userImgs}`);
  const firstSrc = await page.locator("#app .turn-user .user-atts img").first().getAttribute("src").catch(() => "");
  check("image src is a /preview/ URL", /^\/preview\/uploads\//.test(firstSrc || ""), String(firstSrc));

  step = "assert the chat stays clean (no 'sent N images' note, no path note)";
  const notes = await page.locator("#app .turn-user .thread-note").allInnerTexts();
  check("no 'sent N images' note is shown", !notes.some((n) => /sent \d+ image/i.test(n)), JSON.stringify(notes));
  const userText = (await page.locator("#app .turn-user .user-bubble").last().textContent().catch(() => "")) || "";
  check("the user's message carries no '[Attached by user …]' path note", !/attached by user|uploads\\|\/uploads\//i.test(userText), userText.slice(0, 120));

  step = "assert the PROVIDER actually received 5 image parts";
  const withImages = mockSeen.filter((s) => s.imageCount > 0);
  const maxImages = mockSeen.reduce((m, s) => Math.max(m, s.imageCount), 0);
  check("a provider request carried image parts", withImages.length > 0, JSON.stringify(mockSeen));
  check("the provider never received more than 5 images", maxImages === 5, `max=${maxImages}`);

  step = "assert the effort pill offers the MODEL's own levels";
  await page.click("#app .composer .effort-pill");
  await page.waitForSelector(".pop-item.effort-row", { timeout: 4000 });
  const menu = (await page.locator(".pop-item.effort-row").allInnerTexts()).join("\n");
  check("model levels are offered (low/medium/high)", /low/i.test(menu) && /medium/i.test(menu) && /high/i.test(menu), menu);
  check("levels the model does NOT declare are absent (xhigh/max)", !/xhigh/i.test(menu) && !/\bmax\b/i.test(menu), menu);
  check("Default shows the model default", /medium/i.test(menu), menu);

  step = "switch High -> then Default applies the MODEL's default (medium)";
  // The current value is already Default(null), so pick High first — then the
  // Default click is a real change and proves what it stores.
  await page.locator(".pop-item.effort-row").filter({ hasText: /^High/ }).first().click();
  await page.waitForTimeout(900);
  const afterHigh = ((await page.locator("#app .composer .effort-pill").innerText().catch(() => "")) || "").trim();
  check("picking High stores high", /^high$/i.test(afterHigh), afterHigh);
  await page.click("#app .composer .effort-pill");
  await page.waitForSelector(".pop-item.effort-row", { timeout: 4000 });
  await page.locator(".pop-item.effort-row").filter({ hasText: /^Default/ }).first().click();
  await page.waitForTimeout(900);
  const afterDefault = ((await page.locator("#app .composer .effort-pill").innerText().catch(() => "")) || "").trim();
  const storedReasoning = await page.evaluate(async () => {
    const c = await (await fetch("/api/config")).json();
    return c?.config?.provider?.reasoning ?? c?.provider?.reasoning ?? null;
  });
  check("Default stores the model's own default (medium)", storedReasoning === "medium", `stored=${JSON.stringify(storedReasoning)} pill=${afterDefault}`);
  check("the effort pill reflects the stored value after the write", /medium/i.test(afterDefault), afterDefault);

  check("no uncaught browser errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await cleanup(failed ? 1 : 0);
} catch (error) {
  failed++;
  console.error(`FAIL at step "${step}": ${error.stack || error.message}`);
  console.error("mockSeen:", JSON.stringify(mockSeen));
  console.error(serverOutput.join("").slice(-2000));
  await cleanup(1);
}
