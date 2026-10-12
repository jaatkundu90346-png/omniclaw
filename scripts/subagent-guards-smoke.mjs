// Smoke test: sub-agent parent-loop-parity guards (iteration 6).
//  1. Identical-call budget: same tool + same args executes max 3x; further
//     identical calls get a blocked synthetic result (no more 24-round spins).
//  2. Context bound: old bulky tool results are stubbed once the transcript
//     exceeds the budget, so file-heavy delegations can't die on overflow.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { SubAgentSpawner } = await import(pathToFileURL(path.join(ROOT, "src/core/sub-agent-spawner.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const makeSpawner = ({ provider, registryRun, subAgentsConfig = {} }) => new SubAgentSpawner({
  agentRuntime: { provider, rootDir: ROOT, gateway: { addEvent() {} } },
  configStore: { getConfig: () => ({ runtime: { subAgents: subAgentsConfig }, provider: {} }) },
  toolRegistry: {
    getAll: () => [{ id: "read_file", description: "read", schema: { type: "object", properties: { path: { type: "string" } } } }],
    run: registryRun,
  },
});

// ── 1. Identical-call budget ─────────────────────────────────────────────────
{
  let executions = 0;
  let rounds = 0;
  const provider = {
    completeWithTools: async (messages) => {
      rounds += 1;
      // Emit the SAME call 6 rounds in a row, then finish.
      if (rounds <= 6) return { text: "", toolCalls: [{ id: `c${rounds}`, tool: "read_file", input: { path: "a.txt" } }] };
      const sawBlock = messages.some((m) => m.role === "tool" && /Repeated identical tool call blocked/.test(String(m.content)));
      return { text: sawBlock ? "done-after-block" : "done", toolCalls: [] };
    },
  };
  const spawner = makeSpawner({ provider, registryRun: async () => { executions += 1; return { path: "a.txt", content: "file body" }; } });
  const res = await spawner.spawn({ task: "read a.txt and summarize" });
  check("budget: tool executed exactly 3x (not 6)", executions === 3, `executions=${executions}`);
  // spawn() returns the BOUNDED report (buildSubAgentReport) — the child's own
  // final text lives inside it, so match on the report body, not equality.
  check("budget: blocked message reached the model", String(res.result || "").includes("done-after-block"), res.result);
  check("budget: run still completed", res.status === "completed", res.status);
}

// ── 2. Context bound ─────────────────────────────────────────────────────────
{
  const BIG = "x".repeat(60000);
  let rounds = 0;
  let finalMessages = null;
  const provider = {
    completeWithTools: async (messages) => {
      rounds += 1;
      finalMessages = messages;
      // 6 different big reads (~360KB total), then finish.
      if (rounds <= 6) return { text: "", toolCalls: [{ id: `c${rounds}`, tool: "read_file", input: { path: `file${rounds}.txt` } }] };
      return { text: "big-done", toolCalls: [] };
    },
  };
  // Small-context-model config (tool results are capped at 10KB each by the
  // result formatter, so a 40KB budget is crossed by the 5th read).
  const spawner = makeSpawner({ provider, registryRun: async (tool, input) => ({ path: input.path, content: BIG }), subAgentsConfig: { contextChars: 40000 } });
  const res = await spawner.spawn({ task: "read all six files" });
  const total = finalMessages.reduce((n, m) => n + String(m.content || "").length, 0);
  const stubs = finalMessages.filter((m) => m.role === "tool" && /trimmed to keep this sub-agent/.test(String(m.content))).length;
  check("bound: transcript kept near budget", total <= 60000, `total=${total}`);
  check("bound: old tool results stubbed", stubs >= 1, `stubs=${stubs}`);
  const last = finalMessages.filter((m) => m.role === "tool").pop();
  // The newest result is formatted (not stubbed): it must carry no trim marker
  // and fill the formatter's per-result cap (10,000 chars in the sub-agent loop).
  const lastLen = String(last.content).length;
  check("bound: newest tool result kept full", lastLen >= 10000 && !/trimmed to keep this sub-agent/.test(String(last.content)), `lastLen=${lastLen}`);
  check("bound: run completed normally", res.status === "completed" && String(res.result || "").includes("big-done"), JSON.stringify({ s: res.status, r: String(res.result || "").slice(0, 120) }));
}

// ── 3. Normal flow untouched ─────────────────────────────────────────────────
{
  let rounds = 0;
  const provider = {
    completeWithTools: async () => {
      rounds += 1;
      if (rounds === 1) return { text: "", toolCalls: [{ id: "c1", tool: "read_file", input: { path: "one.txt" } }] };
      return { text: "normal-done", toolCalls: [] };
    },
  };
  const spawner = makeSpawner({ provider, registryRun: async () => ({ path: "one.txt", content: "small" }) });
  const res = await spawner.spawn({ task: "one small read" });
  check("normal delegation unaffected", res.status === "completed" && String(res.result || "").includes("normal-done") && res.toolCallCount === 1, JSON.stringify({ s: res.status, r: String(res.result || "").slice(0, 120), tools: res.toolCallCount }));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
