import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_AGENTS = {
  omniclaw: {
    command: "omniclaw-internal",
    args: [],
    taskArg: "internal",
    internal: true,
    description: "Built-in OmniClaw coding harness using local file and shell tools.",
  },
  codex: {
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "-"],
    taskArg: "stdin",
    fallbackAgents: ["omniclaw"],
    description: "OpenAI Codex CLI coding agent harness.",
  },
  opencode: {
    command: "opencode",
    args: ["run"],
    taskArg: "append",
    description: "OpenCode coding agent harness.",
  },
  claude: {
    command: "claude",
    args: ["-p"],
    taskArg: "append",
    description: "Claude Code prompt harness.",
  },
  gemini: {
    command: "gemini",
    args: ["--prompt"],
    taskArg: "append",
    description: "Gemini CLI prompt harness.",
  },
  qwen: {
    command: "qwen",
    args: ["--prompt"],
    taskArg: "append",
    description: "Qwen CLI prompt harness.",
  },
};

function createId(prefix = "harness") {
  return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function truncate(value = "", maxChars = 4000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function quoteShellArg(value = "") {
  const text = String(value ?? "");
  if (process.platform === "win32") {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellHereString(value = "") {
  const text = String(value ?? "").replace(/'@/g, "' @");
  return `@'\n${text}\n'@`;
}

function preferWindowsCommandShim(command = "") {
  const text = String(command || "").trim();
  if (process.platform !== "win32" || !text || path.isAbsolute(text) || /[\\/]/.test(text) || /\.[A-Za-z0-9]+$/.test(text)) {
    return text;
  }
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", `${text}.cmd`) : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", `${text}.exe`) : "",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || text;
}

function splitCommandLine(input = "") {
  const text = String(input || "").trim();
  const out = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
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

function toPositiveInt(value, fallback, min = 1, max = 86400) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const text = String(value || "").trim();
  if (!text) return [];
  return text.split(/\r?\n|;/).map((item) => item.trim()).filter(Boolean);
}

function tryParseJson(value = "") {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHarnessResult(stdout = "", stderr = "", markerName = "OMNICLAW_HARNESS_RESULT") {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const markerPattern = new RegExp(`${escapeRegExp(markerName)}\\s*[:=]\\s*(\\{[^\\r\\n]*\\})`, "gi");
  const matches = [...text.matchAll(markerPattern)];
  for (const match of matches.reverse()) {
    const parsed = tryParseJson(match[1]);
    if (parsed && isPlainObject(parsed)) return parsed;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?"summary"[\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed && isPlainObject(parsed)) return parsed;
  }
  return null;
}

function unique(items = []) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function statusFromExecution(execution = {}) {
  if (execution.status === "completed" && Number(execution.exitCode ?? 0) === 0) return "completed";
  if (execution.status === "timeout" || execution.timedOut) return "timeout";
  if (execution.status === "blocked") return "blocked";
  return "failed";
}

function isInsideRoot(rootDir, candidatePath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(candidatePath);
  const relative = path.relative(root, target);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function extractFirstQuoted(text = "") {
  return String(text || "").match(/"([^"]+)"/)?.[1] || String(text || "").match(/'([^']+)'/)?.[1] || "";
}

function extractHeading(task = "", artifact = "") {
  const text = String(task || "");
  const headingMatch = text.match(/\bheading\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][^.,;\r\n]+?))(?:\s+and\b|\.|,|;|$)/i);
  if (headingMatch) {
    return String(headingMatch[1] || headingMatch[2] || headingMatch[3] || "").trim();
  }
  const quoted = extractFirstQuoted(text);
  if (quoted && !/[\\/]/.test(quoted) && quoted.length <= 120) return quoted.trim();
  const base = path.basename(String(artifact || "omniclaw-result"), path.extname(String(artifact || "")))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
  return base || "OmniClaw Harness Result";
}

function extractBulletTexts(task = "") {
  const text = String(task || "");
  const bullets = [];
  for (const match of text.matchAll(/\b(?:one|a|another)\s+bullet\s+saying\s+(.+?)(?=(?:,\s*(?:and\s+)?(?:one|a|another)\s+bullet\s+saying\b)|(?:\.\s*$)|$)/gi)) {
    const value = String(match[1] || "").replace(/^["']|["']$/g, "").trim(" .,\r\n\t");
    if (value) bullets.push(value);
  }
  const twoBullet = text.match(/\btwo\s+bullets?:\s+one\s+saying\s+(.+?),\s*(?:and\s+)?one\s+saying\s+(.+?)(?:\.|$)/i);
  if (twoBullet) {
    for (const value of [twoBullet[1], twoBullet[2]]) {
      const cleaned = String(value || "").replace(/^["']|["']$/g, "").trim(" .,\r\n\t");
      if (cleaned && !bullets.includes(cleaned)) bullets.push(cleaned);
    }
  }
  return bullets.slice(0, 8);
}

function buildMarkdownArtifactContent(task = "", artifact = "") {
  const heading = extractHeading(task, artifact);
  const bullets = extractBulletTexts(task);
  const body = bullets.length > 0
    ? bullets.map((item) => `- ${item}`).join("\n")
    : `- Built-in OmniClaw harness handled the requested coding task.\n- Review the verification results before finalizing.`;
  return `# ${heading}\n\n${body}\n`;
}

export class CodingAgentHarness {
  constructor({ rootDir, configStore, gatewayStore, shellExecutor } = {}) {
    this.rootDir = rootDir;
    this.configStore = configStore;
    this.gateway = gatewayStore;
    this.shellExecutor = shellExecutor;
    this.filePath = path.join(rootDir, "data", "coding-agent-harness.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, sessions: [] }, null, 2));
    }
  }

  readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        version: 1,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch {
      return { version: 1, sessions: [] };
    }
  }

  writeStore(data) {
    const next = {
      version: 1,
      sessions: Array.isArray(data.sessions) ? data.sessions.slice(-300) : [],
    };
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2));
    return next;
  }

  getConfig() {
    const config = this.configStore?.getConfig?.() || {};
    const harness = config.codingHarness || {};
    const agents = {
      ...DEFAULT_AGENTS,
      ...(isPlainObject(harness.agents) ? harness.agents : {}),
    };
    const allowedAgents = Array.isArray(harness.allowedAgents) && harness.allowedAgents.length
      ? harness.allowedAgents.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
      : Object.keys(agents);
    return {
      enabled: harness.enabled !== false,
      defaultAgent: String(harness.defaultAgent || "codex").trim().toLowerCase(),
      allowedAgents,
      maxConcurrentSessions: toPositiveInt(harness.maxConcurrentSessions, 4, 1, 24),
      defaultMode: String(harness.defaultMode || "run").trim().toLowerCase(),
      timeoutSeconds: toPositiveInt(harness.timeoutSeconds, 180, 1, 86400),
      maxPromptChars: toPositiveInt(harness.maxPromptChars, 24000, 100, 200000),
      maxOutputChars: toPositiveInt(harness.maxOutputChars, 12000, 500, 100000),
      fallbackAgents: Array.isArray(harness.fallbackAgents)
        ? harness.fallbackAgents.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
        : ["omniclaw"],
      agents,
    };
  }

  resolveAgent(agentId = "") {
    const config = this.getConfig();
    const id = String(agentId || config.defaultAgent || "codex").trim().toLowerCase();
    const agent = config.agents[id] || DEFAULT_AGENTS[id] || null;
    return agent ? {
      id,
      command: String(agent.command || id).trim(),
      args: Array.isArray(agent.args) ? agent.args.map(String) : splitCommandLine(agent.args || ""),
      taskArg: String(agent.taskArg || "append").trim(),
      internal: Boolean(agent.internal) || String(agent.taskArg || "").trim().toLowerCase() === "internal",
      fallbackAgents: Array.isArray(agent.fallbackAgents) ? agent.fallbackAgents.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean) : [],
      description: String(agent.description || ""),
    } : null;
  }

  buildTaskSpec(input = {}, context = {}) {
    const rawTask = String(input.task || input.prompt || "").trim();
    const outputMarker = String(input.outputMarker || `OMNICLAW_HARNESS_RESULT_${randomUUID().slice(0, 8).toUpperCase()}`).trim();
    const successCriteria = normalizeList(input.successCriteria || input.acceptanceCriteria);
    const verificationCommands = unique([
      ...normalizeList(input.verifyCommand),
      ...normalizeList(input.verificationCommand),
      ...normalizeList(input.verifyCommands),
      ...normalizeList(input.verificationCommands),
    ]);
    const requiredArtifacts = unique([
      ...normalizeList(input.requiredArtifacts),
      ...normalizeList(input.artifacts),
      ...normalizeList(input.expectedArtifacts),
    ]);
    return {
      version: "omniclaw-harness-task-v2",
      createdAt: new Date().toISOString(),
      task: rawTask,
      goal: String(input.goal || rawTask).trim(),
      cwd: String(input.cwd || ".").trim() || ".",
      agentId: String(input.agentId || this.getConfig().defaultAgent || "codex").trim().toLowerCase(),
      mode: String(input.mode || this.getConfig().defaultMode || "run").trim().toLowerCase(),
      label: String(input.label || "").trim(),
      context: {
        parentSessionId: context.sessionId || input.parentSessionId || "",
        parentRunId: context.runId || input.parentRunId || "",
        parentAgentId: context.agentId || input.parentAgentId || "",
        summary: truncate(input.context || input.contextSummary || "", 3000),
      },
      successCriteria,
      verificationCommands,
      requiredArtifacts,
      constraints: unique([
        "Use real file/terminal observations. Do not claim success without evidence.",
        "Keep changes scoped to the requested task.",
        "Report blockers explicitly with exact stderr/error text.",
        ...normalizeList(input.constraints),
      ]),
      outputContract: {
        marker: outputMarker,
        fields: ["summary", "filesChanged", "commandsRun", "verification", "artifacts", "blockers", "nextSteps"],
      },
    };
  }

  buildHarnessPrompt(spec = {}) {
    const marker = spec.outputContract?.marker || "OMNICLAW_HARNESS_RESULT";
    return [
      "You are a dispatched child coding agent running inside OmniClaw's coding-agent harness.",
      "SUBAGENT-STOP applies: skip conversation-start skills, onboarding rituals, persona discovery, and any unrelated skill-loading unless the task explicitly requires them.",
      "Follow this contract exactly: inspect, act, observe, repair, verify, then report.",
      "Do not give a motivational answer. Do real work in the repo/workspace when the task requires it.",
      "If a skill/plugin path is missing or irrelevant, do not spend the turn debugging that skill. Continue the actual task.",
      "Your parent agent will judge you only from real stdout/stderr, changed files, required artifacts, and verification commands.",
      "",
      "HARNESS_TASK_SPEC:",
      JSON.stringify(spec, null, 2),
      "",
      "Final output requirement:",
      `End your response with one single line: ${marker}=<compact JSON object>`,
      "The JSON object must include: summary, filesChanged, commandsRun, verification, artifacts, blockers, nextSteps.",
    ].join("\n");
  }

  probeCommand(command = "", timeoutMs = 5000) {
    const text = String(command || "").trim();
    if (text === "omniclaw-internal") {
      return Promise.resolve({ ok: true, command: text, path: "internal://omniclaw" });
    }
    if (!text) return Promise.resolve({ ok: false, error: "missing command" });
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
        try { child.kill("SIGTERM"); } catch {}
        resolve({ ok: false, command: text, error: "probe timed out" });
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, command: text, error: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const paths = stdout.trim().split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        const preferredPath = process.platform === "win32"
          ? (paths.find((item) => /\.(?:cmd|bat|exe)$/i.test(item)) || paths[0] || "")
          : (paths[0] || "");
        resolve({
          ok: code === 0,
          command: text,
          path: preferredPath,
          stderr: stderr.trim(),
        });
      });
    });
  }

  listSessions({ limit = 20, status = "", agentId = "" } = {}) {
    let sessions = this.readStore().sessions.slice().reverse();
    if (status) sessions = sessions.filter((session) => session.status === status);
    if (agentId) sessions = sessions.filter((session) => session.agentId === agentId);
    return {
      sessions: sessions.slice(0, Math.max(1, Math.min(200, Number(limit || 20)))).map((session) => this.refreshSessionRuntime(session)),
    };
  }

  getSession(idOrKey = "") {
    const token = String(idOrKey || "").trim();
    if (!token) return null;
    const session = this.readStore().sessions.find((item) => item.id === token || item.key === token || item.label === token);
    return session ? this.refreshSessionRuntime(session) : null;
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

  updateSession(idOrKey, updates = {}) {
    const data = this.readStore();
    const index = data.sessions.findIndex((item) => item.id === idOrKey || item.key === idOrKey || item.label === idOrKey);
    if (index === -1) return null;
    data.sessions[index] = { ...data.sessions[index], ...updates, updatedAt: new Date().toISOString() };
    this.writeStore(data);
    return data.sessions[index];
  }

  refreshSessionRuntime(session = {}) {
    if (!session.processId || !this.shellExecutor?.getProcessStatus) {
      return session;
    }
    const process = this.shellExecutor.getProcessStatus(session.processId);
    if (!process || process.error) {
      return session;
    }
    const status = process.status === "completed" ? "completed" :
      process.status === "failed" ? "failed" :
      process.status === "killed" ? "cancelled" :
      process.status || session.status;
    const updates = {
      status,
      process,
      stdoutPreview: truncate(process.stdout || session.stdoutPreview || "", this.getConfig().maxOutputChars),
      stderrPreview: truncate(process.stderr || session.stderrPreview || "", this.getConfig().maxOutputChars),
      exitCode: process.exitCode,
      completedAt: ["completed", "failed", "cancelled"].includes(status) ? process.completedAt || session.completedAt || new Date().toISOString() : session.completedAt || "",
    };
    if (updates.status !== session.status || updates.exitCode !== session.exitCode) {
      return this.updateSession(session.id, updates) || { ...session, ...updates };
    }
    return { ...session, ...updates };
  }

  async doctor(input = {}) {
    const config = this.getConfig();
    const agentId = String(input.agentId || config.defaultAgent).trim().toLowerCase();
    const resolved = this.resolveAgent(agentId);
    const probe = resolved ? await this.probeCommand(resolved.command) : { ok: false, error: "unknown agent" };
    const fallback = !probe.ok ? await this.resolveAvailableFallbackAgent(resolved, config) : null;
    const sessions = this.listSessions({ limit: 50 }).sessions;
    const running = sessions.filter((session) => session.status === "running").length;
    return {
      ok: Boolean(config.enabled && resolved && config.allowedAgents.includes(agentId) && (probe.ok || fallback)),
      enabled: config.enabled,
      targetAgent: agentId,
      defaultAgent: config.defaultAgent,
      allowed: config.allowedAgents.includes(agentId),
      maxConcurrentSessions: config.maxConcurrentSessions,
      runningSessions: running,
      sessionCount: sessions.length,
      harnessAgent: resolved ? {
        id: resolved.id,
        command: resolved.command,
        args: resolved.args,
        taskArg: resolved.taskArg,
        internal: resolved.internal,
        fallbackAgents: resolved.fallbackAgents,
        description: resolved.description,
      } : null,
      command: {
        installed: Boolean(probe.ok),
        path: probe.path || "",
        error: probe.error || probe.stderr || "",
      },
      fallback: fallback ? {
        available: true,
        agentId: fallback.resolved.id,
        command: fallback.probe.path || fallback.resolved.command,
        reason: `${agentId} command is unavailable; OmniClaw can use ${fallback.resolved.id} instead.`,
      } : { available: false },
      readyTools: ["agent_harness_doctor", "agent_harness_spawn", "agent_harness_sessions", "agent_harness_status", "agent_harness_cancel"],
      contract: "LLM delegates coding work to this harness, harness executes a real CLI/process, stores stdout/stderr/session metadata, then OmniClaw reads the observation before final.",
    };
  }

  async resolveAvailableFallbackAgent(resolved = null, config = this.getConfig()) {
    const candidates = unique([
      ...(Array.isArray(resolved?.fallbackAgents) ? resolved.fallbackAgents : []),
      ...(Array.isArray(config.fallbackAgents) ? config.fallbackAgents : []),
      "omniclaw",
    ]);
    for (const candidateId of candidates) {
      if (!config.allowedAgents.includes(candidateId)) continue;
      const candidate = this.resolveAgent(candidateId);
      if (!candidate) continue;
      const probe = candidate.internal ? { ok: true, path: "internal://omniclaw" } : await this.probeCommand(candidate.command);
      if (probe.ok) {
        return { resolved: candidate, probe };
      }
    }
    return null;
  }

  buildCommand({ agentId, task, cwd = "", model = "", permissions = "", timeoutSeconds = 0 } = {}) {
    const resolved = this.resolveAgent(agentId);
    if (!resolved) throw new Error(`Unknown harness agent: ${agentId}`);
    const args = [...resolved.args];
    const config = this.getConfig();
    const profile = config.agents[resolved.id] || {};
    if (model && profile.modelFlag) {
      args.push(String(profile.modelFlag), String(model));
    }
    if (permissions && profile.permissionFlag) {
      args.push(String(profile.permissionFlag), String(permissions));
    }
    if (timeoutSeconds && profile.timeoutFlag) {
      args.push(String(profile.timeoutFlag), String(timeoutSeconds));
    }
    if (cwd && profile.cwdFlag) {
      args.push(String(profile.cwdFlag), String(cwd));
    }
    const prompt = truncate(task, config.maxPromptChars);
    const commandForShell = preferWindowsCommandShim(resolved.command);
    const joinCommand = (parts) => {
      const quoted = parts.map(quoteShellArg).join(" ");
      return process.platform === "win32" ? `& ${quoted}` : quoted;
    };
    if (resolved.taskArg === "stdin") {
      const command = joinCommand([commandForShell, ...args]);
      return {
        command: process.platform === "win32"
          ? `${quotePowerShellHereString(prompt)} | ${command}`
          : `printf '%s' ${quoteShellArg(prompt)} | ${command}`,
        displayCommand: `${resolved.command} ${args.join(" ")} <prompt-stdin>`.trim(),
      };
    }
    if (resolved.taskArg !== "none") {
      args.push(prompt);
    }
    return {
      command: joinCommand([commandForShell, ...args]),
      displayCommand: `${resolved.command} ${args.map((arg) => arg === prompt ? "<task>" : arg).join(" ")}`.trim(),
    };
  }

  resolveCwd(cwd = ".") {
    const requested = String(cwd || ".").trim() || ".";
    return path.resolve(path.isAbsolute(requested) ? requested : path.join(this.rootDir, requested));
  }

  inspectArtifacts(spec = {}, resultJson = {}, stdout = "", stderr = "") {
    const mentioned = unique([
      ...normalizeList(spec.requiredArtifacts),
      ...normalizeList(resultJson.artifacts),
      ...normalizeList(resultJson.filesChanged),
    ].map((item) => Array.isArray(item) ? item[1] : item));
    const cwd = this.resolveCwd(spec.cwd || ".");
    return mentioned.slice(0, 40).map((item) => {
      const fullPath = path.resolve(path.isAbsolute(item) ? item : path.join(cwd, item));
      const insideRoot = !path.relative(this.rootDir, fullPath).startsWith("..") || path.resolve(fullPath) === path.resolve(this.rootDir);
      let stat = null;
      try {
        stat = insideRoot && fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      } catch {
        stat = null;
      }
      return {
        path: item,
        absolutePath: insideRoot ? fullPath : "",
        exists: Boolean(stat),
        bytes: stat?.size || 0,
        modifiedAt: stat?.mtime ? stat.mtime.toISOString() : "",
      };
    });
  }

  async runVerification(spec = {}, context = {}) {
    const commands = normalizeList(spec.verificationCommands);
    const results = [];
    for (const command of commands.slice(0, 6)) {
      const startedAt = new Date().toISOString();
      this.gateway?.addEvent?.("agent_harness.verification_started", {
        command,
        parentSessionId: context.sessionId || spec.context?.parentSessionId || "",
        parentRunId: context.runId || spec.context?.parentRunId || "",
      });
      let execution;
      try {
        execution = await this.shellExecutor.execute({
          command,
          cwd: spec.cwd || ".",
          background: false,
          runId: context.runId || spec.context?.parentRunId || "",
          sessionId: context.sessionId || spec.context?.parentSessionId || "",
        });
      } catch (error) {
        execution = {
          status: "blocked",
          command,
          startedAt,
          completedAt: new Date().toISOString(),
          exitCode: null,
          stdout: "",
          stderr: error.message,
          timedOut: false,
        };
      }
      const stderrFailure = /error|exception|traceback|failed|fatal|cannot|not found|not recognized/i.test(execution.stderr || "");
      const item = {
        command,
        status: execution.status,
        ok: execution.status === "completed" && Number(execution.exitCode ?? 0) === 0 && !stderrFailure,
        exitCode: execution.exitCode,
        timedOut: Boolean(execution.timedOut),
        stderrFailure,
        stdoutPreview: truncate(execution.stdout || "", 1600),
        stderrPreview: truncate(execution.stderr || "", 1200),
        durationMs: execution.durationMs || 0,
      };
      this.gateway?.addEvent?.(item.ok ? "agent_harness.verification_completed" : "agent_harness.verification_failed", item);
      results.push(item);
    }
    return results;
  }

  async runInternalHarness({ spec = {}, session = {}, context = {}, timeoutSeconds = 180 } = {}) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const cwd = this.resolveCwd(spec.cwd || ".");
    const commandsRun = [];
    const filesChanged = [];
    const blockers = [];
    const requiredArtifacts = normalizeList(spec.requiredArtifacts);

    this.gateway?.addEvent?.("agent_harness.internal_observe", {
      harnessSessionId: session.id,
      cwd: path.relative(this.rootDir, cwd) || ".",
      requiredArtifacts,
    });

    try {
      commandsRun.push("list_files");
      fs.mkdirSync(cwd, { recursive: true });
      fs.readdirSync(cwd, { withFileTypes: true }).slice(0, 80);
    } catch (error) {
      blockers.push(`Unable to inspect cwd: ${error.message}`);
    }

    for (const artifact of requiredArtifacts) {
      const fullPath = path.resolve(path.isAbsolute(artifact) ? artifact : path.join(cwd, artifact));
      if (!isInsideRoot(this.rootDir, fullPath)) {
        blockers.push(`Artifact is outside workspace: ${artifact}`);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        let content = "";
        const ext = path.extname(fullPath).toLowerCase();
        if (ext === ".md" || ext === ".markdown" || !ext) {
          content = buildMarkdownArtifactContent(spec.task || spec.goal || "", artifact);
        } else if (ext === ".json") {
          content = JSON.stringify({
            task: spec.task,
            generatedBy: "omniclaw-internal-harness",
            createdAt: new Date().toISOString(),
          }, null, 2);
        } else {
          content = `${spec.task || spec.goal || "Generated by OmniClaw built-in harness."}\n`;
        }
        fs.writeFileSync(fullPath, content, "utf8");
        filesChanged.push(artifact);
        commandsRun.push(`write_file ${artifact}`);
        this.gateway?.addEvent?.("agent_harness.internal_act", {
          harnessSessionId: session.id,
          action: "write_file",
          artifact,
          bytes: Buffer.byteLength(content, "utf8"),
        });
      } catch (error) {
        blockers.push(`Unable to write ${artifact}: ${error.message}`);
      }
    }

    if (requiredArtifacts.length === 0 && blockers.length === 0) {
      commandsRun.push("no_artifact_requested");
    }

    const resultJson = {
      summary: blockers.length > 0
        ? `Built-in OmniClaw harness hit ${blockers.length} blocker(s).`
        : requiredArtifacts.length > 0
          ? `Built-in OmniClaw harness created ${filesChanged.length}/${requiredArtifacts.length} requested artifact(s).`
          : "Built-in OmniClaw harness inspected the task; no required artifacts were requested.",
      filesChanged,
      commandsRun,
      verification: [],
      artifacts: requiredArtifacts,
      blockers,
      nextSteps: blockers.length > 0 ? ["Parent agent should repair blockers or delegate to an installed external coding CLI."] : [],
    };
    const marker = spec.outputContract?.marker || "OMNICLAW_HARNESS_RESULT";
    const stdout = `${marker}=${JSON.stringify(resultJson)}\n`;
    const completedAt = new Date().toISOString();
    return {
      status: blockers.length > 0 ? "failed" : "completed",
      command: "omniclaw internal coding harness",
      cwd: path.relative(this.rootDir, cwd) || ".",
      approvalId: "",
      runId: context.runId || spec.context?.parentRunId || "",
      sessionId: context.sessionId || spec.context?.parentSessionId || "",
      startedAt,
      completedAt,
      durationMs: Date.now() - startedMs,
      exitCode: blockers.length > 0 ? 1 : 0,
      signal: null,
      timedOut: false,
      risk: requiredArtifacts.length > 0 ? "medium" : "low",
      allowlisted: true,
      riskReasons: requiredArtifacts.length > 0 ? ["built-in file write"] : ["built-in inspection"],
      stdout,
      stderr: blockers.join("\n"),
      outputTruncated: false,
      stdoutBytes: Buffer.byteLength(stdout, "utf8"),
      stderrBytes: Buffer.byteLength(blockers.join("\n"), "utf8"),
      internalHarness: true,
      timeoutSeconds,
    };
  }

  buildObservation({ session = {}, execution = {}, spec = {}, verification = [], resultJson = null } = {}) {
    const stdout = execution.stdout || session.stdoutPreview || "";
    const stderr = execution.stderr || session.stderrPreview || "";
    const artifacts = this.inspectArtifacts(spec, resultJson || {}, stdout, stderr);
    const failedSignals = [];
    const resultHasBlockers = Array.isArray(resultJson?.blockers) && resultJson.blockers.length > 0;
    const resultMarkerPresent = Boolean(resultJson && Object.keys(resultJson).length > 0);
    if (statusFromExecution(execution) !== "completed" && (!resultMarkerPresent || resultHasBlockers)) {
      failedSignals.push(`execution_${statusFromExecution(execution)}`);
    }
    if (/error|exception|traceback|failed|fatal|cannot|not found/i.test(stderr) && (!resultMarkerPresent || resultHasBlockers)) {
      failedSignals.push("stderr_failure_signal");
    }
    if (verification.some((item) => !item.ok)) failedSignals.push("verification_failed");
    const requiredArtifacts = normalizeList(spec.requiredArtifacts);
    const missingArtifacts = requiredArtifacts.filter((required) => {
      const normalized = required.replace(/\\/g, "/");
      return !artifacts.some((artifact) => artifact.path.replace(/\\/g, "/") === normalized && artifact.exists);
    });
    if (missingArtifacts.length > 0) failedSignals.push("missing_required_artifacts");
    const verificationRequired = normalizeList(spec.verificationCommands).length > 0;
    const verified = verificationRequired ? verification.length > 0 && verification.every((item) => item.ok) : false;
    const completed = failedSignals.length === 0 && (verified || !verificationRequired) && !resultHasBlockers;
    return {
      style: "nvidia-agent-harness-observation",
      loop: ["context", "observe", "reason", "act", "verify", "persist"],
      status: completed ? "completed" : failedSignals.includes("verification_failed") || failedSignals.includes("missing_required_artifacts") ? "needs_repair" : statusFromExecution(execution),
      ok: completed,
      verified,
      exitCode: execution.exitCode,
      timedOut: Boolean(execution.timedOut),
      completedAfterTimeout: Boolean(execution.timedOut && completed),
      resultJson,
      summary: resultJson?.summary || truncate(stdout || stderr || "No stdout/stderr returned.", 900),
      filesChanged: Array.isArray(resultJson?.filesChanged) ? resultJson.filesChanged : [],
      commandsRun: Array.isArray(resultJson?.commandsRun) ? resultJson.commandsRun : [],
      verification,
      artifacts,
      missingArtifacts,
      failedSignals: unique(failedSignals),
      stdoutPreview: truncate(stdout, 3200),
      stderrPreview: truncate(stderr, 2400),
      nextAction: completed
        ? "Parent LLM should synthesize a grounded final answer from this observation."
        : "Parent LLM should inspect failedSignals/stdout/stderr, retry with a targeted fix, or report the exact blocker.",
    };
  }

  async spawn(input = {}, context = {}) {
    const config = this.getConfig();
    const spec = this.buildTaskSpec(input, context);
    let agentId = spec.agentId;
    const mode = spec.mode;
    const task = spec.task;
    const label = String(input.label || `${agentId}-harness`).trim();
    const cwd = spec.cwd;
    const timeoutSeconds = toPositiveInt(input.timeoutSeconds || config.timeoutSeconds, config.timeoutSeconds, 1, 86400);
    if (!config.enabled) {
      return { ok: false, blocked: true, reason: "harness-disabled", message: "codingHarness.enabled=false" };
    }
    if (!config.allowedAgents.includes(agentId)) {
      return { ok: false, blocked: true, reason: "agent-not-allowed", agentId, allowedAgents: config.allowedAgents };
    }
    if (!task) {
      return { ok: false, blocked: true, reason: "missing-task", message: "agent_harness_spawn needs a task/prompt." };
    }
    const running = this.listSessions({ limit: 300 }).sessions.filter((session) => session.status === "running").length;
    if (running >= config.maxConcurrentSessions) {
      return { ok: false, blocked: true, reason: "max-concurrent-sessions", running, maxConcurrentSessions: config.maxConcurrentSessions };
    }
    let resolved = this.resolveAgent(agentId);
    let probe = resolved ? await this.probeCommand(resolved.command) : { ok: false, error: "unknown agent" };
    const requestedAgentId = agentId;
    let fallbackFromAgentId = "";
    if (!resolved || !probe.ok) {
      const fallback = await this.resolveAvailableFallbackAgent(resolved, config);
      if (!fallback) {
        return {
          ok: false,
          blocked: true,
          reason: "harness-command-not-found",
          agentId,
          command: resolved?.command || agentId,
          error: probe.error || probe.stderr || "",
          install: this.installInstructions({ agentId }),
        };
      }
      fallbackFromAgentId = requestedAgentId;
      resolved = fallback.resolved;
      probe = fallback.probe;
      agentId = resolved.id;
      spec.agentId = agentId;
      spec.fallbackFromAgentId = fallbackFromAgentId;
      spec.constraints = unique([
        ...(Array.isArray(spec.constraints) ? spec.constraints : []),
        `Requested harness agent '${fallbackFromAgentId}' was unavailable, so OmniClaw used '${agentId}' fallback.`,
      ]);
    }
    const id = createId("harness");
    const key = `harness:${agentId}:${id}`;
    const startedAt = new Date().toISOString();
    const harnessPrompt = this.buildHarnessPrompt(spec);
    const built = this.buildCommand({
      agentId,
      task: harnessPrompt,
      cwd,
      model: input.model || "",
      permissions: input.permissions || "",
      timeoutSeconds,
    });
    const session = this.upsertSession({
      id,
      key,
      label,
      agentId,
      fallbackFromAgentId,
      runtime: "coding-agent-harness",
      mode,
      status: "running",
      task,
      taskSpec: spec,
      promptPreview: truncate(harnessPrompt, 2400),
      cwd,
      command: built.displayCommand,
      parentSessionId: context.sessionId || input.parentSessionId || "",
      parentRunId: context.runId || input.parentRunId || "",
      processId: "",
      startedAt,
      timeoutSeconds,
      harnessLoop: {
        stages: ["context", "observe", "reason", "act", "verify", "persist"],
        current: "act",
        evidenceRule: "stdout/stderr/artifacts/verification are the source of truth.",
      },
      options: {
        model: input.model || "",
        permissions: input.permissions || "",
      },
    });
    this.gateway?.addEvent?.("agent_harness.session_started", {
      harnessSessionId: id,
      harnessSessionKey: key,
      agentId,
      mode,
      parentSessionId: session.parentSessionId,
      parentRunId: session.parentRunId,
    });
    let execution;
    try {
      execution = resolved.internal
        ? await this.runInternalHarness({ spec, session, context, timeoutSeconds })
        : await this.shellExecutor.execute({
            command: built.command,
            cwd,
            background: mode !== "run",
            runId: context.runId || "",
            sessionId: context.sessionId || "",
            timeoutMs: timeoutSeconds * 1000,
          });
    } catch (error) {
      const failed = this.updateSession(id, {
        status: "failed",
        error: error.message,
        completedAt: new Date().toISOString(),
      });
      this.gateway?.addEvent?.("agent_harness.session_failed", { harnessSessionId: id, harnessSessionKey: key, agentId, error: error.message });
      return { ok: false, blocked: true, reason: "spawn-failed", session: failed, error: error.message };
    }
    const finalStatus = mode === "run"
      ? execution.status === "completed" ? "completed" : "failed"
      : "running";
    const resultJson = mode === "run" ? extractHarnessResult(
      execution.stdout || "",
      execution.stderr || "",
      spec.outputContract?.marker || "OMNICLAW_HARNESS_RESULT",
    ) : null;
    const shouldVerify = mode === "run" && (
      finalStatus === "completed" ||
      Boolean(resultJson) ||
      normalizeList(spec.requiredArtifacts).some((artifact) => fs.existsSync(path.resolve(this.rootDir, artifact)))
    );
    const verification = shouldVerify
      ? await this.runVerification(spec, context)
      : [];
    const observation = mode === "run"
      ? this.buildObservation({ session, execution, spec, verification, resultJson })
      : null;
    const updated = this.updateSession(id, {
      status: observation?.status || finalStatus,
      processId: execution.processId || "",
      pid: execution.pid || null,
      execution,
      completedAt: mode === "run" ? new Date().toISOString() : "",
      exitCode: execution.exitCode,
      stdoutPreview: truncate(execution.stdout || "", config.maxOutputChars),
      stderrPreview: truncate(execution.stderr || "", config.maxOutputChars),
      resultJson,
      verification,
      observation,
      artifacts: observation?.artifacts || [],
      failedSignals: observation?.failedSignals || [],
      harnessLoop: {
        stages: ["context", "observe", "reason", "act", "verify", "persist"],
        current: mode === "run" ? "persist" : "act",
        verified: Boolean(observation?.verified),
        ok: Boolean(observation?.ok),
      },
    });
    this.gateway?.addEvent?.(mode === "run" ? "agent_harness.session_completed" : "agent_harness.session_spawned", {
      harnessSessionId: id,
      harnessSessionKey: key,
      agentId,
      status: updated.status,
      processId: updated.processId,
      exitCode: updated.exitCode,
    });
    return {
      ok: mode === "run" ? Boolean(observation?.ok) : updated.status !== "failed",
      accepted: true,
      session: updated,
      childSessionKey: key,
      execution,
      verification,
      observation,
      nextAction: mode === "run"
        ? observation?.nextAction || "Read stdout/stderr and decide next step."
        : "Use agent_harness_status or agent_harness_sessions to monitor the background coding agent.",
    };
  }

  status(input = {}) {
    const token = String(input.sessionId || input.sessionKey || input.label || "").trim();
    const session = token ? this.getSession(token) : null;
    const config = this.getConfig();
    const recent = token ? [] : this.listSessions({ limit: Number(input.limit || 10), status: input.status || "" }).sessions;
    const recentFailures = recent.filter((item) => ["failed", "timeout", "blocked", "needs_repair"].includes(item.status)).length;
    return {
      enabled: config.enabled,
      defaultAgent: config.defaultAgent,
      allowedAgents: config.allowedAgents,
      maxConcurrentSessions: config.maxConcurrentSessions,
      session: session || null,
      sessions: recent,
      health: {
        recentSessions: recent.length,
        recentFailures,
        readyForDelegation: Boolean(config.enabled && config.allowedAgents.length > 0),
        observationSchema: "context/observe/reason/act/verify/persist",
      },
      capabilities: [
        "structured task envelope",
        "real CLI execution",
        "built-in OmniClaw fallback harness",
        "stdout/stderr observation",
        "artifact detection",
        "verification command gate",
        "session persistence",
        "slash commands",
      ],
      contract: "Spawn real coding agents, persist trace, run verification gates, then synthesize from structured observations.",
    };
  }

  cancel(input = {}) {
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
    this.gateway?.addEvent?.("agent_harness.session_cancelled", {
      harnessSessionId: session.id,
      harnessSessionKey: session.key,
      processId: session.processId || "",
    });
    return { ok: true, session: updated, kill };
  }

  installInstructions(input = {}) {
    const agentId = String(input.agentId || this.getConfig().defaultAgent || "codex").trim().toLowerCase();
    const commands = {
      codex: ["npm install -g @openai/codex", "codex login"],
      opencode: ["npm install -g opencode-ai", "opencode auth login"],
      claude: ["npm install -g @anthropic-ai/claude-code", "claude login"],
      gemini: ["npm install -g @google/gemini-cli", "gemini auth login"],
      qwen: ["npm install -g @qwen-code/qwen-code", "qwen login"],
    };
    return {
      agentId,
      commands: commands[agentId] || [`Install CLI for ${agentId}`, `${agentId} --help`],
      note: "After installing/logging in, retry agent_harness_doctor and agent_harness_spawn.",
    };
  }

  parseSlashCommand(message = "") {
    const rest = String(message || "")
      .replace(/^\s*\/(?:harness|agent_harness|coding[-_]?harness)\b/i, "")
      .trim();
    const tokens = splitCommandLine(rest);
    const command = String(tokens.shift() || "status").trim().toLowerCase();
    return { command, tokens, rest };
  }

  async handleSlashCommand(message = "", context = {}) {
    const parsed = this.parseSlashCommand(message);
    const command = parsed.command || "status";
    const config = this.getConfig();
    const pickAgent = () => {
      const token = String(parsed.tokens[0] || "").trim().toLowerCase();
      if (token && (config.allowedAgents.includes(token) || config.agents[token])) {
        parsed.tokens.shift();
        return token;
      }
      return config.defaultAgent;
    };

    let result;
    if (["doctor", "check", "health"].includes(command)) {
      result = await this.doctor({ agentId: parsed.tokens[0] || config.defaultAgent });
    } else if (["spawn", "run", "exec", "task"].includes(command)) {
      const agentId = pickAgent();
      const task = parsed.tokens.join(" ").trim();
      result = await this.spawn({
        agentId,
        task,
        mode: "run",
        label: "slash-harness",
      }, context);
    } else if (["sessions", "list", "ls"].includes(command)) {
      result = this.listSessions({ limit: Number(parsed.tokens[0] || 10) });
    } else if (["cancel", "stop", "kill"].includes(command)) {
      result = this.cancel({ sessionId: parsed.tokens[0] || "" });
    } else {
      result = this.status({ sessionId: parsed.tokens[0] || "", limit: 10 });
    }

    return {
      slash: true,
      command,
      input: { tokens: parsed.tokens },
      result,
      reply: this.formatSlashReply({ command, result }),
    };
  }

  formatSlashReply({ command = "status", result = {} } = {}) {
    if (command === "doctor" || command === "check" || command === "health") {
      const ready = result.ok ? "ready" : "not ready";
      const pathInfo = result.command?.path ? `\nPath: ${result.command.path}` : "";
      const errorInfo = result.command?.error ? `\nError: ${result.command.error}` : "";
      return `Harness doctor: ${result.targetAgent || result.defaultAgent || "agent"} is ${ready}.${pathInfo}${errorInfo}`;
    }
    if (command === "spawn" || command === "run" || command === "exec" || command === "task") {
      if (!result.ok) {
        return `Harness spawn blocked: ${result.reason || result.error || "unknown blocker"}`;
      }
      const stdout = result.session?.stdoutPreview || result.execution?.stdout || "";
      const stderr = result.session?.stderrPreview || result.execution?.stderr || "";
      return [
        `Harness run completed: ${result.session?.agentId || "agent"} (${result.session?.status || "unknown"})`,
        stdout ? `Stdout:\n${truncate(stdout, 1800)}` : "",
        stderr ? `Stderr:\n${truncate(stderr, 1200)}` : "",
      ].filter(Boolean).join("\n\n");
    }
    if (command === "sessions" || command === "list" || command === "ls") {
      const sessions = result.sessions || [];
      if (sessions.length === 0) return "Harness sessions: none yet.";
      return [
        "Harness sessions:",
        ...sessions.slice(0, 10).map((session) => `- ${session.id} ${session.agentId || ""} ${session.status || ""} ${session.label || ""}`.trim()),
      ].join("\n");
    }
    if (command === "cancel" || command === "stop" || command === "kill") {
      return result.ok
        ? `Harness session cancelled: ${result.session?.id || "unknown"}`
        : `Harness cancel failed: ${result.reason || "unknown session"}`;
    }
    const sessions = result.sessions || [];
    return [
      `Harness status: ${result.enabled ? "enabled" : "disabled"}, default=${result.defaultAgent || "unknown"}`,
      `Allowed agents: ${(result.allowedAgents || []).join(", ") || "none"}`,
      sessions.length ? `Recent sessions: ${sessions.map((session) => `${session.id}:${session.status}`).join(", ")}` : "Recent sessions: none",
    ].join("\n");
  }
}
