import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    throw new Error("Browser URL must start with http:// or https://");
  }
  return target;
}

function findWindowsBrowser() {
  const candidates = [
    process.env.OMNICLAW_BROWSER_PATH,
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.request(url, {
      method: options.method || "GET",
      headers: options.headers || {},
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Status Code: ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(data || "null"));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 10000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.url = webSocketDebuggerUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = null;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== "function") {
        reject(new Error("Node WebSocket runtime is unavailable."));
        return;
      }
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), timeoutMs);
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(this);
      });
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket connection failed"));
      });
      socket.addEventListener("close", () => {
        for (const item of this.pending.values()) {
          item.reject(new Error("CDP WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  onMessage(data) {
    const message = JSON.parse(String(data || "{}"));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP command failed"));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (message.method) {
      this.events.push(message);
      if (this.events.length > 200) {
        this.events = this.events.slice(-200);
      }
    }
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    try {
      this.socket?.close();
    } catch {
      // Ignore close races.
    }
  }
}

/**
 * Browser operator with two layers:
 * - lightweight HTTP fetch for simple read_url/web_fetch
 * - optional real Chromium/Edge automation through Chrome DevTools Protocol
 */
export class BrowserOperator {
  constructor({ rootDir = process.cwd() } = {}) {
    this.rootDir = rootDir;
    this.maxBytes = 200_000;
    this.browserProcess = null;
    this.browserPort = 0;
    this.browserPath = process.platform === "win32" ? findWindowsBrowser() : process.env.OMNICLAW_BROWSER_PATH || "";
    this.userDataDir = "";
    this.lastPage = null;
    this.screenshotDir = path.join(rootDir, "data", "generated", "browser-screenshots");
  }

  getStatus() {
    return {
      ready: Boolean(this.browserPath),
      browserPath: this.browserPath,
      running: Boolean(this.browserProcess && !this.browserProcess.killed),
      port: this.browserPort || null,
      lastPage: this.lastPage,
      capabilities: {
        openUrl: true,
        readUrl: true,
        devtoolsNavigate: Boolean(this.browserPath),
        screenshot: Boolean(this.browserPath),
        text: Boolean(this.browserPath),
        links: Boolean(this.browserPath),
        click: Boolean(this.browserPath),
        type: Boolean(this.browserPath),
      },
      message: this.browserPath
        ? "Chromium/Edge DevTools automation is available."
        : "No Chrome/Edge browser executable was found. Set OMNICLAW_BROWSER_PATH to enable automation.",
    };
  }

  async ensureBrowser() {
    if (!this.browserPath) {
      throw new Error("No Chrome/Edge browser executable found. Set OMNICLAW_BROWSER_PATH.");
    }
    if (this.browserProcess && this.browserPort) {
      try {
        await requestJson(`http://127.0.0.1:${this.browserPort}/json/version`, { timeoutMs: 1000 });
        return;
      } catch {
        this.browserProcess = null;
        this.browserPort = 0;
      }
    }

    this.browserPort = 9222 + Math.floor(Math.random() * 1000);
    this.userDataDir = path.join(os.tmpdir(), `omniclaw-browser-${process.pid}-${Date.now()}`);
    fs.mkdirSync(this.userDataDir, { recursive: true });
    this.browserProcess = spawn(this.browserPath, [
      `--remote-debugging-port=${this.browserPort}`,
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--disable-background-networking",
      "--headless=new",
      "about:blank",
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    this.browserProcess.unref();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await requestJson(`http://127.0.0.1:${this.browserPort}/json/version`, { timeoutMs: 1000 });
        return;
      } catch {
        await sleep(250);
      }
    }
    throw new Error("Browser DevTools endpoint did not become ready.");
  }

  async createPage(url = "about:blank") {
    await this.ensureBrowser();
    const encoded = encodeURIComponent(url);
    try {
      return await requestJson(`http://127.0.0.1:${this.browserPort}/json/new?${encoded}`, { method: "PUT" });
    } catch {
      return requestJson(`http://127.0.0.1:${this.browserPort}/json/new?${encoded}`);
    }
  }

  async connectToPage(page) {
    if (!page.webSocketDebuggerUrl) {
      throw new Error("Browser page did not expose a DevTools WebSocket URL.");
    }
    const client = await new CdpClient(page.webSocketDebuggerUrl).connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    return { page, client };
  }

  async connectPage(url = "") {
    const page = url ? await this.createPage(url) : this.lastPage || await this.createPage();
    try {
      return await this.connectToPage(page);
    } catch (error) {
      if (url || !this.lastPage) {
        throw error;
      }
      this.lastPage = null;
      return this.connectToPage(await this.createPage());
    }
  }

  async automate(input = {}) {
    const action = String(input.action || "status").trim().toLowerCase();
    if (action === "status") {
      return this.getStatus();
    }
    if (["navigate", "goto", "open"].includes(action)) {
      return this.navigate(input);
    }
    if (["screenshot", "capture"].includes(action)) {
      return this.screenshot(input);
    }
    if (["text", "read"].includes(action)) {
      return this.pageText(input);
    }
    if (action === "links") {
      return this.pageLinks(input);
    }
    if (action === "click") {
      return this.click(input);
    }
    if (["type", "fill"].includes(action)) {
      return this.type(input);
    }
    throw new Error(`Unsupported browser automation action: ${action}`);
  }

  async navigate({ url, screenshot = true } = {}) {
    const target = normalizeUrl(url);
    const { page, client } = await this.connectPage(target);
    try {
      await client.send("Page.navigate", { url: target });
      await sleep(1800);
      const title = await this.evaluate(client, "document.title");
      const text = await this.evaluate(client, "document.body ? document.body.innerText.slice(0, 6000) : ''");
      const result = {
        ok: true,
        action: "navigate",
        url: target,
        pageId: page.id,
        title,
        textPreview: text,
      };
      this.lastPage = page;
      if (screenshot) {
        result.screenshot = await this.captureScreenshot(client, "navigate");
      }
      return result;
    } finally {
      await client.close();
    }
  }

  async screenshot() {
    const { page, client } = await this.connectPage();
    try {
      const title = await this.evaluate(client, "document.title");
      const screenshot = await this.captureScreenshot(client, "screenshot");
      this.lastPage = page;
      return {
        ok: true,
        action: "screenshot",
        pageId: page.id,
        title,
        screenshot,
      };
    } finally {
      await client.close();
    }
  }

  async pageText({ selector = "body" } = {}) {
    const { page, client } = await this.connectPage();
    try {
      const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}) || document.body; return el ? el.innerText.slice(0, 12000) : ""; })()`;
      const text = await this.evaluate(client, expression);
      this.lastPage = page;
      return {
        ok: true,
        action: "text",
        pageId: page.id,
        selector,
        text,
        length: String(text || "").length,
      };
    } finally {
      await client.close();
    }
  }

  async pageLinks() {
    const { page, client } = await this.connectPage();
    try {
      const links = await this.evaluate(client, `Array.from(document.querySelectorAll("a")).slice(0, 80).map((a) => ({ text: (a.innerText || a.title || "").trim().slice(0, 160), href: a.href }))`);
      this.lastPage = page;
      return {
        ok: true,
        action: "links",
        pageId: page.id,
        links: Array.isArray(links) ? links : [],
      };
    } finally {
      await client.close();
    }
  }

  async click({ selector } = {}) {
    if (!selector) {
      throw new Error("selector is required for browser click.");
    }
    const { page, client } = await this.connectPage();
    try {
      const result = await this.evaluate(client, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { clicked: false, reason: "not found" }; el.click(); return { clicked: true, text: (el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 160) }; })()`);
      await sleep(800);
      this.lastPage = page;
      return {
        ok: Boolean(result?.clicked),
        action: "click",
        pageId: page.id,
        selector,
        result,
      };
    } finally {
      await client.close();
    }
  }

  async type({ selector, text } = {}) {
    if (!selector) {
      throw new Error("selector is required for browser type.");
    }
    const { page, client } = await this.connectPage();
    try {
      const result = await this.evaluate(client, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { typed: false, reason: "not found" }; el.focus(); el.value = ${JSON.stringify(String(text || ""))}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { typed: true, valueLength: el.value.length }; })()`);
      this.lastPage = page;
      return {
        ok: Boolean(result?.typed),
        action: "type",
        pageId: page.id,
        selector,
        result,
      };
    } finally {
      await client.close();
    }
  }

  async evaluate(client, expression) {
    const result = await client.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
    }
    return result.result?.value;
  }

  async captureScreenshot(client, label = "screenshot") {
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const result = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    }, 20000);
    const fileName = `${createId(label)}.png`;
    const filePath = path.join(this.screenshotDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(result.data || "", "base64"));
    return {
      path: filePath,
      bytes: fs.statSync(filePath).size,
      mimeType: "image/png",
    };
  }

  async readUrl(url) {
    try {
      const target = normalizeUrl(url);
      const html = await this.fetchHtml(target);
      const markdown = this.htmlToMarkdown(html);
      return {
        url: target,
        content: markdown,
        length: markdown.length,
        status: "success",
      };
    } catch (error) {
      return {
        url,
        error: error.message,
        status: "error",
      };
    }
  }

  openUrl(url) {
    const target = normalizeUrl(url);
    const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      opened: true,
      url: target,
      app: process.platform === "win32" ? "default Windows browser" : "default browser",
    };
  }

  fetchHtml(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const req = client.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OmniClaw/2.2",
        },
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Status Code: ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > this.maxBytes) {
            req.destroy();
            resolve(`${data}\n\n... (content truncated)`);
          }
        });
        res.on("end", () => resolve(data));
      });

      req.on("error", (err) => reject(err));
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
    });
  }

  htmlToMarkdown(html) {
    let text = html;
    text = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "");
    text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "");
    text = text.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gmi, (m, c) => `\n## ${c.trim()}\n`);
    text = text.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gmi, (m, c) => `\n${c.trim()}\n`);
    text = text.replace(/<br\s*\/?>/gmi, "\n");
    text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gmi, (m, c) => `* ${c.trim()}\n`);
    text = text.replace(/<[^>]+>/g, "");
    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
    return text.trim();
  }
}
