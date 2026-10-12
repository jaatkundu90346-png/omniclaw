// Hermes-parity smoke: verifies the 2026-07-03 upgrades hold —
//  1. Heartbeat EXECUTES due HEARTBEAT.md tasks as real agent runs
//     (freeform file = one implicit task; HEARTBEAT_OK stays quiet;
//     non-quiet results are delivered to the configured target).
//  2. Stale-file guard: editing a file that changed on disk after the
//     read is blocked once with a re-read instruction.
//  3. Instincts are relevance-ranked against the current message.
//  4. memory_write long-term honors title/tags/importance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Heartbeat } from "../src/core/heartbeat.js";
import { OmniLoop, isErrorFixTask, isContinueIntent, TYPE_TOOL_BOOSTS } from "../src/core/omni-loop.js";
import { MemoryStore } from "../src/core/memory-store.js";
import { FileStore } from "../src/core/file-store.js";
import { ToolRegistry } from "../src/core/tool-registry.js";

// Minimal real ToolRegistry over a real FileStore (same stub set as
// tool-contract-smoke) so code_act / restore_checkpoint run the REAL paths.
function makeRegistry(projRoot, extras = {}) {
  const permissions = {
    allowNoteWrite: true, allowMemoryPromotion: true, allowDreamSweep: true,
    allowConnectorWrite: true, allowTaskWrite: true, allowDirectoryList: true,
    allowComputerAccess: true, allowFileRead: true, allowFileWrite: true,
    allowShellPlanning: true, allowWebResearch: true, allowBrowserControl: true,
    allowShellExecution: true, allowTaskRunner: true, allowSkillWrite: true,
    allowConfigWrite: true, allowBrowserEvaluate: true, allowMemoryWrite: true,
  };
  return new ToolRegistry({
    memoryStore: { addNote: () => ({}), getNotes: () => [], getLongTermMemory: () => [], getDreams: () => [], getOverview: () => ({}), runDreamSweep: () => ({}), writeLayeredMemory: () => ({ ok: true }) },
    taskStore: { create: () => ({}), list: () => [] },
    configStore: { getConfig: () => ({ tools: { permissions, filesystem: { maxReadBytes: 131072, writableRoots: ["."] }, computerAccess: { maxReadBytes: 131072 } } }) },
    fileStore: new FileStore(projRoot),
    shellExecutor: { execute: () => ({ execution: { status: "completed" } }), getProcessStatus: () => ({}), listProcesses: () => [], killProcess: () => ({}), cleanupProcesses: () => ({}) },
    webResearch: { search: () => ({ results: [] }), fetchUrl: () => ({ markdown: "" }) },
    browserOperator: { getStatus: () => ({ available: true }), automate: () => ({}), readUrl: () => ({}), openUrl: () => ({}) },
    browser: { open: () => ({}), view: () => ({}), screenshot: () => ({}), click: () => ({}), type: () => ({}), scroll: () => ({}), wait: () => ({}), evaluate: () => ({}), goBack: () => ({}), goForward: () => ({}), close: () => ({}), automate: () => ({}), listSessions: () => [] },
    pluginRegistry: { getToolDefinitions: () => [], runTool: async () => ({}) },
    agentRuntime: { rootDir: projRoot },
    ...extras,
  });
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`ok: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-parity-"));

// ── 1. Heartbeat task execution ─────────────────────────────────────────────
{
  const events = [];
  const handled = [];
  const sent = [];
  let reply = "HEARTBEAT_OK";
  const agent = {
    config: { getConfig: () => ({ runtime: { heartbeat: { target: "telegram:42" } } }) },
    gateway: { addEvent: (type, payload) => events.push({ type, payload }) },
    telegramWorker: { sendMessage: async (chatId, text) => sent.push({ chatId, text }) },
    loadWorkspaceContext: () => ({
      files: [{ name: "HEARTBEAT.md", scope: "agent", content: "Check the disk space and report anomalies." }],
    }),
    handleMessage: async (message, options) => {
      handled.push({ message, options });
      return { reply };
    },
  };
  const hb = new Heartbeat({ agent, intervalMs: 1000 });

  const evaluated = hb.evaluateHeartbeatPrompt(Date.now());
  const due = evaluated?.result?.dueTasks || [];
  check("heartbeat: freeform HEARTBEAT.md becomes one implicit due task", due.length === 1 && due[0].name === "heartbeat");

  await hb.executeDueTasks(due, { target: "telegram:42" });
  check("heartbeat: due task actually ran through handleMessage", handled.length === 1);
  check("heartbeat: run used the heartbeat channel", handled[0]?.options?.channel === "heartbeat");
  check("heartbeat: HEARTBEAT_OK reply stays quiet (no delivery)", sent.length === 0);
  check(
    "heartbeat: quiet completion event recorded",
    events.some((e) => e.type === "heartbeat.task_completed" && e.payload.quiet === true),
  );

  reply = "Disk C: is 97% full — cleanup needed.";
  hb.taskRuns.clear(); // make the task due again
  const evaluated2 = hb.evaluateHeartbeatPrompt(Date.now() + 5000);
  await hb.executeDueTasks(evaluated2?.result?.dueTasks || [], { target: "telegram:42" });
  check("heartbeat: non-quiet result delivered to telegram target", sent.length === 1 && /97% full/.test(sent[0]?.text || ""));
  check("heartbeat: delivery event recorded", events.some((e) => e.type === "heartbeat.result_delivered"));
  check("heartbeat: status exposes execution counters", hb.getStatus().taskRunCount === 2);
}

// ── 2. Stale-file guard ─────────────────────────────────────────────────────
{
  const loop = new OmniLoop({ agentRuntime: { rootDir: tmpRoot, config: { getConfig: () => ({}) } } });
  const target = path.join(tmpRoot, "app.js");
  fs.writeFileSync(target, "console.log(1);\n");

  const readStamps = new Map();
  const readFiles = new Set();
  const key = loop.normalizeFilePath(target);
  readFiles.add(key);
  readStamps.set(key, loop.fileMtimeMs(target));

  const freshCall = { tool: "edit", input: { path: target, find: "1", replace: "2" } };
  check("stale-guard: edit on unchanged file passes", loop.checkStaleEdit(freshCall, readStamps, readFiles) === null);

  // External change: bump mtime well past the recorded stamp.
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(target, future, future);
  const blocked = loop.checkStaleEdit(freshCall, readStamps, readFiles);
  check("stale-guard: edit after external change is blocked", Boolean(blocked?.blocked));
  check("stale-guard: block message demands a re-read", /read_file/.test(String(blocked?.message || "")));
  check("stale-guard: stamp dropped so post-re-read edit passes", loop.checkStaleEdit(freshCall, readStamps, readFiles) === null);
  check("stale-guard: file no longer counted as read", !readFiles.has(key));
}

// ── 3. Relevance-ranked instincts ───────────────────────────────────────────
{
  const dataDir = path.join(tmpRoot, "instincts-home");
  fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });
  const loop = new OmniLoop({ agentRuntime: { rootDir: dataDir, config: { getConfig: () => ({}) } } });
  loop.saveInstincts([
    { text: "When editing CSS grid layouts, verify column counts in the browser.", confidence: 0.95 },
    { text: "When a python import fails, check the virtualenv before reinstalling packages.", confidence: 0.5 },
  ]);
  const section = loop.buildInstinctsSection("fix the python import error in my script");
  const pythonIdx = section.indexOf("python import");
  const cssIdx = section.indexOf("CSS grid");
  check("instincts: relevant lesson outranks higher-confidence irrelevant one", pythonIdx !== -1 && (cssIdx === -1 || pythonIdx < cssIdx));
}

// ── 4. memory_write long-term metadata ──────────────────────────────────────
{
  const memRoot = path.join(tmpRoot, "memory-home");
  fs.mkdirSync(memRoot, { recursive: true });
  const store = new MemoryStore(memRoot);
  const result = store.writeLayeredMemory({
    type: "long-term",
    content: "User prefers pnpm over npm for all JS projects.",
    title: "Package manager preference",
    tags: ["tooling", "preference"],
    importance: "high",
    agentId: "main",
  });
  check("memory: long-term write succeeds", result?.ok === true && result.layer === "longTerm");
  const memory = result?.memory || {};
  check("memory: custom title honored", memory.title === "Package manager preference");
  check("memory: importance honored", memory.importance === "high");
  check("memory: custom tags merged", (memory.tags || []).includes("tooling") && (memory.tags || []).includes("preference"));
}

// ── 5. Diagnose-first guard (the Game.ts read→think→read loop) ──────────────
{
  check("diagnose: error-fix task detected (English)", isErrorFixTask("fix the TypeScript errors in Game.ts"));
  check("diagnose: error-fix task detected (Hinglish)", isErrorFixTask("game me error aa rha hai thik karo"));
  check("diagnose: plain build task NOT flagged", !isErrorFixTask("ek portfolio website banao"));

  const events = [];
  let round = 0;
  const runtime = {
    rootDir: tmpRoot,
    config: {
      getConfig: () => ({
        runtime: { omniLoop: { enabled: true, maxRounds: 6, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false } },
      }),
    },
    gateway: { addEvent: (event, payload) => events.push({ event, payload }) },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      complete: async () => ({ text: "summary" }),
      completeWithTools: async (messages) => {
        round += 1;
        const diagnoseMsg = messages.find((m) => m.role === "user" && /\[Diagnose first\]/.test(String(m.content || "")));
        if (round <= 2) {
          // Two rounds of pure reading — the Game.ts spin pattern.
          if (diagnoseMsg) throw new Error("diagnose nudge fired too early");
          return { text: "", toolCalls: [{ id: `r${round}`, tool: "read_file", input: { path: `src/file${round}.ts` } }] };
        }
        if (round === 3) {
          // The guard must have injected the nudge naming a diagnostic command.
          if (!diagnoseMsg) throw new Error("diagnose nudge missing after 2 gathering rounds");
          if (!/tsc --noEmit/.test(String(diagnoseMsg.content))) throw new Error("nudge did not name the TypeScript diagnostic");
          return { text: "", toolCalls: [{ id: "r3", tool: "exec", input: { command: "npx tsc --noEmit" } }] };
        }
        return { text: "Errors mil gaye aur fix ho gaye.", toolCalls: [] };
      },
    },
    tools: {
      run: async (id, toolInput) => {
        if (id === "read_file") return { path: toolInput.path, content: "export const x: number = 1;\n", bytesRead: 30 };
        if (id === "exec") return { command: toolInput.command, status: "completed", exitCode: 0, stdout: "" };
        return { ok: true };
      },
    },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "fix the TypeScript errors in the game",
    agent: { id: "main", name: "Main" },
    profile: { id: "power" },
    session: { id: "session_diag" },
    run: { id: "run_diag" },
    tools: [
      { id: "read_file", description: "Read a file", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { id: "exec", description: "Run a command", schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
    ],
    contextBundle: {},
  });
  check("diagnose: nudge fired exactly once", report.diagnoseNudges === 1, `got ${report.diagnoseNudges}`);
  check("diagnose: event emitted", events.some((e) => e.event === "model_tool_loop.diagnose_nudge"));
  check("diagnose: run completed after diagnostic ran", report.finalReady === true && report.stoppedReason === "model-final-ready", `stop=${report.stoppedReason}`);
  check("diagnose: tsc exec counted as verification", report.verificationRan === true);
}

// ── 6. Re-verify gate (edits after a FAILING check are unproven fixes) ──────
{
  const events = [];
  let round = 0;
  let execCount = 0;
  const runtime = {
    rootDir: tmpRoot,
    config: {
      getConfig: () => ({
        runtime: { omniLoop: { enabled: true, maxRounds: 8, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false } },
      }),
    },
    gateway: { addEvent: (event, payload) => events.push({ event, payload }) },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      complete: async () => ({ text: "summary" }),
      completeWithTools: async (messages) => {
        round += 1;
        const reverifyMsg = messages.find((m) => m.role === "user" && /\[Re-verify before done\]/.test(String(m.content || "")));
        if (round === 1) return { text: "", toolCalls: [{ id: "r1", tool: "exec", input: { command: "npx tsc --noEmit" } }] };
        if (round === 2) return { text: "", toolCalls: [{ id: "r2", tool: "write_file", input: { path: "src/fix.ts", content: "export {};" } }] };
        if (round === 3) {
          // Tries to claim done WITHOUT re-running the failed check.
          if (reverifyMsg) throw new Error("re-verify nudge fired too early");
          return { text: "Maine errors fix kar diye!", toolCalls: [] };
        }
        if (round === 4) {
          if (!reverifyMsg) throw new Error("re-verify nudge missing after premature done");
          if (!/npx tsc --noEmit/.test(String(reverifyMsg.content))) throw new Error("nudge did not name the failing command");
          return { text: "", toolCalls: [{ id: "r4", tool: "exec", input: { command: "npx tsc --noEmit" } }] };
        }
        return { text: "Ab sach me done — tsc clean exit hua.", toolCalls: [] };
      },
    },
    tools: {
      run: async (id, toolInput) => {
        if (id === "exec") {
          execCount += 1;
          // First tsc run FAILS with errors; the re-run passes.
          return execCount === 1
            ? { command: toolInput.command, status: "failed", exitCode: 2, stdout: "src/core/Game.ts:42:13 - error TS2339: Property 'isOpen' does not exist." }
            : { command: toolInput.command, status: "completed", exitCode: 0, stdout: "" };
        }
        if (id === "write_file") return { path: toolInput.path, bytesWritten: 11 };
        return { ok: true };
      },
    },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "fix the TypeScript errors in the game",
    agent: { id: "main", name: "Main" },
    profile: { id: "power" },
    session: { id: "session_reverify" },
    run: { id: "run_reverify" },
    tools: [
      { id: "exec", description: "Run a command", schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
      { id: "write_file", description: "Write a file", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
    ],
    contextBundle: {},
  });
  check("reverify: premature done blocked exactly once", report.reverifyNudges === 1, `got ${report.reverifyNudges}`);
  check("reverify: event emitted with the failing command", events.some((e) => e.event === "model_tool_loop.reverify_nudge" && /tsc/.test(e.payload.command || "")));
  check("reverify: run finished after the check passed", report.finalReady === true && report.stoppedReason === "model-final-ready", `stop=${report.stoppedReason}`);
  check("reverify: failing command cleared after clean re-run", !report.failingVerifyCommand);
}

// ── 7. Curator: duplicate-instinct merge + applied-instinct freshness ───────
{
  const home = path.join(tmpRoot, "curator-home");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  const loop = new OmniLoop({ agentRuntime: { rootDir: home, config: { getConfig: () => ({}) }, gateway: { addEvent: () => {} } } });
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  loop.saveInstincts([
    { text: "When a python import fails, check the virtualenv before reinstalling packages.", confidence: 0.7, reinforced: 2, lastSeen: old, createdAt: old },
    { text: "When python imports fail, always check the virtualenv before reinstalling any packages.", confidence: 0.5, reinforced: 1, lastSeen: old, createdAt: old },
    { text: "Verify HTML pages in a real browser before declaring them done.", confidence: 0.8, reinforced: 3, lastSeen: new Date().toISOString() },
  ]);
  // Applying a relevant instinct must refresh its lastSeen (keeps it alive).
  loop.buildInstinctsSection("mera python import error fix karo virtualenv problem");
  const afterUse = loop.loadInstincts().find((i) => /python import fails,/.test(i.text));
  check("learning: applied instinct's lastSeen refreshed", afterUse && new Date(afterUse.lastSeen).getTime() > Date.now() - 60000);

  await loop.maybeRunCurator();
  const curated = loop.loadInstincts();
  const pythonLessons = curated.filter((i) => /python/i.test(i.text));
  check("curator: near-duplicate instincts merged into one", pythonLessons.length === 1, `got ${pythonLessons.length}`);
  check("curator: merge concentrated reinforcement", (pythonLessons[0]?.reinforced || 0) >= 3);
  check("curator: unrelated instinct survives", curated.some((i) => /HTML pages/.test(i.text)));
}

// ── 8. Code Map pre-pass (harness pre-searches task identifiers) ────────────
{
  const projRoot = path.join(tmpRoot, "codemap-proj");
  fs.mkdirSync(path.join(projRoot, "src", "game"), { recursive: true });
  fs.writeFileSync(
    path.join(projRoot, "src", "game", "PhoneUI.ts"),
    "export class PhoneUI {\n  isOpen = false;\n  togglePhone() { this.isOpen = !this.isOpen; }\n}\n",
  );
  const loop = new OmniLoop({ agentRuntime: { rootDir: projRoot, config: { getConfig: () => ({}) }, fileStore: new FileStore(projRoot) } });

  const ids = loop.extractTaskIdentifiers("fix the PhoneUI togglePhone bug in src/game/PhoneUI.ts");
  check("codemap: identifiers extracted from task", ids.includes("PhoneUI") && ids.some((i) => /PhoneUI\.ts/.test(i)));

  const section = loop.buildCodeMapSection("fix the PhoneUI togglePhone bug");
  check("codemap: section locates the identifier with file:line", /PhoneUI\.ts:1/.test(section) || /PhoneUI\.ts:\d+/.test(section), section.slice(0, 120));
  check("codemap: prose task yields no section", loop.buildCodeMapSection("hello kaise ho") === "");
}

// ── 9. Focused tool boost (task-relevant tools first, survive the cap) ──────
{
  const loop = new OmniLoop({ agentRuntime: { rootDir: tmpRoot, config: { getConfig: () => ({}) } } });
  const tools = ["update_plan", "read_file", "write_file", "web_search", "exec", "search_text", "browser_open"]
    .map((id) => ({ id, description: id, schema: { type: "object", properties: {} } }));
  const schemas = loop.buildToolSchemas(tools, 4, TYPE_TOOL_BOOSTS["debugging"]);
  const names = schemas.map((s) => s.function.name);
  check("focused-tools: debugging boost puts exec/search_text first", names[0] === "exec" && names.includes("search_text"), names.join(","));
  check("focused-tools: irrelevant tool cut by the cap, relevant kept", !names.includes("web_search") && names.includes("read_file"));
}

// ── 10. Auto plan seeding (harness plans when the model doesn't) ────────────
{
  const events = [];
  const planWrites = [];
  let storedPlan = null;
  let round = 0;
  const runtime = {
    rootDir: tmpRoot,
    config: { getConfig: () => ({}) },
    gateway: { addEvent: (event, payload) => events.push({ event, payload }) },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      complete: async () => ({ text: '[{"title":"Wire the new feature into config","verification":"node --check config.js"},{"title":"Add the feature module","verification":"exec runs it clean"}]' }),
      completeWithTools: async () => {
        round += 1;
        if (round === 1) {
          return { text: "", toolCalls: [
            { id: "a", tool: "read_file", input: { path: "src/a.js" } },
            { id: "b", tool: "read_file", input: { path: "src/b.js" } },
          ] };
        }
        if (round === 2) return { text: "", toolCalls: [{ id: "c", tool: "read_file", input: { path: "src/c.js" } }] };
        if (round === 3) return { text: "", toolCalls: [{ id: "d", tool: "write_file", input: { path: "src/feature.js", content: "//x" } }] };
        if (round === 4) {
          // Model completes the seeded plan.
          return { text: "", toolCalls: [{ id: "e", tool: "update_plan", input: { steps: [
            { title: "Wire the new feature into config", status: "completed", verification: "done" },
            { title: "Add the feature module", status: "completed", verification: "done" },
          ] } }] };
        }
        return { text: "Feature add ho gaya.", toolCalls: [] };
      },
    },
    tools: {
      getRunPlan: () => storedPlan,
      run: async (id, toolInput) => {
        if (id === "update_plan") {
          storedPlan = { steps: toolInput.steps };
          planWrites.push(toolInput);
          return { ok: true, steps: toolInput.steps };
        }
        if (id === "read_file") return { path: toolInput.path, content: "// code", bytesRead: 8 };
        if (id === "write_file") return { path: toolInput.path, bytesWritten: 3 };
        return { ok: true };
      },
    },
  };
  const runtimeSettings = { enabled: true, maxRounds: 7, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false };
  runtime.config.getConfig = () => ({ runtime: { omniLoop: runtimeSettings } });
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "update the config and add the new feature to the project",
    agent: { id: "main", name: "Main" },
    profile: { id: "power" },
    session: { id: "session_seed" },
    run: { id: "run_seed" },
    tools: [
      { id: "read_file", description: "Read", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { id: "write_file", description: "Write", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
      { id: "update_plan", description: "Plan", schema: { type: "object", required: ["steps"], properties: { steps: { type: "array" } } } },
    ],
    contextBundle: {},
  });
  check("plan-seed: harness seeded a plan when model had none", report.autoPlanSeedApplied === true);
  check("plan-seed: seeded steps landed in the plan store", planWrites.length >= 1 && planWrites[0].steps.length === 2 && planWrites[0].steps[0].status === "in_progress");
  check("plan-seed: event emitted", events.some((e) => e.event === "omni_loop.plan_seeded"));
  check("plan-seed: run finished cleanly after plan completed", report.finalReady === true && report.stoppedReason === "model-final-ready", `stop=${report.stoppedReason}`);
}

// ── 11. CodeAct: one script orchestrating many real tool calls ──────────────
{
  const projRoot = path.join(tmpRoot, "codeact-proj");
  fs.mkdirSync(path.join(projRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projRoot, "src", "a.ts"), "// TODO: fix me\nexport const a = 1;\n");
  fs.writeFileSync(path.join(projRoot, "src", "b.ts"), "export const b = 2;\n");
  const registry = makeRegistry(projRoot);

  const output = await registry.run("code_act", {
    script: `
      const res = await tools.search_text({ pattern: 'TODO' });
      const files = [...new Set((res.matches || []).map(m => m.file))];
      for (const f of files) {
        const r = await tools.read_file({ path: f });
        await tools.write_file({ path: f.replace('.ts', '.fixed.ts'), content: r.content.replace('TODO', 'DONE') });
      }
      console.log('processed', files.length);
      return { fixed: files.length };
    `,
  }, { runId: "run_codeact", sessionId: "s", agentId: "main" });

  check("codeact: script ran ok", output?.ok === true, output?.message);
  check("codeact: loop found and fixed the right file", output?.result?.fixed === 1, JSON.stringify(output?.result));
  const fixed = path.join(projRoot, "src", "a.fixed.ts");
  check("codeact: real file written through the tool path", fs.existsSync(fixed) && /DONE/.test(fs.readFileSync(fixed, "utf8")));
  check("codeact: tool calls logged", (output?.toolCallCount || 0) >= 3 && Array.isArray(output?.toolCallsMade));
  check("codeact: console.log captured", (output?.logs || []).some((l) => /processed 1/.test(l)));

  const bad = await registry.run("code_act", { script: "return {" }, { runId: "r2" });
  check("codeact: syntax error reported, not thrown", bad?.error === true && /syntax error/i.test(bad?.message || ""));

  // In-script writes to EXISTING files must be rewindable (polish fix A).
  const edited = await registry.run("code_act", {
    script: "await tools.write_file({ path: 'src/b.ts', content: 'export const b = 999; // clobbered' }); return 'ok';",
  }, { runId: "run_codeact", sessionId: "s", agentId: "main" });
  check("codeact: in-script overwrite ran", edited?.ok === true);
  const restoredB = await registry.run("restore_checkpoint", { path: "src/b.ts" }, { runId: "run_codeact" });
  check("codeact: in-script write was checkpointed and rewound", restoredB?.ok === true && /export const b = 2/.test(fs.readFileSync(path.join(projRoot, "src", "b.ts"), "utf8")), restoredB?.message);
}

// ── 12. Checkpoints: pre-edit snapshot + restore_checkpoint rewind ──────────
{
  const projRoot = path.join(tmpRoot, "checkpoint-proj");
  fs.mkdirSync(projRoot, { recursive: true });
  const target = path.join(projRoot, "app.js");
  fs.writeFileSync(target, "console.log('original');\n");

  const loop = new OmniLoop({ agentRuntime: { rootDir: projRoot, config: { getConfig: () => ({}) } } });
  const report = {};
  loop.saveFileCheckpoint({ tool: "edit", input: { path: target } }, { id: "run_ckpt" }, report);
  check("checkpoint: snapshot saved before edit", report.checkpointsSaved === 1);

  fs.writeFileSync(target, "console.log('BROKEN');\n"); // the bad edit

  const registry = makeRegistry(projRoot);
  const listing = await registry.run("restore_checkpoint", {}, { runId: "run_ckpt" });
  check("checkpoint: listing shows the snapshot", Array.isArray(listing?.checkpoints) && listing.checkpoints.length === 1);

  const restored = await registry.run("restore_checkpoint", { path: target }, { runId: "run_ckpt" });
  check("checkpoint: file rewound to pre-run content", restored?.ok === true && /original/.test(fs.readFileSync(target, "utf8")), restored?.message);
}

// ── 13. Session-start ritual (project state section) ────────────────────────
{
  const projRoot = path.join(tmpRoot, "ritual-proj");
  fs.mkdirSync(projRoot, { recursive: true });
  fs.writeFileSync(path.join(projRoot, "PROGRESS.md"), "# Progress\nDONE: navbar built\nNEXT: wire the cart page\n");
  let priorRuns = [];
  const loop = new OmniLoop({ agentRuntime: {
    rootDir: projRoot,
    config: { getConfig: () => ({}) },
    gateway: { listRuns: () => priorRuns },
  } });
  const section = loop.buildProjectStateSection({ id: "s1" }, { id: "r1" });
  check("ritual: first run gets project state with PROGRESS.md", /session-start ritual/.test(section) && /wire the cart page/.test(section));
  priorRuns = [{ id: "r0", sessionId: "s1" }];
  check("ritual: later runs in the session skip it", loop.buildProjectStateSection({ id: "s1" }, { id: "r1" }) === "");
}

// ── 14. Self-evolving harness: evidence → propose → verify → keep/revert ────
{
  const { HarnessEvolution } = await import("../src/core/harness-evolution.js");
  const home = path.join(tmpRoot, "evolution-home");
  fs.mkdirSync(home, { recursive: true });
  const events = [];
  const evo = new HarnessEvolution({ rootDir: home, gateway: { addEvent: (event, payload) => events.push({ event, payload }) } });

  const okRun = (signals = {}) => ({
    finalReady: true,
    stoppedReason: "model-final-ready",
    failedObservationCount: 0,
    rounds: 5,
    toolCallCount: 6,
    ...Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, v])),
  });

  // Baseline: diagnose nudge firing in ~50% of runs.
  for (let i = 0; i < 15; i += 1) {
    evo.recordRun(okRun(i % 2 === 0 ? { diagnoseNudges: 1 } : {}), { model: "stub", taskType: "debugging" });
  }
  const proposal = evo.maybeEvolve({ cycleMs: 0, minRunsToPropose: 10, minRunsToConclude: 10 });
  check("evolution: experiment proposed from strongest signal", proposal.acted === true && proposal.experiment?.param === "diagnoseGatherRounds", JSON.stringify(proposal));
  check("evolution: tunable moved to trial value", evo.getTunables().diagnoseGatherRounds === 1);
  check("evolution: prediction recorded (falsifiable contract)", /diagnoseNudges/.test(proposal.experiment?.prediction || ""));
  check("evolution: start event emitted", events.some((e) => e.event === "evolution.experiment_started"));

  const early = evo.maybeEvolve({ cycleMs: 0, minRunsToConclude: 10 });
  check("evolution: experiment not judged early", early.acted === false && /still-running/.test(early.reason));

  // Post-change runs: signal gone → prediction held.
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < 12; i += 1) evo.recordRun(okRun({}), { model: "stub", taskType: "debugging" });
  const concluded = evo.maybeEvolve({ cycleMs: 0, minRunsToConclude: 10 });
  check("evolution: improved experiment KEPT", concluded.acted === true && concluded.action === "kept", JSON.stringify(concluded));
  check("evolution: kept tunable persists", evo.getTunables().diagnoseGatherRounds === 1);

  // Second experiment: spin signal, but post-change runs DON'T improve → revert.
  for (let i = 0; i < 15; i += 1) evo.recordRun(okRun({ spinNudges: 1 }), { model: "stub", taskType: "debugging" });
  const proposal2 = evo.maybeEvolve({ cycleMs: 0, minRunsToPropose: 10 });
  check("evolution: second experiment targets spin threshold", proposal2.acted === true && proposal2.experiment?.param === "spinNudgeThreshold", JSON.stringify(proposal2));
  await new Promise((r) => setTimeout(r, 15));
  for (let i = 0; i < 12; i += 1) evo.recordRun(okRun({ spinNudges: 1 }), { model: "stub", taskType: "debugging" });
  const concluded2 = evo.maybeEvolve({ cycleMs: 0, minRunsToConclude: 10 });
  check("evolution: failed prediction REVERTED", concluded2.acted === true && concluded2.action === "reverted", JSON.stringify(concluded2));
  check("evolution: reverted tunable restored", evo.getTunables().spinNudgeThreshold === 4);
  check("evolution: history records both outcomes", (evo.status().history || []).map((h) => h.outcome).join(",") === "kept,reverted");

  // Live integration: an evolved diagnoseGatherRounds=1 makes the diagnose
  // guard fire after ONE gathering round instead of two.
  let round = 0;
  const runtime = {
    rootDir: null, // no real evolution store — we inject a stub below
    config: { getConfig: () => ({ runtime: { omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false } } }) },
    gateway: { addEvent: () => {} },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      complete: async () => ({ text: "summary" }),
      completeWithTools: async (messages) => {
        round += 1;
        const diagnoseMsg = messages.find((m) => m.role === "user" && /\[Diagnose first\]/.test(String(m.content || "")));
        if (round === 1) {
          if (diagnoseMsg) throw new Error("nudge before any round");
          return { text: "", toolCalls: [{ id: "r1", tool: "read_file", input: { path: "src/x.ts" } }] };
        }
        if (round === 2) {
          if (!diagnoseMsg) throw new Error("evolved threshold 1 did not fire after one gathering round");
          return { text: "", toolCalls: [{ id: "r2", tool: "exec", input: { command: "npx tsc --noEmit" } }] };
        }
        return { text: "done", toolCalls: [] };
      },
    },
    tools: { run: async (id, toolInput) => id === "exec"
      ? { command: toolInput.command, status: "completed", exitCode: 0 }
      : { path: toolInput.path, content: "x", bytesRead: 1 } },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  loop.evolution = { getTunables: () => ({ diagnoseGatherRounds: 1, spinNudgeThreshold: 4, editFailSwitchAt: 2 }), recordRun: () => {}, maybeEvolve: () => {} };
  const { report } = await loop.run({
    message: "fix the TypeScript errors",
    agent: { id: "main" }, profile: {}, session: { id: "s_evo" }, run: { id: "r_evo" },
    tools: [
      { id: "read_file", description: "Read", schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
      { id: "exec", description: "Run", schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
    ],
    contextBundle: {},
  });
  check("evolution: evolved tunable steers the live loop", report.diagnoseNudges === 1 && report.finalReady === true, `nudges=${report.diagnoseNudges} stop=${report.stoppedReason}`);
}

// ── 15. Microcompact: older duplicate reads superseded, windows preserved ───
{
  const loop = new OmniLoop({ agentRuntime: { rootDir: tmpRoot, config: { getConfig: () => ({}) } } });
  const bigRead = `✅ read OK\n${"x".repeat(600)}`;
  const mkRead = (id, args) => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify(args) } }] });
  const mkResult = (id) => ({ role: "tool", tool_call_id: id, content: bigRead });
  const messages = [
    { role: "system", content: "sys" },
    mkRead("c1", { path: "src/app.ts" }), mkResult("c1"),          // full read (older) → supersede
    mkRead("c2", { path: "src/app.ts", offset: 10, limit: 50 }), mkResult("c2"), // window → keep
    mkRead("c3", { path: "src/app.ts" }), mkResult("c3"),          // full read (newest) → keep
    ...Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `filler ${i}` })),
  ];
  const superseded = loop.microcompactTranscript(messages);
  check("microcompact: older duplicate full read superseded", superseded === 1 && /superseded read/.test(messages[2].content), `count=${superseded}`);
  check("microcompact: window read preserved (different content)", messages[4].content === bigRead);
  check("microcompact: newest full read preserved", messages[6].content === bigRead);
}

// ── 16. Structured diagnostics + error budget ───────────────────────────────
{
  const loop = new OmniLoop({ agentRuntime: { rootDir: tmpRoot, config: { getConfig: () => ({}) } } });
  const tscOut = [
    "src/core/Game.ts(42,13): error TS2339: Property 'isOpen' does not exist on type 'PhoneUI'.",
    "src/core/Game.ts:97:5 - error TS2554: Expected 2 arguments, but got 1.",
    "src/ui/HUD.ts(12,1): error TS1005: ';' expected.",
  ].join("\n");
  const parsed = loop.parseDiagnostics(tscOut);
  check("diagnostics: tsc errors parsed (both styles)", parsed.length === 3 && parsed[0].file === "src/core/Game.ts" && parsed[0].line === 42, JSON.stringify(parsed[0] || {}));

  const report = {};
  const call = { tool: "exec", input: { command: "npx tsc --noEmit" } };
  const out1 = { status: "failed", exitCode: 2, stderr: "", stdout: tscOut };
  loop.attachStructuredDiagnostics(call, out1, report);
  check("diagnostics: structured list attached on failure", out1.diagnostics?.errorCount === 3 && out1.diagnostics.items.length === 3);

  const out2 = { status: "failed", exitCode: 2, stdout: "src/ui/HUD.ts(12,1): error TS1005: ';' expected." };
  loop.attachStructuredDiagnostics(call, out2, report);
  check("diagnostics: error budget shows progress", /3 → 1/.test(out2.errorProgress || "") && /2 fixed/.test(out2.errorProgress || ""), out2.errorProgress);

  const out3 = { status: "completed", exitCode: 0, stdout: "" };
  loop.attachStructuredDiagnostics(call, out3, report);
  check("diagnostics: clean pass closes the budget", /1 → 0/.test(out3.errorProgress || "") && report.errorBudget["npx tsc --noemit"] === 0, out3.errorProgress);

  // run_terminal_command nests results under output.execution (polish fix D).
  const nested = { execution: { status: "failed", exitCode: 2, stdout: tscOut, command: "npx tsc --noEmit" } };
  loop.attachStructuredDiagnostics({ tool: "run_terminal_command", input: { command: "npx tsc --noEmit" } }, nested, {});
  check("diagnostics: nested execution shape parsed", nested.diagnostics?.errorCount === 3);
}

// ── 17. Best-of-N: parallel candidates, scoring, winner copied ──────────────
{
  const projRoot = path.join(tmpRoot, "bon-proj");
  fs.mkdirSync(projRoot, { recursive: true });
  // Stub spawner: candidate-1 builds a real page, candidate-2 produces nothing.
  const spawner = {
    spawn: async ({ task }) => {
      const m = task.match(/"([^"]*candidate-\d+)"/);
      const dir = m ? path.join(projRoot, m[1]) : null;
      if (dir && /candidate-1/.test(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><body><button>Go</button><script>console.log(1)</script>${"x".repeat(600)}</body></html>`);
      }
      return { status: "completed", summary: "built" };
    },
  };
  const registry = makeRegistry(projRoot, { subAgentSpawner: spawner });
  const result = await registry.run("best_of_n", {
    task: "Build a landing page",
    outputDir: "bon",
    entryFile: "index.html",
    n: 2,
  }, { runId: "r_bon", agentId: "main" });
  check("best-of-n: ran and picked a winner", result?.ok === true && result.winner === "bon/candidate-1", result?.message);
  check("best-of-n: winner copied to best/", fs.existsSync(path.join(projRoot, "bon", "best", "index.html")));
  check("best-of-n: per-candidate scores reported", Array.isArray(result?.candidates) && result.candidates.length === 2 && result.candidates[0].points > result.candidates[1].points);

  const guard = await registry.run("best_of_n", { task: "x", outputDir: "../evil", entryFile: "a.html" }, {});
  check("best-of-n: path traversal rejected", guard?.error === true && /relative/.test(guard?.message || ""));
}

