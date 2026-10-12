// Smoke test: /v1 chat-completions tool-call normalization. Regression guard for
// the bug where OmniClaw's provider shape { tool, input } produced empty names.
import { normalizeProviderToolCalls } from "../src/core/openai-api.js";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log(`  ok   ${msg}`); }
  else { failed += 1; console.error(`  FAIL ${msg}`); }
}

// OmniClaw provider normalized shape { tool, input }.
let out = normalizeProviderToolCalls([{ id: "c1", tool: "read_file", input: { path: "a.txt" } }]);
ok(out[0].function.name === "read_file", "provider {tool} -> function.name");
ok(out[0].function.arguments === JSON.stringify({ path: "a.txt" }), "provider {input} object -> JSON string args");
ok(out[0].type === "function" && out[0].id === "c1", "id + type preserved");

// input already a JSON string is passed through, not double-encoded.
out = normalizeProviderToolCalls([{ tool: "exec", input: '{"command":"ls"}' }]);
ok(out[0].function.arguments === '{"command":"ls"}', "string input passed through");
ok(out[0].id.startsWith("call_"), "missing id gets a generated call_ id");

// Raw OpenAI shape still works (robustness).
out = normalizeProviderToolCalls([{ id: "x", function: { name: "write_file", arguments: '{"path":"b"}' } }]);
ok(out[0].function.name === "write_file" && out[0].function.arguments === '{"path":"b"}', "raw OpenAI function shape preserved");

// Flat { name, arguments } shape.
out = normalizeProviderToolCalls([{ name: "search", arguments: { q: "x" } }]);
ok(out[0].function.name === "search", "flat {name} preserved");

// The original bug: a {tool,input} call must NOT yield an empty name.
out = normalizeProviderToolCalls([{ tool: "list_files", input: {} }]);
ok(out[0].function.name === "list_files" && out[0].function.name !== "", "no empty tool name (the bug)");

// Empty / non-array safe.
ok(normalizeProviderToolCalls([]).length === 0, "empty array -> empty");
ok(normalizeProviderToolCalls(undefined).length === 0, "undefined -> empty");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
