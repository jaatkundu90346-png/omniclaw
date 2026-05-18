import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BROWSER_SESSIONS = new Map();
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min idle timeout

function createSessionId() {
  return `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureBrowser(sessionId, options = {}) {
  let session = BROWSER_SESSIONS.get(sessionId);
  
  if (session && session.browser && session.browser.isConnected()) {
    session.lastUsed = Date.now();
    return session;
  }
  
  const browser = await chromium.launch({
    headless: options.headless !== false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: options.locale || "en-US",
    timezoneId: options.timezone || "Asia/Kolkata",
  });
  
  const page = await context.newPage();
  
  session = {
    id: sessionId,
    browser,
    context,
    page,
    lastUsed: Date.now(),
    createdAt: new Date().toISOString(),
    currentUrl: null,
    history: [],
  };
  
  BROWSER_SESSIONS.set(sessionId, session);
  
  // Setup idle cleanup
  scheduleCleanup(sessionId);
  
  return session;
}

function scheduleCleanup(sessionId) {
  setTimeout(async () => {
    const session = BROWSER_SESSIONS.get(sessionId);
    if (!session) return;
    
    const idleMs = Date.now() - session.lastUsed;
    if (idleMs >= SESSION_TIMEOUT_MS) {
      await closeSession(sessionId);
    } else {
      scheduleCleanup(sessionId);
    }
  }, SESSION_TIMEOUT_MS);
}

async function closeSession(sessionId) {
  const session = BROWSER_SESSIONS.get(sessionId);
  if (!session) return false;
  
  try {
    await session.page?.close?.();
    await session.context?.close?.();
    await session.browser?.close?.();
  } catch (e) {
    // Ignore close errors
  }
  
  BROWSER_SESSIONS.delete(sessionId);
  return true;
}

export class BrowserPlaywright {
  constructor(options = {}) {
    this.defaultSessionId = options.sessionId || createSessionId();
    this.screenshotDir = options.screenshotDir || path.join(os.tmpdir(), "omniclaw-screenshots");
    
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  async open({ url, sessionId, waitUntil = "domcontentloaded" }) {
    const sid = sessionId || this.defaultSessionId;
    const session = await ensureBrowser(sid);
    
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    
    const response = await session.page.goto(normalizedUrl, {
      waitUntil,
      timeout: 30000,
    });
    
    session.currentUrl = normalizedUrl;
    session.history.push({ url: normalizedUrl, timestamp: new Date().toISOString() });
    session.lastUsed = Date.now();
    
    const title = await session.page.title().catch(() => "");
    
    return {
      success: true,
      sessionId: sid,
      url: normalizedUrl,
      title,
      status: response?.status() || 200,
      message: `Opened ${normalizedUrl}`,
    };
  }

  async view({ sessionId, format = "markdown" }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    const url = session.page.url();
    const title = await session.page.title().catch(() => "");
    
    // Get page content
    let content = "";
    let screenshotPath = null;
    
    if (format === "markdown" || format === "both") {
      content = await session.page.evaluate(() => {
        // Extract text content in a readable format
        const body = document.body;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
        const chunks = [];
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent.trim();
          if (text && text.length > 1) {
            chunks.push(text);
          }
        }
        return chunks.join("\n");
      });
    }
    
    if (format === "screenshot" || format === "both") {
      const filename = `screenshot_${Date.now()}.png`;
      screenshotPath = path.join(this.screenshotDir, filename);
      await session.page.screenshot({ path: screenshotPath, fullPage: false });
    }
    
    return {
      success: true,
      sessionId: sid,
      url,
      title,
      content: format !== "screenshot" ? content : undefined,
      screenshotPath,
      message: format === "screenshot" ? "Screenshot saved" : "Page content extracted",
    };
  }

  async screenshot({ sessionId, fullPage = false, selector }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    const filename = `screenshot_${Date.now()}.png`;
    const screenshotPath = path.join(this.screenshotDir, filename);
    
    const options = { path: screenshotPath, fullPage };
    
    if (selector) {
      const element = await session.page.$(selector);
      if (element) {
        await element.screenshot(options);
      } else {
        return { error: `Element not found: ${selector}` };
      }
    } else {
      await session.page.screenshot(options);
    }
    
    return {
      success: true,
      sessionId: sid,
      url: session.page.url(),
      screenshotPath,
      message: "Screenshot saved",
    };
  }

  async click({ sessionId, selector, waitForNavigation = false }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    try {
      await session.page.waitForSelector(selector, { timeout: 5000 });
      
      if (waitForNavigation) {
        await Promise.all([
          session.page.waitForNavigation({ timeout: 30000 }),
          session.page.click(selector),
        ]);
      } else {
        await session.page.click(selector);
      }
      
      session.currentUrl = session.page.url();
      
      return {
        success: true,
        sessionId: sid,
        url: session.currentUrl,
        message: `Clicked: ${selector}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async type({ sessionId, selector, text, pressEnter = false }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    try {
      await session.page.waitForSelector(selector, { timeout: 5000 });
      await session.page.fill(selector, text);
      
      if (pressEnter) {
        await session.page.press(selector, "Enter");
      }
      
      return {
        success: true,
        sessionId: sid,
        message: `Typed "${text}" into ${selector}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async scroll({ sessionId, direction = "down", amount = 500 }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    const scrollY = direction === "down" ? amount : -amount;
    await session.page.evaluate((y) => {
      window.scrollBy(0, y);
    }, scrollY);
    
    return {
      success: true,
      sessionId: sid,
      message: `Scrolled ${direction} by ${amount}px`,
    };
  }

  async wait({ sessionId, selector, timeout = 10000 }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    try {
      if (selector) {
        await session.page.waitForSelector(selector, { timeout });
      } else {
        await session.page.waitForTimeout(timeout);
      }
      
      return {
        success: true,
        sessionId: sid,
        message: selector ? `Element found: ${selector}` : `Waited ${timeout}ms`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async evaluate({ sessionId, script }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    
    try {
      const result = await session.page.evaluate(script);
      return {
        success: true,
        sessionId: sid,
        result,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async goBack({ sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    await session.page.goBack();
    session.currentUrl = session.page.url();
    
    return {
      success: true,
      sessionId: sid,
      url: session.currentUrl,
      message: "Navigated back",
    };
  }

  async goForward({ sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    const session = BROWSER_SESSIONS.get(sid);
    
    if (!session || !session.page) {
      return { error: "No active browser session. Use browser_open first." };
    }
    
    session.lastUsed = Date.now();
    await session.page.goForward();
    session.currentUrl = session.page.url();
    
    return {
      success: true,
      sessionId: sid,
      url: session.currentUrl,
      message: "Navigated forward",
    };
  }

  async close({ sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    const closed = await closeSession(sid);
    
    return {
      success: closed,
      sessionId: sid,
      message: closed ? "Browser session closed" : "Session not found",
    };
  }

  listSessions() {
    const sessions = [];
    for (const [id, session] of BROWSER_SESSIONS) {
      sessions.push({
        id,
        currentUrl: session.currentUrl,
        createdAt: session.createdAt,
        lastUsed: new Date(session.lastUsed).toISOString(),
      });
    }
    return sessions;
  }

  // High-level automation: perform a task on a page
  async automate({ url, actions, sessionId }) {
    const sid = sessionId || this.defaultSessionId;
    
    // Open page
    const openResult = await this.open({ url, sessionId: sid });
    if (openResult.error) {
      return openResult;
    }
    
    const results = [];
    
    // Execute actions
    for (const action of actions) {
      let result;
      
      switch (action.type) {
        case "click":
          result = await this.click({ sessionId: sid, selector: action.selector, waitForNavigation: action.waitForNavigation });
          break;
        case "type":
          result = await this.type({ sessionId: sid, selector: action.selector, text: action.text, pressEnter: action.pressEnter });
          break;
        case "scroll":
          result = await this.scroll({ sessionId: sid, direction: action.direction, amount: action.amount });
          break;
        case "wait":
          result = await this.wait({ sessionId: sid, selector: action.selector, timeout: action.timeout });
          break;
        case "screenshot":
          result = await this.screenshot({ sessionId: sid, fullPage: action.fullPage });
          break;
        case "evaluate":
          result = await this.evaluate({ sessionId: sid, script: action.script });
          break;
        default:
          result = { error: `Unknown action: ${action.type}` };
      }
      
      results.push({ action: action.type, ...result });
      
      if (result.error) {
        break;
      }
    }
    
    return {
      success: !results.some((r) => r.error),
      sessionId: sid,
      url: openResult.url,
      actions: results,
    };
  }
}

export default BrowserPlaywright;