// ── 18. Silent-finish + transcript-echo guards (the screenshot-reply bug) ───
{
  // Case A: tool runs, model finishes EMPTY, observation nudge gets a real
  // answer out of it on the retry.
  let round = 0;
  const makeRuntime18 = (script) => ({
    rootDir: tmpRoot,
    config: { getConfig: () => ({ runtime: { omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false } } }) },
    gateway: { addEvent: () => {} },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      complete: async (messages) => script.onComplete ? script.onComplete(messages) : { text: "summary" },
      completeWithTools: async (messages, input) => script.onRound(++round, messages, input),
    },
    tools: { run: async (id, toolInput) => ({ screenshotRelPath: "screenshots/page.png", url: "file:///site/index.html", ok: true }) },
  });
  const tools18 = [{ id: "browser_screenshot", description: "Shot", schema: { type: "object", properties: { fullPage: { type: "boolean" } } } }];

  const runtimeA = makeRuntime18({
    onRound: (r, messages) => {
      if (r === 1) return { text: "", toolCalls: [{ id: "s1", tool: "browser_screenshot", input: { fullPage: true } }] };
      if (r === 2) return { text: "", toolCalls: [] }; // silent finish attempt
      const nudged = messages.some((m) => m.role === "user" && /\[Observation check\]/.test(String(m.content || "")));
      if (!nudged) throw new Error("observation nudge missing");
      return { text: "Screenshot le liya — screenshots/page.png me saved hai, layout theek dikh raha hai.", toolCalls: [] };
    },
  });
  const loopA = new OmniLoop({ agentRuntime: runtimeA });
  const resA = await loopA.run({ message: "dubara dakho screenshot", agent: { id: "main" }, profile: {}, session: { id: "s18a" }, run: { id: "r18a" }, tools: tools18, contextBundle: {} });
  check("silent-finish: observation nudge produced a real answer", resA.report.finalReady && /page\.png/.test(resA.report.finalAnswer), resA.report.finalAnswer.slice(0, 80));
  check("silent-finish: nudge counted once", resA.report.observationNudges === 1);

  // Case B: model stays empty AND the summary attempts echo transcript
  // plumbing — echo is REJECTED and the deterministic fallback names the
  // screenshot path instead.
  round = 0;
  const runtimeB = makeRuntime18({
    onRound: (r) => {
      if (r === 1) return { text: "", toolCalls: [{ id: "s1", tool: "browser_screenshot", input: { fullPage: true } }] };
      return { text: "", toolCalls: [] }; // empty even after the nudge
    },
    onComplete: () => ({ text: '[called tools: browser_screenshot({"fullPage":true})]' }), // parrot
  });
  // completeWithTools summary attempt also parrots:
  const origOnRound = runtimeB.provider.completeWithTools;
  runtimeB.provider.completeWithTools = async (messages, input) => {
    if (input?.toolChoice === "none") return { text: '[called tools: browser_screenshot({"fullPage":true})]' };
    return origOnRound(messages, input);
  };
  const loopB = new OmniLoop({ agentRuntime: runtimeB });
  const resB = await loopB.run({ message: "dubara dakho screenshot", agent: { id: "main" }, profile: {}, session: { id: "s18b" }, run: { id: "r18b" }, tools: tools18, contextBundle: {} });
  check("echo-guard: parroted transcript plumbing rejected", (resB.report.echoAnswersRejected || 0) >= 1, `rejected=${resB.report.echoAnswersRejected}`);
  check("echo-guard: user never sees '[called tools:' as the reply", !/^\[called tools/i.test(resB.report.finalAnswer || ""), resB.report.finalAnswer.slice(0, 80));
  check("echo-guard: fallback names the screenshot path", /screenshots\/page\.png/.test(resB.report.finalAnswer || ""), resB.report.finalAnswer.slice(0, 120));
}

