// Smoke test for looksLikeIntentToAct — the detector behind the "act, don't
// describe" guard that stops weak models from narrating a step ("Let's do that")
// without calling any tool.
import { looksLikeIntentToAct } from "../src/core/omni-loop.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

// The exact failures from the user's screenshots.
ok(looksLikeIntentToAct("We need to create the directory for the project. Use create_computer_directory tool. Then we can proceed to create files. Let's do that."),
  "screenshot case: 'Use X tool ... Let's do that' -> intent");
ok(looksLikeIntentToAct("Let's do that."), "'Let's do that' -> intent");
ok(looksLikeIntentToAct("I'll create the index.html file now."), "'I'll create ... now' -> intent");
ok(looksLikeIntentToAct("First, create the project folder, then add the files."), "'First, create ...' -> intent");
ok(looksLikeIntentToAct("We should run npm install to set up dependencies."), "'We should run ...' -> intent");
ok(looksLikeIntentToAct("Next, I will write the CSS."), "'Next, I will write' -> intent");
ok(looksLikeIntentToAct("Let me use the write_file tool to make the page."), "'Let me use the write_file tool' -> intent");

// Real final answers / normal prose must NOT be flagged.
ok(!looksLikeIntentToAct("Build complete. I created index.html (240 bytes) and verified it renders with no console errors."),
  "completed report -> not intent");
ok(!looksLikeIntentToAct("The function returns the sum of the two arguments."), "explanation -> not intent");
ok(!looksLikeIntentToAct("I'll explain how this works: the loop iterates over each item."), "'I'll explain' -> not intent");
ok(!looksLikeIntentToAct(""), "empty -> not intent");
ok(!looksLikeIntentToAct("Here is the summary of what was done and the test output: all 12 tests passed."),
  "summary answer -> not intent");
// A very long substantive answer is a real reply, not mere intent.
ok(!looksLikeIntentToAct("Let's do that. " + "x".repeat(1600)), "very long text -> not treated as mere intent");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
