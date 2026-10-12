import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { analyzeShellCommand, DEFAULT_ALLOWLIST_PATTERNS, DEFAULT_BLOCKED_PATTERNS, shellBlockHint } from "./shell-policy.js";

// Background process registry
const backgroundProcesses = new Map();

function ensureWithinRoot(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Execution cwd is outside the OmniClaw workspace.");
  }
  return resolvedCandidate;
}

function expandShellPath(rootDir, inputPath) {
  const text = String(inputPath || "").trim();
  if (!text) {
    return path.resolve(rootDir);
  }
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), text.slice(2)));
  }
  return path.resolve(path.isAbsolute(text) ? text : path.join(rootDir, text));
}

function ensureWithinAnyRoot(rootDir, candidatePath, roots = []) {
  const target = expandShellPath(rootDir, candidatePath);
  const allowedRoots = Array.isArray(roots) && roots.length > 0 ? roots : ["~"];
  const allowed = allowedRoots.some((root) => {
    const resolvedRoot = expandShellPath(rootDir, root);
    const relative = path.relative(resolvedRoot, target);
    return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new Error("Execution cwd is outside configured computer access roots.");
  }
  return target;
}

// Strip ANSI escape sequences (colors, cursor moves, OSC titles) from command
// output. Build tools (vite/rolldown/webpack) colorize errors heavily; the raw
// codes reach the model as `[0m[38;5;249m...` garbage that buries the actual
// error text (and breaks file:line extraction). Humans get colors in their own
// terminal — the agent's observation must be plain text.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
}

// Windows PowerShell 5.1 cannot parse the bash-isms models emit constantly —
// `A && B` is the single most repeated exec failure in real runs (ParserError,
// wasted round, model retries with `;`). Instead of failing and hoping the
// model self-corrects, transparently translate to the PowerShell equivalent
// and report the repair in the result so the model learns the local syntax.
// Quote-aware: never rewrites inside single/double quotes ("2>&1" is safe too —
// the operators here are two identical consecutive chars).
export function translateBashismsForPowerShell(command) {
  const original = String(command || "");
  const repairs = [];
  let out = original;

  // Split on a top-level two-char operator ("&&" or "||"), respecting quotes.
  const splitTopLevel = (input, op) => {
    const parts = [];
    let current = "";
    let quote = "";
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (quote) {
        current += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === op[0] && input[i + 1] === op[1]) {
        parts.push(current);
        current = "";
        i += 1;
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts;
  };

  // `2>/dev/null` → `2>$null`, `>/dev/null` → `>$null` (before chain rewrite).
  if (/\/dev\/null/.test(out)) {
    out = out.replace(/(\d?>)\s*\/dev\/null/g, "$1$null").replace(/\/dev\/null/g, "$null");
    repairs.push("`/dev/null` → `$null`");
  }

  // `| head -N` / `| head -n N` → `| Select-Object -First N` (tail → -Last).
  if (/\|\s*head(\s|$)/.test(out) || /\|\s*tail(\s|$)/.test(out)) {
    out = out
      .replace(/\|\s*head\s+(?:-n\s*)?-?(\d+)/g, "| Select-Object -First $1")
      .replace(/\|\s*head(?=\s*($|\|))/g, "| Select-Object -First 10")
      .replace(/\|\s*tail\s+(?:-n\s*)?-?(\d+)/g, "| Select-Object -Last $1")
      .replace(/\|\s*tail(?=\s*($|\|))/g, "| Select-Object -Last 10");
    repairs.push("`head`/`tail` → `Select-Object -First/-Last`");
  }

  // `A && B && C` → `A; if ($?) { B; if ($?) { C } }` (same short-circuit).
  const andParts = splitTopLevel(out, "&&");
  const hasOr = splitTopLevel(out, "||").length > 1;
  if (andParts.length > 1 && !hasOr) {
    const parts = andParts.map((p) => p.trim()).filter(Boolean);
    let chained = parts[parts.length - 1];
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      chained = `${parts[i]}; if ($?) { ${chained} }`;
    }
    out = chained;
    repairs.push("`&&` → `; if ($?) { ... }` (PowerShell 5.1 has no `&&`)");
  } else if (andParts.length > 1 && hasOr) {
    // Mixed && / || chain: too complex to preserve short-circuit — degrade to
    // sequential `;` (still runs; a parser error would run nothing).
    out = splitTopLevel(splitTopLevel(out, "&&").join(" ; "), "||").join(" ; ");
    repairs.push("mixed `&&`/`||` → `;` (short-circuit dropped)");
  } else if (hasOr) {
    const parts = splitTopLevel(out, "||").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      out = `${parts[0]}; if (-not $?) { ${parts[1]} }`;
      repairs.push("`||` → `; if (-not $?) { ... }`");
    } else {
      out = parts.join(" ; ");
      repairs.push("`||` chain → `;`");
    }
  }

  return { command: out, repairs, changed: repairs.length > 0 };
}

