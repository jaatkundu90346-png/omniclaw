// POST /api/config must actually SAVE. It did not, and it failed silently.
//
// THE BUG: the route called the tool without `{operator:true}`:
//
//   agent.tools.run("update_runtime_settings", body)      -> 200 {blocked:true,
//                                                            code:"EOPERATOR"}
//
// `update_runtime_settings` is an OPERATOR tool, defined to be callable from the
// UI/API and refused to the MODEL. The gate fires on ANY caller that does not
// pass the operator flag — including this route. ws-gateway.js already passed it;
// the HTTP route did not.
//
// WHY IT IS WORSE THAN A CRASH: the response was HTTP 200. Every Settings control
// looked like it saved. In practice nothing did — reasoning effort, theme, panel
// width, provider label — and the only symptom was that a value never stuck.
// "It reports success and does nothing" is the single most expensive class of
// bug, because it actively misleads the person debugging it.
//
// This asserts the write reaches the tool with the operator flag, and that the
// EOPERATOR block is not what comes back.
//
// R14: markers before every step, hard wall clock, cleanup in finally.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let step = "startup";
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 60000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  step = "the config route passes the operator flag";
  const src = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const routeStart = src.indexOf('req.method === "POST" && pathname === "/api/config"');
  assert.ok(routeStart > -1, "POST /api/config route not found");
  const routeEnd = src.indexOf("return;\n  }", routeStart);
  const route = src.slice(routeStart, routeEnd);
  assert.match(route, /tools\.run\(\s*"update_runtime_settings"\s*,\s*body\s*,\s*\{\s*operator:\s*true\s*\}\s*\)/,
    "the config route must pass { operator: true } — without it the EOPERATOR gate blocks the write");
  console.log("ok: operator flag present on the config route");

  step = "the same flag ws-gateway already uses is the one being used here";
  const ws = fs.readFileSync(path.join(root, "src/core/ws-gateway.js"), "utf8");
  assert.match(ws, /"update_runtime_settings",[\s\S]{0,80}operator: true/,
    "ws-gateway is the reference implementation; if it lost the flag, both callers regressed together");
  console.log("ok: both operator callers agree");

  step = "a config write is loopback-gated rather than relying on the bind address";
  assert.match(route, /isLoopback\(req\)/,
    "POST /api/config predates the R12 per-route gate; a config write must check loopback itself");
  assert.match(route, /EPERM/,
    "the loopback rejection must use the standard 403/EPERM shape");
  console.log("ok: loopback gate present");

  step = "the route surfaces a blocked tool as a failure, not a 200";
  // Even with the flag, if a future refactor drops it again the response must not
  // be a cheerful 200 — that is what made this invisible the first time.
  assert.match(route, /if\s*\(result\s*&&\s*result\.blocked\)/,
    "the route forwards `result` verbatim, so a blocked tool would again be reported as HTTP 200 success");
  assert.match(route, /sendJson\(res,\s*400/,
    "a refused configuration change must be a 4xx, so the UI surfaces the failure instead of claiming success");
  console.log("ok: a blocked write is a 4xx, not a 200 that explains it was refused");

  step = "reasoning is accepted by the settings writer this route depends on";
  const { CustomizationEngine } = await import("../src/core/customization-engine.js");
  const writes = [];
  const engine = new CustomizationEngine({
    configStore: { updateUserConfig: (p) => writes.push(p), getConfig: () => ({}) },
    skillRegistry: {},
    secretStore: {},
  });
  engine.updateRuntimeSettings({ provider: { reasoning: "xhigh" } });
  assert.equal(writes.at(-1).provider.reasoning, "xhigh",
    "the writer dropped reasoning even with the gate open — the two bugs would mask each other");
  console.log("ok: the writer itself is fine, the gate was the only blocker");

  clearTimeout(timer);
  console.log("config-operator-gate: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  if (error?.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
} finally {
  clearTimeout(timer);
}