import { spawn } from "node:child_process";
import path from "node:path";

import { analyzeShellCommand, DEFAULT_ALLOWLIST_PATTERNS, DEFAULT_BLOCKED_PATTERNS } from "./shell-policy.js";

function ensureWithinRoot(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Execution cwd is outside the OmniClaw workspace.");
  }
  return resolvedCandidate;
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
  constructor({ rootDir, configStore }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
  }

  getPolicy() {
    const config = this.configStore.getConfig();
    const shellConfig = config.tools?.shellExecution || {};
    return {
      enabled: Boolean(config.tools?.permissions?.allowShellExecution),
      cwd: shellConfig.cwd || ".",
      timeoutMs: Number(shellConfig.timeoutMs || 15000),
      maxOutputBytes: Number(shellConfig.maxOutputBytes || 12000),
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

  execute({ command, cwd = "", approvalId = "", runId = "", sessionId = "" } = {}) {
    const policy = this.getPolicy();
    const safeCommand = this.validateCommand(command, policy);
    const analysis = analyzeShellCommand(safeCommand, policy);
    const safeCwd = ensureWithinRoot(this.rootDir, path.join(this.rootDir, cwd || policy.cwd || "."));
    const timeoutMs = Math.max(1000, Math.min(policy.timeoutMs, 120000));
    const maxOutputBytes = Math.max(1024, Math.min(policy.maxOutputBytes, 256000));
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    return new Promise((resolve) => {
      const shell =
        process.platform === "win32"
          ? {
              command: "powershell.exe",
              args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", safeCommand],
            }
          : {
              command: "/bin/sh",
              args: ["-lc", safeCommand],
            };
      const child = spawn(shell.command, shell.args, {
        cwd: safeCwd,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
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
          command: safeCommand,
          cwd: path.relative(this.rootDir, safeCwd) || ".",
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
          command: safeCommand,
          cwd: path.relative(this.rootDir, safeCwd) || ".",
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
}