function truncateOutput(value, maxBytes) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.length <= maxBytes) {
    return {
      text: buffer.toString("utf8"),
      truncated: false,
      bytes: buffer.length,
    };
  }
  // Keep head AND tail: test/build runners print the verdict (failures,
  // "N passing", stack traces) at the END — head-only truncation hid exactly
  // what the agent needed to read.
  const headBytes = Math.max(0, Math.floor(maxBytes * 0.6));
  const tailBytes = Math.max(0, maxBytes - headBytes - 64);
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return {
    text: `${head}\n...[${buffer.length - headBytes - tailBytes} bytes omitted]...\n${tail}`,
    truncated: true,
    bytes: buffer.length,
  };
}

// Append text to a growing buffer but keep only the most recent maxBytes, so a
// long-running background process (dev server, watcher, log spammer) can't grow
// stdout/stderr unbounded and exhaust memory. Tail is kept (recent output is the
// useful part); the byte counters track the true total separately.
const MAX_BACKGROUND_OUTPUT_BYTES = 256000;
function appendBoundedOutput(current, text, maxBytes = MAX_BACKGROUND_OUTPUT_BYTES) {
  const combined = `${current}${text}`;
  const buffer = Buffer.from(combined, "utf8");
  if (buffer.length <= maxBytes) {
    return { text: combined, truncated: false };
  }
  return { text: buffer.subarray(buffer.length - maxBytes).toString("utf8"), truncated: true };
}

export class ShellExecutor {
  constructor({ rootDir, configStore, eventBus }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.eventBus = eventBus;
  }

  // Swaps the directory that shell commands run in and are sandboxed to.
  // Called when the user picks a different workspace folder, so git/npm/etc.
  // execute inside the selected project instead of the OmniClaw install dir.
  setRootDir(rootDir) {
    const next = String(rootDir || "").trim();
    if (!next) return this.rootDir;
    this.rootDir = next;
    return this.rootDir;
  }

  getPolicy() {
    const config = this.configStore.getConfig();
    const shellConfig = config.tools?.shellExecution || {};
    return {
      enabled: Boolean(config.tools?.permissions?.allowShellExecution),
      cwd: shellConfig.cwd || ".",
      timeoutMs: Number(shellConfig.timeoutMs || 120000),
      maxOutputBytes: Number(shellConfig.maxOutputBytes || 256000),
      allowExternalCwd: Boolean(shellConfig.allowExternalCwd),
      externalCwdRoots: Array.isArray(shellConfig.externalCwdRoots)
        ? shellConfig.externalCwdRoots
        : Array.isArray(config.tools?.computerAccess?.allowedRoots)
          ? config.tools.computerAccess.allowedRoots
          : ["~"],
      blockedPathPatterns: Array.isArray(config.tools?.computerAccess?.blockedPathPatterns)
        ? config.tools.computerAccess.blockedPathPatterns
        : [],
      allowlistMode: String(shellConfig.allowlistMode || "advisory").toLowerCase(),
      trustLevel: String(shellConfig.trustLevel || "protected").toLowerCase(),
      allowlistPatterns: Array.isArray(shellConfig.allowlistPatterns)
        ? shellConfig.allowlistPatterns
        : DEFAULT_ALLOWLIST_PATTERNS,
      blockedPatterns: Array.isArray(shellConfig.blockedPatterns)
        ? shellConfig.blockedPatterns
        : DEFAULT_BLOCKED_PATTERNS,
    };
  }

  validateCommand(command, policy) {
    const text = String(command || "").trim();
    if (!text) {
      throw new Error("Shell command is required.");
    }
    if (text.includes("\u0000")) {
      throw new Error("Shell command contains invalid null bytes.");
    }
    if (!policy.enabled) {
      throw new Error("Shell execution is disabled by runtime policy.");
    }

    const analysis = analyzeShellCommand(text, policy);
    if (analysis.risk === "blocked") {
      // Never return a bare regex: the model cannot act on it, so it retries or
      // thinks instead. Name the correct spelling + the non-blocked tool.
      const hint = shellBlockHint(text, analysis.blockedPattern);
      throw new Error(`Shell command blocked by safety policy: ${analysis.reasons.join("; ")}${hint ? `\nFIX: ${hint}` : ""}`);
    }
    if (policy.allowlistMode === "enforce" && !analysis.allowlisted) {
      throw new Error("Shell command is not in the allowlist and allowlist enforcement is enabled.");
    }
    return text;
  }

