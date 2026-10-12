// Smoke test for slash control-command parsing + session-state application.
import { parseControlCommands, applySessionControls, reasoningOptionFor } from "../src/core/control-commands.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

// Pure command (no task left) -> recognized + pureCommand, empty stripped.
let r = parseControlCommands("/think");
ok(r.recognized && r.controls.reasoningEffort === "high", "/think -> high reasoning");
ok(r.pureCommand && r.strippedMessage === "", "/think alone is a pure command");

r = parseControlCommands("/think hard build a landing page");
ok(r.controls.reasoningEffort === "high", "/think hard -> high");
ok(!r.pureCommand && r.strippedMessage === "build a landing page", "/think hard <task> strips the command");

r = parseControlCommands("/no-think just answer quickly");
ok(r.controls.reasoningEffort === "off" && r.strippedMessage === "just answer quickly", "/no-think -> off + strips");

r = parseControlCommands("/reasoning medium summarize the repo");
ok(r.controls.reasoningEffort === "medium" && r.strippedMessage === "summarize the repo", "/reasoning medium parsed");

r = parseControlCommands("/reasoning bogus do thing");
ok(!r.recognized && r.strippedMessage === "/reasoning bogus do thing", "unknown /reasoning level NOT consumed");

r = parseControlCommands("/fast /think hard make X");
ok(r.controls.fast === true && r.controls.reasoningEffort === "high" && r.strippedMessage === "make X",
  "stacked commands: /fast /think hard <task>");

r = parseControlCommands("/verbose off");
ok(r.controls.verbose === false && r.pureCommand, "/verbose off pure command");

r = parseControlCommands("/steer focus on the navbar first");
ok(r.steerText === "focus on the navbar first" && r.recognized, "/steer captures the rest as payload");
ok(r.strippedMessage === "" && !r.pureCommand, "/steer is terminal, not a pure command");

r = parseControlCommands("build a website normally");
ok(!r.recognized && r.strippedMessage === "build a website normally", "no command -> message untouched");

r = parseControlCommands("/unknowncmd do something");
ok(!r.recognized && r.strippedMessage === "/unknowncmd do something", "unknown slash left for other handlers");

// applySessionControls accumulates across messages.
let state = {};
state = applySessionControls(state, parseControlCommands("/fast").controls);
ok(state.fast === true, "session state remembers fast");
state = applySessionControls(state, parseControlCommands("/think hard").controls);
ok(state.fast === true && state.reasoningEffort === "high", "session state accumulates think over fast");

// reasoningOptionFor mapping.
ok(reasoningOptionFor({ reasoningEffort: "high" })?.effort === "high", "reasoningOptionFor high -> {effort:high}");
ok(reasoningOptionFor({ reasoningEffort: "off" }) === false, "reasoningOptionFor off -> false (disable sentinel)");
ok(reasoningOptionFor({}) === undefined, "no effort -> undefined (keep config default)");
ok(reasoningOptionFor({ fast: true })?.effort === "minimal", "fast implies minimal reasoning");
ok(reasoningOptionFor({ fast: true, reasoningEffort: "high" })?.effort === "high", "explicit effort overrides fast");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
