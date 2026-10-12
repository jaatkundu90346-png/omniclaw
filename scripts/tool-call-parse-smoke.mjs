// Smoke test for omni-loop text/XML tool-call recovery (extractTextModeToolCalls).
// Run: node scripts/tool-call-parse-smoke.mjs
import { extractTextModeToolCalls, repairToolInput, parseToolArguments } from "../src/core/omni-loop.js";

const allowed = new Set(["read_file", "write_file", "exec"]);
let passed = 0;
let failed = 0;

function check(name, text, expected) {
  const got = extractTextModeToolCalls(text, allowed, 5);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       got:      ${JSON.stringify(got)}`);
  }
}

function checkRepair(name, tool, input, schema, expectedInput, expectedRepaired = true) {
  const got = repairToolInput(tool, input, schema);
  const ok = JSON.stringify(got.input) === JSON.stringify(expectedInput) && Boolean(got.repaired) === expectedRepaired;
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       expected: ${JSON.stringify({ input: expectedInput, repaired: expectedRepaired })}`);
    console.log(`       got:      ${JSON.stringify(got)}`);
  }
}

// 1. JSON format (regression — must still work)
check(
  "json {tool,args}",
  'Sure, let me read it. {"tool":"read_file","args":{"path":"a.txt"}}',
  [{ tool: "read_file", input: { path: "a.txt" } }],
);

// 2. Hermes / Qwen JSON-in-wrapper (caught by the JSON scanner)
check(
  "hermes <tool_call>{json}</tool_call>",
  '<tool_call>{"name":"write_file","arguments":{"path":"b.txt","content":"hi"}}</tool_call>',
  [{ tool: "write_file", input: { path: "b.txt", content: "hi" } }],
);

// 3. Qwen3-Coder XML (previously MISSED — no JSON object)
check(
  "qwen3-coder <function=...><parameter=...>",
  "Let me check.\n<tool_call>\n<function=read_file>\n<parameter=path>src/app.js</parameter>\n</function>\n</tool_call>",
  [{ tool: "read_file", input: { path: "src/app.js" } }],
);

// 4. GLM-4.5 arg_key/arg_value (previously MISSED)
check(
  "glm <tool_call>name\\n<arg_key>/<arg_value>",
  '<tool_call>exec\n<arg_key>command</arg_key><arg_value>"ls -la"</arg_value>\n</tool_call>',
  [{ tool: "exec", input: { command: "ls -la" } }],
);

// 5. XML call to a tool that is NOT allowed -> ignored (no false positive)
check(
  "xml unknown tool ignored",
  "<function=delete_everything><parameter=path>/</parameter></function>",
  [],
);

// 6. Qwen3-Coder with typed param (number via JSON coercion)
check(
  "qwen3-coder typed param",
  "<function=exec><parameter=timeout>30</parameter><parameter=command>echo hi</parameter></function>",
  [{ tool: "exec", input: { timeout: 30, command: "echo hi" } }],
);

// 7. ReAct-style text from weak/local models (previously MISSED — no native function call, no JSON wrapper)
check(
  "react Action/Action Input JSON",
  'Thought: need to inspect.\nAction: read_file\nAction Input: {"path":"src/core/omni-loop.js"}',
  [{ tool: "read_file", input: { path: "src/core/omni-loop.js" } }],
);

// 8. Loose markdown/tool format from instruction-tuned models (previously MISSED)
check(
  "markdown Tool/Input block",
  'I will run it now.\nTool: exec\nInput:\n```json\n{"command":"npm test","timeout":120}\n```',
  [{ tool: "exec", input: { command: "npm test", timeout: 120 } }],
);

// 8b. Bare name/parameters array (previously MISSED — a weak model finalized
// a whole 5-round turn on this shape instead of executing it).
check(
  "json array {name, parameters}",
  '[\n[{"name": "read_file", "parameters": {"path": "a.txt"}}]',
  [{ tool: "read_file", input: { path: "a.txt" } }],
);

// 9. Plain prose, no tool call — still no false positive.
check("plain text", "Here is the summary of what I found. All good.", []);

// 10. Harness-level arg repair: weak models often use aliases even when the
// tool schema requires exact keys. The harness should fix common aliases before
// running the tool, not depend on the rented model doing perfect JSON.
checkRepair(
  "repair read_file filepath -> path",
  "read_file",
  { filepath: "src/app.js" },
  { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  { path: "src/app.js" },
);
checkRepair(
  "repair exec cmd + numeric timeout string",
  "exec",
  { cmd: "npm test", timeout: "120" },
  { type: "object", required: ["command"], properties: { command: { type: "string" }, timeout: { type: "number" } } },
  { timeout: 120, command: "npm test" },
);
checkRepair(
  "repair write_file filename/text aliases",
  "write_file",
  { filename: "out.txt", text: "hello" },
  { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
  { path: "out.txt", content: "hello" },
);

console.log(`\n${passed} passed, ${failed} failed`);

// Double-encoded args (live 2026-09-12: weak model wraps the whole object in
// quotes — three full game generations died on "path/content required").
{
  const dbl = JSON.stringify(JSON.stringify({ path: "index.html", content: "<!doctype html>" }));
  const got = parseToolArguments(dbl);
  const okParse = got && got.path === "index.html" && got.content === "<!doctype html>" && !got._rawArguments;
  if (okParse) { passed += 1; console.log("  ok   double-encoded object unwraps"); }
  else { failed += 1; console.log(`  FAIL double-encoded object unwraps — got: ${JSON.stringify(got).slice(0, 120)}`); }
  const plain = parseToolArguments({ path: "a.txt" });
  if (plain && plain.path === "a.txt") { passed += 1; console.log("  ok   object passthrough unchanged"); }
  else { failed += 1; console.log("  FAIL object passthrough unchanged"); }
  const str = parseToolArguments("just a string");
  if (str && str._rawArguments === "just a string") { passed += 1; console.log("  ok   plain string still _rawArguments (unchanged)"); }
  else { failed += 1; console.log(`  FAIL plain string still _rawArguments — got: ${JSON.stringify(str)}`); }
  const broken = parseToolArguments("{not json");
  if (broken && broken._rawArguments) { passed += 1; console.log("  ok   unparseable still _rawArguments"); }
  else { failed += 1; console.log("  FAIL unparseable still _rawArguments"); }
  // Malformed outer wrapper around a valid inner object (live: balanced inner
  // recovered, unbalanced/truncated inner still refused).
  const wrapped = `prefix garbage {"path": "a.txt", "content": "hi"} trailing junk`;
  const gotW = parseToolArguments(wrapped);
  if (gotW && gotW.path === "a.txt" && gotW.content === "hi") { passed += 1; console.log("  ok   brace-scan recovers inner object"); }
  else { failed += 1; console.log(`  FAIL brace-scan recovers inner object — got: ${JSON.stringify(gotW).slice(0, 120)}`); }
  const cut = `{"path": "a.txt", "content": "unclosed`;
  const gotC = parseToolArguments(cut);
  if (gotC && gotC._rawArguments) { passed += 1; console.log("  ok   truncated inner still refused"); }
  else { failed += 1; console.log("  FAIL truncated inner still refused"); }
}

console.log(`\n${passed} passed, ${failed} failed (incl. double-encoding)`);
process.exit(failed === 0 ? 0 : 1);