  getShell(command) {
    if (process.platform === "win32") {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      };
    }
    return {
      command: "/bin/bash",
      args: ["-lc", command],
    };
  }

  // Main execute method - supports both sync and background modes
  execute({ command, cwd = "", background = false, approvalId = "", runId = "", sessionId = "", timeoutMs = 0 } = {}) {
    const policy = this.getPolicy();
    let safeCommand = this.validateCommand(command, policy);
    // Bash-ism auto-repair (Windows only): translate `&&`/`||`//dev/null/head/
    // tail into PowerShell 5.1 equivalents instead of failing with a
    // ParserError. Validation ran on the original above; the repaired form is
    // re-analyzed below, so both shapes pass the safety policy.
    let syntaxRepairs = [];
    let requestedCommand = "";
    if (process.platform === "win32") {
      const translated = translateBashismsForPowerShell(safeCommand);
      if (translated.changed) {
        requestedCommand = safeCommand;
        safeCommand = translated.command;
        syntaxRepairs = translated.repairs;
      }
    }
    const analysis = analyzeShellCommand(safeCommand, policy);
    const requestedCwd = cwd || policy.cwd || ".";
    const safeCwd = policy.allowExternalCwd && (path.isAbsolute(String(requestedCwd)) || String(requestedCwd).startsWith("~"))
      ? ensureWithinAnyRoot(this.rootDir, requestedCwd, policy.externalCwdRoots)
      : ensureWithinRoot(this.rootDir, path.join(this.rootDir, requestedCwd));
    const normalizedCwd = safeCwd.replace(/\\/g, "/");
    const blockedCwd = policy.blockedPathPatterns.find((pattern) => new RegExp(pattern, "i").test(normalizedCwd));
    if (blockedCwd) {
      throw new Error(`Execution cwd is blocked by computer access policy: ${blockedCwd}`);
    }

    // Attach the repair note so the model SEES what actually ran and learns
    // the local shell syntax instead of repeating the bash-ism next round.
    const attachRepairs = (result) => {
      if (syntaxRepairs.length && result && typeof result === "object") {
        result.syntaxRepairs = syntaxRepairs;
        result.requestedCommand = requestedCommand;
        result.harnessNote = "Command contained bash syntax that Windows PowerShell 5.1 cannot parse; the harness auto-translated it (see syntaxRepairs + the executed `command`). Emit PowerShell syntax directly next time.";
      }
      return result;
    };

    // Background mode - spawn and return process ID
    if (background) {
      return attachRepairs(this.executeBackground(safeCommand, safeCwd, analysis, { approvalId, runId, sessionId }));
    }

    // Sync mode - wait for completion
    return this.executeSync(safeCommand, safeCwd, analysis, policy, { approvalId, runId, sessionId, timeoutMs }).then(attachRepairs);
  }

  // Synchronous execution (waits for completion)
  executeSync(command, cwd, analysis, policy, { approvalId = "", runId = "", sessionId = "", timeoutMs = 0 } = {}) {
    const effectiveTimeoutMs = Math.max(1000, Math.min(Number(timeoutMs || policy.timeoutMs), 900000)); // Max 15 min
    const maxOutputBytes = Math.max(1024, Math.min(policy.maxOutputBytes, 512000));
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    return new Promise((resolve) => {
      const shell = this.getShell(command);
      const child = spawn(shell.command, shell.args, {
        cwd,
        windowsHide: true,
        // Ask tools not to colorize at the source; stripAnsi below catches the
        // ones that ignore these conventions.
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0" },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const killTree = () => {
        try {
          if (process.platform === "win32" && child.pid) {
            spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
            return;
          }
        } catch {}
        try { child.kill("SIGTERM"); } catch {}
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, effectiveTimeoutMs);

      // Bound in-flight accumulation (keep the most recent ~2MB) so a command
      // spewing hundreds of MB can't exhaust gateway memory before it exits;
      // final head+tail truncation still applies on close.
      const MAX_SYNC_ACCUM = 2 * 1024 * 1024;
      child.stdout.on("data", (chunk) => {
        stdout = appendBoundedOutput(stdout, stripAnsi(chunk.toString("utf8")), MAX_SYNC_ACCUM).text;
      });

      child.stderr.on("data", (chunk) => {
        stderr = appendBoundedOutput(stderr, stripAnsi(chunk.toString("utf8")), MAX_SYNC_ACCUM).text;
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        const completedAt = new Date().toISOString();
        resolve({
          status: "failed",
          command,
          cwd: path.relative(this.rootDir, cwd) || ".",
          approvalId,
          runId,
          sessionId,
          startedAt,
          completedAt,
          durationMs: Date.now() - startedMs,
          exitCode: null,
          signal: null,
          timedOut,
          risk: analysis.risk,
          allowlisted: analysis.allowlisted,
          riskReasons: analysis.reasons,
          stdout: "",
          stderr: error.message,
          outputTruncated: false,
        });
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        const completedAt = new Date().toISOString();
        const safeStdout = truncateOutput(stdout, maxOutputBytes);
        const safeStderr = truncateOutput(stderr, maxOutputBytes);
        const ok = !timedOut && exitCode === 0;
        resolve({
          status: timedOut ? "timeout" : ok ? "completed" : "failed",
          command,
          cwd: path.relative(this.rootDir, cwd) || ".",
          approvalId,
          runId,
          sessionId,
          startedAt,
          completedAt,
          durationMs: Date.now() - startedMs,
          exitCode,
          signal,
          timedOut,
          risk: analysis.risk,
          allowlisted: analysis.allowlisted,
          riskReasons: analysis.reasons,
          stdout: safeStdout.text,
          stderr: safeStderr.text,
          outputTruncated: safeStdout.truncated || safeStderr.truncated,
          stdoutBytes: safeStdout.bytes,
          stderrBytes: safeStderr.bytes,
        });
      });
    });
  }

  // Background execution - returns process ID immediately
  executeBackground(command, cwd, analysis, { approvalId = "", runId = "", sessionId = "" } = {}) {
    const processId = `proc_${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    const shell = this.getShell(command);
    const child = spawn(shell.command, shell.args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0" },
    });

    const processInfo = {
      id: processId,
      pid: child.pid,
      command,
      cwd: path.relative(this.rootDir, cwd) || ".",
      status: "running",
      startedAt,
      approvalId,
      runId,
      sessionId,
      risk: analysis.risk,
      allowlisted: analysis.allowlisted,
      riskReasons: analysis.reasons,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      child,
    };

    // Store in registry
    backgroundProcesses.set(processId, processInfo);

    // Handle output
    child.stdout.on("data", (chunk) => {
      const text = stripAnsi(chunk.toString("utf8"));
      const bounded = appendBoundedOutput(processInfo.stdout, text);
      processInfo.stdout = bounded.text;
      if (bounded.truncated) processInfo.outputTruncated = true;
      processInfo.stdoutBytes += Buffer.byteLength(text, "utf8");
      this.emitOutput(processId, "stdout", text);
    });

    child.stderr.on("data", (chunk) => {
      const text = stripAnsi(chunk.toString("utf8"));
      const bounded = appendBoundedOutput(processInfo.stderr, text);
      processInfo.stderr = bounded.text;
      if (bounded.truncated) processInfo.outputTruncated = true;
      processInfo.stderrBytes += Buffer.byteLength(text, "utf8");
      this.emitOutput(processId, "stderr", text);
    });

    child.on("error", (error) => {
      processInfo.status = "failed";
      processInfo.stderr = error.message;
      this.emitStatus(processId, "failed", { error: error.message });
    });

    child.on("close", (exitCode, signal) => {
      processInfo.status = exitCode === 0 ? "completed" : "failed";
      processInfo.exitCode = exitCode;
      processInfo.signal = signal;
      processInfo.durationMs = Date.now() - startedMs;
      processInfo.completedAt = new Date().toISOString();
      this.emitStatus(processId, processInfo.status, { exitCode, signal });
    });

    return {
      status: "started",
      processId,
      pid: child.pid,
      command,
      cwd: processInfo.cwd,
      startedAt,
      message: "Background process started. Use process_status to check output.",
    };
  }

  // Emit output event (for WebSocket/SSE)
  emitOutput(processId, stream, text) {
    if (this.eventBus) {
      const process = backgroundProcesses.get(processId);
      this.eventBus.emit("process.output", {
        processId,
        stream,
        text,
        runId: process?.runId || "",
        sessionId: process?.sessionId || "",
        timestamp: Date.now(),
      });
    }
  }

  // Emit status change event
  emitStatus(processId, status, details = {}) {
    if (this.eventBus) {
      const process = backgroundProcesses.get(processId);
      this.eventBus.emit("process.status", {
        processId,
        status,
        ...details,
        runId: process?.runId || "",
        sessionId: process?.sessionId || "",
        timestamp: Date.now(),
      });
    }
  }

  // List all background processes
  listProcesses({ status } = {}) {
    const processes = Array.from(backgroundProcesses.values()).map((p) => ({
      id: p.id,
      pid: p.pid,
      command: p.command,
      cwd: p.cwd,
      status: p.status,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      durationMs: p.durationMs,
      exitCode: p.exitCode,
      stdoutBytes: p.stdoutBytes,
      stderrBytes: p.stderrBytes,
    }));

    if (status) {
      return processes.filter((p) => p.status === status);
    }
    return processes;
  }

  describeProcess(process) {
    return {
      id: process.id,
      pid: process.pid,
      command: process.command,
      cwd: process.cwd,
      status: process.status,
      startedAt: process.startedAt,
      completedAt: process.completedAt,
      durationMs: process.durationMs,
      exitCode: process.exitCode,
      signal: process.signal,
      timedOut: process.timedOut,
      risk: process.risk,
      stdoutBytes: process.stdoutBytes,
      stderrBytes: process.stderrBytes,
      stdout: process.stdout,
      stderr: process.stderr,
    };
  }

  // Get process status and output. Models routinely lose or misremember the
  // processId (a top real-run failure) — a bare "Process not found" dead-ends
  // the round, so auto-resolve to the most recent process instead and always
  // name what IS available.
  getProcessStatus(processId) {
    const id = String(processId || "").trim();
    const exact = backgroundProcesses.get(id);
    if (exact) {
      return this.describeProcess(exact);
    }
    const all = Array.from(backgroundProcesses.values());
    if (all.length === 0) {
      return {
        error: "Process not found",
        processId: id,
        hint: "No background processes exist in this gateway right now. Start one with exec {background: true} — its result includes the processId to use here.",
      };
    }
    const running = all.filter((p) => p.status === "running");
    const candidates = running.length > 0 ? running : all;
    const newest = candidates.reduce((a, b) => (Date.parse(b.startedAt || 0) > Date.parse(a.startedAt || 0) ? b : a));
    const others = all
      .filter((p) => p.id !== newest.id)
      .map((p) => ({ id: p.id, status: p.status, command: String(p.command || "").slice(0, 80) }));
    return {
      ...this.describeProcess(newest),
      note: id
        ? `Process "${id}" not found — auto-resolved to the most recent ${newest.status} process ${newest.id} (${String(newest.command || "").slice(0, 80)}). Use its id from now on.`
        : `No processId given — showing the most recent ${newest.status} process ${newest.id}.`,
      ...(others.length ? { otherProcesses: others } : {}),
    };
  }

  // Kill a background process
  killProcess(processId, signal = "SIGTERM") {
    const process = backgroundProcesses.get(processId);
    if (!process) {
      const running = Array.from(backgroundProcesses.values())
        .filter((p) => p.status === "running")
        .map((p) => ({ id: p.id, command: String(p.command || "").slice(0, 80) }));
      return {
        error: "Process not found",
        processId,
        ...(running.length
          ? { hint: "These processes ARE running — pass one of these ids:", runningProcesses: running }
          : { hint: "No background processes are running." }),
      };
    }

    if (process.status !== "running") {
      return { error: "Process is not running", processId, status: process.status };
    }

    try {
      // On Windows, child.kill() only signals the shell, leaving the real child
      // tree (npm/node/python/etc.) orphaned — they keep holding ports/file
      // locks. Kill the whole tree like the foreground timeout path does.
      if (globalThis.process.platform === "win32" && process.child?.pid) {
        spawn("taskkill.exe", ["/pid", String(process.child.pid), "/t", "/f"], { windowsHide: true });
      } else {
        process.child.kill(signal);
      }
      process.status = "killed";
      process.signal = signal;
      this.emitStatus(processId, "killed", { signal });
      return { success: true, processId, signal, message: `Process ${processId} killed with ${signal}` };
    } catch (error) {
      return { error: error.message, processId };
    }
  }

  // Clear completed/failed processes from registry
  cleanupProcesses({ maxAge = 3600000 } = {}) {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, process] of backgroundProcesses.entries()) {
      if (process.status !== "running") {
        const completedAt = new Date(process.completedAt || process.startedAt).getTime();
        if (now - completedAt > maxAge) {
          backgroundProcesses.delete(id);
          cleaned++;
        }
      }
    }

    return { cleaned, remaining: backgroundProcesses.size };
  }
}

// Export for direct access to process registry
export { backgroundProcesses };
