// T2.1 context-diet contract: pure allocator + engine v2 path (R14: one run
// per change; both modes covered here so regressions show in one pass).
// Verifies: memory floor starvation-proof; manuals excluded from prompt;
// total ≤ 28k on a synthetic 200k-char context; trace budget fields present;
// v1 path byte-identical behaviour (no budget block); heartbeat minimal;
// omni-loop v2 settings default 0.85/6000 with explicit-config override.
import { ContextEngine } from "../src/core/context-engine.js";
import { getOmniLoopSettings } from "../src/core/omni-loop.js";
import { allocate, capIdentityFile, manualsLine, V2_TOTAL_CAP } from "../src/core/context-budget.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) {
    failures++;
    console.log(`FAIL: ${label}`);
    return;
  }
  console.log(`ok: ${label}`);
}

// ── pure allocator ──────────────────────────────────────────────
{
  const got = allocate([
    { id: "workspace", chars: 180000, cap: 4000 },
    { id: "activeMemory", chars: 2000, memory: true, cap: 2500 },
    { id: "longTermMemory", chars: 3000, memory: true, cap: 2000 },
    { id: "rest", chars: 50000, rest: true, cap: 8000 },
  ]);
  assert(got.memoryKept === 4000, `memory floor kept all available (got ${got.memoryKept})`);
  assert(got.used <= V2_TOTAL_CAP, `total within cap (got ${got.used})`);
  assert(got.kept.get("workspace") <= 4000, "workspace capped");
}
{
  // Starvation proof: 200k workspace + tiny memory → memory fully kept.
  const got = allocate([
    { id: "workspace", chars: 200000, cap: 4000 },
    { id: "activeMemory", chars: 800, memory: true, cap: 2500 },
  ]);
  assert(got.memoryKept === 800, "memory never starved by workspace bulk");
  assert(got.used <= V2_TOTAL_CAP, "total within cap under bulk");
}
{
  const capped = capIdentityFile("SOUL.MD", `x${"y".repeat(5000)}`);
  assert(capped.text.length <= 1200 + 120, "SOUL tail-capped ~1.2k");
  assert(/trimmed from SOUL\.MD/.test(capped.text), "trim marker names the file");
  const line = manualsLine([{ name: "SOUL.md" }, { name: "TOOLS.md" }, { name: "HARNESS.md" }]);
  assert(!/SOUL/.test(line) && /TOOLS\.md/.test(line) && /read_file/.test(line), "manuals line drops identity, points at read_file");
}

