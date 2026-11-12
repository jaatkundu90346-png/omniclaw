// Minimal Chrome DevTools Protocol client used by the marketing capture scripts.
//
// Raw CDP on purpose: Playwright's connectOverCDP handshake timed out against
// the Chrome that OmniClaw launches, and a hand-rolled client gives exact
// control over which tab is foreground (a background tab never paints, which is
// why a "live" capture has to keep OmniClaw in front).
import WebSocket from "ws";

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.methods = new Map();
    this.events = [];
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          const method = this.methods.get(msg.id) || "cdp";
          this.methods.delete(msg.id);
          reject(new Error(`${method}: ${msg.error.message} (${msg.error.code})`));
        }
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }

  static async connect(url) {
    const version = await (await fetch(`${url}/json/version`)).json();
    if (!version.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl from /json/version");
    const ws = new WebSocket(version.webSocketDebuggerUrl, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
      handshakeTimeout: 15000,
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("CDP socket handshake timed out")), 15000);
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId = "") {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    this.methods.set(id, method);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45000);
    });
  }

  async evaluate(expression, sessionId) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (res?.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.text || "unknown"}`);
    }
    return res?.result?.value;
  }

  /** Wait until the expression returns a truthy value (or the deadline passes). */
  async waitFor(expression, sessionId, { timeoutMs = 20000, everyMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression, sessionId)) return true;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return false;
  }

  async shot(sessionId, file) {
    const res = await this.send("Page.captureScreenshot", { format: "png" }, sessionId);
    fsWrite(file, res.data);
    return file;
  }
}

import fs from "node:fs";
function fsWrite(file, base64) {
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