// ── 19. Session continuity: plan inheritance + continue directive ───────────
{
  check("continuity: continue intent detected (English)", isContinueIntent("continue"));
  check("continuity: continue intent detected (Hinglish)", isContinueIntent("kya hua continue") && isContinueIntent("aage badho wahi se"));
  check("continuity: normal task NOT flagged as continue", !isContinueIntent("ek naya portfolio website banao jisme dark mode ho"));

  // Registry: update_plan persists per-session; a different run can read it.
  {
    const projRoot = path.join(tmpRoot, "continuity-proj");
    fs.mkdirSync(projRoot, { recursive: true });
    const registry = makeRegistry(projRoot);
    await registry.run("update_plan", { steps: [
      { title: "Build navbar", status: "completed", verification: "done" },
      { title: "Build cart page", status: "in_progress", verification: "browser check" },
      { title: "Wire checkout", status: "pending", verification: "browser check" },
    ] }, { runId: "run_old_model", sessionId: "sess_switch", agentId: "main" });
    const sessionPlan = registry.getSessionPlan("sess_switch");
    check("continuity: session plan persisted by update_plan", sessionPlan?.steps?.length === 3);
    registry.setRunPlan("run_new_model", sessionPlan);
    check("continuity: new run seeded via setRunPlan", registry.getRunPlan("run_new_model")?.steps?.[1]?.title === "Build cart page");
  }

  // Loop integration: new run (new model) inherits the unfinished plan and
  // gets the continuation directive; round 1 already shows the open steps.
  {
    let round = 0;
    let storedRunPlan = null;
    const sessionPlan = { steps: [
      { title: "Build navbar", status: "completed", verification: "done" },
      { title: "Build cart page", status: "in_progress", verification: "browser check" },
    ], note: "", updatedAt: new Date().toISOString() };
    const runtime = {
      rootDir: tmpRoot,
      config: { getConfig: () => ({ runtime: { omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false } } }) },
      gateway: { addEvent: () => {}, listRuns: () => [] },
      sessions: { getSession: () => ({ transcript: [] }) },
      provider: {
        getInfo: () => ({ id: "stub-new-model", ready: true }),
        complete: async () => ({ text: "summary" }),
        completeWithTools: async (messages) => {
          round += 1;
          if (round === 1) {
            const sys = String(messages[0]?.content || "");
            if (!/Continuation Directive/.test(sys)) throw new Error("continuation directive missing from system prompt");
            const reminder = messages.find((m) => m.role === "user" && /Current plan/.test(String(m.content || "")));
            if (!reminder || !/Build cart page/.test(String(reminder.content))) throw new Error("inherited plan not re-shown in round 1");
            return { text: "", toolCalls: [{ id: "p1", tool: "update_plan", input: { steps: [
              { title: "Build navbar", status: "completed", verification: "done" },
              { title: "Build cart page", status: "completed", verification: "done" },
            ] } }] };
          }
          return { text: "Cart page complete — wahi se continue kiya jahan pichhla model ruka tha.", toolCalls: [] };
        },
      },
      tools: {
        getRunPlan: () => storedRunPlan,
        getSessionPlan: (sid) => (sid === "sess_switch2" ? sessionPlan : null),
        setRunPlan: (rid, plan) => { storedRunPlan = plan; },
        run: async (id, toolInput) => {
          if (id === "update_plan") { storedRunPlan = { steps: toolInput.steps }; return { ok: true, steps: toolInput.steps }; }
          return { ok: true };
        },
      },
    };
    const loop = new OmniLoop({ agentRuntime: runtime });
    const { report } = await loop.run({
      message: "continue",
      agent: { id: "main" }, profile: {}, session: { id: "sess_switch2" }, run: { id: "run_new" },
      tools: [{ id: "update_plan", description: "Plan", schema: { type: "object", required: ["steps"], properties: { steps: { type: "array" } } } }],
      contextBundle: {},
    });
    check("continuity: unfinished plan inherited into the new run", report.planInherited === 1, `inherited=${report.planInherited}`);
    check("continuity: new model resumed and finished cleanly", report.finalReady === true && /continue kiya/.test(report.finalAnswer), `stop=${report.stoppedReason}`);
  }
}

