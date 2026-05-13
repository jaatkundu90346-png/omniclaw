import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildOmniClawSystemPrompt } from "../system-prompt.js";

function truncateText(value, maxChars = 5000) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

function compactJson(value, maxChars = 4000) {
  return truncateText(JSON.stringify(value || null, null, 2), maxChars);
}

function isWindowsCommandScript(command) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command || ""));
}

function quoteCmdArg(value) {
  const text = String(value == null ? "" : value);
  if (text && !/\s|["&<>|^]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function wrapCommandForSpawn(command, args = []) {
  if (!isWindowsCommandScript(command)) {
    return { command, args };
  }
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/c", [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ")],
  };
}

function commandExists(command) {
  const bin = String(command || "codex").trim() || "codex";
  if (path.isAbsolute(bin) && fs.existsSync(bin)) {
    return { ok: true, command: bin, path: bin, error: "" };
  }
  const probe = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [bin] : ["-v", bin];
  const result = spawnSync(probe, args, { encoding: "utf8", shell: process.platform !== "win32" });
  return {
    ok: result.status === 0,
    command: bin,
    path: String(result.stdout || "").trim().split(/\r?\n/)[0] || "",
    error: String(result.stderr || result.error?.message || "").trim(),
  };
}

function commandUsable(command) {
  const bin = String(command || "codex").trim() || "codex";
  const wrapped = wrapCommandForSpawn(bin, ["--version"]);
  const result = spawnSync(wrapped.command, wrapped.args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    version: String(result.stdout || "").trim().split(/\r?\n/)[0] || "",
    error: String(result.stderr || result.error?.message || "").trim(),
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const wrapped = wrapCommandForSpawn(command, args);
    let settled = false;
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: options.cwd || process.cwd(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxOutput = Number(options.maxOutputBytes || 80_000);
    const timeoutMs = Number(options.timeoutMs || 45_000);
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killTree = () => {
      try {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
          });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      killTree();
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
        error: `Codex CLI provider timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = truncateText(stdout + chunk.toString("utf8"), maxOutput);
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateText(stderr + chunk.toString("utf8"), maxOutput);
    });
    child.on("error", (error) => {
      finish({ ok: false, exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode) => {
      finish({ ok: exitCode === 0, exitCode, stdout, stderr });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export class CodexCliProvider {
  constructor(configStore) {
    this.configStore = configStore;
  }

  getOptions(config = this.configStore.getConfig()) {
    const provider = config.provider || {};
    return {
      command: String(provider.codexCommand || "codex").trim() || "codex",
      model: String(provider.model || provider.codexModel || "").trim(),
      profile: String(provider.codexProfile || "").trim(),
      sandbox: String(provider.codexSandbox || "read-only").trim() || "read-only",
      timeoutMs: Math.max(5_000, Math.min(45_000, Number(provider.codexTimeoutMs || provider.timeoutMs || 45_000))),
      liveEnabled: provider.codexLiveEnabled === true,
      cwd: process.cwd(),
    };
  }

  getInfo() {
    const config = this.configStore.getConfig();
    const options = this.getOptions(config);
    const detected = commandExists(options.command);
    const usable = detected.ok ? commandUsable(options.command) : { ok: false, error: detected.error };
    return {
      id: "codex-cli",
      mode: "account-bridge",
      ready: detected.ok && usable.ok && options.liveEnabled,
      apiKeyConfigured: false,
      apiKeySource: "chatgpt-account",
      model: options.model || "codex default",
      command: options.command,
      commandPath: detected.path,
      commandVersion: usable.version,
      sandbox: options.sandbox,
      message: detected.ok && usable.ok
        ? options.liveEnabled
          ? "Using OpenAI Codex CLI as the provider bridge. Sign in to Codex with ChatGPT for subscription access."
          : "Codex CLI is installed, but live account-bridge replies are disabled because the CLI can hang. Use BYOK OpenAI-compatible provider for reliable API replies, or set provider.codexLiveEnabled=true after verifying codex exec works."
        : detected.ok
          ? `Codex CLI was found but could not run: ${usable.error || "unknown error"}. Install @openai/codex from npm or fix the app execution alias, then run codex login.`
          : `Codex CLI command "${options.command}" was not found. Install @openai/codex, then run codex login.`,
    };
  }

  buildPrompt(context) {
    const config = this.configStore.getConfig();
    return [
      config.provider.systemPrompt || "",
      "",
      buildOmniClawSystemPrompt(context),
      "",
      "You are answering inside OmniClaw. OmniClaw has already handled local tools; do not claim you executed extra actions.",
      "Use the tool observations and memory below to produce the final user-facing reply.",
      "",
      `User message: ${context.message}`,
      `Detected intents: ${(context.intents || []).join(", ") || "general"}`,
      `Agent profile: ${context.profile?.id || "unknown"}`,
      "",
      "Workspace identity and operating files:",
      compactJson(context.contextBundle?.workspaceContext || context.workspaceContext || null, 4500),
      "",
      "Active agent:",
      compactJson(context.contextBundle?.agent || context.agent || null, 1600),
      "",
      "Visible skills:",
      compactJson(context.contextBundle?.skills || context.skills || [], 2000),
      "",
      "Visible tools:",
      compactJson(context.contextBundle?.tools || context.tools || [], 3000),
      "",
      "Tool observations:",
      compactJson(context.contextBundle?.toolOutputs || context.toolOutputs || [], 5000),
      "",
      "Memory/context summary:",
      compactJson(
        {
          contextReport: context.contextBundle?.report || null,
          recentConversations: context.contextBundle?.recentConversations || context.recentConversations,
          notes: context.contextBundle?.notes || context.notes,
          longTermMemory: context.contextBundle?.longTermMemory || context.longTermMemory,
          research: context.contextBundle?.research || context.research,
          artifacts: context.contextBundle?.artifacts || context.artifacts,
          tasks: context.contextBundle?.tasks || context.tasks,
        },
        4500,
      ),
      "",
      "Write the final human response now.",
    ].join("\n");
  }

  buildExecArgs(outputPath, options = this.getOptions()) {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      options.sandbox,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
    ];
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.profile) {
      args.push("--profile", options.profile);
    }
    args.push("-");
    return args;
  }

  async testConnection(input = {}) {
    const options = {
      ...this.getOptions(),
      command: String(input.codexCommand || input.command || this.getOptions().command).trim() || "codex",
      model: String(input.model || this.getOptions().model || "").trim(),
    };
    const detected = commandExists(options.command);
    if (!detected.ok) {
      return {
        ok: false,
        command: options.command,
        error: `Codex CLI not found. Install with npm install -g @openai/codex, then run codex login.`,
      };
    }
    const usable = commandUsable(options.command);
    if (!usable.ok) {
      return {
        ok: false,
        command: options.command,
        commandPath: detected.path,
        error: `Codex CLI was found but could not run: ${usable.error || "unknown error"}`,
      };
    }

    if (input.verifyAuth) {
      const outputPath = path.join(os.tmpdir(), `omniclaw-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const args = this.buildExecArgs(outputPath, {
        ...options,
        timeoutMs: Number(input.timeoutMs || options.timeoutMs || 30000),
      });
      const result = await runProcess(options.command, args, {
        cwd: options.cwd,
        stdin: input.prompt || "Reply with exactly: ok",
        timeoutMs: Number(input.timeoutMs || 30000),
        maxOutputBytes: 12000,
      });
      const fileText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
      fs.rmSync(outputPath, { force: true });
      if (!result.ok) {
        return {
          ok: false,
          command: options.command,
          commandPath: detected.path,
          commandVersion: usable.version,
          authVerified: false,
          exitCode: result.exitCode,
          error: String(result.stderr || result.error || "Codex CLI live auth test failed. Run codex login.").trim(),
        };
      }
      return {
        ok: true,
        command: options.command,
        commandPath: detected.path,
        commandVersion: usable.version,
        authVerified: true,
        responsePreview: (fileText || result.stdout || "").trim().slice(0, 140),
        message: "Codex CLI live auth test passed.",
      };
    }

    return {
      ok: true,
      command: options.command,
      commandPath: detected.path,
      commandVersion: usable.version,
      authVerified: false,
      model: options.model || "codex default",
      message: "Codex CLI is installed. Use verifyAuth=true or send a chat to confirm ChatGPT account authentication.",
    };
  }

  async respond(context) {
    const options = this.getOptions();
    if (!options.liveEnabled) {
      return [
        "Codex CLI account bridge is installed, but live replies are disabled to prevent chat hangs.",
        "For reliable model replies, use BYOK/OpenAI-compatible mode with a real API key, base URL, and model.",
        "If you want to test the account bridge anyway, set provider.codexLiveEnabled=true after confirming codex exec returns from terminal.",
      ].join(" ");
    }
    const detected = commandExists(options.command);
    if (!detected.ok) {
      return [
        "Codex CLI bridge is selected, but the codex command is not installed or not on PATH.",
        "Install it with npm install -g @openai/codex, then run codex login and choose Sign in with ChatGPT.",
        "OmniClaw local tools and memory still completed before this provider step.",
      ].join(" ");
    }
    const usable = commandUsable(options.command);
    if (!usable.ok) {
      return [
        "Codex CLI bridge is selected, but the codex command could not run.",
        `Details: ${truncateText(usable.error || "unknown error", 700)}`,
        "Use the BYOK panel's Open Codex setup button. It opens a terminal that installs @openai/codex if needed and starts codex login.",
      ].join(" ");
    }

    const outputPath = path.join(os.tmpdir(), `omniclaw-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = this.buildExecArgs(outputPath, options);
    const result = await runProcess(options.command, args, {
      cwd: options.cwd,
      stdin: this.buildPrompt(context),
      timeoutMs: options.timeoutMs,
    });
    const fileText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8").trim() : "";
    fs.rmSync(outputPath, { force: true });

    if (result.ok) {
      return fileText || String(result.stdout || "").trim() || "Codex CLI returned an empty final response.";
    }

    const stderr = String(result.stderr || result.error || "").trim();
    return [
      `Codex CLI provider failed${result.exitCode == null ? "" : ` with exit ${result.exitCode}`}.`,
      stderr ? `Details: ${truncateText(stderr, 900)}` : "No diagnostic text was returned.",
      "Run codex login if the CLI needs ChatGPT account authentication.",
    ].join(" ");
  }

  async complete(messages = []) {
    const config = this.configStore.getConfig();
    const prompt = [
      config.provider.systemPrompt || "",
      "Return only the requested completion. Keep it concise.",
      "",
      ...messages.map((message) => `${message.role || "user"}: ${message.content || ""}`),
    ].join("\n");
    const context = {
      message: prompt,
      intents: ["completion"],
      profile: { id: "codex-cli" },
      skills: [],
      tools: [],
      recentConversations: [],
      research: [],
      artifacts: [],
      longTermMemory: [],
      toolOutputs: [],
    };
    const text = await this.respond(context);
    return { text };
  }
}
