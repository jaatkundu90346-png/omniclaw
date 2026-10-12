// Context-memory smoke: the "Claude Code se better" guarantees.
//  1. Digest is PRESSURE-based: the same transcript digests on a small-window
//     model but stays FULL on a big-window model (1M context bharne layak).
//  2. Digest keeps read EXCERPTS — what each file CONTAINED, not just "ok".
//  3. Main-loop required-args guard: write_file {} gets a TEACHING block with
//     the exact missing args + example (the live 2026-09-20 stuck run).
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { OmniLoop } = await import(pathToFileURL(path.join(ROOT, "src/core/omni-loop.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -> " + String(detail).slice(0, 180)}`);
  if (!ok) failures += 1;
};

const BIG = Array.from({ length: 60 }, (_, i) => `line ${i + 1}: implementation detail of the nexus site worth remembering`).join("\n");

function makeRuntime({ contextTokens, contextCharBudget, calls }) {
  let n = 0;
  const provider = {
    getInfo: () => ({ id: "recorder", model: "test-model", ready: true }),
    completeWithTools: async () => {
      n += 1;
      if (n <= calls) return { text: "", toolCalls: [{ id: `tc${n}`, tool: "read_file", input: { path: `f${n}.txt` } }] };
      return { text: "done", toolCalls: [] };
    },
  };
  return {
    provider,
    gateway: { addEvent() {}, emitTransient() {} },
    sessions: { getSession: () => ({ transcript: [] }), updateSession() {} },
    config: { getConfig: () => ({ runtime: { omniLoop: { maxRounds: 12, enforceToolUse: false, vision: false, streaming: false, autoPlanSeed: false, contextTokens, contextCharBudget } }, provider: { model: "test-model", contextTokens } }) },
    files: { rootDir: ROOT },
    tools: {
      getAll: () => [{ id: "read_file", description: "read", modelCallable: true, schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      run: async (tool, input) => ({ path: input.path, content: BIG, totalLines: 900 }),
      getRunPlan: () => null, getSessionPlan: () => null,
    },
    workspace: { workspaceDir: ROOT },
  };
}

async function runWith(contextTokens, contextCharBudget) {
  const runtime = makeRuntime({ contextTokens, contextCharBudget, calls: 8 });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "read the files", intents: [], agent: { id: "main" },
    profile: { allowToolExecution: true }, session: { id: "ctx-mem" },
    run: { id: `run-${contextTokens}-${contextCharBudget}` },
    tools: runtime.tools.getAll(), contextBundle: {},
  });
  return res;
}

// ── 1. Small-window model: pressure crosses 0.55 → digest fires ────────────
const small = await runWith(40000, 30000);
check("small-window run completes with 8 tool calls", (small?.report?.toolCallCount || 0) >= 8, small?.report?.toolCallCount);
check("small-window model DIGESTS under pressure", (small?.report?.digestRounds || 0) > 0, `digestRounds=${small?.report?.digestRounds}`);

// ── 2. Big-window model (1M): same transcript, NO digest — results stay full
const big = await runWith(1000000, 4000000);
check("1M-window run completes with 8 tool calls", (big?.report?.toolCallCount || 0) >= 8, big?.report?.toolCallCount);
check("1M-window model does NOT digest (full fidelity kept)", (big?.report?.digestRounds || 0) === 0, `digestRounds=${big?.report?.digestRounds}`);

// ── 3. Required-args guard (write_file {} plague) ───────────────────────────
{
  let n = 0;
  const seen = [];
  const provider = {
    getInfo: () => ({ id: "recorder", model: "test-model", ready: true }),
    completeWithTools: async (messages) => {
      n += 1;
      seen.push(JSON.parse(JSON.stringify(messages)));
      if (n === 1) return { text: "", toolCalls: [{ id: "w1", tool: "write_file", input: {} }] };
      const sawTeaching = messages.some((m) => m.role === "tool" && /Missing required argument/.test(String(m.content || "")));
      if (n === 2 && sawTeaching) return { text: "", toolCalls: [{ id: "w2", tool: "write_file", input: { path: "tmp/ctxmem-guard-new.html", content: "<html>ok</html>" } }] };
      return { text: "wrote it", toolCalls: [] };
    },
  };
  const runtime = {
    provider, gateway: { addEvent() {}, emitTransient() {} },
    sessions: { getSession: () => ({ transcript: [] }), updateSession() {} },
    config: { getConfig: () => ({ runtime: { omniLoop: { maxRounds: 6, enforceToolUse: false, vision: false, streaming: false, autoPlanSeed: false } }, provider: { model: "m" } }) },
    files: { rootDir: ROOT },
    tools: {
      getAll: () => [{ id: "write_file", description: "write", modelCallable: true, schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }],
      run: async (tool, input) => ({ path: input.path, bytesWritten: 12 }),
      getRunPlan: () => null, getSessionPlan: () => null,
    },
    workspace: { workspaceDir: ROOT },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "write the file", intents: [], agent: { id: "main" },
    profile: { allowToolExecution: true }, session: { id: "req-args" },
    run: { id: "run-req-args" }, tools: runtime.tools.getAll(), contextBundle: {},
  });
  check("empty-args write_file was BLOCKED with a teaching message", (res?.report?.requiredArgBlocks || 0) >= 1, `requiredArgBlocks=${res?.report?.requiredArgBlocks}`);
  check("teaching message reached the model (exact missing args named)", seen.some((msgs) => msgs.some((m) => m.role === "tool" && /Missing required argument\(s\): path \(string\), content \(string\)/.test(String(m.content || "")))));
  check("model RECOVERED: valid write executed after the teaching block", (res?.report?.toolCallCount || 0) >= 1 && String(res?.report?.finalAnswer || "").includes("wrote it"), `calls=${res?.report?.toolCallCount} stop=${res?.report?.stoppedReason || "none"} final=${String(res?.report?.finalAnswer || "").slice(0, 60)}`);
  check("no stuck-no-progress (the old live failure)", res?.report?.stoppedReason !== "stuck-no-progress", res?.report?.stoppedReason);
}

// ── 4. Session read-memory seeding (the write_file "already exists" plague) ──
// A file read in an EARLIER turn of the same session must not re-trip
// read-before-edit — that block refused every write_file after a model switch.
{
  let n = 0;
  const existing = path.join(ROOT, "package.json").replace(/\\/g, "/").toLowerCase();
  const provider = {
    getInfo: () => ({ id: "recorder", model: "test-model", ready: true }),
    completeWithTools: async () => {
      n += 1;
      if (n === 1) return { text: "", toolCalls: [{ id: "s1", tool: "write_file", input: { path: "package.json", content: "{ \"ok\": true }" } }] };
      return { text: "updated package.json", toolCalls: [] };
    },
  };
  const runtime = {
    provider, gateway: { addEvent() {}, emitTransient() {} },
    sessions: {
      getSession: () => ({ transcript: [] }),
      updateSession() {},
      // The session ledger says: this file was READ in an earlier turn.
      getEvidenceLedger: () => ({ turn: 3, files: { [existing]: { size: 100, turn: 2, about: "package manifest", mtimeMs: 1, hash: "h" } }, edits: [], commands: [], findings: [] }),
    },
    config: { getConfig: () => ({ runtime: { omniLoop: { maxRounds: 4, enforceToolUse: false, vision: false, streaming: false, autoPlanSeed: false } }, provider: { model: "m" } }) },
    files: { rootDir: ROOT },
    tools: {
      getAll: () => [{ id: "write_file", description: "write", modelCallable: true, schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }],
      run: async (tool, input) => ({ path: input.path, bytesWritten: 14 }),
      getRunPlan: () => null, getSessionPlan: () => null,
    },
    workspace: { workspaceDir: ROOT },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const res = await loop.run({
    message: "update package.json", intents: [], agent: { id: "main" },
    profile: { allowToolExecution: true }, session: { id: "seed-test" },
    run: { id: "run-seed" }, tools: runtime.tools.getAll(), contextBundle: {},
  });
  check("session reads were seeded from the evidence ledger", (res?.report?.seededReadFiles || 0) >= 1, `seededReadFiles=${res?.report?.seededReadFiles}`);
  check("existing file write NOT blocked by read-before-edit (model switch case)", (res?.report?.readBeforeEditBlocks || 0) === 0, `readBeforeEditBlocks=${res?.report?.readBeforeEditBlocks}`);
  check("the write actually executed", (res?.report?.toolCallCount || 0) === 1, `calls=${res?.report?.toolCallCount} stop=${res?.report?.stoppedReason || "none"}`);
  const blockedExisting = (res?.toolOutputs || []).some((t) => /already exists/.test(JSON.stringify(t.output || {})));
  check("no 'already exists. Read it first' block anywhere", !blockedExisting);
}

console.log(failures === 0 ? "\ncontext-memory: ALL PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

