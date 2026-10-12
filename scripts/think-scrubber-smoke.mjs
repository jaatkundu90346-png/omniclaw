// Smoke test for the streaming reasoning-tag scrubber (Hermes think_scrubber port).
import { StreamingThinkScrubber, scrubThinkTags } from "../src/core/think-scrubber.js";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

// Feed an array of deltas, return the concatenated visible output + flush.
function run(deltas) {
  const s = new StreamingThinkScrubber();
  let out = "";
  for (const d of deltas) out += s.feed(d);
  out += s.flush();
  return out;
}

// 1. THE BUG: tag split across deltas must NOT leak reasoning.
ok(run(["<think>", "Let me check their config", "</think>", "Hello!"]) === "Hello!",
  "split <think> across deltas: reasoning suppressed, only answer visible");

// 2. Closed pair in a single delta is stripped.
ok(run(["<think>secret plan</think>Answer."]) === "Answer.",
  "closed pair in one delta is stripped");

// 3. Reasoning split char-by-char still suppressed.
ok(run("<think>abc</think>OK".split("")) === "OK",
  "char-by-char stream: reasoning fully suppressed");

// 4. Prose that merely MENTIONS the tag mid-line is NOT stripped (boundary gate).
ok(run(["Use the <think> tag wisely."]) === "Use the <think> tag wisely.",
  "mid-line mention of <think> (not at boundary) is preserved");

// 5. Open tag at start-of-line boundary enters a block.
ok(run(["intro\n", "<think>hidden</think>", "done"]) === "intro\ndone",
  "open tag after newline is treated as a block opener");

// 6. Orphan close tag is stripped (with trailing whitespace).
ok(run(["text </think> more"]).replace(/\s+/g, " ").trim() === "text more",
  "orphan close tag removed");

// 7. Unterminated block at end-of-stream: held content discarded, not leaked.
ok(run(["<think>never closed reasoning"]) === "",
  "unterminated block flushed as empty (no leak)");

// 8. A partial-looking tail that is NOT a tag is emitted on flush.
ok(run(["answer <th"]) === "answer <th",
  "held-back partial that isn't a real tag is emitted on flush");

// 9. Plain text with no tags passes through untouched.
ok(run(["just ", "a normal ", "answer"]) === "just a normal answer",
  "plain text unchanged");

// 10. <reasoning> variant handled.
ok(run(["<reasoning>r</reasoning>X"]) === "X", "<reasoning> variant suppressed");

// 11. scrubThinkTags convenience for complete strings.
ok(scrubThinkTags("<think>a</think>Final") === "Final", "scrubThinkTags strips closed pair");
ok(scrubThinkTags("no tags here") === "no tags here", "scrubThinkTags fast-path leaves plain text");

// 12. Content before reasoning is preserved.
ok(run(["Sure!\n", "<think>deciding</think>", "Here you go."]) === "Sure!\nHere you go.",
  "text before a boundary reasoning block is preserved");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
