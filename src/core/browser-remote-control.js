import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { publishBrowserAction } from "./browser-activity-bus.js";

/**
 * Chrome DevTools Protocol (CDP) client for controlling an ALREADY-RUNNING
 * browser — the user's own Chrome/Firefox with their logged-in sessions.
 *
 * This is deliberately NOT Playwright: Playwright launches a fresh browser with
 * an empty profile, so the user's Gmail/session cookies are absent. Attaching
 * over CDP to `--remote-debugging-port=9222` reuses the real profile, and lets
 * the user keep clicking in the same window while the agent works.
 *
 *   const client = new BrowserRemoteControl("localhost", 9222);
 *   const tabs = await client.listTabs();
 *   await client.attachTab(tabs[0].id);
 *   await client.fillForm(tabs[0].id, [{ selector: "#email", value: "a@b.c" }]);
 */

// `ws` must load in BOTH plain node (source mode) and the packaged pkg exe.
// Inside pkg, a bare `import("ws")` throws "a dynamic import callback was not
// specified", so we createRequire() from the REAL filesystem next to the exe,
// which bypasses the pkg snapshot. Same trick browser-playwright.js uses for
// Playwright — see loadPlaywright() there.
let wsCtor = null;
function loadWebSocket() {
  if (wsCtor) return wsCtor;
  const cwd = process.cwd();
  const bases = [
    path.join(cwd, "index.js"),
    process.execPath,
    path.join(path.dirname(process.execPath), "index.js"),
  ];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const mod = req("ws");
      if (mod) {
        wsCtor = mod.WebSocket || mod;
        return wsCtor;
      }
    } catch { /* try next base */ }
    try {
      const req = createRequire(base);
      const mod = req(path.join(path.dirname(base), "node_modules", "ws"));
      if (mod) {
        wsCtor = mod.WebSocket || mod;
        return wsCtor;
      }
    } catch { /* try next base */ }
  }
  throw new Error(
    "The 'ws' package is required for browser remote control but could not be loaded. Run: npm install ws"
  );
}

