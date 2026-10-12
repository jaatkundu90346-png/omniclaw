// Ledger help + thinking metric (Parts D + F).
// D: small files (<2000 chars) inline FULL content; larger files show size +
// description with re-read allowed; no wording discourages re-reading.
// F: thinkingRatio helper + per-round reasoning fields exist.
import { OmniLoop, thinkingRatio } from "../src/core/omni-loop.js";

let failures = 0;
function assert(cond, label) {
  if (!cond) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

console.log("step 1: ledger renders a 309-byte file with FULL content");
const smallContent = "line one\nline two is here\nline three ends";
const ledger = {
  turn: 2,
  files: {
    "c:/proj/tasks.md": { size: 309, turn: 1, about: "line one", content: smallContent, mtimeMs: 1, hash: "x" },
    "c:/proj/big.js": { size: 50000, turn: 1, about: "server entry, express app", mtimeMs: 2, hash: "y" },
  },
  edits: [],
  commands: [{ cmd: "node --check big.js", exit: 0, turn: 2, result: "ok" }],
  findings: [],
};
const runtime = {
  rootDir: "X",
  getWorkspaceRoot: () => "P",
  config: { getConfig: () => ({ provider: {}, app: {} }) },
  tools: {},
  gateway: { addEvent: () => {}, emitTransient: () => {} },
  sessions: { getEvidenceLedger: () => ledger },
  provider: { getInfo: () => ({ model: "test" }) },
  fileStore: { searchText: () => ({ matches: [] }) },
};
const loop = new OmniLoop({ agentRuntime: runtime });
const section = loop.buildEvidenceLedgerSection({ id: "s1" });
assert(section.includes("line two is here"), "small file FULL content inlined (not just first line)");
assert(section.includes("50000") || section.includes("48.8KB"), "large file states its size");
assert(section.includes("server entry, express app"), "large file keeps a real one-line description");
assert(/re-reading is cheap and allowed/i.test(section), "ledger says re-reading is cheap and allowed");
assert(!/do NOT re-read/i.test(section), "no wording discourages re-reading");
assert(!/already available/i.test(section) || /work from it/i.test(section), "never implies missing content is available");

console.log("step 2: thinking-to-action ratio helper");
assert(thinkingRatio(800, 4) === 200, "800 reasoning tokens / 4 calls = 200");
assert(thinkingRatio(500, 0) === 500, "zero actions: ratio carries the catastrophic count, no div-by-zero");
assert(thinkingRatio(0, 0) === 0, "zero/zero = 0");
assert(thinkingRatio(0, 5) === 0, "no reasoning = 0");

console.log("step 3: reasoning-effort support is reported");
const support = loop.describeReasoningSupport();
assert(support && typeof support.mechanism === "string" && support.mechanism.length > 0, `support reported (${support.mechanism})`);

console.log(failures ? `\nledger-thinking: ${failures} FAILURES` : "\nledger-thinking: ALL PASS");
process.exit(failures ? 1 : 0);
