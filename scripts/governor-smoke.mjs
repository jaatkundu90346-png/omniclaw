// Governor settings + budget handoff + cache matrix + background-model
// precedence. No network, no model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop, getOmniLoopSettings } from "../src/core/omni-loop.js";
import { describeCacheSupport } from "../src/core/providers/openai-compatible-provider.js";
import { Heartbeat } from "../src/core/heartbeat.js";
import { MemoryStore } from "../src/core/memory-store.js";

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`  FAIL ${msg}`); process.exitCode = 1; return; }
  passed += 1;
  console.log(`  ok   ${msg}`);
}

// 1. governor + digest + cap + breakpoint settings
{
  const s = getOmniLoopSettings({});
  // E1 sizing (2026-09): 300000 → 600000 — parallel batches carry more calls
  // per round and a real multi-file build spends ~325k (evidence: 300k hit at
  // round 14 with 9/29 calls failed). Per-round ceiling unchanged (120k).
  ok(s.runTokenBudget === 600000, "runTokenBudget default 600000");
  ok(s.runTokenWarnAt === 0.7, "runTokenWarnAt default 0.7");
  ok(s.digestAfterRounds === 6, "digestAfterRounds default 6");
  ok(s.maxToolCallsPerRound === 6, "maxToolCallsPerRound default 6");
  ok(s.cacheMaxBreakpoints === 4, "cacheMaxBreakpoints default 4");
  const over = getOmniLoopSettings({ runtime: { omniLoop: { runTokenBudget: 1, runTokenWarnAt: 99, digestAfterRounds: 99, maxToolCallsPerRound: 99, cacheMaxBreakpoints: 99 } } });
  ok(over.runTokenBudget === 50000 && over.runTokenWarnAt === 0.95 && over.digestAfterRounds === 12 && over.maxToolCallsPerRound === 12 && over.cacheMaxBreakpoints === 4, "settings clamp to bounds");
  const custom = getOmniLoopSettings({ runtime: { omniLoop: { runTokenBudget: 100000, runTokenWarnAt: 0.5 } } });
  ok(custom.runTokenBudget === 100000 && custom.runTokenWarnAt === 0.5, "explicit config wins");
}

// 2. budget handoff writes resumable PROGRESS block
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gov-"));
  const loop = new OmniLoop({ agentRuntime: { rootDir: tmpRoot } });
  loop.writeBudgetHandoff({
    message: "migrate the thing",
    run: { id: "run9" },
    session: { id: "s" },
    agent: { id: "main" },
    report: {},
    toolOutputs: [{ tool: "read_file", input: { path: "a.js" }, output: { content: "x" } }],
    effectiveTotal: 310000,
  });
  const text = fs.readFileSync(path.join(tmpRoot, "PROGRESS.md"), "utf8");
  ok(/BUDGET HANDOFF/.test(text) && /migrate the thing/.test(text) && /a\.js/.test(text), "handoff block has goal + files");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// 3. cache capability matrix
{
  const cases = [
    ["claude-x", "https://api.anthropic.com", "cache_control"],
    ["anthropic/claude-x", "https://openrouter.ai/api/v1", "cache_control"],
    ["gpt-4o", "https://api.openai.com/v1", "automatic"],
    ["nex-agi/nex-n2.5-pro:free", "https://openrouter.ai/api/v1", "none"],
    ["tencent/hy3:free", "https://openrouter.ai/api/v1", "none"],
    ["", "", "none"],
  ];
  for (const [model, base, want] of cases) {
    const got = describeCacheSupport(model, base).mechanism;
    ok(got === want, `matrix ${model || "(empty)"} -> ${want}`);
  }
  const live = describeCacheSupport("nex-agi/nex-n2.5-pro:free", "https://openrouter.ai/api/v1");
  ok(live.supported === false, "live model reports unsupported (no faked savings)");
}

// 4. heartbeat background-model precedence
{
  const hb = new Heartbeat({ agent: null });
  hb.agent = { config: { getConfig: () => ({ runtime: { heartbeat: { model: "hb-cheap" } }, provider: { compactionModel: "c-cheap" } }) } };
  ok(hb.resolveBackgroundModel() === "hb-cheap", "explicit heartbeat model wins");
  hb.agent = { config: { getConfig: () => ({ runtime: { heartbeat: {} }, provider: { compactionModel: "c-cheap" } }) } };
  ok(hb.resolveBackgroundModel() === "c-cheap", "falls back to compactionModel");
  hb.agent = { config: { getConfig: () => ({ runtime: {}, provider: {} }) } };
  ok(hb.resolveBackgroundModel() === "", "empty inherits main");
}

// 5. dream sweep threads the cheap model id into provider.complete input
{
  const seen = [];
  const provider = { complete: async (msgs, input) => { seen.push(input); return { text: "[]" }; } };
  const tmpMem = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-dream-"));
  const store = new MemoryStore(tmpMem);
  await store.scoreCandidatesWithModel([{ id: "c1", title: "t", text: "x" }], provider, "cheap-x");
  ok(seen.length > 0 && seen[0] && seen[0].model === "cheap-x", "dream sweep passes model override to provider");
  fs.rmSync(tmpMem, { recursive: true, force: true });
}

console.log(`\ngovernor: ${passed} passed${process.exitCode ? " WITH FAILURES" : " ALL PASS"}`);
process.exit(process.exitCode || 0);
