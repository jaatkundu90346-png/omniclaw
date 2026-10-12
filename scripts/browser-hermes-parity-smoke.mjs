import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserPlaywright } from "../src/core/browser-playwright.js";
import { ToolRegistry } from "../src/core/tool-registry.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const sid = `hermes_parity_${Date.now()}`;
const browser = new BrowserPlaywright({ rootDir: ROOT, headless: true, sessionId: sid });
const generatedDir = path.join(ROOT, "data", "generated");
fs.mkdirSync(generatedDir, { recursive: true });
const htmlPath = path.join(generatedDir, `omniclaw-hermes-browser-parity-${Date.now()}.html`);

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hermes Browser Parity</title></head>
<body style="min-height:2200px">
  <main>
    <h1>Hermes Browser Parity</h1>
    <label>Name <input id="name" aria-label="Name" value="initial"></label>
    <button id="go" type="button">Run Action</button>
    <button id="tap-target" type="button">Tap Target</button>
    <button id="prompt" type="button">Prompt Action</button>
    <img id="hero" alt="Hero diagram" width="12" height="10"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
    <p id="output">Waiting</p>
  </main>
  <script>
    console.log("page-ready-log");
    console.warn("page-ready-warn");
    const name = document.querySelector("#name");
    const out = document.querySelector("#output");
    document.querySelector("#go").addEventListener("click", () => {
      out.textContent = "Clicked " + name.value;
    });
    document.querySelector("#tap-target").addEventListener("click", () => {
      out.textContent = "Tapped " + name.value;
    });
    document.querySelector("#prompt").addEventListener("click", () => {
      out.textContent = "Prompt " + prompt("Dialog value", "default");
    });
  </script>
