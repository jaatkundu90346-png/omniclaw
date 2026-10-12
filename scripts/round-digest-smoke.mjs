// In-run digest + round-cap guard: pair-safe compaction, deterministic output,
// hard bounds. No network, no model.
import { OmniLoop, splitRoundCalls } from "../src/core/omni-loop.js";

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`  FAIL ${msg}`); process.exitCode = 1; return; }
  passed += 1;
  console.log(`  ok   ${msg}`);
}

const loop = new OmniLoop({ agentRuntime: {} });

// splitRoundCalls: cap + never-silent
{
  const calls = Array.from({ length: 9 }, (_, i) => ({ id: "c" + i, tool: "read_file", input: {} }));
  const { kept, dropped } = splitRoundCalls(calls, 6);
  ok(kept.length === 6 && dropped.length === 3, "9 calls cap 6 -> 6 kept, 3 parked");
  const small = splitRoundCalls(calls.slice(0, 3), 6);
  ok(small.kept.length === 3 && small.dropped.length === 0, "under cap passes through");
  const clamped = splitRoundCalls(calls, 99);
  ok(clamped.kept.length === 9, "cap clamps to 12 max");
}

// digest: build a fake 8-round transcript
function fakeRun(rounds = 8) {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "do the thing" },
  ];
  for (let r = 1; r <= rounds; r += 1) {
    const id = `call_${r}_0`;
    messages.push({
      role: "assistant", content: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `f${r}.txt` }) } }],
    });
    // Realistic read result: real read_file observations are 1-30k chars —
    // a 180-char fake would make the excerpt-bearing digest line as long as
    // the content it replaced, which never happens in real runs.
    const filler = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of file ${r}: some implementation detail worth remembering`).join("\n");
    messages.push({ role: "tool", tool_call_id: id, content: `✅ read OK: f${r}.txt (lines 1-400 of 900)\n${filler}\nFull output saved to: tmp/tool-results/run-r${r}-${id}.txt — use read_file` });
  }
  return { messages, runStartIndex: 2 };
}
{
  const { messages, runStartIndex } = fakeRun(8);
  const before = messages.length;
  const res = loop.digestOldGroups(messages, runStartIndex, 3, 8);
  ok(res.digested === 5, `8 groups keepLast 3 -> 5 digested (got ${res.digested})`);
  ok(res.chars > 0, "chars saved reported");
  // pair safety: every remaining tool msg has its assistant call present
  const callIds = new Set();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callIds.add(c.id);
  }
  const orphans = messages.filter((m) => m.role === "tool" && !callIds.has(m.tool_call_id));
  ok(orphans.length === 0, "no orphaned tool messages after digest");
  // every remaining assistant call has its tool responses
  const toolById = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  const missing = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (!toolById.has(c.id)) missing.push(c.id);
    }
  }
  ok(missing.length === 0, "no assistant call lost its tool responses");
  ok(messages.length < before, "transcript shrank");
  const digest = messages.find((m) => m.role === "user" && String(m.content || "").startsWith("[Earlier work digested"));
  ok(Boolean(digest) && digest.content.length <= 2100, "digest note present and <=~2000 chars");
  ok(/f1\.txt/.test(digest.content) && /tmp\/tool-results\//.test(digest.content), "digest names targets + tmp paths");
  ok(!/f8\.txt/.test(digest.content), "newest rounds stay verbatim (f8 not digested)");
}

// steer/plan user messages survive digestion
{
  const { messages, runStartIndex } = fakeRun(6);
  messages.splice(4, 0, { role: "user", content: "steer: focus on f9 next" });
  const res = loop.digestOldGroups(messages, runStartIndex, 3, 6);
  ok(res.digested > 0, "digests around interleaved user notes");
  ok(messages.some((m) => m.content === "steer: focus on f9 next"), "steer message preserved verbatim");
  const callIds = new Set();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callIds.add(c.id);
  }
  ok(!messages.some((m) => m.role === "tool" && !callIds.has(m.tool_call_id)), "still pair-safe with interleaving");
}

// determinism + threshold behavior
{
  const a = fakeRun(8);
  const b = fakeRun(8);
  const ra = loop.digestOldGroups(a.messages, a.runStartIndex, 3, 8);
  const rb = loop.digestOldGroups(b.messages, b.runStartIndex, 3, 8);
  const da = a.messages.find((m) => String(m.content || "").startsWith("[Earlier work digested"));
  const db = b.messages.find((m) => String(m.content || "").startsWith("[Earlier work digested"));
  ok(da && db && da.content === db.content && ra.chars === rb.chars, "deterministic across identical runs");
  const short = fakeRun(3);
  const rs = loop.digestOldGroups(short.messages, short.runStartIndex, 3, 3);
  ok(rs.digested === 0, "nothing digested at/below keepLast");
}

console.log(`\nround-digest: ${passed} passed${process.exitCode ? " WITH FAILURES" : " ALL PASS"}`);
process.exit(process.exitCode || 0);
