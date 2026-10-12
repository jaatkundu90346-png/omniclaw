// Unblock contract (live 2026-09-27, real run_1790492275263_vajwt0):
//  1. A blocked shell command must TEACH the safe alternative, not dump a
//     regex. Live: after `npm install` failed with ENOTEMPTY the model tried
//     `Stop-Process -Name node -Force` + `Remove-Item .\node_modules -Recurse
//     -Force`; the policy correctly blocked it and the observation taught
//     nothing, so the agent kept going and burned rounds "thinking".
//  2. A backgrounded command returns a pid, not a result. `process_status` must
//     become reachable and the observation must name the exact follow-up call,
//     otherwise a weak model polls the filesystem and never learns the outcome.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeShellCommand, shellBlockHint } from "../src/core/shell-policy.js";
import { OmniLoop } from "../src/core/omni-loop.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

console.log("step 1: the exact live blocked command now teaches the safe alternative");
{
  // Verbatim from run_1790492275263_vajwt0 (blocked on 2026-09-27).
  const command = "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime; Stop-Process -Name node -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; if (Test-Path .\\node_modules) { Remove-Item .\\node_modules -Recurse -Force -ErrorAction SilentlyContinue }; Test-Path .\\node_modules";
  const analysis = analyzeShellCommand(command, {});
  assert(analysis.risk === "blocked", "the command is still blocked (safety unchanged)");
  const hint = shellBlockHint(command, analysis.blockedPattern);
  assert(/kills OmniClaw itself/i.test(hint), "hint warns that killing all node kills the harness itself");
  assert(/process_kill/.test(hint), "hint names the precise alternative tool");
  assert(/delete_computer_path/.test(hint), "hint names the non-blocked delete tool");
  assert(/blocked/i.test(analysis.reasons[0]), "the policy reason is still reported");
  assert(!/backslash/i.test(hint), "no invented advice about a typo that did not happen");
}

console.log("step 2: hints exist for the other destructive blocks");
{
  assert(/discards/i.test(shellBlockHint("git reset --hard HEAD~1", "")), "git reset --hard is explained");
  assert(/untracked/i.test(shellBlockHint("git clean -fd", "")), "git clean is explained");
  assert(/destroys all data/i.test(shellBlockHint("format D:", "")), "disk format is explained");
  assert(/themselves/i.test(shellBlockHint("shutdown /s", "")), "machine-level action is explained");
  assert(/delete_computer_path/.test(shellBlockHint("rm -rf build", "")), "bash rm -rf is redirected to a real tool");
  assert(shellBlockHint("npm run build", "") === "", "an ordinary command gets no scary hint");
}


console.log("step 3: a backgrounded exec admits process_status and names the call");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bg-"));
  const runtime = {
    rootDir: tmpRoot,
    config: { getConfig: () => ({ provider: { model: "t" }, app: {} }) },
    gateway: { addEvent() {}, emitTransient() {} },
    sessions: { getSession: () => ({ transcript: [] }), updateSession() {}, getEvidenceLedger: () => null, listSessions: () => [] },
    memory: { getLongTermMemory: () => [], getNotes: () => [] },
    tools: {
      getAll: () => [
        { id: "exec", description: "run", modelCallable: true, schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
        { id: "process_status", description: "read a background process", modelCallable: true, schema: { type: "object", properties: { processId: { type: "string" } } } },
      ],
      run: async () => ({ status: "started", processId: "proc_abc123", pid: 4242 }),
      getRunPlan: () => null, getSessionPlan: () => null,
      getRunToolsets: () => [], getSessionToolsets: () => [],
    },
    provider: { getInfo: () => ({ model: "t" }) },
    files: { rootDir: tmpRoot },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  // Menu deliberately contains ONLY exec (the capped-menu case that trapped the
  // live run): process_status must still become admissible.
  const allowedToolIds = new Set(["exec"]);
  const allTools = runtime.tools.getAll();
  const toolSchemas = [{ type: "function", function: { name: "exec", description: "run", parameters: {} } }];
  const toolParamSchemas = new Map([["exec", {}]]);
  const report = { toolCallCount: 0, rejectedToolCalls: [] };
  const events = [];
  const out = await loop.executeRoundCall(
    { tool: "exec", input: { command: "npm install" } },
    {
      round: 4,
      report,
      toolOutputs: [],
      loopController: { canRunTool: () => true, toolStarted: () => {}, toolOutput: () => {}, toolCompleted: () => {} },
      gateway: { addEvent: (type, payload) => events.push({ type, payload }) },
      run: { id: "r1" },
      session: { id: "s1" },
      agent: { id: "main" },
      allowedToolIds,
      availableToolIds: new Set(allTools.map((t) => t.id)),
      allTools,
      toolSchemas,
      toolParamSchemas,
      readFiles: new Set(),
      fileVersions: new Map(),
      readStamps: new Map(),
      surfacedDocs: null,
    },
  );
  assert(out?.processId === "proc_abc123", "the pid observation is preserved");
  assert(out?.stillRunning === true, "observation says the command is still running");
  assert(/process_status/.test(String(out?.nextStep || "")), "the exact follow-up call is named");
  assert(/Do NOT guess/.test(String(out?.nextStep || "")), "it tells the model not to guess/poll");
  assert(allowedToolIds.has("process_status"), "process_status admitted into the live menu");
  assert(toolSchemas.some((s) => s.function.name === "process_status"), "its schema is now in the menu payload");
  assert(report.backgroundProcesses?.length === 1, "background process recorded in the report");
  assert(events.some((e) => e.type === "model_tool_loop.background_process_started"), "gateway event emitted");
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log("step 4: a normal foreground exec is NOT annotated");
{
  const loop = Object.create(OmniLoop.prototype);
  const base = { allowedToolIds: new Set(), allTools: [], toolSchemas: [], toolParamSchemas: new Map(), report: {}, round: 1 };
  assert(loop.annotateBackgroundProcess({ tool: "exec", input: { command: "npm run build" } }, { exitCode: 0, stdout: "ok" }, base) === null,
    "foreground output left untouched (no false 'still running')");
  assert(loop.annotateBackgroundProcess({ tool: "write_file", input: {} }, { status: "started", processId: "p1" }, base) === null,
    "non-shell tools are never annotated");
}

console.log(failures ? `\nunblock-contract: ${failures} FAILURES` : "\nunblock-contract: ALL PASS");
process.exit(failures ? 1 : 0);