// ── 20. Claude Code-style memory: file-per-fact + MEMORY.md index ───────────
{
  const home = path.join(tmpRoot, "structured-mem");
  fs.mkdirSync(home, { recursive: true });
  const store = new MemoryStore(home);
  const first = store.promoteMemory({
    agentId: "main",
    title: "Package manager preference",
    text: "User prefers pnpm over npm for all JS projects.",
    sourceType: "auto_capture",
    sourceId: "t1",
    tags: ["user-fact"],
  });
  check("structured-memory: promote created a per-fact file", first.created === true);
  const factFile = path.join(home, "workspace", "agents", "main", "memory", "package-manager-preference.md");
  check("structured-memory: slug file exists with frontmatter", fs.existsSync(factFile) && /^---\nname: package-manager-preference/.test(fs.readFileSync(factFile, "utf8")));
  check("structured-memory: type derived (user fact)", /type: user/.test(fs.readFileSync(factFile, "utf8")));
  const indexText = fs.readFileSync(path.join(home, "workspace", "agents", "main", "MEMORY.md"), "utf8");
  check("structured-memory: MEMORY.md index line added", /- \[Package manager preference\]\(memory\/package-manager-preference\.md\) — /.test(indexText));

  // Same title again (different sourceId) → file UPDATED, index still ONE line.
  store.promoteMemory({ agentId: "main", title: "Package manager preference", text: "User prefers pnpm; bun acceptable for scripts.", sourceType: "memory_write", sourceId: "t2", tags: [] });
  const index2 = fs.readFileSync(path.join(home, "workspace", "agents", "main", "MEMORY.md"), "utf8");
  const lineCount = (index2.match(/package-manager-preference\.md/g) || []).length;
  check("structured-memory: re-save updates in place (no duplicate index line)", lineCount === 1, `lines=${lineCount}`);
  check("structured-memory: file content updated", /bun acceptable/.test(fs.readFileSync(factFile, "utf8")));
  check("structured-memory: readMemoryIndex returns the index", /Package manager preference/.test(store.readMemoryIndex("main")));

  // The loop injects the index into the memory brief.
  const loop = new OmniLoop({ agentRuntime: { rootDir: home, config: { getConfig: () => ({}) }, memory: store } });
  const brief = loop.buildMemoryBriefSection({}, { message: "koi bhi task", agent: { id: "main" } });
  check("structured-memory: index injected into memory brief", /Memory index/.test(brief) && /package-manager-preference\.md/.test(brief));
}

