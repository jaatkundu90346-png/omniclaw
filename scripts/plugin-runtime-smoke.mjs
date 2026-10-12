// plugin-runtime-smoke — plugins must RUN, not just render.
//
// Until 2026-07-31 PluginRegistry.runTool() only substituted {{keys}} into the
// manifest's `response` string, so a plugin could load, validate, appear in the
// UI and expose tools while being structurally incapable of doing anything.
// (A second, unused implementation in plugin-system.js did have a real loader
// but was never imported by anything.) These checks pin the code path down.
//
//   node scripts/plugin-runtime-smoke.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginRegistry } from "../src/core/plugin-registry.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// A config store stub with just the surface PluginRegistry touches.
function makeConfigStore(config = {}) {
  let current = { pluginConfig: {}, pluginState: {}, ...config };
  return {
    getConfig: () => current,
    readUserConfig: () => current,
    updateUserConfig: (patch) => {
      current = { ...current, ...patch };
      return current;
    },
  };
}

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-plugin-smoke-"));
const pluginsDir = path.join(sandboxRoot, "plugins");

function writePlugin(id, manifest, files = {}) {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id, ...manifest }, null, 2));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

const toolManifest = (extra = {}) => ({
  name: `Plugin ${extra.name || "test"}`,
  version: "1.0.0",
  enabled: true,
  ...extra,
});

try {
  // ── A code-backed plugin actually executes ────────────────────────────────
  writePlugin(
    "code-plugin",
    toolManifest({
      configDefaults: { greeting: "Namaste" },
      runtime: {
        entry: "index.mjs",
        tools: [{ id: "do_math", description: "add", response: "TEMPLATE FALLBACK" }],
      },
    }),
    {
      "index.mjs": `export async function do_math(input, context) {
        context.log("ran");
        return { sum: Number(input.a) + Number(input.b), greeting: context.config.greeting };
      }`,
    },
  );

  // ── A declarative plugin still renders its template ───────────────────────
  writePlugin(
    "template-plugin",
    toolManifest({
      configDefaults: { who: "dashboard" },
      runtime: { tools: [{ id: "say_hi", description: "hi", response: "hi {{who}}" }] },
    }),
  );

  // ── A plugin whose entry is missing must fail LOUDLY, not silently ────────
  writePlugin(
    "broken-plugin",
    toolManifest({
      runtime: { entry: "missing.mjs", tools: [{ id: "ghost", description: "x", response: "TEMPLATE FALLBACK" }] },
    }),
  );

  // ── A plugin whose entry points outside its directory must be refused ─────
  writePlugin(
    "escape-plugin",
    toolManifest({
      runtime: { entry: "../../server.js", tools: [{ id: "escape_tool", description: "x", response: "nope" }] },
    }),
  );

  // ── A plugin that exports a runTool dispatcher instead of named fns ───────
  writePlugin(
    "dispatch-plugin",
    toolManifest({
      runtime: { entry: "index.mjs", tools: [{ id: "dispatched", description: "x", response: "TEMPLATE FALLBACK" }] },
    }),
    { "index.mjs": `export function runTool(toolId, input) { return { via: "dispatcher", toolId, echo: input.value }; }` },
  );

  // ── A plugin whose handler hangs must time out, not wedge the agent ───────
  writePlugin(
    "hang-plugin",
    toolManifest({
      runtime: {
        entry: "index.mjs",
        timeoutMs: 1000,
        tools: [{ id: "never_returns", description: "x", response: "TEMPLATE FALLBACK" }],
      },
    }),
    { "index.mjs": `export function never_returns() { return new Promise(() => {}); }` },
  );

  const registry = new PluginRegistry(sandboxRoot, makeConfigStore());

  const codeResult = await registry.runTool("do_math", { a: 2, b: 40 });
  check("code plugin executes its entry module", codeResult.mode === "code", `mode=${codeResult.mode}`);
  check("code plugin computes a real result", codeResult.output?.sum === 42, JSON.stringify(codeResult.output));
  check("code plugin receives its config", codeResult.output?.greeting === "Namaste");
  check("code plugin logs are captured", codeResult.logs?.includes("ran"), JSON.stringify(codeResult.logs));

  const templateResult = await registry.runTool("say_hi", {});
  check("declarative plugin still renders its template", templateResult.mode === "template" && templateResult.output === "hi dashboard", templateResult.output);

  const dispatched = await registry.runTool("dispatched", { value: 7 });
  check("runTool dispatcher export is supported", dispatched.output?.via === "dispatcher" && dispatched.output?.echo === 7, JSON.stringify(dispatched.output));

  let brokenError = "";
  try {
    await registry.runTool("ghost", {});
  } catch (error) {
    brokenError = error.message;
  }
  check("missing entry fails loudly", /failed to load/i.test(brokenError), brokenError);
  check("missing entry does NOT fall back to the template", !/TEMPLATE FALLBACK/.test(brokenError), brokenError);

  let escapeError = "";
  try {
    await registry.runTool("escape_tool", {});
  } catch (error) {
    escapeError = error.message;
  }
  check("entry outside the plugin directory is refused", /escapes the plugin directory/i.test(escapeError), escapeError);

  let hangError = "";
  const hangStarted = Date.now();
  try {
    await registry.runTool("never_returns", {});
  } catch (error) {
    hangError = error.message;
  }
  check("hanging plugin tool times out", /timed out after 1000ms/.test(hangError), hangError);
  check("timeout fires promptly", Date.now() - hangStarted < 5000, `${Date.now() - hangStarted}ms`);

  // ── Diagnostics the UI needs to explain a dead plugin ─────────────────────
  const broken = registry.getById("broken-plugin");
  check("broken entry is reported on the plugin record", broken?.entryStatus?.declared === true && broken.entryStatus.ok === false, JSON.stringify(broken?.entryStatus));

  const definitions = registry.getToolDefinitions();
  check("tool definitions mark code vs template", definitions.find((t) => t.id === "do_math")?.mode === "code" && definitions.find((t) => t.id === "say_hi")?.mode === "template");

  // ── Editing a plugin picks up without a restart ───────────────────────────
  const entryPath = path.join(pluginsDir, "code-plugin", "index.mjs");
  fs.writeFileSync(entryPath, `export async function do_math() { return { sum: 999 }; }`);
  fs.utimesSync(entryPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  const reloaded = await registry.runTool("do_math", { a: 1, b: 1 });
  check("edited plugin reloads without a restart", reloaded.output?.sum === 999, JSON.stringify(reloaded.output));

  // ── The shipped reference plugin must work as documented ──────────────────
  const realRegistry = new PluginRegistry(process.cwd(), makeConfigStore());
  const hello = await realRegistry.runTool("hello_ping", { name: "Mankush" });
  check("shipped omni-hello plugin runs real code", hello.mode === "code" && /Mankush/.test(hello.output?.message || ""), JSON.stringify(hello.output));
} finally {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nplugin-runtime-smoke: all checks passed" : `\nplugin-runtime-smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
