import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OmniClawAgent } from "../src/core/agent.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function copyRuntime(sourceRoot, targetRoot) {
  for (const dir of ["config", "workspace", "plugins", "connectors"]) {
    const source = path.join(sourceRoot, dir);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(targetRoot, dir), { recursive: true, force: true });
    }
  }
}

function createLocalServer() {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>OmniClaw Tool Smoke</title></head>
<body>
  <main>
    <h1>OmniClaw Tool Smoke Page</h1>
    <p>Local fetch content proves web_fetch can read rendered public URL text.</p>
  </main>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-smoke-model", owned_by: "omniclaw-smoke" }] }));
      return;
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-tool-exec-"));
copyRuntime(repoRoot, rootDir);

const { server, port } = await createLocalServer();
const agent = new OmniClawAgent({ rootDir });
const context = { agentId: "main", sessionId: "tool-exec-smoke", runId: "tool-exec-smoke" };
const runTool = (tool, input = {}) => agent.tools.run(tool, input, context);

try {
  const htmlPath = "data/generated/tool-exec-smoke/index.html";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tool Smoke App</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f7f7f4; color: #171717; }
    main { max-width: 760px; margin: 40px auto; padding: 24px; border: 1px solid #deded8; border-radius: 8px; background: #fff; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    button, input { min-height: 42px; border-radius: 8px; border: 1px solid #cfcfc7; padding: 0 12px; }
    button { background: #111; color: #fff; cursor: pointer; }
    #output { margin-top: 18px; padding: 12px; background: #eef8f0; border-radius: 8px; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } main { margin: 16px; } }
  </style>
</head>
<body>
  <main>
    <h1>Tool Smoke App</h1>
    <p>This app proves write, edit, verify, browser type, click, evaluate, and screenshot.</p>
    <div class="grid">
      <input id="name" aria-label="Name" value="initial">
      <button id="go" type="button">Run Smoke</button>
    </div>
    <div id="output">Waiting</div>
  </main>
  <script>
    const input = document.querySelector("#name");
    const output = document.querySelector("#output");
    document.querySelector("#go").addEventListener("click", () => {
      output.textContent = "Smoke passed for " + input.value;
      localStorage.setItem("tool-smoke", input.value);
    });
  </script>
</body>
</html>`;

  const write = await runTool("write_file", { path: htmlPath, content: html });
  assert(write.path === htmlPath, "write_file should create the HTML artifact.");

  const edit = await runTool("edit", { path: htmlPath, find: "Tool Smoke App", replace: "Tool Smoke App Verified" });
  assert(edit.edited === true, "edit should replace exact text.");

  const read = await runTool("read_file", { path: htmlPath });
  assert(read.content.includes("Tool Smoke App Verified"), "read_file should observe the edited content.");

  const patch = await runTool("apply_patch", {
    input: `*** Begin Patch
*** Add File: data/generated/tool-exec-smoke/patch-proof.txt
+patch line one
+patch line two
*** End Patch`,
  });
  assert(patch.applied === true, "apply_patch should apply OpenClaw/Codex structured patches.");
  const patchRead = await runTool("read_file", { path: "data/generated/tool-exec-smoke/patch-proof.txt" });
  assert(patchRead.content.includes("patch line two"), "apply_patch output should be readable by the next tool step.");

  const verify = await runTool("verify_html_artifact", {
    path: htmlPath,
    requiredText: ["Tool Smoke App Verified", "Smoke passed"],
    forbiddenText: ["OmniClaw Web App"],
    minBytes: 1200,
  });
  assert(verify.ok === true, `verify_html_artifact should pass, got ${JSON.stringify(verify.issues || verify.checks)}`);

  const command = await runTool("run_terminal_command", {
    command: "node -e \"console.log('omniclaw-tool-exec')\"",
  });
  assert(command.status === "completed", "run_terminal_command should complete.");
  assert(String(command.stdout || "").includes("omniclaw-tool-exec"), "terminal stdout should be returned to the caller.");

  const localComputerFile = path.join(rootDir, "data", "generated", "tool-exec-smoke", "computer.txt");
  const computerWrite = await runTool("write_computer_file", { path: localComputerFile, content: "Hello laptop tools" });
  assert(computerWrite.path, "write_computer_file should return a path.");
  const computerRead = await runTool("read_computer_file", { path: localComputerFile });
  assert(computerRead.content.includes("Hello laptop tools"), "read_computer_file should verify computer file content.");
  const computerSearch = await runTool("search_computer_files", {
    path: path.dirname(localComputerFile),
    query: "computer.txt",
    maxResults: 5,
    maxDepth: 1,
  });
  assert((computerSearch.results || []).some((item) => item.name === "computer.txt"), "search_computer_files should find created file.");

  const fetchResult = await runTool("web_fetch", { url: `http://127.0.0.1:${port}/page`, maxChars: 4000 });
  assert(fetchResult.text?.includes("Local fetch content"), "web_fetch should return fetched page text, not only a URL.");

  const provider = await runTool("configure_provider_brain", {
    mode: "openai-compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "local-smoke-model",
    apiKeyProviderId: "tool-exec-smoke",
    apiKey: "SMOKE_PROVIDER_KEY_123456789",
    live: false,
    fetchModels: true,
  });
  assert(provider.updated === true, "configure_provider_brain should update provider config.");
  assert(provider.readiness?.ok === true, "configure_provider_brain should validate key/config when live=false.");
  assert(provider.models?.models?.some((model) => model.id === "local-smoke-model"), "provider model fetch should return local smoke model.");

  const telegram = await runTool("configure_telegram", {
    token: "123456789:AAFakeSmokeTokenForLocalContractOnly",
    defaultAgentId: "main",
    startWorker: false,
  });
  assert(telegram.ok === true, "configure_telegram should save token and adapter config.");
  assert(telegram.test?.ok === true, "configure_telegram should mark adapter test ready when token exists.");
  assert(telegram.worker === null, "configure_telegram startWorker=false should avoid network polling.");

  const browserFile = pathToFileURL(path.join(rootDir, htmlPath)).href;
  const opened = await runTool("browser_open", { url: browserFile, sessionId: "tool-smoke-browser" });
  assert(opened.success === true, `browser_open should open local file: ${opened.error || ""}`);
  const typed = await runTool("browser_type", { sessionId: "tool-smoke-browser", selector: "#name", text: "Codex-level" });
  assert(typed.success === true, `browser_type should fill input: ${typed.error || ""}`);
  const clicked = await runTool("browser_click", { sessionId: "tool-smoke-browser", selector: "#go" });
  assert(clicked.success === true, `browser_click should click button: ${clicked.error || ""}`);
  const evaluated = await runTool("browser_evaluate", {
    sessionId: "tool-smoke-browser",
    script: "document.querySelector('#output').textContent",
  });
  assert(
    evaluated.result === "Smoke passed for Codex-level",
    `browser_evaluate should observe post-click state, got ${JSON.stringify(evaluated)}`,
  );
  const unifiedEval = await runTool("browser", {
    action: "evaluate",
    sessionId: "tool-smoke-browser",
    script: "document.querySelector('#output').textContent",
  });
  assert(
    unifiedEval.ok === true && unifiedEval.result?.result === "Smoke passed for Codex-level",
    `unified browser tool should route evaluate through Playwright, got ${JSON.stringify(unifiedEval)}`,
  );
  const screenshot = await runTool("browser_screenshot", { sessionId: "tool-smoke-browser" });
  assert(screenshot.success === true && fs.existsSync(screenshot.screenshotPath), "browser_screenshot should save a real screenshot.");
  await runTool("browser_close", { sessionId: "tool-smoke-browser" });

  console.log("Tool execution smoke test passed: file/edit/verify, terminal, computer, web_fetch, provider, Telegram, browser.");
} finally {
  agent.heartbeat?.stop?.();
  agent.scheduler?.stop?.();
  agent.autonomousDaemon?.stop?.();
  await agent.browserPlaywright?.close?.({ sessionId: "tool-smoke-browser" }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}
