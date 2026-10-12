import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const targetUrl = process.argv[2] || "http://localhost:3147";
const outputPath = process.argv[3] || path.resolve("screenshots", "omniclaw-ui-redesign.png");
const port = 9223 + Math.floor(Math.random() * 500);
const userDataDir = path.join(os.tmpdir(), `omniclaw-edge-${Date.now()}`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function waitForPage() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const pages = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find((item) => item.type === "page");
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // Browser is still booting.
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for Edge DevTools page.");
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message || "CDP command failed"));
      } else {
        resolve(message.result);
      }
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((commandResolve, commandReject) => {
            pending.set(id, { resolve: commandResolve, reject: commandReject });
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed.")));
  });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const browser = spawn(edgePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--run-all-compositor-stages-before-draw",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--window-size=1440,1100",
  targetUrl,
], {
  stdio: "ignore",
});

try {
  const page = await waitForPage();
  const cdp = await createCdpClient(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: targetUrl });
  await sleep(1_500);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        expression: `
          new Promise((resolve) => {
            const deadline = Date.now() + 8000;
            const tick = () => {
              const inspector = document.querySelector("#inspector-output");
              const text = inspector ? inspector.textContent : "";
              if (text && !text.includes("Loading")) {
                resolve(text);
                return;
              }
              if (Date.now() > deadline) {
                resolve(text || "timeout");
                return;
              }
              setTimeout(tick, 100);
            };
            tick();
          })
        `,
      });
      break;
    } catch (error) {
      if (!String(error.message).includes("Execution context was destroyed") || attempt === 3) {
        throw error;
      }
      await sleep(1_000);
    }
  }
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
  await cdp.send("Browser.close").catch(() => {});
  cdp.close();
  console.log(outputPath);
} finally {
  setTimeout(() => {
    if (!browser.killed) {
      browser.kill();
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // Windows can keep Edge profile files locked briefly after headless shutdown.
    }
  }, 500);
}
