import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BrowserRemoteControl from "./browser-remote-control.js";
// Statically imported on purpose: a dynamic import() of a local module is not
// reliable inside the packaged pkg exe (same failure mode as import("ws")).
import { launchDebugBrowser, browserLaunchStatus } from "./browser-launcher.js";

/**
 * Agent-facing tools for driving the user's OWN browser over CDP.
 *
 * Returns a map in the shape tool-registry.js expects:
 *   { tool_id: { description, permission, group, schema, run(input, context) } }
 *
 * Design notes that matter for agents:
 *  - There is ONE implicit "current tab", so a model that forgets to pass
 *    tabIndex still works. Tools auto-connect and auto-attach rather than
 *    erroring with "call connect first" — that round-trip tax was the single
 *    biggest source of wasted turns in the Playwright browser tools.
 *  - Screenshots are written to DISK and returned as a path. Returning a
 *    base64 PNG inline would add ~500k tokens of noise to the transcript.
 */

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 9222;

const state = {
  clients: new Map(), // "host:port" -> BrowserRemoteControl
  lastKey: null,
  lastTabId: null,
};

function keyFor(host, port) {
  return `${host || DEFAULT_HOST}:${port || DEFAULT_PORT}`;
}

// Note what this does NOT say any more: "run chrome.exe --remote-debugging-port
// yourself". Chrome 136+ ignores that flag on the default profile, so the old
// advice sent people into an ECONNREFUSED they could not fix by following it.
const LAUNCH_HINT =
  "No browser is listening on the debug port. Two ways to fix it: (a) the user turns on local debugging in their OWN " +
  "Chrome at chrome://inspect/#remote-debugging — best when the task needs their real logged-in accounts; or " +
  "(b) call browser_remote_launch, which opens a real Chrome window on a persistent OmniClaw profile. Then retry.";

async function getClient({ host, port, useHttps } = {}) {
  const resolvedHost = host || (state.lastKey ? state.lastKey.split(":")[0] : DEFAULT_HOST);
  const resolvedPort = Number(port) || (state.lastKey ? Number(state.lastKey.split(":")[1]) : DEFAULT_PORT);
  const key = keyFor(resolvedHost, resolvedPort);

  let client = state.clients.get(key);
  if (!client) {
    client = new BrowserRemoteControl(resolvedHost, resolvedPort, Boolean(useHttps));
    // Probe before caching so a dead port doesn't leave a poisoned client.
    await client.version();
    state.clients.set(key, client);
  }
  state.lastKey = key;
  return { client, key };
}

/**
 * Resolve the tab an operation targets and guarantee it is attached.
 * Accepts tabIndex (from browser_remote_list_tabs), an explicit tabId, or
 * nothing at all (reuse the last tab, else the first page).
 */
async function resolveTab(client, input = {}) {
  const tabs = await client.listTabs();
  if (!tabs.length) {
    throw new Error("The browser has no open page tabs. Open a tab, then retry.");
  }

  let tab = null;
  if (input.tabId) {
    tab = tabs.find((t) => t.id === input.tabId);
    if (!tab) throw new Error(`Tab id ${input.tabId} not found (it may have been closed).`);
  } else if (input.tabIndex !== undefined && input.tabIndex !== null && input.tabIndex !== "") {
    const index = Number(input.tabIndex);
    tab = tabs[index];
    if (!tab) throw new Error(`Tab index ${index} is out of range — there are ${tabs.length} tab(s) (0-${tabs.length - 1}).`);
  } else if (state.lastTabId) {
    tab = tabs.find((t) => t.id === state.lastTabId) || null;
  }
  if (!tab) tab = tabs[0];

  await client.attachTab(tab.id);
  state.lastTabId = tab.id;
  return { tab, tabs };
}

// Every tool funnels through here so a dead port produces ONE consistent,
// actionable error instead of a raw ECONNREFUSED stack.
function wrap(fn) {
  return async (input = {}, context = {}) => {
    try {
      return await fn(input, context);
    } catch (error) {
      const message = String(error?.message || error);
      const unreachable = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Timeout connecting|connecting to/i.test(message);
      return {
        error: message,
        ...(unreachable ? { hint: LAUNCH_HINT } : {}),
      };
    }
  };
}

