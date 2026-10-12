// Output-cap regression guard: per-tool model-facing budgets, source caps,
// actionable hints, alias budget inheritance. No network, no model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  toolResultBudget, normalizeToolResultBudgets, DEFAULT_TOOL_RESULT_BUDGETS,
  formatToolResultForModel,
} from "../src/core/omni-loop.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { FileStore } from "../src/core/file-store.js";

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`  FAIL ${msg}`); process.exitCode = 1; return; }
  passed += 1;
  console.log(`  ok   ${msg}`);
}

// A. budget mapping (+ alias inheritance + clamping + override)
{
  const s = { toolResultBudgets: normalizeToolResultBudgets(undefined), readResultChars: 30000, maxToolResultChars: 10000 };
  ok(toolResultBudget("read_file", s) === 8000, "read_file 8000");
  ok(toolResultBudget("read", s) === 8000, "alias read inherits 8000");
  ok(toolResultBudget("read_computer_file", s) === 8000, "read_computer_file 8000");
  ok(toolResultBudget("exec", s) === 4000, "exec 4000");
  ok(toolResultBudget("run_terminal_command", s) === 4000, "run_terminal_command 4000");
  ok(toolResultBudget("search_text", s) === 4000, "search_text 4000");
  ok(toolResultBudget("memory_search", s) === 4000, "memory_search 4000");
  ok(toolResultBudget("memory_recall", s) === 4000, "alias memory_recall inherits 4000");
  ok(toolResultBudget("web_research", s) === 6000, "web_research 6000");
  ok(toolResultBudget("web_extract", s) === 6000, "alias web_extract inherits 6000");
  ok(toolResultBudget("list_files", s) === 3000, "list_files 3000");
  ok(toolResultBudget("git_status", s) === 3000, "git_status 3000");
  ok(toolResultBudget("something_new", s) === 4000, "unknown tool gets default 4000");
  const custom = normalizeToolResultBudgets({ exec: 9000, read_file: 5, bogus: "x" });
  ok(custom.exec === 9000 && custom.read_file === 500 && custom.default === 4000, "override + clamp 500..60000 + bad values ignored");
  ok(DEFAULT_TOOL_RESULT_BUDGETS.default === 4000 && Math.max(...Object.values(DEFAULT_TOOL_RESULT_BUDGETS)) <= 8000, "no default above 8000");
}

// B. model-facing truncation with actionable hints
{
  const big = { path: "src/big.js", content: "x".repeat(30000) + "\nline400\n" + "y".repeat(20000), totalBytes: 50001 };
  const meta = {};
  const out = formatToolResultForModel(big, 8000, "read_file", null, meta);
  ok(out.length <= 8000, `read 50k obj -> <=8000 (got ${out.length})`);
  ok(/read_file path=/.test(out) && /offset=/.test(out), "read hint names offset continuation");
  ok(meta.truncated === true, "meta.truncated set");

  const execOut = { exitCode: 0, command: "npm run build", stdout: "a".repeat(15000), stderr: "e".repeat(3000) };
  const eout = formatToolResultForModel(execOut, 4000, "exec", null, {});
  ok(eout.length <= 4000, `exec 18k -> <=4000 (got ${eout.length})`);
  ok(/Re-run writing stdout to a file/.test(eout), "exec hint is actionable");

  const mem = { query: "q", count: 15, results: Array.from({ length: 15 }, (_, i) => ({ id: "m" + i, title: "t" + i, preview: "p".repeat(5000) })) };
  const mout = formatToolResultForModel(mem, 4000, "memory_search", null, {});
  ok(mout.length <= 4000, `memory 75k -> <=4000 (got ${mout.length})`);
  ok(/memory_get/.test(mout), "memory hint names memory_get");

  const st = { branch: "main", staged: Array.from({ length: 200 }, (_, i) => ({ file: `f${i}.js`, code: "M" })), unstaged: [], untracked: [], clean: false };
  const gout = formatToolResultForModel(st, 3000, "git_status", null, {});
  ok(gout.length <= 3000, `git 200-file object -> <=3000 (got ${gout.length})`);
  ok(/git_diff/.test(gout), "git hint names git_diff");

  const small = { path: "a.txt", content: "hi" };
  const sout = formatToolResultForModel(small, 8000, "read_file", null, {});
  ok(sout.includes("hi") && !/truncated/.test(sout), "small results pass through untouched");
}

