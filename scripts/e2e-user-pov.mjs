import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.OMNICLAW_URL || "http://localhost:3147/";
const outDir = path.resolve(process.cwd(), "test-output");
fs.mkdirSync(outDir, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const screenshotPath = path.join(outDir, `omniclaw-user-pov-${runId}.png`);
const logPath = path.join(outDir, `omniclaw-user-pov-${runId}.json`);

const logs = {
  url: baseUrl,
  startedAt: new Date().toISOString(),
  console: [],
  pageErrors: [],
  result: {},
};

function pushLog(kind, payload) {
  logs[kind].push({ at: new Date().toISOString(), ...payload });
}

const prompt = [
  "You are OmniClaw running inside this repo.",
  "Goal: behave like a real coding+research assistant, showing tool evidence clearly.",
  "",
  "Task:",
  "1) Inspect current workspace and identify 3 highest-risk reliability issues in agent loop + gateway + UI.",
  "2) Run any safe non-destructive terminal commands you need (status/build/tests) and include the outputs as evidence.",
  "3) For each issue: give a concrete fix plan with file paths + functions involved.",
  "",
  "Constraints:",
  "- Do not invent tool outputs; only use real tool evidence.",
  "- If you need approvals, request them clearly.",
].join("\n");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("console", (msg) => {
  pushLog("console", { type: msg.type(), text: msg.text() });
});
page.on("pageerror", (err) => {
  pushLog("pageErrors", { message: err.message, stack: err.stack });
});

let ok = false;
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("#boot-screen, #chat-panel", { timeout: 60000 });

  const bootScreen = page.locator("#boot-screen");
  if (await bootScreen.isVisible().catch(() => false)) {
    const firstLaunchSubmit = page.locator('#first-launch-form button[type="submit"]');
    const skipSetup = page.locator("#skip-first-launch");
    if (await firstLaunchSubmit.isVisible().catch(() => false)) {
      const offline = page.locator('input[name="setup-mode"][value="offline"]');
      if (await offline.count()) {
        await offline.check({ force: true });
      }
      await page.locator("#first-owner-mode").check({ force: true }).catch(() => {});
      await page.locator("#first-runtime-profile").selectOption({ value: "balanced" }).catch(() => {});
      await firstLaunchSubmit.click({ timeout: 30000 });
      await bootScreen.waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
    } else if (await skipSetup.isVisible().catch(() => false)) {
      await skipSetup.click({ timeout: 30000 });
      await bootScreen.waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
    }
  }

  await page.locator("#chat-panel").waitFor({ state: "visible", timeout: 60000 });
  await page.fill("#message", prompt);
  await page.locator('#chat-form button[type="submit"]').click({ timeout: 30000 });

  const live = page.locator("#live-run-output");
  await live.waitFor({ state: "visible", timeout: 60000 });

  const abortButton = page.locator("#abort-run");
  const endBy = Date.now() + 180000;
  while (Date.now() < endBy) {
    const disabled = await abortButton.isDisabled().catch(() => true);
    if (disabled) {
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!(await abortButton.isDisabled().catch(() => false))) {
    throw new Error("Run did not finish within timeout (Stop task button still enabled).");
  }

  logs.result.liveRunOutput = await live.innerText().catch(() => "");
  logs.result.chatOutput = await page.locator("#chat-output").innerText().catch(() => "");
  logs.result.chatTranscript = await page.locator("#chat-transcript").innerText().catch(() => "");
  ok = true;
} catch (error) {
  logs.error = { message: error?.message || String(error), stack: error?.stack || "" };
  logs.result.liveRunOutput = await page.locator("#live-run-output").innerText().catch(() => "");
  logs.result.chatOutput = await page.locator("#chat-output").innerText().catch(() => "");
  logs.result.chatTranscript = await page.locator("#chat-transcript").innerText().catch(() => "");
} finally {
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {}
  logs.finishedAt = new Date().toISOString();
  logs.screenshotPath = screenshotPath;
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), "utf8");
  await browser.close().catch(() => {});
}

process.exitCode = ok ? 0 : 1;
process.stdout.write(JSON.stringify({ ok, screenshotPath, logPath }, null, 2));
