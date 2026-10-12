// Smoke test: bash-ism auto-repair for Windows PowerShell 5.1 in shell-executor.
// Part 1: unit checks on translateBashismsForPowerShell.
// Part 2: LIVE end-to-end through ShellExecutor + real powershell.exe — the
// exact command shape that filled PROGRESS.md with failures must now succeed.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { ShellExecutor, translateBashismsForPowerShell } =
  await import(pathToFileURL(path.join(ROOT, "src/core/shell-executor.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
  if (!ok) failures += 1;
};

// ── Part 1: translation unit checks ─────────────────────────────────────────
const t = (cmd) => translateBashismsForPowerShell(cmd);

let r = t("cd neon-open-world && npm run build");
check("&& → if($?)", r.command === "cd neon-open-world; if ($?) { npm run build }", r.command);

r = t("cd app && npm install && npm run build");
check("triple && nests", r.command === "cd app; if ($?) { npm install; if ($?) { npm run build } }", r.command);

r = t("npm run build 2>&1");
check("2>&1 untouched", !r.changed, r.command);

r = t("echo \"a && b\"");
check("&& inside double quotes untouched", !r.changed, r.command);

r = t("echo 'x || y'");
check("|| inside single quotes untouched", !r.changed, r.command);

r = t("npm test || echo failed");
check("|| → if(-not $?)", r.command === "npm test; if (-not $?) { echo failed }", r.command);

r = t("cd neon-open-world && npm run build 2>&1 | head -100");
check("head -100 → Select-Object -First 100", r.command.includes("| Select-Object -First 100"), r.command);
check("head+&& both repaired", r.command.startsWith("cd neon-open-world; if ($?) {"), r.command);

r = t("node x.js 2>/dev/null");
check("2>/dev/null → 2>$null", r.command === "node x.js 2>$null", r.command);

r = t("npm run build; npm test");
check("plain ; untouched", !r.changed, r.command);

r = t("git log --oneline | tail -n 5");
check("tail -n 5 → Select-Object -Last 5", r.command.includes("| Select-Object -Last 5"), r.command);

// ── Part 2: LIVE end-to-end through real powershell.exe ─────────────────────
const configStore = {
  getConfig: () => ({
    tools: { permissions: { allowShellExecution: true }, shellExecution: { allowlistMode: "advisory" } },
  }),
};
const executor = new ShellExecutor({ rootDir: ROOT, configStore, eventBus: null });

// The exact failure shape from PROGRESS.md: `cd <dir> && <command>`.
let live = await executor.execute({ command: "cd scripts && echo repaired-ok" });
check("LIVE: cd X && echo → completed", live.status === "completed" && live.exitCode === 0, `status=${live.status} exit=${live.exitCode} stderr=${String(live.stderr).slice(0, 120)}`);
check("LIVE: output correct", String(live.stdout).trim() === "repaired-ok", JSON.stringify(live.stdout));
check("LIVE: syntaxRepairs reported", Array.isArray(live.syntaxRepairs) && live.syntaxRepairs.length > 0, JSON.stringify(live.syntaxRepairs));
check("LIVE: requestedCommand preserved", live.requestedCommand === "cd scripts && echo repaired-ok", live.requestedCommand);
check("LIVE: harnessNote teaches the model", String(live.harnessNote || "").includes("PowerShell"), live.harnessNote);

// Short-circuit semantics preserved: first part fails → second must NOT run.
live = await executor.execute({ command: "cd no-such-dir-xyz && echo should-not-print" });
check("LIVE: short-circuit kept (cd fail → no echo)", !String(live.stdout).includes("should-not-print"), JSON.stringify(live.stdout));

// A clean PowerShell command must pass through untouched (no repair fields).
live = await executor.execute({ command: "echo plain" });
check("LIVE: clean command untouched", live.status === "completed" && live.syntaxRepairs === undefined && String(live.stdout).trim() === "plain", JSON.stringify({ s: live.status, rep: live.syntaxRepairs }));

// || fallback path runs.
live = await executor.execute({ command: "cd no-such-dir-xyz || echo fallback-ran" });
check("LIVE: || fallback executes", String(live.stdout).includes("fallback-ran"), JSON.stringify(live.stdout));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