// C. source caps via stubbed registry runs
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-cap-"));
{
  // 1000-line file for the windowed-read default
  fs.writeFileSync(path.join(tmpRoot, "big.txt"), Array.from({ length: 1000 }, (_, i) => `line ${i + 1} padding padding`).join("\n"));
  fs.mkdirSync(path.join(tmpRoot, "many"));
  for (let i = 0; i < 350; i += 1) fs.writeFileSync(path.join(tmpRoot, "many", `f${i}.txt`), "x");
  const shellStub = {
    execute: async ({ command }) => {
      if (String(command).startsWith("git status")) {
        const rows = ["## main...origin/main"];
        for (let i = 0; i < 200; i += 1) rows.push(` M file${i}.js`);
        return { status: "completed", exitCode: 0, stdout: rows.join("\n") };
      }
      return { status: "completed", exitCode: 0, stdout: "" };
    },
  };
  const reg = new ToolRegistry({
    configStore: {
      getConfig: () => ({
        tools: {
          menuV2: true,
          permissions: {
            allowNoteWrite: true, allowMemoryPromotion: true, allowDreamSweep: true,
            allowFileRead: true, allowDirectoryList: true, allowFileWrite: true,
            allowShellPlanning: true, allowShellExecution: true, allowMemoryRead: true,
          },
          filesystem: { maxReadBytes: 65536, writableRoots: [tmpRoot] },
          computerAccess: { maxReadBytes: 131072 },
          shellExecution: {},
        },
      }),
    },
    fileStore: new FileStore(tmpRoot),
    shellExecutor: shellStub,
    memoryStore: {
      hybridSearch: async () => ({
        query: "q", scope: "all", mode: "keyword",
        results: Array.from({ length: 15 }, (_, i) => ({ layer: "longTerm", id: "m" + i, title: "t".repeat(50), text: "b".repeat(5000), item: { id: "m" + i, text: "b".repeat(5000) } })),
        count: 15, layers: {},
      }),
      getLongTermMemory: () => [],
    },
    pluginRegistry: { getToolDefinitions: () => [] },
    agentRegistry: null, customizationEngine: null,
  });
  const ctx = { agentId: "main", sessionId: "s", runId: "r" };

  const r1 = await reg.run("read_file", { path: "big.txt" }, ctx);
  ok(r1.lineWindow && r1.lineWindow.startLine === 1 && r1.lineWindow.endLine === 400, `bare read defaults to first-400 window (got ${r1.lineWindow?.startLine}-${r1.lineWindow?.endLine} of ${r1.totalLines})`);
  const r2 = await reg.run("read_file", { path: "big.txt", offset: 401, limit: 100 }, ctx);
  ok(r2.lineWindow?.startLine === 401 && r2.lineWindow?.endLine === 500, "explicit offset window works (pagination)");

  const mem = await reg.run("memory_search", { query: "q" }, ctx);
  const memChars = JSON.stringify(mem).length;
  ok(memChars <= 5000, `memory_search source-capped <=5000 (got ${memChars})`);
  ok(!JSON.stringify(mem).includes('"item"'), "full memory bodies dropped from source output");

  const gs = await reg.run("git_status", {}, ctx);
  const gsChars = JSON.stringify(gs).length;
  ok(gsChars <= 5000, `git_status 200-file repo <=5000 (got ${gsChars})`);
  ok(gs.omittedFiles === 200 - 40 && gs.unstaged.length === 40, `git_status caps 40/category with +N (omitted=${gs.omittedFiles})`);

  const lf = await reg.run("list_files", { path: "many" }, ctx);
  ok(lf.entries.length === 200 && lf.omittedEntries === 150, "list_files source caps 200 +N");
  // Model-facing (what the round actually sends) is bounded by the 3000 budget:
  const lfModel = formatToolResultForModel(lf, 3000, "list_files", null, {});
  ok(lfModel.length <= 3000, `list_files model-facing <=3000 (got ${lfModel.length})`);
  const memModel = formatToolResultForModel(mem, 4000, "memory_search", null, {});
  ok(memModel.length <= 4000, `memory_search model-facing <=4000 (got ${memModel.length})`);
  const gsModel = formatToolResultForModel(gs, 3000, "git_status", null, {});
  ok(gsModel.length <= 3000, `git_status model-facing <=3000 (got ${gsModel.length})`);
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\noutput-cap: ${passed} passed${process.exitCode ? " WITH FAILURES" : " ALL PASS"}`);
process.exit(process.exitCode || 0);