// ── 21. Auto PROGRESS.md + transient-404 retry ──────────────────────────────
{
  const home = path.join(tmpRoot, "autoprogress");
  fs.mkdirSync(home, { recursive: true });
  let round = 0;
  let failed404Once = false;
  const runtime = {
    rootDir: home,
    config: { getConfig: () => ({ runtime: { omniLoop: { enabled: true, maxRounds: 5, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 1, streaming: false } } }) },
    gateway: { addEvent: () => {}, listRuns: () => [] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", model: "glm-5.2", ready: true }),
      complete: async () => ({ text: "summary" }),
      completeWithTools: async () => {
        round += 1;
        if (round === 1) return { text: "", toolCalls: [{ id: "w1", tool: "write_file", input: { path: "site/index.html", content: "<!doctype html><html><body>x</body></html>" } }] };
        if (round === 2 && !failed404Once) {
          // Mid-run transient 404 from a flaky gateway — same model already
          // answered round 1, so the loop must RETRY, not die.
          failed404Once = true;
          round -= 1; // the retry re-enters with the same logical round
          const err = new Error("Provider native tool request failed with status 404");
          err.status = 404;
          throw err;
        }
        return { text: "Site ban gaya — site/index.html ready.", toolCalls: [] };
      },
    },
    tools: { run: async (id, toolInput) => ({ path: toolInput.path, bytesWritten: 40 }) },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "ek site banao",
    agent: { id: "main" }, profile: {}, session: { id: "s21" }, run: { id: "r21" },
    tools: [{ id: "write_file", description: "Write", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } }],
    contextBundle: {},
  });
  check("transient-404: retried instead of dying", report.finalReady === true && report.stoppedReason === "model-final-ready", `stop=${report.stoppedReason}`);
  check("auto-progress: harness wrote PROGRESS.md", report.autoProgressWritten === true && fs.existsSync(path.join(home, "PROGRESS.md")));
  const progress = fs.readFileSync(path.join(home, "PROGRESS.md"), "utf8");
  check("auto-progress: entry names the work and outcome", /site\/index\.html/.test(progress) && /Outcome: model-final-ready/.test(progress));
  check("auto-progress: newest-first log section present", /## Auto Work Log/.test(progress));

  // Second run prepends (newest first).
  round = 0; failed404Once = true;
  await loop.run({
    message: "dusra kaam karo",
    agent: { id: "main" }, profile: {}, session: { id: "s21b" }, run: { id: "r21b" },
    tools: [{ id: "write_file", description: "Write", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } }],
    contextBundle: {},
  });
  const progress2 = fs.readFileSync(path.join(home, "PROGRESS.md"), "utf8");
  check("auto-progress: newest entry first", progress2.indexOf("dusra kaam") < progress2.indexOf("ek site banao") && progress2.indexOf("dusra kaam") !== -1);
}