// 4B.2: named-key table for inputKey (CDP dispatchKeyEvent needs key + code +
// windowsVirtualKeyCode; printable chars go through Input.insertText instead).
const KEY_DEFS = {
  enter: { key: "Enter", code: "Enter", vk: 13 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  del: { key: "Delete", code: "Delete", vk: 46 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

// Selectors and text are interpolated into JS evaluated in the page. Building
// that string with quote-swapping breaks the moment a selector contains a
// backslash, newline or quote (e.g. [name="x\"y"]). JSON.stringify produces a
// correctly escaped JS string literal for any input, so always use it.
function jsLiteral(value) {
  return JSON.stringify(String(value ?? ""));
}

class CDPSession extends EventEmitter {
  /**
   * Two shapes of session exist, because two shapes of endpoint exist:
   *
   *  - OWN SOCKET: `new CDPSession(wsUrl, tabId)` opens `ws://…/devtools/page/<id>`.
   *    This is the classic path and needs the HTTP `/json/list` discovery that
   *    only a `--remote-debugging-port` browser serves.
   *
   *  - FLAT SESSION: `new CDPSession(null, targetId, parent, sessionId)` rides on
   *    the parent browser-level socket, tagging every message with `sessionId`.
   *    Required for the user's REAL Chrome: with local debugging enabled from
   *    chrome://inspect there is no HTTP discovery and no per-page socket at all,
   *    only `ws://host:port/devtools/browser`. Target.attachToTarget is then the
   *    only way in.
   */
  constructor(webSocketDebuggerUrl, tabId, parent = null, sessionId = "") {
    super();
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.tabId = tabId;
    this.parent = parent;
    this.sessionId = sessionId;
    this.messageId = 0;
    this.pendingMessages = new Map();
    this.connected = false;
    this.ws = null;
    // Flat children routed by sessionId (only ever populated on a browser-level
    // session). Ids stay on the parent: they are unique per socket, not per
    // CDP session, so one map there beats one map per child.
    this.children = new Map();
    // CDP domains are enabled once per session; re-sending Runtime.enable on
    // every call costs a round trip and re-fires executionContextCreated.
    this.enabledDomains = new Set();
    // The user keeps driving this browser while the agent works. Every main-
    // frame navigation lands here so the agent can notice "the human moved to
    // another page" instead of acting on a stale mental model.
    this.activity = [];
    this.activitySeen = 0;
    // Set for the moment around an agent-issued Page.navigate so the resulting
    // event is attributed to the agent, not misreported as the user.
    this.expectAgentNavigation = 0;
    // Set while Page.startScreencast is running, so a second viewer reuses the
    // one stream instead of starting a competing one.
    this.screencast = null;
  }

  recordActivity(entry) {
    this.activity.push({ at: new Date().toISOString(), ...entry });
    while (this.activity.length > 100) this.activity.shift();
  }

  /** Activity since the caller last read it; marks it read. */
  drainActivity() {
    const fresh = this.activity.slice(this.activitySeen);
    this.activitySeen = this.activity.length;
    return fresh;
  }

  async connect() {
    // A flat session has nothing to dial — the parent socket is already open and
    // Target.attachToTarget has already handed us a sessionId.
    if (this.parent) {
      if (!this.parent.connected) throw new Error("Browser-level CDP socket is closed. Reconnect first.");
      this.connected = true;
      this.parent.children.set(this.sessionId, this);
      return this;
    }
    const WebSocketImpl = loadWebSocket();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      try {
        this.ws = new WebSocketImpl(this.webSocketDebuggerUrl, {
          // DevTools frames carry full DOM/screenshot payloads; the default
          // 100MB is fine but the handshake needs a real timeout so a wrong
          // port hangs the agent for seconds, not forever.
          handshakeTimeout: 10000,
          maxPayload: 256 * 1024 * 1024,
        });
      } catch (error) {
        fail(error);
        return;
      }

      const connectTimer = setTimeout(() => {
        try { this.ws.close(); } catch { /* ignore */ }
        fail(new Error(`CDP connect timeout for tab ${this.tabId}`));
      }, 12000);
      connectTimer.unref?.();

      this.ws.on("open", () => {
        clearTimeout(connectTimer);
        this.connected = true;
        if (!settled) {
          settled = true;
          resolve(this);
        }
      });

      this.ws.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return; // a frame we can't parse is not worth killing the session over
        }
        if (message.id) {
          const pending = this.pendingMessages.get(message.id);
          if (!pending) return;
          this.pendingMessages.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message || "CDP error"));
          } else {
            pending.resolve(message.result);
          }
        } else if (message.method) {
          // An event carrying a sessionId belongs to a flat child (a page we
          // attached to through this browser socket), not to the browser itself.
          const child = message.sessionId ? this.children.get(message.sessionId) : null;
          if (child) {
            if (message.method === "Target.detachedFromTarget") {
              child.connected = false;
              this.children.delete(message.sessionId);
              child.emit("closed");
              return;
            }
            child.emit("message", message);
            return;
          }
          this.emit("message", message);
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectTimer);
        if (!this.connected) fail(error);
        else this.emit("error", error);
      });

      this.ws.on("close", () => {
        clearTimeout(connectTimer);
        this.connected = false;
        // Anything still in flight will never resolve — reject it now instead
        // of leaving the caller's await hanging until the 30s timeout.
        for (const [, pending] of this.pendingMessages) {
          pending.reject(new Error("CDP session closed"));
        }
        this.pendingMessages.clear();
        // Flat children have no socket of their own, so nothing else would ever
        // tell them the transport underneath them is gone.
        for (const [, child] of this.children) {
          child.connected = false;
          child.emit("closed");
        }
        this.children.clear();
        this.emit("closed");
      });
    });
  }

  async send(method, params = {}) {
    if (!this.connected) {
      throw new Error("CDP session not connected. Attach the tab again.");
    }
    // Flat session: the parent owns the socket and the message-id space. Adding
    // `sessionId` is the whole difference between "do this to the browser" and
    // "do this to my page".
    if (this.parent) return this.parent.sendOn(this.sessionId, method, params);
    return this.sendOn("", method, params);
  }

  /** @param {string} sessionId "" for this session's own target */
  async sendOn(sessionId, method, params = {}) {
    if (!this.connected) {
      throw new Error("CDP session not connected. Attach the tab again.");
    }

    return new Promise((resolve, reject) => {
      this.messageId += 1;
      const id = this.messageId;

      const timeout = setTimeout(() => {
        this.pendingMessages.delete(id);
        reject(new Error(`CDP timeout after 30s: ${method}`));
      }, 30000);
      timeout.unref?.();

      this.pendingMessages.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });

      try {
        this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMessages.delete(id);
        reject(error);
      }
    });
  }

  async enableDomain(domain) {
    if (this.enabledDomains.has(domain)) return;
    await this.send(`${domain}.enable`);
    this.enabledDomains.add(domain);
  }

  async close() {
    // Detaching a flat session must NOT close the browser socket its siblings
    // (and the tab list) are still using.
    if (this.parent) {
      const { parent, sessionId } = this;
      this.connected = false;
      parent.children.delete(sessionId);
      if (parent.connected) {
        await parent.sendOn("", "Target.detachFromTarget", { sessionId }).catch(() => { /* already gone */ });
      }
      return;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.connected = false;
    }
  }
}

