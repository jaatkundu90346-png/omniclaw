import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { analyzeShellCommand, DEFAULT_ALLOWLIST_PATTERNS, DEFAULT_BLOCKED_PATTERNS } from "./shell-policy.js";

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

function truncateOutput(value, maxBytes) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.length <= maxBytes) {
    return {
      text: buffer.toString("utf8"),
      truncated: false,
      bytes: buffer.length,
    };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    bytes: buffer.length,
  };
}

export class ShellExecutor {
  constructor({ rootDir, configStore, eventBus }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.eventBus = eventBus;
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
      throw new Error(`Shell command blocked by safety policy: ${analysis.reasons.join("; ")}`);
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
  execute({ command, cwd = "", background = false, approvalId = "", runId = "", sessionId = "" } = {}) {
    const policy = this.getPolicy();
    const safeCommand = this.validateCommand(command, policy);
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

    // Background mode - spawn and return process ID
    if (background) {
      return this.executeBackground(safeCommand, safeCwd, analysis, { approvalId, runId, sessionId });
    }

    // Sync mode - wait for completion
    return this.executeSync(safeCommand, safeCwd, analysis, policy, { approvalId, runId, sessionId });
  }

  // Synchronous execution (waits for completion)
  executeSync(command, cwd, analysis, policy, { approvalId = "", runId = "", sessionId = "" } = {}) {
    const timeoutMs = Math.max(1000, Math.min(policy.timeoutMs, 300000)); // Max 5 min
    const maxOutputBytes = Math.max(1024, Math.min(policy.maxOutputBytes, 512000));
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    return new Promise((resolve) => {
      const shell = this.getShell(command);
      const child = spawn(shell.command, shell.args, {
        cwd,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
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
      const text = chunk.toString("utf8");
      processInfo.stdout += text;
      processInfo.stdoutBytes += Buffer.byteLength(text, "utf8");
      this.emitOutput(processId, "stdout", text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      processInfo.stderr += text;
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
      this.eventBus.emit("process.output", { processId, stream, text, timestamp: Date.now() });
    }
  }

  // Emit status change event
  emitStatus(processId, status, details = {}) {
    if (this.eventBus) {
      this.eventBus.emit("process.status", { processId, status, ...details, timestamp: Date.now() });
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

  // Get process status and output
  getProcessStatus(processId) {
    const process = backgroundProcesses.get(processId);
    if (!process) {
      return { error: "Process not found", processId };
    }

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

  // Kill a background process
  killProcess(processId, signal = "SIGTERM") {
    const process = backgroundProcesses.get(processId);
    if (!process) {
      return { error: "Process not found", processId };
    }

    if (process.status !== "running") {
      return { error: "Process is not running", processId, status: process.status };
    }

    try {
      process.child.kill(signal);
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
