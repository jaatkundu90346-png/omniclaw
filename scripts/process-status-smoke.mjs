// Smoke test: process_status/process_kill self-healing (iteration 3).
// Real-run failure: models lose/misremember the background processId and got a
// dead-end "Process not found". Now: auto-resolve to the most recent process,
// list alternatives, and give actionable hints on empty registries.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { ShellExecutor } = await import(pathToFileURL(path.join(ROOT, "src/core/shell-executor.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 220)}`}`);
  if (!ok) failures += 1;
};

const configStore = {
  getConfig: () => ({
    tools: { permissions: { allowShellExecution: true }, shellExecution: { allowlistMode: "advisory" } },
  }),
};
const executor = new ShellExecutor({ rootDir: ROOT, configStore, eventBus: null });

// ── Empty registry: actionable errors, no auto-resolve possible ──────────────
let status = executor.getProcessStatus("proc_never_existed");
check("empty registry: error kept", status.error === "Process not found", JSON.stringify(status));
check("empty registry: hint says how to start one", /exec \{background: true\}/.test(String(status.hint)), status.hint);

let kill = executor.killProcess("proc_never_existed");
check("empty registry kill: 'nothing running' hint", /No background processes/.test(String(kill.hint)), JSON.stringify(kill));

// ── Start a real background process ─────────────────────────────────────────
const started = await executor.execute({ command: "Start-Sleep -Seconds 8", background: true });
const realId = started.processId || started.id;
check("background process started", Boolean(realId), JSON.stringify(started).slice(0, 200));

// Omitted id → auto-resolves to the most recent process.
status = executor.getProcessStatus("");
check("no id: auto-resolved to newest", status.id === realId, JSON.stringify({ got: status.id, want: realId }));
check("no id: note explains resolution", /No processId given/.test(String(status.note)), status.note);

// Wrong id → auto-resolves + tells the model the right id going forward.
status = executor.getProcessStatus("proc_wrong123");
check("wrong id: auto-resolved to newest", status.id === realId, JSON.stringify({ got: status.id }));
check("wrong id: note names the real id", String(status.note).includes(realId), status.note);

// Exact id → clean result, no note.
status = executor.getProcessStatus(realId);
check("exact id: exact match, no note", status.id === realId && status.note === undefined, JSON.stringify({ id: status.id, note: status.note }));

// Wrong kill id while one runs → lists running ids.
kill = executor.killProcess("proc_wrong123");
check("wrong kill id: lists running processes", Array.isArray(kill.runningProcesses) && kill.runningProcesses.some((p) => p.id === realId), JSON.stringify(kill).slice(0, 200));

// Cleanup: kill the real process.
kill = executor.killProcess(realId);
check("real kill works", !kill.error, JSON.stringify(kill).slice(0, 150));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