class BrowserRemoteControl {
  constructor(host = "localhost", port = 9222, useHttps = false) {
    this.host = host;
    this.port = port;
    this.useHttps = useHttps;
    this.protocol = useHttps ? "https" : "http";
    this.sessions = new Map();
    // "http": a --remote-debugging-port browser, /json/* discovery available.
    // "ws":   the user's real Chrome with local debugging enabled from
    //         chrome://inspect — ONLY ws://host:port/devtools/browser exists.
    // Resolved on first use by transport().
    this.mode = "";
    this.browser = null;
  }

  /**
   * Which of the two endpoint shapes this port speaks.
   *
   * Chrome 136+ ignores --remote-debugging-port whenever it would expose the
   * DEFAULT profile, so the only way to drive the browser the user is actually
   * logged into is the chrome://inspect#remote-debugging toggle. That endpoint
   * serves NO HTTP: /json/version, /json/list and / all 404, and a WebSocket on
   * / is refused by the origin check. `ws://host:port/devtools/browser` works
   * and speaks ordinary CDP. HTTP is probed first so the classic path
   * (OmniClaw's own launched profile) keeps its cheaper discovery route.
   */
  async transport() {
    if (this.mode) return this.mode;
    try {
      const version = await this.fetch("/json/version");
      if (version && !version.raw) {
        this.mode = "http";
        return this.mode;
      }
    } catch { /* fall through to the WebSocket probe */ }
    await this.openBrowserSession();
    this.mode = "ws";
    return this.mode;
  }

  /** The browser-level CDP session, opened once and reused. */
  async openBrowserSession() {
    if (this.browser?.connected) return this.browser;
    const scheme = this.useHttps ? "wss" : "ws";
    const session = new CDPSession(`${scheme}://${this.host}:${this.port}/devtools/browser`, "__browser__");
    await session.connect();
    // A socket that opens but does not answer Browser.getVersion is not CDP —
    // better to fail here than inside the first tool call.
    await session.send("Browser.getVersion").catch(async (error) => {
      await session.close();
      throw error;
    });
    session.on("closed", () => { if (this.browser === session) this.browser = null; });
    this.browser = session;
    return session;
  }

