// Memory hygiene contract (measured 2026-09-26): the live store reached 49 MB
// of JSON — 38 MB raw toolOutputs + 9.5 MB plan blobs copied out of the
// transcript that nothing reads. Stored conversations must be bounded DIGESTS,
// secrets must never be written into durable memory, and retention must cap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MemoryStore, boundConversationRecord, boundToolOutputs, boundConversationPlan,
  CONVERSATION_TOOL_OUTPUT_LIMIT, CONVERSATION_TOOL_OUTPUT_CHARS,
  CONVERSATION_RETENTION,
} from "../src/core/memory-store.js";
import { maskSecret } from "../src/core/secret-redact.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

console.log("step 1: tool outputs are digested, newest kept");
{
  const outputs = Array.from({ length: 40 }, (_, i) => ({ tool: `t${i}`, output: "x".repeat(5000) }));
  const bounded = boundToolOutputs(outputs);
  assert(bounded.length === CONVERSATION_TOOL_OUTPUT_LIMIT, `keeps only the newest ${CONVERSATION_TOOL_OUTPUT_LIMIT} entries (got ${bounded.length})`);
  assert(bounded[bounded.length - 1].tool === "t39", "newest entry kept");
  const biggest = Math.max(...bounded.map((o) => JSON.stringify(o.output).length));
  assert(biggest <= CONVERSATION_TOOL_OUTPUT_CHARS + 200, `each output capped near ${CONVERSATION_TOOL_OUTPUT_CHARS}c (got ${biggest})`);
  assert(/digest stored/.test(JSON.stringify(bounded)), "digest marker explains where the full output lives");
  assert(bounded.every((o) => Number(o.digestChars) >= 0), "original size recorded for debugging");
  assert(boundToolOutputs(undefined).length === 0 && boundToolOutputs("junk").length === 0, "non-array input is safe");
}

console.log("step 2: plan blobs are summarised, not stored whole");
{
  const plan = {
    summary: "build the thing",
    steps: Array.from({ length: 60 }, (_, i) => ({ title: `step ${i} ` + "y".repeat(2000), status: "pending", verification: "npm test", hidden: "z".repeat(5000) })),
    // The real planner object carries these — the store must NOT keep them.
    toolsAvailable: Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, schema: { big: "s".repeat(500) } })),
    modelToolLoop: { rounds: Array.from({ length: 50 }, () => ({ log: "l".repeat(2000) })) },
    profile: { id: "power" },
    toolCount: 7,
    source: "auto-planner",
  };
  const bounded = boundConversationPlan(plan);
  assert(bounded.steps.length <= 24, `steps capped (got ${bounded.steps.length})`);
  assert(bounded.steps[0].hidden === undefined, "bulky per-step fields dropped");
  assert(bounded.summary.length <= 600, `summary capped (got ${bounded.summary.length})`);
  assert(bounded.toolsAvailable === undefined, "toolsAvailable (tool schemas) never stored in memory");
  assert(bounded.modelToolLoop === undefined, "modelToolLoop report never stored in memory");
  assert(bounded.toolCount === 7 && bounded.source === "auto-planner", "small useful keys survive");
  assert(JSON.stringify(bounded).length < 12000, `plan blob bounded (${kb(JSON.stringify(bounded).length)})`);
  assert(boundConversationPlan(null) === null, "null plan stays null");
}

console.log("step 3: a whole record is bounded end to end");
{
  const record = {
    user: "u".repeat(50000), assistant: "a".repeat(50000),
    toolOutputs: Array.from({ length: 30 }, () => ({ tool: "read_file", output: "f".repeat(20000) })),
    plan: { summary: "s".repeat(5000), steps: Array.from({ length: 40 }, () => ({ title: "t".repeat(900) })) },
    intents: ["code"], sessionId: "s1", runId: "r1",
  };
  const before = JSON.stringify(record).length;
  const after = JSON.stringify(boundConversationRecord(record)).length;
  assert(after < 25000, `record bounded to ${kb(after)} (was ${kb(before)})`);
  assert(after < before / 5, `at least 5x smaller (${Math.round(before / after)}x)`);
}

console.log("step 4: the store writes digests and enforces retention");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-hygiene-"));
  const store = new MemoryStore(root);
  store.appendConversation({
    agentId: "main", user: "hi", assistant: "yo", sessionId: "s", runId: "r",
    toolOutputs: Array.from({ length: 25 }, () => ({ tool: "exec", output: "z".repeat(9000) })),
    plan: { summary: "x".repeat(4000), steps: [{ title: "y".repeat(4000) }] },
  });
  const stored = store.getRecentConversations(5, "main");
  assert(stored.length === 1, "conversation stored");
  assert(JSON.stringify(stored[0]).length < 15000, `stored record bounded (${kb(JSON.stringify(stored[0]).length)})`);
  assert(/digest stored/.test(JSON.stringify(stored[0].toolOutputs)), "store keeps digests, not raw output");
  const fileSize = fs.statSync(path.join(root, "data", "memory.json")).size;
  assert(fileSize < 20000, `memory.json stays small per write (${kb(fileSize)})`);
  assert(CONVERSATION_RETENTION >= 500, `retention is a real cap (${CONVERSATION_RETENTION})`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 5: secrets are redacted before they reach durable memory");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-secret-"));
  const store = new MemoryStore(root);
  // Clearly fake, built at runtime, and 46 chars so it stays at/above the
  // 40-char mask threshold (this step asserts the head+tail form is written).
  const fakeKey = "sk-live-" + "x".repeat(38);
  const res = store.writeStructuredMemory({ agentId: "main", title: "api key", text: `user ka key ${fakeKey} hai` });
  assert(res.ok === true, "memory write succeeded");
  const onDisk = fs.readFileSync(res.path, "utf8");
  assert(!onDisk.includes(fakeKey), "raw key is NOT on disk");
  assert(onDisk.includes(maskSecret(fakeKey)), `masked form written instead (${maskSecret(fakeKey)})`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nmemory-hygiene: ${failures} FAILURES` : "\nmemory-hygiene: ALL PASS");
process.exit(failures ? 1 : 0);
