import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getAcpSessionRuntimeMetadata } from "./acp-runtime-overlay.js";

const BUILT_IN_AGENTS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "droid",
  "gemini",
  "iflow",
  "kilocode",
  "kimi",
  "kiro",
  "openclaw",
  "opencode",
  "pi",
  "qwen",
];

const DEFAULT_LOCAL_COMMANDS = {
  codex: { command: "codex", args: ["exec", "--skip-git-repo-check"], taskArg: "append" },
  opencode: { command: "opencode", args: ["run"], taskArg: "append" },
  claude: { command: "claude", args: ["-p"], taskArg: "append" },
  gemini: { command: "gemini", args: ["--prompt"], taskArg: "append" },
  qwen: { command: "qwen", args: ["--prompt"], taskArg: "append" },
  cursor: { command: "cursor-agent", args: ["acp"], taskArg: "none" },
};

function createId(prefix) {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quoteShellArg(value) {
  const text = String(value ?? "");
  if (process.platform === "win32") {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function toPositiveInt(value, fallback, min = 1, max = 86400) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeAgentId(value, fallback = "codex") {
  return String(value || fallback).trim().toLowerCase();
}

function stripFlags(args = []) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || "");
    if (!item.startsWith("--")) {
      rest.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    if (eq > 2) {
      flags[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = args[index + 1];
    if (next && !String(next).startsWith("--")) {
      flags[key] = String(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, rest };
}

function splitCommandLine(input = "") {
  const text = String(input || "").trim();
  const out = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

export class AcpManager {
  constructor({ rootDir, configStore, gatewayStore, shellExecutor } = {}) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.gateway = gatewayStore;
    this.shellExecutor = shellExecutor;
    this.filePath = path.join(rootDir, "data", "acp-sessions.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ sessions: [] }, null, 2));
    }
  }

  readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch {
      return { sessions: [] };
    }
  }

  writeStore(data) {
    const next = {
      sessions: Array.isArray(data.sessions) ? data.sessions.slice(-200) : [],
    };
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2));
    return next;
  }

  getConfig() {
    const config = this.configStore?.getConfig?.() || {};
    const acp = config.acp || {};
    const pluginConfig = config.plugins?.entries?.acpx?.config || {};
    return {
      enabled: acp.enabled !== false,
      backend: String(acp.backend || pluginConfig.backend || "local-cli").trim(),
      dispatchEnabled: acp.dispatch?.enabled !== false,
      defaultAgent: normalizeAgentId(acp.defaultAgent || pluginConfig.probeAgent || "codex"),
      allowedAgents: Array.isArray(acp.allowedAgents) && acp.allowedAgents.length
        ? acp.allowedAgents.map((item) => normalizeAgentId(item))
        : BUILT_IN_AGENTS,
      maxConcurrentSessions: toPositiveInt(acp.maxConcurrentSessions, 8, 1, 32),
      ttlMinutes: toPositiveInt(acp.runtime?.ttlMinutes, 120, 1, 10080),
      permissionMode: String(pluginConfig.permissionMode || acp.permissionMode || "approve-reads").trim(),
      nonInteractivePermissions: String(pluginConfig.nonInteractivePermissions || acp.nonInteractivePermissions || "fail").trim(),
      timeoutSeconds: toPositiveInt(pluginConfig.timeoutSeconds || acp.timeoutSeconds, 120, 1, 86400),
      acpxCommand: String(pluginConfig.command || acp.command || "acpx").trim(),
      expectedVersion: String(pluginConfig.expectedVersion || "any").trim(),
      pluginToolsMcpBridge: Boolean(pluginConfig.pluginToolsMcpBridge),
      openClawToolsMcpBridge: Boolean(pluginConfig.openClawToolsMcpBridge),
      agents: isPlainObject(pluginConfig.agents) || isPlainObject(acp.agents)
        ? { ...(isPlainObject(acp.agents) ? acp.agents : {}), ...(isPlainObject(pluginConfig.agents) ? pluginConfig.agents : {}) }
        : {},
    };
  }

  resolveAgentConfig(agentId) {
    const config = this.getConfig();
    const id = normalizeAgentId(agentId, config.defaultAgent);
    const custom = config.agents?.[id] || {};
    const defaults = DEFAULT_LOCAL_COMMANDS[id] || { command: id, args: [], taskArg: "append" };
    return {
      id,
      command: String(custom.command || defaults.command || id).trim(),
      args: Array.isArray(custom.args) ? custom.args.map(String) : defaults.args || [],
      taskArg: String(custom.taskArg || defaults.taskArg || "append").trim(),
      modelFlag: custom.modelFlag || null,
      permissionFlag: custom.permissionFlag || null,
    };
  }

  isAgentAllowed(agentId) {
    const config = this.getConfig();
    return config.allowedAgents.includes(normalizeAgentId(agentId, config.defaultAgent));
  }

  probeExecutable(command, timeoutMs = 5000) {
    const text = String(command || "").trim();
    if (!text) {
      return Promise.resolve({ ok: false, error: "missing command" });
    }
    if (path.isAbsolute(text) || text.includes("/") || text.includes("\\")) {
      return Promise.resolve({ ok: fs.existsSync(text), command: text, path: fs.existsSync(text) ? text : "" });
    }
    const probe = process.platform === "win32"
      ? { command: "where.exe", args: [text] }
      : { command: "which", args: [text] };
    return new Promise((resolve) => {
      const child = spawn(probe.command, probe.args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve({ ok: false, command: text, error: "probe timed out" });
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, command: text, error: error.message });
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({
          ok: exitCode === 0,
          command: text,
          path: stdout.trim().split(/\r?\n/).filter(Boolean)[0] || "",
          stderr: stderr.trim(),
          exitCode,
        });
      });
    });
  }

  async doctor({ agentId } = {}) {
    const config = this.getConfig();
    const target = normalizeAgentId(agentId, config.defaultAgent);
    const agentConfig = this.resolveAgentConfig(target);
    const acpxProbe = await this.probeExecutable(config.acpxCommand);
    const agentProbe = await this.probeExecutable(agentConfig.command);
    const sessions = this.listSessions({ limit: 50 }).sessions;
    const running = sessions.filter((session) => session.status === "running").length;
    const ready = Boolean(config.enabled && config.dispatchEnabled && this.isAgentAllowed(target) && agentProbe.ok);
    return {
      ok: ready,
      enabled: config.enabled,
      dispatchEnabled: config.dispatchEnabled,
      backend: config.backend,
      defaultAgent: config.defaultAgent,
      targetAgent: target,
      allowed: this.isAgentAllowed(target),
      allowedAgents: config.allowedAgents,
      maxConcurrentSessions: config.maxConcurrentSessions,
      runningSessions: running,
      permissionMode: config.permissionMode,
      nonInteractivePermissions: config.nonInteractivePermissions,
      bridges: {
        pluginToolsMcpBridge: config.pluginToolsMcpBridge,
        openClawToolsMcpBridge: config.openClawToolsMcpBridge,
      },
      acpx: {
        command: config.acpxCommand,
        installed: acpxProbe.ok,
        path: acpxProbe.path || "",
        note: config.backend === "acpx"
          ? (acpxProbe.ok ? "acpx command is available." : "acpx backend selected but command was not found.")
          : "Optional: configure backend=acpx when the official acpx plugin/runtime is installed.",
      },
      agentCommand: {
        agentId: target,
        command: agentConfig.command,
        args: agentConfig.args,
        installed: agentProbe.ok,
        path: agentProbe.path || "",
        error: agentProbe.error || agentProbe.stderr || "",
      },
      nextAction: ready
        ? `ACP ${target} route is ready enough to spawn a local non-interactive harness command.`
        : this.installInstructions({ agentId: target }).summary,
    };
  }

  installInstructions({ agentId } = {}) {
    const target = normalizeAgentId(agentId, this.getConfig().defaultAgent);
    return {
      ok: true,
      targetAgent: target,
      summary: "Install/enable the ACP runtime and target harness, then run /acp doctor again.",
      commands: [
        "npm.cmd install -g @openclaw/acpx",
        "openclaw plugins install @openclaw/acpx",
        "openclaw config set plugins.entries.acpx.enabled true",
        "openclaw config set plugins.entries.acpx.config.permissionMode approve-all",
        target === "codex" ? "npm.cmd install -g @openai/codex && codex login" : "",
        target === "opencode" ? "opencode auth login" : "",
      ].filter(Boolean),
      configPatch: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
          backend: "local-cli",
          defaultAgent: target,
          allowedAgents: BUILT_IN_AGENTS,
        },
        plugins: {
          entries: {
            acpx: {
              enabled: true,
              config: {
                permissionMode: "approve-all",
                nonInteractivePermissions: "fail",
              },
            },
          },
        },
      },
    };
  }

  buildCommand({ agentId, task, cwd = "", model = "", permissions = "", timeoutSeconds = 0 } = {}) {
    const agentConfig = this.resolveAgentConfig(agentId);
    const args = [...agentConfig.args];
    if (model && agentConfig.modelFlag) {
      args.push(agentConfig.modelFlag, model);
    }
    if (permissions && agentConfig.permissionFlag) {
      args.push(agentConfig.permissionFlag, permissions);
    }
    if (timeoutSeconds && agentConfig.timeoutFlag) {
      args.push(agentConfig.timeoutFlag, String(timeoutSeconds));
    }
    if (agentConfig.taskArg !== "none" && task) {
      args.push(task);
    }
    const commandParts = [agentConfig.command, ...args].map(quoteShellArg);
    const shellCommand = process.platform === "win32"
      ? `& ${commandParts.join(" ")}`
      : commandParts.join(" ");
    return {
      command: shellCommand,
      displayCommand: [agentConfig.command, ...args.map((arg) => String(arg).length > 80 ? `${String(arg).slice(0, 77)}...` : arg)].join(" "),
      cwd,
    };
  }

  upsertSession(session) {
    const data = this.readStore();
    const index = data.sessions.findIndex((item) => item.id === session.id || item.key === session.key);
    if (index >= 0) {
      data.sessions[index] = { ...data.sessions[index], ...session, updatedAt: new Date().toISOString() };
    } else {
      data.sessions.push({ ...session, createdAt: session.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this.writeStore(data);
    return index >= 0 ? data.sessions[index] : data.sessions[data.sessions.length - 1];
  }

  updateSession(sessionIdOrKey, updates = {}) {
    const data = this.readStore();
    const index = data.sessions.findIndex((item) => item.id === sessionIdOrKey || item.key === sessionIdOrKey);
    if (index < 0) return null;
    data.sessions[index] = { ...data.sessions[index], ...updates, updatedAt: new Date().toISOString() };
    this.writeStore(data);
    return data.sessions[index];
  }

  getSession(sessionIdOrKey = "") {
    const token = String(sessionIdOrKey || "").trim();
    return this.readStore().sessions.find((item) => item.id === token || item.key === token || item.label === token) || null;
  }

  listSessions({ limit = 25, status = "" } = {}) {
    let sessions = this.readStore().sessions.slice().reverse();
    if (status) {
      sessions = sessions.filter((item) => item.status === status);
    }
    return {
      sessions: sessions
        .slice(0, toPositiveInt(limit, 25, 1, 200))
        .map((session) => ({
          ...session,
          runtimeMetadata: getAcpSessionRuntimeMetadata(session),
        })),
    };
  }

  async spawn(input = {}, context = {}) {
    const config = this.getConfig();
    const agentId = normalizeAgentId(input.agentId, config.defaultAgent);
    const task = String(input.task || input.prompt || "").trim();
    const mode = String(input.mode || "run").trim().toLowerCase();
    const cwd = String(input.cwd || "").trim();
    const label = String(input.label || `${agentId}-acp`).trim();
    const timeoutSeconds = toPositiveInt(input.timeoutSeconds || config.timeoutSeconds, config.timeoutSeconds, 1, 86400);
    if (!config.enabled) {
      return { ok: false, blocked: true, reason: "acp-disabled", message: "ACP is disabled by config acp.enabled=false." };
    }
    if (!config.dispatchEnabled) {
      return { ok: false, blocked: true, reason: "acp-dispatch-disabled", message: "ACP dispatch is paused by config acp.dispatch.enabled=false." };
    }
    if (!this.isAgentAllowed(agentId)) {
      return { ok: false, blocked: true, reason: "agent-not-allowed", agentId, allowedAgents: config.allowedAgents };
    }
    if (!task && mode !== "session" && mode !== "persistent") {
      return { ok: false, blocked: true, reason: "missing-task", message: "ACP spawn needs a task/prompt unless mode=session or persistent." };
    }
    const running = this.listSessions({ limit: 200 }).sessions.filter((session) => session.status === "running").length;
    if (running >= config.maxConcurrentSessions) {
      return { ok: false, blocked: true, reason: "max-concurrent-sessions", running, maxConcurrentSessions: config.maxConcurrentSessions };
    }
    const probe = await this.probeExecutable(this.resolveAgentConfig(agentId).command);
    if (!probe.ok) {
      return {
        ok: false,
        blocked: true,
        reason: "harness-command-not-found",
        agentId,
        command: this.resolveAgentConfig(agentId).command,
        install: this.installInstructions({ agentId }),
      };
    }
    const id = createId("acp");
    const key = `agent:${agentId}:acp:${id}`;
    const startedAt = new Date().toISOString();
    const built = this.buildCommand({
      agentId,
      task,
      cwd,
      model: input.model || "",
      permissions: input.permissions || config.permissionMode,
      timeoutSeconds,
    });
    const session = this.upsertSession({
      id,
      key,
      label,
      agentId,
      runtime: "acp",
      backend: config.backend,
      mode,
      status: "running",
      task,
      cwd: cwd || ".",
      command: built.displayCommand,
      parentSessionId: context.sessionId || input.parentSessionId || "",
      parentRunId: context.runId || input.parentRunId || "",
      processId: "",
      startedAt,
      timeoutSeconds,
      options: {
        model: input.model || "",
        permissions: input.permissions || config.permissionMode,
      },
    });
    this.gateway?.addEvent?.("acp.session_started", {
      acpSessionId: id,
      acpSessionKey: key,
      agentId,
      mode,
      parentSessionId: session.parentSessionId,
      parentRunId: session.parentRunId,
    });
    let execution;
    try {
      execution = await this.shellExecutor.execute({
        command: built.command,
        cwd: cwd || ".",
        background: mode !== "run",
        runId: context.runId || "",
        sessionId: context.sessionId || "",
      });
    } catch (error) {
      const failed = this.updateSession(id, {
        status: "failed",
        error: error.message,
        completedAt: new Date().toISOString(),
      });
      this.gateway?.addEvent?.("acp.session_failed", { acpSessionId: id, acpSessionKey: key, agentId, error: error.message });
      return { ok: false, blocked: true, reason: "spawn-failed", session: failed, error: error.message };
    }

    const completedStatus = execution.status === "completed" || execution.status === "started" ? execution.status : "failed";
    const updated = this.updateSession(id, {
      status: mode === "run" ? (completedStatus === "completed" ? "completed" : "failed") : "running",
      processId: execution.processId || "",
      pid: execution.pid || null,
      execution,
      completedAt: mode === "run" ? new Date().toISOString() : "",
      exitCode: execution.exitCode,
      stdoutPreview: String(execution.stdout || "").slice(0, 4000),
      stderrPreview: String(execution.stderr || "").slice(0, 4000),
    });
    this.gateway?.addEvent?.(mode === "run" ? "acp.session_completed" : "acp.session_spawned", {
      acpSessionId: id,
      acpSessionKey: key,
      agentId,
      status: updated.status,
      processId: updated.processId,
      exitCode: updated.exitCode,
    });
    return {
      ok: updated.status !== "failed",
      accepted: true,
      session: updated,
      childSessionKey: key,
      execution,
      nextAction: mode === "run" ? "Inspect stdout/stderr and continue if needed." : "Use acp_status/acp_sessions/process_status to monitor the background harness.",
    };
  }

  status(input = {}) {
    const token = String(input.sessionId || input.sessionKey || input.label || "").trim();
    const session = token ? this.getSession(token) : null;
    const config = this.getConfig();
    return {
      ok: true,
      backend: config.backend,
      enabled: config.enabled,
      dispatchEnabled: config.dispatchEnabled,
      defaultAgent: config.defaultAgent,
      allowedAgents: config.allowedAgents,
      permissionMode: config.permissionMode,
      session: session
        ? {
            ...session,
            runtimeMetadata: getAcpSessionRuntimeMetadata(session),
          }
        : null,
      sessions: token ? [] : this.listSessions({ limit: Number(input.limit || 10) }).sessions,
    };
  }

  async cancel(input = {}) {
    const token = String(input.sessionId || input.sessionKey || input.label || "").trim();
    const session = this.getSession(token);
    if (!session) {
      return { ok: false, reason: "session-not-found", token };
    }
    let kill = null;
    if (session.processId && this.shellExecutor?.killProcess) {
      kill = this.shellExecutor.killProcess(session.processId);
    }
    const updated = this.updateSession(session.id, {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      cancelResult: kill,
    });
    this.gateway?.addEvent?.("acp.session_cancelled", { acpSessionId: session.id, acpSessionKey: session.key, processId: session.processId || "" });
    return { ok: true, session: updated, kill };
  }

  close(input = {}) {
    const token = String(input.sessionId || input.sessionKey || input.label || "").trim();
    const session = this.getSession(token);
    if (!session) {
      return { ok: false, reason: "session-not-found", token };
    }
    const updated = this.updateSession(session.id, {
      status: ["completed", "failed", "cancelled"].includes(session.status) ? session.status : "closed",
      closedAt: new Date().toISOString(),
    });
    this.gateway?.addEvent?.("acp.session_closed", { acpSessionId: session.id, acpSessionKey: session.key });
    return { ok: true, session: updated };
  }

  setOption(input = {}) {
    const token = String(input.sessionId || input.sessionKey || input.label || "").trim();
    const session = token ? this.getSession(token) : null;
    const key = String(input.key || "").trim();
    const value = input.value;
    if (!key) {
      return { ok: false, reason: "missing-key" };
    }
    if (!session) {
      this.configStore.updateUserConfig({ acp: { [key]: value } });
      return { ok: true, scope: "config", key, value };
    }
    const options = { ...(session.options || {}), [key]: value };
    const updated = this.updateSession(session.id, { options });
    return { ok: true, scope: "session", session: updated, key, value };
  }

  parseSlashCommand(message = "") {
    const raw = String(message || "").trim();
    if (!raw.toLowerCase().startsWith("/acp")) return null;
    const parts = splitCommandLine(raw);
    const command = String(parts[1] || "status").toLowerCase();
    const args = parts.slice(2);
    const { flags, rest } = stripFlags(args);
    return { command, args, flags, rest, raw };
  }

  async handleSlashCommand(message, context = {}) {
    const parsed = this.parseSlashCommand(message);
    if (!parsed) return null;
    const [first, ...tail] = parsed.rest;
    if (parsed.command === "doctor") {
      return this.doctor({ agentId: first || parsed.flags.agent });
    }
    if (parsed.command === "install") {
      return this.installInstructions({ agentId: first || parsed.flags.agent });
    }
    if (parsed.command === "sessions") {
      return this.listSessions({ limit: Number(parsed.flags.limit || first || 25) });
    }
    if (parsed.command === "status") {
      return this.status({ sessionId: first || parsed.flags.session || "", limit: Number(parsed.flags.limit || 10) });
    }
    if (parsed.command === "spawn") {
      const agentId = first || parsed.flags.agent || this.getConfig().defaultAgent;
      const task = parsed.flags.task || parsed.flags.prompt || tail.join(" ");
      return this.spawn({
        agentId,
        task,
        cwd: parsed.flags.cwd || "",
        mode: parsed.flags.mode || (parsed.flags.bind || parsed.flags.thread ? "session" : "run"),
        label: parsed.flags.label || "",
        model: parsed.flags.model || "",
        permissions: parsed.flags.permissions || "",
        timeoutSeconds: parsed.flags.timeout || parsed.flags.timeoutSeconds || 0,
      }, context);
    }
    if (parsed.command === "cancel") {
      return this.cancel({ sessionId: first || parsed.flags.session || "" });
    }
    if (parsed.command === "close") {
      return this.close({ sessionId: first || parsed.flags.session || "" });
    }
    if (["model", "permissions", "timeout", "cwd", "set"].includes(parsed.command)) {
      const key = parsed.command === "set" ? first : parsed.command;
      const value = parsed.command === "set" ? tail.join(" ") : parsed.rest.join(" ");
      return this.setOption({ sessionId: parsed.flags.session || "", key, value });
    }
    return {
      ok: false,
      reason: "unknown-acp-command",
      command: parsed.command,
      supported: ["doctor", "install", "spawn", "sessions", "status", "cancel", "close", "model", "permissions", "timeout", "cwd", "set"],
    };
  }

  formatSlashReply(result = {}) {
    if (!result) return "";
    if (Array.isArray(result.sessions)) {
      if (result.sessions.length === 0) return "ACP sessions: none yet.";
      return [
        "ACP sessions:",
        ...result.sessions.slice(0, 12).map((session) =>
          `- ${session.key || session.id} | ${session.agentId} | ${session.status} | ${session.label || ""}`.trim(),
        ),
      ].join("\n");
    }
    if (result.targetAgent && result.commands) {
      return [
        `ACP install/setup for ${result.targetAgent}:`,
        result.summary,
        "",
        ...result.commands.map((command) => `- ${command}`),
      ].join("\n");
    }
    if (result.acpx || result.agentCommand) {
      return [
        `ACP doctor: ${result.ok ? "ready" : "not ready"}`,
        `Backend: ${result.backend}; enabled=${result.enabled}; dispatch=${result.dispatchEnabled}`,
        `Target: ${result.targetAgent}; allowed=${result.allowed}`,
        `Harness command: ${result.agentCommand?.command || ""} ${result.agentCommand?.installed ? "found" : "missing"}`,
        `acpx: ${result.acpx?.installed ? "found" : "missing"} (${result.acpx?.note || ""})`,
        `Next: ${result.nextAction || ""}`,
      ].join("\n");
    }
    if (result.childSessionKey || result.session) {
      const session = result.session || {};
      return [
        `ACP session ${result.ok === false ? "failed" : "accepted"}: ${session.key || result.childSessionKey || session.id || ""}`,
        `Agent: ${session.agentId || ""}; status: ${session.status || ""}; mode: ${session.mode || ""}`,
        session.processId ? `Process: ${session.processId}` : "",
        session.error ? `Error: ${session.error}` : "",
        session.stderrPreview ? `stderr: ${session.stderrPreview.slice(0, 1000)}` : "",
        session.stdoutPreview ? `stdout: ${session.stdoutPreview.slice(0, 1000)}` : "",
        result.nextAction ? `Next: ${result.nextAction}` : "",
      ].filter(Boolean).join("\n");
    }
    return JSON.stringify(result, null, 2);
  }
}
