import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createManusToolsExtension } from "./manus-tools-extension.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
import { redactSecrets } from "./secret-redact.js";
import { fuzzyFindAndReplace, findClosestSnippet } from "./fuzzy-edit.js";
import { HarnessEvolution } from "./harness-evolution.js";
import { ToolForge } from "./tool-forge.js";
import {
  verifyTelegramToken,
  getWebhookConflict,
  deleteWebhook,
  sendTelegramMessage,
  maskToken,
} from "./telegram-api.js";
import { saveFileCheckpoint as saveSharedFileCheckpoint } from "./file-checkpoint.js";
import { normalizeLedgerKey } from "./file-store.js";
import { getProvider } from "./provider-factory.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { classifyProviderError } from "./provider-error-classifier.js";
import { recordModelTest, markModelRetired, statusFromReason } from "./model-registry.js";
import { createBrowserRemoteTools, BROWSER_REMOTE_TOOL_IDS } from "./browser-remote-tools.js";
import { APPROVAL_TOOL_TIMEOUT_MS } from "./gateway-store.js";
import { OPERATOR_IDS, EOPERATOR, PLACEHOLDER_REDIRECT, TOOLSETS, ALIAS_IDS, DROP_IDS } from "./tool-layers.js";

const CACHEABLE_OBSERVATION_TOOLS = new Set([
  "time_now",
  "runtime_summary",
  "provider_status",
  "prompt_trace",
  "tool_trace",
  "list_tasks",
  "list_files",
  "read_file",
  "list_computer_directory",
  "read_computer_file",
  "search_computer_files",
  "computer_access_status",
  "computer_access_audit",
  "web_search",
  "web_research",
  "web_fetch",
  "browser_status",
  "browser_snapshot",
  "browser_links",
  "browser_text",
  "session_status",
  "sessions_list",
  "sessions_history",
  "subagents",
  "memory_search",
  "memory_get",
]);

// Edits must read the WHOLE file, not the 64KB read preview — a capped read
// makes find-text beyond the cap unmatchable (endless edit failures) and would
// write truncated content back, dropping the rest of the file. 16MB safety cap.
const EDIT_MAX_BYTES = 16 * 1024 * 1024;

// Common tool-name synonyms a model may reach for, routed to the canonical
// OmniClaw tool so a near-miss name doesn't fail with "Unknown tool". Folder
// creation especially: models habitually call mkdir/make_directory/create_folder.
const TOOL_NAME_ALIASES = {
  mkdir: "create_directory",
  makedir: "create_directory",
  make_directory: "create_directory",
  create_dir: "create_directory",
  createdir: "create_directory",
  create_folder: "create_directory",
  new_folder: "create_directory",
  make_dir: "create_directory",
  makedirs: "create_directory",
  // Namespace rationalization: one canonical tool per capability (measured
  // usage picks the target). Aliases stay resolvable for transcripts and
  // programmatic callers but never enter the model menu. NOTE: `write` is
  // deliberately NOT aliased — its def fans out append:true correctly and an
  // alias would silently turn appends into overwrites.
  read: "read_file",
  read_url: "web_fetch",
  web_extract: "web_fetch",
  memory_recall: "memory_search",
  computer_use: "computer_access_status",
  mixture_of_agents: "delegate_task",
  // NOTE: enable_toolset is deliberately NOT aliased to load_toolset — they
  // are different scopes (run vs session) with different events
  // (toolset.enabled vs toolset.session_pinned). An alias here silently
  // reroutes the run-scoped tool and breaks the session-toolsets contract.
};

// Tools whose execution invalidates session read-cache entries by path
// (exact paths from inputs) or by command-text match (shell-class tools).
// Includes delegating alias defs (write/patch/terminal/execute_code call the
// canonical run() directly, bypassing dispatch): invalidation must name the
// OUTER id the model actually called.
const WRITE_INVALIDATE_TOOLS = new Set([
  "write_file",
  "write",
  "append_file",
  "create_directory",
  "write_computer_file",
  "create_computer_directory",
  "copy_computer_path",
  "move_computer_path",
  "delete_computer_path",
  "edit",
  "multi_edit",
  "apply_patch",
  "patch",
]);
const COMMAND_INVALIDATE_TOOLS = new Set([
  "exec",
  "terminal",
  "run_terminal_command",
  "code_execution",
  "execute_code",
]);

// Reading a PNG/mp4/zip as "text" floods the context with garbage bytes (a
// real run burned 774 lines on one screenshot). Route images to describe_image
// (the harness's eyes) and other binaries to a clear refusal.
const IMAGE_FILE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".avif"]);
const BINARY_FILE_EXTS = new Set([
  ...IMAGE_FILE_EXTS,
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".avi", ".mkv", ".mov", ".webm",
  ".zip", ".rar", ".7z", ".gz", ".tar", ".exe", ".dll", ".msi", ".iso", ".bin",
  ".pdf", ".doc", ".docx", ".xlsx", ".pptx", ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".sqlite", ".db", ".pyc", ".class", ".o", ".so", ".node", ".wasm",
]);

function binaryReadGuard(filePath = "") {
  const ext = String(filePath || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  if (!BINARY_FILE_EXTS.has(ext)) return null;
  if (IMAGE_FILE_EXTS.has(ext)) {
    return {
      error: true,
      isImage: true,
      path: filePath,
      message: `This is an IMAGE file (${ext}) — reading it as text gives useless bytes. To SEE it, call describe_image {"path":"${String(filePath).replace(/\\/g, "/")}"} (works even if your model cannot see images). To show it to the user, reference its /preview/ URL.`,
    };
  }
  return {
    error: true,
    isBinary: true,
    path: filePath,
    message: `This is a binary ${ext} file — read_file only works on text. Use list_files/exec for metadata, or the appropriate media/archive tool.`,
  };
}

const SIDE_EFFECT_TOOLS = new Set([
  "write_file",
  "append_file",
  "create_directory",
  "write_computer_file",
  "create_computer_directory",
  "copy_computer_path",
  "move_computer_path",
  "delete_computer_path",
  "run_terminal_command",
  "exec",
  "shell_exec",
  "apply_patch",
  "sandbox_apply",
  "open_browser_url",
  "browser",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_tap",
  "browser_dialog",
  "browser_cdp",
  // Remote-browser tools that MUTATE the user's real session — dedup/confirm
  // them like the Playwright equivalents above.
  "browser_remote_click",
  "browser_remote_type",
  "browser_remote_fill_form",
  "browser_remote_navigate",
  "message",
  "send_message",
  "sessions_send",
  "sessions_spawn",
  "agent_harness_spawn",
  "agent_harness_cancel",
  "delegate_task",
  "remember_note",
  "promote_memory",
  "memory_write",
  "memory_replace",
  "memory_forget",
  "run_task",
  "configure_telegram",
]);

// Browser actions that may have to LAUNCH the browser (no session yet, or the
// idle session was reaped). Only these get the long cold-start budget; see
// runBrowserOperation.
const BROWSER_LAUNCH_ACTIONS = new Set([
  "open_url",
  "browser_open",
  "browser_view",
  "browser_automate",
]);

// Provider/runtime configuration tools are explicit user actions (from the
// Settings UI), not agent-loop calls. Retrying them after fixing a key/setting
// is always legitimate, so they must never be blocked by the dedup/failed-call
// guards (otherwise "add key -> Fetch models" stays blocked by the earlier
// missing-key failure).
const DEDUP_EXEMPT_TOOLS = new Set([
  "list_provider_models",
  "test_provider_profile",
  "set_provider_key",
  "apply_provider_profile",
  "save_provider_profile",
  "delete_provider_profile",
  "configure_provider_brain",
  "get_provider_key_status",
  "update_runtime_settings",
  "harness_doctor",
  "init_project",
  // Feature-list state actions are legitimately repeated (re-verify after a fix).
  "feature_verify",
  "feature_set",
  "verify_done",
  "evaluate_work",
  "check_boundaries",
  "add_check",
  "sprint_contract",
  "task_trace",
  "session_handoff",
]);

function normalizeContext(context = {}) {
  if (typeof context === "string") {
    return {
      agentId: context,
    };
  }

  return context && typeof context === "object" ? context : {};
}

// Builds a compact unified-style diff for a find→replace edit: the find text
// becomes "-" lines and the replace text "+" lines. Capped so a huge edit
// does not flood the transcript or the UI.
function buildEditDiff(find, replace, maxLines = 40) {
  const removed = String(find || "").split("\n");
  const added = String(replace || "").split("\n");
  const lines = [
    ...removed.slice(0, maxLines).map((line) => `- ${line}`),
    ...added.slice(0, maxLines).map((line) => `+ ${line}`),
  ];
  if (removed.length > maxLines || added.length > maxLines) {
    lines.push(`... [diff truncated: ${removed.length}- / ${added.length}+ lines total]`);
  }
  return lines.join("\n");
}

function stableToolStringify(value) {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableToolStringify(item)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableToolStringify(value[key])}`).join(",")}}`;
}

function normalizeToolInputForKey(id, input = {}) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (["web_search", "web_research"].includes(id)) {
    return {
      query: String(value.query || value.q || value.search || "").toLowerCase().replace(/\s+/g, " ").trim(),
      maxResults: Number(value.maxResults || value.limit || 0) || undefined,
    };
  }
  if (["web_fetch", "open_browser_url"].includes(id)) {
    return { url: String(value.url || value.href || "").toLowerCase().trim() };
  }
  if (["read_file", "read_computer_file", "list_files", "list_computer_directory", "search_computer_files"].includes(id)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, typeof entry === "string" ? entry.replace(/\0/g, "").trim() : entry])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function buildObservationKey(id, input = {}, context = {}) {
  const runScope = String(context.runId || context.sessionId || "global").trim() || "global";
  const agentScope = String(context.agentId || "main").trim() || "main";
  return `${agentScope}:${runScope}:${id}:${stableToolStringify(normalizeToolInputForKey(id, input))}`;
}

function isSuccessfulToolResult(result) {
  return Boolean(result) &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    result.error !== true &&
    result.blocked !== true &&
    result.ok !== false &&
    result.success !== false;
}

function isFailedToolResult(result) {
  return Boolean(result) &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result.error === true || result.blocked === true || result.ok === false || result.success === false);
}

function compactObservationResult(result = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  return {
    ...result,
    cachedObservation: true,
    cacheHint: "Same tool and same arguments already succeeded in this run/session, so OmniClaw reused the prior observation.",
  };
}

function sanitizeToolResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const sanitize = (value, key = "", depth = 0) => {
    if (depth > 5) {
      return "[truncated-depth]";
    }
    const normalizedKey = String(key || "");
    if (!/^apiKeyProviderId$/i.test(normalizedKey) && /api[_-]?key|authorization|bearer|password|secret|token|cookie|credential/i.test(normalizedKey)) {
      return "[redacted]";
    }
    if (typeof value === "string") {
      // Mask secret-shaped VALUES (sk-/ghp_/AKIA/Bearer/env-assignments/etc.)
      // that key-name redaction can't catch — e.g. a key sitting in command
      // stdout (`env`, `cat .env`), file content, or an error string.
      const redacted = redactSecrets(value);
      return redacted.length > 24000 ? `${redacted.slice(0, 23960)}...[truncated ${redacted.length - 23960} chars]` : redacted;
    }
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((item) => sanitize(item, "", depth + 1));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)]));
    }
    return value;
  };
  return sanitize(result);
}

function validateAgainstSimpleSchema(schema = null, input = {}) {
  if (!schema || typeof schema !== "object") {
    return { ok: true, errors: [] };
  }
  const errors = [];
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (value[key] === undefined || value[key] === null || value[key] === "") {
      errors.push(`${key} is required`);
    }
  }
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const [key, rule] of Object.entries(properties)) {
    if (value[key] === undefined || !rule || typeof rule !== "object") {
      continue;
    }
    const type = Array.isArray(rule.type) ? rule.type : [rule.type].filter(Boolean);
    if (type.length === 0) {
      continue;
    }
    const actual = Array.isArray(value[key]) ? "array" : typeof value[key];
    if (!type.includes(actual)) {
      errors.push(`${key} must be ${type.join(" or ")}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "openclaw-skill";
}

function normalizeBrowserAction(action = "") {
  const normalized = String(action || "open").trim().toLowerCase().replace(/[_\s-]+/g, "-");
  const aliases = {
    goto: "open",
    navigate: "open",
    navigation: "open",
    visit: "open",
    observe: "view",
    inspect: "view",
    snapshot: "snapshot",
    text: "view",
    read: "view",
    fetch: "view",
    capture: "screenshot",
    fill: "type",
    input: "type",
    image: "get-images",
    images: "get-images",
    img: "get-images",
    "get-image": "get-images",
    logs: "console",
    devtools: "cdp",
    dialogs: "dialog",
    js: "evaluate",
    eval: "evaluate",
    forward: "forward",
    next: "forward",
    previous: "back",
    stop: "close",
    tabs: "sessions",
    list: "sessions",
    "list-sessions": "sessions",
    doctor: "status",
  };
  return aliases[normalized] || normalized;
}

function browserObservation(action, tool, result, extra = {}) {
  const ok = !result?.error && result?.ok !== false && result?.success !== false;
  return {
    ok,
    action,
    tool,
    sessionId: result?.sessionId || extra.sessionId || null,
    url: result?.url || result?.currentUrl || extra.url || null,
    title: result?.title || null,
    result,
    next: ok
      ? "Continue with another browser action if the page state is not enough; otherwise summarize the observed result."
      : "Use the returned error as an observation, adjust selector/session/url, then retry or explain the blocker.",
  };
}

function isPatchOperationLine(line = "") {
  return /^(?:\*\*\* Add File: |\*\*\* Update File: |\*\*\* Delete File: )/.test(String(line || ""));
}

function parseStructuredPatchInput(input = "") {
  const text = String(input || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === "*** End Patch") {
      last = i;
      break;
    }
  }
  if (first < 0 || last < 0 || last <= first) {
    throw new Error("Patch must include *** Begin Patch and *** End Patch.");
  }

  const operations = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    let match = line.match(/^\*\*\* Add File: (.+)$/);
    if (match) {
      const filePath = match[1].trim();
      i += 1;
      const contentLines = [];
      while (i < last && !isPatchOperationLine(lines[i])) {
        if (!lines[i].startsWith("+")) {
          throw new Error(`Add File lines must start with '+': ${filePath}`);
        }
        contentLines.push(lines[i].slice(1));
        i += 1;
      }
      operations.push({ kind: "add", path: filePath, content: contentLines.join("\n") });
      continue;
    }

    match = line.match(/^\*\*\* Delete File: (.+)$/);
    if (match) {
      operations.push({ kind: "delete", path: match[1].trim() });
      i += 1;
      continue;
    }

    match = line.match(/^\*\*\* Update File: (.+)$/);
    if (match) {
      const filePath = match[1].trim();
      i += 1;
      let moveTo = "";
      if (i < last) {
        const move = lines[i].match(/^\*\*\* Move to: (.+)$/);
        if (move) {
          moveTo = move[1].trim();
          i += 1;
        }
      }
      const hunks = [];
      while (i < last && !isPatchOperationLine(lines[i])) {
        hunks.push(lines[i]);
        i += 1;
      }
      operations.push({ kind: "update", path: filePath, moveTo, hunks });
      continue;
    }

    throw new Error(`Unsupported patch operation line: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch contains no file operations.");
  }
  return operations;
}

function splitPatchHunks(lines = []) {
  const groups = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    if (line.trim() === "*** End of File" || line.trim() === "") {
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function findLineSequence(lines = [], expected = [], startAt = 0) {
  if (expected.length === 0) return startAt;
  for (let i = Math.max(0, startAt); i <= lines.length - expected.length; i += 1) {
    let ok = true;
    for (let j = 0; j < expected.length; j += 1) {
      if (lines[i + j] !== expected[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function applyPatchHunksToContent(content = "", hunkLines = [], filePath = "") {
  const hadFinalNewline = /\n$/.test(content);
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  if (hadFinalNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let cursor = 0;
  let appliedHunks = 0;
  for (const hunk of splitPatchHunks(hunkLines)) {
    const expected = [];
    const replacement = [];
    for (const line of hunk) {
      const prefix = line[0];
      const value = line.slice(1);
      if (prefix === " ") {
        expected.push(value);
        replacement.push(value);
      } else if (prefix === "-") {
        expected.push(value);
      } else if (prefix === "+") {
        replacement.push(value);
      } else {
        throw new Error(`Unsupported patch hunk line in ${filePath}: ${line}`);
      }
    }

    if (expected.length === 0) {
      lines.splice(cursor, 0, ...replacement);
      cursor += replacement.length;
      appliedHunks += 1;
      continue;
    }

    const index = findLineSequence(lines, expected, cursor);
    if (index < 0) {
      throw new Error(`Patch context did not match for ${filePath}. Read the file again and regenerate a narrower patch.`);
    }
    lines.splice(index, expected.length, ...replacement);
    cursor = index + replacement.length;
    appliedHunks += 1;
  }

  return {
    content: lines.join("\n") + (hadFinalNewline ? "\n" : ""),
    appliedHunks,
  };
}

function parseOpenClawSkill(contents, filePath, rootDir) {
  const text = String(contents || "");
  const meta = {};
  let body = text;
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (item) {
        meta[item[1].toLowerCase()] = item[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
  const directoryName = path.basename(path.dirname(filePath));
  return {
    name: meta.name || directoryName,
    description: meta.description || "",
    path: relativePath,
    absolutePath: filePath,
    source: relativePath.startsWith("vendor/openclaw/extensions/") ? "extensions" : "skills",
    instructions: body.trim(),
  };
}

const OPENCLAW_COMPAT_SKILL_PACKS = {
  v2_core: [
    {
      name: "browser-automation",
      path: "vendor/openclaw/extensions/browser/skills/browser-automation/SKILL.md",
      importName: "OpenClaw Browser Automation",
      triggers: ["browser", "automation", "web page", "click", "tab", "screenshot", "login"],
      agents: ["main"],
      reason: "Gives the agent an OpenClaw-style browser operating loop: status, tabs, snapshot, narrow action, observe.",
    },
    {
      name: "coding-agent",
      path: "vendor/openclaw/skills/coding-agent/SKILL.md",
      importName: "OpenClaw Coding Agent",
      triggers: ["coding agent", "build", "implement", "review", "refactor", "codex", "opencode"],
      agents: ["main"],
      reason: "Documents how OpenClaw delegates implementation work to background coding CLIs.",
    },
    {
      name: "github",
      path: "vendor/openclaw/skills/github/SKILL.md",
      importName: "OpenClaw GitHub Operator",
      triggers: ["github", "repo", "pull request", "issue", "branch", "commit"],
      agents: ["main"],
      reason: "Adds GitHub workflow behavior for repo/PR/issue operations.",
    },
    {
      name: "healthcheck",
      path: "vendor/openclaw/skills/healthcheck/SKILL.md",
      importName: "OpenClaw Healthcheck",
      triggers: ["healthcheck", "diagnostics", "status", "doctor", "runtime"],
      agents: ["main"],
      reason: "Helps the agent inspect runtime health before claiming a feature works.",
    },
    {
      name: "session-logs",
      path: "vendor/openclaw/skills/session-logs/SKILL.md",
      importName: "OpenClaw Session Logs",
      triggers: ["session logs", "history", "transcript", "chat history", "conversation"],
      agents: ["main"],
      reason: "Strengthens session-history behavior so the agent checks prior messages instead of starting fresh.",
    },
    {
      name: "skill-creator",
      path: "vendor/openclaw/skills/skill-creator/SKILL.md",
      importName: "OpenClaw Skill Creator",
      triggers: ["create skill", "new skill", "skill file", "capability"],
      agents: ["main"],
      reason: "Adds OpenClaw-style skill authoring guidance for growing OmniClaw capabilities.",
    },
  ],
};

const HERMES_COMPAT_TOOLS = [
  { id: "web_search", toolset: "web", status: "native", omniclawTool: "web_search" },
  { id: "web_extract", toolset: "web", status: "alias", omniclawTool: "web_fetch" },
  { id: "terminal", toolset: "terminal", status: "alias", omniclawTool: "run_terminal_command" },
  { id: "process", toolset: "terminal", status: "native", omniclawTool: "process" },
  { id: "read_file", toolset: "file", status: "native", omniclawTool: "read_file" },
  { id: "write_file", toolset: "file", status: "native", omniclawTool: "write_file" },
  { id: "patch", toolset: "file", status: "alias", omniclawTool: "apply_patch" },
  { id: "search_files", toolset: "file", status: "alias", omniclawTool: "memory_search/search_computer_files" },
  { id: "vision_analyze", toolset: "vision", status: "alias", omniclawTool: "image/analyze_pending_media_attachments" },
  { id: "video_analyze", toolset: "video", status: "alias", omniclawTool: "video_analyze" },
  { id: "image_generate", toolset: "image_gen", status: "native", omniclawTool: "image_generate" },
  { id: "skills_list", toolset: "skills", status: "alias", omniclawTool: "hermes_skill_scan/capability_demo" },
  { id: "skill_view", toolset: "skills", status: "alias", omniclawTool: "read_computer_file" },
  { id: "skill_manage", toolset: "skills", status: "partial", omniclawTool: "create_skill/openclaw_skill_import" },
  { id: "browser_navigate", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_snapshot", toolset: "browser", status: "native", omniclawTool: "browser_snapshot" },
  { id: "browser_click", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_type", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_scroll", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_back", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_press", toolset: "browser", status: "alias", omniclawTool: "browser" },
  { id: "browser_get_images", toolset: "browser", status: "native", omniclawTool: "browser_get_images" },
  { id: "browser_vision", toolset: "browser", status: "native", omniclawTool: "browser_screenshot + describe_image" },
  { id: "browser_console", toolset: "browser", status: "native", omniclawTool: "browser_console" },
  { id: "browser_cdp", toolset: "browser", status: "native", omniclawTool: "browser_cdp" },
  { id: "browser_dialog", toolset: "browser", status: "native", omniclawTool: "browser_dialog" },
  { id: "browser_tap", toolset: "browser", status: "native", omniclawTool: "browser_tap" },
  { id: "text_to_speech", toolset: "tts", status: "placeholder", omniclawTool: "media plugin needed" },
  { id: "todo", toolset: "todo", status: "alias", omniclawTool: "create_task/list_tasks" },
  { id: "memory", toolset: "memory", status: "alias", omniclawTool: "memory_search/list_long_term_memory/promote_memory/memory_replace/memory_forget" },
  { id: "session_search", toolset: "session_search", status: "alias", omniclawTool: "sessions_history/memory_search" },
  { id: "clarify", toolset: "clarify", status: "placeholder", omniclawTool: "assistant follow-up" },
  { id: "execute_code", toolset: "code_execution", status: "alias", omniclawTool: "code_execution" },
  { id: "delegate_task", toolset: "delegation", status: "native", omniclawTool: "delegate_task" },
  { id: "cronjob", toolset: "cronjob", status: "alias", omniclawTool: "cron" },
  { id: "send_message", toolset: "messaging", status: "alias", omniclawTool: "message" },
  { id: "ha_list_entities", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "ha_get_state", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "ha_list_services", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "ha_call_service", toolset: "homeassistant", status: "placeholder", omniclawTool: "connector plugin needed" },
  { id: "kanban_show", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_list", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_complete", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_block", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_heartbeat", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_comment", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_create", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_link", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "kanban_unblock", toolset: "kanban", status: "placeholder", omniclawTool: "task/agent orchestration needed" },
  { id: "computer_use", toolset: "computer_use", status: "partial", omniclawTool: "computer_access_status/browser/terminal" },
  { id: "mixture_of_agents", toolset: "moa", status: "partial", omniclawTool: "subagents/delegate_task" },
];

const LIMITED_PRODUCT_TOOLS = {
  browser_vision: {
    status: "partial",
    replacement: "browser_screenshot + describe_image",
    reason: "Capture with browser_screenshot, then describe_image reads it via the media engine's vision backend.",
  },
  skill_manage: {
    status: "partial",
    replacement: "create_skill",
    reason: "Hermes-style self-editing skill management needs diff/review before writes.",
  },
  clarify: {
    status: "partial",
    replacement: "assistant_followup",
    reason: "Clarification should be a chat question, not a model-callable fake tool.",
  },
  mixture_of_agents: {
    status: "partial",
    replacement: "delegate_task",
    reason: "Full MoA orchestration is not built; delegate_task is the concrete backend.",
  },
  computer_use: {
    status: "partial",
    replacement: "computer_access_status",
    reason: "Computer-use is a status bundle; concrete actions use terminal/browser/file tools.",
  },
  text_to_speech: {
    status: "placeholder",
    replacement: "",
    reason: "TTS provider plugin is not configured.",
  },
  music_generate: {
    status: "placeholder",
    replacement: "",
    reason: "Music generation provider plugin is not configured.",
  },
  tts: {
    status: "placeholder",
    replacement: "",
    reason: "TTS provider plugin is not configured.",
  },
  ha_list_entities: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  ha_get_state: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  ha_list_services: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  ha_call_service: {
    status: "placeholder",
    replacement: "",
    reason: "Home Assistant connector is not configured.",
  },
  kanban_show: {
    status: "placeholder",
    replacement: "list_tasks",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_list: {
    status: "placeholder",
    replacement: "list_tasks",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_complete: {
    status: "placeholder",
    replacement: "run_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_block: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_heartbeat: {
    status: "placeholder",
    replacement: "cron",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_comment: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_create: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_link: {
    status: "placeholder",
    replacement: "create_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
  kanban_unblock: {
    status: "placeholder",
    replacement: "run_task",
    reason: "Kanban board orchestration is not wired yet.",
  },
};

const CODEX_GRADE_MODEL_TOOLS = new Set([
  // Remote control of the user's own running browser (CDP). Without these ids
  // here, getAll(modelCallableOnly) filters the tools out and the model never
  // sees them.
  ...BROWSER_REMOTE_TOOL_IDS,
  "time_now",
  "code_act",
  "restore_checkpoint",
  "harness_evolution_status",
  "best_of_n",
  "update_plan",
  "update_progress",
  "read_progress",
  "sprint_contract",
  "read_sprint_contract",
  "task_trace",
  "session_handoff",
  "feature_list",
  "feature_set",
  "feature_verify",
  "verify_done",
  "check_boundaries",
  "add_check",
  "evaluate_work",
  "log_decision",
  "read_decisions",
  "git_commit",
  "harness_doctor",
  "init_project",
  "provider_status",
  "configure_provider_brain",
  "test_provider_profile",
  "list_provider_models",
  "save_provider_profile",
  "delete_provider_profile",
  "apply_provider_profile",
  "list_files",
  "read_file",
  "write_file",
  "append_file",
  "create_directory",
  "edit",
  "multi_edit",
  "apply_patch",
  "search_text",
  "git_status",
  "git_diff",
  "git_log",
  "verify_html_artifact",
  "search_computer_files",
  "list_computer_directory",
  "read_computer_file",
  "write_computer_file",
  "create_computer_directory",
  "copy_computer_path",
  "move_computer_path",
  "delete_computer_path",
  "computer_access_status",
  "computer_system_status",
  "exec_approval_status",
  "plan_shell_command",
  "run_terminal_command",
  "exec",
  "process",
  "process_list",
  "process_status",
  "process_kill",
  "process_cleanup",
  "code_execution",
  "execute_code",
  "auto_review",
  "sandbox_status",
  "sandbox_run",
  "sandbox_apply",
  "web_research",
  "web_search",
  "brave_search",
  "exa_search",
  "web_fetch",
  "read_url",
  "x_search",
  "open_browser_url",
  "browser",
  "browser_status",
  "browser_open",
  "browser_view",
  "browser_snapshot",
  "browser_links",
  "browser_text",
  "browser_screenshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_forward",
  "browser_press",
  "browser_get_images",
  "browser_console",
  "browser_cdp",
  "browser_dialog",
  "browser_tap",
  "browser_wait",
  "browser_evaluate",
  "browser_close",
  "browser_automate",
  "browser_sessions",
  "remember_note",
  "list_notes",
  "list_long_term_memory",
  "promote_memory",
  "dream_memory_sweep",
  "memory_search",
  "memory_get",
  "memory_write",
  "memory_replace",
  "memory_forget",
  "memory_compact",
  "memory",
  "session_search",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "session_status",
  "channel_dock",
  "acp_doctor",
  "acp_install",
  "acp_spawn",
  "acp_status",
  "acp_sessions",
  "acp_cancel",
  "acp_close",
  "acp_set_option",
  "agent_harness_doctor",
  "agent_harness_spawn",
  "agent_harness_status",
  "agent_harness_sessions",
  "agent_harness_cancel",
  "agents_list",
  "create_task",
  "list_tasks",
  "todo",
  "run_task",
  "delegate_task",
  "subagents",
  "cron",
  "cronjob",
  "configure_telegram",
  // 2026-07-31: connecting Telegram was reachable but unanswerable — the model
  // could store a token and had no way to check it or send anything.
  "telegram_status",
  "telegram_send",
  "message",
  "send_message",
  "real_task_health",
  "mcp_integration_status",
  "mcp_connect_all",
  "connected_apps_status",
  "github_list_repositories",
  "github_search_issues",
  "gmail_search_messages",
  "gmail_get_message",
  // Media powers (real backends via MediaEngine) — these being absent here was
  // why the model kept telling the user "image/video generate nahi kar sakta"
  // even after the tools were built: getAll(modelCallableOnly) is allowlist-
  // gated, so CORE_TOOL_ORDER placement alone never reached the model.
  "image_generate",
  "describe_image",
  "video_generate",
  "vision_analyze",
  "video_analyze",
  // Skills system — without skill_read the model could see matched skill
  // NAMES (injected in the prompt) but had no way to open the SKILL.md method.
  "skills_list",
  "skill_read",
  "skill_view",
  "create_skill",
  // Provider self-service referenced by CORE_TOOL_ORDER.
  "provider_keys",
  "switch_model",
  // Tool Forge (ADA parity): the agent builds/tests/manages its OWN tools when
  // nothing existing fits the user's task. Forged tools themselves are admitted
  // dynamically via runtimeStatus "custom" after passing their self-tests.
  "build_tool",
  "test_tool",
  "list_custom_tools",
  "remove_custom_tool",
  // Mid-run interactive question card (Claude Code AskUserQuestion parity).
  "ask_user",
  // Progressive-disclosure meta tools (always in the model menu).
  "list_toolsets",
  "load_toolset",
]);

export class ToolRegistry {
  constructor({
    memoryStore,
    taskStore,
    configStore,
    fileStore,
    shellPlanner,
    shellExecutor,
    webResearch,
    browserOperator,
    browser,
    sandboxRunner,
    systemMonitor,
    taskRunner,
    customizationEngine,
    pluginRegistry,
    agentRegistry,
    connectorStore,
    appConnections,
    agentRuntime,
    subAgentSpawner,
    acpManager,
    codingHarness,
  }) {
    this.memoryStore = memoryStore;
    this.taskStore = taskStore;
    this.configStore = configStore;
    this.fileStore = fileStore;
    this.shellPlanner = shellPlanner;
    this.shellExecutor = shellExecutor || agentRuntime?.shellExecutor;
    this.webResearch = webResearch;
    this.browserOperator = browserOperator;
    this.browser = browser || agentRuntime?.browserPlaywright;
    this.sandboxRunner = sandboxRunner;
    this.systemMonitor = systemMonitor;
    this.taskRunner = taskRunner;
    this.customizationEngine = customizationEngine;
    this.pluginRegistry = pluginRegistry;
    this.agentRegistry = agentRegistry;
    this.connectorStore = connectorStore;
    this.appConnections = appConnections || agentRuntime?.appConnections;
    this.agentRuntime = agentRuntime;
    // ADA-style self-built tools: forged by the model via build_tool, persisted
    // under workspace/tools/, sandbox-executed, reloaded on every boot.
    this.toolForge = new ToolForge({
      rootDir: agentRuntime?.rootDir || process.cwd(),
      network: configStore?.getConfig?.()?.tools?.toolForge?.network,
    });
    this.customTools = new Map();
    try {
      for (const tool of this.toolForge.loadAll()) this.customTools.set(tool.name, tool);
    } catch { /* forge dir unreadable — start with none */ }
    this.subAgentSpawner = subAgentSpawner;
    this.acpManager = acpManager || agentRuntime?.acp;
    this.codingHarness = codingHarness || agentRuntime?.codingHarness;
    this.observationCache = new Map();
    this.failedObservationCache = new Map();
    this.inFlightToolKeys = new Set();
    this.duplicateSideEffectKeys = new Set();
    // In-run plans written by update_plan, keyed by runId (bounded).
    this.runPlans = new Map();
    // T2.2: toolsets enabled mid-run via enable_toolset, keyed by runId.
    // Read by the menu builder so later rounds see the new tools.
    this.runToolsets = new Map();
    // Progressive disclosure: toolsets loaded for the whole SESSION via
    // load_toolset, keyed by sessionId. Bounded like runToolsets.
    this.sessionToolsets = new Map();
    // Latest plan per SESSION — survives across runs, so a new run (fresh
    // model after a rate-limit switch, or a "continue") can inherit the
    // previous run's unfinished plan instead of starting blind.
    this.sessionPlans = new Map();
    this.tools = {
      // Drive the user's OWN already-running Chrome over CDP (their profile,
      // their logins) instead of the fresh Playwright browser above. Spread
      // first so any later key here would deliberately win a name collision.
      ...createBrowserRemoteTools(),
      time_now: {
        description: "Current local time (ISO). The prompt date suffices otherwise.",
        permission: null,
        run: async () => ({
          now: new Date().toISOString(),
        }),
      },
      connected_apps_status: {
        description: "Show connected apps (GitHub, Gmail) and the current Computer Use permission. OAuth tokens are never returned.",
        permission: null,
        group: "connected-apps",
        run: async () => this.appConnections?.getCatalog?.() || { apps: [], computerUse: { enabled: false }, message: "Connected Apps runtime is unavailable." },
      },
      github_list_repositories: {
        description: "List repositories from the user's connected GitHub account. Requires a GitHub connection approved in Plugins.",
        permission: "allowConnectorWrite",
        group: "connected-apps",
        schema: { type: "object", properties: { visibility: { type: "string", description: "all, public, or private (default all)" }, limit: { type: "number", description: "1-100, default 30" } } },
        run: async (input = {}) => this.appConnections?.githubListRepositories?.(input) || { error: true, message: "GitHub connection runtime is unavailable." },
      },
      github_search_issues: {
        description: "Search issues and pull requests in the user's connected GitHub account. Requires a GitHub connection approved in Plugins.",
        permission: "allowConnectorWrite",
        group: "connected-apps",
        schema: { type: "object", required: ["query"], properties: { query: { type: "string", description: "GitHub search query, e.g. repo:owner/repo is:open bug" }, limit: { type: "number", description: "1-100, default 20" } } },
        run: async (input = {}) => this.appConnections?.githubSearchIssues?.(input) || { error: true, message: "GitHub connection runtime is unavailable." },
      },
      gmail_search_messages: {
        description: "Search message metadata from the user's connected Gmail account. Read-only: returns sender, subject, date, and snippet, never sends email.",
        permission: "allowConnectorWrite",
        group: "connected-apps",
        schema: { type: "object", properties: { query: { type: "string", description: "Optional Gmail search syntax, e.g. from:alice newer_than:7d" }, limit: { type: "number", description: "1-50, default 10" } } },
        run: async (input = {}) => this.appConnections?.gmailSearchMessages?.(input) || { error: true, message: "Gmail connection runtime is unavailable." },
      },
      gmail_get_message: {
        description: "Read metadata and a short snippet for one Gmail message from a prior gmail_search_messages result. Read-only; does not send or modify email.",
        permission: "allowConnectorWrite",
        group: "connected-apps",
        schema: { type: "object", required: ["id"], properties: { id: { type: "string", description: "Gmail message id from gmail_search_messages" } } },
        run: async (input = {}) => this.appConnections?.gmailGetMessage?.(input) || { error: true, message: "Gmail connection runtime is unavailable." },
      },
      enable_toolset: {
        description: "Load a toolset for this run when the task needs tools outside CORE (browser, computer, project, comms, memory-admin, mcp, self, forge, git-write, web). Pass {name, reason}; later rounds see the new tools. NOT for things CORE already covers.",
        permission: null,
        group: "delegation",
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Toolset name (see capabilities toolsets)." },
            reason: { type: "string", description: "One line on why this run needs it." },
          },
        },
        run: async ({ name, reason } = {}, context = {}) => {
          const toolset = String(name || "").trim();
          if (!toolset) throw new Error("name is required.");
          const runId = String(context.runId || "").trim();
          const active = runId ? this.enableRunToolset(runId, toolset) : [toolset];
          this.agentRuntime?.gateway?.addEvent?.("toolset.enabled", {
            name: toolset,
            reason: String(reason || "").slice(0, 200),
            runId,
            sessionId: String(context.sessionId || ""),
            agentId: this.getAgentId(context),
          });
          return { ok: true, toolset, active, message: `${toolset} tools are now in this run's menu.` };
        },
      },
      list_toolsets: {
        description: "List loadable toolsets (name + one-line purpose + tool count). The default menu is a ~22-tool core; everything else loads on demand.",
        permission: null,
        group: "delegation",
        schema: { type: "object", properties: {} },
        run: async () => ({
          toolsets: Object.entries(TOOLSETS).map(([name, set]) => ({
            name,
            purpose: set.description || "",
            // Effective menu-visible members only (alias/drop/operator ids
            // never enter a menu, so they must not inflate the count).
            tools: (set.members || []).filter((id) => !ALIAS_IDS.has(id) && !DROP_IDS.has(id) && !OPERATOR_IDS.has(id)).length,
          })),
          hint: "Call load_toolset {name} to activate one for the rest of the session.",
        }),
      },
      load_toolset: {
        description: "Activate one named toolset (see list_toolsets) for the rest of THIS session. Prefer this over guessing tool names. Loading re-anchors the context cache (one INFO event), so load rarely — batch your needs first.",
        permission: null,
        group: "delegation",
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Toolset name from list_toolsets." },
            reason: { type: "string", description: "One line on why this session needs it." },
          },
        },
        run: async ({ name, reason } = {}, context = {}) => {
          const toolset = String(name || "").trim();
          if (!toolset) throw new Error("name is required.");
          if (!TOOLSETS[toolset]) throw new Error(`Unknown toolset: ${toolset}. Call list_toolsets for names.`);
          const sessionId = String(context.sessionId || "").trim();
          const runId = String(context.runId || "").trim();
          // Session pin (survives across runs) + current-run enablement so
          // later rounds of THIS run see the tools immediately.
          const pinned = sessionId ? this.enableSessionToolset(sessionId, toolset) : [toolset];
          if (runId) this.enableRunToolset(runId, toolset);
          this.agentRuntime?.gateway?.addEvent?.("toolset.session_pinned", {
            name: toolset,
            reason: String(reason || "").slice(0, 200),
            runId,
            sessionId,
            agentId: this.getAgentId(context),
          });
          return { ok: true, toolset, pinned, message: `${toolset} tools are now available for the rest of this session.` };
        },
      },
      finish: {
        description: "Report the final result and end the run ({summary, ok}). Do the verification FIRST — finish is a report, not a substitute for proving the work.",
        permission: null,
        group: "delegation",
        schema: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string", description: "User-facing result summary with evidence (paths, outputs, test results)." },
            ok: { type: "boolean", description: "Whether the task succeeded." },
          },
        },
        run: async ({ summary, ok = true } = {}) => ({
          finished: true,
          ok: ok !== false,
          summary: String(summary || "").slice(0, 4000),
        }),
      },
      update_plan: {
        description: "Track the task plan (pass the FULL plan; exactly ONE step in_progress; each step needs an executable verification). NOT for single-action tasks. Small/single-file deliverable: skip the plan or use at most 2 steps (write complete file, then verify) — write the complete file first, don't split one file across rounds. Call with NO arguments to see the current plan.",
        permission: null,
        group: "planning",
        schema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              description: "The complete plan. Exactly one step in_progress at a time (WIP=1) — except steps modifying the SAME single file, which may complete together in one write.",
              items: {
                type: "object",
                required: ["title", "status"],
                properties: {
                  title: { type: "string", description: "Short imperative step title (one atomic unit of work)." },
                  status: { type: "string", enum: ["pending", "in_progress", "completed", "skipped", "blocked"] },
                  verification: { type: "string", description: "Executable completion evidence for this step (e.g. a test/curl/build command). Required to mark a step completed honestly." },
                },
              },
            },
            note: { type: "string", description: "Optional one-line note about what changed." },
          },
        },
        run: async ({ steps, note } = {}, context = {}) => {
          const runId = String(context.runId || "").trim();
          const normalized = (Array.isArray(steps) ? steps : [])
            .map((step) => ({
              title: String(step?.title || "").trim().slice(0, 200),
              status: ["pending", "in_progress", "completed", "skipped", "blocked"].includes(step?.status) ? step.status : "pending",
              verification: String(step?.verification || "").trim().slice(0, 300),
            }))
            .filter((step) => step.title)
            .slice(0, 30);
          if (normalized.length === 0) {
            // Empty call = "show me the plan" (weak models emit update_plan {}
            // when they want to re-read the plan — 2026-09-23 live run: 4
            // consecutive empty calls ate rounds 10-13 and the stuck detector
            // killed the run). Answer with the CURRENT plan so the loop turns
            // into forward motion instead of a repeated teaching block.
            const sessionId0 = String(context.sessionId || "").trim();
            const existing = (runId && this.runPlans.get(runId)) || (sessionId0 && this.sessionPlans.get(sessionId0));
            if (existing && Array.isArray(existing.steps) && existing.steps.length > 0) {
              const open = existing.steps.filter((s) => s.status !== "completed" && s.status !== "skipped");
              return {
                ok: true,
                noArgs: true,
                note: "No steps were sent, so nothing changed — this is the CURRENT active plan. Continue executing it now; call update_plan again only when a step finished or the plan truly changes, and then send the FULL steps array.",
                currentStep: (open[0] && open[0].title) || "",
                plan: existing.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.verification ? ` (verify: ${s.verification})` : ""}`).join("\n"),
              };
            }
            return { error: true, message: "steps array with at least one {title, status} entry is required. Example: update_plan({\"steps\": [{\"title\": \"Build index.html\", \"status\": \"in_progress\", \"verification\": \"file exists and opens\"}]})" };
          }
          const activeCount = normalized.filter((s) => s.status === "in_progress").length;
          const completed = normalized.filter((s) => s.status === "completed").length;
          // WIP=1: surface a warning (and a guard message) when more than one
          // step is active, so the agent finishes one before starting another.
          const wipViolation = activeCount > 1;
          const plan = {
            steps: normalized,
            note: String(note || "").trim().slice(0, 300),
            updatedAt: new Date().toISOString(),
          };
          if (runId) {
            this.runPlans.set(runId, plan);
            if (this.runPlans.size > 50) {
              this.runPlans.delete(this.runPlans.keys().next().value);
            }
          }
          const sessionId = String(context.sessionId || "").trim();
          if (sessionId) {
            this.sessionPlans.set(sessionId, plan);
            if (this.sessionPlans.size > 50) {
              this.sessionPlans.delete(this.sessionPlans.keys().next().value);
            }
          }
          this.agentRuntime?.gateway?.addEvent?.("plan.updated", {
            runId,
            sessionId: context.sessionId || "",
            agentId: this.getAgentId(context),
            steps: normalized,
            note: plan.note,
            completed,
            total: normalized.length,
            activeCount,
            wipViolation,
          });
          return {
            saved: true,
            completed,
            total: normalized.length,
            activeCount,
            verifiedCompletionRate: normalized.length ? Number((completed / normalized.length).toFixed(2)) : 0,
            ...(wipViolation
              ? { wipWarning: `WIP=1 violated: ${activeCount} steps are in_progress. Keep only ONE active — finish and verify it before starting the next. Exception: steps modifying the SAME single file may complete together in one write.` }
              : {}),
            plan: normalized.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.verification ? ` (verify: ${s.verification})` : ""}`).join("\n"),
          };
        },
      },
      remember_note: {
        description: "Save a short note into persistent memory.",
        permission: "allowNoteWrite",
        schema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string" },
          },
        },
        run: async ({ text }, context) => {
          const note = this.memoryStore.addNote(String(text || "").trim(), {
            agentId: this.getAgentId(context),
          });
          return { saved: true, note };
        },
      },
      memory_write: {
        description: "Save a durable fact (long-term identity/preferences as one sentence) or a daily note. NOT for session trivia.",
        permission: "allowMemoryWrite",
        group: "memory",
        schema: {
          type: "object",
          required: ["content"],
          properties: {
            type: { type: "string", enum: ["session", "daily", "long-term"], description: "long-term = durable cross-session fact; daily = today's working note" },
            content: { type: "string", description: "The fact/note itself — self-contained, one to three sentences" },
            title: { type: "string", description: "Short title (max ~8 words) for long-term memories" },
            tags: { type: "array", items: { type: "string" }, description: "Optional topic tags for recall" },
            importance: { type: "string", enum: ["low", "medium", "high"] },
            source: { type: "string" },
            expiry: { type: "string" },
            actionBoundary: { type: "string" },
          },
        },
        run: async (input = {}, context) => this.memoryStore.writeLayeredMemory({
          ...input,
          agentId: input.agentId || this.getAgentId(context),
          sessionId: input.sessionId || context.sessionId || "",
          runId: input.runId || context.runId || "",
        }),
      },
      list_notes: {
        description: "List all saved notes.",
        permission: null,
        run: async (_, context) => ({
          notes: this.memoryStore.getNotes(this.getAgentId(context)),
        }),
      },
      list_long_term_memory: {
        description: "List promoted long-term memories for the active agent.",
        permission: null,
        run: async (_, context) => ({
          memories: this.memoryStore.getLongTermMemory(50, this.getAgentId(context)),
          dreams: this.memoryStore.getDreams(10, this.getAgentId(context)),
          overview: this.memoryStore.getOverview(this.getAgentId(context)),
        }),
      },
      promote_memory: {
        description: "Promote a note, conversation, research item, or manual text into long-term memory.",
        permission: "allowMemoryPromotion",
        run: async (input, context) =>
          this.memoryStore.promoteMemory({
            ...input,
            agentId: input.agentId || this.getAgentId(context),
          }),
      },
      memory_replace: {
        description: "Fix or update an EXISTING long-term memory in place. Find it by a short substring of its title/text that matches exactly one memory, then overwrite its text (and optionally title). Use this when a saved fact is wrong or outdated — do NOT save a duplicate corrected memory with memory_write.",
        permission: "allowMemoryWrite",
        group: "memory",
        schema: {
          type: "object",
          required: ["match", "text"],
          properties: {
            match: { type: "string", description: "Short unique substring of the memory's current title or text, e.g. \"prefers dark mode\"." },
            text: { type: "string", description: "The corrected, self-contained content that replaces the memory's text." },
            title: { type: "string", description: "Optional new title; omit to keep the current one." },
          },
        },
        run: async ({ match, text, title } = {}, context) =>
          this.memoryStore.replaceMemory({
            match,
            text,
            title,
            agentId: this.getAgentId(context),
          }),
      },
      memory_forget: {
        description: "Delete a long-term memory that is stale, wrong, or no longer relevant. Find it by a short substring of its title/text that matches exactly one memory. Deletion is permanent — prefer memory_replace when the fact just needs correcting.",
        permission: "allowMemoryWrite",
        group: "memory",
        schema: {
          type: "object",
          required: ["match"],
          properties: {
            match: { type: "string", description: "Short unique substring of the memory's title or text." },
          },
        },
        run: async ({ match } = {}, context) =>
          this.memoryStore.removeMemory({
            match,
            agentId: this.getAgentId(context),
          }),
      },
      dream_memory_sweep: {
        description: "Run a lightweight memory review that promotes high-value candidates.",
        permission: "allowDreamSweep",
        run: async (input, context) =>
          this.memoryStore.runDreamSweep({
            ...input,
            agentId: input.agentId || this.getAgentId(context),
            provider: this.agentRuntime?.provider,
            // Background scoring rides the cheap compaction model, never the
            // main model (empty = unchanged legacy behavior).
            model: this.configStore.getConfig()?.provider?.compactionModel || "",
          }),
      },
      scan_file_drop: {
        description: "Scan the local data/inbox folder and process new text files as connector messages.",
        permission: "allowConnectorWrite",
        run: async (input, context) => {
          if (!this.agentRuntime?.scanFileDrop) {
            throw new Error("File-drop connector runtime is unavailable.");
          }
          return this.agentRuntime.scanFileDrop({
            ...input,
            agentId: input.agentId || "",
          });
        },
      },
      cleanup_attachment_cache: {
        description: "Apply the attachment retention policy and purge old or oversized cached connector files.",
        permission: "allowConnectorWrite",
        run: async (input = {}) => {
          if (!this.connectorStore?.cleanupAdapterAttachmentCache) {
            throw new Error("Attachment cleanup runtime is unavailable.");
          }
          return this.connectorStore.cleanupAdapterAttachmentCache({
            dryRun: input.dryRun !== false,
            force: input.force === true,
            policy: input.policy && typeof input.policy === "object" ? input.policy : {},
          });
        },
      },
      analyze_attachment_media: {
        description: "Run OCR/transcription media analysis for one cached media attachment extract.",
        permission: "allowConnectorWrite",
        run: async (input = {}) => {
          if (!this.connectorStore?.analyzeAdapterAttachmentMedia) {
            throw new Error("Media analysis runtime is unavailable.");
          }
          return this.connectorStore.analyzeAdapterAttachmentMedia({
            extractId: input.extractId || input.id || "",
            cacheId: input.cacheId || "",
            deliveryId: input.deliveryId || "",
            attachmentIndex: Number(input.attachmentIndex || 0),
            force: input.force === true,
            policy: input.policy && typeof input.policy === "object" ? input.policy : {},
          });
        },
      },
      analyze_pending_media_attachments: {
        description: "Analyze recent pending image, PDF, audio, or video attachment metadata records.",
        permission: "allowConnectorWrite",
        run: async (input = {}) => {
          if (!this.connectorStore?.analyzePendingMediaAttachments) {
            throw new Error("Media analysis runtime is unavailable.");
          }
          return this.connectorStore.analyzePendingMediaAttachments({
            limit: Number(input.limit || 5),
            force: input.force === true,
            policy: input.policy && typeof input.policy === "object" ? input.policy : {},
          });
        },
      },
      create_task: {
        description: "Create one tracked task. NOT for plan steps (use update_plan).",
        permission: "allowTaskWrite",
        run: async (input = {}, context) => {
          const title = String(input.title || input.objective || "").trim();
          const plan = Array.isArray(input.plan) ? input.plan : this.buildTaskPlan(input);
          const toolPlan = Array.isArray(input.toolPlan) ? input.toolPlan : this.buildTaskToolPlan(input);
          const acceptanceCriteria = Array.isArray(input.acceptanceCriteria)
            ? input.acceptanceCriteria
            : this.buildTaskAcceptanceCriteria(input);
          const task = this.taskStore.createTask(String(title || "").trim(), {
            agentId: this.getAgentId(context),
            objective: input.objective || title,
            sourceMessage: input.sourceMessage || input.message || "",
            taskType: input.taskType || this.inferTaskType(input),
            priority: input.priority || "normal",
            plan,
            toolPlan,
            acceptanceCriteria,
            automation: input.automation || null,
            context: {
              createdFrom: context.source || "chat",
              sessionId: context.sessionId || "",
              runId: context.runId || "",
            },
          });
          return { created: true, task, plan, toolPlan, acceptanceCriteria };
        },
      },
      list_tasks: {
        description: "List tracked tasks. NOT a substitute for update_plan on multi-step work.",
        permission: null,
        run: async (_, context) => ({
          tasks: this.taskStore.listTasks(this.getAgentId(context)),
        }),
      },
      todo: {
        description: "Hermes-compatible todo/task tool.",
        permission: "allowTaskWrite",
        group: "hermes-planning",
        run: async ({ action, title } = {}, context) => {
          const normalized = String(action || (title ? "create" : "list")).toLowerCase();
          if (["create", "add", "new"].includes(normalized)) {
            return this.tools.create_task.run({ title }, context);
          }
          return this.tools.list_tasks.run({}, context);
        },
      },
      runtime_summary: {
        description: "Summarize current runtime profile and provider mode.",
        permission: null,
        run: async (_, context) => {
          const config = this.configStore.getConfig();
          const agentId = this.getAgentId(context);
          const agent = this.agentRegistry?.resolveAgent(agentId) || null;
          const profile = agent
            ? this.configStore.getProfile(agent.profileId)
            : this.configStore.getActiveProfile();
          return {
            agent,
            profile,
            providerMode: config.provider.mode,
          };
        },
      },
      provider_status: {
        description: "Diagnose the active model/provider brain, auth readiness, command path, and next fix.",
        permission: null,
        group: "runtime",
        run: async ({ verify } = {}) => {
          const info = this.agentRuntime?.getProviderInfo?.() || {};
          let live = null;
          if (verify && this.agentRuntime?.provider?.testConnection) {
            try {
              live = await this.agentRuntime.provider.testConnection({
                verifyAuth: true,
                timeoutMs: 30000,
                prompt: "Reply with exactly: ok",
              });
            } catch (error) {
              live = {
                ok: false,
                error: error.message,
              };
            }
          }
          const ready = Boolean(info.ready);
          const liveOk = live ? Boolean(live.ok) : null;
          const needsAuth = (live && !liveOk) || (!ready && /auth|login|codex|key|not found|could not run/i.test(String(info.message || "")));
          return {
            ready: live ? liveOk : ready,
            provider: info.id || "unknown",
            mode: info.mode || "",
            model: info.model || "",
            command: info.command || "",
            commandPath: info.commandPath || "",
            commandVersion: info.commandVersion || "",
            apiKeyConfigured: Boolean(info.apiKeyConfigured),
            apiKeySource: info.apiKeySource || "",
            message: info.message || "",
            verified: Boolean(live),
            live,
            needsAuth,
            nextFix: needsAuth
              ? "Open a terminal and run codex login for ChatGPT/Codex bridge, or switch to an OpenAI-compatible BYOK provider with base URL, model, and API key."
              : live
                ? "Provider live reply test passed."
                : ready
                ? "Provider brain is ready."
                : "Check provider profile, base URL, model name, command path, and saved API key.",
          };
        },
      },
      prompt_trace: {
        description: "Inspect the sanitized prompt/context trace for a completed run.",
        permission: null,
        group: "runtime",
        run: async ({ runId }) => {
          const trace = this.agentRuntime?.getPromptTrace?.(String(runId || "").trim());
          if (!trace) {
            return {
              found: false,
              message: "Run not found.",
            };
          }
          return {
            found: true,
            ...trace,
          };
        },
      },
      prompt_assembly_status: {
        description: "Hermes-style prompt assembly report: identity files, project context discovery, injection defense, and context budget.",
        permission: null,
        group: "runtime",
        run: async (_, context) => this.getPromptAssemblyStatus(context),
      },
      tool_trace: {
        description: "Inspect the per-run tool execution ledger with inputs, outputs, status, and timing.",
        permission: null,
        group: "runtime",
        run: async ({ runId }) => {
          const trace = this.agentRuntime?.getToolTrace?.(String(runId || "").trim());
          if (!trace) {
            return {
              found: false,
              message: "Run not found.",
            };
          }
          return {
            found: true,
            ...trace,
          };
        },
      },
      v2_status: {
        description: "OmniClaw V2 feature health report with scores, weak features, evidence, and gaps.",
        permission: null,
        group: "runtime",
        run: async () => this.agentRuntime?.getV2Report?.() || {
          version: "v2-unavailable",
          score: 0,
          features: [],
          weakest: [],
        },
      },
      v2_repair_plan: {
        description: "Generate a prioritized OmniClaw V2 repair plan from the live feature health report.",
        permission: null,
        group: "runtime",
        run: async () => {
          const report = this.agentRuntime?.getV2Report?.() || { weakest: [], nextMilestones: [] };
          const weakest = Array.isArray(report.weakest) ? report.weakest : [];
          return {
            version: report.version || "v2-foundation",
            score: report.score || 0,
            criticalScore: report.criticalScore || 0,
            immediateRepairs: weakest.slice(0, 5).map((item, index) => ({
              rank: index + 1,
              feature: item.name,
              status: item.status,
              priority: item.priority,
              gaps: item.gaps,
              nextAction: item.nextAction,
            })),
            milestones: report.nextMilestones || [],
            rule: "Do not claim a feature is done unless status is ready and evidence is present.",
          };
        },
      },
      capability_demo: {
        description: "Return a practical demo of the active agent's real tools, skills, and example tasks.",
        permission: null,
        group: "runtime",
        run: async (_, context) => {
          const agentId = this.getAgentId(context);
          const tools = this.getAll({ agentId });
          const productReadyTools = tools.filter((tool) => tool.productReady !== false);
          const limitedTools = tools.filter((tool) => tool.productReady === false);
          const skills = this.agentRegistry
            ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
            : [];
          const toolIds = productReadyTools.map((tool) => tool.id);
          return {
            agentId,
            toolCount: tools.length,
            productReadyToolCount: productReadyTools.length,
            limitedToolCount: limitedTools.length,
            skillCount: skills.length,
            coreTools: toolIds.filter((id) => [
              "exec",
              "process",
              "code_execution",
              "browser",
              "browser_snapshot",
              "browser_audit",
              "web_search",
              "web_fetch",
              "read",
              "write",
              "edit",
              "copy_computer_path",
              "move_computer_path",
              "computer_access_audit",
              "sessions_list",
              "sessions_history",
              "memory_search",
              "gateway",
              "cron",
              "nodes",
              "mcp_integration_status",
              "mcp_connect_all",
              "trajectory_training_status",
              "closed_learning_loop_status",
              "hermes_use_cases_status",
              "design_principles_status",
            ].includes(id)),
            skills: skills.map((skill) => ({
              id: skill.id,
              name: skill.name,
              triggers: skill.triggers,
            })),
            limitedTools: limitedTools.slice(0, 24).map((tool) => ({
              id: tool.id,
              status: tool.runtimeStatus,
              replacement: tool.replacement,
              reason: tool.readinessReason,
            })),
            demos: [
              "Ask: 'laptop status check karo' -> computer_system_status runs.",
              "Ask: 'list files' or 'read file README.md' -> filesystem tools run.",
              "Ask: 'search web OpenClaw tools' -> web_search/web_research runs.",
              "Ask: 'gateway status' -> gateway/provider/session diagnostics run.",
              "Ask: 'run terminal command \"Get-Date\"' -> governed exec runs with audit logs.",
            ],
          };
        },
      },
      real_task_health: {
        description: "Run a product-grade real-task health probe across tools, skills, provider, files, terminal, browser, memory, and model routing.",
        permission: null,
        group: "runtime",
        run: async (input = {}, context) => this.getRealTaskHealth({
          live: input.live !== false,
          context,
        }),
      },
      layer_status: {
        description: "Report OmniClaw's OpenClaw-style layer 1-5 architecture status, gaps, and next upgrades.",
        permission: null,
        run: async () => {
          if (!this.agentRuntime?.getOpenClawLayerReport) {
            throw new Error("Layer report runtime is unavailable.");
          }
          return this.agentRuntime.getOpenClawLayerReport();
        },
      },
      self_build_plan: {
        description: "Create a Codex + OpenClaw implementation plan for improving OmniClaw itself.",
        permission: null,
        run: async ({ focus } = {}, context) => {
          const config = this.configStore.getConfig();
          const provider = this.agentRuntime?.getProviderInfo?.() || {};
          const tools = this.getAll({ agentId: this.getAgentId(context) });
          const scripts = {
            build: "npm.cmd run build",
            test: "npm.cmd run test",
            chatAgentSmoke: "npm.cmd run test:chat-agent",
            portableBuild: "npm.cmd run portable:build",
            release: "npm.cmd run release:windows",
          };
          const docs = [
            "docs/OMNICLAW_CODEX_OPENCLAW_ARCHITECTURE.md",
            "docs/OPENCLAW_UI_DEEP_STUDY.md",
            "docs/WINDOWS_INSTALLER_PLAN.md",
            "docs/SHELL_EXECUTION_GOVERNANCE.md",
            "docs/BYOK_PROVIDER_SETUP.md",
          ];

          return {
            focus: focus || "self-build",
            architecture: {
              brain: provider.ready && provider.id !== "mock/local-rule-engine"
                ? `Remote LLM provider ${provider.id} is ready.`
                : "Offline task engine is active; connect BYOK/API key for the real LLM brain.",
              hands: [
                "safe shell execution",
                "file read/write/copy/move/delete inside protected roots",
                "build/test/release commands",
                "task runner",
                "plugins",
                "connectors",
                "scheduler",
              ],
              eyes: [
                "workspace files",
                "system status",
                "sessions and gateway events",
                "memory and artifacts",
                "connector inboxes",
                "logs through command output",
              ],
              loop: "intent -> plan -> act with tools -> observe outputs -> provider final response",
            },
            currentProvider: provider,
            shellPolicy: {
              trustLevel: config.tools?.shellExecution?.trustLevel || "protected",
              allowlistMode: config.tools?.shellExecution?.allowlistMode || "advisory",
              allowlistCount: config.tools?.shellExecution?.allowlistPatterns?.length || 0,
            },
            toolSurface: {
              count: tools.length,
              coreTools: tools.slice(0, 16).map((tool) => tool.id),
            },
            implementationPlan: [
              {
                step: "Make the chat reply human-first",
                status: "done",
                detail: "Greetings and API setup no longer dump raw intent/plan text.",
              },
              {
                step: "Make safe local work executable",
                status: "done",
                detail: "Build/test/release requests map to allowlisted shell commands.",
              },
              {
                step: "Add self-build planner",
                status: "in_progress",
                detail: "Expose architecture, tools, scripts, docs, and next actions inside OmniClaw.",
              },
              {
                step: "Add richer hands",
                status: "next",
                detail: "Teach OmniClaw to apply scoped code patches and inspect browser screenshots through governed tools.",
              },
              {
                step: "Add stronger brain loop",
                status: "next",
                detail: "Use provider tool-call JSON for repeated think-act-observe cycles when an API key is configured.",
              },
            ],
            scripts,
            docs,
            nextPromptExamples: [
              "test karo",
              "release zip banao",
              "api key setup",
              "OmniClaw self build plan",
              "read file docs/OMNICLAW_CODEX_OPENCLAW_ARCHITECTURE.md",
            ],
          };
        },
      },
      list_files: {
        description: "List a workspace directory (recursive maps a subtree, skips node_modules/.git/dist). Start here for orientation. NOT for system-wide search.",
        permission: "allowDirectoryList",
        schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory path, defaults to ." },
            recursive: { type: "boolean", description: "true = walk subdirectories and return relative paths." },
            maxDepth: { type: "number", description: "Recursion depth when recursive (default 4)." },
            maxEntries: { type: "number", description: "Max entries to return when recursive (default 800)." },
          },
        },
        run: async ({ path, recursive, maxDepth, maxEntries }, context) => {
          const files = this.chatFiles(context);
          if (recursive) {
            return files.listDirectoryRecursive(path || ".", { maxDepth, maxEntries });
          }
          // Token diet: non-recursive lists cap at 200 entries with a note
          // (the source was unbounded: every entry rode the full payload).
          // 200 aligns with sanitizeToolResult's nested-array bound below, so
          // the omitted count stays truthful instead of silently shrinking.
          const listing = files.listDirectory(path || ".");
          const entries = Array.isArray(listing) ? listing : (listing.entries || []);
          const omitted = Math.max(0, entries.length - 200);
          return {
            path: path || ".",
            entries: entries.slice(0, 200),
            ...(omitted > 0
              ? { omittedEntries: omitted, note: `showing 200/${entries.length} entries. Narrow with path or use recursive with maxEntries.` }
              : {}),
          };
        },
      },
      computer_access_status: {
        description: "Show configured laptop/computer access roots, terminal policy, and browser capability.",
        permission: null,
        schema: { type: "object", properties: {} },
        run: async () => {
          const config = this.configStore.getConfig();
          const policy = this.getComputerAccessPolicy();
          const shellPolicy = config.tools?.shellExecution || {};
          const recentOperations = this.getComputerAccessAudit(8);
          return {
            enabled: policy.enabled,
            allowedRoots: policy.allowedRoots,
            allowWrite: policy.allowWrite !== false,
            allowDelete: policy.allowDelete !== false,
            deleteMode: policy.allowPermanentDelete ? "permanent-delete-allowed" : "move-to-data-trash",
            blockedPathPatterns: policy.blockedPathPatterns,
            terminal: {
              enabled: Boolean(config.tools?.permissions?.allowShellExecution),
              trustLevel: shellPolicy.trustLevel || "protected",
              allowlistMode: shellPolicy.allowlistMode || "advisory",
              cwd: shellPolicy.cwd || ".",
              timeoutMs: shellPolicy.timeoutMs || 15000,
            },
            sandbox: this.sandboxRunner?.getStatus?.() || {},
            browser: {
              openUrl: true,
              readUrl: true,
              automation: this.browserOperator.getStatus?.() || {},
              operations: ["browser_snapshot", "browser_links", "browser_screenshot", "browser_text", "browser_audit"],
            },
            operations: {
              available: [
                "list_computer_directory",
                "search_computer_files",
                "read_computer_file",
                "write_computer_file",
                "create_computer_directory",
                "copy_computer_path",
                "move_computer_path",
                "delete_computer_path",
              ],
              recent: recentOperations,
            },
          };
        },
      },
      search_computer_files: {
        description: "Search file and folder names across configured laptop access roots.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Filename, folder name, or text to search." },
            roots: { type: "array", items: { type: "string" }, description: "Optional roots like ~/Downloads or C:/Users/name/Documents." },
            maxDepth: { type: "number" },
            maxResults: { type: "number" },
            maxScanMs: { type: "number" },
          },
        },
        run: async (input = {}, context) => {
          const result = this.fileStore.searchComputerFiles(input, this.requireComputerAccessPolicy());
          this.recordComputerAccessOperation("search", {
            path: result.roots?.join(", ") || "",
            type: "search",
            bytes: result.results?.length || 0,
          }, context);
          return result;
        },
      },
      computer_access_audit: {
        description: "List recent governed computer-access operations captured in the gateway audit feed.",
        permission: "allowComputerAccess",
        run: async ({ limit }) => ({
          operations: this.getComputerAccessAudit(Number(limit || 25)),
        }),
      },
      list_computer_directory: {
        description: "List files from configured laptop access roots such as the user home folder.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Computer path, e.g. ~, ~/Downloads, ~/Documents, C:/Users/name/Desktop." },
          },
        },
        run: async ({ path }, context) => {
          const result = this.fileStore.listComputerDirectory(path || "~", this.requireComputerAccessPolicy());
          this.recordComputerAccessOperation("list", result, context);
          return result;
        },
      },
      read_computer_file: {
        description: "Read a text file from configured laptop access roots.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Computer file path, e.g. ~/Downloads/notes.txt." },
          },
        },
        run: async ({ path }, context) => {
          const guarded = binaryReadGuard(path);
          if (guarded) return guarded;
          const config = this.configStore.getConfig();
          const result = this.fileStore.readComputerText(
            path,
            config.tools?.computerAccess?.maxReadBytes || 131072,
            this.requireComputerAccessPolicy(),
          );
          this.recordComputerAccessOperation("read", { ...result, content: undefined }, context);
          return result;
        },
      },
      write_computer_file: {
        description: "Write or append a text file inside configured laptop access roots.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Computer file path inside allowed roots, e.g. ~/Downloads/omniclaw-output.txt." },
            content: { type: "string", description: "Exact text content to write." },
            append: { type: "boolean", description: "Append instead of overwrite." },
          },
        },
        run: async ({ path, content, append }, context) => {
          const result = this.fileStore.writeComputerText(path, String(content || ""), {
            append: Boolean(append),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation(append ? "append" : "write", result, context);
          return result;
        },
      },
      create_computer_directory: {
        description: "Create a directory inside configured laptop access roots.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Computer directory path inside allowed roots." },
          },
        },
        run: async ({ path }, context) => {
          const result = this.fileStore.createComputerDirectory(path, this.requireComputerAccessPolicy());
          this.recordComputerAccessOperation("mkdir", result, context);
          return result;
        },
      },
      copy_computer_path: {
        description: "Copy a file or folder between configured laptop access roots.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string" },
            source: { type: "string" },
            to: { type: "string" },
            destination: { type: "string" },
            overwrite: { type: "boolean" },
          },
        },
        run: async ({ from, source, to, destination, overwrite }, context) => {
          const result = this.fileStore.copyComputerPath(from || source, to || destination, {
            overwrite: Boolean(overwrite),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation("copy", result, context);
          return result;
        },
      },
      move_computer_path: {
        description: "Move or rename a file or folder inside configured laptop access roots.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          required: ["from", "to"],
          properties: {
            from: { type: "string" },
            source: { type: "string" },
            to: { type: "string" },
            destination: { type: "string" },
            overwrite: { type: "boolean" },
          },
        },
        run: async ({ from, source, to, destination, overwrite }, context) => {
          const result = this.fileStore.moveComputerPath(from || source, to || destination, {
            overwrite: Boolean(overwrite),
            policy: this.requireComputerAccessPolicy(),
          });
          this.recordComputerAccessOperation("move", result, context);
          return result;
        },
      },
      delete_computer_path: {
        description: "Delete a file or folder inside configured laptop access roots. By default it moves the item to data/trash for restore.",
        permission: "allowComputerAccess",
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            permanent: { type: "boolean", description: "Permanent delete only if explicitly requested and policy allows it." },
            confirmAgentWorkspaceDelete: { type: "boolean" },
          },
        },
        run: async ({ path, permanent, confirmAgentWorkspaceDelete }, context) => {
          const policy = this.requireComputerAccessPolicy();
          const target = this.fileStore.resolveComputerPath(path, policy);
          const overlappingAgentIds = findOverlappingWorkspaceAgentIds(
            this.agentRegistry,
            this.getAgentId(context),
            target,
          );
          if (overlappingAgentIds.length > 0 && !confirmAgentWorkspaceDelete) {
            return {
              path: target,
              deleted: false,
              blocked: true,
              reason: "Target overlaps another agent workspace.",
              overlappingAgentIds,
              confirmHint: "Pass confirmAgentWorkspaceDelete=true only after the user explicitly confirms deleting this shared/overlapping agent workspace path.",
            };
          }
          const result = this.fileStore.deleteComputerPath(path, {
            permanent: Boolean(permanent),
            policy,
          });
          this.recordComputerAccessOperation("delete", { ...result, overlappingAgentIds }, context);
          return result;
        },
      },
      read_file: {
        description: "Read a chat-project file with offset/limit paging and line numbers (default: first 400 lines; page with offset/limit for the rest). PATH: workspace-relative like 'src/app.js' (preferred) or absolute under the chat root; absolute paths outside the chat root are rejected naming the root. Always read before editing. NOT for huge dumps or cross-folder paths (use computer toolset). Example: {\"path\":\"package.json\"} or {\"path\":\"src/app.js\",\"offset\":1,\"limit\":120}.",
        permission: "allowFileRead",
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "REQUIRED. Workspace-relative path from the chat project root (e.g. 'src/app.js', 'package.json'). Absolute paths are honored only when confined inside the chat root; anything else fails closed naming the root." },
            offset: { type: "number", description: "OPTIONAL. 1-based start line. Omit for the first 400 lines; use offset+limit to page." },
            limit: { type: "number", description: "OPTIONAL. Lines to read from offset (max ~400 per call unless paging a large file)." },
            lineNumbers: { type: "boolean", description: "OPTIONAL. Default true. Keep true so edit find-text matches exact lines." },
            forceRead: { type: "boolean", description: "OPTIONAL. Default false. true = re-read even when the ledger says unchanged." },
          },
        },
        run: async ({ path, offset, limit, lineNumbers, forceRead }, context) => {
          const guarded = binaryReadGuard(path);
          if (guarded) return guarded;
          const config = this.configStore.getConfig();
          const files = this.chatFiles(context);
          // Session read cache (rounds-per-message lever): a bare re-read of
          // an unchanged file returns a pointer, not 8,000 chars. Explicit
          // windows always execute (unseen content); forceRead overrides.
          if (!forceRead && offset == null && limit == null) {
            const shortcut = this.checkUnchangedRead(path, context);
            if (shortcut) return shortcut;
          }
          // Default to a line-numbered view: without line numbers the model
          // cannot locate a reported error line (the #1 read/edit failure).
          const withLineNumbers = lineNumbers !== false;
          // Token diet: a bare read_file returns the first 400 lines as a
          // window (with total + continuation hint), NOT the whole 65KB file.
          // Explicit offset/limit still reads any window, including the tail.
          const windowedLimit = offset == null && limit == null ? 400 : limit;
          const result = files.readText(path, config.tools.filesystem.maxReadBytes, { offset, limit: windowedLimit, lineNumbers: withLineNumbers });
          // Knowledge near code: surface this module's docs/constraints so the
          // agent honors local rules without having to search for them.
          try {
            const nearby = files.findNearbyDocs(path);
            if (nearby.length) result.nearbyDocs = nearby;
          } catch { /* best effort */ }
          return result;
        },
      },
      search_text: {
        description: "Grep workspace file contents (regex) with paths and line numbers. Find code before reading or editing. NOT for whole-disk search.",
        permission: "allowFileRead",
        group: "fs",
        schema: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string", description: "Regular expression to match against each line." },
            path: { type: "string", description: "Workspace-relative directory to search (default: project root)." },
            glob: { type: "string", description: "Optional filename filter, e.g. \"*.js\" or \"**/*.css\"." },
            ignoreCase: { type: "boolean", description: "Case-insensitive match." },
            contextLines: { type: "number", description: "Lines of context before/after each match (0-5)." },
            maxResults: { type: "number", description: "Max matches to return (default 200)." },
          },
        },
        run: async ({ pattern, path: searchPath, glob, ignoreCase, contextLines, maxResults }, context) =>
          this.chatFiles(context).searchText(String(pattern || ""), {
            path: searchPath,
            glob,
            ignoreCase: Boolean(ignoreCase),
            contextLines: Number(contextLines || 0),
            maxResults: Number(maxResults || 200),
          }),
      },
      write_file: {
        description: "Create or overwrite a workspace file (≤2MB). Read first: the stale guard rejects blind overwrites. NOT for appending line-by-line or files over 2MB.",
        permission: "allowFileWrite",
        schema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Workspace-relative destination file path." },
            content: { type: "string", description: "Full text content to write." },
          },
        },
        run: async ({ path, content }, context) => {
          const config = this.configStore.getConfig();
          return this.chatFiles(context).writeText(path, String(content || ""), {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
        },
      },
      append_file: {
        description: "Append text to a file inside protected writable roots.",
        permission: "allowFileWrite",
        schema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Workspace-relative destination file path." },
            content: { type: "string", description: "Text content to append." },
          },
        },
        run: async ({ path, content }, context) => {
          const config = this.configStore.getConfig();
          return this.chatFiles(context).writeText(path, String(content || ""), {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: true,
          });
        },
      },
      create_directory: {
        description: "Create a folder (and any missing parent folders) in the project workspace. Cross-platform — ALWAYS use this instead of a shell `mkdir`/`mkdir -p` (those fail on Windows PowerShell). Tip: write_file already auto-creates parent folders, so you only need this for an EMPTY directory.",
        permission: "allowFileWrite",
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Workspace-relative folder path, e.g. airforce-site/src/components." },
          },
        },
        run: async ({ path: dirPath }, context) => {
          const config = this.configStore.getConfig();
          return this.chatFiles(context).createDirectory(dirPath, {
            allowedRoots: config.tools.filesystem.writableRoots,
          });
        },
      },
      verify_html_artifact: {
        description: "Verify a generated HTML artifact is nonblank, structured, and has interactive app pieces.",
        permission: "allowFileRead",
        run: async ({ path: artifactInputPath, requiredText = [], forbiddenText = [], minBytes = 1200 }) => {
          const config = this.configStore.getConfig();
          const file = this.fileStore.readText(artifactInputPath, config.tools.filesystem.maxReadBytes);
          const html = String(file.content || "");
          const artifactPath = String(file.path || artifactInputPath || "");
          const artifactDir = artifactPath.replace(/[^/\\]+$/i, "");
          const linkedAssetPaths = [
            ...[...html.matchAll(/<script\b[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]),
            ...[...html.matchAll(/<link\b(?=[^>]+rel=["']stylesheet["'])(?=[^>]+href=["']([^"']+)["'])[^>]*>/gi)].map((match) => match[1]),
          ]
            .map((asset) => String(asset || "").trim())
            .filter((asset) => asset && !/^(?:https?:|data:|#)/i.test(asset))
            .map((asset) => path.normalize(path.join(artifactDir || ".", asset)).replace(/\\/g, "/"));
          const linkedAssetText = linkedAssetPaths.map((assetPath) => {
            try {
              return this.fileStore.readText(assetPath, config.tools.filesystem.maxReadBytes).content || "";
            } catch {
              return "";
            }
          }).join("\n");
          const verificationText = `${html}\n${linkedAssetText}`;
          const bytes = file.totalBytes || file.bytesRead || Buffer.byteLength(html, "utf8");
          const required = Array.isArray(requiredText) ? requiredText.map((item) => String(item || "").trim()).filter(Boolean) : [];
          const forbidden = Array.isArray(forbiddenText) ? forbiddenText.map((item) => String(item || "").trim()).filter(Boolean) : [];
          const normalizedVerificationText = verificationText.toLowerCase();
          const requiredMatches = required.map((needle) => {
            const normalizedNeedle = needle.toLowerCase();
            if (normalizedVerificationText.includes(normalizedNeedle)) return true;
            const tokens = normalizedNeedle
              .split(/[^a-z0-9]+/i)
              .map((token) => token.trim())
              .filter((token) => token.length > 2 && !["cta", "app", "web", "site", "page"].includes(token));
            if (tokens.length === 0) return true;
            if (
              tokens.includes("responsive") &&
              (tokens.includes("layout") || tokens.includes("design")) &&
              /<meta\b[^>]+name=["']viewport["']/i.test(html) &&
              /@media\b/i.test(linkedAssetText || html)
            ) {
              return true;
            }
            return tokens.every((token) =>
              normalizedVerificationText.includes(token) ||
              (token === "reservation" && normalizedVerificationText.includes("reserve")) ||
              (token === "reserve" && normalizedVerificationText.includes("reservation")),
            );
          });
          const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
          const withoutStyles = withoutScripts.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
          const textPreview = withoutStyles
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300);
          const checks = [
            { id: "exists", label: "File exists and was readable", ok: true },
            { id: "min-bytes", label: `File has enough substance (${minBytes}+ bytes)`, ok: bytes >= Number(minBytes || 0) },
            { id: "html-root", label: "Contains <!doctype> or <html>", ok: /<!doctype html|<html[\s>]/i.test(html) },
            { id: "body", label: "Contains <body>", ok: /<body[\s>]/i.test(html) },
            { id: "visible-text", label: "Has visible text content", ok: textPreview.length >= 10 },
            { id: "style-depth", label: "Has meaningful embedded styling", ok: /<style\b[^>]*>[\s\S]{180,}<\/style>/i.test(html) || /<link\b[^>]+rel=["']stylesheet["']/i.test(html) },
            { id: "interactive-control", label: "Has buttons, inputs, selects, textareas, or links", ok: /<(button|input|select|textarea|a)\b/i.test(html) },
            { id: "script", label: "Has client-side script", ok: /<script\b/i.test(html) },
            { id: "script-interaction", label: "Script wires real UI behavior", ok: /(addEventListener|onclick|onsubmit|onchange|querySelector|localStorage)/i.test(verificationText) },
            { id: "responsive-meta", label: "Has viewport meta tag", ok: /<meta\b[^>]+name=["']viewport["']/i.test(html) },
            { id: "required-text", label: "Includes requested app-specific text", ok: requiredMatches.every(Boolean), details: required },
            { id: "forbidden-text", label: "Does not include known fallback template text", ok: forbidden.every((needle) => !html.includes(needle)), details: forbidden },
          ];
          const passed = checks.filter((check) => check.ok).length;
          const score = Math.round((passed / checks.length) * 100);
          return {
            path: file.path,
            bytes,
            ok: score >= 85
              && checks.find((check) => check.id === "visible-text")?.ok
              && checks.find((check) => check.id === "required-text")?.ok
              && checks.find((check) => check.id === "forbidden-text")?.ok,
            score,
            passed,
            total: checks.length,
            checks,
            issues: checks.filter((check) => !check.ok).map((check) => check.id),
            textPreview,
          };
        },
      },
      plan_shell_command: {
        description: "Prepare a shell-command request that requires later approval.",
        permission: "allowShellPlanning",
        schema: {
          type: "object",
          required: ["request"],
          properties: {
            request: { type: "string", description: "Natural-language or shell command request." },
          },
        },
        run: async ({ request }) => {
          const command = this.inferCommand(request);
          return this.shellPlanner.buildRequest(
            command,
            "Requested through OmniClaw as a planned shell action.",
          );
        },
      },
      exec_approval_status: {
        description: "Inspect OmniClaw terminal/exec approval policy: trust level, allowlist mode, safe defaults, and what the agent can run without asking.",
        permission: null,
        run: async () => {
          const config = this.configStore.getConfig();
          const shellPolicy = config.tools?.shellExecution || {};
          const permissions = config.tools?.permissions || {};
          return {
            enabled: Boolean(permissions.allowShellExecution),
            host: shellPolicy.host || "gateway",
            trustLevel: shellPolicy.trustLevel || "protected",
            allowlistMode: shellPolicy.allowlistMode || "advisory",
            cwd: shellPolicy.cwd || ".",
            allowExternalCwd: Boolean(shellPolicy.allowExternalCwd),
            timeoutMs: shellPolicy.timeoutMs || 120000,
            maxOutputBytes: shellPolicy.maxOutputBytes || 256000,
            safeBins: shellPolicy.safeBins || ["cut", "uniq", "head", "tail", "tr", "wc"],
            strictInlineEval: Boolean(shellPolicy.strictInlineEval),
            allowlistPatterns: shellPolicy.allowlistPatterns || [],
            blockedPatterns: shellPolicy.blockedPatterns || [],
            decisions: ["allow once", "allow always", "deny"],
            rule: "Terminal commands execute locally through ShellExecutor. Failed stdout/stderr is returned to the LLM for self-correction; destructive commands stay blocked by policy.",
          };
        },
      },
      web_research: {
        description: "Slow multi-source web research with synthesis. NOT for quick lookups (use web_search).",
        permission: "allowWebResearch",
        group: "web",
        schema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            maxResults: { type: "number" },
            count: { type: "number" },
            fetchTop: { type: "number" },
            provider: { type: "string" },
          },
        },
        run: async ({ query, count, maxResults, fetchTop, provider }) =>
          this.webResearch.search(String(query || "").trim(), {
            maxResults: Number(count || maxResults || 8),
            fetchTop: fetchTop === undefined ? undefined : Number(fetchTop),
            provider,
          }),
      },
      read_url: {
        description: "Fetch and read the text content of a specific public URL.",
        permission: "allowWebResearch",
        group: "web",
        schema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            maxChars: { type: "number" },
          },
        },
        run: async ({ url, maxChars }) => this.webResearch.fetchUrl(String(url || "").trim(), Number(maxChars || 12000)),
      },
      open_browser_url: {
        description: "Open a URL in the laptop's default browser.",
        permission: "allowBrowserControl",
        run: async ({ url, path: filePath }, context) =>
          this.runBrowserOperation("open_url", () => {
            const target = String(url || filePath || "").trim();
            const resolved = /^(?:https?|file):\/\//i.test(target)
              ? target
              : pathToFileURL(this.fileStore.resolveWorkspacePath(target)).href;
            return this.browserOperator.openUrl(resolved);
          }, context),
      },
      run_terminal_command: {
        description: "Execute a terminal command through OmniClaw shell policy and audit logging.",
        permission: "allowShellExecution",
        schema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Exact terminal command to execute." },
            cwd: { type: "string", description: "Optional working directory." },
          },
        },
        run: async ({ command, cwd }, context) => {
          const cmd = String(command || "").trim();
          const gate = await this.awaitShellApproval(cmd, context, "run_terminal_command");
          if (gate?.blocked) return { blocked: true, command: cmd, approvalId: gate.approvalId, reason: gate.reason };
          return this.agentRuntime?.executeTerminalCommand
            ? this.agentRuntime.executeTerminalCommand({
                command: cmd,
                cwd: String(cwd || "").trim(),
                context,
              })
            : this.shellPlanner.buildRequest(cmd, "Terminal execution requested.");
        },
      },
      sandbox_status: {
        description: "Show the governed temp-workspace sandbox status, limits, and capabilities.",
        permission: null,
        group: "safety",
        run: async () => this.sandboxRunner?.getStatus?.() || { enabled: false },
      },
      sandbox_run: {
        description: "Run a shell command in an isolated temp workspace copy and report changed files without touching the real workspace.",
        permission: "allowShellExecution",
        group: "safety",
        run: async (input = {}) => this.sandboxRunner.run(input),
      },
      sandbox_apply: {
        description: "Apply selected changed files from a sandbox run into the real workspace.",
        permission: "allowFileWrite",
        group: "safety",
        run: async (input = {}) => this.sandboxRunner.apply(input),
      },
      list_processes: {
        description: "List currently running system processes (Windows).",
        permission: "allowShellExecution",
        run: async ({ filter }) => this.systemMonitor.listProcesses(String(filter || "").trim()),
      },
      exec: {
        description: "Run a PowerShell command in the CHAT PROJECT root (foreground; background:true only for servers, then read via process_status). CWD: omit or pass a chat-root-relative dir; absolute cwd outside the chat root is rejected. Windows: separate with ';' never '&&'. REQUIRED: command. OPTIONAL: cwd, background, timeoutMs. NOT for interactive programs or giant outputs (redirect to a file). Example: {\"command\":\"npm run build\"}. Independent exec calls in one turn run in parallel unless they write the same file.",
        permission: "allowShellExecution",
        group: "terminal",
        schema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "REQUIRED. Exact PowerShell command. Use ';' separators. Never interactive; never '&&'." },
            cwd: { type: "string", description: "OPTIONAL. Chat-root-relative working dir (e.g. 'web-next'). Omit = chat project root. Absolute paths confined to the chat root." },
            background: { type: "boolean", description: "OPTIONAL. Default false. true ONLY for long servers (npm run dev); then poll with process_status." },
            timeoutMs: { type: "number", description: "OPTIONAL. Foreground timeout ms (max 900000). Omit for the harness default." },
          },
        },
        examples: [
          { input: { command: "git status" }, description: "Check git working tree status" },
          { input: { command: "npm run build", background: true }, description: "Run build in background, get processId" },
          { input: { command: "ping -n 4 google.com" }, description: "Ping 4 times to test connectivity" },
        ],
        run: async ({ command, cwd, background, timeout, timeoutMs }, context) => {
          const cmd = String(command || "").trim();
          // Auto-background dev servers/watchers: run in the foreground they
          // never exit — the call hangs until the timeout, burns minutes, and
          // reads as a failure. Only kicks in when the model did not choose a
          // mode explicitly.
          const LONG_RUNNING_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\bvite\b(?!\s+build)|\bnext\s+dev\b|\bnodemon\b|\bwebpack-dev-server\b|--watch\b|\bpython3?\s+-m\s+http\.server\b|\bflask\s+run\b|\buvicorn\b|\bphp\s+-S\b|\blive-server\b|\bhttp-server\b|\btail\s+-f\b/i;
          let effectiveBackground = Boolean(background);
          let autoBackgrounded = false;
          if (background === undefined && LONG_RUNNING_RE.test(cmd)) {
            effectiveBackground = true;
            autoBackgrounded = true;
          }
          // Dedupe servers: the same dev-server started twice fights over the
          // port and confuses the loop (this really happened — two `npm run
          // dev` processes in one session). If an equivalent background
          // command is still running, hand back THAT process instead.
          if (effectiveBackground || LONG_RUNNING_RE.test(cmd)) {
            const normalize = (c) => String(c || "").toLowerCase().replace(/\s+/g, " ").replace(/&&|;/g, ";").trim();
            const existing = (this.shellExecutor.listProcesses({ status: "running" }) || [])
              .find((p) => normalize(p.command) === normalize(cmd));
            if (existing) {
              return {
                status: "already_running",
                processId: existing.id,
                pid: existing.pid,
                command: existing.command,
                cwd: existing.cwd,
                startedAt: existing.startedAt,
                message: `This exact command is ALREADY RUNNING as background process ${existing.id} (started ${existing.startedAt}). Do NOT start another copy — use process_status {"processId":"${existing.id}"} to read its output, or process_kill first if you really need a restart.`,
              };
            }
          }
          const gate = await this.awaitShellApproval(cmd, context, "exec");
          if (gate?.blocked) return { blocked: true, command: cmd, approvalId: gate.approvalId, reason: gate.reason };
          // Per-chat bind: default cwd is the chat's own project folder, and
          // an explicit cwd outside it fails closed (Full Access means
          // unconstrained INSIDE the selected project, not the server repo).
          const chatGate = this.chatCwd(cwd, context);
          if (!chatGate.ok) return { blocked: true, command: cmd, reason: chatGate.error };
          const result = await this.shellExecutor.execute({
            command: cmd,
            cwd: chatGate.cwd,
            background: effectiveBackground,
            timeoutMs: Number(timeoutMs || timeout || 0),
            runId: context.runId || "",
            sessionId: context.sessionId || "",
          });
          if (autoBackgrounded && result && result.status === "started") {
            result.autoBackgrounded = true;
            result.message = `Long-running server/watcher detected — auto-started in the BACKGROUND (foreground would hang until timeout). processId=${result.processId}. Next: wait a moment, then process_status {"processId":"${result.processId}"} to read startup output/port, browser_open the local URL to actually test it, and process_kill when done. Do NOT re-run this command.`;
          }
          return result;
        },
      },
      computer_system_status: {
        description: "Check laptop RAM, CPU, OS, and disk storage status.",
        permission: null,
        run: async () => this.systemMonitor.getComputerStatus(),
      },
      run_task: {
        description: "Run the latest open task or a task by id.",
        permission: "allowTaskRunner",
        run: async ({ taskId }, context) =>
          this.taskRunner.runTask(String(taskId || "").trim(), {
            agentId: this.getAgentId(context),
          }),
      },
      create_skill: {
        description: "Create a new local skill file for OmniClaw.",
        permission: "allowSkillWrite",
        run: async (input, context) => {
          const result = this.customizationEngine.createSkill({
            ...input,
            agentId: input.agentId || this.getAgentId(context),
          });
          // Provenance mark: only agent-created skills are eligible for the
          // weekly skill curator's stale/archive/consolidation lifecycle.
          if (result?.name) this.agentRuntime?.omniLoop?.recordSkillCreated?.(result.name);
          return result;
        },
      },
      ask_user: {
        description: "Ask the user a blocking decision mid-run (interactive card; 2-4 options, one recommended). A 5-minute timeout falls back to recommended. NOT for anything you can decide yourself.",
        permission: null,
        group: "interaction",
        schema: {
          type: "object",
          required: ["question", "options"],
          properties: {
            question: { type: "string", description: "The complete question, ending with '?'" },
            options: {
              type: "array",
              description: "2-4 choices: [{label, description, recommended}] — exactly one recommended:true.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                  recommended: { type: "boolean" },
                },
              },
            },
            allowOther: { type: "boolean", description: "Let the user type a custom answer (default true)." },
          },
        },
        examples: [
          { input: { question: "Landing page ka color theme kya rakhein?", options: [{ label: "Dark neon", description: "Black + cyan glow, modern", recommended: true }, { label: "Light minimal", description: "White, clean, corporate" }] }, description: "Mid-run design decision with a recommended option" },
        ],
        run: async (input = {}, context = {}) => {
          const runtime = this.agentRuntime;
          if (!runtime?.pendingQuestions) throw new Error("Question runtime unavailable in this environment.");
          const question = String(input.question || "").trim().slice(0, 600);
          if (!question) throw new Error("question is required");
          const options = (Array.isArray(input.options) ? input.options : [])
            .slice(0, 4)
            .map((option) => ({
              label: String(option?.label || "").trim().slice(0, 80),
              description: String(option?.description || "").trim().slice(0, 200),
              recommended: Boolean(option?.recommended),
            }))
            .filter((option) => option.label);
          if (options.length < 2) throw new Error("Give 2-4 options with labels (mark one recommended:true).");
          const questionId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const entry = { answered: false, answer: "" };
          runtime.pendingQuestions.set(questionId, entry);
          // Q1 (4B.2): mirror into the gateway open-questions list so
          // GET /api/questions hydrates UI cards after reload.
          try {
            runtime.gateway?.upsertOpenQuestion?.({
              id: questionId,
              // M3: same attribution rule as approvals - the asking agent is
              // stamped now, because a run can be reaped before the question is
              // answered and the run/session link is all we would have left.
              agentId: this.getAgentId(context) || String(context.runAgentId || "") || null,
              sessionId: context.sessionId || "",
              runId: context.runId || "",
              text: question,
              options,
            });
          } catch {}
          runtime.gateway?.addEvent?.("run.question", {
            questionId,
            question,
            // M3: attribute the question to the asking agent so the live card
            // chip works without a refetch.
            agentId: this.getAgentId(context) || String(context.runAgentId || "") || null,
            options,
            allowOther: input.allowOther !== false,
            tool: "ask_user",
            runId: context.runId || "",
            sessionId: context.sessionId || "",
          });
          const deadline = Date.now() + APPROVAL_TOOL_TIMEOUT_MS;
          while (Date.now() < deadline && !entry.answered) {
            if (context.runId && runtime.cancelledRuns?.has(context.runId)) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          runtime.pendingQuestions.delete(questionId);
          try { runtime.gateway?.removeOpenQuestion?.(questionId); } catch {}
          if (!entry.answered) {
            const recommended = options.find((option) => option.recommended) || options[0];
            runtime.gateway?.addEvent?.("run.question_timeout", { questionId });
            return {
              answered: false,
              timedOut: true,
              answer: recommended.label,
              message: `User did not answer within 5 minutes. Proceed with the recommended option ("${recommended.label}") and state that assumption clearly in your final reply.`,
            };
          }
          return { answered: true, answer: entry.answer };
        },
      },
      build_tool: {
        description: "Forge a new tool when none fits: provide JS `async function run(input, api)` plus self-tests. Guard-scanned, sandbox-tested, then registered under your chosen name. api: fetch, readFile, writeFile, listFiles, log.",
        permission: "allowSkillWrite",
        group: "forge",
        schema: {
          type: "object",
          required: ["name", "description", "code"],
          properties: {
            name: { type: "string", description: "snake_case tool name, e.g. currency_converter" },
            description: { type: "string", description: "One-line description — future runs pick the tool by this." },
            code: { type: "string", description: "JS source defining `async function run(input, api) { ... return result; }`" },
            schema: { type: "object", description: "JSON Schema for the tool's input (optional)." },
            tests: { type: "array", description: "Self-test cases: [{input: {...}, expect: \"substring or JSON fragment\"}]. Tool registers only if ALL pass." },
          },
        },
        examples: [
          { input: { name: "word_count", description: "Count words in text", code: "async function run(input, api) { return { words: String(input.text||'').trim().split(/\\s+/).filter(Boolean).length }; }", tests: [{ input: { text: "do shabd" }, expect: "2" }] }, description: "Build and self-test a word counter tool" },
        ],
        run: async (input = {}, context = {}) => {
          const built = await this.toolForge.buildTool(input);
          this.customTools.set(built.name, { ...built.manifest, code: String(input.code) });
          // Auto-author a SKILL.md so the MAIN agent discovers the tool by
          // topic later (skill matching) — not just when this run remembers it.
          let skillWritten = "";
          try {
            skillWritten = this.writeToolSkill(built, context);
          } catch { /* skill is a bonus — never fail the build over it */ }
          const verified = built.testResults.filter((result) => result.ok).length;
          const unverified = built.testResults.some((result) => result.unverified);
          this.agentRuntime?.gateway?.addEvent?.("forge.tool_built", {
            tool: built.name,
            tests: built.testResults.length,
            skill: skillWritten,
            message: `agent built its own tool: ${built.name}${skillWritten ? ` (+ skill ${skillWritten})` : ""}`,
          });
          return {
            ok: true,
            built: built.name,
            registered: true,
            testResults: built.testResults,
            skill: skillWritten || undefined,
            message: unverified
              ? `Tool "${built.name}" is registered and callable, but its empty-input smoke run threw — it likely NEEDS input. Call test_tool with a real input to confirm it works, or rebuild with a "tests" array. A skill was written so the main agent finds it later.`
              : `Tool "${built.name}" passed ${verified} self-test(s), is registered, and a skill was written — the main agent can call it by name anytime, in any session.`,
          };
        },
      },
      test_tool: {
        description: "Run one of YOUR self-built tools with a given input to verify its behavior (returns output + captured logs).",
        permission: null,
        group: "forge",
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            input: { type: "object", description: "Input to pass to the tool's run(input, api)." },
          },
        },
        run: async ({ name, input } = {}) => {
          const tool = this.customTools.get(String(name || "").trim().toLowerCase());
          if (!tool) throw new Error(`Custom tool not found: ${name}. list_custom_tools shows what exists.`);
          const { result, logs } = await this.toolForge.execute(tool.code, input || {});
          return { ok: true, tool: tool.name, result, logs: logs.slice(-10) };
        },
      },
      list_custom_tools: {
        description: "List the tools this agent has built for itself (name, description, when).",
        permission: null,
        group: "forge",
        run: async () => ({
          count: this.customTools.size,
          tools: [...this.customTools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            updatedAt: tool.updatedAt || tool.createdAt || "",
            tests: (tool.tests || []).length,
          })),
        }),
      },
      remove_custom_tool: {
        description: "Delete a self-built tool (its workspace/tools/<name> directory is removed).",
        permission: "allowSkillWrite",
        group: "forge",
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        run: async ({ name } = {}) => {
          const result = this.toolForge.remove(name);
          this.customTools.delete(result.removed);
          return result;
        },
      },
      openclaw_vendor_status: {
        description: "Inspect the vendored OpenClaw reference checkout and license metadata.",
        permission: null,
        group: "openclaw",
        examples: [
          { input: {}, description: "Show OpenClaw vendor status, version, and license info" },
        ],
        run: async () => this.getOpenClawVendorStatus(),
      },
      openclaw_code_study: {
        description: "Study the vendored OpenClaw source tree and produce an OmniClaw implementation map.",
        permission: null,
        group: "openclaw",
        examples: [
          { input: {}, description: "Deep-dive OpenClaw and map features to OmniClaw equivalents" },
          { input: { focus: "skill-system" }, description: "Focus analysis on OpenClaw's skill system implementation" },
        ],
        run: async (input = {}) => this.getOpenClawCodeStudy(input),
      },
      hermes_reference_status: {
        description: "Summarize Hermes Agent reference ideas and map them to OmniClaw's current runtime.",
        permission: null,
        group: "hermes",
        examples: [
          { input: {}, description: "Get Hermes Agent reference status and feature mapping" },
        ],
        run: async () => {
          const provider = this.agentRuntime?.getProviderInfo?.() || {};
          const report = this.agentRuntime?.getV2Report?.() || {};
          const agentCount = this.agentRegistry?.getAll?.()?.length || 0;
          const tools = this.getAll({ agentId: "main" });
          const toolIds = tools.map((tool) => tool.id);
          const vendor = this.getHermesVendorStatus();
          return {
            source: {
              name: "Hermes Agent",
              repo: "https://github.com/nousresearch/hermes-agent",
              license: "MIT",
              status: vendor.available ? "vendored in vendor/hermes-agent" : "external reference, not vendored into OmniClaw",
            },
            vendor,
            usefulPatterns: [
              "Slash command surface for /model, /skills, /usage, /doctor, and platform status.",
              "Self-improving skill library that grows from agent work.",
              "Full-text session/history search so old chats are first-class context.",
              "Gateway/channel layer for chat, cron, and background jobs.",
              "Subagents and terminal backends for real execution instead of prompt-only claims.",
            ],
            omniClawNow: {
              providerReady: Boolean(provider.ready),
              provider: provider.id || "unknown",
              model: provider.model || "",
              v2Score: report.score || 0,
              agentCount,
              toolCount: tools.length,
              commandSurface: ["/doctor", "/model", "/skills", "/usage", "/platforms", "/hermes"],
              matchingTools: toolIds.filter((id) => [
                "provider_status",
                "list_provider_models",
                "capability_demo",
                "sessions_list",
                "sessions_history",
                "memory_search",
                "gateway",
                "cron",
                "nodes",
                "subagents",
                "run_terminal_command",
                "browser_snapshot",
                "computer_access_status",
              ].includes(id)),
            },
            gaps: [
              "Self-improving skills are still manual/local skill writes, not automatic promotion from successful runs.",
              "Session history exists, but fast full-text search/indexing needs a stronger search layer.",
              "Gateways exist locally, but WhatsApp/Slack/Signal/iMessage adapters still need real account pairing.",
              "Terminal/browser tools are governed, but hard sandbox isolation is still partial.",
            ],
            nextBuildActions: [
              vendor.available
                ? "Scan vendored Hermes skills and import selected compatible skills into OmniClaw."
                : "Vendor Hermes Agent with license preserved before importing selected patterns.",
              "Make /doctor the first debugging path for provider, gateway, memory, tools, and permissions.",
              "Grow skill promotion from successful workflows into editable SKILL.md files.",
              "Index sessions and memories for laptop-wide recall/search.",
            ],
          };
        },
      },
      hermes_vendor_status: {
        description: "Inspect the vendored Hermes Agent reference copy and license metadata.",
        permission: null,
        group: "hermes",
        run: async () => this.getHermesVendorStatus(),
      },
      hermes_skill_scan: {
        description: "Scan vendored Hermes Agent SKILL.md files for possible OmniClaw imports.",
        permission: null,
        group: "hermes",
        run: async (input = {}) => this.scanHermesSkills(input),
      },
      hermes_tool_catalog: {
        description: "List Hermes Agent core tools and their OmniClaw compatibility/adaptation status.",
        permission: null,
        group: "hermes",
        run: async ({ status, toolset } = {}) => this.getHermesToolCatalog({ status, toolset }),
      },
      context_compression_status: {
        description: "Hermes-style context compression status: head/middle/tail, summary framing, token budget awareness.",
        permission: null,
        group: "runtime",
        examples: [
          { input: {}, description: "Get current context compression status and token budget" },
        ],
        run: async (_, context) => this.getContextCompressionStatus(context),
      },
      memory_lifecycle_status: {
        description: "Hermes-style memory lifecycle status: prefetch, fenced memory block, sync, dream sweep, and session search.",
        permission: null,
        group: "memory",
        examples: [
          { input: {}, description: "Get memory lifecycle status and health metrics" },
          { input: { query: "project decisions" }, description: "Query memory for specific context" },
        ],
        run: async ({ query } = {}, context) => this.getMemoryLifecycleStatus({ query, context }),
      },
      skill_system_status: {
        description: "Hermes-style skills system status: progressive disclosure, agentskills compatibility, and self-improvement gaps.",
        permission: null,
        group: "skills",
        examples: [
          { input: {}, description: "Get skill system status and available skills" },
        ],
        run: async (_, context) => this.getSkillSystemStatus(context),
      },
      messaging_gateway_status: {
        description: "Hermes-style messaging gateway status: adapters, session routing, voice/media ingestion, and DM security.",
        permission: null,
        group: "messaging",
        examples: [
          { input: {}, description: "Get messaging gateway status and active sessions" },
        ],
        run: async (_, context) => this.getMessagingGatewayStatus(context),
      },
      configure_telegram: {
        description: "Connect Telegram: verify a bot token live against the Telegram API, save it, clear any webhook that would block polling, and start the polling worker. Use this whenever the user wants to connect/link Telegram.",
        permission: "allowConnectorWrite",
        group: "gateway",
        examples: [
          { input: { botToken: "123456:ABC-DEF..." }, description: "Connect Telegram with a token from @BotFather" },
          { input: {}, description: "Show the setup steps when no token is known yet" },
        ],
        run: async (input = {}) => this.configureTelegramAdapter(input),
      },
      telegram_status: {
        description: "Live Telegram health check: is the saved bot token valid, which bot is it, is the polling worker running, and is a webhook blocking incoming messages. Use this to answer 'is Telegram connected?'.",
        permission: null,
        group: "gateway",
        examples: [
          { input: {}, description: "Check whether Telegram is really connected and receiving" },
        ],
        run: async () => this.getTelegramStatus(),
      },
      telegram_send: {
        description: "Send a Telegram message directly to a chat id or @channelusername using the configured bot. Use this to message someone on Telegram.",
        permission: "allowConnectorWrite",
        group: "gateway",
        examples: [
          { input: { chatId: "123456789", text: "Build finished." }, description: "Send a message to a chat" },
        ],
        run: async (input = {}) => this.sendTelegramMessageTool(input),
      },
      terminal_backends_status: {
        description: "Hermes-style terminal backend status: local/docker/ssh/cloud backends, process registry, and approval gates.",
        permission: null,
        group: "runtime",
        examples: [
          { input: {}, description: "Get terminal backend status and active processes" },
        ],
        run: async (_, context) => this.getTerminalBackendsStatus(context),
      },
      model_provider_status: {
        description: "Hermes-style multi-provider model support status: API mode, credential pool, failover, and model discovery.",
        permission: null,
        group: "provider",
        examples: [
          { input: {}, description: "Get provider status, credentials, and failover config" },
        ],
        run: async (_, context) => this.getModelProviderStatus(context),
      },
      subagent_delegation_status: {
        description: "Hermes-style subagent delegation status: isolation, blocked child tools, concurrency, and shared budget.",
        permission: null,
        group: "delegation",
        examples: [
          { input: {}, description: "Get subagent delegation status and active delegations" },
        ],
        run: async (_, context) => this.getSubagentDelegationStatus(context),
      },
      mcp_integration_status: {
        description: "Hermes-style MCP integration status: configured servers, live tool registry, aliases, and ACP gap.",
        permission: null,
        group: "mcp",
        examples: [
          { input: {}, description: "Get MCP integration status and available tools" },
        ],
        run: async (_, context) => this.getMcpIntegrationStatus(context),
      },
      mcp_connect_all: {
        description: "Connect all configured MCP servers and refresh their live tool registry.",
        permission: "allowConfigWrite",
        group: "mcp",
        examples: [
          { input: {}, description: "Connect all MCP servers and sync tool registry" },
        ],
        run: async () => this.connectAllMcpServers(),
      },
      cron_scheduler_status: {
        description: "Hermes-style built-in cron scheduler status: schedules, background jobs, triggers, and delivery path.",
        permission: null,
        group: "cron",
        examples: [
          { input: {}, description: "Get scheduler overview: active schedules, next run time" },
          { input: { scheduleId: "schedule_xxx" }, description: "Get specific schedule status" },
        ],
        run: async (_, context) => this.getCronSchedulerStatus(context),
      },
      trajectory_training_status: {
        description: "Hermes-style trajectory generation and RL training status for agent runs/tool traces.",
        permission: null,
        group: "research",
        examples: [
          { input: {}, description: "Get trajectory training status and active models" },
        ],
        run: async (_, context) => this.getTrajectoryTrainingStatus(context),
      },
      closed_learning_loop_status: {
        description: "Hermes-style closed learning loop status: session logging, memory nudges, skill promotion, and next interaction improvement.",
        permission: null,
        group: "learning",
        examples: [
          { input: {}, description: "Get learning loop status and recent improvements" },
        ],
        run: async (_, context) => this.getClosedLearningLoopStatus(context),
      },
      hermes_use_cases_status: {
        description: "Map Hermes use-case categories to OmniClaw's current real capabilities and gaps.",
        permission: null,
        group: "runtime",
        examples: [
          { input: {}, description: "Get Hermes use cases and OmniClaw capability mapping" },
        ],
        run: async (_, context) => this.getHermesUseCasesStatus(context),
      },
      design_principles_status: {
        description: "Report Hermes-style design principles and OmniClaw compliance/gaps.",
        permission: null,
        group: "runtime",
        examples: [
          { input: {}, description: "Get design principles and compliance report" },
        ],
        run: async (_, context) => this.getDesignPrinciplesStatus(context),
      },
      openclaw_skill_scan: {
        description: "Scan vendored OpenClaw SKILL.md files for possible OmniClaw imports.",
        permission: null,
        group: "openclaw",
        examples: [
          { input: {}, description: "Scan all OpenClaw skills and show import candidates" },
          { input: { category: "browser" }, description: "Scan only browser-related skills" },
        ],
        run: async (input = {}) => this.scanOpenClawSkills(input),
      },
      openclaw_skill_import: {
        description: "Import one vendored OpenClaw SKILL.md into OmniClaw's local .skill format.",
        permission: "allowSkillWrite",
        group: "openclaw",
        run: async (input = {}, context) => this.importOpenClawSkill(input, context),
      },
      openclaw_skill_pack_import: {
        description: "Import a curated OpenClaw compatibility skill pack into OmniClaw agents.",
        permission: "allowSkillWrite",
        group: "openclaw",
        run: async (input = {}, context) => this.importOpenClawSkillPack(input, context),
      },
      update_runtime_settings: {
        description: "Update OmniClaw runtime profile or provider mode.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.updateRuntimeSettings(input),
      },
      apply_provider_profile: {
        description: "Apply a saved provider profile.",
        permission: "allowConfigWrite",
        run: async ({ profileId }) => this.customizationEngine.applyProviderProfile(String(profileId || "").trim()),
      },
      select_provider_connection: {
        description: "Atomically switch provider connection (optional profileId) AND set the exact model, then verify the committed pair. Prefer this over apply_provider_profile followed by a separate model write — one operation, no half-applied state. Scope is global (all chats).",
        permission: "allowConfigWrite",
        group: "provider",
        schema: {
          type: "object",
          required: ["model"],
          properties: {
            profileId: { type: "string", description: "Saved provider profile id to switch to first. Omit to keep the current connection." },
            model: { type: "string", description: "Exact model ID to use on that connection." },
            contextTokens: { type: "number", description: "Optional model context window (tokens) from the provider /models catalog. Persisted alongside the model so the context budget follows the real model size." },
          },
        },
        run: async (input) => this.customizationEngine.selectProviderConnection(input),
      },
      save_provider_profile: {
        description: "Save a custom OpenAI-compatible provider (base URL + key) as a named profile. Verify with list_provider_models first. apply:true activates it immediately.",
        permission: "allowConfigWrite",
        group: "provider",
        schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Display name for the provider (also used as its id). e.g. 'My Cerebras'." },
            baseUrl: { type: "string", description: "OpenAI-compatible base URL, e.g. https://api.example.com/v1" },
            model: { type: "string", description: "Default model id the endpoint accepts." },
            apiKey: { type: "string", description: "API key to store locally for this provider (optional if already stored)." },
            authStyle: { type: "string", description: "'anthropic' for x-api-key + anthropic-version headers; omit for standard Bearer auth." },
            apply: { type: "boolean", description: "Make this the active provider right away." },
          },
          required: ["name", "baseUrl", "model"],
        },
        run: async (input) => this.customizationEngine.saveProviderProfile(input),
      },
      delete_provider_profile: {
        description: "Delete a user-added custom provider profile (built-in defaults can't be removed).",
        permission: "allowConfigWrite",
        group: "provider",
        schema: {
          type: "object",
          properties: {
            profileId: { type: "string", description: "The profile id/name to delete." },
            removeKey: { type: "boolean", description: "Also delete the stored API key for this provider." },
          },
          required: ["profileId"],
        },
        run: async (input) => this.customizationEngine.deleteProviderProfile(input),
      },
      set_provider_key: {
        description: "Store a BYOK provider key locally.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.setProviderKey(input),
      },
      configure_provider_brain: {
        description: "Atomically configure provider profile, base URL, model, API key, and readiness test.",
        permission: "allowConfigWrite",
        group: "provider",
        run: async (input) => this.customizationEngine.configureProviderBrain(input),
      },
      get_provider_key_status: {
        description: "Read provider BYOK key status (masked only).",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.getProviderKeyStatus(input),
      },
      test_provider_profile: {
        description: "Validate provider profile and key readiness.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.testProviderProfile(input),
      },
      list_provider_models: {
        description: "Fetch available models from the selected provider's /models endpoint.",
        permission: "allowConfigWrite",
        run: async (input) => this.customizationEngine.listProviderModels(input),
      },
      test_provider_model: {
        description: "Test ONE model id on a provider endpoint with a minimal real call: reachability (/models list), id validity, tool-calling support, and parallel-tool-call support. Persists the result to the model registry (retired ids are recorded and excluded from pickers and the sub-agent ladder). Use before assigning a model to sub-agents. Bounded (~15s probe timeout).",
        permission: "allowConfigWrite",
        group: "provider",
        schema: {
          type: "object",
          required: ["model"],
          properties: {
            model: { type: "string", description: "REQUIRED. Exact model id to test." },
            profileId: { type: "string", description: "Saved provider profile id. Provide this OR baseUrl." },
            baseUrl: { type: "string", description: "Ad-hoc OpenAI-compatible base URL. Provide this OR profileId." },
          },
        },
        run: async (input) => this.testProviderModel(input),
      },
      terminal: {
        description: "Hermes-compatible governed terminal command execution.",
        permission: "allowShellExecution",
        group: "hermes-terminal",
        run: async ({ command, cwd, background } = {}, context) => this.tools.exec.run({ command, cwd, background }, context),
      },
      process_list: {
        description: "List background processes started by OmniClaw.",
        permission: null,
        group: "terminal",
        run: async ({ status } = {}) => {
          if (!this.shellExecutor?.listProcesses) {
            return { processes: [], message: "Background process registry is not available." };
          }
          return this.shellExecutor.listProcesses({ status });
        },
      },
      process_status: {
        description: "Read a background process's captured output (id optional, defaults to latest). NOT for starting new commands.",
        permission: null,
        group: "terminal",
        schema: {
          type: "object",
          properties: {
            processId: { type: "string", description: "Background process id returned by exec with background=true. Optional — omit to get the most recent process." },
          },
        },
        run: async ({ processId } = {}) => this.requireShellExecutor().getProcessStatus(String(processId || "").trim()),
      },
      process_kill: {
        description: "Kill a running background process by ID.",
        permission: "allowShellExecution",
        group: "terminal",
        schema: {
          type: "object",
          required: ["processId"],
          properties: {
            processId: { type: "string", description: "Background process id to kill." },
            signal: { type: "string", description: "Signal name (default SIGTERM)." },
          },
        },
        run: async ({ processId, signal } = {}) =>
          this.requireShellExecutor().killProcess(String(processId || "").trim(), String(signal || "SIGTERM").trim()),
      },
      process_cleanup: {
        description: "Remove old completed/killed process entries from the registry.",
        permission: null,
        group: "terminal",
        run: async ({ maxAgeMs } = {}) => this.requireShellExecutor().cleanupProcesses({ maxAge: Number(maxAgeMs || 3600000) }),
      },
      process: {
        description: "OpenClaw-compatible process inspection tool.",
        permission: "allowShellExecution",
        group: "runtime",
        run: async ({ filter }) => this.systemMonitor.listProcesses(String(filter || "").trim()),
      },
      code_act: {
        description: "Run ONE JS script making MANY tool calls (loops/variables) instead of chaining rounds — await tools.read_file/edit/exec/search_text with normal inputs. End with `return summary`. Limits: 40 calls, 60s.",
        permission: "allowFileWrite",
        group: "runtime",
        schema: {
          type: "object",
          required: ["script"],
          properties: {
            script: { type: "string", description: "JavaScript body. Call tools with await tools.<name>(input). Finish with a return statement." },
            timeoutMs: { type: "number", description: "Wall-clock cap in ms (default 60000, max 120000)." },
          },
        },
        run: async ({ script, timeoutMs } = {}, context = {}) => this.runCodeAct(script, timeoutMs, context),
      },
      harness_evolution_status: {
        description: "Self-evolving harness status: the evidence collected from past runs (guard-nudge rates, success rate), the currently-running tunable experiment with its prediction, evolved tunable values, and the kept/reverted history. Use when asked how the harness is learning/evolving or why its behavior changed.",
        permission: null,
        group: "runtime",
        run: async () => new HarnessEvolution({ rootDir: this.getRootDir() }).status(),
      },
      restore_checkpoint: {
        description: "Rewind a file to how it was BEFORE this run edited it (checkpoint rollback). The harness snapshots every existing file before each write/edit. Call with no args to LIST this run's checkpoints. Call with {path} to restore that file's PRE-RUN content (oldest snapshot). Add {latest: true} to restore the most recent snapshot instead (undo only the last edit). Use this when your edits made a file WORSE and you want the known-good version back.",
        permission: "allowFileWrite",
        group: "file",
        schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to restore. Omit to list available checkpoints." },
            latest: { type: "boolean", description: "true = restore the newest snapshot (undo last edit) instead of the pre-run original." },
            runId: { type: "string", description: "Restore from a different run's checkpoints (default: current run)." },
          },
        },
        run: async (input = {}, context = {}) => {
          const rootDir = this.getRootDir();
          const runId = String(input.runId || context.runId || "").replace(/[^\w.-]/g, "_");
          if (!runId) return { error: true, message: "No runId available — checkpoints are stored per run." };
          const dir = path.join(rootDir, "data", "checkpoints", runId);
          let index = [];
          try { index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")); } catch { /* none */ }
          if (!Array.isArray(index) || index.length === 0) {
            return { ok: true, checkpoints: [], message: "No checkpoints recorded for this run (only edits to EXISTING files are snapshotted)." };
          }
          const wanted = String(input.path || "").trim();
          if (!wanted) {
            return {
              ok: true,
              checkpoints: index.map((e) => ({ seq: e.seq, file: e.file, at: e.at, tool: e.tool })),
              message: "Call again with {path} to restore a file's pre-run content.",
            };
          }
          const normalizePath = (p) => path.resolve(String(p || "")).replace(/[\\/]+/g, path.sep).toLowerCase();
          const wantedAbs = normalizePath(path.isAbsolute(wanted) ? wanted : path.join(rootDir, wanted));
          const matches = index.filter((e) => normalizePath(e.file) === wantedAbs);
          if (matches.length === 0) {
            return { error: true, message: `No checkpoint found for "${wanted}" in this run. Call restore_checkpoint with no args to list what is available.` };
          }
          const chosen = input.latest === true ? matches[matches.length - 1] : matches[0];
          const snapshotPath = path.join(dir, chosen.snapshot);
          if (!fs.existsSync(snapshotPath)) {
            return { error: true, message: "Checkpoint snapshot file is missing on disk." };
          }
          fs.copyFileSync(snapshotPath, chosen.file);
          return {
            ok: true,
            restored: chosen.file,
            fromSnapshot: { seq: chosen.seq, at: chosen.at, tool: chosen.tool },
            message: `Restored "${chosen.file}" to its ${input.latest === true ? "most recent snapshot" : "pre-run content"}. Re-read it before further edits.`,
          };
        },
      },
      code_execution: {
        description: "Run a small Python snippet through governed terminal execution.",
        permission: "allowShellExecution",
        group: "runtime",
        run: async ({ code }, context) => {
          const snippet = String(code || "").trim();
          if (!snippet) {
            throw new Error("code is required.");
          }
          const encoded = Buffer.from(snippet, "utf8").toString("base64");
          const command = `python -c "import base64; exec(base64.b64decode('${encoded}').decode('utf-8'))"`;
          return this.tools.run_terminal_command.run({ command }, context);
        },
      },
      execute_code: {
        description: "Hermes-compatible Python code execution alias.",
        permission: "allowShellExecution",
        group: "hermes-code",
        run: async ({ code }, context) => this.tools.code_execution.run({ code }, context),
      },
      auto_review: {
        description: "Run a Codex/OpenClaw-style self-review pass: inspect git changes, run validation, and return actionable failures.",
        permission: "allowShellExecution",
        group: "code",
        run: async ({ tests = true, mode = "local", maxOutputChars = 12000 } = {}, context = {}) => {
          if (!this.agentRuntime?.executeTerminalCommand) {
            throw new Error("Terminal execution runtime is unavailable.");
          }
          const cwd = this.getRootDir();
          const commands = [
            { id: "status", command: "git status --short" },
            { id: "diffstat", command: "git diff --stat" },
          ];
          if (tests) {
            commands.push(
              { id: "build", command: "npm.cmd run build" },
              { id: "agent-loop", command: "npm.cmd run test:agent-loop" },
              { id: "tool-contract", command: "npm.cmd run test:tool-contract" },
              { id: "runtime-backend", command: "npm.cmd run test:runtime-backend" },
              { id: "tool-execution", command: "npm.cmd run test:tool-execution" },
              { id: "health", command: "npm.cmd test" },
            );
          }
          const results = [];
          for (const item of commands) {
            const execution = await this.agentRuntime.executeTerminalCommand({
              command: item.command,
              cwd,
              context,
            });
            results.push({
              id: item.id,
              command: item.command,
              status: execution.status,
              exitCode: execution.exitCode,
              timedOut: Boolean(execution.timedOut),
              durationMs: execution.durationMs || 0,
              stdout: String(execution.stdout || "").slice(0, Number(maxOutputChars || 12000)),
              stderr: String(execution.stderr || "").slice(0, Number(maxOutputChars || 12000)),
            });
          }
          const failures = results.filter((item) =>
            item.status !== "completed" || (item.exitCode != null && item.exitCode !== 0) || item.timedOut,
          );
          return {
            ok: failures.length === 0,
            mode,
            testsRun: Boolean(tests),
            commandCount: results.length,
            failureCount: failures.length,
            failures,
            results,
            nextAction:
              failures.length > 0
                ? "Read failing stdout/stderr, patch the concrete issue, then run auto_review again."
                : "Validation commands passed. Inspect diff semantics before finalizing.",
          };
        },
      },
      browser: {
        description: "Unified browser (prefer the dedicated browser_open/snapshot/click/type tools; use this only for status/sessions/legacy transcripts). REQUIRED: action one of status|open|view|snapshot|links|screenshot|click|type|press|scroll|back|forward|wait|evaluate|sessions|close. open/view/click/type NEED a prior browser_open {url}; click/type NEED a browser_snapshot @e ref first. open NEEDS url. Example: {\"action\":\"open\",\"url\":\"https://example.com\"} then {\"action\":\"snapshot\"}.",
        permission: "allowBrowserControl",
        group: "browser",
        schema: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["status", "open", "view", "snapshot", "links", "get-images", "screenshot", "click", "type", "press", "scroll", "tap", "console", "cdp", "dialog", "back", "forward", "wait", "evaluate", "automate", "sessions", "close"], description: "REQUIRED. Which browser operation. open needs url; click/type need a snapshot @e ref first." },
            url: { type: "string", description: "REQUIRED for action=open. Full https URL (e.g. 'https://example.com')." },
            ref: { type: "string", description: "REQUIRED for click/type/press. @e ref from snapshot (e.g. '@e1')." },
            selector: { type: "string", description: "OPTIONAL CSS fallback when no @e ref." },
            text: { type: "string", description: "REQUIRED for type. Text to type." },
            sessionId: { type: "string", description: "OPTIONAL. Session id. Omit = current tab." },
            format: { type: "string", enum: ["markdown", "screenshot", "both"], description: "OPTIONAL for view. Default markdown." },
          },
        },
        run: async (input = {}, context) => {
          const rawAction = input.action || input.kind || input.type || (input.url ? "open" : "status");
          const action = normalizeBrowserAction(rawAction);
          const sessionId = input.sessionId || input.browserSessionId || input.tabId;
          const url = input.url || input.target || input.href || input.path;
          const common = { ...input, sessionId };
          const runConcrete = async (tool, args = common) => {
            const result = await this.tools[tool].run(args, context);
            return browserObservation(action, tool, result, { sessionId, url });
          };

          if (action === "status") {
            const result = await this.tools.browser_status.run({}, context);
            return browserObservation(action, "browser_status", result, { sessionId, url });
          }
          if (action === "sessions") {
            const result = await this.tools.browser_sessions.run({}, context);
            return browserObservation(action, "browser_sessions", { success: true, sessions: result }, { sessionId, url });
          }
          if (action === "open") {
            return runConcrete("browser_open", { ...common, url });
          }
          if (action === "view") {
            if (url) {
              const opened = await this.tools.browser_open.run({ ...common, url }, context);
              if (opened?.error || opened?.success === false) {
                return browserObservation(action, "browser_open", opened, { sessionId, url });
              }
            }
            return runConcrete("browser_view", { ...common, format: input.format || "markdown" });
          }
          if (action === "snapshot") {
            return runConcrete("browser_snapshot", common);
          }
          if (action === "links") {
            const result = await this.runBrowserOperation("browser_links", () =>
              this.requireBrowserPlaywright().evaluate({
                sessionId,
                script: `Array.from(document.querySelectorAll('a[href]')).slice(0, 80).map((a) => ({ text: (a.innerText || a.textContent || '').trim().slice(0, 160), href: a.href }))`,
              }), context);
            return browserObservation(action, "browser_evaluate", result, { sessionId, url });
          }
          if (action === "get-images") {
            return runConcrete("browser_get_images", common);
          }
          if (action === "screenshot") {
            return runConcrete("browser_screenshot", common);
          }
          if (action === "click") {
            return runConcrete("browser_click", common);
          }
          if (action === "type") {
            return runConcrete("browser_type", common);
          }
          if (action === "press") {
            const result = await this.runBrowserOperation("browser_press", () =>
              this.requireBrowserPlaywright().press({
                sessionId,
                ref: input.ref,
                selector: input.ref ? input.selector : (input.selector || "body"),
                key: input.key || input.text || "Enter",
              }), context);
            return browserObservation(action, "browser_press", result, { sessionId, url });
          }
          if (action === "scroll") {
            return runConcrete("browser_scroll", common);
          }
          if (action === "tap") {
            return runConcrete("browser_tap", common);
          }
          if (action === "console") {
            return runConcrete("browser_console", common);
          }
          if (action === "cdp") {
            return runConcrete("browser_cdp", common);
          }
          if (action === "dialog") {
            return runConcrete("browser_dialog", { ...common, action: input.dialogAction || input.dialog || "list" });
          }
          if (action === "back") {
            return runConcrete("browser_back", common);
          }
          if (action === "forward") {
            return runConcrete("browser_forward", common);
          }
          if (action === "wait") {
            return runConcrete("browser_wait", common);
          }
          if (action === "evaluate") {
            return runConcrete("browser_evaluate", common);
          }
          if (action === "automate") {
            return runConcrete("browser_automate", { ...common, url, actions: input.actions || [] });
          }
          if (action === "close") {
            return runConcrete("browser_close", common);
          }
          return {
            ok: false,
            action,
            supportedActions: ["status", "open", "view", "snapshot", "links", "get-images", "screenshot", "click", "type", "press", "scroll", "tap", "console", "cdp", "dialog", "back", "forward", "wait", "evaluate", "automate", "sessions", "close"],
            message: "Unsupported browser action. Choose one supported action and retry.",
          };
        },
      },
      browser_status: {
        description:
          "Check browser automation availability, current sessions, and whether browser_* is currently driving the " +
          "user's OWN browser (their logins) or a launched Playwright one.",
        permission: null,
        group: "ui",
        run: async () => ({
          operator: this.browserOperator.getStatus?.() || {},
          playwrightSessions: this.browser?.listSessions?.() || [],
          playwrightReady: Boolean(this.browser),
          // Where browser_* actually runs: the user's own Chrome when its debug
          // port is open, otherwise a launched Playwright browser.
          realBrowser: (await this.browser?.realBrowserStatus?.()) || null,
        }),
      },
      browser_open: {
        description:
          "Open a URL in a real browser tab FIRST before any view/snapshot/click/type. REQUIRED: url (full https, e.g. 'https://example.com'; bare hosts gain https://). NOT for file:// paths. Returns a sessionId — pass it to later calls or omit for the current tab. Example: {\"url\":\"https://example.com\"}.",
        permission: "allowBrowserControl",
        group: "browser",
        schema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", description: "REQUIRED. Full https URL to open. Never a file path; never empty." },
            sessionId: { type: "string", description: "OPTIONAL. Reuse an existing browser session id. Omit for a new/current tab." },
          },
        },
        run: async ({ url, sessionId } = {}, context) =>
          this.runBrowserOperation("browser_open", () => this.requireBrowserPlaywright().open({ url, sessionId }), context),
      },
      browser_view: {
        description: "Read the CURRENT page after browser_open. REQUIRED order: browser_open {url} FIRST, then browser_snapshot to get @e refs, then browser_view/click/type. No url arg here — it reads the open tab. format: 'markdown' (default text), 'screenshot', or 'both'. Example: open https://example.com, snapshot, then {\"format\":\"markdown\"}. Calling view with no open tab errors — always open first.",
        permission: "allowBrowserControl",
        group: "browser",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "OPTIONAL. Browser session id from browser_open. Omit = current tab." },
            format: { type: "string", enum: ["markdown", "screenshot", "both"], description: "REQUIRED choice. 'markdown' = page text (default), 'screenshot' = image, 'both' = text+image." },
          },
        },
        run: async ({ sessionId, format } = {}, context) =>
          this.runBrowserOperation("browser_view", () => this.requireBrowserPlaywright().view({ sessionId, format: format || "markdown" }), context),
      },
      browser_audit: {
        description: "List recent governed browser actions captured in the gateway audit feed.",
        permission: null,
        group: "ui",
        run: async ({ limit }) => ({
          operations: this.getBrowserAudit(Number(limit || 25)),
          localActions: this.browserOperator.getStatus?.().recentActions || [],
        }),
      },
      browser_snapshot: {
        description: "Hermes-compatible browser snapshot: accessibility-style text tree plus stable @e refs for click/type/tap.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string", description: "Optional browser session id to inspect." },
            full: { type: "boolean", description: "Reserved for Hermes parity; current implementation returns refs plus visible text." },
            maxElements: { type: "number", description: "Maximum interactive elements to include (default 100)." },
          },
        },
        run: async (input = {}, context) => {
          if (this.browser?.snapshot) {
            return this.runBrowserOperation("browser_snapshot", () => this.browser.snapshot(input), context);
          }
          return this.runBrowserOperation("snapshot", () => this.browserOperator.automate({ ...input, action: "snapshot" }), context);
        },
      },
      browser_links: {
        description: "Extract visible links from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) =>
          this.runBrowserOperation("links", () => this.browserOperator.automate({ ...input, action: "links" }), context),
      },
      browser_screenshot: {
        description: "Screenshot the current browser tab to disk (vision models see it). NOT a substitute for reading live state.",
        permission: "allowBrowserControl",
        group: "browser",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            fullPage: { type: "boolean", description: "true = capture the whole scrollable page." },
            ref: { type: "string", description: "Optional Hermes-style @e ref to capture a single element." },
            selector: { type: "string", description: "Optional CSS selector to capture a single element." },
          },
        },
        run: async (input = {}, context) => {
          if (this.browser) {
            return this.runBrowserOperation("browser_screenshot", () => this.browser.screenshot(input), context);
          }
          return this.runBrowserOperation("screenshot", () => this.browserOperator.automate({ ...input, action: "screenshot" }), context);
        },
      },
      browser_text: {
        description: "Extract visible text from the current automated browser page.",
        permission: "allowBrowserControl",
        group: "ui",
        run: async (input = {}, context) =>
          this.runBrowserOperation("text", () => this.browserOperator.automate({ ...input, action: "text" }), context),
      },
      browser_navigate: {
        description: "Hermes-compatible browser navigation tool. Must be called before other browser tools.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", description: "URL to navigate to." },
            sessionId: { type: "string", description: "Optional browser session id to reuse." },
          },
        },
        run: async ({ url, sessionId } = {}, context) =>
          this.tools.browser_open.run({ url, sessionId }, context),
      },
      browser_click: {
        description: "Click a page element. REQUIRED order: browser_open {url}, then browser_snapshot to get @e refs, then click with {ref:'@eN'}. Pass EITHER ref (preferred, e.g. '@e1') OR selector (CSS fallback) — never neither. sessionId optional (omit = current tab). waitForNavigation:true when the click loads a new page. Example: {\"ref\":\"@e3\"}.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "PREFERRED. Hermes element ref from browser_snapshot, e.g. '@e1'. Use this, not guessing selectors." },
            selector: { type: "string", description: "FALLBACK. CSS selector (e.g. 'button.submit'). Use only when no @e ref exists." },
            sessionId: { type: "string", description: "OPTIONAL. Browser session id. Omit = current tab." },
            waitForNavigation: { type: "boolean", description: "OPTIONAL. true = wait for navigation the click triggers. Default false." },
          },
        },
        run: async (input = {}, context) => {
          if (this.browser) {
            return this.runBrowserOperation("browser_click", () => this.browser.click(input), context);
          }
          return this.tools.browser.run({ ...input, action: "click" }, context);
        },
      },
      browser_type: {
        description: "Type text into an input field using a Hermes @e ref from browser_snapshot or a CSS selector. Clears the field first.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          required: ["text"],
          properties: {
            ref: { type: "string", description: "Hermes-style element ref from browser_snapshot, e.g. @e1." },
            selector: { type: "string", description: "CSS selector of the input field (fallback)." },
            text: { type: "string", description: "Text to type into the field." },
            pressEnter: { type: "boolean", description: "true = press Enter after typing." },
            sessionId: { type: "string" },
          },
        },
        run: async (input = {}, context) => {
          if (this.browser) {
            return this.runBrowserOperation("browser_type", () => this.browser.type(input), context);
          }
          return this.tools.browser.run({ ...input, action: "type" }, context);
        },
      },
      browser_scroll: {
        description: "Hermes-compatible browser scroll tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) => {
          if (this.browser) {
            return this.runBrowserOperation("browser_scroll", () => this.browser.scroll(input), context);
          }
          return this.tools.browser.run({ ...input, action: "scroll" }, context);
        },
      },
      browser_back: {
        description: "Hermes-compatible browser back tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) => {
          if (this.browser) {
            return this.runBrowserOperation("browser_back", () => this.browser.goBack(input), context);
          }
          return this.tools.browser.run({ ...input, action: "back" }, context);
        },
      },
      browser_forward: {
        description: "Hermes-compatible browser forward tool.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_forward", () => this.requireBrowserPlaywright().goForward(input), context),
      },
      browser_wait: {
        description: "Wait for a selector in the active browser session.",
        permission: "allowBrowserControl",
        group: "browser",
        schema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector to wait for. Omit to wait a fixed timeout." },
            timeout: { type: "number", description: "Max wait in milliseconds (default 10000)." },
            sessionId: { type: "string" },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_wait", () => this.requireBrowserPlaywright().wait(input), context),
      },
      browser_evaluate: {
        description: "Evaluate JavaScript in the active browser session and READ the returned value in the tool result. End with a JSON-serializable expression to read page/game state, e.g. ({score: document.querySelector('#score')?.textContent, gameOver: !!window.gameOver, startHidden: getComputedStyle(document.querySelector('#startPanel')).display === 'none'}). DOM nodes are not serializable — map them to plain data.",
        permission: "allowBrowserEvaluate",
        group: "browser",
        schema: {
          type: "object",
          required: ["script"],
          properties: {
            script: { type: "string", description: "JavaScript expression or function to run in the page (aliases accepted: expression/code/js). Its return value comes back in result.result." },
            args: { type: "array", description: "Optional arguments when script is a function." },
            sessionId: { type: "string" },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_evaluate", () => this.requireBrowserPlaywright().evaluate(input), context),
      },
      browser_close: {
        description: "Close a browser session.",
        permission: "allowBrowserControl",
        group: "browser",
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_close", () => this.requireBrowserPlaywright().close(input), context),
      },
      browser_automate: {
        description: "Perform multiple browser actions in sequence with Playwright.",
        permission: "allowBrowserControl",
        group: "browser",
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_automate", () => this.requireBrowserPlaywright().automate(input), context),
      },
      browser_sessions: {
        description: "List active Playwright browser sessions.",
        permission: null,
        group: "browser",
        run: async () => this.browser?.listSessions?.() || [],
      },
      browser_press: {
        description: "Hermes-compatible browser key press tool. Defaults to pressing on body; can target a ref/selector.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Keyboard key, e.g. Enter, Tab, Escape, Home." },
            ref: { type: "string", description: "Optional Hermes-style element ref to target." },
            selector: { type: "string", description: "Optional CSS selector to target." },
            sessionId: { type: "string" },
          },
        },
        run: async (input = {}, context) => {
          if (this.browser?.press) {
            return this.runBrowserOperation("browser_press", () => this.browser.press(input), context);
          }
          return this.tools.browser.run({ ...input, action: "press" }, context);
        },
      },
      browser_get_images: {
        description: "Hermes-compatible browser image discovery tool. Returns image URLs and alt text from the current page.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_get_images", () => this.requireBrowserPlaywright().getImages(input), context),
      },
      browser_vision: {
        description: "Hermes-compatible browser screenshot/vision bridge. Captures a screenshot and optional ref metadata for external visual inspection.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_vision", () => this.requireBrowserPlaywright().vision(input), context),
      },
      browser_console: {
        description: "Hermes-compatible browser console reader. Returns console/warn/error/pageerror messages and can evaluate JavaScript when allowed.",
        permission: "allowBrowserEvaluate",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            clear: { type: "boolean", description: "Clear collected console buffers after reading." },
            expression: { type: "string", description: "Optional JavaScript expression to evaluate before returning messages." },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_console", () => this.requireBrowserPlaywright().console(input), context),
      },
      browser_cdp: {
        description: "Hermes-compatible raw Chrome DevTools Protocol escape hatch for the active page.",
        permission: "allowBrowserEvaluate",
        group: "hermes-browser",
        schema: {
          type: "object",
          required: ["method"],
          properties: {
            sessionId: { type: "string" },
            method: { type: "string", description: "CDP method, e.g. Runtime.evaluate or Browser.getVersion." },
            params: { type: "object", description: "CDP method parameters." },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_cdp", () => this.requireBrowserPlaywright().cdp(input), context),
      },
      browser_dialog: {
        description: "Hermes-compatible browser dialog control. Pre-arm accept/dismiss/type for the next alert/confirm/prompt or list handled dialogs.",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            action: { type: "string", enum: ["list", "clear", "accept", "dismiss", "type"], description: "Dialog action. accept/type are armed for the next dialog." },
            text: { type: "string", description: "Text to pass to prompt dialogs for accept/type." },
            promptText: { type: "string", description: "Alias for text." },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_dialog", () => this.requireBrowserPlaywright().dialog(input), context),
      },
      browser_tap: {
        description: "Tap an element by Hermes @e ref/CSS selector or by x/y coordinates (touchscreen tap with mouse fallback).",
        permission: "allowBrowserControl",
        group: "hermes-browser",
        schema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Hermes-style element ref from browser_snapshot, e.g. @e1." },
            selector: { type: "string", description: "CSS selector fallback." },
            x: { type: "number", description: "Viewport x coordinate." },
            y: { type: "number", description: "Viewport y coordinate." },
            sessionId: { type: "string" },
          },
        },
        run: async (input = {}, context) =>
          this.runBrowserOperation("browser_tap", () => this.requireBrowserPlaywright().tap(input), context),
      },

      web_search: {
        description: "Search the web and fetch the best hits. Use for anything outside this machine. NOT for proving local files exist (use list_files/read_file).",
        permission: "allowWebResearch",
        group: "web",
        schema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            count: { type: "number" },
            maxResults: { type: "number" },
            fetchTop: { type: "number" },
            provider: { type: "string" },
            freshness: { type: "string" },
            date_after: { type: "string" },
            date_before: { type: "string" },
            country: { type: "string" },
            language: { type: "string" },
            contents: { type: "string" },
            type: { type: "string" },
          },
        },
        run: async ({ query, count, maxResults, fetchTop, provider, freshness, date_after, date_before, country, language, contents, type }) =>
          this.webResearch.search(String(query || "").trim(), {
            maxResults: Number(count || maxResults || 8),
            fetchTop: fetchTop === undefined ? undefined : Number(fetchTop),
            provider,
            freshness,
            date_after,
            date_before,
            country,
            language,
            contents,
            type,
          }),
      },
      brave_search: {
        description: "Search the web through Brave Search when a Brave key is configured; returns structured URL/title/snippet observations or a clear missing-key blocker.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ query, count, maxResults, freshness, date_after, date_before, country, language, search_lang, ui_lang }) => {
          const key = this.webResearch?.secretStore?.getProviderKey?.("brave")
            || this.webResearch?.secretStore?.getProviderKey?.("brave-search")
            || process.env.BRAVE_API_KEY
            || "";
          if (!key) {
            return {
              ok: false,
              blocked: true,
              provider: "brave",
              error: "BRAVE_API_KEY is not configured. Use web_search for fallback providers or configure a Brave provider key.",
            };
          }
          return this.webResearch.search(String(query || "").trim(), {
            maxResults: Number(count || maxResults || 8),
            provider: "brave",
            freshness,
            date_after,
            date_before,
            country,
            language,
            search_lang,
            ui_lang,
          });
        },
      },
      exa_search: {
        description: "Search the web through Exa neural/keyword search when an Exa key is configured; can request highlights, text, or summaries.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ query, count, maxResults, type, contents, freshness, date_after, date_before }) => {
          const key = this.webResearch?.secretStore?.getProviderKey?.("exa") || process.env.EXA_API_KEY || "";
          if (!key) {
            return {
              ok: false,
              blocked: true,
              provider: "exa",
              error: "EXA_API_KEY is not configured. Use web_search for fallback providers or configure an Exa provider key.",
            };
          }
          return this.webResearch.search(String(query || "").trim(), {
            maxResults: Number(count || maxResults || 8),
            provider: "exa",
            type,
            contents,
            freshness,
            date_after,
            date_before,
          });
        },
      },
      web_extract: {
        description: "Hermes-compatible URL extraction/fetch alias.",
        permission: "allowWebResearch",
        group: "hermes-web",
        run: async ({ url }, context) => this.tools.web_fetch.run({ url }, context),
      },
      x_search: {
        description: "Search public web results scoped toward X/Twitter posts.",
        permission: "allowWebResearch",
        group: "web",
        run: async ({ query }) => this.webResearch.search(`${String(query || "").trim()} site:x.com OR site:twitter.com`),
      },
      web_fetch: {
        description: "Fetch one URL to markdown. NOT for login-walled pages or local paths.",
        permission: "allowWebResearch",
        group: "web",
        schema: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string" },
            maxChars: { type: "number" },
          },
        },
        run: async ({ url, maxChars }) => this.webResearch.fetchUrl(String(url || "").trim(), Number(maxChars || 12000)),
      },
      read: {
        description: "OpenClaw-compatible workspace file read alias.",
        permission: "allowFileRead",
        group: "fs",
        schema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Workspace-relative or absolute file path." },
          },
        },
        run: async ({ path }) => this.tools.read_file.run({ path }),
      },
      write: {
        description: "OpenClaw-compatible workspace file write alias.",
        permission: "allowFileWrite",
        group: "fs",
        schema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Workspace-relative or absolute file path." },
            content: { type: "string", description: "Full file content to write." },
            append: { type: "boolean", description: "true = append instead of overwrite." },
          },
        },
        run: async ({ path, content, append }) =>
          append ? this.tools.append_file.run({ path, content }) : this.tools.write_file.run({ path, content }),
      },
      edit: {
        description: "Replace one unique text block in a file you already read (fuzzy whitespace match; misses return Did-you-mean). NOT for new files, whole rewrites (use write_file), or non-unique find text.",
        permission: "allowFileWrite",
        group: "fs",
        schema: {
          type: "object",
          required: ["path", "find"],
          properties: {
            path: { type: "string", description: "Workspace-relative or absolute file path." },
            find: { type: "string", description: "Text to find (unique in the file unless replaceAll=true). Whitespace/indent need not match exactly." },
            replace: { type: "string", description: "Replacement text. Empty string deletes the find text." },
            replaceAll: { type: "boolean", description: "true = replace every occurrence instead of requiring a unique match." },
          },
        },
        run: async ({ path, find, replace, replaceAll }, context) => {
          const config = this.configStore.getConfig();
          const files = this.chatFiles(context);
          // Editing needs the WHOLE file, never the 64KB read preview: a capped
          // read makes find-text beyond the cap impossible to match (endless edit
          // failures) and, worse, would write the truncated content back and DROP
          // the rest of the file. Read full (16MB safety cap) and refuse if bigger.
          const read = files.readText(path, EDIT_MAX_BYTES);
          if (read.truncated) {
            return { error: true, edited: false, path: read.path, message: `File is too large to edit safely (> ${EDIT_MAX_BYTES} bytes). Split it or edit a smaller file.` };
          }
          const target = String(find || "");
          if (!target) {
            throw new Error("find text is required.");
          }
          const replacement = String(replace || "");
          const result = fuzzyFindAndReplace(read.content, target, replacement, Boolean(replaceAll));
          if (result.error || result.matchCount === 0) {
            const out = {
              error: true,
              edited: false,
              path: read.path,
              occurrences: result.occurrences || 0,
              message: result.error || "Find text not found in file.",
            };
            // Closest-block hint only when nothing matched (not on ambiguity).
            if (result.matchCount === 0 && !/matches \d+ places/.test(result.error || "")) {
              const hint = findClosestSnippet(target, read.content);
              if (hint) out.didYouMean = hint;
              out.message += " Re-read the file (read_file shows line numbers) and copy the current text.";
            }
            return out;
          }
          const next = result.content;
          const write = files.writeText(path, next, {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
          const at = next.indexOf(replacement);
          const contextSnippet = replacement && at >= 0
            ? next.slice(Math.max(0, at - 120), Math.min(next.length, at + replacement.length + 120))
            : "";
          return {
            edited: true,
            replacements: result.matchCount,
            matchStrategy: result.strategy,
            contextSnippet,
            diff: buildEditDiff(target, replacement),
            ...write,
          };
        },
      },
      multi_edit: {
        description: "Apply several find/replace edits to ONE file atomically: all finds validated first, applied in order, all-or-nothing. Prefer over multiple edit calls for several spots in one file.",
        permission: "allowFileWrite",
        group: "fs",
        schema: {
          type: "object",
          required: ["path", "edits"],
          properties: {
            path: { type: "string", description: "Workspace-relative or absolute file path." },
            edits: {
              type: "array",
              description: "Ordered edits applied to the same file.",
              items: {
                type: "object",
                required: ["find", "replace"],
                properties: {
                  find: { type: "string", description: "Exact text to find (unique unless replaceAll=true)." },
                  replace: { type: "string", description: "Replacement text." },
                  replaceAll: { type: "boolean", description: "Replace every occurrence of this find." },
                },
              },
            },
          },
        },
        run: async ({ path, edits }, context) => {
          const config = this.configStore.getConfig();
          const files = this.chatFiles(context);
          const list = Array.isArray(edits) ? edits : [];
          if (list.length === 0) {
            return { error: true, edited: false, message: "edits array with at least one {find, replace} is required." };
          }
          // Edits need the FULL file (see the edit tool) — a capped read both
          // breaks matching and risks writing truncated content back.
          const read = files.readText(path, EDIT_MAX_BYTES);
          if (read.truncated) {
            return { error: true, edited: false, path: read.path, message: `File is too large to edit safely (> ${EDIT_MAX_BYTES} bytes). Split it or edit a smaller file.` };
          }
          let working = read.content;
          const applied = [];
          // Validate + apply sequentially against the working copy; abort on the
          // first failure so the file on disk is never half-edited. Same fuzzy
          // matching as the single edit tool (whitespace/indent/quote tolerant).
          for (let i = 0; i < list.length; i += 1) {
            const target = String(list[i]?.find || "");
            const replacement = String(list[i]?.replace || "");
            const replaceAll = Boolean(list[i]?.replaceAll);
            if (!target) {
              return { error: true, edited: false, path: read.path, failedEditIndex: i, message: `Edit ${i + 1}: find text is required.` };
            }
            const r = fuzzyFindAndReplace(working, target, replacement, replaceAll);
            if (r.error || r.matchCount === 0) {
              const out = { error: true, edited: false, path: read.path, failedEditIndex: i, message: `Edit ${i + 1}: ${r.error || "find text not found"} (note: earlier edits in this call may have changed it). No changes written.` };
              if (r.matchCount === 0 && !/matches \d+ places/.test(r.error || "")) {
                const hint = findClosestSnippet(target, working);
                if (hint) out.didYouMean = hint;
              }
              return out;
            }
            working = r.content;
            applied.push({ index: i, replacements: r.matchCount, strategy: r.strategy, diff: buildEditDiff(target, replacement, 20) });
          }
          const write = files.writeText(path, working, {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
          return {
            edited: true,
            editsApplied: applied.length,
            replacements: applied.reduce((sum, item) => sum + item.replacements, 0),
            diff: applied.map((item, idx) => `# edit ${idx + 1}\n${item.diff}`).join("\n"),
            ...write,
          };
        },
      },
      apply_patch: {
        description: "Apply an OpenClaw/Codex structured patch to workspace files, then return changed paths and verification metadata.",
        permission: "allowFileWrite",
        group: "fs",
        run: async (input = {}, context) => this.applyStructuredPatch(input, this.chatFiles(context)),
      },
      update_progress: {
        description: "Maintain a persistent PROGRESS.md at the project root for long or multi-session tasks (state subsystem). Records what is done, in progress, blocked, and notes — so the NEXT session resumes instead of re-exploring. Pass the full current state each time; it overwrites PROGRESS.md.",
        permission: "allowFileWrite",
        group: "state",
        schema: {
          type: "object",
          properties: {
            done: { type: "array", items: { type: "string" }, description: "Completed items." },
            inProgress: { type: "array", items: { type: "string" }, description: "Items currently being worked on." },
            blocked: { type: "array", items: { type: "string" }, description: "Blocked items, with the blocker." },
            notes: { type: "string", description: "Free-form notes / next concrete step for the next session." },
            task: { type: "string", description: "Optional one-line task/goal title." },
          },
        },
        run: async ({ done, inProgress, blocked, notes, task } = {}) => {
          const config = this.configStore.getConfig();
          const list = (items) => (Array.isArray(items) && items.length
            ? items.map((i) => `- ${String(i).trim()}`).join("\n")
            : "- (none)");
          const body = [
            "# PROGRESS",
            "",
            task ? `**Task:** ${String(task).trim()}` : "",
            `**Updated:** ${new Date().toISOString()}`,
            "",
            "## Done",
            list(done),
            "",
            "## In progress",
            list(inProgress),
            "",
            "## Blocked",
            list(blocked),
            "",
            "## Notes / next step",
            String(notes || "").trim() || "(none)",
            "",
          ].filter((line) => line !== "").join("\n") + "\n";
          const write = this.fileStore.writeText("PROGRESS.md", body, {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
          this.agentRuntime?.gateway?.addEvent?.("progress.updated", {
            done: (done || []).length,
            inProgress: (inProgress || []).length,
            blocked: (blocked || []).length,
          });
          return { saved: true, path: write.path, doneCount: (done || []).length, inProgressCount: (inProgress || []).length, blockedCount: (blocked || []).length };
        },
      },
      read_progress: {
        description: "Read the project's PROGRESS.md (state subsystem) to resume a long/multi-session task. Call this at the start of a continued task.",
        permission: "allowFileRead",
        group: "state",
        schema: { type: "object", properties: {} },
        run: async () => this.fileStore.readProgress(),
      },
      sprint_contract: {
        description: "Record the work-block agreement to SPRINT.md BEFORE coding: scope, files to change / NOT touch, pass criteria, exclusions.",
        permission: "allowFileWrite",
        group: "observability",
        schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short name for this sprint/work block." },
            scope: { type: "array", items: { type: "string" }, description: "What this block WILL do." },
            filesToChange: { type: "array", items: { type: "string" }, description: "Files expected to change." },
            doNotTouch: { type: "array", items: { type: "string" }, description: "Files/areas that must NOT be modified." },
            passCriteria: { type: "array", items: { type: "string" }, description: "Verifiable conditions for 'done' (commands/behaviors)." },
            exclusions: { type: "array", items: { type: "string" }, description: "Explicitly out of scope for this block." },
          },
        },
        run: async (input = {}) => {
          const config = this.configStore.getConfig();
          const list = (items) => (Array.isArray(items) && items.length ? items.map((i) => `- ${String(i).trim()}`).join("\n") : "- (none)");
          const body = [
            "# Sprint Contract",
            "",
            input.title ? `**Block:** ${String(input.title).trim()}` : "",
            `**Agreed:** ${new Date().toISOString()}`,
            "",
            "## Scope (will do)",
            list(input.scope),
            "",
            "## Files to change",
            list(input.filesToChange),
            "",
            "## Do NOT touch",
            list(input.doNotTouch),
            "",
            "## Pass criteria (verifiable)",
            list(input.passCriteria),
            "",
            "## Exclusions (out of scope)",
            list(input.exclusions),
            "",
          ].filter((l) => l !== "").join("\n") + "\n";
          const write = this.fileStore.writeText("SPRINT.md", body, {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
          this.agentRuntime?.gateway?.addEvent?.("sprint_contract.set", {
            title: input.title || "",
            scopeCount: (input.scope || []).length,
            doNotTouchCount: (input.doNotTouch || []).length,
            passCriteriaCount: (input.passCriteria || []).length,
          });
          return { saved: true, path: write.path, passCriteria: (input.passCriteria || []).length, doNotTouch: (input.doNotTouch || []).length };
        },
      },
      read_sprint_contract: {
        description: "Read the current SPRINT.md (process observability) — the upfront scope/do-not-touch/pass-criteria agreement for the work block. Read at the start to stay inside the agreed boundary.",
        permission: "allowFileRead",
        group: "observability",
        schema: { type: "object", properties: {} },
        run: async () => {
          try {
            const r = this.fileStore.readText("SPRINT.md", 20000);
            return { exists: true, content: r.content };
          } catch {
            return { exists: false, content: "" };
          }
        },
      },
      feature_list: {
        description: "Read the project's feature_list.json — the machine-readable single source of truth for scope. Each feature has {id, behavior, verification, state}. Returns the list plus a per-state summary and verified-completion rate. Call at the start of multi-feature work to know what's done/active/next.",
        permission: "allowFileRead",
        group: "state",
        schema: { type: "object", properties: {} },
        run: async () => {
          const { exists, features } = this.fileStore.readFeatureList();
          const by = (s) => features.filter((f) => f.state === s);
          const passing = by("passing").length;
          return {
            exists,
            total: features.length,
            summary: {
              not_started: by("not_started").length,
              active: by("active").length,
              blocked: by("blocked").length,
              passing,
            },
            verifiedCompletionRate: features.length ? Number((passing / features.length).toFixed(2)) : 0,
            nextNotStarted: (by("not_started")[0] || null),
            features,
          };
        },
      },
      feature_set: {
        description: "Define/update features in feature_list.json. Each feature needs behavior + verification command + state (not_started/active/blocked — never 'passing'; only feature_verify sets passing). One active feature at a time.",
        permission: "allowFileWrite",
        group: "state",
        schema: {
          type: "object",
          required: ["features"],
          properties: {
            features: {
              type: "array",
              description: "Full feature list to save (replaces the file). Pass all features each time.",
              items: {
                type: "object",
                required: ["id", "behavior"],
                properties: {
                  id: { type: "string", description: "Stable id, e.g. F01." },
                  behavior: { type: "string", description: "Observable behavior, e.g. 'POST /cart/items returns 201'." },
                  verification: { type: "string", description: "Exact shell command that proves it (run by feature_verify)." },
                  state: { type: "string", enum: ["not_started", "active", "blocked"], description: "passing is set only by feature_verify." },
                  deps: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        run: async ({ features } = {}) => {
          const config = this.configStore.getConfig();
          const existing = this.fileStore.readFeatureList().features;
          const prevById = new Map(existing.map((f) => [f.id, f]));
          const incoming = Array.isArray(features) ? features : [];
          if (incoming.length === 0) {
            return { error: true, message: "features array is required." };
          }
          let rejectedPassing = 0;
          const normalized = incoming.map((f) => {
            const id = String(f?.id || "").trim();
            const prev = prevById.get(id) || {};
            let state = ["not_started", "active", "blocked", "passing"].includes(f?.state) ? f.state : (prev.state || "not_started");
            // Pass-state gating: never accept a direct jump to passing here.
            if (f?.state === "passing" && prev.state !== "passing") {
              state = prev.state && prev.state !== "passing" ? prev.state : "active";
              rejectedPassing += 1;
            }
            // Once passing (via feature_verify), it stays passing (irreversible).
            if (prev.state === "passing") state = "passing";
            return {
              id,
              behavior: String(f?.behavior || prev.behavior || "").trim().slice(0, 400),
              verification: String(f?.verification || prev.verification || "").trim().slice(0, 400),
              state,
              evidence: prev.evidence || "",
              deps: Array.isArray(f?.deps) ? f.deps : (prev.deps || []),
            };
          }).filter((f) => f.id);
          const write = this.fileStore.writeFeatureList(normalized, { allowedRoots: config.tools.filesystem.writableRoots });
          const activeCount = normalized.filter((f) => f.state === "active").length;
          this.agentRuntime?.gateway?.addEvent?.("feature_list.updated", {
            total: normalized.length,
            passing: normalized.filter((f) => f.state === "passing").length,
            activeCount,
          });
          return {
            saved: true,
            path: write.path,
            total: normalized.length,
            activeCount,
            ...(rejectedPassing ? { note: `${rejectedPassing} feature(s) cannot be set passing directly — run feature_verify to prove them.` } : {}),
            ...(activeCount > 1 ? { wipWarning: "More than one feature is active. Keep WIP=1 — finish and verify one first." } : {}),
          };
        },
      },
      session_handoff: {
        description: "End-of-session clean-state check (build, tests, progress, artifacts, startup). Run before ending multi-step work; fix failures before exit.",
        permission: "allowShellExecution",
        group: "observability",
        schema: {
          type: "object",
          properties: {
            static: { type: "array", items: { type: "string" }, description: "Build/static commands. Omit to auto-discover." },
            tests: { type: "array", items: { type: "string" }, description: "Test commands. Omit to auto-discover." },
            cwd: { type: "string", description: "Optional working directory." },
          },
        },
        run: async (input = {}, context) => this.runSessionHandoff(input, context),
      },
      task_trace: {
        description: "Runtime observability: get a replayable decision-path timeline for a run (the current run by default) — status, rounds, tools used with status/duration, plan progress, verification results, errors, and token usage. Use to understand 'what actually ran' (e.g. why tests failed, what was changed) instead of re-diagnosing from scratch.",
        permission: null,
        group: "observability",
        schema: {
          type: "object",
          properties: {
            runId: { type: "string", description: "Run id to trace. Defaults to the current run." },
          },
        },
        run: async ({ runId } = {}, context) => {
          const id = String(runId || context?.runId || "").trim();
          if (!id) return { ok: false, error: "No runId (none provided and no current run in context)." };
          const trace = this.agentRuntime?.getToolTrace?.(id);
          if (!trace) return { ok: false, error: `Run not found: ${id}` };
          const loop = trace.modelToolLoop || {};
          const timeline = (trace.toolTrace || []).slice(-40).map((t) => ({
            round: t.round,
            tool: t.tool,
            status: t.error ? "error" : t.blocked ? "blocked" : "ok",
            durationMs: t.durationMs,
            detail: String(t.outputSummary || t.path || t.command || "").slice(0, 100),
          }));
          const plan = this.getRunPlan?.(id);
          let reasoningEffort = null;
          try {
            reasoningEffort = this.agentRuntime?.omniLoop?.describeReasoningSupport?.() || null;
          } catch { /* best effort */ }
          return {
            ok: true,
            runId: id,
            status: trace.status,
            engine: loop.loopEngine || "",
            rounds: loop.rounds,
            toolCallCount: loop.toolCallCount,
            stoppedReason: loop.stoppedReason,
            parallelToolBatches: loop.parallelToolBatches,
            verificationNudges: loop.verificationNudges,
            codeEdited: loop.codeEdited,
            verificationRan: loop.verificationRan,
            usage: loop.usage,
            // F2/F3 bench scoreboard: thinking-to-action ratio. A rise in
            // this ratio after a change is a regression signal.
            reasoningTokensTotal: loop.reasoningTokensTotal ?? loop.usage?.reasoningTokens ?? 0,
            thinkingToActionRatio: loop.thinkingToActionRatio ?? 0,
            roundReasoningTokens: loop.roundReasoningTokens || [],
            reasoningEffort,
            errors: (loop.errors || []).slice(0, 8),
            plan: plan ? plan.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`) : null,
            timeline,
          };
        },
      },
      check_boundaries: {
        description: "Run the project's architectural boundary rules (arch_rules.json) as executable checks — e.g. 'renderer must not import fs directly'. Greps the scoped files for each forbidden pattern and reports violations WITH the exact fix instruction. Turns architecture rules from docs into mechanical enforcement; run it in your static/verification step.",
        permission: "allowFileRead",
        group: "verification",
        schema: { type: "object", properties: {} },
        run: async () => this.runBoundaryChecks(),
      },
      add_check: {
        description: "Review-feedback promotion: add (or update) an architectural boundary rule to arch_rules.json so a recurring issue becomes a PERMANENT automated check. Provide a forbidden regex, the file glob to scan, and an agent-oriented fix message (what/why/how).",
        permission: "allowFileWrite",
        group: "verification",
        schema: {
          type: "object",
          required: ["id", "forbidden", "fix"],
          properties: {
            id: { type: "string", description: "Stable rule id, e.g. no-fs-in-renderer." },
            description: { type: "string", description: "What the rule enforces." },
            glob: { type: "string", description: "Files to scan, e.g. src/renderer/**/*.{js,ts}. Default: all source." },
            forbidden: { type: "string", description: "Regex that must NOT appear in scoped files." },
            fix: { type: "string", description: "Agent-oriented fix: what's wrong, why, and exactly how to fix it." },
          },
        },
        run: async ({ id, description, glob, forbidden, fix } = {}) => {
          const rid = String(id || "").trim();
          const pattern = String(forbidden || "").trim();
          if (!rid || !pattern || !String(fix || "").trim()) {
            return { error: true, message: "id, forbidden (regex), and fix are required." };
          }
          try { new RegExp(pattern); } catch (e) { return { error: true, message: `Invalid forbidden regex: ${e.message}` }; }
          const config = this.configStore.getConfig();
          const { rules } = this.fileStore.readArchRules();
          const next = rules.filter((r) => r.id !== rid);
          next.push({
            id: rid,
            description: String(description || "").trim().slice(0, 300),
            glob: String(glob || "").trim(),
            forbidden: pattern,
            fix: String(fix).trim().slice(0, 500),
          });
          const write = this.fileStore.writeArchRules(next, { allowedRoots: config.tools.filesystem.writableRoots });
          this.agentRuntime?.gateway?.addEvent?.("arch_rule.added", { id: rid, total: next.length });
          return { saved: true, path: write.path, ruleId: rid, totalRules: next.length };
        },
      },
      verify_done: {
        description: "Three-layer done-check BEFORE declaring a coding task complete, in order, stop at first failure: L1 static (build/lint), L2 tests/runtime, L3 end-to-end flow. Returns done + failing layer + fixes.",
        permission: "allowShellExecution",
        group: "verification",
        schema: {
          type: "object",
          properties: {
            static: { type: "array", items: { type: "string" }, description: "L1 commands (build/lint/typecheck). Omit to auto-discover." },
            tests: { type: "array", items: { type: "string" }, description: "L2 commands (test suites / startup). Omit to auto-discover." },
            e2e: { type: "array", items: { type: "string" }, description: "L3 end-to-end / full-flow commands. No reliable auto-discovery — pass these for a real done." },
            cwd: { type: "string", description: "Optional working directory." },
          },
        },
        run: async (input = {}, context) => this.runTerminationCheck(input, context),
      },
      feature_verify: {
        description: "Pass-state gate for a feature: runs the feature's verification command and marks it 'passing' ONLY if the command exits 0 (attaching the evidence). On failure it stays active and returns the output so you can fix it. This is the only way a feature becomes passing — you cannot self-declare it done.",
        permission: "allowShellExecution",
        group: "state",
        schema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", description: "Feature id to verify (e.g. F01)." },
            cwd: { type: "string", description: "Optional working directory for the verification command." },
          },
        },
        run: async ({ id, cwd } = {}, context) => {
          const config = this.configStore.getConfig();
          const fid = String(id || "").trim();
          const { features } = this.fileStore.readFeatureList();
          const feature = features.find((f) => f.id === fid);
          if (!feature) {
            return { ok: false, error: `Feature not found: ${fid}. Define it with feature_set first.` };
          }
          const command = String(feature.verification || "").trim();
          if (!command) {
            return { ok: false, error: `Feature ${fid} has no verification command. Add one with feature_set — 'looks fine' is not completion evidence.` };
          }
          const executor = this.shellExecutor || this.agentRuntime?.shellExecutor;
          if (!executor?.execute) {
            return { ok: false, error: "Shell executor unavailable; feature_verify needs it to run the verification command." };
          }
          let result;
          try {
            result = await executor.execute({
              command,
              cwd: String(cwd || "").trim(),
              timeoutMs: 120000,
              runId: context?.runId || "",
              sessionId: context?.sessionId || "",
            });
          } catch (error) {
            result = { status: "failed", exitCode: 1, stderr: error.message };
          }
          // Strict gate: only an explicit clean exit (status completed + exit 0)
          // counts. An unknown/missing exit code is treated as NOT passing.
          const passed = result.status === "completed" && result.exitCode === 0;
          const stdout = String(result.stdout || "").slice(0, 600);
          const stderr = String(result.stderr || "").slice(0, 600);
          // Only the verification command exiting 0 flips the state to passing.
          const updated = features.map((f) => {
            if (f.id !== fid) return f;
            if (passed) {
              return { ...f, state: "passing", evidence: `verified: ${command} (exit ${result.exitCode ?? 0}) @ ${new Date().toISOString()}` };
            }
            return { ...f, state: f.state === "passing" ? "passing" : "active" };
          });
          this.fileStore.writeFeatureList(updated, { allowedRoots: config.tools.filesystem.writableRoots });
          this.agentRuntime?.gateway?.addEvent?.("feature.verified", { id: fid, passed, exitCode: result.exitCode });
          return {
            ok: true,
            id: fid,
            passed,
            newState: passed ? "passing" : "active",
            command,
            exitCode: result.exitCode ?? null,
            stdout,
            stderr: passed ? "" : stderr,
            message: passed
              ? `Feature ${fid} verified and marked passing.`
              : `Feature ${fid} verification FAILED — still active. Fix the cause and re-run feature_verify.`,
          };
        },
      },
      log_decision: {
        description: "Append a design decision to DECISIONS.md at the project root — the WHY behind a choice (which option, why, what was rejected). Compaction and new sessions lose the 'why'; this preserves it. Log non-obvious choices so a future session does not re-decide differently.",
        permission: "allowFileWrite",
        group: "state",
        schema: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", description: "The decision made (one line)." },
            reason: { type: "string", description: "Why this was chosen." },
            rejected: { type: "string", description: "Alternative(s) considered and why rejected." },
            constraint: { type: "string", description: "Any resulting constraint/assumption to honor later." },
          },
        },
        run: async ({ decision, reason, rejected, constraint } = {}) => {
          const text = String(decision || "").trim();
          if (!text) {
            return { error: true, message: "decision is required." };
          }
          const config = this.configStore.getConfig();
          const existing = this.fileStore.readDecisions();
          const date = new Date().toISOString().slice(0, 10);
          const entry = [
            `## ${date}: ${text}`,
            reason ? `- Reason: ${String(reason).trim()}` : "",
            rejected ? `- Rejected: ${String(rejected).trim()}` : "",
            constraint ? `- Constraint: ${String(constraint).trim()}` : "",
            "",
          ].filter(Boolean).join("\n") + "\n";
          const header = existing.exists ? "" : "# Design Decisions\n\nWhy choices were made — read at session start so a new session does not re-decide differently.\n\n";
          const body = `${existing.exists ? existing.content.replace(/\n*$/, "\n") : header}${entry}`;
          const write = this.fileStore.writeText("DECISIONS.md", body, {
            allowedRoots: config.tools.filesystem.writableRoots,
            append: false,
          });
          this.agentRuntime?.gateway?.addEvent?.("decision.logged", { decision: text.slice(0, 120) });
          return { saved: true, path: write.path, decision: text };
        },
      },
      read_decisions: {
        description: "Read the project's DECISIONS.md (the 'why' log) to understand past design choices before changing related code. Call at the start of a continued task.",
        permission: "allowFileRead",
        group: "state",
        schema: { type: "object", properties: {} },
        run: async () => this.fileStore.readDecisions(),
      },
      harness_doctor: {
        description: "Audit the current project's agent harness across the five subsystems (Instructions, Tools, Environment, State, Feedback) and report a score plus concrete gaps, a fresh-session test, knowledge-decay warnings, and an initialization/ready-to-hand-off verdict. Use to check why the agent struggles in a repo, or before a big task.",
        permission: "allowFileRead",
        group: "harness",
        schema: { type: "object", properties: {} },
        run: async (_input, context) => this.runHarnessDoctor(context),
      },
      init_project: {
        description: "Run the dedicated INITIALIZATION phase for a repo (do this BEFORE feature work, separate from implementation): detect run/test commands and structure, scaffold STARTUP.md (startup readiness checklist) and TASKS.md (task breakdown) if missing, and report the 4 readiness conditions. Never overwrites existing files. After this, ensure one test passes and git_commit a clean checkpoint.",
        permission: "allowFileWrite",
        group: "harness",
        schema: { type: "object", properties: {} },
        run: async (_input, context) => this.runInitProject(context),
      },
      git_status: {
        description: "Show branch plus staged/unstaged/untracked files. Read-only; commits live in git-write.",
        permission: "allowShellExecution",
        group: "git",
        schema: { type: "object", properties: { cwd: { type: "string", description: "Optional repo subdirectory." } } },
        run: async ({ cwd } = {}, context) => this.runGitCommand("status --porcelain=v1 --branch", cwd, context, (stdout) => {
          const lines = String(stdout || "").split("\n").filter(Boolean);
          const status = { branch: "", staged: [], unstaged: [], untracked: [] };
          for (const line of lines) {
            if (line.startsWith("##")) { status.branch = line.slice(2).trim(); continue; }
            const code = line.slice(0, 2);
            const file = line.slice(3);
            if (code === "??") status.untracked.push(file);
            else {
              if (code[0] !== " " && code[0] !== "?") status.staged.push({ file, code: code[0] });
              if (code[1] !== " " && code[1] !== "?") status.unstaged.push({ file, code: code[1] });
            }
          }
          // Token diet: cap each category at 40 files with +N counts. Never
          // inline diffs here — scope git_diff to a path for details.
          const capList = (arr) => {
            const omitted = Math.max(0, arr.length - 40);
            return { kept: arr.slice(0, 40), omitted };
          };
          const staged = capList(status.staged);
          const unstaged = capList(status.unstaged);
          const untracked = capList(status.untracked);
          const omittedTotal = staged.omitted + unstaged.omitted + untracked.omitted;
          return {
            branch: status.branch,
            staged: staged.kept,
            unstaged: unstaged.kept,
            untracked: untracked.kept,
            clean: lines.filter((l) => !l.startsWith("##")).length === 0,
            ...(omittedTotal > 0
              ? { omittedFiles: omittedTotal, note: `showing 40 per category, ${omittedTotal} more file(s) omitted. Use git_diff on a specific path.` }
              : {}),
          };
        }),
      },
      git_diff: {
        description: "Show the working-tree diff (staged:true for the index, path to scope). Read-only.",
        permission: "allowShellExecution",
        group: "git",
        schema: {
          type: "object",
          properties: {
            staged: { type: "boolean", description: "true = show staged (index) diff instead of working tree." },
            path: { type: "string", description: "Optional file/dir to scope the diff." },
            cwd: { type: "string", description: "Optional repo subdirectory." },
          },
        },
        run: async ({ staged, path: diffPath, cwd } = {}, context) => {
          const args = ["diff"];
          if (staged) args.push("--staged");
          if (diffPath) args.push("--", String(diffPath));
          return this.runGitCommand(args.join(" "), cwd, context, (stdout) => {
            const text = String(stdout || "");
            return { staged: Boolean(staged), path: diffPath || "", empty: text.trim() === "", diff: text.slice(0, 12000), truncated: text.length > 12000 };
          });
        },
      },
      git_log: {
        description: "Show recent git commits (oneline: hash, subject). Read-only.",
        permission: "allowShellExecution",
        group: "git",
        schema: {
          type: "object",
          properties: {
            count: { type: "number", description: "How many commits (default 15, max 100)." },
            cwd: { type: "string", description: "Optional repo subdirectory." },
          },
        },
        run: async ({ count, cwd } = {}, context) => {
          const n = Math.max(1, Math.min(100, Number(count || 15)));
          // A --pretty value beginning with % is a literal format string; we
          // avoid the "format:" prefix because the shell policy blocks the word.
          return this.runGitCommand(`log -n ${n} --date=short --pretty=%h%x09%an%x09%ad%x09%s`, cwd, context, (stdout) => {
            const commits = String(stdout || "").split("\n").filter(Boolean).map((line) => {
              const [hash, author, date, ...subject] = line.split("\t");
              return { hash, author, date, subject: subject.join("\t") };
            });
            return { count: commits.length, commits };
          });
        },
      },
      git_commit: {
        description: "Create a git checkpoint: stage all changes and commit locally with a message. Use after completing an atomic unit of work — these are free, versioned snapshots a future session can restore from. Local only (never pushes). Commit messages should say what was done and why.",
        permission: "allowShellExecution",
        group: "git",
        schema: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", description: "Commit message: what was done and why." },
            cwd: { type: "string", description: "Optional repo subdirectory." },
          },
        },
        run: async ({ message, cwd } = {}, context) => {
          const raw = String(message || "").trim();
          if (!raw) {
            return { ok: false, error: "commit message is required." };
          }
          // Sanitize for a single -m argument: no newlines, escape double quotes.
          const safeMsg = raw.replace(/[\r\n]+/g, " ").replace(/"/g, '\\"').slice(0, 300);
          const executor = this.shellExecutor || this.agentRuntime?.shellExecutor;
          if (!executor?.execute) {
            return { ok: false, error: "Shell executor unavailable; git_commit needs it." };
          }
          // Per-chat bind (same rule as runGitCommand): never commit outside
          // the chat's own project folder.
          const gate = this.chatCwd(cwd, context);
          if (!gate.ok) {
            return { ok: false, error: gate.error };
          }
          const runGit = async (args) => {
            try {
              return await executor.execute({ command: `git ${args}`, cwd: gate.cwd, timeoutMs: 30000, runId: context?.runId || "", sessionId: context?.sessionId || "" });
            } catch (error) {
              return { status: "failed", stderr: error.message };
            }
          };
          const okOf = (r) => r.status === "completed" && (r.exitCode === 0 || r.exitCode == null);
          // Stale-lock recovery: an interrupted/timed-out git command (or a raced
          // concurrent commit) leaves `.git/index.lock`, which then blocks EVERY
          // subsequent commit — the model retries ~25x and never recovers. If the
          // error is lock contention AND the lock file is stale (older than a few
          // seconds, so we're not stomping an actively-running git), remove it and
          // retry. Only ever touches the lock inside THIS repo root.
          const repoRoot = path.resolve(gate.cwd);
          const lockPath = path.join(repoRoot, ".git", "index.lock");
          const isLockError = (txt) => /index\.lock|another git process seems to be running|Unable to create.*index\.lock/i.test(String(txt || ""));
          const clearStaleLock = () => {
            try {
              const st = fs.statSync(lockPath); // throws if absent
              if (Date.now() - st.mtimeMs > 5000) { fs.rmSync(lockPath, { force: true }); return true; }
            } catch { /* no lock file — nothing to clear */ }
            return false;
          };
          const runGitWithLockRetry = async (args) => {
            let r = await runGit(args);
            for (let attempt = 0; attempt < 3 && !okOf(r) && isLockError(r.stderr || r.stdout); attempt += 1) {
              const cleared = clearStaleLock();
              if (!cleared) await new Promise((res) => setTimeout(res, 800)); // lock is fresh — let the other git finish
              r = await runGit(args);
            }
            return r;
          };
          const stage = await runGitWithLockRetry("add -A");
          if (!okOf(stage)) {
            const err = String(stage.stderr || stage.stdout || "").trim();
            return { ok: false, error: /not a git repository/i.test(err) ? "Not a git repository (run `git init` first)." : (err.slice(0, 400) || "git add failed") };
          }
          const commit = await runGitWithLockRetry(`commit -m "${safeMsg}"`);
          const out = String(commit.stdout || commit.stderr || "");
          if (!okOf(commit)) {
            if (/nothing to commit|no changes added/i.test(out)) {
              return { ok: true, committed: false, message: "Nothing to commit — working tree clean." };
            }
            return { ok: false, error: out.trim().slice(0, 400) || "git commit failed" };
          }
          const hashRes = await runGit("rev-parse --short HEAD");
          const hash = okOf(hashRes) ? String(hashRes.stdout || "").trim().split("\n")[0] : "";
          this.agentRuntime?.gateway?.addEvent?.("git.committed", { hash, message: raw.slice(0, 120) });
          return { ok: true, committed: true, hash, message: raw.slice(0, 300) };
        },
      },
      patch: {
        description: "Hermes-compatible patch alias.",
        permission: "allowFileWrite",
        group: "hermes-file",
        run: async (input = {}, context) => this.tools.apply_patch.run(input, context),
      },
      search_files: {
        description: "Hermes-compatible search across memory and configured computer roots.",
        permission: "allowComputerAccess",
        group: "hermes-file",
        run: async ({ pattern, query, path, target, limit } = {}, context) => {
          const q = String(query || pattern || "").trim();
          if (!q) {
            throw new Error("pattern or query is required.");
          }
          const memory = await this.tools.memory_search.run({ query: q }, context);
          let files = null;
          try {
            files = await this.tools.search_computer_files.run({
              query: q,
              root: path,
              target,
              maxResults: Number(limit || 80),
              maxDepth: 4,
              maxScanMs: 7000,
            }, context);
          } catch (error) {
            files = {
              ok: false,
              error: error.message,
            };
          }
          return { query: q, memory, files };
        },
      },
      message: {
        description: "Send a message into an OmniClaw agent session/channel.",
        permission: "allowConnectorWrite",
        group: "messaging",
        run: async ({ text, message, agentId, label, channel }) => {
          if (!this.agentRuntime?.handleMessage) {
            throw new Error("Agent message runtime is unavailable.");
          }
          return this.agentRuntime.handleMessage(String(text || message || "").trim(), {
            agentId: String(agentId || "main").trim(),
            label: String(label || "tool-message").trim(),
            channel: String(channel || "webchat").trim(),
          });
        },
      },
      send_message: {
        description: "Hermes-compatible cross-platform message send alias.",
        permission: "allowConnectorWrite",
        group: "hermes-messaging",
        run: async (input = {}) => this.tools.message.run(input),
      },
      sessions_list: {
        description: "List OmniClaw sessions.",
        permission: null,
        group: "sessions",
        run: async ({ limit }) => ({
          sessions: this.agentRuntime?.sessions?.listSessions?.(Number(limit || 50)) || [],
        }),
      },
      sessions_history: {
        description: "Read transcript history for one session.",
        permission: null,
        group: "sessions",
        run: async ({ sessionId, limit }, context) => {
          const sessions = this.agentRuntime?.sessions;
          if (!sessions?.getSession) {
            throw new Error("Session runtime is unavailable.");
          }
          const resolvedSessionId = String(sessionId || context.sessionId || "").trim();
          if (!resolvedSessionId) {
            return {
              session: null,
              transcript: [],
              message: "No sessionId was provided and the current tool context has no sessionId.",
            };
          }
          const session = sessions.getSession(resolvedSessionId, {
            messageLimit: Number(limit || 80),
          });
          if (!session) {
            return {
              session: null,
              transcript: [],
              message: `Session not found: ${resolvedSessionId}`,
            };
          }
          return {
            session,
            transcript: Array.isArray(session.transcript) ? session.transcript : [],
          };
        },
      },
      sessions_send: {
        description: "OpenClaw-compatible session send alias.",
        permission: "allowConnectorWrite",
        group: "sessions",
        run: async (input) => this.tools.message.run(input),
      },
      channel_dock: {
        description: "Move the current session reply route to a linked channel/peer without creating a new session.",
        permission: "allowConnectorWrite",
        group: "sessions",
        run: async (input = {}, context = {}) => {
          const sessionId = String(input.sessionId || context.sessionId || "").trim();
          if (!sessionId) {
            return {
              ok: false,
              blocked: true,
              reason: "missing-session-id",
              message: "channel_dock needs a current sessionId or explicit sessionId.",
            };
          }
          if (!this.agentRuntime?.sessions?.dockSession) {
            throw new Error("Session docking backend is unavailable.");
          }
          const result = this.agentRuntime.sessions.dockSession(sessionId, input);
          this.agentRuntime?.gateway?.addEvent?.("session.docked", {
            sessionId,
            ok: Boolean(result.ok),
            blocked: Boolean(result.blocked),
            reason: result.reason || "",
            route: result.route || null,
          });
          return result;
        },
      },

      sessions_spawn: {
        description: "Spawn an isolated background OmniClaw session and immediately return child session/run ids.",
        permission: null,
        group: "sessions",
        schema: {
          type: "object",
          properties: {
            label: { type: "string" },
            agentId: { type: "string" },
            channel: { type: "string" },
            message: { type: "string" },
            task: { type: "string" },
          },
        },
        run: async ({ label, agentId, channel, message, task } = {}, context = {}) => {
          const instruction = String(message || task || "").trim();
          const session = this.agentRuntime?.sessions?.resolveSession?.({
            label: String(label || "spawned").trim(),
            agentId: String(agentId || "main").trim(),
            channel: String(channel || "webchat").trim(),
            parentSessionId: context.sessionId || null,
          });
          if (!session || !instruction || !this.agentRuntime?.handleMessage) {
            return { spawned: Boolean(session), session, childSessionKey: session?.key || "", runId: "", queued: false };
          }
          const result = await this.agentRuntime.handleMessage(instruction, {
            sessionId: session.id,
            label: session.label,
            agentId: session.agentId,
            channel: session.channel,
            parentRunId: context.runId || "",
            parentSessionId: context.sessionId || "",
            source: "sessions_spawn",
          });
          return {
            spawned: true,
            session,
            childSessionKey: session.key,
            runId: result?.run?.id || "",
            queued: true,
            contract: "spawn -> yield -> result event; do not poll repeatedly",
          };
        },
      },
      sessions_yield: {
        description: "Yield current turn after spawning/delegating work; wait for result event instead of polling.",
        permission: null,
        group: "sessions",
        run: async (_, context) => ({
          yielded: true,
          sessionId: context.sessionId || "",
          runId: context.runId || "",
          agentId: this.getAgentId(context),
          contract: "Do not poll subagents repeatedly. Spawn -> yield -> result event.",
        }),
      },
      session_status: {
        description: "Lightweight /status-style readback for provider, queue, session, and active agent.",
        permission: null,
        group: "sessions",
        run: async (_, context) => ({
          provider: this.agentRuntime?.getProviderInfo?.() || {},
          gateway: this.agentRuntime?.gateway?.getOverview?.() || {},
          sessionId: context.sessionId || "",
          runId: context.runId || "",
          agent: this.agentRegistry?.resolveAgent?.(this.getAgentId(context)) || null,
        }),
      },
      acp_doctor: {
        description: "Run ACP backend/harness readiness checks for Codex, OpenCode, Claude, Gemini, and other ACP agents.",
        permission: null,
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().doctor(input),
      },
      acp_install: {
        description: "Return deterministic ACP/acpx install and permission setup instructions.",
        permission: null,
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().installInstructions(input),
      },
      acp_spawn: {
        description: "Spawn a real external ACP/local CLI harness session for a task.",
        permission: "allowShellExecution",
        group: "acp",
        run: async (input = {}, context = {}) => this.requireAcpManager().spawn(input, context),
      },
      acp_status: {
        description: "Show ACP control-plane status and optionally inspect one ACP session.",
        permission: null,
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().status(input),
      },
      acp_sessions: {
        description: "List recent ACP external harness sessions.",
        permission: null,
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().listSessions(input),
      },
      acp_cancel: {
        description: "Cancel a running ACP external harness session.",
        permission: "allowShellExecution",
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().cancel(input),
      },
      acp_close: {
        description: "Close an ACP session binding/record.",
        permission: "allowShellExecution",
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().close(input),
      },
      acp_set_option: {
        description: "Set ACP runtime option such as model, permissions, timeout, or cwd on a session/config.",
        permission: "allowConfigWrite",
        group: "acp",
        run: async (input = {}) => this.requireAcpManager().setOption(input),
      },
      agent_harness_doctor: {
        description: "Check jcode-style coding agent harness readiness for Codex/OpenCode/Claude/Gemini/Qwen CLI agents.",
        permission: null,
        group: "harness",
        schema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Harness agent id such as codex, opencode, claude, gemini, or qwen." },
          },
        },
        run: async (input = {}) => this.requireCodingHarness().doctor(input),
      },
      agent_harness_spawn: {
        description: "Spawn a real coding-agent harness session to work on a coding task and return stored stdout/stderr/session metadata.",
        permission: "allowShellExecution",
        group: "harness",
        schema: {
          type: "object",
          required: ["task"],
          properties: {
            agentId: { type: "string", description: "Harness agent id. Defaults to codingHarness.defaultAgent." },
            task: { type: "string", description: "Coding task/prompt for the harness agent." },
            prompt: { type: "string", description: "Alias for task." },
            cwd: { type: "string", description: "Working directory. Defaults to workspace root." },
            mode: { type: "string", description: "run waits for completion; background/session returns process id." },
            label: { type: "string" },
            model: { type: "string" },
            permissions: { type: "string" },
            timeoutSeconds: { type: "number" },
            successCriteria: {
              type: "array",
              items: { type: "string" },
              description: "Acceptance criteria the child agent must satisfy.",
            },
            verificationCommands: {
              type: "array",
              items: { type: "string" },
              description: "Commands OmniClaw should run after the harness finishes. All must pass for verified completion.",
            },
            requiredArtifacts: {
              type: "array",
              items: { type: "string" },
              description: "Expected files/artifacts that must exist after the harness run.",
            },
            constraints: {
              type: "array",
              items: { type: "string" },
              description: "Extra safety/scope constraints for the child agent.",
            },
            context: { type: "string", description: "Compact parent context for the child agent." },
          },
        },
        run: async (input = {}, context = {}) => this.requireCodingHarness().spawn(input, context),
      },
      agent_harness_status: {
        description: "Inspect one coding-agent harness session or get harness control-plane status.",
        permission: null,
        group: "harness",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            sessionKey: { type: "string" },
            label: { type: "string" },
            limit: { type: "number" },
            status: { type: "string" },
          },
        },
        run: async (input = {}) => this.requireCodingHarness().status(input),
      },
      agent_harness_sessions: {
        description: "List recent coding-agent harness sessions.",
        permission: null,
        group: "harness",
        schema: {
          type: "object",
          properties: {
            limit: { type: "number" },
            status: { type: "string" },
            agentId: { type: "string" },
          },
        },
        run: async (input = {}) => this.requireCodingHarness().listSessions(input),
      },
      agent_harness_cancel: {
        description: "Cancel a running coding-agent harness session.",
        permission: "allowShellExecution",
        group: "harness",
        schema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            sessionKey: { type: "string" },
            label: { type: "string" },
          },
        },
        run: async (input = {}) => this.requireCodingHarness().cancel(input),
      },
      agents_list: {
        description: "List configured OmniClaw agents.",
        permission: null,
        group: "sessions",
        run: async () => ({
          agents: this.agentRegistry?.getAll?.() || [],
        }),
      },
      skills_list: {
        description: "List compact OmniClaw skills. Full SKILL.md content is intentionally omitted; use skill_read on demand.",
        permission: null,
        group: "skills",
        run: async (input = {}, context) => {
          const agentId = this.getAgentId(context);
          const omniSkills = this.agentRegistry
            ? this.agentRegistry.filterSkills(this.agentRuntime?.skills?.getAll?.({ agentId }) || this.customizationEngine?.skillRegistry?.getAll?.({ agentId }) || [], agentId)
            : [];
          const hermes = this.scanHermesSkills({
            query: input.query || "",
            limit: Number(input.limit || 40),
          });
          return {
            agentId,
            omniSkillCount: omniSkills.length,
            hermesSkillCount: hermes.totalAvailable,
            omniSkills,
            hermesSkills: hermes.skills,
            precedence: ["workspace-agent", "workspace", "personal-agent", "managed", "personal", "bundled"],
            note: "Prompt gets compact list only; read SKILL.md via skill_read/read_file when needed.",
          };
        },
      },
      skill_read: {
        description: "Open a matched skill's SKILL.md method file. NOT for guessing from the name — read it.",
        permission: null,
        group: "skills",
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            scope: { type: "string" },
          },
        },
        run: async ({ name, scope } = {}, context = {}) => {
          const agentId = this.getAgentId(context);
          const skill = this.agentRuntime?.skills?.getSkill?.(String(name || "").trim(), scope || "all", agentId);
          return {
            found: Boolean(skill),
            id: skill?.id || "",
            name: skill?.name || name || "",
            source: skill?.source || skill?.scope || "",
            path: skill?.path || "",
            content: skill?.content || "",
          };
        },
      },
      skill_view: {
        description: "Hermes-compatible skill read/view tool.",
        permission: null,
        group: "hermes-skills",
        run: async ({ id, name, path: skillPath } = {}) => {
          const target = String(skillPath || id || name || "").trim();
          if (!target) {
            throw new Error("skill id/name/path is required.");
          }
          const root = this.getRootDir();
          const candidates = this.getHermesSkillFiles();
          const match = candidates.find((filePath) => {
            const relative = path.relative(root, filePath).replace(/\\/g, "/");
            return relative.toLowerCase().includes(target.toLowerCase()) ||
              path.basename(path.dirname(filePath)).toLowerCase() === target.toLowerCase();
          });
          if (!match) {
            return {
              found: false,
              query: target,
              message: "Skill not found in vendored Hermes skills.",
            };
          }
          return {
            found: true,
            path: path.relative(root, match).replace(/\\/g, "/"),
            content: fs.readFileSync(match, "utf8"),
          };
        },
      },
      skill_manage: {
        description: "Hermes-compatible skill management placeholder for reviewable imports.",
        permission: "allowSkillWrite",
        group: "hermes-skills",
        run: async (input = {}) => ({
          ok: false,
          action: input.action || "review",
          message: "Hermes skill management is cataloged. Use hermes_skill_scan plus a dedicated import step so incompatible Python-only instructions are not blindly installed.",
          nextUpgrade: "Add hermes_skill_import with compatibility rewrite into OmniClaw skill format.",
        }),
      },
      memory_search: {
        description: "Hybrid search across session transcripts, daily memory, long-term memory, notes, research, and artifacts.",
        permission: null,
        group: "memory",
        schema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            scope: { type: "string" },
          },
        },
        run: async ({ query, limit, scope, filters } = {}, context) => {
          const res = await this.memoryStore.hybridSearch({
            query,
            limit: Math.max(1, Math.min(12, Number(limit || 12))),
            scope: scope || filters?.scope || "all",
            agentId: this.getAgentId(context),
            semanticMemory: this.agentRuntime?.semanticMemory,
          });
          // Token diet: never dump full memory bodies (the 150k-char blowup).
          // 12 hits max: id + short title + 240-char snippet each (~4.7k
          // total). Full text stays one memory_get {id} away (the model hint
          // says exactly that).
          const results = (res.results || []).slice(0, 12).map((hit) => ({
            layer: hit.layer || "",
            id: hit.id || "",
            title: String(hit.title || "").slice(0, 60),
            preview: String(hit.preview || hit.text || "").replace(/\s+/g, " ").trim().slice(0, 240),
            score: hit.score ?? null,
          }));
          return {
            query: res.query ?? query,
            scope: res.scope ?? scope ?? "all",
            mode: res.mode || "",
            count: results.length,
            layers: res.layers || {},
            results,
          };
        },
      },
      memory_recall: {
        description: "Recall relevant memories for the current message (hybrid keyword + semantic). Key facts also arrive automatically; call this when history, preferences, or past work matter for what you are doing. NOT for brand-new facts (use memory_write) or session trivia.",
        permission: null,
        group: "memory",
        schema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "What to recall (the current topic or question)." },
            limit: { type: "number", description: "Max memories (default 12)." },
          },
        },
        run: async ({ query, limit } = {}, context) =>
          this.memoryStore.hybridSearch({
            query: String(query || ""),
            limit: Number(limit || 12),
            scope: "all",
            agentId: this.getAgentId(context),
            semanticMemory: this.agentRuntime?.semanticMemory,
          }),
      },
      memory_get: {
        description: "Read memory layer files or memory overview. file can be MEMORY.md, daily, dreams, or overview.",
        permission: null,
        group: "memory",
        schema: {
          type: "object",
          properties: {
            file: { type: "string" },
            range: { type: "string" },
          },
        },
        run: async ({ file, range } = {}, context) => this.memoryStore.getLayeredMemory({
          file: file || "overview",
          range,
          agentId: this.getAgentId(context),
        }),
      },
      memory_compact: {
        description: "Compact daily/session memory into durable long-term memory candidates and refresh MEMORY.md.",
        permission: "allowMemoryPromotion",
        group: "memory",
        schema: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
            maxItems: { type: "number" },
          },
        },
        run: async (input = {}, context) => this.memoryStore.compactLayeredMemory({
          ...input,
          agentId: input.agentId || this.getAgentId(context),
        }),
      },
      memory: {
        description: "Hermes-compatible memory read/search/save/promote/replace/remove tool.",
        permission: null,
        group: "hermes-memory",
        run: async ({ action, query, text, old_text: oldText, match, content, title } = {}, context) => {
          const normalized = String(action || (text ? "remember" : query ? "search" : "list")).toLowerCase();
          if (["search", "find"].includes(normalized)) {
            return this.tools.memory_search.run({ query }, context);
          }
          if (["remember", "save", "note", "add"].includes(normalized)) {
            return this.tools.memory_write.run({ type: "daily", content: text || content, source: "memory-tool" }, context);
          }
          if (["promote"].includes(normalized)) {
            return this.tools.promote_memory.run({ text, sourceType: "manual" }, context);
          }
          // Hermes memory(action=replace/remove, old_text=...) parity.
          if (["replace", "update", "edit"].includes(normalized)) {
            return this.tools.memory_replace.run({ match: oldText || match, text: text || content, title }, context);
          }
          if (["remove", "delete", "forget"].includes(normalized)) {
            return this.tools.memory_forget.run({ match: oldText || match || text }, context);
          }
          return this.tools.list_long_term_memory.run({}, context);
        },
      },
      session_search: {
        description: "Hermes-compatible session and memory search.",
        permission: null,
        group: "hermes-memory",
        run: async ({ query, limit } = {}, context) => {
          const sessions = await this.tools.sessions_list.run({ limit: Number(limit || 20) }, context);
          const memory = query ? await this.tools.memory_search.run({ query }, context) : null;
          return {
            query: query || "",
            sessions,
            memory,
            message: "Full transcript FTS is a next upgrade; this returns session list plus memory search now.",
          };
        },
      },
      clarify: {
        description: "Hermes-compatible clarify placeholder. The assistant should ask the user directly.",
        permission: null,
        group: "hermes-planning",
        run: async ({ question, options } = {}) => ({
          needsUserInput: true,
          question: question || "Please clarify the request.",
          options: Array.isArray(options) ? options : [],
          message: "Clarify is represented as a tool result; the chat layer can ask this question directly.",
        }),
      },
      mixture_of_agents: {
        description: "Hermes-compatible multi-agent reasoning placeholder backed by OmniClaw subagents.",
        permission: "allowShellPlanning",
        group: "hermes-planning",
        run: async ({ task } = {}, context) => ({
          ok: false,
          availableSubagents: await this.tools.subagents.run({}, context),
          task: task || "",
          message: "Mixture-of-agents is cataloged. Use delegate_task/subagents for concrete routed work until full MoA orchestration is built.",
        }),
      },
      computer_use: {
        description: "Hermes-compatible computer-use status backed by OmniClaw laptop access, browser, and terminal tools.",
        permission: null,
        group: "hermes-computer",
        run: async () => this.tools.computer_access_status.run(),
      },
      ha_list_entities: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_list_entities", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      ha_get_state: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_get_state", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      ha_list_services: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_list_services", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      ha_call_service: {
        description: "Hermes-compatible Home Assistant placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-homeassistant",
        run: async () => this.hermesToolNotReady("ha_call_service", "Home Assistant connector is not configured in OmniClaw yet."),
      },
      nodes: {
        description: "Discover paired/trusted nodes and local host bindings.",
        permission: null,
        group: "runtime",
        run: async () => ({
          localNode: {
            id: "local-windows-host",
            role: "gateway",
            status: "online",
          },
          trust: this.agentRuntime?.trust?.getOverview?.() || {},
          devices: this.agentRuntime?.trust?.listDevices?.() || [],
        }),
      },
      canvas: {
        description: "Canvas compatibility status. Full node canvas eval/snapshot is not yet enabled.",
        permission: null,
        group: "ui",
        run: async () => ({
          ready: false,
          message: "Canvas tool surface is registered for OpenClaw compatibility; full canvas runtime is a next upgrade.",
        }),
      },
      cron: {
        description: "List schedules and background jobs.",
        permission: null,
        group: "runtime",
        run: async ({ limit }) => ({
          schedules: this.agentRuntime?.schedules?.listSchedules?.(Number(limit || 50)) || [],
          jobs: this.agentRuntime?.jobs?.listJobs?.(Number(limit || 50)) || [],
        }),
      },
      cronjob: {
        description: "Hermes-compatible cron job listing/status alias.",
        permission: null,
        group: "hermes-runtime",
        run: async (input = {}) => this.tools.cron.run(input),
      },
      kanban_show: {
        description: "Hermes-compatible kanban placeholder.",
        permission: null,
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_show", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_list: {
        description: "Hermes-compatible kanban placeholder.",
        permission: null,
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_list", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_complete: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_complete", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_block: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_block", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_heartbeat: {
        description: "Hermes-compatible kanban placeholder.",
        permission: null,
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_heartbeat", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_comment: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_comment", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_create: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_create", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_link: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_link", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      kanban_unblock: {
        description: "Hermes-compatible kanban placeholder.",
        permission: "allowTaskWrite",
        group: "hermes-kanban",
        run: async () => this.hermesToolNotReady("kanban_unblock", "Kanban orchestration board is not wired into OmniClaw yet."),
      },
      gateway: {
        description: "Inspect OmniClaw gateway overview, events, runs, approvals, and provider status.",
        permission: null,
        group: "runtime",
        run: async ({ limit }) => {
          const gateway = this.agentRuntime?.gateway;
          return {
            overview: gateway?.getOverview?.() || {},
            events: gateway?.listEvents?.(Number(limit || 20)) || [],
            runs: gateway?.listRuns?.(Number(limit || 20)) || [],
            approvals: gateway?.listApprovals?.("") || [],
            provider: this.agentRuntime?.getProviderInfo?.() || {},
          };
        },
      },
      image: {
        description: "Image analysis compatibility tool backed by attachment media analysis when configured.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async (input) => this.tools.analyze_attachment_media.run(input),
      },
      image_generate: {
        description: "Generate a real image from a text prompt (configured image provider, or the free keyless fallback). Saves under workspace/media and returns path + previewUrl.",
        permission: "allowConnectorWrite",
        group: "media",
        examples: [
          { input: { prompt: "neon cyberpunk city at night, rain, cinematic" }, description: "Generate a 1024x768 image" },
        ],
        run: async ({ prompt, width, height, seed } = {}) => {
          if (!this.agentRuntime?.mediaEngine) throw new Error("Media engine is unavailable in this runtime.");
          return this.agentRuntime.mediaEngine.generateImage({ prompt, width, height, seed });
        },
      },
      describe_image: {
        description: "SEE an image: a vision backend describes any image file (screenshot, generated image, photo) as text — works even when the active model cannot see images.",
        permission: null,
        group: "media",
        examples: [
          { input: { path: "data/browser-screenshots/shot.png", question: "Is the layout broken?" }, description: "Describe a screenshot" },
        ],
        run: async ({ path: imagePath, base64, mime, question } = {}) => {
          if (!this.agentRuntime?.mediaEngine) throw new Error("Media engine is unavailable in this runtime.");
          return this.agentRuntime.mediaEngine.describeImage({ path: imagePath, base64, mime, question });
        },
      },
      vision_analyze: {
        description: "Hermes-compatible image analysis alias (describe_image for paths, attachment analysis otherwise).",
        permission: "allowConnectorWrite",
        group: "hermes-media",
        run: async (input = {}) => {
          if (input.path || input.base64) return this.tools.describe_image.run(input);
          return input.extractId || input.cacheId
            ? this.tools.image.run(input)
            : this.tools.analyze_pending_media_attachments.run({ limit: input.limit || 5, force: input.force });
        },
      },
      video_analyze: {
        description: "Hermes-compatible video analysis alias.",
        permission: "allowConnectorWrite",
        group: "hermes-media",
        run: async (input = {}) => this.tools.analyze_pending_media_attachments.run({ ...input, limit: input.limit || 5 }),
      },
      text_to_speech: {
        description: "Hermes-compatible text-to-speech placeholder.",
        permission: "allowConnectorWrite",
        group: "hermes-media",
        run: async ({ text, voice } = {}) => ({
          ok: false,
          configured: false,
          textPreview: String(text || "").slice(0, 180),
          voice: voice || "",
          message: "Text-to-speech tool is cataloged from Hermes, but OmniClaw needs a TTS provider plugin before audio can be generated.",
        }),
      },
      music_generate: {
        description: "Music generation compatibility placeholder. Requires adding a music provider plugin.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async ({ prompt }) => this.mediaNotConfigured("music_generate", prompt),
      },
      video_generate: {
        description: "Generate a video from a text prompt: scene keyframe images assembled with ffmpeg into an mp4 (or an autoplaying HTML slideshow when ffmpeg is missing). Saves under workspace/media.",
        permission: "allowConnectorWrite",
        group: "media",
        examples: [
          { input: { prompt: "sunrise over Haryana fields, cinematic", seconds: 8 }, description: "8-second generated video" },
        ],
        run: async ({ prompt, seconds, width, height, frames } = {}) => {
          if (!this.agentRuntime?.mediaEngine) throw new Error("Media engine is unavailable in this runtime.");
          return this.agentRuntime.mediaEngine.generateVideo({ prompt, seconds, width, height, frames });
        },
      },
      tts: {
        description: "Text-to-speech compatibility placeholder. Requires adding a TTS provider plugin.",
        permission: "allowConnectorWrite",
        group: "media",
        run: async ({ text }) => this.mediaNotConfigured("tts", text),
      },
      delegate_task: {
        description: "Delegate ONE self-contained subtask to an isolated sub-agent (own context+loop: files, shell, web, browser). REQUIRED: task — full standalone spec with exact chat-root-relative paths, acceptance criteria, and what NOT to touch (the child sees NOTHING else). OPTIONAL: tools, model, provider, timeoutMs, systemPrompt. Model+endpoint resolve as ONE binding: omit both to inherit the parent's full binding (endpoint AND model — the default); an explicit model is validated on its endpoint before spawn and falls down the ladder (fallback → parent → local) on failure. Returns a bounded report {status:completed|incomplete|failed, done, notDone, filesTouched, transcriptPath} — incomplete is NOT success, re-plan or retry. Multiple delegate_task calls in ONE turn fan out in parallel. Example: {\"task\":\"In web-next/js/ui/thread.js add a context-meter div; verify with npm run build. Do NOT touch provider keys.\"}.",
        permission: "allowTaskWrite",
        group: "delegation",
        schema: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", description: "REQUIRED. Standalone spec: goal + exact file paths + acceptance check + boundaries. Min 20 chars. The child cannot see this chat." },
            tools: { type: "array", items: { type: "string" }, description: "OPTIONAL. Tool ids for the child. Omit = file/shell/web/browser core set." },
            model: { type: "string", description: "OPTIONAL. Model id for the child. Omit = inherit the parent binding. An explicit id is validated on its endpoint first; invalid ids fail immediately naming valid alternatives." },
            provider: { type: "string", description: "OPTIONAL. Provider profile id (Settings → providers) for the child. Omit = configured sub-agent provider, else the parent endpoint. The endpoint always travels with the model." },
            timeoutMs: { type: "number", description: "OPTIONAL. Child timeout ms (default 300000, min 30000)." },
            systemPrompt: { type: "string", description: "OPTIONAL. Extra system instructions for the child." },
            // ── AGENT-TO-AGENT HANDOFF (leave all three unset for a sub-agent) ──
            targetAgentId: { type: "string", description: "OPTIONAL. Hand the task to ANOTHER agent by id (default \"main\"). Supplying this (or `prompt`) switches delegate_task from sub-agent spawn to an agent handoff. The tool returns IMMEDIATELY with {delegationId,status:\"queued\"}; the card in the chat tracks it live. Cannot target yourself; max 3 open tasks; max depth 3." },
            title: { type: "string", description: "OPTIONAL. Short label for the handed-off task. Shown on the card and in the target session name." },
            prompt: { type: "string", description: "OPTIONAL. The task for the other agent, in full (it sees only this). Use this INSTEAD of `task` for an agent handoff. Max 8000 chars." },
          },
        },
        run: async ({ task, tools, model, provider, timeoutMs, systemPrompt, targetAgentId, title, prompt } = {}, context) => {
          // ── AGENT-TO-AGENT mode ─────────────────────────────────────────
          // When the caller names a TARGET AGENT (or supplies `prompt`), this is
          // no longer a sub-agent spawn: it hands a task to another agent that
          // runs in its own session, through the same global run gate. The tool
          // still RETURNS IMMEDIATELY with {delegationId, status:"queued"} -
          // awaiting the child would deadlock against the source run when
          // maxConcurrentRuns is 1.
          const wantsAgentHandoff = Boolean(targetAgentId || prompt);
          if (wantsAgentHandoff) {
            return this.agentRuntime?.delegateTask?.({
              // `main` is the ONE shipped OmniClaw coding agent, so it is the
              // default target.
              targetAgentId: targetAgentId || "main",
              title: title || String(task || prompt || "").slice(0, 120),
              prompt: String(prompt || task || ""),
              parentSessionId: context.sessionId || "",
              parentRunId: context.runId || "",
              // Depth comes from the context, so a delegated run that delegates
              // again is capped exactly like the first one.
              depth: Number(context.delegationDepth) || 0,
              parentDelegationId: String(context.delegationId || ""),
              source: "model",
            }) || { error: "Delegation bridge unavailable." };
          }
          if (!this.subAgentSpawner) {
            throw new Error("Sub-agent spawner is not available.");
          }
          return this.subAgentSpawner.spawn({
            task: String(task || "").trim(),
            parentAgentId: this.getAgentId(context),
            tools: Array.isArray(tools) ? tools : [],
            model: String(model || "").trim(),
            provider: String(provider || "").trim(),
            timeoutMs: Number(timeoutMs) || 0,
            systemPrompt: String(systemPrompt || "").trim(),
            context,
          });
        },
      },
      best_of_n: {
        description: "Build the SAME deliverable N times in parallel (isolated sub-agents, candidate-N folders), verify each, keep the winner. For build-from-scratch work only — never for edits to existing files.",
        permission: "allowTaskWrite",
        group: "delegation",
        schema: {
          type: "object",
          required: ["task", "outputDir", "entryFile"],
          properties: {
            task: { type: "string", description: "Self-contained build task — each candidate independently builds the SAME deliverable from this spec." },
            outputDir: { type: "string", description: "Project-relative folder for candidates (created if missing)." },
            entryFile: { type: "string", description: "Main artifact each candidate must produce, relative to its candidate folder (e.g. index.html or app.js). Drives scoring." },
            n: { type: "number", description: "Candidate count, 2-3 (default 2)." },
            verifyCommand: { type: "string", description: "Optional check command; {dir} is replaced with the candidate folder path; exit 0 = pass (worth the most points)." },
            timeoutMs: { type: "number", description: "Per-candidate timeout ms (default 300000)." },
          },
        },
        run: async (input = {}, context = {}) => this.runBestOfN(input, context),
      },
      evaluate_work: {
        description: "Get an INDEPENDENT, nitpicky review of work from a separate reviewer agent (worker != checker). The same model self-evaluating is systematically overconfident; this spawns a fresh sub-agent tuned to be critical, with read-only + exec tools, to check whether the work actually meets the requirement end-to-end. Use before declaring a non-trivial or subjective task done.",
        permission: "allowTaskWrite",
        group: "verification",
        schema: {
          type: "object",
          required: ["requirement"],
          properties: {
            requirement: { type: "string", description: "What the work was SUPPOSED to achieve (the acceptance criteria)." },
            workSummary: { type: "string", description: "What was done / which files+paths to inspect." },
            verification: { type: "string", description: "Optional command the reviewer should run to check it actually works." },
          },
        },
        run: async ({ requirement, workSummary, verification } = {}, context) => {
          if (!this.subAgentSpawner) {
            return { ok: false, error: "Sub-agent spawner unavailable; evaluate_work needs it." };
          }
          const req = String(requirement || "").trim();
          if (!req) {
            return { ok: false, error: "requirement is required (what the work must achieve)." };
          }
          const task = [
            "You are an INDEPENDENT, skeptical code reviewer. You did NOT write this code. Your job is to find what is incomplete, broken, or unverified — be nitpicky, not generous. Do NOT talk yourself out of a real issue.",
            "",
            `Requirement (acceptance criteria): ${req}`,
            workSummary ? `Claimed work: ${String(workSummary).slice(0, 1500)}` : "",
            verification ? `Run this to check it actually works: ${verification}` : "",
            "",
            "Steps: inspect the actual files (read_file/list_files/search_text), and if a verification command is given, RUN it with exec. Do not trust claims — verify against real files and real execution.",
            "",
            "Score each dimension A/B/C/D with specific evidence (cite file:line or command output):",
            "- Functionality: does the required behavior actually work end-to-end? (A=fully, D=doesn't run)",
            "- Correctness: tests/verification pass? (A=all pass, D=build/verify fails)",
            "- Architecture/scope: stays within the requirement, no out-of-scope changes, follows conventions.",
            "- Completeness: edge cases + error paths handled, not just the happy path / presentational stubs.",
            "",
            "VERDICT: PASS only if Functionality and Correctness are A/B AND (if a command was given) it ran successfully. Otherwise FAIL with the dimension scores, the concrete list of what is missing/broken, and the exact next fix.",
          ].filter(Boolean).join("\n");
          try {
            const result = await this.subAgentSpawner.spawn({
              task,
              parentAgentId: this.getAgentId(context),
              tools: ["read_file", "list_files", "search_text", "exec", "grep_files"],
              systemPrompt: "You are a rigorous, independent QA reviewer. Be specific and skeptical. Never rubber-stamp. Prefer running the verification over reasoning about it.",
              // Use a separate reviewer model when configured (worker != checker
              // AND ideally worker-model != checker-model, to resist self-bias).
              // Falls back to the cheap compaction model: review is not
              // user-facing work and must never bill the main model by default.
              model: String(this.configStore.getConfig()?.provider?.reviewerModel || this.configStore.getConfig()?.provider?.compactionModel || "").trim(),
              context,
            });
            return {
              ok: true,
              independent: true,
              requirement: req,
              review: result.result || result.error || "",
              durationMs: result.durationMs,
              toolCallCount: result.toolCallCount,
            };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        },
      },
      provider_keys: {
        description: "List which provider API keys are configured (MASKED — never full keys), the active provider/model, and the sub-agent model config. Use when rate-limited to see what you can switch to (then list_provider_models + switch_model).",
        permission: null,
        group: "provider",
        run: async () => {
          const info = this.agentRuntime?.getProviderInfo?.() || {};
          const config = this.configStore.getConfig();
          const keys = this.agentRuntime?.secrets?.getAllStatuses?.() || [];
          const profiles = config.providerProfiles || {};
          return {
            activeProvider: { id: info.id || config.provider?.apiKeyProviderId || "", model: info.model || config.provider?.model || "", ready: info.ready !== false },
            compactionModel: config.provider?.compactionModel || "(none — main model used)",
            subAgents: {
              model: config.runtime?.subAgents?.model || "(same as main)",
              fallbackModel: config.runtime?.subAgents?.fallbackModel || config.provider?.compactionModel || "(none)",
              maxConcurrent: config.runtime?.subAgents?.maxConcurrent || 3,
              maxPerHour: config.runtime?.subAgents?.maxPerHour || 30,
            },
            configuredKeys: keys, // [{providerId, configured, masked}]
            availableProfiles: Object.keys(profiles).map((id) => ({ id, baseUrl: profiles[id].baseUrl || "", keyProvider: profiles[id].apiKeyProviderId || id, defaultModel: profiles[id].model || "" })),
            hint: "Rate-limited? Pick a model on the SAME provider with switch_model {model, scope}. scope: 'main' (your model), 'subagents' (all sub-agents), 'compaction' (summaries). Different provider needs the user to apply a profile in Settings.",
          };
        },
      },
      switch_model: {
        description: "Switch the active model at runtime (same provider/key). scope 'main' = the primary agent model, 'subagents' = default model for all sub-agents, 'compaction' = cheap model for summaries/learning. Use after a rate limit or to put research sub-agents on a cheaper model. Verify the model id first via list_provider_models.",
        permission: "allowConfigWrite",
        group: "provider",
        schema: {
          type: "object",
          required: ["model"],
          properties: {
            model: { type: "string", description: "Exact model id the provider accepts (e.g. from list_provider_models)." },
            scope: { type: "string", description: "'main' (default), 'subagents', or 'compaction'." },
          },
        },
        run: async ({ model, scope } = {}) => {
          const target = String(model || "").trim();
          if (!target) return { ok: false, error: "model is required." };
          const normalizedScope = String(scope || "main").toLowerCase();
          const before = this.configStore.getConfig();
          if (normalizedScope === "subagents") {
            this.configStore.updateUserConfig({ runtime: { subAgents: { model: target } } });
          } else if (normalizedScope === "compaction") {
            this.configStore.updateUserConfig({ provider: { compactionModel: target } });
          } else {
            this.configStore.updateUserConfig({ provider: { model: target } });
          }
          this.agentRuntime?.gateway?.addEvent?.("provider.model_switched", {
            scope: normalizedScope,
            model: target,
            message: `model switched (${normalizedScope}): ${target}`,
          });
          return {
            ok: true,
            scope: normalizedScope,
            model: target,
            previous: normalizedScope === "subagents" ? (before.runtime?.subAgents?.model || "") : normalizedScope === "compaction" ? (before.provider?.compactionModel || "") : (before.provider?.model || ""),
            note: normalizedScope === "main" ? "New rounds/runs use this model on the same provider+key." : "Applies to the next spawn/summary.",
          };
        },
      },
      subagents: {
        description: "List active and recently completed sub-agents (with limits + models), or cancel a running sub-agent.",
        permission: null,
        group: "delegation",
        run: async ({ action, agentId } = {}) => {
          if (!this.subAgentSpawner) {
            throw new Error("Sub-agent spawner is not available.");
          }
          const normalizedAction = String(action || "").toLowerCase();
          if (normalizedAction === "cancel" && agentId) {
            return this.subAgentSpawner.cancel(String(agentId).trim());
          }
          if (normalizedAction === "history") {
            return { history: this.subAgentSpawner.getHistory(20) };
          }
          return {
            ...this.subAgentSpawner.getStatus(),
            activeDelegations: this.agentRuntime?.gateway?.listDelegations?.({ limit: 20 }) || [],
            contract: "Use sessions_spawn/delegate_task once, then sessions_yield. Avoid repeated polling.",
          };
        },
      },
    };
    Object.assign(this.tools, createManusToolsExtension(this.agentRuntime || this));
  }

  // D2: minimal REAL capability probe for one (endpoint, model): reachability,
  // id validity, native tool-calling, and parallel tool calls. Persists to the
  // model registry (retired ids excluded from pickers + ladder afterwards).
  async testProviderModel({ profileId = "", baseUrl = "", model = "", timeoutMs = 0 } = {}) {
    const id = String(model || "").trim();
    if (!id) return { ok: false, code: "EINVAL", error: "model is required." };
    const pid = String(profileId || "").trim();
    const base = String(baseUrl || "").trim();
    if (!pid && !base) return { ok: false, code: "EINVAL", error: "profileId or baseUrl is required." };
    const ms = Math.max(5000, Math.min(60000, Number(timeoutMs) || 15000));
    const rootDir = this.agentRuntime?.rootDir || process.cwd();
    let provider = null;
    let effectiveBase = "";
    try {
      if (pid) {
        provider = getProvider(this.configStore, this.agentRuntime?.secrets, pid);
        if (!provider) {
          return { ok: false, code: "EUNREACHABLE", model: id, profileId: pid, error: `Profile "${pid}" is unknown or has no usable key.` };
        }
        effectiveBase = String(provider.getInfo?.()?.baseUrl || "");
      } else {
        const cfg = this.configStore.getConfig();
        const tempStore = { getConfig: () => ({ ...cfg, provider: { ...cfg.provider, mode: "openai-compatible", baseUrl: base, model: id } }) };
        provider = new OpenAICompatibleProvider(tempStore, this.agentRuntime?.secrets);
        effectiveBase = base;
      }
    } catch (error) {
      return { ok: false, code: "EUNREACHABLE", model: id, error: String(error?.message || error).slice(0, 300) };
    }
    // Step 1: reachability + id validity via /models (short race — the
    // provider's own 45s timeout is too long for a Test button).
    let listedIds = null;
    try {
      const listed = await Promise.race([
        (async () => {
          try { return await provider.listModels(); }
          catch (error) { return { ok: false, error: String(error?.message || error) }; }
        })(),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "model list timed out after 10s", timedOut: true }), 10000)),
      ]);
      const raw = listed && (Array.isArray(listed) ? listed : (listed.models || listed.data || []));
      if (listed && listed.ok !== false && Array.isArray(raw)) listedIds = raw.map((m) => String(m?.id || m?.name || m || "").trim()).filter(Boolean);
      else if (listed && listed.ok === false) {
        recordModelTest(rootDir, { baseUrl: effectiveBase, model: id, ok: false, status: statusFromReason("timeout"), error: String(listed.error || "list failed").slice(0, 200) });
        return { ok: false, code: "EUNREACHABLE", model: id, endpoint: effectiveBase, reachable: false, error: String(listed.error || "endpoint unreachable").slice(0, 300) };
      }
    } catch (error) {
      return { ok: false, code: "EUNREACHABLE", model: id, endpoint: effectiveBase, reachable: false, error: String(error?.message || error).slice(0, 300) };
    }
    if (listedIds && !listedIds.includes(id)) {
      recordModelTest(rootDir, { baseUrl: effectiveBase, model: id, ok: false, status: "unknown", error: "id not on endpoint list" });
      return { ok: false, code: "ENOTFOUND", model: id, endpoint: effectiveBase, reachable: true, error: `Model "${id}" is not on this endpoint's /models list.`, listed: listedIds.slice(0, 12) };
    }
    // Step 2: capability probe — one tiny completion forcing tool use and
    // inviting two parallel calls.
    const pingTool = {
      type: "function",
      function: {
        name: "ping_probe",
        description: "Reply marker for capability probing.",
        parameters: { type: "object", required: ["n"], properties: { n: { type: "string" } } },
      },
    };
    try {
      const res = await provider.completeWithTools(
        [{ role: "user", content: "Call ping_probe twice: once with n=\"one\", once with n=\"two\". Reply with calls only." }],
        { tools: [pingTool], toolChoice: "required", maxTokens: 64, temperature: 0, timeoutMs: ms, model: id },
      );
      const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
      const toolCalling = calls.length > 0;
      const parallel = calls.length >= 2;
      recordModelTest(rootDir, { baseUrl: effectiveBase, model: id, ok: true, toolCalling, parallel, status: "ok" });
      return {
        ok: true, model: id, endpoint: effectiveBase, reachable: true,
        toolCalling, parallel, toolCalls: calls.length,
        note: toolCalling
          ? (parallel ? "Native tool calls work; parallel calls observed." : "Native tool calls work; only a single call observed (parallel unconfirmed).")
          : "No tool call returned — model answered in text (tool-calling unsupported or refused).",
      };
    } catch (error) {
      const classified = classifyProviderError(error);
      if (classified.isModelGone) {
        markModelRetired(rootDir, effectiveBase, id, String(error?.message || "").slice(0, 200));
      } else {
        recordModelTest(rootDir, { baseUrl: effectiveBase, model: id, ok: false, status: statusFromReason(classified.reason), error: String(error?.message || "").slice(0, 200) });
      }
      return {
        ok: false,
        code: classified.reason === "model_retired" ? "ERETIRED" : "EPROBEFAIL",
        model: id, endpoint: effectiveBase, reachable: true,
        toolCalling: null, parallel: null,
        reason: classified.reason,
        error: (classified.userMessage || String(error?.message || error)).slice(0, 400),
      };
    }
  }

  getRunPlan(runId) {
    return this.runPlans.get(String(runId || "").trim()) || null;
  }

  getSessionPlan(sessionId) {
    return this.sessionPlans.get(String(sessionId || "").trim()) || null;
  }

  // Used by the loop to seed a new run with the session's inherited plan.
  setRunPlan(runId, plan) {
    const id = String(runId || "").trim();
    if (!id || !plan || !Array.isArray(plan.steps)) return;
    this.runPlans.set(id, plan);
    if (this.runPlans.size > 50) {
      this.runPlans.delete(this.runPlans.keys().next().value);
    }
  }

  // Session-scoped plan: the resumable unit. update_plan mirrors here on
  // every write and the budget handoff tops it up, so a "continue" in a new
  // run (or after a restart, via the run.resume transcript event) resumes
  // completed work instead of redoing it. Bounded like runPlans.
  setSessionPlan(sessionId, plan) {
    const id = String(sessionId || "").trim();
    if (!id || !plan || !Array.isArray(plan.steps)) return;
    this.sessionPlans.set(id, plan);
    if (this.sessionPlans.size > 50) {
      this.sessionPlans.delete(this.sessionPlans.keys().next().value);
    }
  }

  // T2.2: toolsets enabled mid-run (enable_toolset tool + session pins merge
  // in the menu builder). Bounded like runPlans.
  getRunToolsets(runId) {
    return [...(this.runToolsets.get(String(runId || "").trim()) || [])];
  }

  enableRunToolset(runId, name) {
    const id = String(runId || "").trim();
    const toolset = String(name || "").trim();
    if (!id || !toolset) return [];
    const set = this.runToolsets.get(id) || new Set();
    set.add(toolset);
    this.runToolsets.set(id, set);
    if (this.runToolsets.size > 50) {
      this.runToolsets.delete(this.runToolsets.keys().next().value);
    }
    return [...set];
  }

  // Progressive disclosure: session-pinned toolsets (load_toolset tool).
  // Read by the menu builder alongside run toolsets and session pins.
  getSessionToolsets(sessionId) {
    return [...(this.sessionToolsets.get(String(sessionId || "").trim()) || [])];
  }

  enableSessionToolset(sessionId, name) {
    const id = String(sessionId || "").trim();
    const toolset = String(name || "").trim();
    if (!id || !toolset) return [];
    const set = this.sessionToolsets.get(id) || new Set();
    set.add(toolset);
    this.sessionToolsets.set(id, set);
    if (this.sessionToolsets.size > 100) {
      this.sessionToolsets.delete(this.sessionToolsets.keys().next().value);
    }
    return [...set];
  }

  getAgentId(context = {}) {
    const normalized = normalizeContext(context);
    const requestedAgentId = String(normalized.agentId || "").trim();
    if (!this.agentRegistry) {
      return requestedAgentId || "main";
    }
    return this.agentRegistry.resolveAgent(requestedAgentId).id;
  }

  getComputerAccessPolicy() {
    const config = this.configStore.getConfig();
    const policy = config.tools?.computerAccess || {};
    return {
      enabled: policy.enabled !== false,
      allowedRoots: Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0 ? policy.allowedRoots : ["~"],
      blockedPathPatterns: Array.isArray(policy.blockedPathPatterns)
        ? policy.blockedPathPatterns
        : [
            "^[A-Z]:/$",
            "^[A-Z]:/Windows(?:/|$)",
            "^[A-Z]:/Program Files(?:/|$)",
            "^[A-Z]:/Program Files \\(x86\\)(?:/|$)",
            "^[A-Z]:/ProgramData(?:/|$)",
          ],
      allowWrite: policy.allowWrite !== false,
      allowDelete: policy.allowDelete !== false,
      allowPermanentDelete: Boolean(policy.allowPermanentDelete),
      trashDir: policy.trashDir || "data/trash",
    };
  }

  requireComputerAccessPolicy() {
    const policy = this.getComputerAccessPolicy();
    if (!policy.enabled) {
      throw new Error("Computer access is disabled by runtime policy.");
    }
    return policy;
  }

  recordComputerAccessOperation(action, result = {}, context = {}) {
    const gateway = this.agentRuntime?.gateway;
    if (!gateway?.addEvent) {
      return null;
    }
    const targetPath = result.path || result.source || "";
    const destinationPath = result.destination || result.movedTo || "";
    const workspaceAgentIds = targetPath && this.agentRegistry?.resolveAgentIdsByWorkspacePath
      ? this.agentRegistry.resolveAgentIdsByWorkspacePath(targetPath)
      : [];
    const destinationWorkspaceAgentIds = destinationPath && this.agentRegistry?.resolveAgentIdsByWorkspacePath
      ? this.agentRegistry.resolveAgentIdsByWorkspacePath(destinationPath)
      : [];
    return gateway.addEvent("computer.access_operation", {
      action,
      agentId: this.getAgentId(context),
      runId: context.runId || "",
      sessionId: context.sessionId || "",
      path: targetPath,
      destination: destinationPath,
      type: result.type || "",
      bytes: result.bytes ?? result.bytesRead ?? result.bytesWritten ?? 0,
      permanent: Boolean(result.permanent),
      overwritten: Boolean(result.overwritten),
      workspaceAgentIds,
      destinationWorkspaceAgentIds,
      ok: !result.error,
    });
  }

  getComputerAccessAudit(limit = 25) {
    const gateway = this.agentRuntime?.gateway;
    const count = Math.max(1, Math.min(100, Number(limit || 25)));
    return (gateway?.listEvents?.(200) || [])
      .filter((event) => event.event === "computer.access_operation")
      .slice(0, count)
      .map((event) => ({
        id: event.id,
        at: event.at,
        seq: event.seq,
        ...event.payload,
      }));
  }

  requireShellExecutor() {
    if (!this.shellExecutor) {
      throw new Error("Shell executor is not available in this OmniClaw runtime.");
    }
    return this.shellExecutor;
  }

  requireAcpManager() {
    if (!this.acpManager) {
      throw new Error("ACP manager is not available in this OmniClaw runtime.");
    }
    return this.acpManager;
  }

  requireCodingHarness() {
    if (!this.codingHarness) {
      throw new Error("Coding agent harness is not available in this OmniClaw runtime.");
    }
    return this.codingHarness;
  }

  requireBrowserPlaywright() {
    if (!this.browser) {
      throw new Error("Playwright browser automation is not available in this OmniClaw runtime.");
    }
    return this.browser;
  }

  // Audits the project's harness across the lecture's five subsystems and
  // returns a per-subsystem score (0-5) plus concrete gap suggestions.
  runHarnessDoctor() {
    const rootDir = this.agentRuntime?.rootDir || process.cwd();
    const has = (rel) => {
      try { return fs.existsSync(path.join(rootDir, rel)); } catch { return false; }
    };
    const subsystems = [];

    // 1. Instructions — present AND lean (entry file is a router, 50-200 lines,
    // with links to topic docs). Flag bloat: a giant entry file buries critical
    // rules "in the middle" and eats context budget.
    const instrFiles = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CONVENTIONS.md", ".cursorrules"].filter(has);
    const readRootEarly = (rel) => {
      try { const p = path.join(rootDir, rel); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; } catch { return ""; }
    };
    const bloatWarnings = [];
    let entryHasLinks = false;
    for (const name of instrFiles) {
      const doc = readRootEarly(name);
      const lineCount = doc ? doc.split("\n").length : 0;
      if (lineCount > 200) {
        bloatWarnings.push(`${name} is ${lineCount} lines — an entry file should be a ~50-200 line router. Split topic detail into docs/ and link to it on demand.`);
      }
      if (/\]\(([^)]*\.md)\)/.test(doc) || /docs\//.test(doc) || /topic docs/i.test(doc)) entryHasLinks = true;
    }
    let instrScore = instrFiles.length ? 5 : 1;
    if (bloatWarnings.length) instrScore = Math.min(instrScore, 3);
    subsystems.push({
      subsystem: "instructions",
      score: instrScore,
      present: instrFiles,
      bloatWarnings,
      hasTopicDocLinks: entryHasLinks,
      suggestion: instrFiles.length
        ? (bloatWarnings.length
            ? bloatWarnings[0]
            : (entryHasLinks ? "" : "Entry file is lean. As it grows, link out to docs/ topic files instead of inlining detail."))
        : "Add an AGENTS.md (~100 lines): project overview, tech stack + versions, first-run commands, hard constraints, and a verification section.",
    });

    // 2. Tools (OmniClaw always exposes a rich tool surface)
    const toolCount = Object.keys(this.tools || {}).length;
    subsystems.push({
      subsystem: "tools",
      score: toolCount >= 20 ? 5 : 3,
      detail: `${toolCount} runtime tools available (files, shell, grep, git, browser, web, memory).`,
      suggestion: "",
    });

    // 3. Environment (self-describing deps + version pins)
    const lockfiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "pyproject.toml", "requirements.txt", "Cargo.lock", "go.sum"].filter(has);
    const versionPins = [".nvmrc", ".python-version", ".tool-versions", "Dockerfile", ".devcontainer"].filter(has);
    const envScore = (lockfiles.length ? 3 : 0) + (versionPins.length ? 2 : 0);
    subsystems.push({
      subsystem: "environment",
      score: Math.max(1, envScore),
      lockfiles,
      versionPins,
      suggestion: envScore >= 4 ? "" : "Lock dependencies (package.json/pyproject) and pin runtime versions (.nvmrc/.python-version) so the environment is reproducible.",
    });

    // 4. State (cross-session continuity): progress + decision log
    const hasProgress = has("PROGRESS.md");
    const hasDecisions = has("DECISIONS.md");
    const statePresent = [hasProgress && "PROGRESS.md", hasDecisions && "DECISIONS.md"].filter(Boolean);
    const stateScore = (hasProgress ? 3 : 1) + (hasDecisions ? 2 : 0);
    subsystems.push({
      subsystem: "state",
      score: stateScore,
      present: statePresent,
      suggestion: hasProgress && hasDecisions
        ? ""
        : !hasProgress
          ? "For long/multi-session work, keep a PROGRESS.md (use update_progress) so the next session resumes instead of re-exploring."
          : "Add a DECISIONS.md (use log_decision) to preserve the 'why' behind choices — compaction and new sessions lose it otherwise.",
    });

    // 5. Feedback (discoverable verification commands)
    let verification = { commands: [] };
    try { verification = this.fileStore.discoverProjectVerification(); } catch { /* best effort */ }
    subsystems.push({
      subsystem: "feedback",
      score: verification.commands.length ? 5 : 1,
      verificationCommands: verification.commands,
      suggestion: verification.commands.length ? "" : "Add explicit verification commands (test/lint/build) to AGENTS.md and package.json scripts — this is the highest-ROI subsystem.",
    });

    const total = subsystems.reduce((sum, s) => sum + s.score, 0);
    const weakest = subsystems.slice().sort((a, b) => a.score - b.score)[0];

    // Fresh Session Test: can a brand-new session answer the 5 repo questions
    // from files alone (the lecture's core diagnostic)?
    const readRoot = (rel) => {
      try {
        const p = path.join(rootDir, rel);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      } catch { return ""; }
    };
    const firstPresent = (names) => names.find(has) || "";
    const q = [];
    const whatDoc = firstPresent(["AGENTS.md", "CLAUDE.md", "README.md"]);
    q.push({ question: "What is this system?", answerable: Boolean(whatDoc), source: whatDoc || "(add README.md or AGENTS.md overview)" });
    const orgDoc = firstPresent(["ARCHITECTURE.md", "AGENTS.md", "docs"]) || (has("src") ? "src/ (module layout)" : "");
    q.push({ question: "How is it organized?", answerable: Boolean(orgDoc), source: orgDoc || "(add ARCHITECTURE.md or document the module layout)" });
    const runHas = Boolean(readRoot("Makefile")) || /"scripts"\s*:/.test(readRoot("package.json")) || has("init.sh");
    q.push({ question: "How do I run it?", answerable: runHas, source: runHas ? (has("Makefile") ? "Makefile" : "package.json scripts") : "(add run commands to AGENTS.md / package.json)" });
    q.push({ question: "How do I verify it?", answerable: verification.commands.length > 0, source: verification.commands.length ? verification.commands.map((c) => c.command).join(", ") : "(add verification commands)" });
    q.push({ question: "Where are we now?", answerable: hasProgress, source: hasProgress ? "PROGRESS.md" : "(add PROGRESS.md via update_progress, or rely on git log)" });
    const answered = q.filter((item) => item.answerable).length;

    // Knowledge decay: docs referencing files that no longer exist (the lecture's
    // "biggest enemy" — stale docs send the agent the wrong way).
    const decayWarnings = [];
    for (const docName of instrFiles.concat(has("ARCHITECTURE.md") ? ["ARCHITECTURE.md"] : [])) {
      const doc = readRoot(docName);
      if (!doc) continue;
      const refs = doc.match(/`([\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|go|rs|json|md))`/g) || [];
      let missing = 0;
      const missingExamples = [];
      for (const ref of refs.slice(0, 60)) {
        const clean = ref.replace(/`/g, "");
        // Only flag explicit relative paths (with a separator). Bare filenames
        // are too ambiguous to resolve and cause false positives.
        if (clean.includes("/") && !has(clean)) {
          missing += 1;
          if (missingExamples.length < 4) missingExamples.push(clean);
        }
      }
      if (missing > 0) {
        decayWarnings.push({ doc: docName, missingRefs: missing, examples: missingExamples });
      }
    }

    // Initialization / "ready to hand off" verdict (lecture 06): the 4
    // conditions a fresh session needs to take over without asking a human.
    const hasTasks = has("TASKS.md") || has("TASK_BREAKDOWN.md");
    const canStart = runHas;
    const canTest = verification.commands.length > 0;
    const canSeeProgress = hasProgress;
    const canPickUpNext = hasProgress || hasTasks;
    const initialization = {
      canStart,
      canTest,
      canSeeProgress,
      canPickUpNext,
      hasStartupChecklist: has("STARTUP.md"),
      hasTaskBreakdown: hasTasks,
      readyToHandOff: canStart && canTest && canSeeProgress && canPickUpNext,
      recommendation: (canStart && canTest && canSeeProgress && canPickUpNext)
        ? "Repo is initialized and ready for a fresh session to take over."
        : "Run init_project: this repo is missing " + [
            !canStart && "run commands",
            !canTest && "verifiable tests",
            !canSeeProgress && "a PROGRESS.md",
            !canPickUpNext && "a task breakdown",
          ].filter(Boolean).join(", ") + " — do a dedicated initialization pass before feature work.",
    };

    return {
      ok: true,
      rootDir,
      overallScore: total,
      maxScore: subsystems.length * 5,
      subsystems,
      weakestSubsystem: weakest.subsystem,
      topRecommendation: weakest.suggestion || "Harness looks healthy. Keep AGENTS.md and PROGRESS.md current as the project evolves.",
      freshSessionTest: { answered, total: q.length, questions: q, passes: answered === q.length },
      knowledgeDecay: { stale: decayWarnings.length > 0, warnings: decayWarnings },
      initialization,
    };
  }

  // Dedicated initialization phase (lecture 06): scaffold the startup-readiness
  // artifacts a fresh session needs, without clobbering anything the user wrote.
  runInitProject(context) {
    const config = this.configStore.getConfig();
    const writableRoots = config.tools?.filesystem?.writableRoots || ["."];
    const doctor = this.runHarnessDoctor(context);
    const verification = (() => {
      try { return this.fileStore.discoverProjectVerification(); } catch { return { commands: [] }; }
    })();
    const structure = (() => {
      try {
        return this.fileStore.listDirectory(".").filter((e) => e.type === "directory" && !e.name.startsWith(".") && !["node_modules", "dist", "data", "logs"].includes(e.name));
      } catch { return []; }
    })();

    const created = [];
    const existing = [];
    const write = (name, body) => {
      if (this.fileStore.readText && this.fileExists(name)) {
        existing.push(name);
        return;
      }
      try {
        this.fileStore.writeText(name, body, { allowedRoots: writableRoots, append: false });
        created.push(name);
      } catch {
        // leave it; report below
      }
    };

    const verifyLines = verification.commands.length
      ? verification.commands.map((c) => `- ${c.name}: \`${c.command}\``).join("\n")
      : "- (none detected — add a test/build script and list it here)";
    const structureLines = structure.length
      ? structure.map((d) => `- \`${d.name}/\``).join("\n")
      : "- (top-level directories not detected)";

    write("STARTUP.md", [
      "# Startup Readiness Checklist",
      "",
      "How a fresh agent session takes over this repo without asking a human.",
      "",
      "## Start / Verify Commands",
      verifyLines,
      "",
      "## Current State",
      `- Deps locked: ${doctor.subsystems.find((s) => s.subsystem === "environment")?.lockfiles?.length ? "yes" : "unknown — add a lockfile"}`,
      `- Verifiable tests: ${verification.commands.length ? "yes" : "no — configure a test framework + 1 passing example test"}`,
      `- Progress tracked: ${doctor.initialization.canSeeProgress ? "yes (PROGRESS.md)" : "no — use update_progress"}`,
      "",
      "## Project Structure",
      structureLines,
      "",
      "## Clock in / Clock out",
      "- Clock in: read this file + PROGRESS.md + DECISIONS.md; confirm tests pass.",
      "- Clock out: update_progress, log_decision for non-obvious choices, git_commit a checkpoint.",
      "",
    ].join("\n") + "\n");

    write("TASKS.md", [
      "# Task Breakdown",
      "",
      "Ordered tasks, each with a command-verifiable acceptance criterion. Fill these in for THIS project's goal (initialization scaffolds the shape; you fill the content).",
      "",
      "## Task 1: <name>",
      "- <what to build>",
      "- Acceptance: <test/command that must pass>",
      "",
      "## Task 2: <name>",
      "- ...",
      "- Acceptance: ...",
      "",
    ].join("\n") + "\n");

    const init = doctor.initialization;
    const nextSteps = [
      !init.canStart && "Add run commands (package.json scripts / Makefile) and list them in STARTUP.md.",
      !init.canTest && "Configure a test framework and make at least ONE example test pass.",
      "Fill TASKS.md with the real ordered task breakdown for this project's goal.",
      !init.canSeeProgress && "Call update_progress to create PROGRESS.md.",
      "git_commit a clean initialization checkpoint once the above hold.",
    ].filter(Boolean);

    return {
      ok: true,
      phase: "initialization",
      created,
      existing,
      detectedCommands: verification.commands,
      structure: structure.map((d) => d.name),
      readiness: init,
      nextSteps,
      note: "Initialization is separate from implementation. Complete these, commit a checkpoint, THEN start feature work.",
    };
  }

  fileExists(relativePath) {
    try {
      return fs.existsSync(path.join(this.agentRuntime?.rootDir || process.cwd(), relativePath));
    } catch {
      return false;
    }
  }

  // Runs the repo's architectural boundary rules (arch_rules.json) by grepping
  // scoped files for each forbidden pattern. Violations carry the fix message.
  runBoundaryChecks() {
    const { exists, rules } = this.fileStore.readArchRules();
    if (!exists || rules.length === 0) {
      return { ok: true, hasRules: false, violations: [], passed: true, message: "No arch_rules.json — no boundary rules to enforce (add_check to create some)." };
    }
    const violations = [];
    for (const rule of rules) {
      const pattern = String(rule?.forbidden || "").trim();
      if (!pattern) continue;
      let res;
      try {
        res = this.fileStore.searchText(pattern, { glob: rule.glob || "", maxResults: 50 });
      } catch (error) {
        violations.push({ ruleId: rule.id, error: `rule scan failed: ${error.message}` });
        continue;
      }
      for (const m of (res.matches || [])) {
        violations.push({
          ruleId: rule.id || "",
          description: rule.description || "",
          file: m.file,
          line: m.line,
          text: m.text,
          fix: rule.fix || "(no fix message — update the rule with add_check)",
        });
      }
    }
    return {
      ok: true,
      hasRules: true,
      ruleCount: rules.length,
      passed: violations.length === 0,
      violationCount: violations.length,
      violations: violations.slice(0, 50),
      message: violations.length === 0
        ? `All ${rules.length} architectural boundary rule(s) passed.`
        : `${violations.length} boundary violation(s). Fix each per its 'fix' instruction before declaring done.`,
    };
  }

  // Lecture-12 end-of-session clean-state check: the 5 conditions a clean
  // handoff requires. Composes verify_done (build/tests), progress + startup
  // discovery, and the stale-artifact scan.
  async runSessionHandoff(input = {}, context = {}) {
    // 1+2: build + tests via the termination check (static + runtime layers).
    const term = await this.runTerminationCheck({ static: input.static, tests: input.tests, e2e: [], cwd: input.cwd }, context);
    const buildPassed = !(term.failedLayer === "L1-static");
    const testsPassed = !(term.failedLayer === "L2-runtime") && term.done; // term.done requires runtime ran + passed
    // 3: progress recorded.
    const progress = this.fileStore.readProgress();
    const progressRecorded = progress.exists;
    // 4: no stale artifacts.
    const stale = this.fileStore.scanStaleArtifacts();
    // 5: startup path exists (a run/build/test command is discoverable).
    let verification = { commands: [] };
    try { verification = this.fileStore.discoverProjectVerification(); } catch { /* best effort */ }
    let hasStart = verification.commands.length > 0;
    try {
      const pkgRaw = this.fileStore.readText("package.json", 20000).content;
      const scripts = JSON.parse(pkgRaw).scripts || {};
      if (scripts.start || scripts.dev) hasStart = true;
    } catch { /* no package.json */ }

    const conditions = {
      buildPasses: buildPassed,
      testsPass: testsPassed,
      progressRecorded,
      noStaleArtifacts: stale.clean,
      startupPathExists: hasStart,
    };
    const failed = Object.entries(conditions).filter(([, v]) => !v).map(([k]) => k);
    const cleanHandoff = failed.length === 0;

    this.agentRuntime?.gateway?.addEvent?.("session_handoff.checked", { cleanHandoff, failed });
    const fixes = [];
    if (!buildPassed) fixes.push(`Build fails: ${term.message}`);
    if (buildPassed && !testsPassed) fixes.push(`Tests not green: ${term.message}`);
    if (!progressRecorded) fixes.push("No PROGRESS.md — call update_progress to record done/in-progress/next.");
    if (!stale.clean) fixes.push(`Stale artifacts: ${stale.debugMarkerCount} debug marker(s), ${stale.tempFileCount} temp file(s) — remove them.`);
    if (!hasStart) fixes.push("No startup/run command discoverable — add one (package.json scripts / Makefile).");

    return {
      ok: true,
      cleanHandoff,
      conditions,
      failedConditions: failed,
      staleArtifacts: stale.clean ? undefined : { debugMarkers: stale.debugMarkers, tempFiles: stale.tempFiles },
      message: cleanHandoff
        ? "Clean handoff: build + tests green, progress recorded, no stale artifacts, startup path available. Safe to end the session."
        : `NOT a clean handoff — fix before exit: ${fixes.join(" | ")}`,
    };
  }

  // Lecture-09 three-layer termination check. Runs static -> runtime -> e2e in
  // order, stops at the first failing layer, and returns actionable feedback.
  async runTerminationCheck(input = {}, context = {}) {
    const executor = this.shellExecutor || this.agentRuntime?.shellExecutor;
    if (!executor?.execute) {
      return { ok: false, error: "Shell executor unavailable; verify_done needs it." };
    }
    const cwd = String(input.cwd || "").trim();
    // Auto-discover and bucket the project's commands by layer when not given.
    let discovered = { commands: [] };
    try { discovered = this.fileStore.discoverProjectVerification(); } catch { /* best effort */ }
    const isStatic = (c) => /\b(build|lint|eslint|tsc|typecheck|type-check|mypy|ruff|check)\b/i.test(`${c.name} ${c.command}`);
    const isTest = (c) => /\b(test|tests|pytest|jest|vitest|mocha|go test|cargo test)\b/i.test(`${c.name} ${c.command}`);
    // An explicit array (even empty) is honored as-is — empty means "skip this
    // layer". Only auto-discover when the caller omits the layer entirely.
    const pick = (explicit, predicate) => {
      if (Array.isArray(explicit)) return explicit.map(String);
      return discovered.commands.filter(predicate).map((c) => c.command);
    };
    const layers = [
      { layer: "L1-static", label: "syntax / static (build, lint, typecheck)", commands: pick(input.static, isStatic) },
      { layer: "L2-runtime", label: "runtime (tests, startup checks)", commands: pick(input.tests, isTest) },
      { layer: "L3-e2e", label: "end-to-end / full user flow", commands: Array.isArray(input.e2e) ? input.e2e.map(String) : [] },
    ];

    const runCmd = async (command) => {
      try {
        const r = await executor.execute({ command, cwd, timeoutMs: 180000, runId: context?.runId || "", sessionId: context?.sessionId || "" });
        return { command, ok: r.status === "completed" && r.exitCode === 0, exitCode: r.exitCode ?? null, stdout: String(r.stdout || "").slice(0, 500), stderr: String(r.stderr || "").slice(0, 600) };
      } catch (error) {
        return { command, ok: false, exitCode: null, stderr: String(error.message).slice(0, 600) };
      }
    };

    const results = [];
    let ranAnyRuntime = false;

    // L1 begins with architectural boundary rules (lecture 10): a static,
    // mechanical check that runs before build/lint. A violation stops here.
    const boundary = this.runBoundaryChecks();
    if (boundary.hasRules && !boundary.passed) {
      this.agentRuntime?.gateway?.addEvent?.("termination_check.failed", { layer: "L1-static", reason: "boundary-violation" });
      return {
        ok: true,
        done: false,
        failedLayer: "L1-static",
        boundary,
        results: [{ layer: "L1-static", label: "architectural boundary rules", violations: boundary.violations }],
        message: `Not done: ${boundary.violationCount} architectural boundary violation(s) (L1). Fix each per its 'fix' instruction before anything else: ${boundary.violations.slice(0, 3).map((v) => `${v.file}:${v.line} — ${v.fix}`).join(" | ")}`,
      };
    }

    for (const L of layers) {
      if (L.commands.length === 0) {
        results.push({ layer: L.layer, label: L.label, skipped: true, reason: "no command (provide one for a real check)" });
        continue;
      }
      const layerResults = [];
      for (const command of L.commands) {
        const r = await runCmd(command);
        layerResults.push(r);
        if (L.layer === "L2-runtime") ranAnyRuntime = true;
        if (!r.ok) {
          this.agentRuntime?.gateway?.addEvent?.("termination_check.failed", { layer: L.layer, command, exitCode: r.exitCode });
          return {
            ok: true,
            done: false,
            failedLayer: L.layer,
            failedCommand: command,
            results: [...results, { layer: L.layer, label: L.label, commands: layerResults }],
            message: `Not done: ${L.layer} (${L.label}) FAILED on \`${command}\` (exit ${r.exitCode}). Fix this before going further — do NOT run later layers or claim done. Error: ${(r.stderr || r.stdout || "").slice(0, 300)}`,
          };
        }
      }
      results.push({ layer: L.layer, label: L.label, commands: layerResults });
    }

    const e2eProvided = layers[2].commands.length > 0;
    const done = ranAnyRuntime; // must have at least run tests/runtime to be "done"
    this.agentRuntime?.gateway?.addEvent?.("termination_check.passed", { done, e2eProvided, ranAnyRuntime });
    return {
      ok: true,
      done,
      results,
      e2eProvided,
      message: done
        ? (e2eProvided
            ? "All three layers passed — task is verifiably done."
            : "Static + runtime layers passed. No end-to-end (L3) command was given, so the full user flow is UNVERIFIED — provide an e2e command for a complete done.")
        : "No runtime/test command ran. Static checks alone are NOT 'done' — add and run tests (L2) before declaring completion.",
    };
  }

  // Runs a read-only git command through the shell executor and parses stdout.
  async runGitCommand(args, cwd, context, parse) {
    const executor = this.shellExecutor || this.agentRuntime?.shellExecutor;
    if (!executor?.execute) {
      return { ok: false, error: "Shell executor is unavailable; git tools need it." };
    }
    // Per-chat bind: git runs inside the chat's own project folder. An
    // explicit cwd outside it fails closed instead of silently operating on
    // another repo (e.g. the server repo while a user project is selected).
    const gate = this.chatCwd(cwd, context);
    if (!gate.ok) {
      return { ok: false, error: gate.error };
    }
    let result;
    try {
      result = await executor.execute({
        command: `git ${args}`,
        cwd: gate.cwd,
        timeoutMs: 20000,
        runId: context?.runId || "",
        sessionId: context?.sessionId || "",
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const ok = result.status === "completed" && (result.exitCode === 0 || result.exitCode == null);
    if (!ok) {
      const stderr = String(result.stderr || result.stdout || "").trim();
      return {
        ok: false,
        error: /not a git repository/i.test(stderr) ? "Not a git repository (run `git init` first)." : (stderr.slice(0, 600) || `git ${args} failed`),
        exitCode: result.exitCode,
      };
    }
    try {
      return { ok: true, ...parse(result.stdout) };
    } catch (error) {
      return { ok: false, error: `Failed to parse git output: ${error.message}` };
    }
  }

  async runBrowserOperation(action, fn, context = {}) {
    const startedAt = Date.now();
    const config = this.configStore.getConfig();
    const browserControl = config.tools?.browserControl || {};
    // A flat 30s budget punished the one action that legitimately needs longer:
    // the FIRST open has to launch (and sometimes fetch) Chromium, which blows
    // past 30s on a cold Windows box — the real "Browser operation timed out
    // after 30000ms: browser_open" in the event log. Once a session exists every
    // other action is fast, so only the launch-capable ones get the long budget.
    const isLaunchAction = BROWSER_LAUNCH_ACTIONS.has(action);
    const configured = isLaunchAction
      ? browserControl.launchTimeoutMs || browserControl.timeoutMs || 90000
      : browserControl.timeoutMs || 30000;
    const timeoutMs = Math.max(1000, Math.min(180000, Number(configured)));
    let result;
    try {
      result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Browser operation timed out after ${timeoutMs}ms: ${action}`)), timeoutMs)),
      ]);
      this.recordBrowserOperation(action, result, context, Date.now() - startedAt);
      return result;
    } catch (error) {
      const failed = {
        ok: false,
        action,
        error: error.message,
      };
      this.recordBrowserOperation(action, failed, context, Date.now() - startedAt);
      throw error;
    }
  }

  recordBrowserOperation(action, result = {}, context = {}, durationMs = 0) {
    const gateway = this.agentRuntime?.gateway;
    if (!gateway?.addEvent) {
      return null;
    }
    const snapshot = result.snapshot || {};
    return gateway.addEvent("browser.operation", {
      action,
      agentId: this.getAgentId(context),
      runId: context.runId || "",
      sessionId: context.sessionId || "",
      ok: result.error ? false : Boolean(result.ok ?? result.opened ?? (result.status ? result.status === "success" : true)),
      url: result.url || snapshot.url || "",
      title: result.title || snapshot.title || "",
      screenshotPath: result.screenshot?.path || "",
      linkCount: Array.isArray(result.links) ? result.links.length : Array.isArray(snapshot.links) ? snapshot.links.length : 0,
      controlCount: Array.isArray(snapshot.controls) ? snapshot.controls.length : 0,
      durationMs,
      error: result.error || "",
    });
  }

  getBrowserAudit(limit = 25) {
    const gateway = this.agentRuntime?.gateway;
    const count = Math.max(1, Math.min(100, Number(limit || 25)));
    return (gateway?.listEvents?.(200) || [])
      .filter((event) => event.event === "browser.operation")
      .slice(0, count)
      .map((event) => ({
        id: event.id,
        at: event.at,
        seq: event.seq,
        ...event.payload,
      }));
  }

  inferTaskType(input = {}) {
    const text = `${input.title || ""} ${input.objective || ""} ${input.sourceMessage || ""}`.toLowerCase();
    if (/research|search|study|compare|analyse|analyze/.test(text)) return "research";
    if (/build|code|implement|app|website|feature|fix|debug/.test(text)) return "build";
    if (/browser|form|fill|login|website|open/.test(text)) return "browser";
    if (/schedule|daily|hourly|weekly|every|24\s*hours|monitor|watch/.test(text)) return "automation";
    if (/file|folder|download|document|pdf/.test(text)) return "file";
    return "general";
  }

  buildTaskPlan(input = {}) {
    const type = this.inferTaskType(input);
    const base = [
      "Understand the user's goal, constraints, and success criteria.",
      "Inspect available local context, memory, files, tools, and provider status.",
    ];
    const byType = {
      research: [
        "Run web research and fetch/read primary pages where possible.",
        "Compare sources, extract evidence, and cite source URLs.",
      ],
      build: [
        "Read the relevant code/files before editing.",
        "Implement the smallest useful working slice.",
        "Run build/tests or static verification and report proof.",
      ],
      browser: [
        "Open or inspect the target browser page.",
        "Fill forms/click controls only when the user has authorized the action.",
        "Capture screenshot/snapshot proof after the browser action.",
      ],
      automation: [
        "Convert the request into a persisted schedule or background job plan.",
        "Record delivery channel, interval, retry policy, and stop condition.",
      ],
      file: [
        "Locate/read the target file or folder through governed access.",
        "Write/copy/move only inside allowed roots, then read/list back to verify.",
      ],
      general: [
        "Choose the safest relevant tool sequence.",
        "Execute, observe, and summarize results with proof.",
      ],
    };
    return [...base, ...(byType[type] || byType.general)];
  }

  buildTaskToolPlan(input = {}) {
    const type = this.inferTaskType(input);
    const toolsByType = {
      research: ["web_research", "web_fetch", "memory_search"],
      build: ["read_file", "write_file", "verify_html_artifact", "run_terminal_command"],
      browser: ["open_browser_url", "browser_snapshot", "browser_click", "browser_type"],
      automation: ["cron", "create_task", "send_message"],
      file: ["search_computer_files", "read_computer_file", "write_computer_file", "list_computer_directory"],
      general: ["provider_status", "computer_access_status", "web_research"],
    };
    return toolsByType[type] || toolsByType.general;
  }

  buildTaskAcceptanceCriteria(input = {}) {
    const type = this.inferTaskType(input);
    const common = [
      "Every claimed action must be backed by a tool output, file proof, browser proof, or provider diagnostic.",
      "If a tool/provider is unavailable, report the blocker and next fix instead of pretending success.",
    ];
    const byType = {
      research: ["Final answer includes source URLs or fetched-content evidence."],
      build: ["Created/edited artifacts are verified with read-back, build/test, or artifact verification."],
      browser: ["Browser state after the action is captured with snapshot/screenshot metadata."],
      automation: ["Schedule/job is persisted with next run time and retry policy."],
      file: ["File operations include read/list-back proof."],
      general: ["Result includes clear completion status and remaining risks."],
    };
    return [...common, ...(byType[type] || byType.general)];
  }

  // Claude Code-style command approvals: when tools.shellExecution.approvalMode
  // is "always", every shell command pauses, raises an approval card in the
  // chat UI (approval.requested event), and waits for Allow/Deny. Default
  // "auto" keeps today's behavior (no pause).
  async awaitShellApproval(command, context = {}, tool = "") {
    const config = this.configStore.getConfig();
    const mode = String(config.tools?.shellExecution?.approvalMode || "auto").toLowerCase();
    if (mode !== "always") return null;
    const gateway = this.agentRuntime?.gateway;
    if (!gateway?.createApproval) return null;
    const approval = gateway.createApproval({
      type: "shell-exec",
      tool: tool || context.tool || "",
      // M3: stamp WHO asked, at creation. Fallback chain: the tool context's
      // agent is authoritative; the run's own agentId is the fallback for older
      // contexts that only carry the run.
      agentId: this.getAgentId(context) || String(context.runAgentId || "") || null,
      sessionId: context.sessionId || "",
      runId: context.runId || "",
      summary: `Run command: ${String(command).slice(0, 200)}`,
      payload: { command: String(command).slice(0, 500) },
    });
    const deadline = Date.now() + APPROVAL_TOOL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const current = gateway.getApproval?.(approval.id)
        || (gateway.listApprovals?.() || []).find((item) => item.id === approval.id);
      if (current && current.status !== "pending") {
        if (current.status === "approved") return { approved: true, approvalId: approval.id };
        return {
          blocked: true,
          approvalId: approval.id,
          reason: `User ${current.status} this command${current.note ? ` ("${current.note}")` : ""}. Respect the decision — do not retry the same command; adjust the approach or ask.`,
        };
      }
      if (context.runId && this.agentRuntime?.cancelledRuns?.has(context.runId)) {
        return { blocked: true, approvalId: approval.id, reason: "Run was cancelled while waiting for command approval." };
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return { blocked: true, approvalId: approval.id, reason: "Command approval timed out after 5 minutes — the user did not respond. Pick a safer path or ask_user." };
  }

  // Every forged tool gets a companion SKILL.md so the MAIN agent rediscovers
  // it by topic in future sessions (skill matching), not only when a run
  // happens to remember the tool exists. Guarded/curated like any agent skill.
  writeToolSkill(built, context = {}) {
    const skills = this.agentRuntime?.skills;
    if (!skills?.createSkill) return "";
    const name = built.name;
    const skillName = `tool-${name}`;
    const inputKeys = Object.keys(built.manifest?.schema?.properties || {});
    const exampleInput = built.manifest?.tests?.find?.((test) => test && test.input)?.input || {};
    const content = [
      `# ${name} (self-built tool)`,
      "",
      `The agent built the tool **\`${name}\`** in the forge. It is a real, model-callable tool — call it by name like any built-in.`,
      "",
      "## What it does",
      built.description || built.manifest?.description || name,
      "",
      "## How to use",
      `Call the tool \`${name}\`${inputKeys.length ? ` with input fields: ${inputKeys.map((key) => `\`${key}\``).join(", ")}.` : " (no required input)."}`,
      Object.keys(exampleInput).length ? `\nExample input:\n\n\`\`\`json\n${JSON.stringify(exampleInput, null, 2)}\n\`\`\`` : "",
      "",
      "## Note",
      "If the tool misbehaves, rebuild it with build_tool (same name overwrites) or run test_tool to inspect its output.",
    ].join("\n");
    const created = skills.createSkill(skillName, {
      scope: "global",
      description: `Use the self-built tool "${name}": ${String(built.description || built.manifest?.description || "").slice(0, 120)}`,
      content,
      triggers: [name, ...inputKeys].slice(0, 6),
      tags: ["self-built-tool", "forge"],
    });
    // Provenance-mark so the weekly curator can manage it like any agent skill.
    try { this.agentRuntime?.omniLoop?.recordSkillCreated?.(skillName); } catch { /* best-effort */ }
    return created?.name || skillName;
  }

  getProductToolMetadata(id, tool = {}) {
    const limited = LIMITED_PRODUCT_TOOLS[id];
    if (!limited) {
      return {
        runtimeStatus: "ready",
        productReady: true,
        modelCallable: true,
        replacement: "",
        readinessReason: "Backend is wired.",
      };
    }
    return {
      runtimeStatus: limited.status,
      productReady: false,
      modelCallable: false,
      replacement: limited.replacement || "",
      readinessReason: limited.reason || "Backend is not production-ready yet.",
    };
  }

  // MCP tools from connected external servers (Composio, etc.). They are
  // first-class, model-callable tools — exposed with `mcp_<server>_<tool>` ids
  // and their JSON-Schema mapped to `schema` so buildToolSchemas picks it up.
  getMcpTools() {
    const mcpTools = this.agentRuntime?.mcp?.getAllTools?.() || [];
    return mcpTools.map((tool) => ({
      id: tool.id,
      description: tool.description || `MCP tool ${tool.name} from ${tool.mcpServer}`,
      permission: null,
      group: `mcp:${tool.mcpServer}`,
      schema: tool.inputSchema || { type: "object", properties: {}, additionalProperties: true },
      runtimeStatus: "mcp",
      productReady: true,
      modelCallable: true,
      replacement: "",
      mcpServer: tool.mcpServer,
      mcpToolName: tool.mcpToolName,
    }));
  }

  getAll(context = {}) {
    const normalized = normalizeContext(context);
    const permissions = this.configStore?.getConfig?.()?.tools?.permissions || {};
    const tools = [
      ...Object.entries(this.tools).map(([id, tool]) => ({
        id,
        description: tool.description,
        permission: tool.permission,
        group: tool.group || "",
        schema: tool.schema || tool.inputSchema || null,
        ...this.getProductToolMetadata(id, tool),
      })),
      ...this.getMcpTools(),
      // Self-built (forged) tools — passed their own tests at build time,
      // re-guard-scanned at every load, fully model-callable.
      ...[...this.customTools.values()].map((tool) => ({
        id: tool.name,
        description: `${tool.description} (self-built tool)`,
        permission: null,
        group: "forge:custom",
        schema: tool.schema || { type: "object", properties: {}, additionalProperties: true },
        runtimeStatus: "custom",
        productReady: true,
        modelCallable: true,
        replacement: "",
        readinessReason: "Agent-built tool; passed its self-tests in the forge sandbox.",
      })),
      ...this.pluginRegistry.getToolDefinitions().map((tool) => ({
        ...tool,
        runtimeStatus: "plugin",
        productReady: true,
        // A plugin tool earns model-callability the same way a forged tool
        // does: by being real. mode === "code" means the plugin's entry module
        // loaded and the call will actually execute. A template-only tool just
        // echoes a canned manifest string — precisely the fake-tool shape the
        // Codex-grade contract exists to keep away from the model — so those
        // stay operator-only.
        modelCallable: tool.mode === "code",
        replacement: "",
        readinessReason:
          tool.mode === "code"
            ? "Plugin tool backed by a loaded entry module."
            : "Declarative plugin tool renders a manifest template only; hidden from the LLM.",
      })),
    ].filter((tool) => {
      if (!(normalized.productMode || normalized.modelCallableOnly)) {
        return true;
      }
      if (tool.modelCallable === false) {
        return false;
      }
      if (normalized.modelCallableOnly) {
        if (tool.permission && permissions[tool.permission] === false) {
          return false;
        }
        // MCP tools from connected servers (Composio, etc.) carry dynamic ids
        // (mcp_<server>_<tool>) that can't be enumerated in a static allowlist,
        // so admit them by prefix — connecting a server is the opt-in.
        if (tool.runtimeStatus === "mcp" || String(tool.id || "").startsWith("mcp_")) {
          return true;
        }
        // Forged tools earn model-callability by passing their self-tests —
        // the dynamic equivalent of the static Codex-grade allowlist.
        if (tool.runtimeStatus === "custom") {
          return true;
        }
        // Installed plugins carry author-chosen tool ids that no static
        // allowlist can enumerate. Enabling a plugin whose entry module loads
        // is the opt-in; `modelCallable` above already excluded the
        // template-only ones.
        if (tool.runtimeStatus === "plugin") {
          return true;
        }
        return CODEX_GRADE_MODEL_TOOLS.has(tool.id);
      }
      return true;
    });

    if (normalized.includeAllAgents || !this.agentRegistry) {
      return tools;
    }

    return this.agentRegistry.filterTools(tools, this.getAgentId(normalized));
  }

  getToolDefinition(id) {
    if (this.tools[id]) {
      return {
        id,
        description: this.tools[id].description,
        permission: this.tools[id].permission,
        schema: this.tools[id].schema || this.tools[id].inputSchema || null,
      };
    }

    // Self-built (forged) tools.
    if (this.customTools.has(id)) {
      const custom = this.customTools.get(id);
      return {
        id,
        description: `${custom.description} (self-built tool)`,
        permission: null,
        schema: custom.schema || null,
        isCustom: true,
      };
    }

    if (String(id || "").startsWith("mcp_")) {
      const mcpTool = (this.agentRuntime?.mcp?.getAllTools?.() || []).find((tool) => tool.id === id);
      if (mcpTool) {
        return {
          id,
          description: mcpTool.description || "",
          permission: null,
          schema: mcpTool.inputSchema || null,
          isMcp: true,
          mcpServer: mcpTool.mcpServer,
          mcpToolName: mcpTool.mcpToolName,
        };
      }
    }

    return this.pluginRegistry.getToolDefinitions().find((tool) => tool.id === id) || null;
  }

  has(id, context = {}) {
    return this.getAll(context).some((tool) => tool.id === id);
  }

  // Snapshot an existing file before a write, into the SAME per-run checkpoint
  // store omni-loop uses — so writes made INSIDE a code_act script are just as
  // rewindable via restore_checkpoint as normal tool-loop writes.
  // Snapshot a file before an in-script (code_act) write, into the SAME per-run
  // checkpoint store the main loop and sub-agents use. Delegates to the shared
  // primitive so all three write paths share one implementation (no drift — the
  // previous hand-rolled copy here could diverge from file-checkpoint.js).
  saveCheckpointForPath(filePath, tool, runId) {
    saveSharedFileCheckpoint({
      rootDir: this.getRootDir(),
      runId,
      filePath,
      tool: String(tool || "code_act"),
    });
  }

  // ── CodeAct executor ───────────────────────────────────────────────────────
  // Runs ONE model-written JS script that composes many tool calls (loops,
  // conditions, variables) in a bare vm context. Every tool call inside the
  // script goes through registry.run(), so permissions, path policy, audit,
  // and secret redaction all apply exactly as they do for individual calls.
  async runCodeAct(script, timeoutMs, context = {}) {
    const source = String(script || "").trim();
    if (!source) {
      return { error: true, message: "script is required." };
    }
    // Composition-only surface: tools the script may call. code_act itself and
    // long-running/interactive tools are deliberately excluded (no recursion,
    // no runaway spawns from inside a script).
    const CODE_ACT_TOOLS = [
      "read_file", "write_file", "edit", "multi_edit", "append_file", "apply_patch",
      "list_files", "search_text", "create_directory",
      "exec", "run_terminal_command",
      "read_computer_file", "write_computer_file", "list_computer_directory", "search_computer_files",
      "web_fetch", "web_search", "read_url",
      "git_status", "git_diff", "git_log",
      "memory_search", "memory_write",
    ];
    const MAX_CALLS = 40;
    const wall = Math.max(5000, Math.min(120000, Number(timeoutMs || 60000)));
    const startedAt = Date.now();
    const callLog = [];
    const logs = [];
    const WRITE_TOOLS = new Set(["write_file", "edit", "multi_edit", "append_file", "apply_patch", "write_computer_file"]);
    const toolsApi = {};
    for (const toolId of CODE_ACT_TOOLS) {
      toolsApi[toolId] = async (input = {}) => {
        if (callLog.length >= MAX_CALLS) {
          throw new Error(`code_act tool budget exceeded (${MAX_CALLS} calls). Return your partial result instead.`);
        }
        if (Date.now() - startedAt > wall) {
          throw new Error("code_act wall-clock budget exhausted mid-script.");
        }
        const safeInput = input && typeof input === "object" ? input : {};
        // In-script writes get the same rewind snapshots as loop writes.
        if (WRITE_TOOLS.has(toolId) && safeInput.path) {
          this.saveCheckpointForPath(String(safeInput.path), toolId, context.runId);
        }
        const output = await this.run(toolId, safeInput, { ...context, source: "code_act" });
        callLog.push({ tool: toolId, ok: !(output && (output.error || output.blocked)) });
        return output;
      };
    }
    const sandbox = {
      tools: Object.freeze(toolsApi),
      console: {
        log: (...args) => {
          const line = args.slice(0, 4).map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ").slice(0, 600);
          logs.push(line);
          if (logs.length > 120) logs.shift();
        },
      },
      JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Map, Set, Promise, Error,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    };
    let compiled;
    try {
      compiled = new vm.Script(`(async () => {\n${source}\n})()`, { filename: "code_act.js" });
    } catch (err) {
      return { error: true, message: `code_act script has a syntax error: ${err.message}`, logs };
    }
    const vmContext = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    let result;
    let wallTimer = null;
    try {
      // vm timeout guards the SYNC portions; the Promise.race guards awaits.
      const pending = compiled.runInContext(vmContext, { timeout: 15000 });
      result = await Promise.race([
        Promise.resolve(pending),
        // Timer is cleared in finally so a fast-finishing script does not leave
        // a live timeout hanging on the event loop for up to `wall` ms — under
        // heavy code_act use in the long-running gateway those accumulate.
        new Promise((_, reject) => { wallTimer = setTimeout(() => reject(new Error(`code_act wall-clock timeout after ${wall}ms — split the work into smaller scripts.`)), wall); }),
      ]);
    } catch (err) {
      return {
        error: true,
        message: `code_act failed: ${String(err?.message || err).slice(0, 500)}`,
        logs,
        toolCallsMade: callLog,
        toolCallCount: callLog.length,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (wallTimer) clearTimeout(wallTimer);
    }
    // Keep the returned value JSON-safe and bounded.
    let safeResult = result;
    try {
      safeResult = JSON.parse(JSON.stringify(result === undefined ? null : result));
    } catch {
      safeResult = String(result).slice(0, 8000);
    }
    if (typeof safeResult === "string" && safeResult.length > 8000) safeResult = safeResult.slice(0, 8000);
    return {
      ok: true,
      result: safeResult,
      logs,
      toolCallsMade: callLog,
      toolCallCount: callLog.length,
      durationMs: Date.now() - startedAt,
    };
  }

  // ── Best-of-N executor ─────────────────────────────────────────────────────
  // Spawns N independent sub-agents on the SAME build spec, each in its own
  // candidate folder, scores every candidate deterministically (artifact
  // exists / has substance / verify command passes), and copies the winner to
  // <outputDir>/best. Parallel exploration beats a single weak-model attempt.
  async runBestOfN(input = {}, context = {}) {
    if (!this.subAgentSpawner) {
      return { error: true, message: "Sub-agent spawner is not available — best_of_n needs it." };
    }
    const task = String(input.task || "").trim();
    const outputDir = String(input.outputDir || "").trim().replace(/^[\\/]+/, "");
    const entryFile = String(input.entryFile || "").trim().replace(/^[\\/]+/, "");
    if (!task || !outputDir || !entryFile) {
      return { error: true, message: "task, outputDir, and entryFile are all required." };
    }
    if (path.isAbsolute(outputDir) || outputDir.includes("..")) {
      return { error: true, message: "outputDir must be a project-relative path without '..'." };
    }
    const n = Math.max(2, Math.min(3, Number(input.n || 2)));
    const timeoutMs = Math.max(60000, Math.min(600000, Number(input.timeoutMs || 300000)));
    const rootDir = this.getRootDir();
    const startedAt = Date.now();

    const candidates = Array.from({ length: n }, (_, i) => {
      const dir = `${outputDir}/candidate-${i + 1}`;
      return { index: i + 1, dir, absDir: path.join(rootDir, dir) };
    });
    const spawnResults = await Promise.allSettled(candidates.map((candidate) =>
      this.subAgentSpawner.spawn({
        task: [
          task,
          "",
          `BUILD LOCATION (hard requirement): create EVERYTHING inside the folder "${candidate.dir}" (create it first). Do not write outside it.`,
          `The main artifact MUST be "${candidate.dir}/${entryFile}". The deliverable is judged on that file actually working.`,
          "You are one of several independent attempts — build the best version you can, completely, then stop.",
        ].join("\n"),
        parentAgentId: this.getAgentId(context),
        tools: [],
        timeoutMs,
        context,
      }),
    ));

    // Deterministic scoring per candidate.
    const scored = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const spawn = spawnResults[i];
      const score = { candidate: candidate.dir, points: 0, checks: [] };
      const addCheck = (label, ok, points) => {
        score.checks.push({ label, ok });
        if (ok) score.points += points;
      };
      addCheck("sub-agent completed", spawn.status === "fulfilled" && !spawn.value?.error, 1);
      const entryAbs = path.join(candidate.absDir, entryFile);
      let entryBytes = 0;
      try { entryBytes = fs.statSync(entryAbs).size; } catch { /* missing */ }
      addCheck(`entry file ${entryFile} exists`, entryBytes > 0, 3);
      addCheck("entry file has substance (>500 bytes)", entryBytes > 500, 1);
      let fileCount = 0;
      try {
        const walk = (dir, depth = 0) => {
          if (depth > 4 || fileCount > 50) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isFile()) fileCount += 1;
            else if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
          }
        };
        walk(candidate.absDir);
      } catch { /* missing dir */ }
      addCheck("candidate folder has files", fileCount > 0, 1);
      if (/\.html?$/i.test(entryFile) && entryBytes > 0) {
        try {
          const html = fs.readFileSync(entryAbs, "utf8");
          addCheck("html structure valid", /<!doctype html|<html[\s>]/i.test(html) && /<body[\s>]/i.test(html), 1);
          addCheck("html has interactivity/script", /<script\b/i.test(html) || /<(button|input|select|a)\b/i.test(html), 1);
        } catch { /* unreadable */ }
      }
      if (String(input.verifyCommand || "").trim() && entryBytes > 0) {
        try {
          const command = String(input.verifyCommand).replaceAll("{dir}", candidate.absDir);
          const verify = await this.run("run_terminal_command", { command }, { ...context, source: "best_of_n" });
          const passed = verify?.execution?.status === "completed" || verify?.exitCode === 0 || verify?.status === "completed";
          addCheck(`verify command passed`, Boolean(passed), 4);
        } catch {
          addCheck("verify command passed", false, 4);
        }
      }
      scored.push(score);
    }

    scored.sort((a, b) => b.points - a.points);
    const winner = scored[0];
    if (!winner || winner.points <= 0) {
      return {
        error: true,
        message: "No candidate produced a usable artifact — all attempts scored 0. Check the sub-agent outcomes and retry with a clearer spec.",
        candidates: scored,
        durationMs: Date.now() - startedAt,
      };
    }
    const bestDir = `${outputDir}/best`;
    const bestAbs = path.join(rootDir, bestDir);
    try {
      fs.rmSync(bestAbs, { recursive: true, force: true });
      fs.cpSync(path.join(rootDir, winner.candidate), bestAbs, { recursive: true });
    } catch (err) {
      return { error: true, message: `Winner chosen (${winner.candidate}) but copy to ${bestDir} failed: ${err.message}`, candidates: scored };
    }
    this.agentRuntime?.gateway?.addEvent?.("best_of_n.completed", {
      outputDir, n, winner: winner.candidate, points: winner.points,
      message: `best-of-${n}: ${winner.candidate} won with ${winner.points} points → ${bestDir}`,
    });
    return {
      ok: true,
      winner: winner.candidate,
      bestDir,
      entryFile: `${bestDir}/${entryFile}`,
      candidates: scored,
      durationMs: Date.now() - startedAt,
      message: `Best-of-${n} complete: "${winner.candidate}" won (${winner.points} pts). Winner copied to "${bestDir}" — verify ${bestDir}/${entryFile} and present THAT to the user.`,
    };
  }

  async run(id, input = {}, context = {}) {
    // Route common synonyms (mkdir/make_directory/...) and collapsed
    // namespace aliases (read->read_file, ...) to the canonical tool.
    const rawId = String(id || "");
    const routedId = TOOL_NAME_ALIASES[rawId.toLowerCase()] || id;
    if (routedId !== rawId) {
      // Alias telemetry (namespace-rationalization watch): counts how often
      // the model reaches for a hidden alias instead of the canonical name.
      try {
        this.agentRuntime?.gateway?.addEvent?.("tool.runtime.alias_resolved", {
          from: rawId, to: routedId,
          runId: String(context?.runId || ""),
          sessionId: String(context?.sessionId || ""),
          agentId: this.getAgentId(context),
        });
      } catch { /* telemetry must never throw */ }
    }
    id = routedId;
    const normalized = normalizeContext(context);
    const agentId = this.getAgentId(normalized);
    const definition = this.getToolDefinition(id);
    const observationKey = buildObservationKey(id, input, { ...normalized, agentId });

    if (!definition) {
      throw new Error(`Unknown tool: ${id}`);
    }

    // T2.2: operator-only ids fail closed for model/API callers (design D3).
    // Internal operator surfaces (Settings UI, ws-gateway) pass
    // {operator:true}; direct this.tools.X.run multiplexers bypass run().
    if (this.configStore?.getConfig?.()?.tools?.menuV2 === true
      && OPERATOR_IDS.has(id) && !normalized.operator) {
      // Placeholders/partials: single-line explicit error naming the working
      // alternative (or stating none exists) — never a fabricated success and
      // never a misleading "do it in Settings".
      const meta = this.getProductToolMetadata(id, definition);
      const isPlaceholder = Object.hasOwn(PLACEHOLDER_REDIRECT, id) || meta.productReady === false;
      if (isPlaceholder) {
        const alt = Object.hasOwn(PLACEHOLDER_REDIRECT, id) ? PLACEHOLDER_REDIRECT[id] : (meta.replacement || "");
        const reason = alt
          ? `${id} is unavailable (${meta.readinessReason || "not wired into OmniClaw yet"}). Use ${alt} instead.`
          : `${id} is unavailable (${meta.readinessReason || "not wired into OmniClaw yet"}).`;
        try {
          this.agentRuntime?.gateway?.addEvent?.("tool.runtime.placeholder_blocked", {
            tool: id, alternative: alt || "",
            runId: String(context?.runId || normalized?.runId || ""),
            sessionId: String(context?.sessionId || normalized?.sessionId || ""),
            agentId,
          });
        } catch { /* telemetry must never throw */ }
        return { blocked: true, code: "EPLACEHOLDER", tool: id, agentId, reason };
      }
      return {
        blocked: true,
        code: "EOPERATOR",
        tool: id,
        agentId,
        reason: EOPERATOR,
      };
    }

    if (this.agentRegistry && !this.agentRegistry.isToolAllowed(agentId, definition)) {
      return {
        blocked: true,
        reason: `Tool ${id} is blocked for agent ${agentId}.`,
        agentId,
      };
    }

    if (String(id).startsWith("mcp_") || definition.isMcp) {
      return this.runMcpTool(id, input, { ...normalized, agentId }, definition);
    }

    // Self-built (forged) tools: sandbox-executed with captured logs.
    if (!this.tools[id] && this.customTools.has(id)) {
      const custom = this.customTools.get(id);
      try {
        const { result, logs } = await this.toolForge.execute(custom.code, input || {});
        return sanitizeToolResult({ ok: true, tool: id, selfBuilt: true, result, logs: logs.slice(-10), agentId });
      } catch (error) {
        return {
          error: true,
          tool: id,
          selfBuilt: true,
          agentId,
          message: `Self-built tool "${id}" failed: ${error.message}. Fix it with build_tool (same name overwrites) or remove_custom_tool.`,
        };
      }
    }

    if (!this.tools[id]) {
      const result = await this.pluginRegistry.runTool(id, input);
      return {
        agentId,
        ...sanitizeToolResult(result),
      };
    }

    const schemaValidation = validateAgainstSimpleSchema(this.tools[id].schema || this.tools[id].inputSchema || null, input);
    if (!schemaValidation.ok) {
      this.agentRuntime?.gateway?.addEvent?.("tool_runtime.validation_failed", {
        tool: id,
        agentId,
        sessionId: normalized.sessionId || "",
        runId: normalized.runId || "",
        errors: schemaValidation.errors,
      });
      return {
        blocked: true,
        reason: "Tool input schema validation failed.",
        errors: schemaValidation.errors,
        agentId,
        tool: id,
      };
    }

    const permission = this.tools[id].permission;
    if (permission) {
      const config = this.configStore.getConfig();
      const allowed = Boolean(config.tools.permissions[permission]);
      if (!allowed) {
        return {
          blocked: true,
          reason: `Permission ${permission} is disabled.`,
          agentId,
        };
      }
    }

    const dedupExempt = DEDUP_EXEMPT_TOOLS.has(id) || normalized.bypassDedup === true;

    if (!dedupExempt && CACHEABLE_OBSERVATION_TOOLS.has(id) && this.observationCache.has(observationKey)) {
      const cached = this.observationCache.get(observationKey);
      this.agentRuntime?.gateway?.addEvent?.("tool_runtime.observation_reused", {
        tool: id,
        agentId,
        sessionId: normalized.sessionId || "",
        runId: normalized.runId || "",
        observationKey,
      });
      return compactObservationResult(cached);
    }

    if (!dedupExempt && this.failedObservationCache.has(observationKey)) {
      const failed = this.failedObservationCache.get(observationKey);
      this.agentRuntime?.gateway?.addEvent?.("tool_runtime.failed_repeat_blocked", {
        tool: id,
        agentId,
        sessionId: normalized.sessionId || "",
        runId: normalized.runId || "",
        observationKey,
      });
      return {
        blocked: true,
        reason: "Same tool and same arguments already failed.",
        detail: "Change query/args, fix the previous blocker, or explain the blocker instead of repeating the same failed call.",
        previousFailure: failed,
        agentId,
        tool: id,
      };
    }

    if (this.inFlightToolKeys.has(observationKey)) {
      return {
        blocked: true,
        reason: "Duplicate pending tool call blocked.",
        detail: "Same tool and same arguments are already running for this run/session.",
        agentId,
        tool: id,
      };
    }

    if (!dedupExempt && SIDE_EFFECT_TOOLS.has(id) && this.duplicateSideEffectKeys.has(observationKey)) {
      return {
        blocked: true,
        reason: "Duplicate side-effect tool call blocked.",
        detail: "Same side-effect tool and same arguments already ran in this run/session. Change args, use cached observation, or explain the blocker.",
        agentId,
        tool: id,
      };
    }

    this.inFlightToolKeys.add(observationKey);
    let result;
    try {
      this.agentRuntime?.gateway?.addEvent?.("tool_runtime.before_tool_call", {
        tool: id,
        agentId,
        sessionId: normalized.sessionId || "",
        runId: normalized.runId || "",
        permission: this.tools[id].permission || "",
        cacheable: CACHEABLE_OBSERVATION_TOOLS.has(id),
        sideEffect: SIDE_EFFECT_TOOLS.has(id),
      });
      result = await this.tools[id].run(input, normalized);
    } finally {
      this.inFlightToolKeys.delete(observationKey);
    }
    // Session read-cache invalidation (correctness first): a write touching
    // a path drops that path at once; shell-class tools drop ledger entries
    // naming paths in the command/code. Over-invalidation only costs a
    // re-read; under-invalidation would serve stale bytes.
    try {
      if (WRITE_INVALIDATE_TOOLS.has(id)) {
        const paths = ["path", "file", "from", "to", "source", "destination", "moveTo"]
          .map((key) => input && typeof input === "object" ? input[key] : "")
          .filter((value) => typeof value === "string" && value.trim());
        if (paths.length > 0) this.invalidateLedgerPaths(normalized, paths);
      } else if (COMMAND_INVALIDATE_TOOLS.has(id) && input && typeof input === "object") {
        const text = [input.command, input.cmd, input.code].filter((value) => typeof value === "string" && value).join("\n");
        if (text) this.invalidateLedgerForCommand(normalized, text);
      }
    } catch { /* invalidation is best-effort */ }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return result;
    }

    const output = {
      agentId,
      ...sanitizeToolResult(result),
    };
    if (CACHEABLE_OBSERVATION_TOOLS.has(id) && isSuccessfulToolResult(output)) {
      this.observationCache.set(observationKey, output);
      if (this.observationCache.size > 500) {
        const oldest = this.observationCache.keys().next().value;
        this.observationCache.delete(oldest);
      }
    }
    if (isFailedToolResult(output) && !DEDUP_EXEMPT_TOOLS.has(id) && normalized.bypassDedup !== true) {
      this.failedObservationCache.set(observationKey, {
        reason: output.reason || output.message || output.error || "tool failed",
        at: new Date().toISOString(),
      });
      if (this.failedObservationCache.size > 500) {
        const oldest = this.failedObservationCache.keys().next().value;
        this.failedObservationCache.delete(oldest);
      }
    }
    if (SIDE_EFFECT_TOOLS.has(id)) {
      this.duplicateSideEffectKeys.add(observationKey);
      if (this.duplicateSideEffectKeys.size > 500) {
        const oldest = this.duplicateSideEffectKeys.values().next().value;
        this.duplicateSideEffectKeys.delete(oldest);
      }
    }
    return output;
  }

  inferCommand(request) {
    const text = String(request || "").trim();
    const match = text.match(/["']([^"']+)["']/);
    if (match) {
      return match[1];
    }

    return text;
  }

  mediaNotConfigured(tool, prompt = "") {
    return {
      ok: false,
      configured: false,
      tool,
      promptPreview: String(prompt || "").slice(0, 180),
      message: `${tool} is registered for OpenClaw compatibility, but no media provider plugin is configured yet.`,
      nextUpgrade: "Add provider-backed image/music/video/TTS plugins and route these tools to them.",
    };
  }

  hermesToolNotReady(tool, message = "") {
    const item = HERMES_COMPAT_TOOLS.find((entry) => entry.id === tool) || {};
    return {
      ok: false,
      ready: false,
      tool,
      toolset: item.toolset || "",
      status: item.status || "placeholder",
      omniclawTool: item.omniclawTool || "",
      message: message || "This Hermes-compatible tool is cataloged, but its backend is not wired into OmniClaw yet.",
      source: "vendor/hermes-agent",
    };
  }

  getHermesToolCatalog({ status = "", toolset = "" } = {}) {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    const normalizedToolset = String(toolset || "").trim().toLowerCase();
    const visibleTools = new Set(this.getAll({ agentId: "main" }).map((tool) => tool.id));
    const tools = HERMES_COMPAT_TOOLS
      .filter((tool) => !normalizedStatus || tool.status === normalizedStatus)
      .filter((tool) => !normalizedToolset || tool.toolset === normalizedToolset)
      .map((tool) => ({
        ...tool,
        exposed: visibleTools.has(tool.id),
      }));
    const counts = tools.reduce((acc, tool) => {
      acc[tool.status] = (acc[tool.status] || 0) + 1;
      return acc;
    }, {});
    return {
      source: "vendor/hermes-agent/toolsets.py",
      total: tools.length,
      counts,
      toolsets: [...new Set(HERMES_COMPAT_TOOLS.map((tool) => tool.toolset))].sort(),
      tools,
      composableToolsets: [
        { id: "web", tools: ["web_search", "web_extract"] },
        { id: "terminal", tools: ["terminal", "process"] },
        { id: "file", tools: ["read_file", "write_file", "patch", "search_files"] },
        { id: "browser", tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll"] },
        { id: "memory", tools: ["memory", "session_search"] },
        { id: "skills", tools: ["skills_list", "skill_view", "skill_manage"] },
      ],
      rule: "OmniClaw keeps its working tools and exposes Hermes-compatible aliases/adapters. Python-only Hermes backends stay placeholders until safely ported.",
    };
  }

  async getRealTaskHealth({ live = true, context = {} } = {}) {
    const agentId = this.getAgentId(context);
    const config = this.configStore.getConfig();
    const tools = this.getAll({ agentId });
    const productReadyTools = tools.filter((tool) => tool.productReady !== false);
    const limitedTools = tools.filter((tool) => tool.productReady === false);
    const toolIds = new Set(tools.map((tool) => tool.id));
    const skills = this.agentRegistry
      ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
      : [];
    const provider = this.agentRuntime?.getProviderInfo?.() || {};
    const permissions = config.tools?.permissions || {};
    const hermesCatalog = this.getHermesToolCatalog({});
    const requiredTools = {
      files: ["list_files", "read_file", "write_file", "apply_patch"],
      computer: ["list_computer_directory", "search_computer_files", "read_computer_file", "write_computer_file", "delete_computer_path"],
      terminal: ["run_terminal_command", "exec", "process", "code_execution"],
      browser: ["browser_navigate", "browser_snapshot", "browser_text", "browser_screenshot"],
      web: ["web_research", "web_search", "read_url", "web_fetch"],
      memory: ["remember_note", "memory_search", "list_long_term_memory", "promote_memory"],
      skills: ["capability_demo", "create_skill", "hermes_skill_scan", "skill_system_status"],
      sessions: ["sessions_list", "sessions_history", "sessions_send", "delegate_task"],
      automation: ["cron", "list_tasks", "create_task", "run_task"],
      provider: ["provider_status", "list_provider_models", "test_provider_profile", "apply_provider_profile"],
    };
    const groups = Object.entries(requiredTools).map(([group, ids]) => {
      const present = ids.filter((id) => toolIds.has(id));
      return {
        group,
        status: present.length === ids.length ? "ready" : present.length > 0 ? "partial" : "missing",
        present,
        missing: ids.filter((id) => !toolIds.has(id)),
      };
    });

    const probes = [];
    const addProbe = (name, status, detail = "", extra = {}) => {
      probes.push({ name, status, detail, ...extra });
    };

    try {
      const entries = this.fileStore.listDirectory(".");
      addProbe("workspace_files", "ready", `${entries.length} workspace item(s) visible.`);
    } catch (error) {
      addProbe("workspace_files", "failed", error.message);
    }

    try {
      const home = this.fileStore.listComputerDirectory("~", this.requireComputerAccessPolicy());
      addProbe("computer_home", "ready", `${home.entries.length} home folder item(s) visible.`, {
        path: home.path,
        sample: home.entries.slice(0, 6).map((entry) => entry.name),
      });
    } catch (error) {
      addProbe("computer_home", "failed", error.message);
    }

    try {
      const system = await this.systemMonitor.getComputerStatus();
      addProbe("system_status", "ready", `RAM ${system.memory?.freeGb || "?"}/${system.memory?.totalGb || "?"} GB free/total.`);
    } catch (error) {
      addProbe("system_status", "failed", error.message);
    }

    if (live && this.agentRuntime?.executeTerminalCommand && permissions.allowShellExecution) {
      try {
        const execution = await this.agentRuntime.executeTerminalCommand({
          command: "Get-Date",
          context: {
            ...context,
            agentId,
            source: "real-task-health",
          },
        });
        addProbe(
          "terminal_execution",
          execution.status === "completed" ? "ready" : execution.status || "failed",
          execution.status === "completed"
            ? String(execution.stdout || "").trim().slice(0, 160)
            : String(execution.stderr || execution.reason || "").slice(0, 220),
        );
      } catch (error) {
        addProbe("terminal_execution", "failed", error.message);
      }
    } else {
      addProbe("terminal_execution", permissions.allowShellExecution ? "skipped" : "disabled", "Live terminal probe skipped.");
    }

    try {
      const browser = this.browserOperator.getStatus?.() || {};
      addProbe(browser.available === false ? "browser_control" : "browser_control", browser.available === false ? "partial" : "ready", browser.message || "Browser operator registered.", {
        status: browser,
      });
    } catch (error) {
      addProbe("browser_control", "failed", error.message);
    }

    addProbe(
      "provider_brain",
      provider.ready === false ? "needs-setup" : "ready",
      provider.ready === false
        ? (provider.message || "Provider brain needs API/account setup.")
        : `${provider.id || "provider"} ${provider.model || ""}`.trim(),
    );

    const readyCount = groups.filter((group) => group.status === "ready").length;
    const partialCount = groups.filter((group) => group.status === "partial").length;
    const failedProbeCount = probes.filter((probe) => ["failed", "needs-setup"].includes(probe.status)).length;
    const placeholderCount = limitedTools.filter((tool) => tool.runtimeStatus === "placeholder").length;
    const partialToolCount = limitedTools.filter((tool) => tool.runtimeStatus === "partial").length;
    const callableRatio = productReadyTools.length / Math.max(1, tools.length);
    const score = Math.max(0, Math.min(100, Math.round(
      (readyCount / groups.length) * 55 +
      ((groups.length - partialCount) / groups.length) * 10 +
      ((probes.length - failedProbeCount) / Math.max(1, probes.length)) * 20 +
      callableRatio * 15 -
      Math.min(12, placeholderCount * 0.6) -
      Math.min(6, partialToolCount * 0.35),
    )));

    return {
      agentId,
      productMode: true,
      score,
      provider: {
        id: provider.id || "unknown",
        mode: provider.mode || "",
        model: provider.model || "",
        ready: provider.ready !== false,
        apiKeySource: provider.apiKeySource || "",
      },
      tools: {
        total: tools.length,
        productReady: productReadyTools.length,
        limited: limitedTools.length,
        placeholders: placeholderCount,
        partial: partialToolCount,
        groups,
        hermesCompatibility: hermesCatalog.counts || {},
        hiddenFromPlanner: limitedTools.slice(0, 24).map((tool) => ({
          id: tool.id,
          status: tool.runtimeStatus,
          replacement: tool.replacement,
          reason: tool.readinessReason,
        })),
      },
      skills: {
        total: skills.length,
        loaded: skills.slice(0, 12).map((skill) => ({
          id: skill.id,
          name: skill.name,
          triggers: skill.triggers,
        })),
      },
      probes,
      recipes: [
        { ask: "mara laptop par opencode file search karo", expectedTools: ["search_computer_files"] },
        { ask: "list computer folder ~", expectedTools: ["list_computer_directory"] },
        { ask: "read file docs/PRODUCT_VISION.md", expectedTools: ["read_file"] },
        { ask: "run terminal command \"Get-Date\"", expectedTools: ["run_terminal_command"] },
        { ask: "open browser https://github.com", expectedTools: ["browser_navigate"] },
        { ask: "fetch models nvidia", expectedTools: ["list_provider_models"] },
      ],
      nextHardening: [
        "Convert each placeholder Hermes tool into a working adapter or hide it from product UI until backend exists.",
        "Add smoke tests for every high-value natural-language recipe, not just backend tool IDs.",
        "Prefer grounded tool-output replies for filesystem, browser, terminal, and provider tasks.",
        "Make provider model fetch/save/test one atomic flow in UI and chat.",
      ],
      rule: "Product mode means no fake success: every real task must show executed tool evidence, failure reason, or next fix.",
    };
  }

  getContextCompressionStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const agent = this.agentRegistry?.resolveAgent?.(agentId) || null;
    const profile = agent ? this.configStore.getProfile(agent.profileId) : this.configStore.getActiveProfile();
    const maxChars = this.agentRuntime?.contextEngine?.getMaxChars?.(profile || {}) || 0;
    const sessionId = context.sessionId || "";
    const session = sessionId && this.agentRuntime?.sessions?.getSession
      ? this.agentRuntime.sessions.getSession(sessionId, { messageLimit: 120 })
      : null;
    const summary = sessionId && this.agentRuntime?.summarizer?.readSummary
      ? this.agentRuntime.summarizer.readSummary(sessionId)
      : null;
    const transcriptCount = session?.transcriptEntryCount || 0;
    const compressionThreshold = Math.floor(maxChars * 0.82);
    return {
      agentId,
      profile: profile?.id || "balanced",
      maxChars,
      compressionThreshold,
      activeSessionId: sessionId,
      transcriptEntryCount: transcriptCount,
      summaryPresent: Boolean(summary),
      summaryFrame: summary
        ? "CONTEXT COMPACTION - treat as background reference, NOT active instructions. Respond only to the latest message."
        : "",
      algorithm: [
        "Preserve head/bootstrap identity and latest tail messages.",
        "Prune old bulky tool outputs first.",
        "Summarize middle conversation when session grows.",
        "Keep prior summary across re-compressions.",
        "Track rough char budget as token-budget proxy.",
      ],
      currentSummary: summary,
      nextUpgrade: "Replace simple session compaction with head+tail preservation plus middle summary budgeted around 20% of compressed content.",
    };
  }

  getMemoryLifecycleStatus({ query = "", context = {} } = {}) {
    const agentId = this.getAgentId(context);
    const prefetch = this.memoryStore.prefetchAll({
      query,
      agentId,
      limit: 12,
    });
    const search = query ? prefetch.search : this.memoryStore.searchAll("", agentId);
    return {
      ...prefetch,
      sessionSearch: {
        ready: true,
        mode: "JSON full-text scan now; SQLite FTS5 index is next upgrade.",
        query: query || "",
        resultCounts: search
          ? Object.fromEntries(Object.entries(search).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]))
          : {},
      },
      fencedBlockRule: "Memory is injected as context data, not as executable instructions.",
    };
  }

  getSkillSystemStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const omniSkills = this.agentRegistry
      ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
      : [];
    const hermes = this.scanHermesSkills({ limit: 16 });
    const standards = omniSkills.reduce((acc, skill) => {
      const key = skill.standard || "omniclaw-skill";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      agentId,
      omniSkillCount: omniSkills.length,
      hermesVendoredSkillCount: hermes.totalAvailable,
      standards,
      progressiveDisclosure: [
        "Tier 1: name + description + triggers are injected compactly.",
        "Tier 2: full instructions are loaded when the skill matches the user request.",
        "Tier 3: references/templates/assets should be loaded on demand by future skill importer.",
      ],
      selfImprovement: {
        current: "create_skill can write local .skill files; dream sweep promotes memory candidates.",
        gap: "skill_manage is still a placeholder for reviewable updates to SKILL.md after complex tasks.",
        nextUpgrade: "Add hermes_skill_import and skill_manage update flow with diff/review before writing.",
      },
      sampleHermesSkills: hermes.skills.slice(0, 8),
    };
  }

  getMessagingGatewayStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const adapters = this.connectorStore?.listAdapters?.() || [];
    const overview = this.connectorStore?.getAdaptersOverview?.() || {
      total: adapters.length,
      enabled: adapters.filter((adapter) => adapter.enabled).length,
      ready: adapters.filter((adapter) => ["ready", "configured"].includes(adapter.status)).length,
      needsSecret: adapters.filter((adapter) => adapter.status === "needs-secret").length,
    };
    const gateway = this.agentRuntime?.gateway;
    const sessions = this.agentRuntime?.sessions?.listSessions?.(20) || [];
    const deliveries = this.connectorStore?.listAdapterDeliveries?.({ limit: 12 }) || [];
    const webhookDeliveries = this.connectorStore?.listWebhookDeliveries?.(12) || [];
    const configuredPlatforms = adapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      transport: adapter.transport,
      direction: adapter.direction,
      enabled: adapter.enabled,
      status: adapter.status,
      defaultAgentId: adapter.defaultAgentId,
      secretConfigured: adapter.secretConfigured,
      capabilities: adapter.capabilities || [],
    }));
    return {
      agentId,
      mode: "single gateway process routes all configured platform adapters into agent sessions",
      overview,
      configuredPlatforms,
      supportedTargets: ["telegram", "discord", "http-webhook", "webchat"],
      plannedTargets: ["whatsapp", "slack", "signal", "email", "matrix", "mattermost", "dingtalk", "wecom", "feishu"],
      sessionRouting: {
        ready: true,
        rule: "platform/user/channel ids map into persistent OmniClaw sessions; webchat uses sessionId/sessionKey.",
        recentSessionCount: sessions.length,
        recentSessions: sessions.slice(0, 6).map((session) => ({
          id: session.id,
          key: session.key,
          agentId: session.agentId,
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
        })),
      },
      voiceTranscription: {
        status: "partial",
        current: "attachments are cached/extracted/analyzed through media-provider adapters when configured",
        gap: "automatic voice memo transcription and audio reply synthesis need speech/TTS provider plugins",
      },
      dmPairingSecurity: {
        trustStore: Boolean(this.agentRuntime?.trust),
        approvals: gateway?.listApprovals?.("")?.length || 0,
        rule: "gateway tokens, adapter secrets, device pairing, and shell approvals guard risky operations",
      },
      recentTraffic: {
        adapterDeliveries: deliveries.length,
        webhookDeliveries: webhookDeliveries.length,
        recentEvents: gateway?.listEvents?.(8) || [],
      },
      nextUpgrade: "Promote Telegram/Discord workers plus webhook into a unified gateway adapter dashboard, then add WhatsApp/Slack/Signal/Email account pairing.",
    };
  }

  /** The token the Telegram adapter is actually configured with, if any. */
  telegramToken() {
    return String(this.connectorStore?.getAdapterSecret?.("telegram", "botToken") || "").trim();
  }

  async configureTelegramAdapter(input = {}) {
    // Models reach for snake_case as often as camelCase; rejecting one half
    // silently looked like "the tool ignored my token" and sent the agent off
    // to build a custom connector instead.
    const botToken = String(
      input.botToken || input.bot_token || input.token || input.botapitoken || input.secret || "",
    ).trim();
    const defaultAgentId = String(input.defaultAgentId || input.default_agent_id || "main").trim() || "main";
    const startWorker = input.startWorker !== false;

    if (!botToken) {
      const adapter = this.connectorStore?.getAdapter?.("telegram") || null;
      return {
        ok: false,
        needsToken: true,
        adapterId: "telegram",
        status: adapter?.status || "unknown",
        enabled: Boolean(adapter?.enabled),
        secretConfigured: Boolean(adapter?.secretConfigured),
        setup: [
          "Telegram me @BotFather open karo.",
          "/newbot se bot banao ya existing bot token copy karo.",
          "OmniClaw chat me token bhejo: telegram token <BOT_TOKEN>",
          "Main token save karke Telegram adapter enable/start kar dunga.",
        ],
      };
    }

    // Verify against Telegram BEFORE saving. connectorStore.testAdapter() only
    // checks that a secret string exists locally, so a typo'd or revoked token
    // used to be stored and reported as `ok: true` while nothing worked.
    const identity = await verifyTelegramToken(botToken);
    if (!identity.ok) {
      return {
        ok: false,
        adapterId: "telegram",
        saved: false,
        code: identity.code,
        error: identity.error,
        token: maskToken(botToken),
        fix:
          identity.code === "telegram-401"
            ? "Telegram rejected this token. Open @BotFather -> /mytoken (or /revoke) and copy the current one."
            : identity.code === "network" || identity.code === "timeout"
              ? "Could not reach api.telegram.org. Check connectivity, then re-run."
              : "Copy the token exactly as @BotFather sent it, with no quotes or spaces.",
      };
    }

    const configResult = this.connectorStore.setAdapterConfig({
      adapterId: "telegram",
      enabled: input.enabled !== false,
      defaultAgentId,
      mode: input.mode || "polling",
      secret: botToken,
    });
    const test = this.connectorStore.testAdapter("telegram");

    // A leftover webhook makes getUpdates fail with 409 forever — the classic
    // "connected but receives nothing" trap. Detect it, and clear it when the
    // adapter is being put into polling mode.
    const webhook = await getWebhookConflict(botToken);
    let webhookCleared = false;
    if (webhook.ok && webhook.conflictsWithPolling && (input.mode || "polling") === "polling") {
      const dropped = await deleteWebhook(botToken);
      webhookCleared = Boolean(dropped.ok);
    }

    let worker = null;
    let workerError = "";
    if (startWorker && this.agentRuntime?.telegramWorker?.start) {
      try {
        worker = await this.agentRuntime.telegramWorker.start({ limit: 5 });
      } catch (error) {
        workerError = error.message;
      }
    }

    return {
      ok: true,
      adapterId: "telegram",
      verified: true,
      bot: identity.bot,
      secretUpdated: Boolean(configResult.secretUpdated),
      adapter: configResult.adapter,
      test,
      webhook: webhook.ok ? { ...webhook, cleared: webhookCleared } : { error: webhook.error },
      worker,
      workerError,
      next: [
        `Telegram me @${identity.bot.username} ko /start bhejo.`,
        "Phir message bhejo — telegram_status se live check kar sakte ho.",
      ],
    };
  }

  async getTelegramStatus() {
    const adapter = this.connectorStore?.getAdapter?.("telegram") || null;
    const token = this.telegramToken();
    const worker = this.agentRuntime?.telegramWorker?.getStatus?.() || null;

    if (!token) {
      return {
        ok: false,
        connected: false,
        code: "no-token",
        adapter,
        worker,
        message: "No Telegram bot token is configured.",
        fix: ["@BotFather me /newbot ya /mytoken se token lo.", "Phir configure_telegram({ botToken })."],
      };
    }

    const identity = await verifyTelegramToken(token);
    if (!identity.ok) {
      return {
        ok: false,
        connected: false,
        code: identity.code,
        error: identity.error,
        token: maskToken(token),
        adapter,
        worker,
        fix: ["Token invalid ya reachable nahi. configure_telegram({ botToken }) se naya token do."],
      };
    }

    const webhook = await getWebhookConflict(token);
    const blocked = webhook.ok && webhook.conflictsWithPolling;
    return {
      ok: true,
      connected: true,
      bot: identity.bot,
      token: maskToken(token),
      adapter,
      worker,
      webhook: webhook.ok ? webhook : { error: webhook.error },
      // "Token is valid" and "messages are flowing" are different questions;
      // answer the second one too or this tool is just a prettier getMe.
      receiving: blocked
        ? "BLOCKED — a webhook is registered, so getUpdates returns 409. Run configure_telegram again (it clears the webhook) or delete it in BotFather."
        : worker?.running
          ? "Polling worker is running."
          : "Token works, but the polling worker is NOT running — call configure_telegram({ botToken, startWorker: true }).",
    };
  }

  async sendTelegramMessageTool(input = {}) {
    const token = this.telegramToken();
    if (!token) {
      return {
        ok: false,
        code: "no-token",
        error: "Telegram is not configured. Call configure_telegram({ botToken }) first.",
      };
    }
    const chatId = String(input.chatId ?? input.chat_id ?? input.to ?? "").trim();
    const text = String(input.text ?? input.message ?? input.body ?? "");
    const sent = await sendTelegramMessage(token, chatId, text, {
      parseMode: input.parseMode ?? input.parse_mode,
      disablePreview: input.disablePreview,
      replyToMessageId: input.replyToMessageId ?? input.reply_to_message_id,
    });
    if (!sent.ok) {
      return {
        ok: false,
        code: sent.code,
        error: sent.error,
        chatId,
        fix:
          sent.code === "telegram-400" && /chat not found/i.test(sent.error || "")
            ? "The bot can only message chats it has seen. Send the bot /start from that chat first, or use the numeric chat id from an incoming message."
            : sent.code === "telegram-403"
              ? "The user blocked the bot, or the bot was removed from that group."
              : undefined,
      };
    }
    return {
      ok: true,
      chatId,
      messageId: sent.result?.message_id,
      parseModeDowngraded: Boolean(sent.parseModeDowngraded),
      sentAt: new Date().toISOString(),
    };
  }

  async getTerminalBackendsStatus(context = {}) {
    const config = this.configStore.getConfig();
    const shellPermissions = config.tools?.permissions || {};
    const shellPolicy = config.tools?.shell || {};
    const audit = this.agentRuntime?.shellAudit?.list?.({ limit: 12 }) || [];
    const processes = await (this.systemMonitor?.listProcesses?.("") || Promise.resolve({ processes: [], count: 0 }));
    const sandboxStatus = this.sandboxRunner?.getStatus?.() || {};
    return {
      agentId: this.getAgentId(context),
      defaultBackend: "local",
      backends: [
        { id: "local", status: shellPermissions.allowShellExecution ? "ready" : "permission-disabled", detail: "Direct governed subprocess execution on this Windows laptop." },
        { id: "docker", status: sandboxStatus.enabled ? "partial" : "missing", detail: "Sandbox runner exists, hard container isolation needs a stricter Docker backend." },
        { id: "ssh", status: "planned", detail: "Remote command backend not wired yet." },
        { id: "daytona", status: "planned", detail: "Serverless dev environment backend not wired yet." },
        { id: "modal", status: "planned", detail: "Serverless GPU/cloud backend not wired yet." },
        { id: "singularity", status: "planned", detail: "HPC container backend not wired yet." },
      ],
      persistentEnvironments: {
        status: "partial",
        current: "process registry and background jobs exist; per-backend long-lived environment reuse is next",
      },
      processRegistry: {
        ready: true,
        processSampleCount: Array.isArray(processes.processes) ? Math.min(processes.processes.length, 20) : 0,
        auditCount: audit.length,
        recentShellAudit: audit.slice(0, 5),
      },
      approvalGates: {
        enabled: Boolean(shellPolicy.requireApproval || shellPermissions.allowShellPlanning),
        shellExecutionAllowed: Boolean(shellPermissions.allowShellExecution),
        shellPlanningAllowed: Boolean(shellPermissions.allowShellPlanning),
        policy: shellPolicy,
      },
      nextUpgrade: "Add backend selection to terminal/process tools so local/docker/ssh/cloud execution can be chosen per tool call.",
    };
  }

  getModelProviderStatus(context = {}) {
    const config = this.configStore.getConfig();
    const provider = this.agentRuntime?.getProviderInfo?.() || {};
    const profiles = config.providerProfiles || {};
    const secretStatuses = this.agentRuntime?.secrets?.getAllStatuses?.() || [];
    const fallbackChain = [
      ...(config.provider?.fallbacks || []),
      ...(config.fallbacks || []),
    ].filter((item, index, arr) => item && arr.indexOf(item) === index);
    const recentRuns = this.agentRuntime?.gateway?.listRuns?.(20) || [];
    const recentProviderRun = recentRuns.find((run) => run.providerDiagnostics || run.providerAttempts);
    const lastAttempts = recentProviderRun?.providerDiagnostics?.attempts || recentProviderRun?.providerAttempts || [];
    const activeProfile = Object.entries(profiles).find(([, profile]) =>
      profile?.mode === config.provider?.mode &&
      profile?.baseUrl === config.provider?.baseUrl &&
      profile?.model === config.provider?.model
    );
    const baseUrl = String(config.provider?.baseUrl || "");
    const apiMode = provider.mode === "codex-cli"
      ? "codex_responses"
      : /anthropic|claude/i.test(baseUrl)
        ? "anthropic_messages"
        : "chat_completions";
    return {
      agentId: this.getAgentId(context),
      active: {
        provider: provider.id || "unknown",
        ready: Boolean(provider.ready),
        mode: provider.mode || config.provider?.mode || "",
        model: provider.model || config.provider?.model || "",
        baseUrl,
        apiMode,
        profileId: activeProfile?.[0] || "",
      },
      autoDetection: {
        ready: true,
        rule: "provider mode/baseUrl select chat_completions, anthropic_messages-style, or codex_responses command bridge",
        supportedModes: ["mock", "openai-compatible", "codex-cli"],
      },
      credentialPool: {
        status: secretStatuses.some((item) => item.configured) ? "partial" : "missing",
        configuredKeys: secretStatuses.filter((item) => item.configured).length,
        keys: secretStatuses,
        gap: "round-robin key rotation per provider is not implemented yet",
      },
      smartFailover: {
        status: fallbackChain.length > 0 ? "partial" : "missing",
        current: fallbackChain.length > 0
          ? "active provider failures can try configured fallback profiles in sequence"
          : "provider failures are classified and converted into fallback replies/status",
        configuredChain: fallbackChain,
        lastAttempts,
        gap: fallbackChain.length > 0
          ? "fallback retry works by provider profile; key-pool rotation and persisted rate-limit scoring are still pending"
          : "configure provider.fallbacks or agent fallbackChain for secondary model failover",
      },
      rateLimitTracker: {
        status: "planned",
        current: "provider test responses expose errors, but rate-limit headers are not persisted yet",
      },
      modelDiscovery: {
        ready: true,
        tool: "list_provider_models",
        rule: "OpenAI-compatible /models endpoint can be fetched after base URL and key are configured",
      },
      nextUpgrade: "Add provider key-pool rotation and rate-limit header storage for smarter fallback ordering.",
    };
  }

  getSubagentDelegationStatus(context = {}) {
    const agents = this.agentRegistry?.getAll?.() || [];
    const delegations = this.agentRuntime?.gateway?.listDelegations?.({ limit: 20 }) || [];
    const visibleTools = new Set(this.getAll({ agentId: "main" }).map((tool) => tool.id));
    return {
      agentId: this.getAgentId(context),
      availableAgents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role || "",
        profileId: agent.profileId,
        toolCount: Array.isArray(agent.tools) ? agent.tools.length : 0,
      })),
      delegationToolReady: visibleTools.has("delegate_task"),
      isolationGuarantees: {
        childGetsParentHistory: false,
        resultMode: "summary result only",
        maxDepth: 1,
        defaultConcurrentChildren: 1,
        blockedChildTools: ["delegate_task", "clarify", "memory", "send_message", "execute_code"],
        gap: "current delegate_task queues a routed task; full isolated child execution loop is still partial",
      },
      sharedIterationBudget: {
        status: "planned",
        current: "parent run records delegation request; separate shared budget object is next",
      },
      executeCodeTool: {
        ready: visibleTools.has("execute_code") || visibleTools.has("code_execution"),
        note: "execute_code exists for compact local scripts, governed by shell execution permissions",
      },
      recentDelegations: delegations.slice(0, 8),
      nextUpgrade: "Turn queued delegations into real child agent runs with isolated context, bounded toolsets, and collected summaries.",
    };
  }

  getMcpIntegrationStatus(context = {}) {
    const mcp = this.agentRuntime?.mcp;
    const status = mcp?.getStatus?.() || {};
    const tools = mcp?.getAllTools?.() || [];
    const acpStatus = this.agentRuntime?.acp?.status?.({ limit: 5 }) || null;
    const configPath = mcp?.configPath || "config/mcp-servers.json";
    let configuredServers = [];
    try {
      const parsed = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      configuredServers = Object.entries(parsed.servers || {}).map(([id, server]) => ({
        id,
        transport: server.transport || "stdio",
        command: server.command || "",
        url: server.url || "",
      }));
    } catch {
      configuredServers = [];
    }
    return {
      agentId: this.getAgentId(context),
      configPath,
      configuredServers,
      connectedServers: Object.values(status).filter((item) => item.connected).length,
      status,
      liveToolCount: tools.length,
      liveTools: tools.slice(0, 20),
      resolutionFlow: [
        "MCP server configured in config/mcp-servers.json",
        "mcp.connectServer/connectAll starts the server",
        "tools/list populates first-class mcp_* tool ids",
        "model/tool loop can call mcp tool through registry",
      ],
      explicitAliases: {
        ready: configuredServers.length > 0,
        rule: "server id is embedded in generated mcp_<server>_<tool> id to avoid ambiguous tool names",
      },
      servesOmniClawToo: {
        status: "planned",
        gap: "OmniClaw can consume MCP servers; exposing OmniClaw itself as an MCP server is not wired yet",
      },
      acpAdapter: {
        status: acpStatus?.enabled ? "partial" : "disabled",
        backend: acpStatus?.backend || "",
        defaultAgent: acpStatus?.defaultAgent || "",
        sessions: acpStatus?.sessions || [],
        readyTools: ["acp_doctor", "acp_install", "acp_spawn", "acp_status", "acp_sessions", "acp_cancel", "acp_close"],
        gap: "ACP control plane is wired for local external harness commands; full ACP protocol streaming through acpx is still the next backend upgrade.",
      },
      nextUpgrade: "Add dashboard connect/test buttons for MCP servers, then expose connected MCP tools in capability_demo.",
    };
  }

  // Execute a connected MCP tool (mcp_<server>_<tool>) and normalize the
  // MCP-spec result ({ content:[{type:'text',text}], isError }) into the plain
  // shape the model loop expects — a pass/fail verdict + readable text.
  async runMcpTool(id, input = {}, context = {}, definition = null) {
    const agentId = context.agentId || "main";
    const mcp = this.agentRuntime?.mcp;
    if (!mcp?.callTool) {
      return { ok: false, agentId, tool: id, error: "MCP registry is not available in this runtime." };
    }
    // If the tool isn't in the live registry yet, the server probably isn't
    // connected. Auto-connect once so the model doesn't have to.
    const known = (mcp.getAllTools?.() || []).some((t) => t.id === id);
    if (!known) {
      const server = definition?.mcpServer || String(id).split("_")[1];
      try { await mcp.connectServer?.(server); } catch {}
    }

    this.agentRuntime?.gateway?.addEvent?.("mcp.tool_call", {
      tool: id,
      agentId,
      sessionId: context.sessionId || "",
      runId: context.runId || "",
      server: definition?.mcpServer || "",
    });

    try {
      const raw = await mcp.callTool(id, input || {});
      const result = raw?.result ?? raw;
      const contentBlocks = Array.isArray(result?.content) ? result.content : [];
      const text = contentBlocks
        .map((block) => {
          if (typeof block === "string") return block;
          if (block?.type === "text") return block.text || "";
          if (block?.type === "resource" && block.resource?.text) return block.resource.text;
          return JSON.stringify(block);
        })
        .filter(Boolean)
        .join("\n");
      const isError = result?.isError === true;
      return {
        ok: !isError,
        agentId,
        tool: id,
        mcpServer: definition?.mcpServer || "",
        content: text || (isError ? "MCP tool reported an error." : ""),
        structured: result?.structuredContent ?? undefined,
        isError,
      };
    } catch (err) {
      this.agentRuntime?.gateway?.addEvent?.("mcp.tool_error", { tool: id, agentId, error: err.message });
      return {
        ok: false,
        agentId,
        tool: id,
        error: `MCP tool call failed: ${err.message}`,
        detail: "Check the server is connected (mcp_connect_all) and the arguments match the tool schema.",
      };
    }
  }

  async connectAllMcpServers() {
    const mcp = this.agentRuntime?.mcp;
    if (!mcp?.connectAll) {
      return {
        ok: false,
        message: "MCP registry is not available in this runtime.",
      };
    }
    const results = await mcp.connectAll();
    const status = this.getMcpIntegrationStatus({ agentId: "main" });
    this.agentRuntime?.gateway?.addEvent?.("mcp.connect_all", {
      configuredServers: status.configuredServers.length,
      connectedServers: status.connectedServers,
      liveToolCount: status.liveToolCount,
      results,
    });
    return {
      ok: true,
      results,
      ...status,
    };
  }

  getCronSchedulerStatus(context = {}) {
    const overview = this.agentRuntime?.scheduler?.getOverview?.() || {};
    const schedules = this.agentRuntime?.schedules?.listSchedules?.(20) || [];
    const jobs = this.agentRuntime?.jobs?.listJobs?.(20) || [];
    return {
      agentId: this.getAgentId(context),
      overview,
      schedules: schedules.slice(0, 10),
      recentJobs: jobs.slice(0, 10),
      howItWorks: [
        "create_schedule/cronjob creates a persisted schedule",
        "scheduler ticks independently of the chat request",
        "due schedule enqueues a fresh background tool job",
        "job output is recorded in jobs/gateway logs and can be delivered through messaging adapters",
      ],
      unattendedOperation: {
        status: "partial",
        current: "scheduler runs inside the local gateway process while OmniClaw is running",
        gap: "OS-level service/auto-start and cloud serverless backends are next",
      },
      deliveryPath: {
        ready: true,
        current: "background worker -> gateway event/job log; send_message can route adapter outbox when configured",
      },
      cliReference: ["cron", "cronjob", "create_schedule", "delete_schedule", "run_schedule_now"],
      nextUpgrade: "Add natural-language schedule parsing and per-platform delivery selection from chat.",
    };
  }

  getTrajectoryTrainingStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const gateway = this.agentRuntime?.gateway;
    const runs = gateway?.listRuns?.(50) || [];
    const events = gateway?.listEvents?.(200) || [];
    const shellAudit = this.agentRuntime?.shellAudit?.list?.({ limit: 50 }) || [];
    const jobs = this.agentRuntime?.jobs?.listJobs?.(50) || [];
    const toolEvents = events.filter((event) =>
      /tool|shell|browser|computer|provider|schedule|mcp|connector/i.test(`${event.event || ""}`)
    );
    const trajectorySample = runs.slice(0, 5).map((run) => ({
      id: run.id,
      status: run.status,
      agentId: run.agentId || agentId,
      sessionId: run.sessionId || "",
      providerStatus: run.providerStatus || "",
      toolOutputs: Array.isArray(run.toolOutputs) ? run.toolOutputs.length : 0,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));
    return {
      agentId,
      pipeline: {
        status: runs.length > 0 ? "partial" : "seeded",
        mode: "gateway run log + tool outputs + shell/browser/audit events",
        skipContextFiles: true,
        rule: "training exports must exclude SOUL.md/USER.md/PROFILE.md and ephemeral system prompt data",
      },
      components: [
        { id: "trajectory", status: "partial", current: "gateway runs store structured run/session/provider/tool metadata" },
        { id: "batch_runner", status: "planned", current: "no large-scale trajectory generation runner yet" },
        { id: "trajectory_compressor", status: "partial", current: "session summaries/context compression exist; training-specific compression is next" },
        { id: "mini_swe_runner", status: "planned", current: "software engineering benchmark runner not wired yet" },
        { id: "rl_training_tool", status: "planned", current: "approved action -> reward sample pipeline not wired yet" },
      ],
      counts: {
        runs: runs.length,
        toolEvents: toolEvents.length,
        shellAudit: shellAudit.length,
        jobs: jobs.length,
      },
      sample: trajectorySample,
      rlTraining: {
        status: "planned",
        gap: "No reward model/environment feedback loop yet; traces are useful for later supervised/RL data export.",
      },
      nextUpgrade: "Add trajectory_export_jsonl with redaction, skip_context_files=true, and one approved run as one training sample.",
    };
  }

  getClosedLearningLoopStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const memory = this.memoryStore.prefetchAll({ agentId, limit: 8 });
    const sessions = this.agentRuntime?.sessions?.listSessions?.(30) || [];
    const skills = this.agentRegistry
      ? this.agentRegistry.filterSkills(this.customizationEngine?.skillRegistry?.getAll?.() || [], agentId)
      : [];
    const shellAuditOverview = this.agentRuntime?.shellAudit?.getOverview?.() || {};
    return {
      agentId,
      loop: [
        { step: "user_interaction", status: "ready", evidence: `${sessions.length} recent session(s)` },
        { step: "agent_executes_task", status: "ready", evidence: `${shellAuditOverview.executed || 0} executed shell record(s), gateway/tool logs available` },
        { step: "memory_nudge", status: "partial", evidence: `${memory.overview?.longTerm || 0} long-term memories, ${memory.overview?.dreams || 0} dreams` },
        { step: "session_logged", status: "ready", evidence: "session transcripts and gateway runs persist locally" },
        { step: "skill_auto_created", status: "partial", evidence: `${skills.length} local skill(s); automatic post-task skill refinement still guarded/manual` },
        { step: "user_model_updated", status: "partial", evidence: "PROFILE.md and memory facts update; Honcho-style external user model is not wired" },
        { step: "next_interaction_smarter", status: "partial", evidence: "prefetch_all injects memory/session context; FTS5 + skill_manage are next" },
      ],
      memoryLifecycle: memory.lifecycle || [],
      closedLoopRule: "Every interaction should leave usable state: transcript, run trace, memory candidate, or skill candidate.",
      nextUpgrade: "Add post-run learner that proposes MEMORY.md and SKILL.md diffs for review instead of silently rewriting identity.",
    };
  }

  getHermesUseCasesStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const toolIds = new Set(this.getAll({ agentId }).map((tool) => tool.id));
    const has = (...ids) => ids.some((id) => toolIds.has(id));
    const cases = [
      {
        id: "software_engineering",
        label: "Software engineering",
        status: has("read", "write", "edit", "apply_patch", "run_terminal_command", "code_execution") ? "partial" : "missing",
        ready: ["read/patch codebases", "run governed commands/tests", "inspect files"],
        gaps: ["full CI/GitHub PR automation depends on configured GitHub tooling and provider brain"],
      },
      {
        id: "research_analysis",
        label: "Research and analysis",
        status: has("web_search", "web_fetch", "memory_search", "vision_analyze") ? "partial" : "missing",
        ready: ["web search/fetch", "session/memory recall", "attachment/media analysis when provider configured"],
        gaps: ["deep extraction pipeline and image-capable provider plugins need more adapters"],
      },
      {
        id: "personal_assistant",
        label: "Personal assistant",
        status: has("cron", "send_message", "messaging_gateway_status") ? "partial" : "missing",
        ready: ["webchat", "scheduler", "gateway logs", "adapter outbox"],
        gaps: ["Telegram/WhatsApp/voice memo production pairing and TTS replies"],
      },
      {
        id: "devops_automation",
        label: "DevOps and automation",
        status: has("run_terminal_command", "cron", "computer_access_status") ? "partial" : "missing",
        ready: ["local terminal", "scheduled jobs", "file operations", "audits"],
        gaps: ["SSH/Docker/cloud terminal backends and Home Assistant connector"],
      },
      {
        id: "ml_research",
        label: "ML research",
        status: has("trajectory_training_status", "model_provider_status") ? "seeded" : "missing",
        ready: ["trajectory diagnostics", "provider/model diagnostics"],
        gaps: ["GPU backends, RL environments, benchmark runner, batch trajectory generation"],
      },
      {
        id: "team_workflows",
        label: "Team workflows",
        status: has("subagent_delegation_status", "mcp_integration_status") ? "partial" : "missing",
        ready: ["subagent routing status", "MCP consumer registry", "Discord adapter skeleton"],
        gaps: ["Slack/Discord production bot workflows, shared skills hub, company MCP dashboards"],
      },
    ];
    return {
      agentId,
      cases,
      summary: cases.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
      rule: "Use-case claims must map to real tools; partial means useful pieces exist but production-grade flow is incomplete.",
      nextUpgrade: "Pick one use case and drive it from partial to ready with a real end-to-end smoke test.",
    };
  }

  getDesignPrinciplesStatus(context = {}) {
    const config = this.configStore.getConfig();
    const provider = this.agentRuntime?.getProviderInfo?.() || {};
    const workspaceContext = this.agentRuntime?.loadWorkspaceContext?.(this.getAgentId(context)) || { files: [] };
    const shellAudit = this.agentRuntime?.shellAudit?.getOverview?.() || {};
    return {
      agentId: this.getAgentId(context),
      principles: [
        {
          id: "openai_compatible_everywhere",
          status: provider.mode === "openai-compatible" || provider.mode === "account-bridge" ? "partial" : "seeded",
          evidence: `provider=${provider.id || "unknown"}, mode=${provider.mode || config.provider?.mode || "unknown"}`,
          gap: "Provider-native schemas and all 200+ provider quirks are not fully normalized yet.",
        },
        {
          id: "stateless_prompt_assembly",
          status: "partial",
          evidence: `${workspaceContext.files?.length || 0} context file(s), prompt assembly status tool, injection scans`,
          gap: "Some runtime assembly still lives in Agent methods; extract smaller pure prompt-builder modules next.",
        },
        {
          id: "one_external_memory_plugin",
          status: "ready",
          evidence: "built-in memory store is primary; no conflicting external memory provider enabled",
          gap: "Optional Honcho-style external provider interface is not wired.",
        },
        {
          id: "trajectories_skip_ephemeral_data",
          status: "partial",
          evidence: "trajectory_training_status marks skipContextFiles=true and excludes identity files by policy",
          gap: "JSONL exporter/redactor still needs implementation.",
        },
        {
          id: "idempotent_tool_calls",
          status: "partial",
          evidence: `${shellAudit.total || 0} shell audit record(s), gateway event/run ids, durable job records`,
          gap: "Large tool outputs are not yet always persisted by content hash and replayed by id.",
        },
        {
          id: "platform_aware_formatting",
          status: "partial",
          evidence: "gateway adapters have platform metadata and prompt assembly includes platform hints",
          gap: "Per-platform formatter for Telegram/Discord/CLI output needs final routing.",
        },
      ],
      rule: "Design principles are guardrails for implementation, not marketing claims.",
      nextUpgrade: "Add trajectory exporter + idempotent artifact store, then wire platform-aware response formatting per adapter.",
    };
  }

  scanPromptContextText(value = "") {
    const text = String(value || "");
    const findings = [];
    const checks = [
      { id: "ignore-previous-instructions", pattern: /ignore (all )?(previous|prior|above) (instructions|rules|messages)/i },
      { id: "disregard-previous-instructions", pattern: /disregard (all )?(previous|prior|above) (instructions|rules|messages)/i },
      { id: "system-prompt-exfiltration", pattern: /reveal (your )?(instructions|prompt|system)|system prompt/i },
      { id: "role-rewrite", pattern: /you are now|act as|do not obey/i },
      { id: "hidden-html", pattern: /<script[\s>]|<iframe[\s>]|display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0/i },
      { id: "invisible-unicode", pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u },
    ];
    for (const check of checks) {
      if (check.pattern.test(text)) {
        findings.push(check.id);
      }
    }
    return findings;
  }

  getPromptAssemblyStatus(context = {}) {
    const agentId = this.getAgentId(context);
    const agent = this.agentRegistry?.resolveAgent?.(agentId) || null;
    const profile = agent ? this.configStore.getProfile(agent.profileId) : this.configStore.getActiveProfile();
    const workspaceContext = this.agentRuntime?.loadWorkspaceContext?.(agentId) || { files: [] };
    const files = Array.isArray(workspaceContext.files) ? workspaceContext.files : [];
    const scanned = files.map((file) => ({
      name: file.name || "",
      scope: file.scope || "",
      path: file.path || "",
      chars: String(file.content || "").length,
      findings: this.scanPromptContextText(file.content || ""),
    }));
    const suspicious = scanned.filter((file) => file.findings.length > 0);
    return {
      agentId,
      profile: profile?.id || "balanced",
      maxContextChars: this.agentRuntime?.contextEngine?.getMaxChars?.(profile || {}) || 0,
      assembly: [
        "DEFAULT_AGENT_IDENTITY / runtime identity",
        "SOUL.md / USER.md / PROFILE.md",
        "Project context discovery: .hermes.md, HERMES.md, AGENTS.md, .cursorrules",
        "Skills index and tool schema",
        "Memory context and session summary",
        "Platform hints and heartbeat behavior",
      ],
      defenses: {
        promptInjectionScan: true,
        invisibleUnicodeScan: true,
        hiddenHtmlScan: true,
        untrustedContextTags: true,
      },
      files: scanned,
      suspiciousCount: suspicious.length,
      suspicious: suspicious.slice(0, 12),
      rule: "Workspace/project context is injected as untrusted data. Suspicious phrases are blocked in the final system prompt instead of treated as instructions.",
    };
  }

  resolvePatchRelativePath(inputPath, { workspaceOnly = true } = {}) {
    const root = this.fileStore?.rootDir || this.getRootDir();
    const text = String(inputPath || "").trim();
    if (!text) {
      throw new Error("Patch file path is required.");
    }
    const absolute = path.resolve(path.isAbsolute(text) ? text : path.join(root, text));
    const relative = path.relative(path.resolve(root), absolute);
    if (workspaceOnly && (relative.startsWith("..") || path.isAbsolute(relative))) {
      throw new Error(`Patch path is outside the workspace: ${text}`);
    }
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("OmniClaw apply_patch currently supports workspace-contained writes only.");
    }
    return relative.replace(/\\/g, "/");
  }

  applyStructuredPatch(input = {}, files = null) {
    // Scoped store for per-chat binding (defaults to the shared store, which
    // keeps global behavior for session-less callers). All paths below stay
    // workspace-contained relative to whichever root is in effect.
    const store = files || this.fileStore;
    const patchText = String(input.input || input.patch || "");
    const dryRun = input.dryRun === true || input.apply === false;
    const config = this.configStore.getConfig();
    const workspaceOnly = config.tools?.exec?.applyPatch?.workspaceOnly !== false;
    const writableRoots = Array.isArray(config.tools?.filesystem?.writableRoots)
      ? config.tools.filesystem.writableRoots
      : ["."];
    const operations = parseStructuredPatchInput(patchText);
    const results = [];

    for (const operation of operations) {
      const relativePath = this.resolvePatchRelativePath(operation.path, { workspaceOnly });
      if (operation.kind === "add") {
        const target = store.resolveWorkspacePath(relativePath);
        if (fs.existsSync(target) && input.overwrite !== true) {
          throw new Error(`Patch add target already exists: ${relativePath}`);
        }
        if (!dryRun) {
          store.writeText(relativePath, operation.content, {
            allowedRoots: writableRoots,
            append: false,
          });
        }
        results.push({
          kind: "add",
          path: relativePath,
          bytes: Buffer.byteLength(operation.content, "utf8"),
          applied: !dryRun,
        });
        continue;
      }

      if (operation.kind === "delete") {
        const target = store.resolveWorkspacePath(relativePath);
        const exists = fs.existsSync(target);
        if (!exists) {
          throw new Error(`Patch delete target does not exist: ${relativePath}`);
        }
        if (!dryRun) {
          fs.rmSync(target, { recursive: false, force: false });
        }
        results.push({
          kind: "delete",
          path: relativePath,
          existed: exists,
          applied: !dryRun,
        });
        continue;
      }

      if (operation.kind === "update") {
        const read = store.readText(relativePath, Math.max(config.tools?.filesystem?.maxReadBytes || 65536, 1024 * 1024));
        const next = applyPatchHunksToContent(read.content, operation.hunks, relativePath);
        const targetPath = operation.moveTo
          ? this.resolvePatchRelativePath(operation.moveTo, { workspaceOnly })
          : relativePath;
        if (!dryRun) {
          store.writeText(targetPath, next.content, {
            allowedRoots: writableRoots,
            append: false,
          });
          if (operation.moveTo && operation.moveTo !== operation.path) {
            fs.rmSync(store.resolveWorkspacePath(relativePath), { force: false });
          }
        }
        results.push({
          kind: operation.moveTo ? "move-update" : "update",
          path: relativePath,
          targetPath,
          hunks: next.appliedHunks,
          bytes: Buffer.byteLength(next.content, "utf8"),
          applied: !dryRun,
        });
      }
    }

    return {
      ok: true,
      applied: !dryRun,
      dryRun,
      operationCount: results.length,
      changedPaths: [...new Set(results.flatMap((item) => [item.path, item.targetPath].filter(Boolean)))],
      operations: results,
      rule: "Patch paths are workspace-contained by default. After patching code, run a read/build/test tool before finalizing.",
    };
  }

  getRootDir() {
    return this.agentRuntime?.rootDir || this.fileStore?.rootDir || process.cwd();
  }

  // Per-chat project root for model-invoked tools: the session's own folder
  // when its record has one, else the currently selected folder. Calls
  // without a session (panels, probes, operator routes) keep old behavior.
  chatRoot(context) {
    try {
      const root = this.agentRuntime?.getChatRoot?.(context?.sessionId);
      if (root) return root;
    } catch {}
    return this.fileStore?.rootDir || process.cwd();
  }

  // Session read-cache key: delegates to the shared normalizer so the
  // registry-side checker always agrees byte-for-byte with the agent-side
  // ledger builder (same session workspace root, same canonicalization).
  ledgerKeyFor(context, p) {
    let root = "";
    try {
      root = this.chatRoot(context) || this.fileStore?.rootDir || "";
    } catch {}
    return normalizeLedgerKey(root, p);
  }

  readSessionLedger(context) {
    try {
      const sid = String(context?.sessionId || "").trim();
      if (!sid) return null;
      return this.agentRuntime?.sessions?.getEvidenceLedger?.(sid) || null;
    } catch {
      return null;
    }
  }

  writeSessionLedger(context, ledger) {
    try {
      const sid = String(context?.sessionId || "").trim();
      if (!sid || !ledger) return;
      this.agentRuntime?.sessions?.updateSession?.(sid, { evidenceLedger: ledger });
    } catch { /* best effort; normalizeSession validates + caps */ }
  }

  // D shortcut: bare re-read of a stat-unchanged file returns a pointer.
  // mtime+size match only (no content hash — hashing would require the read
  // we're skipping); write-path invalidation below is the correctness
  // backstop, forceRead the escape hatch.
  checkUnchangedRead(filePath, context) {
    try {
      const ledger = this.readSessionLedger(context);
      const files = ledger?.files && typeof ledger.files === "object" ? ledger.files : null;
      if (!files) return null;
      const key = this.ledgerKeyFor(context, filePath);
      const entry = files[key];
      if (!entry) return null;
      let st = null;
      try {
        st = fs.statSync(path.resolve(this.chatRoot(context) || ".", String(filePath || "")));
      } catch {
        return null;
      }
      if (!st || (st.mtimeMs || 0) !== (entry.mtimeMs || 0) || st.size !== (entry.size || 0)) return null;
      const full = typeof entry.content === "string" && entry.content ? entry.content
        : typeof entry.head === "string" ? entry.head : "";
      const head = full ? `\nContent (${entry.size || 0}B, unchanged):\n${full}` : "";
      return {
        path: String(filePath || ""),
        unchanged: true,
        sinceTurn: entry.turn ?? "?",
        size: entry.size || 0,
        about: entry.about || "",
        message: `Unchanged since turn ${entry.turn ?? "?"} (mtime+size match). What it contains: ${entry.about || "see ledger"}.${head} The content above is current — work from it. To force a fresh read: read_file {"path":"${String(filePath || "")}","forceRead":true}.`,
      };
    } catch {
      return null;
    }
  }

  // D invalidation: any write-ish tool drops its paths from the ledger cache
  // immediately (correctness first — a same-millisecond same-size rewrite
  // could otherwise slip past mtime checks).
  invalidateLedgerPaths(context, paths = []) {
    try {
      const ledger = this.readSessionLedger(context);
      if (!ledger || !ledger.files) return;
      let changed = false;
      for (const p of paths) {
        const s = String(p || "").trim();
        if (!s) continue;
        const key = this.ledgerKeyFor(context, s);
        if (Object.hasOwn(ledger.files, key)) {
          delete ledger.files[key];
          changed = true;
        }
      }
      if (changed) this.writeSessionLedger(context, ledger);
    } catch { /* best effort */ }
  }

  // Exec-class tools can change anything: invalidate ledger entries whose
  // path (or basename) appears in the command text. Commands naming no known
  // path (git status, ls) invalidate nothing — sources on disk are untouched.
  invalidateLedgerForCommand(context, command = "") {
    try {
      const ledger = this.readSessionLedger(context);
      const files = ledger?.files && typeof ledger.files === "object" ? ledger.files : null;
      if (!files) return;
      const cmd = String(command || "").toLowerCase();
      if (!cmd) return;
      const hit = [];
      for (const key of Object.keys(files)) {
        const base = key.split("/").pop() || "";
        if ((key && cmd.includes(key)) || (base && base.length >= 4 && cmd.includes(base))) hit.push(key);
      }
      if (hit.length > 0) {
        for (const key of hit) delete files[key];
        this.writeSessionLedger(context, ledger);
      }
    } catch { /* best effort */ }
  }

  // Scoped FileStore view for workspace file tools. Cheap (the constructor
  // only takes rootDir) and race-free across concurrent runs in different
  // chats — unlike mutating the shared store's rootDir per call. Harness
  // tools that manage OmniClaw's own repo files keep using this.fileStore.
  chatFiles(context) {
    const base = this.fileStore;
    if (!base) return base;
    const root = this.chatRoot(context);
    if (!root) return base;
    try {
      if (path.resolve(root) === path.resolve(base.rootDir)) return base;
    } catch {
      return base;
    }
    return new base.constructor(root);
  }

  // Resolve a caller-supplied cwd/path against the chat's project root.
  // Fail closed with the project named, so the model learns where it is.
  chatCwd(cwd, context) {
    const root = this.chatRoot(context);
    const requested = String(cwd || "").trim();
    const target = requested
      ? (path.isAbsolute(requested) ? path.normalize(requested) : path.join(root, requested))
      : root;
    let rel = "";
    try {
      rel = path.relative(path.resolve(root), path.resolve(target));
    } catch {
      return { ok: false, error: `Path is outside the selected project: ${root}` };
    }
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
      return { ok: false, error: `Path is outside the selected project: ${root}` };
    }
    return { ok: true, cwd: target };
  }

  getOpenClawRoot() {
    return path.join(this.getRootDir(), "vendor", "openclaw");
  }

  getHermesRoot() {
    return path.join(this.getRootDir(), "vendor", "hermes-agent");
  }

  getOpenClawVendorStatus() {
    const root = this.getOpenClawRoot();
    const packagePath = path.join(root, "package.json");
    const licensePath = path.join(root, "LICENSE");
    const gitPath = path.join(root, ".git");
    const packageJson = fs.existsSync(packagePath)
      ? JSON.parse(fs.readFileSync(packagePath, "utf8"))
      : {};
    return {
      available: fs.existsSync(root),
      path: root,
      gitLinked: fs.existsSync(gitPath),
      packageName: packageJson.name || "",
      version: packageJson.version || "",
      license: packageJson.license || (fs.existsSync(licensePath) ? "present" : ""),
      docsPresent: fs.existsSync(path.join(root, "docs")),
      skillsPresent: fs.existsSync(path.join(root, "skills")),
      extensionsPresent: fs.existsSync(path.join(root, "extensions")),
      recommendedMode: "reference-submodule",
      nextActions: [
        "Use openclaw_skill_scan to find donor skills.",
        "Use openclaw_skill_import for selected skills only.",
        "Use docs/OPENCLAW_TO_OMNICLAW_TRANSPLANT_MAP.md for layer-by-layer runtime work.",
      ],
    };
  }

  countFilesUnder(dir, { extensions = null, max = 50000 } = {}) {
    if (!fs.existsSync(dir)) {
      return 0;
    }
    let count = 0;
    const stack = [dir];
    const allowed = Array.isArray(extensions) ? new Set(extensions.map((item) => item.toLowerCase())) : null;
    while (stack.length > 0 && count < max) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (["node_modules", ".git", "dist", "target", ".next"].includes(entry.name)) {
          continue;
        }
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolutePath);
        } else if (!allowed || allowed.has(path.extname(entry.name).toLowerCase())) {
          count += 1;
          if (count >= max) break;
        }
      }
    }
    return count;
  }

  listOpenClawExtensionCatalog(limit = 140) {
    const extensionsDir = path.join(this.getOpenClawRoot(), "extensions");
    if (!fs.existsSync(extensionsDir)) {
      return [];
    }
    return fs.readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const extensionDir = path.join(extensionsDir, entry.name);
        const manifestPath = path.join(extensionDir, "openclaw.plugin.json");
        const packagePath = path.join(extensionDir, "package.json");
        const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
        const packageJson = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, "utf8")) : {};
        const name = entry.name;
        const category = this.classifyOpenClawExtension(name, manifest, packageJson);
        return {
          id: name,
          category,
          title: manifest.displayName || manifest.name || packageJson.name || name,
          description: manifest.description || packageJson.description || "",
          hasManifest: fs.existsSync(manifestPath),
          hasPackage: fs.existsSync(packagePath),
          tsFiles: this.countFilesUnder(extensionDir, { extensions: [".ts", ".tsx"], max: 2000 }),
          skillFiles: this.walkOpenClawSkillFiles(extensionDir, []).length,
        };
      })
      .sort((left, right) => left.category.localeCompare(right.category) || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(Number(limit) || 140, 300)));
  }

  classifyOpenClawExtension(name, manifest = {}, packageJson = {}) {
    const text = [name, manifest.name, manifest.description, packageJson.description].join(" ").toLowerCase();
    if (/telegram|whatsapp|discord|slack|signal|imessage|bluebubbles|matrix|mattermost|feishu|line|messenger|teams|googlechat|irc|nostr|qqbot|twitch|nextcloud|synology/.test(text)) {
      return "channel";
    }
    if (/openai|anthropic|deepseek|groq|nvidia|minimax|moonshot|qwen|mistral|ollama|openrouter|together|fireworks|bedrock|azure|vertex|gemini|huggingface|cerebras|perplexity|litellm|vllm|lmstudio|venice|qianfan/.test(text)) {
      return "model-provider";
    }
    if (/brave|duckduckgo|exa|firecrawl|searxng|tavily|web|readability/.test(text)) {
      return "web-search";
    }
    if (/speech|tts|audio|voice|deepgram|elevenlabs|senseaudio|talk/.test(text)) {
      return "speech";
    }
    if (/image|video|music|fal|comfy|runway|media/.test(text)) {
      return "media";
    }
    if (/memory|lancedb|wiki|active-memory/.test(text)) {
      return "memory";
    }
    if (/browser|phone|device|pair|file-transfer|diffs|codex|opencode|mcp|acp|qa|diagnostics|webhooks/.test(text)) {
      return "tooling";
    }
    return "other";
  }

  getOpenClawCodeStudy({ includeExtensions = true, includeCore = true, limit = 140 } = {}) {
    const root = this.getOpenClawRoot();
    const studyGuidePath = path.join(os.homedir(), "Downloads", "OMNICLAW_STUDY_GUIDE.md");
    const coreDirs = includeCore && fs.existsSync(path.join(root, "src"))
      ? fs.readdirSync(path.join(root, "src"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = path.join(root, "src", entry.name);
          return {
            name: entry.name,
            tsFiles: this.countFilesUnder(dir, { extensions: [".ts", ".tsx"], max: 5000 }),
            mappedToOmniClaw: this.mapOpenClawCoreDir(entry.name),
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const extensions = includeExtensions ? this.listOpenClawExtensionCatalog(limit) : [];
    const categories = extensions.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    }, {});
    const keyFiles = [
      "openclaw.mjs",
      "src/entry.ts",
      "src/agents/index.ts",
      "src/gateway/index.ts",
      "src/channels/base.ts",
      "src/config/index.ts",
      "src/plugin-sdk/index.ts",
    ].map((relative) => ({
      path: relative,
      exists: fs.existsSync(path.join(root, relative)),
    }));
    const implementationPlan = [
      {
        phase: 1,
        name: "Study and catalog",
        status: "implemented-now",
        action: "openclaw_code_study maps core dirs, extensions, key files, and safe import points.",
      },
      {
        phase: 2,
        name: "Safe skill transplant",
        status: "available",
        action: "openclaw_skill_scan/openclaw_skill_import imports SKILL.md guidance into OmniClaw agents.",
      },
      {
        phase: 3,
        name: "Provider/channel setup parity",
        status: "next",
        action: "Turn OpenClaw extension manifests into OmniClaw provider/channel setup cards and token flows.",
      },
      {
        phase: 4,
        name: "Runtime parity",
        status: "next",
        action: "Port selected working adapters one by one: Telegram, browser, web-search, memory, media.",
      },
      {
        phase: 5,
        name: "Hard sandbox/product installer",
        status: "next",
        action: "Installer, permissions, sandbox, and auto-update must be native OmniClaw code, not blind copied.",
      },
    ];
    return {
      source: "vendor/openclaw",
      available: fs.existsSync(root),
      root,
      studyGuide: {
        path: studyGuidePath,
        present: fs.existsSync(studyGuidePath),
        chars: fs.existsSync(studyGuidePath) ? fs.readFileSync(studyGuidePath, "utf8").length : 0,
      },
      stats: {
        coreDirCount: coreDirs.length,
        extensionCount: extensions.length,
        categoryCounts: categories,
        skillFiles: this.getOpenClawSkillFiles("all").length,
        tsFilesApprox: this.countFilesUnder(root, { extensions: [".ts", ".tsx"], max: 20000 }),
      },
      keyFiles,
      coreDirs,
      extensions: extensions.slice(0, 80),
      implementationPlan,
      rule: "OpenClaw code is a reference donor. OmniClaw should port compatible patterns/adapters with tests, not paste the full repo into runtime.",
    };
  }

  mapOpenClawCoreDir(name) {
    const map = {
      agents: "src/core/agent.js + tool loop + sub-agent spawner",
      gateway: "src/core/ws-gateway.js + connector-store + session routing",
      channels: "connectors/adapters + Telegram/Discord workers",
      tools: "src/core/tool-registry.js aliases and native tools",
      terminal: "run_terminal_command + sandbox-runner + process monitor",
      "web-search": "src/core/web-research.js providers/fallbacks",
      "web-fetch": "src/core/web-research.js fetchUrl/read_url",
      memory: "memory-store + long-term memory + dream sweep",
      "context-engine": "src/core/context-engine.js + summarizer",
      sessions: "session-store transcripts and session search",
      config: "config-store + provider profiles + BYOK UI",
      secrets: "secret-store provider/connector keys",
      security: "approval store + shell policy + computer access guard",
      plugins: "OpenClaw extension catalog -> OmniClaw plugin plan",
      "plugin-sdk": "future OmniClaw plugin SDK",
      cron: "job-store + background-worker",
      pairing: "trust-store pairing requests",
      media: "connector attachment cache + media analysis",
      tts: "text_to_speech placeholder -> provider plugin",
      "image-generation": "image_generate LIVE (provider profile or free fallback via media engine)",
      "video-generation": "video_analyze/video provider placeholders",
    };
    return map[name] || "not mapped yet";
  }

  getHermesVendorStatus() {
    const root = this.getHermesRoot();
    const packagePath = path.join(root, "pyproject.toml");
    const licensePath = path.join(root, "LICENSE");
    const readmePath = path.join(root, "README.md");
    const packageText = fs.existsSync(packagePath) ? fs.readFileSync(packagePath, "utf8") : "";
    const version = packageText.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1] || "";
    const name = packageText.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] || "hermes-agent";
    const skillFiles = this.getHermesSkillFiles().length;
    return {
      available: fs.existsSync(root),
      path: root,
      gitLinked: fs.existsSync(path.join(root, ".git")),
      packageName: name,
      version,
      license: fs.existsSync(licensePath) ? "MIT" : "",
      licensePath: fs.existsSync(licensePath) ? path.relative(this.getRootDir(), licensePath).replace(/\\/g, "/") : "",
      readmePresent: fs.existsSync(readmePath),
      skillsPresent: fs.existsSync(path.join(root, "skills")),
      gatewayPresent: fs.existsSync(path.join(root, "gateway")),
      cliPresent: fs.existsSync(path.join(root, "hermes_cli")),
      agentRuntimePresent: fs.existsSync(path.join(root, "agent")),
      skillFileCount: skillFiles,
      recommendedMode: "copied-reference-vendor",
      nextActions: [
        "Use hermes_skill_scan to find donor skills.",
        "Import only compatible skills/patterns; do not run Hermes Python code inside OmniClaw without an adapter.",
        "Use docs/HERMES_AGENT_REFERENCE.md for layer-by-layer runtime work.",
      ],
    };
  }

  walkOpenClawSkillFiles(dir, output = []) {
    if (!fs.existsSync(dir)) {
      return output;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "dist"].includes(entry.name)) {
          continue;
        }
        this.walkOpenClawSkillFiles(absolutePath, output);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        output.push(absolutePath);
      }
    }
    return output;
  }

  getOpenClawSkillFiles(source = "skills") {
    const root = this.getOpenClawRoot();
    const normalized = String(source || "skills").trim().toLowerCase();
    const roots = [];
    if (normalized === "skills" || normalized === "all") {
      roots.push(path.join(root, "skills"));
    }
    if (normalized === "extensions" || normalized === "all") {
      roots.push(path.join(root, "extensions"));
    }
    return roots.flatMap((item) => this.walkOpenClawSkillFiles(item));
  }

  getHermesSkillFiles() {
    const root = this.getHermesRoot();
    return this.walkOpenClawSkillFiles(path.join(root, "skills"));
  }

  scanHermesSkills({ query = "", limit = 40 } = {}) {
    const rootDir = this.getRootDir();
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    const skills = this.getHermesSkillFiles()
      .map((filePath) => parseOpenClawSkill(fs.readFileSync(filePath, "utf8"), filePath, rootDir))
      .filter((skill) => {
        if (!normalizedQuery) {
          return true;
        }
        return [skill.name, skill.description, skill.path].join(" ").toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, safeLimit)
      .map(({ absolutePath, instructions, ...skill }) => ({
        ...skill,
        source: "hermes-agent",
        instructionChars: instructions.length,
      }));
    return {
      source: "hermes-agent",
      query,
      count: skills.length,
      totalAvailable: this.getHermesSkillFiles().length,
      skills,
    };
  }

  scanOpenClawSkills({ query = "", source = "skills", limit = 40 } = {}) {
    const rootDir = this.getRootDir();
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 40, 200));
    const skills = this.getOpenClawSkillFiles(source)
      .map((filePath) => parseOpenClawSkill(fs.readFileSync(filePath, "utf8"), filePath, rootDir))
      .filter((skill) => {
        if (!normalizedQuery) {
          return true;
        }
        return [skill.name, skill.description, skill.path].join(" ").toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, safeLimit)
      .map(({ absolutePath, instructions, ...skill }) => ({
        ...skill,
        instructionChars: instructions.length,
      }));
    return {
      source,
      query,
      count: skills.length,
      skills,
    };
  }

  importOpenClawSkillPack(input = {}, context = {}) {
    const packId = String(input.pack || "v2_core").trim();
    const pack = OPENCLAW_COMPAT_SKILL_PACKS[packId];
    if (!pack) {
      return {
        imported: false,
        reason: `Unknown OpenClaw skill pack: ${packId}`,
        availablePacks: Object.keys(OPENCLAW_COMPAT_SKILL_PACKS),
      };
    }

    const dryRun = Boolean(input.dryRun);
    const defaultAgentId = input.agentId || this.getAgentId(context);
    const items = pack.map((item) => ({
      ...item,
      agents: Array.isArray(input.agents) && input.agents.length > 0 ? input.agents : item.agents,
    }));

    if (dryRun) {
      return {
        imported: false,
        dryRun: true,
        pack: packId,
        count: items.length,
        skills: items.map(({ name, path: skillPath, importName, triggers, agents, reason }) => ({
          name,
          path: skillPath,
          importName,
          triggers,
          agents,
          reason,
        })),
      };
    }

    const results = [];
    for (const item of items) {
      try {
        results.push({
          ok: true,
          reason: item.reason,
          result: this.importOpenClawSkill({
            path: item.path,
            importName: item.importName,
            triggers: item.triggers,
            agents: item.agents,
            agentId: defaultAgentId,
            description: `${item.reason} Imported from OpenClaw ${item.path}.`,
          }, context),
        });
      } catch (error) {
        results.push({
          ok: false,
          name: item.name,
          path: item.path,
          reason: item.reason,
          error: error.message,
        });
      }
    }

    return {
      imported: results.filter((item) => item.ok && item.result?.imported).length,
      failed: results.filter((item) => !item.ok || item.result?.imported === false).length,
      pack: packId,
      results,
      nextActions: [
        "Ask 'tumhare paas kaun si skills hain demo do' to force capability_demo.",
        "Use imported skills only as operating guidance; tools still execute through OmniClaw runtime definitions.",
        "Keep transplanting OpenClaw features selectively from docs/OPENCLAW_TO_OMNICLAW_TRANSPLANT_MAP.md.",
      ],
    };
  }

  importOpenClawSkill(input = {}, context = {}) {
    const rootDir = this.getRootDir();
    const requestedPath = String(input.path || "").trim().replace(/\\/g, "/");
    const requestedName = String(input.name || "").trim().toLowerCase();
    const matches = this.getOpenClawSkillFiles(input.source || "all")
      .map((filePath) => parseOpenClawSkill(fs.readFileSync(filePath, "utf8"), filePath, rootDir))
      .filter((skill) => {
        if (requestedPath) {
          return skill.path === requestedPath || skill.path.endsWith(`/${requestedPath}`);
        }
        return requestedName && skill.name.toLowerCase() === requestedName;
      });

    if (matches.length === 0) {
      throw new Error("OpenClaw skill not found. Use openclaw_skill_scan first and pass the exact path.");
    }
    if (matches.length > 1) {
      return {
        imported: false,
        reason: "Multiple skills matched. Pass exact path.",
        matches: matches.map((skill) => ({ name: skill.name, path: skill.path, description: skill.description })),
      };
    }

    const skill = matches[0];
    const triggers = Array.isArray(input.triggers) && input.triggers.length > 0
      ? input.triggers
      : [skill.name, ...skill.name.split(/[-_\s]+/)].map((item) => item.trim()).filter(Boolean);
    const imported = this.customizationEngine.createSkill({
      name: input.importName || `OpenClaw ${skill.name}`,
      triggers: [...new Set(triggers.map((item) => item.toLowerCase()))],
      description: input.description || `Imported from OpenClaw ${skill.path}. ${skill.description}`.trim(),
      instructions: [
        "Compatibility note: this skill was imported from the vendored OpenClaw reference. Map OpenClaw tool names to OmniClaw runtime tools that are visible in the current prompt; do not claim missing plugins are installed.",
        "",
        `Imported from OpenClaw vendor path: ${skill.path}`,
        "",
        skill.instructions,
      ].join("\n"),
      agentId: input.agentId || this.getAgentId(context),
      agents: input.agents,
    });
    return {
      imported: true,
      source: {
        name: skill.name,
        path: skill.path,
        description: skill.description,
      },
      target: imported,
      id: slugify(input.importName || `OpenClaw ${skill.name}`),
    };
  }
}