function screenshotDir() {
  const dir = path.join(os.tmpdir(), "omniclaw-browser-remote");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createBrowserRemoteTools() {
  return {
    browser_remote_connect: {
      description:
        "Connect to the user's ALREADY-RUNNING Chrome and list its tabs. Use this instead of browser_open when the task " +
        "needs the user's real logged-in session (Gmail, dashboards, anything behind a login). The user exposes their own " +
        "browser from chrome://inspect/#remote-debugging — never tell them to pass --remote-debugging-port, which Chrome " +
        "136+ ignores on the default profile. Other browser_remote_* tools auto-connect, so this is mainly for discovery.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          host: { type: "string", description: "Debugger host (default localhost)." },
          port: { type: "number", description: "Debugger port (default 9222)." },
          useHttps: { type: "boolean", description: "Use https for the debugger endpoint (rare)." },
        },
      },
      run: wrap(async (input) => {
        const { client, key } = await getClient(input);
        const version = await client.version().catch(() => ({}));
        const tabs = await client.listTabs();
        // localDebugging == reached over the WebSocket-only endpoint == the
        // user's REAL profile. Surfaced so the model can tell "their logins are
        // here" from "this is a blank OmniClaw profile" without guessing.
        const realProfile = version.localDebugging === true;
        return {
          success: true,
          connection: key,
          browser: version["Browser"] || "unknown",
          localDebugging: realProfile,
          profile: realProfile ? "user" : "omniclaw",
          tabCount: tabs.length,
          tabs: tabs.map((tab, index) => ({
            index,
            id: tab.id,
            title: String(tab.title || "").slice(0, 100),
            url: tab.url,
          })),
          message: tabs.length
            ? `Connected to ${version["Browser"] || "browser"} at ${key} with ${tabs.length} tab(s)${realProfile ? " — this is the user's own profile, their logged-in sessions are available" : ""}. Target one with tabIndex.`
            : `Connected to ${key} but no page tabs are open.`,
        };
      }),
    },

    browser_remote_launch: {
      description:
        "Start a real Chrome/Edge window with the debug port open, so the browser tools have something to attach to. " +
        "Call this when a browser_remote_* tool fails with ECONNREFUSED and the task does NOT need the user's own " +
        "logged-in accounts — do not ask the user to run `chrome --remote-debugging-port` themselves, because Chrome 136+ " +
        "ignores that flag on the default profile. The window it opens uses a separate persistent OmniClaw profile: " +
        "whatever the user signs into there stays signed in, but their real Chrome logins are NOT in it. When the task " +
        "needs those logins, ask the user to enable local debugging at chrome://inspect/#remote-debugging instead — " +
        "if their own Chrome is already exposed this tool detects it and reports realProfile: true rather than launching.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          port: { type: "number", description: "Debug port to open (default 9222)." },
          host: { type: "string", description: "Host to check (default localhost)." },
          browser: { type: "string", description: "Preferred browser: Chrome, Edge or Brave. Default: first installed." },
          startUrl: { type: "string", description: "Page to open in the new window (default about:blank)." },
        },
      },
      run: wrap(async (input) => {
        const result = await launchDebugBrowser({
          host: input.host || DEFAULT_HOST,
          port: Number(input.port) || DEFAULT_PORT,
          browser: input.browser || "",
          startUrl: input.startUrl || "about:blank",
        });
        // Attach right away: without this the very next tool call pays the
        // connect round trip again, and a model that sees "launched" but then
        // ECONNREFUSED concludes the launch failed.
        const tabs = await getClient({ host: result.host, port: result.port })
          .then(({ client }) => client.listTabs())
          .catch(() => []);
        return {
          ...result,
          tabCount: tabs.length,
          tabs: tabs.map((tab, index) => ({ index, id: tab.id, title: String(tab.title || "").slice(0, 100), url: tab.url })),
        };
      }),
    },

    browser_remote_list_tabs: {
      description: "List the open page tabs in the connected real browser, with their index, title and URL.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "number" },
        },
      },
      run: wrap(async (input) => {
        const { client, key } = await getClient(input);
        const tabs = await client.listTabs();
        return {
          success: true,
          connection: key,
          count: tabs.length,
          tabs: tabs.map((tab, index) => ({
            index,
            id: tab.id,
            title: String(tab.title || "").slice(0, 100),
            url: tab.url,
            active: tab.id === state.lastTabId,
          })),
          message: `${tabs.length} tab(s) open.`,
        };
      }),
    },

    browser_remote_state: {
      description:
        "Read the current page: URL, title, visible text, and the interactive elements with CSS selectors you can " +
        "pass to browser_remote_click / _type / _fill_form. Call this BEFORE clicking or filling so you use real " +
        "selectors instead of guessing.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          tabIndex: { type: "number", description: "Tab to inspect (default: current tab)." },
          tabId: { type: "string" },
          maxElements: { type: "number", description: "Cap on interactive elements returned (default 60)." },
        },
      },
      run: wrap(async (input) => {
        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);
        const pageState = await client.getPageState(tab.id, { maxElements: input.maxElements });

        // This is a browser the human is ALSO using. Call out their navigations
        // explicitly — silently returning fresh state hides the fact that the
        // page changed under the agent, which is how it ends up clicking a
        // selector from a page nobody is looking at any more.
        const userMoves = (pageState.activity || []).filter((a) => a.by === "user");
        const userNote = userMoves.length
          ? ` NOTE: the user navigated this tab ${userMoves.length} time(s) since your last check (latest: ${userMoves[userMoves.length - 1].url}). Selectors from before then are stale.`
          : "";

        return {
          success: true,
          connection: key,
          tabId: tab.id,
          ...pageState,
          userNavigated: userMoves.length > 0,
          message:
            `${pageState.title || "(untitled)"} — ${pageState.elements.length} interactive element(s), readyState=${pageState.readyState}.` +
            userNote,
        };
      }),
    },

    browser_remote_screenshot: {
      description:
        "Screenshot the current tab of the real browser. Saves a PNG to disk and returns its path (the harness " +
        "attaches the image when the model has vision).",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          tabIndex: { type: "number" },
          tabId: { type: "string" },
          inline: {
            type: "boolean",
            description:
              "For the UI panel only. Also returns a base64 data URL — do NOT set this as a model, it floods the transcript.",
          },
        },
      },
      run: wrap(async (input) => {
        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);
        const base64 = await client.screenshot(tab.id);
        const file = path.join(screenshotDir(), `remote_${Date.now()}.png`);
        fs.writeFileSync(file, Buffer.from(base64, "base64"));
        // The panel needs this to translate a click on the <img> back into
        // viewport coordinates for browser_remote_click {x, y}.
        const viewport = input.inline ? await client.viewport(tab.id).catch(() => null) : null;
        return {
          success: true,
          connection: key,
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          screenshotPath: file,
          bytes: Buffer.byteLength(base64, "base64"),
          ...(viewport ? { viewport } : {}),
          // The live-view panel renders an <img>, which needs the bytes; the
          // model gets only the path so a screenshot costs ~20 tokens.
          ...(input.inline ? { dataUrl: `data:image/png;base64,${base64}` } : {}),
          message: `Screenshot of "${String(tab.title || "").slice(0, 60)}" saved to ${file}`,
        };
      }),
    },

    browser_remote_click: {
      description:
        "Click an element in the real browser by CSS selector. Scrolls it into view first. Get selectors from " +
        "browser_remote_state.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector, e.g. button[type=\"submit\"]." },
          x: { type: "number", description: "Viewport x, as an alternative to selector (used by the live-view panel)." },
          y: { type: "number", description: "Viewport y, paired with x." },
          tabIndex: { type: "number" },
          tabId: { type: "string" },
          actor: { type: "string", description: "Live-view panel only: pass \"user\" so the click is not drawn as the agent's cursor." },
        },
      },
      run: wrap(async (input) => {
        const hasPoint = Number.isFinite(Number(input.x)) && Number.isFinite(Number(input.y));
        if (!String(input.selector || "").trim() && !hasPoint) {
          return { error: "Pass either selector, or x and y. Run browser_remote_state to see available selectors." };
        }
        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);
        const actor = input.actor === "user" ? "user" : "agent";

        const result = hasPoint
          ? await client.clickAt(tab.id, input.x, input.y, { actor })
          : await client.click(tab.id, input.selector, { actor });

        return {
          success: true,
          connection: key,
          tabId: tab.id,
          ...(hasPoint ? {} : { selector: input.selector }),
          clickedAt: { x: result.x, y: result.y },
          message: `Clicked ${hasPoint ? `(${result.x}, ${result.y})` : input.selector}. Call browser_remote_state or _screenshot to see the result.`,
        };
      }),
    },

    browser_remote_type: {
      description: "Focus a field in the real browser and type text into it.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        required: ["selector", "text"],
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
          tabIndex: { type: "number" },
          tabId: { type: "string" },
          actor: { type: "string", description: "Live-view panel only: pass \"user\" so the typing is not drawn as the agent's cursor." },
        },
      },
      run: wrap(async (input) => {
        if (!String(input.selector || "").trim()) return { error: "selector is required." };
        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);
        const result = await client.type(tab.id, input.selector, input.text ?? "", {
          actor: input.actor === "user" ? "user" : "agent",
        });
        return {
          success: true,
          connection: key,
          tabId: tab.id,
          selector: input.selector,
          typed: result.typed,
          message: `Typed ${result.typed} character(s) into ${input.selector}.`,
        };
      }),
    },

    browser_remote_fill_form: {
      description:
        "Fill several form fields in the real browser in one call, then read each value back to confirm it stuck. " +
        "Works with React/Vue controlled inputs. Check `matched` per field — false means the page rewrote or " +
        "rejected the value.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        required: ["fields"],
        properties: {
          fields: {
            type: "array",
            description: "Fields to fill, in order.",
            items: {
              type: "object",
              required: ["selector", "value"],
              properties: {
                selector: { type: "string" },
                value: { type: "string" },
              },
            },
          },
          submitSelector: {
            type: "string",
            description: "Optional selector to click after all fields are filled (e.g. the submit button).",
          },
          tabIndex: { type: "number" },
          tabId: { type: "string" },
        },
      },
      run: wrap(async (input) => {
        const fields = Array.isArray(input.fields) ? input.fields : [];
        if (!fields.length) {
          return { error: "fields must be a non-empty array of {selector, value}." };
        }
        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);

        const results = await client.fillForm(tab.id, fields);
        const filled = results.filter((r) => r.success).length;
        const mismatched = results.filter((r) => r.success && r.matched === false);

        let submitted = null;
        if (input.submitSelector && filled === results.length) {
          try {
            await client.click(tab.id, input.submitSelector);
            submitted = { selector: input.submitSelector, success: true };
          } catch (error) {
            submitted = { selector: input.submitSelector, success: false, error: error.message };
          }
        }

        return {
          success: filled === results.length,
          connection: key,
          tabId: tab.id,
          filled,
          total: results.length,
          results,
          submitted,
          message:
            `Filled ${filled}/${results.length} field(s)` +
            (mismatched.length ? `; ${mismatched.length} did not read back as typed (${mismatched.map((m) => m.selector).join(", ")})` : "") +
            (submitted ? `; submit ${submitted.success ? "clicked" : `FAILED: ${submitted.error}`}` : ""),
        };
      }),
    },

    browser_remote_evaluate: {
      description:
        "Run JavaScript in the real browser tab and return the value. Must evaluate to a JSON-serializable value " +
        "(DOM nodes are not) — e.g. ({title: document.title, rows: document.querySelectorAll('tr').length}).",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        required: ["script"],
        properties: {
          script: { type: "string", description: "JavaScript expression to evaluate in the page." },
          tabIndex: { type: "number" },
          tabId: { type: "string" },
        },
      },
      run: wrap(async (input) => {
        // Match browser_evaluate's alias tolerance — models reach for these keys
        // constantly and an empty-script no-op is a silently wasted turn.
        const raw = input.script ?? input.expression ?? input.code ?? input.js;
        const source = typeof raw === "string" ? raw.trim() : "";
        if (!source) {
          return { error: "script is required (aliases accepted: expression/code/js). Return a JSON-serializable value." };
        }
        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);
        const result = await client.evaluate(tab.id, source);
        return {
          success: true,
          connection: key,
          tabId: tab.id,
          result: result === undefined ? null : result,
          ...(result === undefined
            ? { note: "Script returned undefined — end with an expression that yields a value." }
            : {}),
        };
      }),
    },

    browser_remote_navigate: {
      description: "Navigate a tab of the real browser to a URL, waiting briefly for the load to start.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          tabIndex: { type: "number" },
          tabId: { type: "string" },
          actor: { type: "string", description: "Live-view panel only: pass \"user\" when the human typed the URL." },
        },
      },
      run: wrap(async (input) => {
        const target = String(input.url || "").trim();
        if (!target) return { error: "url is required." };
        // Bare hosts get https://, but anything already carrying a scheme is
        // passed through untouched — prefixing "data:text/html,..." produced
        // "https://data:text/html,..." and Chrome rejected it as invalid.
        const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`;

        const { client, key } = await getClient(input);
        const { tab } = await resolveTab(client, input);
        await client.navigate(tab.id, url, { actor: input.actor === "user" ? "user" : "agent" });

        // Poll for the load rather than sleeping a fixed 1s — a fast page is
        // ready in 100ms and a slow one is not ready in 1000ms.
        let readyState = "unknown";
        for (let i = 0; i < 20; i += 1) {
          await new Promise((r) => setTimeout(r, 150));
          try {
            readyState = await client.evaluate(tab.id, "document.readyState");
            if (readyState === "complete" || readyState === "interactive") break;
          } catch { /* context is swapping during navigation; keep polling */ }
        }

        const after = (await client.listTabs()).find((t) => t.id === tab.id);
        return {
          success: true,
          connection: key,
          tabId: tab.id,
          url: after?.url || url,
          title: after?.title || "",
          readyState,
          message: `Navigated to ${after?.url || url} (readyState=${readyState}).`,
        };
      }),
    },

    browser_remote_disconnect: {
      description: "Close CDP sessions to the real browser. The browser itself and its tabs stay open.",
      permission: "allowBrowserControl",
      group: "browser-remote",
      schema: {
        type: "object",
        properties: {
          connection: { type: "string", description: 'Connection key like "localhost:9222". Omit to close all.' },
        },
      },
      run: wrap(async (input) => {
        if (input.connection) {
          const client = state.clients.get(input.connection);
          if (!client) return { success: false, message: `No connection ${input.connection}.` };
          await client.closeAllSessions();
          state.clients.delete(input.connection);
          if (state.lastKey === input.connection) {
            state.lastKey = null;
            state.lastTabId = null;
          }
          return { success: true, message: `Disconnected ${input.connection}.` };
        }
        for (const [, client] of state.clients) await client.closeAllSessions();
        const count = state.clients.size;
        state.clients.clear();
        state.lastKey = null;
        state.lastTabId = null;
        return { success: true, message: `Disconnected ${count} browser connection(s).` };
      }),
    },
  };
}

export const BROWSER_REMOTE_TOOL_IDS = [
  "browser_remote_launch",
  "browser_remote_connect",
  "browser_remote_list_tabs",
  "browser_remote_state",
  "browser_remote_screenshot",
  "browser_remote_click",
  "browser_remote_type",
  "browser_remote_fill_form",
  "browser_remote_evaluate",
  "browser_remote_navigate",
  "browser_remote_disconnect",
];

/**
 * Runtime handle for the live-view SSE endpoint.
 *
 * The endpoint deliberately reuses the SAME cached client and "current tab" the
 * tools use, rather than opening a connection of its own: one CDP session per
 * tab means the panel and the agent stay on the same page, and the screencast
 * multiplexes to both instead of two competing Page.startScreencast calls.
 */
export async function acquireLiveTab({ host, port, tabId } = {}) {
  const { client, key } = await getClient({ host, port });
  const { tab, tabs } = await resolveTab(client, tabId ? { tabId } : {});
  return { client, connection: key, tab, tabs };
}

// 4B.2: route helpers over the SAME cached client the tools use — never a
// second connection path. host/port default to the managed endpoint
// (explicit host/port = the ⚙ advanced popover path).
export async function managedClient({ host, port } = {}) {
  return getClient({ host, port });
}

export async function managedAttach(client, tabId) {
  await client.attachTab(tabId);
  state.lastTabId = tabId;
  return tabId;
}

// B1: tab id = CDP targetId. favicon is always null (no external favicon
// services; the UI shows a globe). active = last operated tab.
// List-only: never attaches (a status poll must not hijack the active tab).
export async function managedListTabs({ host, port } = {}) {
  const { client, key } = await getClient({ host, port });
  const tabs = await client.listTabs();
  const attached = new Set(client.attachedTabs());
  return {
    connection: key,
    lastTabId: state.lastTabId,
    tabs: tabs.map((t) => ({
      id: t.id,
      title: String(t.title || "").slice(0, 100),
      url: t.url || "",
      active: t.id === state.lastTabId,
      attached: attached.has(t.id),
      favicon: null,
    })),
  };
}

export async function managedTabs({ host, port } = {}) {
  return managedListTabs({ host, port });
}

export { browserLaunchStatus };
export default createBrowserRemoteTools;
