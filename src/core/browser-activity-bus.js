import { EventEmitter } from "node:events";

/**
 * One place every browser action an AGENT performs is announced, whichever
 * stack performed it — the CDP tools (browser_remote_*) or Playwright
 * (browser_*). The live view subscribes here to draw the agent's cursor.
 *
 * Without this the panel could only show pixels, and "the agent clicked
 * something, somewhere" is exactly the part a human watching needs to see. A
 * screenshot cannot show it: CDP dispatches synthetic input, so no real mouse
 * pointer ever moves and nothing appears in the captured frame.
 *
 * Kept as a standalone module rather than a method on either browser class so
 * both stacks can publish without importing each other.
 */

const bus = new EventEmitter();
// The dock, an inspector and a couple of agents can all watch at once; the
// default limit of 10 would start printing leak warnings.
bus.setMaxListeners(64);

const recent = [];
const MAX_RECENT = 200;

/**
 * @param {{source: "cdp"|"playwright", type: string, x?: number, y?: number,
 *          selector?: string, text?: string, url?: string, tabId?: string,
 *          sessionId?: string, label?: string}} action
 */
export function publishBrowserAction(action = {}) {
  const entry = {
    at: new Date().toISOString(),
    source: action.source || "cdp",
    type: action.type || "action",
    ...action,
  };
  // Typed text is echoed to a human watching the panel; a password field would
  // put a credential on screen and into the recent-actions buffer. Length is
  // enough to show "the agent is typing".
  if (entry.secret && entry.text) entry.text = "•".repeat(Math.min(String(entry.text).length, 24));
  recent.push(entry);
  while (recent.length > MAX_RECENT) recent.shift();
  bus.emit("action", entry);
  return entry;
}

/** @returns {() => void} unsubscribe */
export function onBrowserAction(listener) {
  bus.on("action", listener);
  return () => bus.off("action", listener);
}

export function recentBrowserActions(limit = 40) {
  return recent.slice(-Math.max(1, Number(limit) || 40));
}

export default { publishBrowserAction, onBrowserAction, recentBrowserActions };