// ── 22. Claude Code parity: debugging protocol + regression-test discipline ─
{
  const home = path.join(tmpRoot, "regression-proj");
  fs.mkdirSync(path.join(home, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node scripts/smoke.mjs" } }));

  let round = 0;
  let execCount = 0;
  const runtime = {
    rootDir: home,
    config: { getConfig: () => ({ runtime: { omniLoop: { enabled: true, maxRounds: 8, maxTokens: 1000, roundTimeoutMs: 5000, historyMessages: 0, providerRetries: 0, streaming: false } } }) },
    gateway: { addEvent: () => {}, listRuns: () => [{ id: "r0", sessionId: "s22" }] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true }),
      complete: async () => ({ text: "summary" }),
      completeWithTools: async (messages) => {
        round += 1;
        if (round === 1) {
          if (!/Debugging Protocol/.test(String(messages[0]?.content || ""))) throw new Error("debugging protocol missing for error-fix task");
          return { text: "", toolCalls: [{ id: "e1", tool: "exec", input: { command: "npm test" } }] };
        }
        if (round === 2) return { text: "", toolCalls: [{ id: "w1", tool: "write_file", input: { path: "src/fix.js", content: "//fix" } }] };
        if (round === 3) return { text: "", toolCalls: [{ id: "e2", tool: "exec", input: { command: "npm test" } }] };
        if (round === 4) {
          // Tries to finish right after the fix — regression gate must fire.
          return { text: "Bug fix ho gaya!", toolCalls: [] };
        }
        if (round === 5) {
          const nudge = messages.find((m) => m.role === "user" && /\[Regression-proof\]/.test(String(m.content || "")));
          if (!nudge) throw new Error("regression nudge missing");
          return { text: "", toolCalls: [{ id: "w2", tool: "write_file", input: { path: "scripts/regression.mjs", content: "// test" } }] };
        }
        return { text: "Fix + regression test dono done.", toolCalls: [] };
      },
    },
    tools: {
      run: async (id, toolInput) => {
        if (id === "exec") {
          execCount += 1;
          return execCount === 1
            ? { command: toolInput.command, status: "failed", exitCode: 1, stdout: "src/fix.js:3:1 - error TS0000: broken thing" }
            : { command: toolInput.command, status: "completed", exitCode: 0, stdout: "" };
        }
        return { path: toolInput.path, bytesWritten: 5 };
      },
    },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "fix the failing test error in the project",
    agent: { id: "main" }, profile: {}, session: { id: "s22" }, run: { id: "r22" },
    tools: [
      { id: "exec", description: "Run", schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } },
      { id: "write_file", description: "Write", schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
    ],
    contextBundle: {},
  });
  check("regression: nudge fired once after fix went green", report.regressionNudges === 1);
  check("regression: run finished after adding the test", report.finalReady === true && /regression test dono done/.test(report.finalAnswer), `stop=${report.stoppedReason}`);

  // Protocol section only appears for error-fix tasks.
  const sys = loop.buildDebuggingProtocolSection("ek website banao");
  check("protocol: not injected for non-error tasks", sys === "");
  check("protocol: test setup detection works", loop.projectHasTestSetup() === true);
}