</body>
</html>`;
fs.writeFileSync(htmlPath, html, "utf8");

const permissions = {
  allowBrowserControl: true,
  allowBrowserEvaluate: true,
};
const registry = new ToolRegistry({
  memoryStore: {},
  taskStore: {},
  configStore: { getConfig: () => ({ tools: { permissions } }) },
  fileStore: {},
  shellExecutor: {},
  webResearch: {},
  browser,
  browserOperator: {
    getStatus: () => ({ available: true }),
    automate: () => {
      throw new Error("browser_snapshot must use Playwright refs, not legacy browserOperator snapshot.");
    },
  },
  pluginRegistry: { getToolDefinitions: () => [], runTool: async () => ({}) },
  agentRuntime: {},
});
const context = { agentId: "main", sessionId: "hermes-browser-parity", runId: "hermes-browser-parity" };

try {
  const modelIds = new Set(registry.getAll({ includeAllAgents: true, modelCallableOnly: true }).map((tool) => tool.id));
  for (const id of ["browser_press", "browser_get_images", "browser_console", "browser_cdp", "browser_dialog", "browser_tap"]) {
    assert(modelIds.has(id), `${id} must be model-callable once its backend is wired.`);
  }

  const opened = await browser.open({ url: pathToFileURL(htmlPath).href, sessionId: sid });
  assert(opened.success === true, `browser.open should load parity page: ${JSON.stringify(opened)}`);

  const snapshot = await registry.tools.browser_snapshot.run({ sessionId: sid }, context);
  assert(snapshot.success === true, `browser_snapshot should succeed: ${JSON.stringify(snapshot)}`);
  assert(Array.isArray(snapshot.elements) && snapshot.elements.length >= 3, "browser_snapshot should return interactive elements.");
  assert(snapshot.elements.every((element) => /^@e\d+$/.test(element.ref || "")), "every snapshot element should have Hermes-style @e refs.");
  assert(typeof snapshot.content === "string" && snapshot.content.includes("[@e"), "snapshot.content should be a model-friendly text tree with refs.");

  const nameRef = snapshot.elements.find((element) => element.name === "Name" || element.selector === "#name")?.ref;
  const runRef = snapshot.elements.find((element) => /Run Action/i.test(element.name || element.text || ""))?.ref;
  const tapRef = snapshot.elements.find((element) => /Tap Target/i.test(element.name || element.text || ""))?.ref;
  const promptRef = snapshot.elements.find((element) => /Prompt Action/i.test(element.name || element.text || ""))?.ref;
  assert(nameRef && runRef && tapRef && promptRef, `snapshot refs should identify input/buttons: ${JSON.stringify(snapshot.elements)}`);

  const typed = await registry.tools.browser_type.run({ sessionId: sid, ref: nameRef, text: "Patel" }, context);
  assert(typed.success === true, `browser_type should accept ref: ${JSON.stringify(typed)}`);
  const clicked = await registry.tools.browser_click.run({ sessionId: sid, ref: runRef }, context);
  assert(clicked.success === true, `browser_click should accept ref: ${JSON.stringify(clicked)}`);
  let output = await browser.evaluate({ sessionId: sid, script: "document.querySelector('#output').textContent" });
  assert(output.result === "Clicked Patel", `click by ref should update output, got ${JSON.stringify(output)}`);

  const tap = await registry.tools.browser_tap.run({ sessionId: sid, ref: tapRef }, context);
  assert(tap.success === true, `browser_tap should accept ref: ${JSON.stringify(tap)}`);
  output = await browser.evaluate({ sessionId: sid, script: "document.querySelector('#output').textContent" });
  assert(output.result === "Tapped Patel", `tap by ref should update output, got ${JSON.stringify(output)}`);
  const routedTap = await registry.tools.browser.run({ sessionId: sid, action: "tap", ref: tapRef }, context);
  assert(routedTap.ok === true && routedTap.tool === "browser_tap", `unified browser action=tap should route to browser_tap, got ${JSON.stringify(routedTap)}`);

  const images = await registry.tools.browser_get_images.run({ sessionId: sid }, context);
  assert(images.success === true && images.images?.some((image) => image.alt === "Hero diagram"), `browser_get_images should return page images, got ${JSON.stringify(images)}`);
  const routedImages = await registry.tools.browser.run({ sessionId: sid, action: "images" }, context);
  assert(routedImages.ok === true && routedImages.tool === "browser_get_images" && routedImages.result?.images?.some((image) => image.alt === "Hero diagram"), `unified browser action=images should route to browser_get_images, got ${JSON.stringify(routedImages)}`);

  const consoleResult = await registry.tools.browser_console.run({ sessionId: sid, expression: "console.error('parity-console-error'); 6 * 7", clear: false }, context);
  assert(consoleResult.success === true, `browser_console should succeed: ${JSON.stringify(consoleResult)}`);
  assert(consoleResult.result === 42, `browser_console expression should return 42, got ${JSON.stringify(consoleResult)}`);
  assert((consoleResult.messages || []).some((message) => /page-ready-log|page-ready-warn|parity-console-error/.test(message.text || "")), `browser_console should include console messages, got ${JSON.stringify(consoleResult.messages)}`);
  const routedConsole = await registry.tools.browser.run({ sessionId: sid, action: "console", expression: "window.__routeCheck = 99" }, context);
  assert(routedConsole.ok === true && routedConsole.tool === "browser_console" && routedConsole.result?.result === 99, `unified browser action=console should route/evaluate, got ${JSON.stringify(routedConsole)}`);

  const cdp = await registry.tools.browser_cdp.run({ sessionId: sid, method: "Runtime.evaluate", params: { expression: "document.title" } }, context);
  assert(cdp.success === true && cdp.result?.result?.value === "Hermes Browser Parity", `browser_cdp should execute Runtime.evaluate, got ${JSON.stringify(cdp)}`);
  const routedCdp = await registry.tools.browser.run({ sessionId: sid, action: "cdp", method: "Runtime.evaluate", params: { expression: "document.title" } }, context);
  assert(routedCdp.ok === true && routedCdp.tool === "browser_cdp" && routedCdp.result?.result?.result?.value === "Hermes Browser Parity", `unified browser action=cdp should route, got ${JSON.stringify(routedCdp)}`);
  const routedDialogStatus = await registry.tools.browser.run({ sessionId: sid, action: "dialogs" }, context);
  assert(routedDialogStatus.ok === true && routedDialogStatus.tool === "browser_dialog", `unified browser action=dialogs should route to browser_dialog, got ${JSON.stringify(routedDialogStatus)}`);

  const prearm = await registry.tools.browser_dialog.run({ sessionId: sid, action: "accept", text: "accepted-by-agent" }, context);
  assert(prearm.success === true && prearm.armed === true, `browser_dialog accept should pre-arm next dialog, got ${JSON.stringify(prearm)}`);
  const promptClick = await registry.tools.browser_click.run({ sessionId: sid, ref: promptRef }, context);
  assert(promptClick.success === true, `prompt click should not hang/fail: ${JSON.stringify(promptClick)}`);
  output = await browser.evaluate({ sessionId: sid, script: "document.querySelector('#output').textContent" });
  assert(output.result === "Prompt accepted-by-agent", `dialog accept should feed prompt text, got ${JSON.stringify(output)}`);
  const dialogs = await registry.tools.browser_dialog.run({ sessionId: sid, action: "list" }, context);
  assert(dialogs.dialogs?.some((dialog) => dialog.message === "Dialog value" && dialog.handledAction === "accept"), `browser_dialog list should show handled dialog, got ${JSON.stringify(dialogs)}`);

  const scrolled = await registry.tools.browser_scroll.run({ sessionId: sid, direction: "down", amount: 650 }, context);
  assert(scrolled.success === true, `browser_scroll should still work: ${JSON.stringify(scrolled)}`);
  const pressed = await registry.tools.browser_press.run({ sessionId: sid, key: "Home" }, context);
  assert(pressed.success === true, `browser_press should still work: ${JSON.stringify(pressed)}`);

  // evaluate result plumbing (the "sirf success:true dikh raha" game-testing bug):
  // alias keys must work, empty script must ERROR, undefined must come back loud.
  const aliased = await browser.evaluate({ sessionId: sid, expression: "({answer: 6 * 7, title: document.title})" });
  assert(aliased.success === true && aliased.result?.answer === 42, `evaluate should accept expression alias and return the value, got ${JSON.stringify(aliased)}`);
  const codeAlias = await browser.evaluate({ sessionId: sid, code: "1 + 1" });
  assert(codeAlias.result === 2, `evaluate should accept code alias, got ${JSON.stringify(codeAlias)}`);
  const noScript = await browser.evaluate({ sessionId: sid });
  assert(typeof noScript.error === "string" && /script is required/.test(noScript.error), `evaluate with no script must ERROR not silently succeed, got ${JSON.stringify(noScript)}`);
  const undef = await browser.evaluate({ sessionId: sid, script: "window.__nothing" });
  assert(undef.success === true && undef.result === null && /returned undefined/.test(undef.note || ""), `undefined result must return null + an explanatory note, got ${JSON.stringify(undef)}`);
  const routedEval = await registry.tools.browser.run({ sessionId: sid, action: "evaluate", expression: "({routed: true})" }, context);
  assert(routedEval.ok === true && routedEval.result?.result?.routed === true, `unified browser action=evaluate should carry the alias through, got ${JSON.stringify(routedEval)}`);

  console.log("Hermes browser parity smoke passed: refs, click/type/tap/scroll/press, images, console, CDP, dialogs, evaluate result plumbing.");
} finally {
  await browser.close({ sessionId: sid }).catch(() => {});
  try { fs.unlinkSync(htmlPath); } catch {}
}