  // `method` matters: modern Chrome rejects GET on /json/new with "Using unsafe
  // HTTP verb GET ... supports only PUT verb", so tab creation must send PUT.
  async fetch(routePath, method = "GET") {
    return new Promise((resolve, reject) => {
      const client = this.useHttps ? https : http;
      const req = client.request(
        {
          hostname: this.host,
          port: this.port,
          path: routePath,
          method,
          timeout: 10000,
          // Chrome rejects /json/* requests whose Host header is not an IP or
          // "localhost" (DNS-rebinding protection). Being explicit keeps this
          // working when host is a LAN name.
          headers: { Host: `${this.host}:${this.port}` },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            // A 404 here is the signature of the chrome://inspect endpoint,
            // which serves no DevTools HTTP at all. Reject so transport() falls
            // through to the WebSocket probe instead of treating it as garbage.
            if (res.statusCode === 404) {
              reject(new Error(`HTTP 404 from ${routePath} — no DevTools HTTP discovery on this port`));
              return;
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              // /json/close answers with the plain text "Target is closing" —
              // a successful non-JSON body is not an error.
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ raw: data.trim() });
                return;
              }
              reject(new Error(`HTTP ${res.statusCode} from ${routePath}: ${data.slice(0, 120)}`));
            }
          });
        }
      );
      req.on("error", (error) =>
        reject(new Error(`${error.code || "ERR"} connecting to ${this.host}:${this.port} — ${error.message}`))
      );
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Timeout connecting to ${this.host}:${this.port}`));
      });
      req.end();
    });
  }

  async listTabs() {
    if ((await this.transport()) === "ws") {
      const session = await this.openBrowserSession();
      const { targetInfos = [] } = await session.send("Target.getTargets");
      return targetInfos
        .filter((t) => t.type === "page" && !String(t.url || "").startsWith("devtools://"))
        .map((t) => ({ id: t.targetId, type: "page", url: t.url, title: t.title, attached: t.attached }));
    }
    const tabs = await this.fetch("/json/list");
    if (!Array.isArray(tabs)) return [];
    // Service workers / extension backgrounds show up here too and cannot be
    // screenshotted or clicked; only real pages are useful to an agent.
    return tabs.filter((tab) => tab.type === "page" && tab.webSocketDebuggerUrl);
  }

  async version() {
    if ((await this.transport()) === "ws") {
      const session = await this.openBrowserSession();
      const info = await session.send("Browser.getVersion");
      return {
        Browser: info.product,
        "Protocol-Version": info.protocolVersion,
        "User-Agent": info.userAgent,
        webSocketDebuggerUrl: session.webSocketDebuggerUrl,
        // Flags the real-profile endpoint, so callers can say "your Chrome"
        // instead of "the OmniClaw profile".
        localDebugging: true,
      };
    }
    return this.fetch("/json/version");
  }

  async newTab(url = "about:blank") {
    if ((await this.transport()) === "ws") {
      const session = await this.openBrowserSession();
      const { targetId } = await session.send("Target.createTarget", { url: String(url) });
      return { id: targetId, targetId, url: String(url), type: "page" };
    }
    return this.fetch(`/json/new?${encodeURIComponent(url)}`, "PUT");
  }

  async closeTab(tabId) {
    await this.detachTab(tabId);
    if ((await this.transport()) === "ws") {
      const session = await this.openBrowserSession();
      return session.send("Target.closeTarget", { targetId: tabId });
    }
    return this.fetch(`/json/close/${tabId}`, "PUT").catch(() =>
      // Older Chrome answers /json/close on GET and 405s on PUT; newer builds
      // are the reverse. Try both rather than leaking the tab.
      this.fetch(`/json/close/${tabId}`, "GET")
    );
  }

  async attachTab(tabId) {
    const existing = this.sessions.get(tabId);
    if (existing?.connected) return existing;

    const session = (await this.transport()) === "ws"
      ? await this.attachFlat(tabId)
      : await this.attachOwnSocket(tabId);

    session.on("closed", () => {
      if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
    });

    // Watch main-frame navigations so the agent can see the user's own moves.
    session.on("message", (message) => {
      if (message.method !== "Page.frameNavigated") return;
      const frame = message.params?.frame;
      if (!frame || frame.parentId) return; // sub-frames are noise
      const byAgent = session.expectAgentNavigation > 0;
      if (byAgent) session.expectAgentNavigation -= 1;
      session.recordActivity({
        type: "navigated",
        by: byAgent ? "agent" : "user",
        url: String(frame.url || "").slice(0, 300),
      });
    });
    await session.enableDomain("Page").catch(() => {
      /* activity tracking is best-effort; never block attach on it */
    });

    this.sessions.set(tabId, session);
    return session;
  }

  /**
   * chrome://inspect endpoint: one browser socket, page sessions multiplexed on
   * it. There is no per-page WebSocket URL to dial here, so Target.attachToTarget
   * is the only way in — and it is also the only path that works against the
   * profile the user is already signed into.
   */
  async attachFlat(targetId) {
    const browser = await this.openBrowserSession();
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    if (!sessionId) throw new Error(`Could not attach to tab ${targetId} — Chrome returned no sessionId.`);
    const session = new CDPSession(null, targetId, browser, sessionId);
    await session.connect();
    return session;
  }

  /** Classic --remote-debugging-port endpoint: dial the page's own socket. */
  async attachOwnSocket(tabId) {
    const tabs = await this.listTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}. It may have been closed — list tabs again.`);
    }
    if (!tab.webSocketDebuggerUrl) {
      throw new Error(
        `Tab ${tabId} has no debugger URL. Another DevTools client (an open DevTools window) is probably already attached to it.`
      );
    }
    const session = new CDPSession(tab.webSocketDebuggerUrl, tabId);
    await session.connect();
    return session;
  }

  requireSession(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || !session.connected) {
      throw new Error(`No attached session for tab ${tabId}. Attach the tab first.`);
    }
    return session;
  }

  async detachTab(tabId) {
    const session = this.sessions.get(tabId);
    if (session) {
      await session.close();
      this.sessions.delete(tabId);
    }
  }

  async navigate(tabId, url, { actor = "agent" } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Page");
    // Claim the frameNavigated this is about to produce, so it is not reported
    // back to the agent as a user action.
    session.expectAgentNavigation += 1;
    const result = await session.send("Page.navigate", { url }).catch((error) => {
      session.expectAgentNavigation = Math.max(0, session.expectAgentNavigation - 1);
      throw error;
    });
    if (result?.errorText) {
      throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    }
    // B6: short human label for the action log ("Navigated to youtube.com").
    let host = String(url);
    try { host = new URL(String(url)).host || String(url); } catch {}
    publishBrowserAction({ source: "cdp", actor, type: "navigate", tabId, url: String(url), label: `Navigated to ${host}` });
    return result;
  }

  /** @returns {Promise<string>} base64 PNG */
  async screenshot(tabId) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Page");
    const result = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (!result?.data) throw new Error("Screenshot returned no data");
    return result.data;
  }

  /**
   * A COMPACT page summary. The obvious implementation calls
   * DOMSnapshot.captureSnapshot, but that returns megabytes of node/style
   * arrays — dumping it into an agent's context is both useless and ruinously
   * expensive. Instead run one script in the page and return the same shape of
   * text + interactive-element refs that browser_snapshot produces, so the
   * model can act on it directly.
   */
  async getPageState(tabId, { maxElements = 60 } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Runtime");

    const tabs = await this.listTabs().catch(() => []);
    const tab = tabs.find((t) => t.id === tabId) || null;

    const expression = `(() => {
      const visible = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
      };
      const sel = (el) => {
        if (el.id) {
          try { if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id); } catch {}
        }
        for (const a of ["data-testid","name","aria-label","placeholder","type"]) {
          const v = el.getAttribute(a);
          if (!v) continue;
          const c = el.tagName.toLowerCase() + "[" + a + "=" + JSON.stringify(v) + "]";
          try { if (document.querySelectorAll(c).length === 1) return c; } catch {}
        }
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
          let i = 1, sib = cur;
          while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) i++;
          parts.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
          cur = cur.parentElement;
        }
        return parts.join(" > ") || el.tagName.toLowerCase();
      };
      const els = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role=button],[contenteditable=true]"))
        .filter(visible)
        .slice(0, ${Number(maxElements) || 60})
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          name: (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || (el.innerText || el.value || "")).trim().replace(/\\s+/g, " ").slice(0, 80),
          selector: sel(el),
          value: el.value === undefined ? undefined : String(el.value).slice(0, 60),
          disabled: Boolean(el.disabled),
        }));
      return {
        readyState: document.readyState,
        text: (document.body ? document.body.innerText : "").trim().replace(/\\s+/g, " ").slice(0, 1500),
        elements: els,
      };
    })()`;

    const evaluated = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (evaluated.exceptionDetails) {
      throw new Error(
        `Page state probe failed: ${evaluated.exceptionDetails.text || evaluated.exceptionDetails.exception?.description}`
      );
    }

    const probe = evaluated.result?.value || {};
    const elements = (probe.elements || []).map((el, i) => ({ ref: `@e${i + 1}`, ...el }));

    return {
      url: tab?.url || "",
      title: tab?.title || "",
      favicon: tab?.faviconUrl || "",
      readyState: probe.readyState || "unknown",
      text: probe.text || "",
      elements,
      activity: session.drainActivity(),
    };
  }

  async click(tabId, selector, { actor = "agent" } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Runtime");

    // Scroll into view first: dispatchMouseEvent uses VIEWPORT coordinates, so
    // clicking an element below the fold silently hits whatever is on screen at
    // those coordinates instead. This was the subtlest bug in the first cut.
    const located = await session.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${jsLiteral(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        return { found: true, inView, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
      returnByValue: true,
    });

    const box = located.result?.value;
    if (!box?.found) throw new Error(`Element not found: ${selector}`);
    if (!box.inView) throw new Error(`Element could not be scrolled into view: ${selector}`);

    // Move before pressing. Hover styles, tooltips and canvas games that track
    // mousemove all need it, and it is also what lets the live view animate the
    // cursor travelling to the target instead of teleporting.
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 }).catch(() => {});
    for (const type of ["mousePressed", "mouseReleased"]) {
      await session.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    publishBrowserAction({ source: "cdp", actor, type: "click", tabId, x: box.x, y: box.y, selector, label: `Clicked '${String(selector).slice(0, 48)}'` });
    return { success: true, x: box.x, y: box.y };
  }

  /**
   * Click raw viewport coordinates. This is what makes the live-view panel
   * interactive: the user clicks the screenshot, we map the pixel back to CSS
   * viewport space and dispatch a real mouse event there.
   */
  async clickAt(tabId, x, y, { actor = "agent" } = {}) {
    const session = this.requireSession(tabId);
    const px = Math.round(Number(x));
    const py = Math.round(Number(y));
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      throw new Error("clickAt requires numeric x and y");
    }
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, buttons: 0 }).catch(() => {});
    for (const type of ["mousePressed", "mouseReleased"]) {
      await session.send("Input.dispatchMouseEvent", {
        type,
        x: px,
        y: py,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    publishBrowserAction({ source: "cdp", actor, type: "click", tabId, x: px, y: py, label: `Clicked (${px}, ${py})` });
    return { success: true, x: px, y: py };
  }

  /** Raise the tab in its window. Required before capture — see startScreencast. */
  async bringToFront(tabId) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Page");
    await session.send("Page.bringToFront").catch(() => { /* a minimised window still streams */ });
  }

  /**
   * Continuous live video of the tab, as a stream of JPEG frames pushed by
   * Chrome whenever the page actually changes.
   *
   * This is what makes "watch the agent play the game" work. Polling
   * Page.captureScreenshot cannot: each capture is a full round trip, so the
   * best it manages is well under 1fps of real motion, and it burns CPU
   * re-encoding identical frames while nothing moves.
   *
   * @returns {Promise<() => void>} call it to stop watching
   */
  async startScreencast(tabId, options = {}, onFrame) {
    if (typeof onFrame !== "function") throw new Error("startScreencast requires an onFrame callback");
    const session = this.requireSession(tabId);
    await session.enableDomain("Page");

    if (!session.screencast) {
      // Chrome does not produce screencast frames for a BACKGROUND tab, so a
      // live view of a tab the user is not looking at freezes on frame one.
      // This is done ONCE when the stream is created, NOT on every viewer
      // attach: bringToFront also defeats Chrome's background throttling, so
      // calling it per reconnect pinned the tab at full render rate forever.
      await session.send("Page.bringToFront").catch(() => { /* best effort */ });
      const viewers = new Set();
      const handler = (message) => {
        if (message.method !== "Page.screencastFrame") return;
        const params = message.params || {};
        if (session.screencast) session.screencast.gotFrame = true;
        // Chrome sends nothing further until each frame is acknowledged. Miss
        // this and the stream delivers exactly one frame, which looks like a
        // freeze rather than a bug.
        session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        for (const viewer of viewers) {
          try {
            viewer({ data: params.data, metadata: params.metadata || {} });
          } catch { /* one broken viewer must not kill the stream for the others */ }
        }
      };
      session.on("message", handler);
      const quality = Math.min(100, Math.max(20, Number(options.quality) || 60));
      const maxWidth = Number(options.maxWidth) || 1280;
      const maxHeight = Number(options.maxHeight) || 900;
      session.screencast = { viewers, handler, gotFrame: false, quality, maxWidth, maxHeight };
      await session.send("Page.startScreencast", {
        format: options.format === "png" ? "png" : "jpeg",
        quality,
        maxWidth,
        maxHeight,
        everyNthFrame: Math.max(1, Number(options.everyNthFrame) || 1),
      });

      // A page that has finished loading and sits still never repaints, so
      // Chrome pushes no screencast frames at all and the panel shows an empty
      // box — on exactly the ordinary pages a browsing task starts from. If
      // nothing arrives shortly after attaching, send one snapshot so the
      // viewer always has the current page on screen.
      setTimeout(() => {
        if (!session.screencast || session.screencast.gotFrame) return;
        session.send("Page.captureScreenshot", { format: "jpeg", quality, maxWidth, maxHeight })
          .then((shot) => {
            if (!shot?.data || !session.screencast) return;
            for (const viewer of session.screencast.viewers) {
              try {
                viewer({ data: shot.data, metadata: { deviceWidth: 0, deviceHeight: 0, initial: true } });
              } catch { /* one broken viewer must not kill the stream */ }
            }
          })
          .catch(() => { /* tab closed mid-capture */ });
      }, 700).unref?.();
    }

    session.screencast.viewers.add(onFrame);
    return () => { this.stopScreencast(tabId, onFrame).catch(() => {}); };
  }

  async stopScreencast(tabId, onFrame = null) {
    const session = this.sessions.get(tabId);
    if (!session?.screencast) return;
    if (onFrame) {
      session.screencast.viewers.delete(onFrame);
      // Two dock panels (or a panel and an inspector) can watch the same tab;
      // the last one out turns the stream off.
      if (session.screencast.viewers.size) return;
    }
    const { handler } = session.screencast;
    session.off("message", handler);
    session.screencast = null;
    if (session.connected) await session.send("Page.stopScreencast").catch(() => {});
  }

  /** Viewport size + devicePixelRatio, so a screenshot pixel maps to a CSS point. */
  async viewport(tabId) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Runtime");
    const result = await session.send("Runtime.evaluate", {
      expression: "({w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1})",
      returnByValue: true,
    });
    return result.result?.value || { w: 0, h: 0, dpr: 1 };
  }

  async type(tabId, selector, text, { actor = "agent", quiet = false } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Runtime");

    const focused = await session.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${jsLiteral(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.focus();
        const r = el.getBoundingClientRect();
        return { ok: document.activeElement === el,
                 x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                 secret: el.type === "password" };
      })()`,
      returnByValue: true,
    });
    const target = focused.result?.value;
    if (!target?.ok) {
      throw new Error(`Could not focus element: ${selector} (not found, or not focusable)`);
    }
    // Announce BEFORE typing: the watcher should see the cursor land on the
    // field as the characters appear, not a frame after the value is already in.
    // B6: short human label ("Typed 'lofi'"); the bus masks secrets.
    if (!quiet) {
      const shown = String(text).slice(0, 24);
      publishBrowserAction({
        source: "cdp", actor, type: "type", tabId,
        x: target.x, y: target.y, selector,
        text: String(text), secret: Boolean(target.secret),
        label: `Typed '${shown}'${String(text).length > 24 ? "…" : ""}`,
      });
    }

    // Input.insertText commits the whole string in one CDP round trip and —
    // unlike a per-character dispatchKeyEvent("char") loop — handles non-ASCII
    // (emoji, Devanagari) correctly. React/Vue still see a real input event.
    await session.send("Input.insertText", { text: String(text) });
    return { success: true, typed: String(text).length };
  }

  async evaluate(tabId, script) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Runtime");

    const result = await session.send("Runtime.evaluate", {
      expression: String(script),
      returnByValue: true,
      awaitPromise: true,
      // Gmail and most real apps ship a CSP that blocks eval; userGesture +
      // this flag let DevTools-originated evaluation through anyway.
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true,
    });

    if (result.exceptionDetails) {
      throw new Error(
        `Script error: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description || "unknown"}`
      );
    }
    return result.result?.value;
  }

  async fillForm(tabId, fields, { actor = "agent" } = {}) {
    const results = [];
    for (const field of Array.isArray(fields) ? fields : []) {
      const { selector, value } = field || {};
      try {
        if (!selector) throw new Error("selector is required");
        const session = this.requireSession(tabId);
        await session.enableDomain("Runtime");

        // Clear via the native value setter. Assigning `el.value = ""` directly
        // is swallowed by React, which tracks the last value it set and skips
        // the change; going through the prototype setter defeats that tracking
        // so controlled components actually update.
        await session.send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector(${jsLiteral(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            el.focus();
            const proto = el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(el, ""); else el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`,
          returnByValue: true,
        });

        await this.type(tabId, selector, value, { actor });

        await session.send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector(${jsLiteral(selector)});
            if (!el) return null;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            return el.value === undefined ? null : String(el.value).slice(0, 120);
          })()`,
          returnByValue: true,
        });

        // Read back what the field actually holds. A form can reject, mask or
        // reformat input (phone/date masks), and reporting "filled" without
        // checking is how an agent convinces itself a broken form succeeded.
        const verify = await session.send("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector(${jsLiteral(selector)});
            return el && el.value !== undefined ? String(el.value) : null;
          })()`,
          returnByValue: true,
        });
        const actual = verify.result?.value;

        results.push({
          selector,
          value,
          actual,
          success: true,
          matched: actual === null || actual === undefined ? null : actual === String(value),
        });
      } catch (error) {
        results.push({ selector, value, success: false, error: error.message });
      }
    }
    return results;
  }

  // 4B.2: tab ids with a live CDP session (for tabs[].attached).
  attachedTabs() {
    const out = [];
    for (const [tabId, session] of this.sessions) {
      if (session && session.connected) out.push(tabId);
    }
    return out;
  }

  // 4B.2: raw mouse input for the managed-viewport routes (UI-driven, so the
  // default actor is "user"; agent tools keep using click/clickAt).
  // kind: move | down | up | click (= down+up). Coordinates are VIEWPORT CSS
  // px — the route scales client frame coords before calling.
  async inputMouse(tabId, { kind = "click", x = 0, y = 0, button = "left" } = {}, { actor = "user" } = {}) {
    const session = this.requireSession(tabId);
    const px = Math.max(0, Math.round(Number(x) || 0));
    const py = Math.max(0, Math.round(Number(y) || 0));
    const btn = ["left", "right", "middle"].includes(button) ? button : "left";
    const press = async (type) => {
      await session.send("Input.dispatchMouseEvent", {
        type, x: px, y: py, button: btn, clickCount: 1,
        buttons: type === "mousePressed" ? (btn === "middle" ? 4 : btn === "right" ? 2 : 1) : 0,
      });
    };
    if (kind === "move") {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, buttons: 0 }).catch(() => {});
    } else if (kind === "down") {
      await press("mousePressed");
    } else if (kind === "up") {
      await press("mouseReleased");
    } else {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, buttons: 0 }).catch(() => {});
      await press("mousePressed");
      await press("mouseReleased");
    }
    publishBrowserAction({ source: "cdp", actor, type: "click", tabId, x: px, y: py, label: `Clicked (${px}, ${py})` });
    return { success: true, x: px, y: py };
  }

  // 4B.2: raw keyboard input. Printable text (possibly multi-char) commits via
  // Input.insertText; named keys dispatch rawKeyDown/rawKeyUp with CDP key,
  // code and windowsVirtualKeyCode (Enter, Backspace, Tab, arrows…).
  async inputKey(tabId, { text = "", key = "", code = "", vk = 0 } = {}, { actor = "user" } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Runtime").catch(() => {});
    if (text != null && String(text) !== "" && !key) {
      await session.send("Input.insertText", { text: String(text) });
      publishBrowserAction({
        source: "cdp", actor, type: "key", tabId,
        text: String(text).slice(0, 24), label: `Typed '${String(text).slice(0, 24)}'`,
      });
      return { success: true, typed: String(text).length };
    }
    const def = KEY_DEFS[String(key || "").toLowerCase()] || null;
    const k = def ? def.key : (key || "Unidentified");
    const c = code || (def ? def.code : "");
    const v = Number(vk) || (def ? def.vk : 0);
    // CDP pairs rawKeyDown with keyUp (there is no rawKeyUp).
    await session.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: k, code: c || k, windowsVirtualKeyCode: v,
      ...(k === "Enter" || k === " " ? { text: k === "Enter" ? "\r" : " " } : {}),
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: k, code: c || k, windowsVirtualKeyCode: v,
    });
    publishBrowserAction({ source: "cdp", actor, type: "key", tabId, key: k, label: `Pressed ${k}` });
    return { success: true, key: k };
  }

  // 4B.2: wheel scroll at viewport CSS px. Deltas in CSS px (CDP mouseWheel).
  async inputWheel(tabId, { x = 0, y = 0, deltaX = 0, deltaY = 0 } = {}, { actor = "user" } = {}) {
    const session = this.requireSession(tabId);
    const px = Math.max(0, Math.round(Number(x) || 0));
    const py = Math.max(0, Math.round(Number(y) || 0));
    const dx = Math.max(-10000, Math.min(10000, Math.round(Number(deltaX) || 0)));
    const dy = Math.max(-10000, Math.min(10000, Math.round(Number(deltaY) || 0)));
    if (!dx && !dy) throw new Error("wheel needs deltaX and/or deltaY");
    await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: px, y: py, deltaX: dx, deltaY: dy });
    return { success: true, x: px, y: py, deltaX: dx, deltaY: dy };
  }

  // 4B.2: history traversal via CDP, with a JS fallback for frames whose
  // history CDP cannot enumerate.
  async goBack(tabId, { actor = "user" } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Page").catch(() => {});
    try {
      const { currentIndex, entries } = await session.send("Page.getNavigationHistory");
      if (Array.isArray(entries) && Number.isInteger(currentIndex) && currentIndex > 0) {
        const prev = entries[currentIndex - 1];
        if (prev && prev.id != null) {
          session.expectAgentNavigation += 1;
          await session.send("Page.navigateToHistoryEntry", { entryId: prev.id }).catch((error) => {
            session.expectAgentNavigation = Math.max(0, session.expectAgentNavigation - 1);
            throw error;
          });
          publishBrowserAction({ source: "cdp", actor, type: "navigate", tabId, label: "Went back" });
          return { success: true, via: "history" };
        }
      }
    } catch (error) {
      if (!/history/i.test(String(error?.message || ""))) throw error;
    }
    await session.enableDomain("Runtime").catch(() => {});
    await session.send("Runtime.evaluate", { expression: "history.back()", returnByValue: true });
    publishBrowserAction({ source: "cdp", actor, type: "navigate", tabId, label: "Went back" });
    return { success: true, via: "script" };
  }

  async goForward(tabId, { actor = "user" } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Page").catch(() => {});
    try {
      const { currentIndex, entries } = await session.send("Page.getNavigationHistory");
      if (Array.isArray(entries) && Number.isInteger(currentIndex) && currentIndex < entries.length - 1) {
        const next = entries[currentIndex + 1];
        if (next && next.id != null) {
          session.expectAgentNavigation += 1;
          await session.send("Page.navigateToHistoryEntry", { entryId: next.id }).catch((error) => {
            session.expectAgentNavigation = Math.max(0, session.expectAgentNavigation - 1);
            throw error;
          });
          publishBrowserAction({ source: "cdp", actor, type: "navigate", tabId, label: "Went forward" });
          return { success: true, via: "history" };
        }
      }
    } catch (error) {
      if (!/history/i.test(String(error?.message || ""))) throw error;
    }
    await session.enableDomain("Runtime").catch(() => {});
    await session.send("Runtime.evaluate", { expression: "history.forward()", returnByValue: true });
    publishBrowserAction({ source: "cdp", actor, type: "navigate", tabId, label: "Went forward" });
    return { success: true, via: "script" };
  }

  // 4B.2: reload the tab (route-level; tools can adopt it later).
  async reloadTab(tabId, { actor = "user" } = {}) {
    const session = this.requireSession(tabId);
    await session.enableDomain("Page").catch(() => {});
    session.expectAgentNavigation += 1;
    await session.send("Page.reload", {}).catch((error) => {
      session.expectAgentNavigation = Math.max(0, session.expectAgentNavigation - 1);
      throw error;
    });
    publishBrowserAction({ source: "cdp", actor, type: "reload", tabId, label: "Reloaded" });
    return { success: true };
  }

  async closeAllSessions() {
    for (const [, session] of this.sessions) {
      await session.close();
    }
    this.sessions.clear();
    // In ws mode the browser-level socket outlives every page session, so
    // clearing the map alone would leak it.
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

export default BrowserRemoteControl;
export { BrowserRemoteControl, CDPSession };