// ── engine v2 end-to-end on synthetic 200k context ─────────────
function bigFiles() {
  const files = [
    { name: "SOUL.md", scope: "agent", path: "/ws/SOUL.md", content: `soul\n${"s".repeat(9000)}` },
    { name: "IDENTITY.md", scope: "agent", path: "/ws/IDENTITY.md", content: "id\n".repeat(600) },
    { name: "PERSONALITY.md", scope: "agent", path: "/ws/PERSONALITY.md", content: "p\n".repeat(600) },
    { name: "USER.md", scope: "agent", path: "/ws/USER.md", content: "- likes x\n".repeat(400) },
    { name: "TOOLS.md", scope: "agent", path: "/ws/TOOLS.md", content: `t${"o".repeat(60000)}` },
    { name: "AGENT_LOOP.md", scope: "agent", path: "/ws/AGENT_LOOP.md", content: `l${"o".repeat(60000)}` },
    { name: "AGENT_RUNTIME.md", scope: "agent", path: "/ws/AGENT_RUNTIME.md", content: `r${"u".repeat(60000)}` },
  ];
  return files;
}
function v2input() {
  return {
    promptV2: true,
    sessionId: "sess-smoke",
    message: "hello",
    profile: { id: "power" },
    loopContract: { stages: ["a", "b"], note: "n".repeat(8000) },
    plan: { steps: [] },
    skills: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `skill-${i}`, description: `does things ${i} `.repeat(20) })),
    tools: Array.from({ length: 211 }, (_, i) => ({ id: `t${i}`, description: `tool ${i}`, permission: "" })),
    toolOutputs: [],
    workspaceContext: { manifest: { agentWorkspace: "/ws" }, files: bigFiles() },
    activeMemory: { promptSection: `relevant memory `.repeat(150) },
    longTermMemory: [{ text: "fact one" }, { text: "fact two" }],
    notes: [{ text: "note one" }],
    recentConversations: [],
    research: [],
    artifacts: [],
    tasks: [],
    harness: null,
    mcp: null,
    sessionSummary: null,
    workspaceDir: "",
    channel: "webchat",
  };
}
{
  const engine = new ContextEngine({ getConfig: () => ({ prompt: { v2: true } }) });
  const bundle = engine.build(v2input());
  assert(bundle.promptV2 === true, "v2 bundle flagged");
  assert(bundle.report.usedChars <= V2_TOTAL_CAP, `v2 total ≤28k (got ${bundle.report.usedChars})`);
  assert(bundle.report.budget && bundle.report.budget.cap === V2_TOTAL_CAP, "report.budget present with cap");
  assert(bundle.report.budget.memoryKept >= Math.min(6000, 1) && bundle.report.budget.memoryKept > 0, `memory kept (${bundle.report.budget.memoryKept})`);
  assert(Array.isArray(bundle.report.budget.sections) && bundle.report.budget.sections.length > 5, "budget sections itemized");
  assert(bundle.skills.length <= 5, `skills top-5 (got ${bundle.skills.length})`);
  assert(bundle.workspaceContext.promptV2diet === true, "workspace diet flagged");
  assert(bundle.workspaceContext.files.length === 4, `only identity files (${bundle.workspaceContext.files.length})`);
  assert(/Manuals available via read_file/.test(bundle.workspaceContext.manualsLine || ""), "manuals one-liner present");
  assert(bundle.loopContract && JSON.stringify(bundle.loopContract).length <= 2100, "loopContract ≤2k");
}
{
  // Model-aware scaling: a KNOWN huge window grows the diet (floor = the
  // designed 28k, ceiling 120k) while the no-contextTokens cases above stay
  // byte-identical. Live regression: 1M-window model was fed 28000 chars with
  // 311 items omitted per turn (2026-09-23).
  const big = new ContextEngine({ getConfig: () => ({ prompt: { v2: true }, provider: { contextTokens: 1048576 } }) });
  const bundleBig = big.build(v2input());
  assert(bundleBig.report.maxChars === 120000, `v2 1M window -> cap ceiling 120000 (got ${bundleBig.report.maxChars})`);
  assert(bundleBig.report.usedChars <= 120000, `model-aware total within ceiling (got ${bundleBig.report.usedChars})`);
  const mid = new ContextEngine({ getConfig: () => ({ prompt: { v2: true }, provider: { contextTokens: 128000 } }) });
  assert(mid.getMaxChars({ id: "power" }) === 64000, `128k window -> 64000 (got ${mid.getMaxChars({ id: "power" })})`);
  const v1big = new ContextEngine({ getConfig: () => ({ provider: { contextTokens: 1048576 } }) });
  assert(v1big.getMaxChars({ id: "power" }) === 160000, `v1 power scales to 160000 ceiling (got ${v1big.getMaxChars({ id: "power" })})`);
  assert(new ContextEngine({ getConfig: () => ({ prompt: { v2: true } }) }).getMaxChars({ id: "power" }) === V2_TOTAL_CAP, "no contextTokens -> designed 28k unchanged");
}
{
  // v1 path unchanged: no budget block, full files, old caps.
  const engine = new ContextEngine({ getConfig: () => ({}) });
  const bundle = engine.build({ ...v2input(), promptV2: false });
  assert(!bundle.report.budget, "v1 has no budget block");
  assert(bundle.report.maxChars === 64000, `v1 power budget unchanged (got ${bundle.report.maxChars})`);
  assert(bundle.skills.length === 8, "v1 keeps all 8 skills");
}
{
  // Heartbeat minimal: HEARTBEAT.md only.
  const engine = new ContextEngine({ getConfig: () => ({ prompt: { v2: true } }) });
  const input = v2input();
  input.channel = "heartbeat";
  input.workspaceContext.files.push({ name: "HEARTBEAT.md", scope: "agent", path: "/ws/HEARTBEAT.md", content: "Check approvals." });
  const bundle = engine.build(input);
  assert(bundle.workspaceContext.heartbeatOnly === true, "heartbeat flagged");
  assert(bundle.workspaceContext.files.length === 1 && bundle.workspaceContext.files[0].name === "HEARTBEAT.md", "heartbeat keeps only HEARTBEAT.md");
  assert(bundle.skills.length === 0, "heartbeat drops skills");
}

// ── omni-loop v2 settings ───────────────────────────────────────
{
  const old = getOmniLoopSettings({});
  assert(old.compactAtPercent === 0.8 && old.maxToolResultChars === 10000 && old.promptV2 !== true, "v1 settings defaults unchanged");
  const v2 = getOmniLoopSettings({ prompt: { v2: true } });
  assert(v2.compactAtPercent === 0.85 && v2.maxToolResultChars === 6000 && v2.promptV2 === true, "v2 settings 0.85/6000");
  const over = getOmniLoopSettings({ prompt: { v2: true }, runtime: { omniLoop: { compactAtPercent: 0.9, maxToolResultChars: 9000 } } });
  assert(over.compactAtPercent === 0.9 && over.maxToolResultChars === 9000, "explicit config wins over v2 defaults");
}

console.log(failures ? `\ncontext-budget: ${failures} FAILURES` : "\ncontext-budget: ALL PASS");
process.exit(failures ? 1 : 0);
