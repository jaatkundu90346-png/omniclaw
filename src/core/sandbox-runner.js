import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { analyzeShellCommand, DEFAULT_BLOCKED_PATTERNS } from "./shell-policy.js";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureInside(rootDir, targetPath, label = "path") {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the allowed root.`);
  }
  return target;
}

function normalizeRel(inputPath = ".") {
  return String(inputPath || ".").trim().replace(/^[/\\]+/, "") || ".";
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function shouldSkip(relativePath, patterns = []) {
  const normalized = relativePath.replace(/\\/g, "/");
  return patterns.some((pattern) => new RegExp(pattern, "i").test(normalized));
}

function collectFiles(rootDir, patterns = []) {
  const files = new Map();
  if (!fs.existsSync(rootDir)) {
    return files;
  }

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(rootDir, absolute) || entry.name;
      if (shouldSkip(relative, patterns)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        files.set(relative.replace(/\\/g, "/"), {
          path: relative.replace(/\\/g, "/"),
          bytes: stat.size,
          hash: hashFile(absolute),
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  };

  walk(rootDir);
  return files;
}

function diffFileMaps(before, after) {
  const changes = [];
  for (const [relative, next] of after.entries()) {
    const previous = before.get(relative);
    if (!previous) {
      changes.push({ path: relative, status: "added", bytes: next.bytes });
    } else if (previous.hash !== next.hash) {
      changes.push({ path: relative, status: "modified", bytes: next.bytes });
    }
  }
  for (const [relative, previous] of before.entries()) {
    if (!after.has(relative)) {
      changes.push({ path: relative, status: "deleted", bytes: previous.bytes });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function truncateOutput(value, maxBytes) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString("utf8"), truncated: false, bytes: buffer.length };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    bytes: buffer.length,
  };
}

export class SandboxRunner {
  constructor({ rootDir, configStore }) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.manifestDir = path.join(rootDir, "data", "sandbox-runs");
    fs.mkdirSync(this.manifestDir, { recursive: true });
  }

  getPolicy() {
    const config = this.configStore.getConfig();
    const sandbox = config.tools?.sandbox || {};
    return {
      enabled: sandbox.enabled !== false,
      timeoutMs: Math.max(1000, Math.min(Number(sandbox.timeoutMs || 30000), 180000)),
      maxOutputBytes: Math.max(1024, Math.min(Number(sandbox.maxOutputBytes || 20000), 256000)),
      maxCopyBytes: Math.max(1024 * 1024, Math.min(Number(sandbox.maxCopyBytes || 25 * 1024 * 1024), 250 * 1024 * 1024)),
      maxFileBytes: Math.max(1024, Math.min(Number(sandbox.maxFileBytes || 2 * 1024 * 1024), 25 * 1024 * 1024)),
      defaultPaths: Array.isArray(sandbox.defaultPaths) && sandbox.defaultPaths.length > 0 ? sandbox.defaultPaths : ["."],
      excludePatterns: Array.isArray(sandbox.excludePatterns)
        ? sandbox.excludePatterns
        : [
            "^\\.git(?:/|$)",
            "^node_modules(?:/|$)",
            "^data(?:/|$)",
            "^dist(?:/|$)",
            "^\\.next(?:/|$)",
            "^src-tauri/target(?:/|$)",
          ],
      blockedPatterns: Array.isArray(sandbox.blockedPatterns) ? sandbox.blockedPatterns : DEFAULT_BLOCKED_PATTERNS,
    };
  }

  getStatus() {
    const policy = this.getPolicy();
    return {
      enabled: policy.enabled,
      isolation: "temp-workspace-copy",
      applyMode: "explicit-selected-files",
      manifestDir: this.manifestDir,
      defaultPaths: policy.defaultPaths,
      excludePatterns: policy.excludePatterns,
      limits: {
        timeoutMs: policy.timeoutMs,
        maxCopyBytes: policy.maxCopyBytes,
        maxFileBytes: policy.maxFileBytes,
        maxOutputBytes: policy.maxOutputBytes,
      },
      capabilities: {
        dryRunCommand: true,
        changedFileReport: true,
        explicitApply: true,
        blocksKnownDestructiveSystemCommands: true,
        vmIsolation: false,
      },
    };
  }

  createWorkspace(paths = []) {
    const policy = this.getPolicy();
    if (!policy.enabled) {
      throw new Error("Sandbox runner is disabled by config.");
    }

    const runId = createId("sandbox");
    const runRoot = path.join(os.tmpdir(), runId);
    const workspaceRoot = path.join(runRoot, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const selectedPaths = (Array.isArray(paths) && paths.length > 0 ? paths : policy.defaultPaths).map(normalizeRel);
    const copied = [];
    const skipped = [];
    let copiedBytes = 0;

    const copyOne = (relativePath) => {
      const source = ensureInside(this.rootDir, path.join(this.rootDir, relativePath), "sandbox source");
      if (!fs.existsSync(source)) {
        skipped.push({ path: relativePath, reason: "missing" });
        return;
      }
      const stat = fs.statSync(source);
      const normalized = normalizeRel(relativePath).replace(/\\/g, "/");
      if (shouldSkip(normalized, policy.excludePatterns)) {
        skipped.push({ path: normalized, reason: "excluded" });
        return;
      }

      if (stat.isDirectory()) {
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            const rel = path.relative(this.rootDir, absolute).replace(/\\/g, "/");
            if (shouldSkip(rel, policy.excludePatterns)) {
              skipped.push({ path: rel, reason: "excluded" });
              continue;
            }
            if (entry.isDirectory()) {
              walk(absolute);
              continue;
            }
            if (!entry.isFile()) {
              skipped.push({ path: rel, reason: "not-file" });
              continue;
            }
            this.copyFileWithLimits(absolute, path.join(workspaceRoot, rel), rel, policy, copied, skipped, () => copiedBytes, (value) => {
              copiedBytes = value;
            });
          }
        };
        walk(source);
        return;
      }

      if (stat.isFile()) {
        this.copyFileWithLimits(source, path.join(workspaceRoot, normalized), normalized, policy, copied, skipped, () => copiedBytes, (value) => {
          copiedBytes = value;
        });
      }
    };

    for (const item of selectedPaths) {
      copyOne(item);
    }

    const before = collectFiles(workspaceRoot, policy.excludePatterns);
    const manifest = {
      id: runId,
      rootDir: this.rootDir,
      runRoot,
      workspaceRoot,
      selectedPaths,
      copied,
      skipped,
      copiedBytes,
      before: Object.fromEntries(before),
      createdAt: new Date().toISOString(),
    };
    this.writeManifest(manifest);
    return manifest;
  }

  copyFileWithLimits(source, destination, relativePath, policy, copied, skipped, getCopiedBytes, setCopiedBytes) {
    const stat = fs.statSync(source);
    if (stat.size > policy.maxFileBytes) {
      skipped.push({ path: relativePath, reason: "file-too-large", bytes: stat.size });
      return;
    }
    if (getCopiedBytes() + stat.size > policy.maxCopyBytes) {
      skipped.push({ path: relativePath, reason: "copy-budget-exceeded", bytes: stat.size });
      return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push({ path: relativePath, bytes: stat.size });
    setCopiedBytes(getCopiedBytes() + stat.size);
  }

  readManifest(runId) {
    const id = String(runId || "").trim();
    const filePath = ensureInside(this.manifestDir, path.join(this.manifestDir, `${id}.json`), "sandbox manifest");
    if (!fs.existsSync(filePath)) {
      throw new Error(`Sandbox run not found: ${id}`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  writeManifest(manifest) {
    const filePath = path.join(this.manifestDir, `${manifest.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  }

  async run({ command, cwd = ".", paths = [] } = {}) {
    const policy = this.getPolicy();
    const text = String(command || "").trim();
    if (!text) {
      throw new Error("Sandbox command is required.");
    }
    const analysis = analyzeShellCommand(text, {
      allowlistMode: "advisory",
      trustLevel: "balanced",
      blockedPatterns: policy.blockedPatterns,
    });
    if (analysis.risk === "blocked") {
      return {
        status: "blocked",
        command: text,
        risk: analysis.risk,
        riskReasons: analysis.reasons,
        message: "Command matched blocked destructive policy and was not run, even in sandbox.",
      };
    }

    const manifest = this.createWorkspace(paths);
    const safeCwd = ensureInside(manifest.workspaceRoot, path.join(manifest.workspaceRoot, normalizeRel(cwd)), "sandbox cwd");
    fs.mkdirSync(safeCwd, { recursive: true });
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const execution = await this.spawnCommand(text, safeCwd, policy);
    const after = collectFiles(manifest.workspaceRoot, policy.excludePatterns);
    const before = new Map(Object.entries(manifest.before || {}));
    const changes = diffFileMaps(before, after);
    const completed = {
      ...manifest,
      command: text,
      cwd: path.relative(manifest.workspaceRoot, safeCwd).replace(/\\/g, "/") || ".",
      analysis,
      execution: {
        ...execution,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
      },
      changes,
      after: Object.fromEntries(after),
      completedAt: new Date().toISOString(),
    };
    this.writeManifest(completed);
    return this.publicRun(completed);
  }

  spawnCommand(command, cwd, policy) {
    return new Promise((resolve) => {
      const shell =
        process.platform === "win32"
          ? {
              command: "powershell.exe",
              args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
            }
          : { command: "/bin/sh", args: ["-lc", command] };
      const child = spawn(shell.command, shell.args, { cwd, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, policy.timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          exitCode: null,
          signal: null,
          timedOut,
          stdout: "",
          stderr: error.message,
          outputTruncated: false,
        });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        const safeStdout = truncateOutput(stdout, policy.maxOutputBytes);
        const safeStderr = truncateOutput(stderr, policy.maxOutputBytes);
        resolve({
          status: timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed",
          exitCode,
          signal,
          timedOut,
          stdout: safeStdout.text,
          stderr: safeStderr.text,
          stdoutBytes: safeStdout.bytes,
          stderrBytes: safeStderr.bytes,
          outputTruncated: safeStdout.truncated || safeStderr.truncated,
        });
      });
    });
  }

  apply({ runId, files = [] } = {}) {
    const manifest = this.readManifest(runId);
    const selected = Array.isArray(files) && files.length > 0
      ? new Set(files.map((item) => normalizeRel(item).replace(/\\/g, "/")))
      : new Set((manifest.changes || []).filter((item) => item.status !== "deleted").map((item) => item.path));
    const changes = manifest.changes || [];
    const applied = [];
    const skipped = [];

    for (const change of changes) {
      if (!selected.has(change.path)) {
        continue;
      }
      if (change.status === "deleted") {
        skipped.push({ path: change.path, reason: "delete-apply-not-supported" });
        continue;
      }
      const source = ensureInside(manifest.workspaceRoot, path.join(manifest.workspaceRoot, change.path), "sandbox apply source");
      const target = ensureInside(this.rootDir, path.join(this.rootDir, change.path), "sandbox apply target");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      applied.push({ path: change.path, status: change.status, bytes: fs.statSync(target).size });
    }

    manifest.applied = [...(manifest.applied || []), ...applied];
    manifest.applySkipped = [...(manifest.applySkipped || []), ...skipped];
    manifest.appliedAt = new Date().toISOString();
    this.writeManifest(manifest);
    return {
      runId: manifest.id,
      applied,
      skipped,
      message: applied.length > 0 ? "Selected sandbox changes were applied to the real workspace." : "No sandbox changes were applied.",
    };
  }

  publicRun(manifest) {
    return {
      runId: manifest.id,
      status: manifest.execution?.status || "created",
      command: manifest.command || "",
      cwd: manifest.cwd || ".",
      risk: manifest.analysis?.risk || "medium",
      riskReasons: manifest.analysis?.reasons || [],
      copiedFiles: manifest.copied?.length || 0,
      copiedBytes: manifest.copiedBytes || 0,
      skipped: manifest.skipped || [],
      changes: manifest.changes || [],
      stdout: manifest.execution?.stdout || "",
      stderr: manifest.execution?.stderr || "",
      exitCode: manifest.execution?.exitCode ?? null,
      timedOut: Boolean(manifest.execution?.timedOut),
      outputTruncated: Boolean(manifest.execution?.outputTruncated),
      workspaceRoot: manifest.workspaceRoot,
      createdAt: manifest.createdAt,
      completedAt: manifest.completedAt || null,
      applyHint: "Use sandbox_apply with runId and selected files to copy changes into the real workspace.",
    };
  }
}