// ── 23. search_text: file paths + slash-wrapped patterns (VehicleController bug)
{
  const home = path.join(tmpRoot, "search-proj");
  fs.mkdirSync(path.join(home, "src", "vehicles"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "src", "vehicles", "VehicleController.ts"),
    "export class VehicleController {\n  spawnVehicle(type: string) {}\n  enterNearestVehicle() {}\n  exitVehicle() {}\n}\n",
  );
  const store = new FileStore(home);

  const onFile = store.searchText("spawnVehicle|enterNearestVehicle|exitVehicle", { path: "src/vehicles/VehicleController.ts" });
  check("search-file: FILE path scans that file directly", onFile.ok === true && onFile.matchCount === 3, `count=${onFile.matchCount}`);

  const slashWrapped = store.searchText("/spawnVehicle|enterNearestVehicle|exitVehicle/", { path: "src/vehicles/VehicleController.ts" });
  check("search-file: /slash-wrapped/ pattern unwrapped", slashWrapped.ok === true && slashWrapped.matchCount === 3, `count=${slashWrapped.matchCount}`);

  const slashFlag = store.searchText("/SPAWNVEHICLE/i", { path: "src/vehicles/VehicleController.ts" });
  check("search-file: /pattern/i flag honored", slashFlag.ok === true && slashFlag.matchCount === 1);

  const dirMode = store.searchText("spawnVehicle", { path: "src" });
  check("search-file: directory mode still works", dirMode.ok === true && dirMode.matchCount === 1 && /VehicleController\.ts/.test(dirMode.matches[0].file));

  const missing = store.searchText("x", { path: "src/nahi-hai.ts" });
  check("search-file: missing path returns a clear error (not 0 matches)", missing.ok === false && /not found/i.test(missing.error || ""));

  const division = store.searchText("a/b", { path: "src" });
  check("search-file: plain pattern containing / untouched", division.ok === true, division.error);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nHERMES-PARITY SMOKE: FAILED (${failures})`);
  process.exit(1);
}
console.log("\nHERMES-PARITY SMOKE: PASSED");
