// MUST stay the first import: fixes the NAT64/Happy-Eyeballs connect stall that
// silently broke Telegram and every forged-tool fetch. See network-bootstrap.js.
import "./src/core/network-bootstrap.js";

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawn } from "node:child_process";

import { OmniClawAgent } from "./src/core/agent.js";
import { attachWsGateway } from "./src/core/ws-gateway.js";
import { OpenAICompatibleAPI } from "./src/core/openai-api.js";
import { GatewayWSProtocol } from "./src/core/gateway-ws-protocol.js";
import { acquireLiveTab, browserLaunchStatus, managedClient, managedAttach, managedListTabs } from "./src/core/browser-remote-tools.js";
import { launchDebugBrowser, reapStaleManagedBrowsers, claimBrowserOwnership } from "./src/core/browser-launcher.js";
import { onBrowserAction, recentBrowserActions } from "./src/core/browser-activity-bus.js";
import { APPROVAL_TTL_MS, APPROVAL_TOOL_TIMEOUT_MS } from "./src/core/gateway-store.js";
import { TOOLSETS, CORE_ORDER, ALIAS_OF, DROP_IDS } from "./src/core/tool-layers.js";
import { loadModelRegistry } from "./src/core/model-registry.js";
import { describeCacheSupport } from "./src/core/providers/openai-compatible-provider.js";

// ─── CORS ──────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Omniclaw-Token, X-Connector-Token",
  "Access-Control-Max-Age": "86400",
};

// ─── Rate Limiter (server.js:28-…) ────────────────────────────────────
// Env knobs (no config-file path exists for these, so env it is):
//   OMNICLAW_RATE_MAX          — /api/* + /v1/* default (default 60)
//   OMNICLAW_RATE_MAX_LOOPBACK — same, for loopback clients (default 300)
// Static disk assets (/next/*, public/ files, /) bypass the limiter entirely:
// a page load is ~30 files and must never eat the API budget. SSE/streaming
// routes (/api/chat/stream, /api/events, /api/browser/live) are single HTTP
// requests — they count ONCE at open by construction (packets are res.write,
// never re-enter this handler).
const rateLimitMap = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX = Number(process.env.OMNICLAW_RATE_MAX || 60);
const RATE_MAX_LOOPBACK = Number(process.env.OMNICLAW_RATE_MAX_LOOPBACK || 300);
const STATIC_EXTS = new Set([
  "js", "css", "html", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico",
  "woff", "woff2", "map", "json", "txt",
]);
function isLoopbackIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function isStaticAsset(pathname, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  // API routes are always limited, even if they ever grew a dotted tail.
  if (pathname.startsWith("/api/") || pathname.startsWith("/v1/")) return false;
  if (pathname === "/" || pathname === "/next" || pathname === "/next/") return true;
  if (pathname.startsWith("/next/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/favicon.svg") return true;
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  if (dot > slash) {
    const ext = pathname.slice(dot + 1).toLowerCase();
    if (STATIC_EXTS.has(ext)) return true;
  }
  return false;
}
function checkRateLimit(ip) {
  const max = isLoopbackIp(ip) ? RATE_MAX_LOOPBACK : RATE_MAX;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1, max });
    return { allowed: true, remaining: max - 1, max };
  }
  entry.count++;
  entry.max = max;
  if (entry.count > max) return { allowed: false, remaining: 0, max };
  return { allowed: true, remaining: max - entry.count, max };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimitMap) {
    if (now - e.start > RATE_WINDOW * 2) rateLimitMap.delete(ip);
  }
}, 120_000);

// ─── Graceful Shutdown ──────────────────────────────────────────────
let isShuttingDown = false;
function gracefulShutdown(sig) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nOmniClaw shutting down (${sig})...`);
  // Every browser we started is spawned detached, so it does NOT die with this
  // process. Without this the user accumulates one orphan Chrome per run, and
  // the machine that notices the problem is the one that stops responding.
  try { agent.browserOperator?.closeBrowser?.(); } catch { /* best effort */ }
  try { agent.browserPlaywright?.closeAll?.(); } catch { /* best effort */ }
  if (typeof server !== "undefined") {
    server.close(() => { console.log("All connections closed."); process.exit(0); });
    setTimeout(() => { console.log("Force exit (5s timeout)."); process.exit(1); }, 5000);
  } else {
    process.exit(0);
  }
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Covers the window-close path on Windows, where no signal is delivered.
process.on("exit", () => {
  try { agent.browserOperator?.browserProcess?.kill?.(); } catch { /* best effort */ }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourceDir = __dirname;
const runtimeDir = process.pkg
  ? process.cwd()
  : path.resolve(process.env.OMNICLAW_ROOT_DIR || sourceDir);
const publicDir = path.join(process.pkg ? runtimeDir : sourceDir, "public");
const webNextDir = path.join(process.pkg ? runtimeDir : sourceDir, "web-next");

// R11: isolated verification instances set OMNICLAW_DATA_DIR to a scratch dir
// (e.g. ./.tmp-test-data) so tests never touch live config/sessions/secrets.
// publicDir/webNextDir stay on the source tree; only agent state moves.
const appDir = path.resolve(process.env.OMNICLAW_DATA_DIR || runtimeDir);
const agent = new OmniClawAgent({
  rootDir: appDir,
  sourceDir,
});
// No top-level await: the pkg/esbuild sidecar bundle is CJS. The HTTP server
// only starts listening once this promise resolves (see server.listen below).
// The stale-browser reaper is chained in so it has definitely finished before
// the first request can launch a browser — its whole job is to run when nothing
// of ours is alive, and a half-finished reaper racing our own launch is worse
// than not reaping at all.
const agentReady = agent.start()
  .then(() => reapedBrowsers)
  .catch((error) => {
    console.error(`OmniClaw agent failed to start: ${error.message}`);
    process.exit(1);
  });

// Reap a managed browser left behind by a DEAD previous run. This is anchored
// to startup rather than to shutdown on purpose: on Windows a killed or crashed
// process never runs its shutdown handlers, so a browser spawned detached
// outlives it and every abnormal exit would otherwise leave another one running
// until the user rebooted. The reaper is ownership-aware, so a second live
// OmniClaw keeps its own browser.
//
// Awaited (not fired-and-forgotten) so it finishes before the server can serve a
// request that launches a browser — otherwise this process's own reaper could
// race its own launch.
// Claim reaping rights BEFORE reaping: a live instance (this one) must own the
// record so a second OmniClaw started alongside it leaves our browsers alone.
// Dev server beside the packaged exe is a normal setup, not an edge case.
claimBrowserOwnership?.();

const reapedBrowsers = reapStaleManagedBrowsers?.()
  .then((result) => {
    if (result?.killed) {
      console.log(`Reaped ${result.killed} stale browser process(es) from a previous run (${result.reason}).`);
    }
    return result;
  })
  .catch(() => null);   // best effort: never block startup
const openaiAPI = new OpenAICompatibleAPI(agent);
const eventClients = new Set();

const port = Number(process.env.PORT || 3147);

function sendJson(res, statusCode, payload) {
  // Never write twice — a double-send (e.g. a handler that already replied then
  // falls through to the 404) would throw ERR_HTTP_HEADERS_SENT and, being
  // async/unhandled, crash the whole process. Guard makes it a safe no-op.
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendOAuthCallbackPage(res, { ok, message }) {
  if (res.headersSent || res.writableEnded) return;
  const safeMessage = String(message || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>OmniClaw connected apps</title><style>body{font-family:Segoe UI,system-ui,sans-serif;background:#101827;color:#edf2ff;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:480px;padding:32px;border:1px solid #334155;border-radius:18px;background:#172033;box-shadow:0 18px 60px #0008}h1{margin:0 0 10px;font-size:22px}.ok{color:#4ade80}.bad{color:#fca5a5}p{color:#b8c3d9;line-height:1.55}button{margin-top:14px;background:#6d7cff;color:white;border:0;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer}</style></head><body><main class="card"><h1 class="${ok ? "ok" : "bad"}">${ok ? "Connected" : "Connection failed"}</h1><p>${safeMessage}</p><button onclick="window.close()">Close this window</button></main></body></html>`);
}

function truncateHttpText(value = "", maxChars = 1200) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}...[truncated ${text.length - maxChars} chars]`;
}

// B1: loopback gate for new local-only routes (R12). Reuses isLoopbackIp
// (line 45, from the rate limiter). No per-route token scheme exists for
// these (/provider/* relies on global checkAuth instead), so loopback is the
// boundary. x-forwarded-for is never trusted.
function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || "");
  return isLoopbackIp(ip);
}

/**
 * Attachment descriptors arrive from the browser and are used to attach images
 * to the model. They name files on disk, so they are untrusted input: an
 * absolute path or a `..` segment would let a caller make OmniClaw read ANY
 * file on the machine and hand it to the model as an image.
 *
 * So: keep only relative, containment-checked paths under the runtime dir, keep
 * a small allowlist of image extensions, and cap the count. Anything else is
 * dropped silently — the text note still names the file, so a blind model can
 * still call describe_image through the normal, permission-checked path.
 */
const MAX_CHAT_ATTACHMENTS = 6;
const CHAT_ATTACHMENT_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]);

function sanitizeAttachmentRefs(list) {
  if (!Array.isArray(list)) return [];
  const root = path.resolve(runtimeDir);
  const out = [];
  for (const item of list.slice(0, MAX_CHAT_ATTACHMENTS)) {
    const relPath = String(item?.relPath || "").trim();
    if (!relPath) continue;
    const ext = relPath.split(".").pop().toLowerCase();
    if (!CHAT_ATTACHMENT_IMAGE_EXTS.has(ext)) continue;
    if (path.isAbsolute(relPath)) continue;
    const abs = path.resolve(root, relPath);
    const relative = path.relative(root, abs);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    out.push({
      relPath: relative.split(path.sep).join("/"),
      name: String(item?.name || "").slice(0, 200),
      isImage: true,
    });
  }
  return out;
}

function sendErr(res, status, code, message) {
  sendJson(res, status, { error: message, code });
}

// B1 fs helpers: SAME policy the computer tools use —
// FileStore.resolveComputerPath(input, policy) (src/core/file-store.js:43-64)
// with policy = config.tools.computerAccess, gated by enabled like
// requireComputerAccessPolicy (src/core/tool-registry.js:5528-5534).
function b1FsPolicy() {
  const policy = (agent.config.getConfig()?.tools?.computerAccess) || {};
  if (!policy.enabled) {
    throw { status: 403, code: "EPERM", message: "Computer access is disabled by runtime policy." };
  }
  return policy;
}

function b1ResolveFs(requestedPath) {
  const policy = b1FsPolicy();
  const raw = String(requestedPath || "").trim();
  const base = raw ? raw : agent.getWorkspaceRoot();
  try {
    // agent.files is the workspace-scoped FileStore (re-scoped on workspace
    // select, agent.js:514) — same object the computer tools resolve through.
    return { target: agent.files.resolveComputerPath(base, policy), policy };
  } catch (error) {
    throw { status: 403, code: "EPERM", message: error.message };
  }
}

// B1 git helpers: fixed `git` invocations via execFile (never shell:true),
// mirroring the existing /api/workspace/git route above. Shared runGit +
// status parser feed all five /api/git/* routes.
function runGit(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        cwd, encoding: "utf8", timeout: 10000, maxBuffer: 20 * 1024 * 1024, windowsHide: true,
      }),
    };
  } catch (error) {
    return { ok: false, error: error.message, stdout: error.stdout ? String(error.stdout) : "" };
  }
}

function b1GitRoot() {
  const root = agent.getWorkspaceRoot();
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw { status: 409, code: "ENOTGIT", message: "Workspace is not a git repo." };
  }
  return root;
}

// Workspace containment for git paths (same pattern as ensureWithinRoot,
// src/core/file-store.js:5-15).
function b1GitPath(cwd, requested) {
  const raw = String(requested || "").trim();
  if (!raw) throw { status: 400, code: "EINVAL", message: "path is required." };
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw { status: 403, code: "EPERM", message: "Path is outside the workspace." };
  }
  return abs;
}

function b1PorcelainLetter(x, y) {
  const s = `${x}${y}`;
  if (s.includes("U")) return "U";
  if (s.includes("R")) return "R";
  if (s.includes("M")) return "M";
  if (s.includes("A")) return "A";
  if (s.includes("D")) return "D";
  if (s.includes("?")) return "?";
  return s.trim() || "?";
}

function b1GitFiles(cwd) {
  const out = runGit(["status", "--porcelain=v1", "-uall"], cwd);
  if (!out.ok) throw { status: 400, code: "EINVAL", message: out.error.slice(0, 300) };
  const files = [];
  for (const line of String(out.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";
    let rest = line.slice(3);
    if (rest.includes(" -> ")) rest = rest.split(" -> ").pop();
    files.push({
      path: rest.trim(),
      status: b1PorcelainLetter(x, y),
      staged: x !== " " && x !== "?",
    });
  }
  return files;
}

// B1 step 5: spawn wrapper. OMNICLAW_TEST_NO_SPAWN=1 stubs the spawn so
// tests assert exact argv without launching processes.
function b1Spawn(bin, args) {
  if (process.env.OMNICLAW_TEST_NO_SPAWN === "1") {
    return { stubbed: true, bin, args };
  }
  const child = spawn(bin, args, { windowsHide: true, stdio: "ignore", detached: true });
  child.unref();
  return { ok: true, pid: child.pid || 0 };
}

function b1FindOnPath(names) {
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  for (const raw of dirs) {
    const dir = raw.trim();
    if (!dir) continue;
    for (const name of names) {
      try {
        const full = path.join(dir, name);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // Not here — keep looking.
      }
    }
  }
  return "";
}

// B1 step 8: capability probes (real checks, cached per process).
let b1CapsCache = null;
function b1Capabilities() {
  if (b1CapsCache) return b1CapsCache;
  let git = false;
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    git = true;
  } catch {
    git = false;
  }
  let vscode = false;
  if (process.platform === "win32") {
    vscode = b1FindOnPath(["code.cmd", "code.exe"]) !== "";
  }
  let version = "0.1.0";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
    if (pkg.version) version = String(pkg.version);
  } catch {
    // Keep the fallback — capabilities must never 500.
  }
  // Route-presence flags are backend facts, verified against this file:
  // sessions/search (:3275), memory/search (:3409), mcp/status (:2122),
  // harness/status (:903). fs/git/system/toolCallId are this file's own
  // routes/fields. terminal/attachments are honestly false (B2 scope).
  b1CapsCache = {
    fs: true,
    git,
    systemOpen: process.platform === "win32" ? { reveal: true, vscode } : { reveal: false, vscode: false },
    terminal: false,
    attachments: false,
    toolCallId: true,
    sessionsSearch: true,
    memorySearch: true,
    mcp: true,
    harness: true,
    // 4B.1: tool-side approval wait budget (tool-registry.js awaitShellApproval
    // + ask_user). UI countdowns use min(record.expiresAt, createdAt + this).
    approvalToolTimeoutMs: APPROVAL_TOOL_TIMEOUT_MS,
    // 4B.2: managed browser surface (routes below; all loopback-only).
    browser: { managed: true, input: true, screencast: true },
    // T2.2: toolset catalog for the composer + Tools page (static metadata).
    toolsets: Object.entries(TOOLSETS).map(([name, set]) => ({
      name,
      description: set.description,
      size: set.members.length,
    })),
    version,
  };
  return b1CapsCache;
}

function b1FsEntry(absPath, name) {
  const stat = fs.statSync(absPath);
  return {
    name,
    path: absPath,
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.isDirectory() ? 0 : stat.size,
    mtime: stat.mtimeMs,
  };
}

// B1 error mapper: shaped throws ({status, code, message}) pass through;
// node fs errors map ENOENT→404, EACCES/EPERM→403; everything else 400.
function b1FsError(res, error, fallbackCode = "EINVAL") {
  const KNOWN = ["EINVAL", "EPERM", "ENOENT", "ETOOBIG", "ENOTGIT"];
  if (error && KNOWN.includes(error.code)) {
    const status = error.status
      || (error.code === "ENOENT" ? 404 : error.code === "EPERM" ? 403 : error.code === "ETOOBIG" ? 413 : 400);
    sendErr(res, status, error.code, error.message);
    return;
  }
  const code = error && error.code;
  if (code === "ENOENT") { sendErr(res, 404, "ENOENT", error.message); return; }
  if (code === "EACCES" || code === "EPERM") { sendErr(res, 403, "EPERM", error.message); return; }
  sendErr(res, 400, fallbackCode, (error && error.message) || "Bad request");
}

// Big/raw payload fields handled explicitly below (or deliberately dropped from
// the HTTP view); everything else is passed through bounded so the UI + the
// chat-agent contract keep diagnostic fields (score, provider, execution,
// model, task blueprint, etc.) instead of silently losing them.
const HEAVY_OUTPUT_KEYS = new Set([
  "results", "fetchedContent", "fetchCandidates", "attempts", "content",
  "html", "markdown", "stdout", "stderr", "summary", "raw", "data", "body",
  "buffer", "screenshot", "screenshotBase64", "image", "diff",
  // explicitly normalized keys (don't double-emit from passthrough)
  "status", "ok", "blocked", "error", "reason", "path", "url", "title", "query", "count",
]);

function compactHttpValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateHttpText(value, 1500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 4) return `[array(${value.length})]`;
    return value.slice(0, 10).map((entry) => compactHttpValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[object]";
    const out = {};
    let keys = 0;
    for (const [key, child] of Object.entries(value)) {
      if (keys >= 40) break;
      const compacted = compactHttpValue(child, depth + 1);
      if (compacted !== undefined) { out[key] = compacted; keys += 1; }
    }
    return out;
  }
  return undefined;
}

function compactToolOutputForHttp(item = {}) {
  const output = item.output || {};
  const passthrough = {};
  if (output && typeof output === "object" && !Array.isArray(output)) {
    for (const [key, value] of Object.entries(output)) {
      if (HEAVY_OUTPUT_KEYS.has(key)) continue;
      const compacted = compactHttpValue(value, 1);
      if (compacted !== undefined) passthrough[key] = compacted;
    }
  }
  return {
    tool: item.tool || "",
    input: item.input || {},
    reason: truncateHttpText(item.reason || "", 300),
    source: item.source || "",
    round: item.round,
    output: {
      ...passthrough,
      status: output.status || "",
      ok: output.ok,
      blocked: Boolean(output.blocked),
      error: output.error ? truncateHttpText(output.error, 600) : output.error,
      reason: truncateHttpText(output.reason || "", 500),
      path: output.path || "",
      url: output.url || "",
      title: output.title || "",
      query: output.query || undefined,
      summary: truncateHttpText(output.summary || output.content || output.stdout || output.stderr || "", 1200),
      count: output.count ?? (Array.isArray(output.results) ? output.results.length : undefined),
      results: (output.results || []).slice(0, 5).map((result) => ({
        title: truncateHttpText(result.title || result.name || "", 180),
        url: result.url || "",
        path: result.path || "",
        snippet: truncateHttpText(result.snippet || result.text || result.content || "", 360),
      })),
    },
    toolSummary: item.toolSummary || undefined,
  };
}

function compactChatResultForHttp(result = {}) {
  return {
    error: result.error || undefined,
    session: result.session,
    agent: result.agent,
    run: result.run,
    reply: result.reply || "",
    intents: result.intents || [],
    plan: result.plan ? {
      summary: result.plan.summary || "",
      intents: result.plan.intents || [],
      source: result.plan.source || "",
      profile: result.plan.profile ? {
        id: result.plan.profile.id,
        description: result.plan.profile.description,
      } : undefined,
      toolsAvailableCount: Array.isArray(result.plan.toolsAvailable) ? result.plan.toolsAvailable.length : 0,
      steps: (result.plan.steps || []).slice(0, 8).map((step) => ({
        type: step.type || "",
        tool: step.tool || "",
        reason: truncateHttpText(step.reason || "", 500),
      })),
    } : result.plan,
    toolOutputs: Array.isArray(result.toolOutputs)
      ? result.toolOutputs.slice(-12).map(compactToolOutputForHttp)
      : result.toolOutputs,
    context: result.context ? {
      usedChars: result.context.usedChars,
      maxChars: result.context.maxChars,
      omittedItems: result.context.omittedItems,
      summary: result.context.summary,
    } : result.context,
    modelToolLoop: result.modelToolLoop ? {
      enabled: result.modelToolLoop.enabled,
      attempted: result.modelToolLoop.attempted,
      loopEngine: result.modelToolLoop.loopEngine,
      rounds: result.modelToolLoop.rounds,
      maxRounds: result.modelToolLoop.maxRounds,
      toolCallCount: result.modelToolLoop.toolCallCount,
      parallelToolBatches: result.modelToolLoop.parallelToolBatches,
      transcriptCompactions: result.modelToolLoop.transcriptCompactions,
      codeEdited: result.modelToolLoop.codeEdited,
      verificationRan: result.modelToolLoop.verificationRan,
      verificationNudges: result.modelToolLoop.verificationNudges,
      finalReady: result.modelToolLoop.finalReady,
      stoppedReason: result.modelToolLoop.stoppedReason,
      skippedReason: result.modelToolLoop.skippedReason,
      recoveredToolCalls: result.modelToolLoop.recoveredToolCalls,
      repeatedToolCallsSkipped: result.modelToolLoop.repeatedToolCallsSkipped,
      usage: result.modelToolLoop.usage,
      errors: (result.modelToolLoop.errors || []).slice(0, 5).map((error) => truncateHttpText(error, 500)),
    } : result.modelToolLoop,
    finalMetadata: result.finalMetadata ? {
      mode: result.finalMetadata.mode,
      model: result.finalMetadata.model,
      providerId: result.finalMetadata.providerId,
      durationMs: result.finalMetadata.durationMs,
      stepCount: result.finalMetadata.stepCount,
      toolCallCount: result.finalMetadata.toolCallCount,
      stopReason: result.finalMetadata.stopReason,
      failedToolCount: result.finalMetadata.failedToolCount,
      verificationPassed: result.finalMetadata.verificationPassed,
      remainingIssues: result.finalMetadata.remainingIssues || [],
    } : result.finalMetadata,
    providerDiagnostics: result.providerDiagnostics ? {
      ok: result.providerDiagnostics.ok,
      status: result.providerDiagnostics.status,
      reason: result.providerDiagnostics.reason,
      message: truncateHttpText(result.providerDiagnostics.message || "", 800),
      providerId: result.providerDiagnostics.providerId,
      model: result.providerDiagnostics.model,
      durationMs: result.providerDiagnostics.durationMs,
    } : result.providerDiagnostics,
    provider: result.provider ? {
      id: result.provider.id,
      mode: result.provider.mode,
      ready: result.provider.ready,
      model: result.provider.model,
      apiKeySource: result.provider.apiKeySource,
      message: truncateHttpText(result.provider.message || "", 500),
    } : result.provider,
    approvals: Array.isArray(result.approvals) ? result.approvals.slice(0, 5) : result.approvals,
  };
}

function sendSSEHeaders(res, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS_HEADERS,
  });
  // Nagle batches small SSE writes and adds ~40ms to every frame. A live view
  // that is already frame-rate bound cannot afford to wait on it.
  try { res.socket?.setNoDelay?.(true); } catch { /* not a socket-backed res */ }
  try { res.flushHeaders?.(); } catch {}
}

// ── Backpressure (the "laptop hangs, only a reboot helps" bug) ──────────────
//
// A 1280x900 q60 JPEG frame is ~100-200KB of base64. At 30-60fps that is
// 3-12MB/s per viewer. res.write() returns FALSE once the kernel/socket buffer
// is full but the bytes are ALREADY queued in memory — so a client that stops
// reading (backgrounded tab, throttled window, busy machine) made this process
// buffer frames without any limit. Node's heap climbed until the machine began
// swapping, at which point nothing responded and the only exit was a restart.
//
// The fix is the standard one for a lossy real-time feed: never queue, DROP.
// A stale video frame is worthless, so the newest frame simply supersedes
// whatever we could not deliver, and the heartbeat keeps the envelope alive so
// the client still knows the stream is open.
const SSE_MAX_BUFFER_BYTES = 1_000_000;   // ~1MB ≈ 5-8 frames of slack
const SSE_MAX_BUFFER_EVENTS = 256;         // non-droppable payloads queued

/**
 * @param {boolean} droppable true for high-rate lossy payloads (video frames)
 *   which may be skipped when the client is behind. false for state the client
 *   must eventually receive (ready/action/heartbeat) — those are only refused
 *   once the backlog is unambiguously pathological.
 */
function writeSSE(res, payload, { droppable = false } = {}) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const queued = res.writableLength || 0;
  if (droppable ? queued > SSE_MAX_BUFFER_BYTES : queued > SSE_MAX_BUFFER_BYTES * SSE_MAX_BUFFER_EVENTS) {
    return false;
  }
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcastEvent(record) {
  const chunk = `data: ${JSON.stringify(record)}\n\n`;
  for (const client of eventClients) {
    // Same rule as writeSSE: a stalled tab must not be able to grow this
    // process's heap without bound. Dropping a progress tick is survivable;
    // an OOM is not.
    if (client.writableEnded || client.destroyed || (client.writableLength || 0) > SSE_MAX_BUFFER_BYTES) {
      continue;
    }
    try {
      client.write(chunk);
    } catch {
      eventClients.delete(client);
    }
  }
}

agent.gateway.onEvent(broadcastEvent);

function startCodexLoginWindow() {
  const config = agent.config.getConfig();
  const command = String(config.provider?.codexCommand || "codex").trim() || "codex";
  if (process.platform === "win32") {
    const loginCommand = [
      "$ErrorActionPreference = 'Continue'",
      `$codexCommand = '${command.replace(/'/g, "''")}'`,
      "Write-Host 'Checking Codex CLI...'",
      "try { & $codexCommand --version; $ok = $LASTEXITCODE -eq 0 } catch { $ok = $false; Write-Host $_.Exception.Message }",
      "if (-not $ok) { Write-Host 'Installing official @openai/codex CLI with npm...'; npm.cmd install -g @openai/codex }",
      "Write-Host 'Starting Codex login. Choose Sign in with ChatGPT.'",
      "& $codexCommand login",
    ].join("; ");
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Start-Process",
        "powershell.exe",
        "-ArgumentList",
        `'-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-Command','${loginCommand.replace(/'/g, "''")}'`,
      ],
      { cwd: runtimeDir, detached: true, windowsHide: true, stdio: "ignore" },
    );
    child.unref();
    return { started: true, platform: process.platform, command: `${command} login`, setup: "installs @openai/codex first if the current command cannot run" };
  }
  const child = spawn(command, ["login"], { cwd: runtimeDir, detached: true, stdio: "ignore" });
  child.unref();
  return { started: true, platform: process.platform, command: `${command} login` };
}

function sendFile(res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml; charset=utf-8",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
    };
    const contentType = contentTypes[ext] || "application/octet-stream";

    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    sendJson(res, 404, { error: "Not found" });
  }
}


// ─── Auth Middleware ──────────────────────────────────────────────
// Only true pre-auth essentials stay public: liveness + initial device pairing.
// /api/events (telemetry SSE) and /api/auth/overview (device/trust metadata) were
// public and leaked internal state, so they now go through checkAuth (still open
// when no gateway token is configured; enforced once a token is set).
const PUBLIC_ENDPOINTS = new Set(["/api/health", "/api/auth/pairing/request"]);

// A run that is "running" but has emitted nothing for this long is reported as
// "stalled", not "running": the UI must be able to tell "working" from "wedged"
// (a tool call that never returns looks identical otherwise). 60s is well under
// the longest legitimate silence - a single tool may run 900s - because
// lastActivityAt is stamped on the RUN RECORD by every event it emits (M2).
const AGENT_STALLED_MS = 60_000;
// The three non-terminal run statuses. Mirrors ACTIVE_RUN_STATUSES in
// gateway-store, but defined here too so the HTTP layer never has to import the
// store just to classify a run.
const AGENT_ACTIVE_RUN_STATUSES = new Set(["accepted", "queued", "running"]);

// Resolve an agent's live status. COMPUTED, never stored: an agent has no
// "status" field in config, and the hardcoded "ready" this replaced was exactly
// the lie that made the agent list useless.
//
// M2 (AGENTS_AUDIT risk 3): this reads status + lastActivityAt from the RUN
// RECORD, not by replaying the events log. The log is capped at 200 entries and
// the whole gateway file is size-budgeted (gateway-store.js enforceSizeBudget),
// so a long run's early events fall out of it - status computed from the log
// silently degraded to "idle" on exactly the agents that were busy. The event log
// is now used ONLY for the optional round counter, where losing history is
// cosmetic rather than a lie.
//
//   idle              no active run, nothing waiting
//   queued            a run is waiting for the global slot (runtime.maxConcurrentRuns)
//   running           an active run exists for it
//   stalled           active run, but no activity for > AGENT_STALLED_MS
//   waiting-approval  a LIVE pending approval belongs to one of its active runs
//   offline           the agent exists but its runtime cannot be reached
function activeRuns(runs) {
  return runs.filter((run) => AGENT_ACTIVE_RUN_STATUSES.has(run.status));
}

function computeAgentRuntime(agentId) {
  const base = {
    status: "idle",
    lastActivityAt: null,
    liveRunId: null,
    step: null,
    runCount: 0,
    queuePosition: 0,
  };
  let runs = [];
  let approvals = [];
  let events = [];
  try {
    runs = agent.gateway?.listRuns?.(500) || [];
    // listLivePendingApprovals drops approvals whose run already finished or was
    // pruned from the size budget. A stale row used to paint a row amber forever.
    approvals = typeof agent.gateway?.listLivePendingApprovals === "function"
      ? agent.gateway.listLivePendingApprovals()
      : agent.gateway?.listApprovals?.("pending") || [];
    events = agent.gateway?.listEvents?.(200) || [];
  } catch (error) {
    // Never let a store hiccup turn the whole agents list into a 500.
    return { ...base, status: "offline", error: error.message };
  }

  const scoped = runs.filter((run) => String(run.agentId || "") === String(agentId));
  const live = activeRuns(scoped);
  const active = live[0] || null;
  // Newest activity wins. lastActivityAt is stamped on the run by every event;
  // updatedAt is the fallback for runs written before M2 (nothing stamped yet).
  let lastActivityAt = null;
  for (const run of scoped) {
    const stamp = run.lastActivityAt || run.updatedAt || run.createdAt || null;
    if (stamp && (!lastActivityAt || Date.parse(stamp) > Date.parse(lastActivityAt))) {
      lastActivityAt = stamp;
    }
  }

  let step = null;
  if (active) {
    // "step x of y" comes from the round_started event payload
    // (omni-loop.js:5022 emits {round, maxRounds}). Best-effort only.
    const lastRound = events.find(
      (event) => event.event === "model_tool_loop.round_started"
        && String((event.payload || {}).runId || "") === String(active.id),
    );
    if (lastRound && lastRound.payload) {
      step = {
        round: Number(lastRound.payload.round) || null,
        maxRounds: Number(lastRound.payload.maxRounds) || null,
      };
    }
    if (!lastActivityAt) lastActivityAt = active.updatedAt || active.createdAt || null;
  }

  // A pending approval belongs to an agent through the agentId STAMPED ON IT AT
  // CREATION (M3) - that survives the run and session being reaped. The run-id /
  // session-id match below stays as the fallback for records written before M3
  // (old gateway.json rows have no agentId at all).
  const activeRunIds = new Set(live.map((run) => String(run.id)));
  const activeSessionIds = new Set(live.map((run) => String(run.sessionId || "")).filter(Boolean));
  const waitingApproval = approvals.find((approval) => {
    if (approval.agentId) return String(approval.agentId) === String(agentId);
    return (approval.runId && activeRunIds.has(String(approval.runId)))
      || (approval.sessionId && activeSessionIds.has(String(approval.sessionId)));
  });

  let status = "idle";
  if (waitingApproval) {
    status = "waiting-approval";
  } else if (active) {
    if (active.status === "queued") {
      // Waiting for the global slot, not doing anything yet. Reporting this as
      // "running" is how a user ends up staring at an agent that will not answer.
      status = "queued";
    } else {
      const idleMs = lastActivityAt ? Date.now() - Date.parse(lastActivityAt) : Infinity;
      status = idleMs > AGENT_STALLED_MS ? "stalled" : "running";
    }
  }

  return {
    status,
    lastActivityAt,
    liveRunId: active ? active.id : null,
    step,
    runCount: scoped.length,
    queuePosition: active && active.status === "queued" ? Number(active.queuePosition) || 0 : 0,
  };
}

function listAgentsForShell() {
  try {
    const agents = agent.agents?.getAll?.() || [];
    const entries = agents.length ? agents : [{ id: "main", name: "Main agent" }];
    return entries.map((entry) => {
      const id = entry.id || "main";
      // Normalized through the registry so a pre-M1 agent still gets safe
      // label/avatar/color defaults. Fall back to a plain object when the shape
      // came from the stub above rather than from normalizeAgent().
      const runtime = computeAgentRuntime(id);
      return {
        // ── pre-existing fields (unchanged, frozen) ──
        id,
        name: entry.name || id || "Main agent",
        description: entry.description || entry.goal || "Local OmniClaw agent",
        default: Boolean(entry.default),
        workspace: entry.workspace || entry.workspacePath
          ? { path: entry.workspacePath || entry.workspace?.path || "" }
          : undefined,
        // ── computed live status, NOT the hardcoded "ready" ──
        status: runtime.status,
        label: entry.label || entry.name || id,
        avatar: entry.avatar || "blob",
        color: entry.color || "#7c8cf8",
        model: entry.model || "",
        computerProvider: entry.computerProvider || "local",
        createdAt: entry.createdAt || "",
        updatedAt: entry.updatedAt || "",
        lastActivityAt: runtime.lastActivityAt,
        liveRunId: runtime.liveRunId,
        step: runtime.step,
        runCount: runtime.runCount,
        queuePosition: runtime.queuePosition,
      };
    });
  } catch (error) {
    return [{
      id: "main",
      name: "Main agent",
      description: "Local OmniClaw agent",
      default: true,
      label: "Main agent",
      avatar: "blob",
      color: "#7c8cf8",
      computerProvider: "local",
      status: "offline",
      lastActivityAt: null,
      liveRunId: null,
      step: null,
      error: error.message,
    }];
  }
}

function listSessionSummariesForShell(limit, workspace = "") {
  const max = Math.max(1, Math.min(200, Number(limit || 50)));
  try {
    // Over-fetch when filtering by workspace so the limit applies AFTER the filter.
    const fetchMax = workspace ? 200 : max;
    const sessions = typeof agent.sessions?.listSessionSummariesFast === "function"
      ? agent.sessions.listSessionSummariesFast(fetchMax)
      : agent.sessions.listSessions(fetchMax);
    let out = sessions;
    if (workspace) {
      const ws = String(workspace).trim();
      const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      const wsPath = norm(ws);
      // Accept either a workspaceId (key suffix) or a filesystem path.
      out = sessions.filter((s) => {
        if (s.workspaceId && s.workspaceId === ws) return true;
        if (s.workspacePath && norm(s.workspacePath) === wsPath) return true;
        const suffix = String(s.key || "").match(/:ws:([^:]+)$/);
        if (suffix && suffix[1] === ws) return true;
        return false;
      });
    }
    return { sessions: out.slice(0, max), totalMatched: out.length, workspace: workspace || null };
  } catch (error) {
    return { sessions: [], degraded: true, error: error.message };
  }
}

function checkAuth(req, pathname) {
  // Public endpoints skip auth
  if (PUBLIC_ENDPOINTS.has(pathname)) return true;
  // OAuth providers redirect back in the user's browser, which cannot attach
  // the local gateway token. The signed, short-lived OAuth state is verified
  // again by AppConnections before any token is stored.
  if (pathname.startsWith("/api/apps/oauth/callback/")) return true;
  // The webhook route authenticates with its OWN per-connector token
  // (authorizeWebhook). Gating it behind the gateway token too would break all
  // third-party webhooks the moment requireApiAuth is turned on.
  if (pathname === "/api/connectors/webhook") return true;
  // Static files skip auth; /api/* and /v1/* (provider-backed API) are gated.
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) return true;
  // OPTIONS skip auth
  if (req.method === "OPTIONS") return true;

  const config = agent.config.getConfig();
  const requireAuth = config.security?.requireApiAuth ?? false;

  // Auth is opt-in. Default (requireApiAuth off) → open for local, loopback-bound
  // use so the UI works without a token. When the operator turns auth ON, enforce
  // the gateway token via the trust store (verifyGatewayToken handles hashing +
  // expiry/revocation). Source of truth is the trust store, NOT the non-existent
  // `getGatewayToken()` — that bug made the check always bypass even with auth on.
  if (!requireAuth) return true;
  if (agent.trust?.getGatewayStatus?.()?.configured !== true) return false; // auth on but no token → fail closed

  const bearer = String(req.headers.authorization || "").trim();
  const headerToken = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";
  const queryToken = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("token") || "";
  const customHeader = req.headers["x-omniclaw-token"] || "";

  const provided = headerToken || queryToken || customHeader;
  // verifyGatewayToken does a constant-time hash comparison + expiry/revocation.
  return agent.trust.verifyGatewayToken?.(String(provided || "")) === true;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    // Honor the configured cap (the knob was previously ignored) and stop the
    // request the moment it's exceeded instead of accumulating forever.
    const maxBytes = Number(agent?.config?.getConfig?.()?.security?.maxRequestBytes) || 1_000_000;
    const chunks = [];
    let size = 0;
    let done = false;

    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        try { req.destroy(); } catch { /* socket already gone */ }
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (done) return;
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => { if (!done) { done = true; reject(error); } });
  });
}

function getConnectorToken(req, body, url) {
  const bearer = String(req.headers.authorization || "").trim();
  const bearerToken = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";
  return String(
    body.connectorToken ||
      body.token ||
      url.searchParams.get("token") ||
      req.headers["x-omniclaw-token"] ||
      req.headers["x-connector-token"] ||
      bearerToken ||
      "",
  ).trim();
}

function adapterHistoryOptions(url, limitParam = "adapterLimit", statusParam = "adapterStatus") {
  return {
    limit: Number(url.searchParams.get(limitParam) || 20),
    adapterId: url.searchParams.get("adapterId") || "",
    status: url.searchParams.get(statusParam) || "",
    query: url.searchParams.get("adapterQuery") || url.searchParams.get("query") || "",
  };
}

async function retryAdapterOutbox(outboxId) {
  const item = agent.connectors.getAdapterOutboxItem(outboxId);
  if (item.adapterId === "telegram") {
    return agent.telegramWorker.retryOutbox(item.id);
  }
  if (item.adapterId === "discord") {
    return agent.discordWorker.retryOutbox(item.id);
  }
  throw new Error(`Adapter ${item.adapterId || "(missing)"} does not support retry yet.`);
}

async function cacheAdapterAttachment(input = {}) {
  const { delivery } = agent.connectors.getAdapterDeliveryAttachment(input);
  if (delivery.adapterId === "telegram") {
    return agent.telegramWorker.cacheAttachment(input);
  }
  if (delivery.adapterId === "discord") {
    return agent.discordWorker.cacheAttachment(input);
  }
  throw new Error(`Adapter ${delivery.adapterId || "(missing)"} does not support attachment caching yet.`);
}

const server = http.createServer(async (req, res) => {
 if (isShuttingDown) {
 res.writeHead(503, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ error: "Server is shutting down" }));
 return;
 }

 const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
 const pathname = url.pathname;
 const clientIp = req.socket.remoteAddress || "unknown";

 // CORS preflight
 if (req.method === "OPTIONS") {
 res.writeHead(204, CORS_HEADERS);
 res.end();
 return;
 }

  // Rate limiting (/api/* + /v1/* only — static assets bypass it).
  if (!isStaticAsset(pathname, req.method)) {
    const rl = checkRateLimit(clientIp);
    if (!rl.allowed) {
    sendJson(res, 429, { error: `Rate limit exceeded (${rl.max} req/min)`, retryAfter: 60 });
    return;
    }
  }

  // Auth check — /v1/* (OpenAI-compatible API) is gated too: it exposes the
  // configured provider credentials, so it must not be an unauthenticated bypass.
  if (!checkAuth(req, pathname)) {
  sendJson(res, 401, { error: "Unauthorized. Provide gateway token via Authorization: Bearer <token> or ?token=<token>" });
  return;
  }

  // OpenAI-compatible API routes
  if (pathname.startsWith("/v1/")) {
    const handled = await openaiAPI.handleRequest(req, res, url, pathname);
    if (handled) return;
  }

  // Improved health endpoint
 if (req.method === "GET" && pathname === "/api/health") {
 sendJson(res, 200, {
 ok: true,
 status: "ok",
 name: "OmniClaw",
 version: "0.1.0",
 uptime: Math.round(process.uptime()),
 provider: {
   id: agent.config?.getConfig?.()?.provider?.mode || "unknown",
   ready: true,
   source: "cached-config",
 },
 timestamp: new Date().toISOString(),
 });
 return;
 }

 if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, agent.getState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/agents") {
    sendJson(res, 200, {
      agents: listAgentsForShell(),
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/agents/") && pathname.endsWith("/inspector")) {
    const parts = pathname.split("/").filter(Boolean);
    const agentId = parts[2] || "main";
    try {
      sendJson(res, 200, {
        inspector: agent.getAgentInspector(agentId, {
          sessionId: url.searchParams.get("sessionId") || "",
        }),
      });
    } catch (error) {
      sendJson(res, 404, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/agents/")) {
    const agentId = pathname.slice("/api/agents/".length);
    const item = listAgentsForShell().find((entry) => entry.id === agentId) || null;
    if (!item) {
      sendJson(res, 404, { error: "Agent not found" });
      return;
    }
    sendJson(res, 200, { agent: item });
    return;
  }

  if (req.method === "GET" && pathname === "/api/gateway") {
    sendJson(res, 200, {
      overview: agent.gateway.getOverview(),
      events: agent.gateway.listEvents(50).map((event) => ({
        ...event,
        payload: event.payload || {},
      })),
      runs: agent.gateway.listRuns(20).map(({ promptTrace, toolTrace, ...run }) => ({
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
        sessionId: run.sessionId,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        channel: run.channel,
        label: run.label,
        queuePosition: run.queuePosition,
        waitedMs: run.waitedMs,
        blockedByRunId: run.blockedByRunId,
        stopReason: run.stopReason,
        error: truncateHttpText(run.error || "", 500),
        message: truncateHttpText(run.message || "", 500),
        reply: truncateHttpText(run.reply || "", 700),
        planSummary: run.plan?.summary || "",
        toolOutputCount: Array.isArray(run.toolOutputs) ? run.toolOutputs.length : 0,
        providerStatus: run.providerDiagnostics?.status || "",
        providerReason: run.providerDiagnostics?.reason || "",
        promptTrace: Boolean(promptTrace),
        toolTrace: Boolean((Array.isArray(toolTrace) && toolTrace.length > 0) || run.modelToolLoop?.attempted),
        toolTraceCount: Array.isArray(toolTrace) ? toolTrace.length : Number(run.toolTraceCount || 0),
      })),
      approvals: agent.gateway.listApprovals(),
      delegations: agent.gateway.listDelegations({ limit: 20 }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/harness/status") {
    sendJson(res, 200, agent.codingHarness.status({
      sessionId: url.searchParams.get("sessionId") || "",
      sessionKey: url.searchParams.get("sessionKey") || "",
      label: url.searchParams.get("label") || "",
      status: url.searchParams.get("status") || "",
      limit: Number(url.searchParams.get("limit") || 20),
    }));
    return;
  }

  if (req.method === "GET" && pathname === "/api/harness/doctor") {
    sendJson(res, 200, await agent.codingHarness.doctor({
      agentId: url.searchParams.get("agentId") || "",
    }));
    return;
  }

  if (req.method === "POST" && pathname === "/api/harness/spawn") {
    try {
      const body = await parseBody(req);
      const result = await agent.codingHarness.spawn(body, {
        sessionId: body.sessionId || "",
        runId: body.runId || "",
      });
      sendJson(res, result.blocked || result.ok === false ? 400 : 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/harness/cancel") {
    try {
      const body = await parseBody(req);
      sendJson(res, 200, agent.codingHarness.cancel(body));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname.startsWith("/api/runs/") && pathname.endsWith("/stop")) {
    const parts = pathname.split("/").filter(Boolean);
    const runId = parts[2] || "";
    const result = agent.cancelRun(runId);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // Steer a running run: inject a user message the agent reads at the next round
  // boundary, without interrupting it.
  if (req.method === "POST" && pathname.startsWith("/api/runs/") && pathname.endsWith("/steer")) {
    const parts = pathname.split("/").filter(Boolean);
    const runId = parts[2] || "";
    try {
      const body = await parseBody(req);
      const result = agent.steerRun(runId, body.message || body.text || "");
      sendJson(res, result.ok ? 202 : 400, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/runs/") && pathname.endsWith("/prompt-trace")) {
    const parts = pathname.split("/").filter(Boolean);
    const runId = parts[2] || "";
    const trace = agent.getPromptTrace(runId);
    if (!trace) {
      sendJson(res, 404, { error: "Run not found" });
      return;
    }
    sendJson(res, trace.available ? 200 : 404, trace.available ? trace : { ...trace, error: "Prompt trace not available for this run" });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/runs/") && pathname.endsWith("/tool-trace")) {
    const parts = pathname.split("/").filter(Boolean);
    const runId = parts[2] || "";
    const trace = agent.getToolTrace(runId);
    if (!trace) {
      sendJson(res, 404, { error: "Run not found" });
      return;
    }
    sendJson(res, trace.available ? 200 : 404, trace.available ? trace : { ...trace, error: "Tool trace not available for this run" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/layers") {
    sendJson(res, 200, agent.getOpenClawLayerReport());
    return;
  }

  if (req.method === "GET" && pathname === "/api/v2") {
    sendJson(res, 200, agent.getV2Report());
    return;
  }

  if (req.method === "GET" && pathname === "/api/delegations") {
    sendJson(res, 200, {
      delegations: agent.gateway.listDelegations({
        limit: Number(url.searchParams.get("limit") || 50),
        status: url.searchParams.get("status") || "",
        agentId: url.searchParams.get("agentId") || "",
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/delegations/create") {
    try {
      const body = await parseBody(req);
      const result = agent.queueDelegation({
        sourceAgentId: body.sourceAgentId || body.sourceAgent || "main",
        targetAgentId: body.targetAgentId || body.agentId,
        instruction: body.instruction || body.task,
        parentSessionId: body.parentSessionId || body.sessionId || "",
        parentRunId: body.parentRunId || "",
        source: body.source || "manual-dashboard",
      });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/delegations/cancel") {
    try {
      const body = await parseBody(req);
      const delegationId = body.delegationId || body.id;
      // M3 records (delegation.* / a targetSessionId) go through the bridge,
      // which also cancels the TARGET RUN; pre-M3 records keep the old path.
      const record = agent.gateway.getDelegation(delegationId);
      const result = record && record.targetSessionId
        ? agent.cancelDelegationTask(delegationId)
        : agent.cancelDelegation(delegationId, body.note || "api-cancel");
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/delegations/retry") {
    try {
      const body = await parseBody(req);
      const delegationId = body.delegationId || body.id;
      const record = agent.gateway.getDelegation(delegationId);
      const result = record && record.targetSessionId
        ? agent.retryDelegationTask(delegationId)
        : agent.retryDelegation(delegationId, {
          sourceAgentId: body.sourceAgentId || "",
          targetAgentId: body.targetAgentId || "",
          instruction: body.instruction || "",
          parentSessionId: body.parentSessionId || "",
          parentRunId: body.parentRunId || "",
          source: body.source || "api-retry",
        });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/events") {
    sendSSEHeaders(res);
    writeSSE(res, { type: "hello", at: new Date().toISOString() });
    eventClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        writeSSE(res, { type: "heartbeat", at: new Date().toISOString() });
      } catch {
        eventClients.delete(res);
        clearInterval(heartbeat);
      }
    }, 15000);
    req.on("close", () => {
      eventClients.delete(res);
      clearInterval(heartbeat);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, listSessionSummariesForShell(
      url.searchParams.get("limit") || 50,
      url.searchParams.get("workspace") || "",
    ));
    return;
  }

  // Connected Apps: OAuth configuration and account consent live behind the
  // Plugins sidebar. OAuth tokens are stored encrypted at rest by SecretStore;
  // these endpoints return statuses only, never raw credentials.
  if (req.method === "GET" && pathname === "/api/apps") {
    sendJson(res, 200, agent.appConnections.getCatalog());
    return;
  }

  if (req.method === "POST" && pathname === "/api/apps/oauth/config") {
    try {
      const body = await parseBody(req);
      sendJson(res, 200, agent.appConnections.configureOAuth(body));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/apps/oauth/start") {
    try {
      const started = agent.appConnections.beginOAuth(url.searchParams.get("provider"));
      res.writeHead(302, { Location: started.url, "Cache-Control": "no-store" });
      res.end();
    } catch (error) {
      sendOAuthCallbackPage(res, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/apps/oauth/callback/")) {
    const provider = pathname.slice("/api/apps/oauth/callback/".length);
    try {
      await agent.appConnections.completeOAuth({
        provider,
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
        error: url.searchParams.get("error"),
        errorDescription: url.searchParams.get("error_description"),
      });
      sendOAuthCallbackPage(res, { ok: true, message: `${provider} is connected to OmniClaw. Return to the Plugins sidebar and refresh the app card.` });
    } catch (error) {
      sendOAuthCallbackPage(res, { ok: false, message: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/apps/disconnect") {
    try {
      const body = await parseBody(req);
      sendJson(res, 200, agent.appConnections.disconnect(body.provider));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/apps/computer-use") {
    try {
      const body = await parseBody(req);
      sendJson(res, 200, agent.appConnections.setComputerUse(body.enabled === true));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors") {
    sendJson(res, 200, {
      config: agent.connectors.getPublicConfig(),
      adaptersOverview: agent.connectors.getAdaptersOverview(),
      adapters: agent.connectors.listAdapters(),
      telegramWorker: agent.telegramWorker.getStatus(),
      discordWorker: agent.discordWorker.getStatus(),
      adapterDeliveries: agent.connectors.listAdapterDeliveries(adapterHistoryOptions(url)),
      adapterOutbox: agent.connectors.listAdapterOutbox(adapterHistoryOptions(url, "outboxLimit", "outboxStatus")),
      adapterAttachmentCache: agent.connectors.listAdapterAttachmentCache(adapterHistoryOptions(url, "cacheLimit", "cacheStatus")),
      adapterAttachmentExtracts: agent.connectors.listAdapterAttachmentExtracts(adapterHistoryOptions(url, "extractLimit", "extractStatus")),
      adapterAttachmentInjections: agent.connectors.listAdapterAttachmentInjections(adapterHistoryOptions(url, "injectLimit", "injectStatus")),
      adapterAttachmentAnalyses: agent.connectors.listAdapterAttachmentAnalyses(adapterHistoryOptions(url, "analysisLimit", "analysisStatus")),
      attachmentCleanupRuns: agent.connectors.listAttachmentCleanupRuns(Number(url.searchParams.get("cleanupLimit") || 10)),
      overview: agent.connectors.getOverview(),
      webhookDeliveries: agent.connectors.listWebhookDeliveries(Number(url.searchParams.get("limit") || 20)),
      fileDropRecords: agent.connectors.listFileDropRecords(Number(url.searchParams.get("limit") || 20)),
      pendingFiles: agent.connectors.listPendingFiles({
        limit: Number(url.searchParams.get("pendingLimit") || 20),
        agentId: url.searchParams.get("agentId") || "",
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/adapters") {
    sendJson(res, 200, {
      overview: agent.connectors.getAdaptersOverview(),
      adapters: agent.connectors.listAdapters(),
      telegramWorker: agent.telegramWorker.getStatus(),
      discordWorker: agent.discordWorker.getStatus(),
      adapterDeliveries: agent.connectors.listAdapterDeliveries(adapterHistoryOptions(url)),
      adapterOutbox: agent.connectors.listAdapterOutbox(adapterHistoryOptions(url, "outboxLimit", "outboxStatus")),
      adapterAttachmentCache: agent.connectors.listAdapterAttachmentCache(adapterHistoryOptions(url, "cacheLimit", "cacheStatus")),
      adapterAttachmentExtracts: agent.connectors.listAdapterAttachmentExtracts(adapterHistoryOptions(url, "extractLimit", "extractStatus")),
      adapterAttachmentInjections: agent.connectors.listAdapterAttachmentInjections(adapterHistoryOptions(url, "injectLimit", "injectStatus")),
      adapterAttachmentAnalyses: agent.connectors.listAdapterAttachmentAnalyses(adapterHistoryOptions(url, "analysisLimit", "analysisStatus")),
      attachmentCleanupRuns: agent.connectors.listAttachmentCleanupRuns(Number(url.searchParams.get("cleanupLimit") || 10)),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/config") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.setAdapterConfig(body);
      agent.gateway.addEvent("connector.adapter_config_updated", {
        adapterId: result.adapter.id,
        enabled: result.adapter.enabled,
        status: result.adapter.status,
        defaultAgentId: result.adapter.defaultAgentId,
        secretUpdated: result.secretUpdated,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/test") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.testAdapter(body.adapterId || body.id);
      agent.gateway.addEvent("connector.adapter_tested", {
        adapterId: result.adapterId,
        ok: result.ok,
        status: result.status,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/retry") {
    try {
      const body = await parseBody(req);
      const result = await retryAdapterOutbox(body.outboxId || body.id);
      agent.gateway.addEvent("connector.adapter_outbox_retried", {
        outboxId: result.outbox?.id || body.outboxId || "",
        adapterId: result.outbox?.adapterId || "",
        status: result.outbox?.status || "",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message, outbox: error.outbox || null });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/cache") {
    try {
      const body = await parseBody(req);
      const result = await cacheAdapterAttachment({
        deliveryId: body.deliveryId || body.id,
        attachmentIndex: Number(body.attachmentIndex || 0),
        attachmentId: body.attachmentId || "",
        maxBytes: Number(body.maxBytes || 5_000_000),
      });
      agent.gateway.addEvent("connector.adapter_attachment_cache_requested", {
        deliveryId: result.cache?.deliveryId || body.deliveryId || "",
        cacheId: result.cache?.id || "",
        adapterId: result.cache?.adapterId || "",
        status: result.cache?.status || "",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message, cache: error.cache || null, delivery: error.delivery || null });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/extract") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.extractAdapterAttachmentCache({
        cacheId: body.cacheId || body.id,
        deliveryId: body.deliveryId || "",
        attachmentIndex: Number(body.attachmentIndex || 0),
        maxBytes: Number(body.maxBytes || 1_000_000),
        maxChars: Number(body.maxChars || 12000),
      });
      agent.gateway.addEvent("connector.adapter_attachment_extracted", {
        extractId: result.extract?.id || "",
        cacheId: result.extract?.cacheId || body.cacheId || "",
        deliveryId: result.extract?.deliveryId || "",
        adapterId: result.extract?.adapterId || "",
        status: result.extract?.status || "",
        characterCount: result.extract?.characterCount || 0,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/inject") {
    try {
      const body = await parseBody(req);
      const result = await agent.injectAdapterAttachmentExtract({
        extractId: body.extractId || body.id,
        agentId: body.agentId || "",
        sessionId: body.sessionId || "",
        label: body.label || "",
        maxChars: Number(body.maxChars || 12000),
        source: "api",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        error: error.message,
        injection: error.injection || null,
        extract: error.extract || null,
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/analyze") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.analyzeAdapterAttachmentMedia({
        extractId: body.extractId || body.id || "",
        cacheId: body.cacheId || "",
        deliveryId: body.deliveryId || "",
        attachmentIndex: Number(body.attachmentIndex || 0),
        force: body.force === true,
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      agent.gateway.addEvent("connector.adapter_attachment_media_analyzed", {
        analysisId: result.analysis?.id || "",
        extractId: result.analysis?.extractId || "",
        adapterId: result.analysis?.adapterId || "",
        provider: result.analysis?.provider || "",
        status: result.analysis?.status || "",
        characterCount: result.analysis?.characterCount || 0,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/analyze-pending") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.analyzePendingMediaAttachments({
        limit: Number(body.limit || 5),
        force: body.force === true,
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      agent.gateway.addEvent("connector.adapter_attachment_media_batch_analyzed", {
        scanned: result.scanned,
        completed: result.completed,
        failed: result.failed,
        skipped: result.skipped,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/media-provider/test") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.testAttachmentMediaAnalysisProvider({
        mediaKind: body.mediaKind || "",
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
        testArgs: "testArgs" in body ? body.testArgs : undefined,
      });
      agent.gateway.addEvent("connector.media_provider_tested", {
        provider: result.provider,
        mediaKind: result.mediaKind,
        routeApplied: result.routeApplied,
        status: result.status,
        ok: result.ok,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/adapters/attachments/media-provider/setup") {
    try {
      const result = await agent.connectors.getLocalMediaProviderSetup();
      agent.gateway.addEvent("connector.media_provider_setup_checked", {
        readyCount: result.readyCount,
        missingCount: result.missingCount,
        warnings: result.warnings.length,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/media-provider/install-plan") {
    try {
      const body = await parseBody(req);
      const result = await agent.connectors.createLocalMediaProviderInstallPlan({
        engineIds: Array.isArray(body.engineIds) ? body.engineIds : [],
        includeAvailable: body.includeAvailable === true,
        platform: body.platform || "",
      });
      agent.gateway.addEvent("connector.media_provider_install_plan_created", {
        targetCount: result.targetCount,
        commandCount: result.commandCount,
        platform: result.platform,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/ingest") {
    try {
      const body = await parseBody(req);
      const deliveryId = String(body.deliveryId || body.id || "").trim();
      if (!deliveryId) {
        throw new Error("deliveryId is required");
      }
      const delivery = agent.connectors.getAdapterDelivery(deliveryId);
      const result = await agent.ingestAdapterDeliveryAttachments(delivery, {
        force: body.force === true,
        source: "api",
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/adapters/attachments/cleanup") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.cleanupAdapterAttachmentCache({
        dryRun: body.dryRun !== false,
        force: body.force === true,
        policy: body.policy && typeof body.policy === "object" ? body.policy : {},
      });
      agent.gateway.addEvent("connector.adapter_attachment_cleanup_completed", {
        status: result.status,
        dryRun: result.dryRun,
        candidates: result.candidates,
        purged: result.purged,
        orphanPurged: result.orphanPurged,
        bytesFreed: result.bytesFreed,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/telegram/status") {
    sendJson(res, 200, {
      telegramWorker: agent.telegramWorker.getStatus(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/connectors/discord/status") {
    sendJson(res, 200, {
      discordWorker: agent.discordWorker.getStatus(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/discord/start") {
    try {
      const body = await parseBody(req);
      const discordWorker = agent.discordWorker.start({
        connectNow: body.connectNow !== false,
      });
      sendJson(res, 200, { discordWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/discord/stop") {
    try {
      const body = await parseBody(req);
      const discordWorker = agent.discordWorker.stop(body.reason || "api-stop");
      sendJson(res, 200, { discordWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/discord/dispatch") {
    try {
      const body = await parseBody(req);
      const result = await agent.discordWorker.dispatch({
        mockEvents: Array.isArray(body.mockEvents) ? body.mockEvents : undefined,
        event: body.event,
        payload: body.payload,
        reply: Boolean(body.reply),
        source: body.source || "api",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/telegram/start") {
    try {
      const body = await parseBody(req);
      const telegramWorker = agent.telegramWorker.start({
        intervalMs: Number(body.intervalMs || 5000),
        limit: Number(body.limit || 10),
        runNow: body.runNow !== false,
      });
      sendJson(res, 200, { telegramWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/telegram/stop") {
    try {
      const body = await parseBody(req);
      const telegramWorker = agent.telegramWorker.stop(body.reason || "api-stop");
      sendJson(res, 200, { telegramWorker });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/telegram/poll") {
    try {
      const body = await parseBody(req);
      const result = await agent.telegramWorker.pollOnce({
        limit: Number(body.limit || 10),
        timeoutSeconds: Number(body.timeoutSeconds || 1),
        offset: body.offset,
        mockUpdates: Array.isArray(body.mockUpdates) ? body.mockUpdates : undefined,
        reply: body.reply !== false,
        source: body.source || "api",
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message, adapter: error.adapter || null });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/webhook") {
    try {
      const body = await parseBody(req);
      const result = await agent.receiveWebhook({
        ...body,
        connectorToken: getConnectorToken(req, body, url),
        source: body.source || "http",
      });
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, code: error.code || "webhook_failed" });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/config") {
    try {
      const body = await parseBody(req);
      const result = agent.connectors.updateConfig({
        webhook: body.webhook || {},
        fileDrop: body.fileDrop || {},
        attachmentIngestion: body.attachmentIngestion || {},
        attachmentRetention: body.attachmentRetention || {},
        attachmentMediaAnalysis: body.attachmentMediaAnalysis || {},
      });
      agent.gateway.addEvent("connector.config_updated", {
        webhookEnabled: result.config.webhook.enabled,
        webhookDefaultAgentId: result.config.webhook.defaultAgentId,
        webhookAllowPayloadAgent: result.config.webhook.allowPayloadAgent,
        webhookRequireToken: result.config.webhook.requireToken,
        fileDropEnabled: result.config.fileDrop.enabled,
        fileDropDefaultAgentId: result.config.fileDrop.defaultAgentId,
        fileDropArchiveProcessed: result.config.fileDrop.archiveProcessed,
        attachmentIngestionEnabled: result.config.attachmentIngestion.enabled,
        attachmentAutoInject: result.config.attachmentIngestion.autoInject,
        attachmentRetentionEnabled: result.config.attachmentRetention.enabled,
        attachmentRetentionMaxBytes: result.config.attachmentRetention.maxTotalBytes,
        attachmentMediaAnalysisEnabled: result.config.attachmentMediaAnalysis.enabled,
        attachmentMediaAnalysisProvider: result.config.attachmentMediaAnalysis.provider,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/webhook/token/rotate") {
    try {
      const result = agent.connectors.rotateWebhookToken();
      agent.gateway.addEvent("connector.webhook_token_rotated", {
        tokenPreview: result.config.webhook.tokenPreview,
        tokenRotatedAt: result.config.webhook.tokenRotatedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/connectors/file-drop/scan") {
    try {
      const body = await parseBody(req);
      const result = await agent.scanFileDrop({
        agentId: body.agentId || "",
        limit: Number(body.limit || 10),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message, code: error.code || "file_drop_failed" });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/memory") {
    const agentId = String(url.searchParams.get("agentId") || "").trim();
    sendJson(res, 200, {
      overview: agent.memory.getOverview(agentId),
      longTerm: agent.memory.getLongTermMemory(Number(url.searchParams.get("limit") || 50), agentId),
      dreams: agent.memory.getDreams(Number(url.searchParams.get("dreamLimit") || 20), agentId),
      candidates: agent.memory.getPromotionCandidates({
        agentId,
        limit: Number(url.searchParams.get("candidateLimit") || 12),
      }),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/memory/insights") {
    const agentId = String(url.searchParams.get("agentId") || "").trim();
    const dreams = agent.memory.getDreams(10, agentId);
    const insight = dreams.length > 0 ? dreams[0] : null;
    sendJson(res, 200, { insight });
    return;
  }

  if (req.method === "POST" && pathname === "/api/memory/promote") {
    try {
      const body = await parseBody(req);
      const result = agent.memory.promoteMemory(body);
      agent.gateway.addEvent("memory.promoted", {
        memoryId: result.memory.id,
        created: result.created,
        sourceRef: result.memory.sourceRef,
        agentId: result.memory.agentId,
      });
      sendJson(res, result.created ? 201 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/memory/dream") {
    try {
      const body = await parseBody(req);
      const result = await agent.memory.runDreamSweep({
        agentId: body.agentId || "main",
        limit: Number(body.limit || 5),
        minScore: Number(body.minScore || 0.65),
        source: "api",
        provider: agent.provider,
      });
      agent.gateway.addEvent("memory.dream_completed", {
        dreamId: result.dream.id,
        promotedCount: result.promoted.length,
        agentId: result.dream.agentId,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/summary")) {
    const sessionId = pathname.slice("/api/sessions/".length, -"/summary".length);
    let summary = agent.summarizer.readSummary(sessionId);
    // On-demand generate: ?generate=1 builds a summary from the transcript when
    // none exists (or when force=1 and a provider is configured). Additive —
    // default GET still 404s when missing so old clients keep working.
    if ((!summary || url.searchParams.get("force") === "1") && url.searchParams.get("generate") === "1") {
      if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
      const raw = agent.sessions.read?.() || null;
      const sessionMeta = raw && Array.isArray(raw.sessions)
        ? raw.sessions.find((s) => s.id === sessionId)
        : null;
      if (!sessionMeta) {
        sendJson(res, 404, { error: "Session not found" });
        return;
      }
      try {
        const entries = agent.sessions.readTranscriptEntries(sessionMeta, 0);
        const generated = await agent.summarizer.summarizeSession(sessionMeta, entries, { force: url.searchParams.get("force") === "1" });
        summary = generated || agent.summarizer.readSummary(sessionId) || null;
      } catch (error) {
        sendJson(res, 502, { error: `Summary generate failed: ${error.message}` });
        return;
      }
    }
    if (!summary) {
      sendJson(res, 404, { error: "Summary not found for session" });
      return;
    }
    sendJson(res, 200, { summary });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/sessions/") && !pathname.endsWith("/export") && !pathname.endsWith("/summary") && pathname !== "/api/sessions/search") {
    const sessionId = pathname.slice("/api/sessions/".length);
    const session = agent.sessions.getSession(sessionId, {
      messageLimit: Number(url.searchParams.get("messageLimit") || 80),
    });
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }

  // T2.2 (additive, loopback-only): per-session pinned toolsets for the menu
  // builder (composer "+ → Tools"). Unknown names → 400 EINVAL.
  if (req.method === "POST" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/toolsets")) {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const sessionId = pathname.slice("/api/sessions/".length, -"/toolsets".length);
      const body = await parseBody(req);
      const names = Array.isArray(body.toolsets) ? body.toolsets.map((t) => String(t || "").trim()).filter(Boolean) : null;
      if (!names) { sendErr(res, 400, "EINVAL", "toolsets array is required."); return; }
      const known = new Set(Object.keys(TOOLSETS));
      const bad = names.filter((name) => !known.has(name));
      if (bad.length) { sendErr(res, 400, "EINVAL", `Unknown toolset(s): ${bad.join(", ")}.`); return; }
      const session = agent.sessions.updateSession(sessionId, { pinnedToolsets: [...new Set(names)] });
      sendJson(res, 200, { ok: true, pinnedToolsets: session.pinnedToolsets || [] });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions/rename") {    try {
      const body = await parseBody(req);
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const session = agent.sessions.renameSession(sessionId, body.label);
      agent.gateway.addEvent("session.renamed", { sessionId, label: session.label });
      sendJson(res, 200, { session });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions/reset") {
    try {
      const body = await parseBody(req);
      const sessionId = String(body.sessionId || "").trim();
      const reason = String(body.reason || "manual-reset").trim();
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const session = agent.sessions.archiveSession(sessionId, reason);
      agent.gateway.addEvent("session.reset", {
        sessionId,
        reason,
      });
      sendJson(res, 200, { session });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions/cleanup-problem-history") {
    try {
      const body = await parseBody(req);
      const result = agent.sessions.cleanupProblemSessions({
        reason: body.reason || "cleanup-problem-history",
        includeArchived: Boolean(body.includeArchived),
        patterns: Array.isArray(body.patterns) ? body.patterns : undefined,
      });
      agent.gateway.addEvent("session.cleanup_problem_history", result);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/system/status") {
    try {
      const summary = await agent.systemMonitor.getSystemSummary();
      const processes = await agent.systemMonitor.listProcesses();
      sendJson(res, 200, { summary, processes });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/approvals") {
    // 4B.1 additive: ?status=pending filters server-side for the global
    // approvals store poll; default (no param) returns the full list as before.
    sendJson(res, 200, {
      // ?agentId=<id> narrows to one agent's items; ?agentId=system selects
  // only the unattributed ones (POST /api/tools/run). "" = everything.
  approvals: agent.gateway.listApprovals(String(url.searchParams.get("status") || ""), String(url.searchParams.get("agentId") || "")),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/shell/audit") {
    sendJson(res, 200, {
      overview: agent.shellAudit.getOverview(),
      policy: agent.shellExecutor.getPolicy(),
      records: agent.shellAudit.list({
        limit: Number(url.searchParams.get("limit") || 50),
        status: url.searchParams.get("status") || "",
        risk: url.searchParams.get("risk") || "",
        query: url.searchParams.get("query") || "",
      }),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/shell/policy") {
    try {
      const body = await parseBody(req);
      const result = agent.customizationEngine.updateShellPolicy(body);
      agent.gateway.addEvent("shell.policy_updated", {
        allowlistMode: result.config.tools?.shellExecution?.allowlistMode,
        trustLevel: result.config.tools?.shellExecution?.trustLevel,
        timeoutMs: result.config.tools?.shellExecution?.timeoutMs,
        maxOutputBytes: result.config.tools?.shellExecution?.maxOutputBytes,
      });
      sendJson(res, 200, {
        ...result,
        policy: agent.shellExecutor.getPolicy(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/approvals/resolve") {
    try {
      const body = await parseBody(req);
      const approvalId = String(body.approvalId || "").trim();
      const decision = String(body.decision || "").trim();
      const note = String(body.note || "").trim();

      if (!approvalId || !decision) {
        sendJson(res, 400, { error: "approvalId and decision are required" });
        return;
      }

      const result = await agent.resolveApproval(approvalId, decision, note);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Q1 (4B.2): open run.question items for UI hydration after reload.
  // Loopback-only (in-memory runtime state). ?status=pending (default) drops
  // expired; ?status= lists all open.
  if (req.method === "GET" && pathname === "/api/questions") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    const status = String(url.searchParams.get("status") ?? "pending");
    const agentIdFilter = String(url.searchParams.get("agentId") || "");
    // Same ?agentId= filter as approvals. "system" = unattributed questions.
    const questions = agent.gateway.listOpenQuestions(status)
      .filter((q) => (agentIdFilter ? (q.agentId ? String(q.agentId) : "system") === agentIdFilter : true));
    sendJson(res, 200, { questions });
    return;
  }

  // Mid-run ask_user answer (question card in the chat UI).
  if (req.method === "POST" && pathname === "/api/questions/answer") {
    try {
      const body = await parseBody(req);
      const result = agent.answerQuestion(body.questionId, body.answer);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/trust") {
    sendJson(res, 200, {
      overview: agent.trust.getOverview(),
      devices: agent.trust.listDevices(),
      pairingRequests: agent.trust.listPairingRequests(),
      audit: agent.trust.listAudit(Number(url.searchParams.get("limit") || 40)),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/overview") {
    sendJson(res, 200, {
      overview: agent.trust.getOverview(),
      devices: agent.trust.listDevices(),
      pairingRequests: agent.trust.listPairingRequests(),
      audit: agent.trust.listAudit(20),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/pairing/request") {
    try {
      const body = await parseBody(req);
      const result = agent.trust.requestPairing({
        label: body.label,
        role: body.role,
        fingerprint: body.fingerprint,
        remoteAddress: req.socket.remoteAddress || "",
      });
      agent.gateway.addEvent(result.tokenRequired ? "trust.device_token_required" : "trust.pairing_requested", {
        requestId: result.request?.id || "",
        deviceId: result.device?.id || "",
        role: result.request?.role || result.device?.role || body.role || "operator",
        fingerprint: result.request?.fingerprint || result.device?.fingerprint || "",
      });
      sendJson(res, result.request ? 202 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing/request") {
    try {
      const body = await parseBody(req);
      const result = agent.trust.requestPairing({
        label: body.label,
        role: body.role,
        fingerprint: body.fingerprint,
        remoteAddress: req.socket.remoteAddress || "",
      });
      agent.gateway.addEvent(result.tokenRequired ? "trust.device_token_required" : "trust.pairing_requested", {
        requestId: result.request?.id || "",
        deviceId: result.device?.id || "",
        role: result.request?.role || result.device?.role || body.role || "operator",
        fingerprint: result.request?.fingerprint || result.device?.fingerprint || "",
      });
      sendJson(res, result.request ? 202 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/pairing/approve") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const result = agent.trust.approvePairing(requestId, String(body.note || "dashboard-approval").trim());
      agent.gateway.addEvent("trust.pairing_approved", {
        requestId,
        deviceId: result.device.id,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing/approve") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const result = agent.trust.approvePairing(requestId, String(body.note || "auth-approval").trim());
      agent.gateway.addEvent("trust.pairing_approved", {
        requestId,
        deviceId: result.device.id,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/pairing/reject") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const request = agent.trust.rejectPairing(requestId, String(body.note || "dashboard-rejection").trim());
      agent.gateway.addEvent("trust.pairing_rejected", {
        requestId,
        role: request.role,
      });
      sendJson(res, 200, { request });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/pairing/reject") {
    try {
      const body = await parseBody(req);
      const requestId = String(body.requestId || "").trim();
      if (!requestId) {
        sendJson(res, 400, { error: "requestId is required" });
        return;
      }
      const request = agent.trust.rejectPairing(requestId, String(body.note || "auth-rejection").trim());
      agent.gateway.addEvent("trust.pairing_rejected", {
        requestId,
        role: request.role,
      });
      sendJson(res, 200, { request });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/devices/revoke") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const device = agent.trust.revokeDevice(deviceId, String(body.note || "dashboard-revoke").trim());
      agent.gateway.addEvent("trust.device_revoked", {
        deviceId,
        role: device.role,
      });
      sendJson(res, 200, { device });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/device/revoke") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const device = agent.trust.revokeDevice(deviceId, String(body.note || "auth-device-revoke").trim());
      agent.gateway.addEvent("trust.device_revoked", {
        deviceId,
        role: device.role,
      });
      sendJson(res, 200, { device });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/devices/rotate-token") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const result = agent.trust.rotateDeviceToken(deviceId, String(body.note || "dashboard-token-rotation").trim());
      agent.gateway.addEvent("trust.device_token_rotated", {
        deviceId,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/device-token/rotate") {
    try {
      const body = await parseBody(req);
      const deviceId = String(body.deviceId || "").trim();
      if (!deviceId) {
        sendJson(res, 400, { error: "deviceId is required" });
        return;
      }
      const result = agent.trust.rotateDeviceToken(deviceId, String(body.note || "auth-token-rotation").trim());
      agent.gateway.addEvent("trust.device_token_rotated", {
        deviceId,
        role: result.device.role,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/trust/gateway/rotate") {
    try {
      const result = agent.trust.rotateGatewayToken();
      agent.gateway.addEvent("trust.gateway_token_rotated", {
        rotatedAt: result.status.rotatedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/gateway-token/rotate") {
    try {
      const result = agent.trust.rotateGatewayToken();
      agent.gateway.addEvent("trust.gateway_token_rotated", {
        rotatedAt: result.status.rotatedAt,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/auth/gateway-token/revoke") {
    try {
      const body = await parseBody(req);
      const status = agent.trust.revokeGatewayToken(String(body.note || "auth-gateway-revoke").trim());
      agent.gateway.addEvent("trust.gateway_token_revoked", {
        revokedAt: status.revokedAt,
      });
      sendJson(res, 200, { status });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // ── MCP Server Endpoints ──────────────────────────────────────
 if (req.method === "GET" && pathname === "/api/mcp/status") {
   try { sendJson(res, 200, agent.mcp.getStatus()); } catch (e) { sendJson(res, 500, { error: e.message }); }
   return;
 }
 if (req.method === "POST" && pathname.startsWith("/api/mcp/connect/")) {
   const serverId = pathname.split("/").filter(Boolean).pop();
   try {
     const client = await agent.mcp.connectServer(serverId);
     sendJson(res, 200, { connected: true, serverId, tools: client.tools.map(t => t.name) });
   } catch (e) { sendJson(res, 500, { error: e.message }); }
   return;
 }
 if (req.method === "POST" && pathname.startsWith("/api/mcp/disconnect/")) {
   const serverId = pathname.split("/").filter(Boolean).pop();
   try {
     const client = agent.mcp.clients.get(serverId);
     if (client) client.disconnect();
     agent.mcp.clients.delete(serverId);
     sendJson(res, 200, { disconnected: true, serverId });
   } catch (e) { sendJson(res, 500, { error: e.message }); }
   return;
 }
 if (req.method === "GET" && pathname === "/api/mcp/tools") {
   sendJson(res, 200, { tools: agent.mcp.getAllTools() });
   return;
 }
 if (req.method === "POST" && pathname === "/api/mcp/call") {
   try {
     const body = await parseBody(req);
     if (!body.toolId) { sendJson(res, 400, { error: "toolId required" }); return; }
     const result = await agent.mcp.callTool(body.toolId, body.args || {});
     sendJson(res, 200, { result });
   } catch (e) { sendJson(res, 500, { error: e.message }); }
   return;
 }

if (req.method === "GET" && pathname === "/api/workspace") {
    sendJson(res, 200, {
      ...agent.getWorkspaceState(),
      selection: agent.workspaces.getState(),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/workspace/select") {
    try {
      const body = await parseBody(req);
      const result = agent.selectWorkspace(body.path || body.workspacePath || "");
      if (!result.ok) {
        sendJson(res, 400, result);
        return;
      }
      sendJson(res, 200, {
        ...result,
        selection: agent.workspaces.getState(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/fs/browse") {
    const requested = url.searchParams.get("path") || "";
    const result = agent.workspaces.browse(requested);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── B1 fs routes (R12: additive; loopback-only; computer-access policy) ──
  if (req.method === "GET" && pathname === "/api/fs/tree") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const { target } = b1ResolveFs(url.searchParams.get("path") || "");
      const depth = Math.max(0, Math.min(5, Number(url.searchParams.get("depth") || 2)));
      const ignore = new Set(String(url.searchParams.get("ignore") || "node_modules,.git,dist,.venv")
        .split(",").map((s) => s.trim()).filter(Boolean));
      const MAX_ENTRIES = 5000;
      let count = 0;
      let truncated = false;
      const walk = (dir, level) => {
        const out = [];
        if (truncated) return out;
        let entries = [];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return out;
        }
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : (a.isDirectory() ? -1 : 1)));
        for (const entry of entries) {
          if (count >= MAX_ENTRIES) { truncated = true; break; }
          if (entry.isSymbolicLink()) continue;
          if (ignore.has(entry.name)) continue;
          // Dot-directories (.git internals, .venv, IDE dirs) stay hidden
          // like the workspace browser (browse skips dotted names too).
          if (entry.isDirectory() && entry.name.startsWith(".")) continue;
          const abs = path.join(dir, entry.name);
          let node = null;
          try {
            node = b1FsEntry(abs, entry.name);
          } catch {
            continue;
          }
          count++;
          if (entry.isDirectory() && level < depth) {
            node.children = walk(abs, level + 1);
          }
          out.push(node);
        }
        return out;
      };
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) throw { status: 400, code: "EINVAL", message: "Not a directory." };
      sendJson(res, 200, { path: target, entries: walk(target, 0), truncated });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/fs/read") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const requested = String(url.searchParams.get("path") || "").trim();
      if (!requested) throw { status: 400, code: "EINVAL", message: "path is required." };
      const { target } = b1ResolveFs(requested);
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) {
        // B1 step 9: optional ?maxBytes= (≤1MB) + lines count.
        const HARD_CAP = 1024 * 1024;
        let maxBytes = HARD_CAP;
        const asked = url.searchParams.get("maxBytes");
        if (asked !== null && asked !== "") {
          const n = Number(asked);
          if (!Number.isFinite(n) || n <= 0 || n > HARD_CAP) {
            throw { status: 400, code: "EINVAL", message: "maxBytes must be between 1 and 1048576." };
          }
          maxBytes = Math.floor(n);
        }
        if (stat.size > HARD_CAP) {
          throw { status: 413, code: "ETOOBIG", message: `File too large (${stat.size} bytes, cap 1MB).` };
        }
        const buffer = fs.readFileSync(target).subarray(0, maxBytes);
        const head = buffer.subarray(0, Math.min(buffer.length, 8192));
        if (head.includes(0)) {
          sendJson(res, 200, { path: target, size: stat.size, mtime: stat.mtimeMs, binary: true });
          return;
        }
        const content = buffer.toString("utf8");
        sendJson(res, 200, {
          path: target, size: stat.size, mtime: stat.mtimeMs,
          encoding: "utf8", content,
          lines: content.length ? content.split("\n").length : 0,
        });
        return;
      }
      throw { status: 400, code: "EINVAL", message: "Not a file." };
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/fs/search") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) throw { status: 400, code: "EINVAL", message: "q is required." };
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
      const { target } = b1ResolveFs(url.searchParams.get("path") || "");
      const ignore = new Set(["node_modules", ".git", "dist", ".venv"]);
      const needle = q.toLowerCase();
      // Substring match first; subsequence (fuzzy) fallback.
      const fuzzy = (name) => {
        const hay = name.toLowerCase();
        if (hay.includes(needle)) return true;
        let i = 0;
        for (const ch of hay) {
          if (ch === needle[i]) i++;
          if (i >= needle.length) return true;
        }
        return false;
      };
      const entries = [];
      let scanned = 0;
      const SCAN_CAP = 20000;
      const walk = (dir) => {
        if (entries.length >= limit || scanned >= SCAN_CAP) return;
        let items = [];
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of items) {
          if (entries.length >= limit || scanned >= SCAN_CAP) return;
          if (entry.isSymbolicLink()) continue;
          if (ignore.has(entry.name)) continue;
          if (entry.isDirectory() && entry.name.startsWith(".")) continue;
          scanned++;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(abs);
          } else if (fuzzy(entry.name)) {
            try {
              entries.push(b1FsEntry(abs, entry.name));
            } catch {
              // Vanished mid-walk — skip.
            }
          }
        }
      };
      walk(target);
      sendJson(res, 200, { q, limit, path: target, entries });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/fs/write") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const body = await parseBody(req);
      const requested = String(body.path || "").trim();
      if (!requested) throw { status: 400, code: "EINVAL", message: "path is required." };
      if (typeof body.content !== "string") throw { status: 400, code: "EINVAL", message: "content must be a string." };
      if (Buffer.byteLength(body.content, "utf8") > 2 * 1024 * 1024) {
        throw { status: 413, code: "ETOOBIG", message: "Content too large (cap 2MB)." };
      }
      const { target, policy } = b1ResolveFs(requested);
      if (policy.allowWrite === false) {
        throw { status: 403, code: "EPERM", message: "Computer file writes are disabled by policy." };
      }
      if (body.expectedMtime !== undefined && body.expectedMtime !== null) {
        let current = null;
        try {
          current = fs.statSync(target).mtimeMs;
        } catch {
          current = null;
        }
        if (current !== null && Number(body.expectedMtime) !== current) {
          throw { status: 409, code: "EINVAL", message: "File changed on disk (expectedMtime mismatch). Re-read first." };
        }
      }
      // Same writer the tools use (mkdir -p included).
      const result = agent.files.writeComputerText(target, body.content, { policy });
      const mtime = fs.statSync(result.path).mtimeMs;
      agent.gateway.addEvent("fs.changed", { path: result.path, mtime });
      sendJson(res, 200, { ok: true, path: result.path, mtime, bytesWritten: result.bytesWritten });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  // Git state for the selected workspace. These are fixed, read-only git
  // invocations with an already-validated workspace as their cwd. execFileSync
  // deliberately avoids a shell, so branch/file names never become command
  // syntax. This powers the dock's real Files & Changes view.
  if (req.method === "GET" && pathname === "/api/workspace/git") {
    const target = agent.getWorkspaceRoot();
    if (!fs.existsSync(path.join(target, ".git"))) {
      sendJson(res, 200, { isRepo: false, path: target, current: null, branches: [], changes: [] });
      return;
    }
    try {
      const stdout = execFileSync("git", ["branch", "--list", "--no-color"], {
        cwd: target,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      });
      const branches = String(stdout || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const current = line.startsWith("*");
          return { name: line.replace(/^\*\s*/, "").trim(), current };
        });
      const statusOutput = execFileSync("git", ["status", "--short", "--branch"], {
        cwd: target,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      });
      const changes = String(statusOutput || "")
        .split("\n")
        .slice(1) // first line is the branch header (## main...origin/main)
        .map((line) => {
          const match = line.match(/^(.{2})\s+(.+)$/);
          if (!match) return null;
          const status = match[1];
          const filePath = match[2].trim();
          return {
            status,
            path: filePath,
            kind: status === "??" ? "untracked" : status.includes("D") ? "deleted" : status.includes("A") ? "added" : "modified",
          };
        })
        .filter(Boolean);
      sendJson(res, 200, {
        isRepo: true,
        path: target,
        current: branches.find((branch) => branch.current)?.name || null,
        branches,
        changes,
      });
    } catch (error) {
      sendJson(res, 200, {
        isRepo: true,
        path: target,
        current: null,
        branches: [],
        changes: [],
        error: String(error.message || "").slice(0, 300),
      });
    }
    return;
  }

  // ── B1 git routes (R12: additive; loopback-only; workspace-contained) ──
  if (req.method === "GET" && pathname === "/api/git/status") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    const root = agent.getWorkspaceRoot();
    if (!fs.existsSync(path.join(root, ".git"))) {
      sendJson(res, 200, { isRepo: false });
      return;
    }
    try {
      const branchOut = runGit(["branch", "--show-current"], root);
      const branch = branchOut.ok ? String(branchOut.stdout || "").trim() : "";
      // B1 step 9: repo top-level so the UI can compute relative paths.
      const topOut = runGit(["rev-parse", "--show-toplevel"], root);
      const top = topOut.ok ? String(topOut.stdout || "").trim().replace(/\//g, path.sep) : root;
      let ahead = 0;
      let behind = 0;
      const lr = runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], root);
      if (lr.ok) {
        const parts = String(lr.stdout || "").trim().split(/\s+/);
        ahead = Number(parts[0]) || 0;
        behind = Number(parts[1]) || 0;
      }
      const files = b1GitFiles(root);
      let added = 0;
      let deleted = 0;
      const numstat = runGit(["diff", "HEAD", "--numstat"], root);
      if (numstat.ok) {
        for (const line of String(numstat.stdout || "").split("\n")) {
          const m = line.match(/^(\d+)\s+(\d+)\s+/);
          if (m) {
            added += Number(m[1]);
            deleted += Number(m[2]);
          }
        }
      }
      sendJson(res, 200, { isRepo: true, root: top, branch, ahead, behind, files, summary: { added, deleted } });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/git/diff") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const root = b1GitRoot();
      const abs = b1GitPath(root, url.searchParams.get("path") || "");
      const staged = ["1", "true", "yes"].includes(String(url.searchParams.get("staged") || "").toLowerCase());
      const rel = path.relative(root, abs) || ".";
      const files = b1GitFiles(root);
      const tracked = files.find((f) => f.path === rel || path.resolve(root, f.path) === abs);
      const isUntracked = !tracked || tracked.status === "?";
      let patch = "";
      let added = 0;
      let deleted = 0;
      let binary = false;
      if (isUntracked) {
        // Whole file as added lines (Windows: NUL instead of /dev/null).
        const nul = process.platform === "win32" ? "NUL" : "/dev/null";
        const full = runGit(["diff", "--no-index", "--", nul, abs], root);
        patch = full.stdout || "";
        const ns = runGit(["diff", "--no-index", "--numstat", "--", nul, abs], root);
        const m = String(ns.stdout || "").match(/^(\d+)\s+(\d+)\s+/m);
        if (m) {
          added = Number(m[1]);
          deleted = Number(m[2]);
        } else if (patch && !/Binary files .* differ/.test(patch)) {
          added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        }
      } else {
        const args = staged
          ? ["diff", "--cached", "--", rel]
          : ["diff", "--", rel];
        const full = runGit(args, root);
        patch = full.stdout || "";
        const ns = runGit(staged
          ? ["diff", "--cached", "--numstat", "--", rel]
          : ["diff", "--numstat", "--", rel], root);
        const m = String(ns.stdout || "").match(/^(\d+)\s+(\d+)\s+/m);
        if (m) {
          added = Number(m[1]);
          deleted = Number(m[2]);
        }
      }
      if (/Binary files .* differ/.test(patch)) binary = true;
      const PATCH_CAP = 1024 * 1024;
      let truncated = false;
      if (patch.length > PATCH_CAP) {
        patch = patch.slice(0, PATCH_CAP);
        truncated = true;
      }
      sendJson(res, 200, { path: abs, patch, added, deleted, binary, truncated });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  if (req.method === "POST" && (pathname === "/api/git/stage" || pathname === "/api/git/unstage")) {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const root = b1GitRoot();
      const body = await parseBody(req);
      const abs = b1GitPath(root, body.path || "");
      const rel = path.relative(root, abs) || ".";
      const args = pathname === "/api/git/stage"
        ? ["add", "--", rel]
        : ["restore", "--staged", "--", rel];
      const result = runGit(args, root);
      if (!result.ok) throw { status: 400, code: "EINVAL", message: result.error.slice(0, 300) };
      sendJson(res, 200, { ok: true, path: abs });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  // ── B1 system routes (R12: additive; loopback-only) ──
  // Paths pass resolveComputerPath like the computer tools (A2/step-5 spec).
  // explorer.exe/code spawn with shell:false (spawn default) — never cmd /c.
  if (req.method === "POST" && (pathname === "/api/system/reveal" || pathname === "/api/system/open")) {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      if (process.platform !== "win32") {
        throw { status: 400, code: "EINVAL", message: "System open is Windows-only." };
      }
      const body = await parseBody(req);
      const { target } = b1ResolveFs(body.path || "");
      if (pathname === "/api/system/reveal") {
        const r = b1Spawn("explorer.exe", [`/select,${target}`]);
        sendJson(res, 200, { ok: true, path: target, ...r });
        return;
      }
      const app = String(body.app || "default").toLowerCase();
      if (app === "vscode") {
        const codeBin = b1FindOnPath(["code.cmd", "code.exe"]);
        if (!codeBin) {
          sendErr(res, 404, "ENOENT", "VS Code not found");
          return;
        }
        const r = b1Spawn(codeBin, [target]);
        sendJson(res, 200, { ok: true, path: target, app, ...r });
        return;
      }
      if (app === "default") {
        const r = b1Spawn("explorer.exe", [target]);
        sendJson(res, 200, { ok: true, path: target, app, ...r });
        return;
      }
      throw { status: 400, code: "EINVAL", message: 'app must be "vscode" or "default".' };
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/git/revert") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const root = b1GitRoot();
      const body = await parseBody(req);
      if (body.confirm !== true) {
        throw { status: 400, code: "EINVAL", message: "confirm:true is required." };
      }
      const abs = b1GitPath(root, body.path || "");
      const rel = path.relative(root, abs) || ".";
      const result = runGit(["checkout", "--", rel], root);
      if (!result.ok) throw { status: 400, code: "EINVAL", message: result.error.slice(0, 300) };
      sendJson(res, 200, { ok: true, path: abs });
    } catch (error) {
      b1FsError(res, error);
    }
    return;
  }

  // B1 step 8: static capability map so the frontend hides features honestly.
  if (req.method === "GET" && pathname === "/api/capabilities") {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    sendJson(res, 200, b1Capabilities());
    return;
  }

  if (req.method === "GET" && pathname === "/api/models") {
    try {
      const result = await agent.provider.listModels({});
      sendJson(res, result.ok === false ? 400 : 200, {
        ok: result.ok !== false,
        models: result.models || [],
        endpoint: result.endpoint || "",
        error: result.error || null,
        activeModel: agent.config.getConfig()?.provider?.model || "",
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, models: [], error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/schedules") {
    sendJson(res, 200, {
      overview: agent.scheduler.getOverview(),
      schedules: agent.schedules.listSchedules(Number(url.searchParams.get("limit") || 50)),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules") {
    try {
      const body = await parseBody(req);
      const tool = String(body.tool || "").trim();
      if (!tool) {
        sendJson(res, 400, { error: "tool is required" });
        return;
      }
      const schedule = agent.scheduler.createSchedule({
        name: String(body.name || `${tool} schedule`).trim(),
        tool,
        input: body.input || {},
        agentId: body.agentId || "main",
        intervalMs: Number(body.intervalSeconds || 60) * 1000,
        maxRuns: Number(body.maxRuns || 0),
        runNow: Boolean(body.runNow),
        source: "api",
        retry: {
          maxAttempts: Number(body.retryMaxAttempts || 1),
          delayMs: Number(body.retryDelaySeconds || 5) * 1000,
        },
      });
      sendJson(res, 201, { schedule });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules/run") {
    try {
      const body = await parseBody(req);
      const scheduleId = String(body.scheduleId || "").trim();
      if (!scheduleId) {
        sendJson(res, 400, { error: "scheduleId is required" });
        return;
      }
      const result = agent.scheduler.runNow(scheduleId, "api");
      sendJson(res, 202, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules/toggle") {
    try {
      const body = await parseBody(req);
      const scheduleId = String(body.scheduleId || "").trim();
      if (!scheduleId) {
        sendJson(res, 400, { error: "scheduleId is required" });
        return;
      }
      const schedule = agent.scheduler.setStatus(scheduleId, body.status || "paused");
      sendJson(res, 200, { schedule });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/schedules/delete") {
    try {
      const body = await parseBody(req);
      const scheduleId = String(body.scheduleId || "").trim();
      if (!scheduleId) {
        sendJson(res, 400, { error: "scheduleId is required" });
        return;
      }
      const schedule = agent.scheduler.deleteSchedule(scheduleId);
      sendJson(res, 200, { schedule });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/plugins") {
    sendJson(res, 200, {
      plugins: agent.plugins.getAll(),
      tools: agent.plugins.getToolDefinitions(),
    });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/plugins/")) {
    const pluginId = pathname.slice("/api/plugins/".length);
    const plugin = agent.plugins.getDetail(pluginId);
    if (!plugin) {
      sendJson(res, 404, { error: "Plugin not found" });
      return;
    }
    sendJson(res, 200, { plugin });
    return;
  }

  if (req.method === "POST" && pathname === "/api/plugins/reload") {
    try {
      const plugins = agent.refreshPlugins("http-reload");
      sendJson(res, 200, {
        plugins,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/plugins/toggle") {
    try {
      const body = await parseBody(req);
      const pluginId = String(body.pluginId || "").trim();
      if (!pluginId) {
        sendJson(res, 400, { error: "pluginId is required" });
        return;
      }
      const plugin = agent.plugins.setEnabled(pluginId, Boolean(body.enabled));
      agent.gateway.addEvent("plugin.toggled", {
        pluginId,
        enabled: plugin.enabled,
      });
      agent.refreshPlugins("toggle");
      sendJson(res, 200, plugin);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/plugins/config") {
    try {
      const body = await parseBody(req);
      const pluginId = String(body.pluginId || "").trim();
      if (!pluginId) {
        sendJson(res, 400, { error: "pluginId is required" });
        return;
      }
      const plugin = agent.plugins.updatePluginConfig(pluginId, body.config || {});
      agent.gateway.addEvent("plugin.config_updated", { pluginId });
      agent.refreshPlugins("config-update");
      sendJson(res, 200, plugin);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/jobs") {
    sendJson(res, 200, {
      jobs: agent.jobs.listJobs(50),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/jobs/cancel") {
    try {
      const body = await parseBody(req);
      const jobId = String(body.jobId || "").trim();
      if (!jobId) {
        sendJson(res, 400, { error: "jobId is required" });
        return;
      }
      const job = agent.worker.cancelJob(jobId, String(body.reason || "api-cancel").trim());
      sendJson(res, 200, { job });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/jobs") {
    try {
      const body = await parseBody(req);
      const tool = String(body.tool || "").trim();
      if (!tool) {
        sendJson(res, 400, { error: "tool is required" });
        return;
      }
      const job = agent.worker.enqueueToolJob({
        tool,
        input: body.input || {},
        source: "api",
        agentId: body.agentId || "main",
        scheduleId: body.scheduleId || "",
        runAt: body.runAt || "",
        retry: {
          maxAttempts: Number(body.retryMaxAttempts || body.retry?.maxAttempts || 1),
          delayMs: Number(body.retryDelaySeconds || 5) * 1000,
        },
      });
      sendJson(res, 202, job);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    const state = agent.getState();
    sendJson(res, 200, {
      config: state.config,
      runtime: state.runtime,
      provider: state.provider,
      providerSecrets: state.providerSecrets,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/config") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("update_runtime_settings", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/provider/status") {
    const state = agent.getState();
    let readiness = null;
    try {
      readiness = await agent.customizationEngine.testProviderProfile({ live: false });
    } catch (error) {
      readiness = { ok: false, error: error.message };
    }
    sendJson(res, 200, {
      provider: state.provider,
      providerSecrets: state.providerSecrets,
      readiness,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/design/stitch") {
    const designPath = path.join(runtimeDir, "DESIGN.md");
    const designMd = fs.existsSync(designPath) ? fs.readFileSync(designPath, "utf8") : "";
    sendJson(res, 200, {
      designMd,
      designPath: "DESIGN.md",
      stitchUrl: "https://stitch.withgoogle.com/",
      prompt:
        "Import this DESIGN.md into Stitch, generate a web app dashboard refinement, then export updated DESIGN.md or HTML/CSS back into OmniClaw.",
      updatedAt: fs.existsSync(designPath) ? fs.statSync(designPath).mtime.toISOString() : null,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/design/stitch") {
    try {
      const body = await parseBody(req);
      const designMd = String(body.designMd || "").trim();
      if (!designMd) {
        sendJson(res, 400, { error: "designMd is required" });
        return;
      }
      const designPath = path.join(runtimeDir, "DESIGN.md");
      fs.writeFileSync(designPath, `${designMd}\n`);
      agent.gateway.addEvent("design.stitch_updated", {
        designPath: "DESIGN.md",
        bytes: Buffer.byteLength(designMd, "utf8"),
      });
      sendJson(res, 200, {
        updated: true,
        designPath: "DESIGN.md",
        bytes: Buffer.byteLength(designMd, "utf8"),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/profile") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("apply_provider_profile", body);
      agent.gateway.addEvent("provider.profile_applied", { profileId: body.profileId });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/select") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("select_provider_connection", body);
      if (result && result.ok !== false) {
        agent.gateway.addEvent("provider.selection_committed", {
          profileId: (result.applied && result.applied.profileId) || null,
          model: (result.applied && result.applied.model) || "",
          scope: "global",
        });
      }
      sendJson(res, result && result.ok === false ? 400 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/profile/save") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("save_provider_profile", body);
      agent.gateway.addEvent("provider.profile_saved", { profileId: result.profileId, ok: result.ok });
      sendJson(res, result.ok === false ? 400 : 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/profile/delete") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("delete_provider_profile", body);
      agent.gateway.addEvent("provider.profile_deleted", { profileId: body.profileId, ok: result.ok });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/key") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("set_provider_key", body);
      agent.gateway.addEvent("provider.key_updated", {
        providerId: body.providerId || "openai-compatible",
        configured: Boolean(result.status?.configured),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/provider/key/status") {
    const providerId = String(url.searchParams.get("providerId") || "").trim();
    const statuses = providerId ? [agent.secrets.getProviderKeyStatus(providerId)] : agent.secrets.getAllStatuses();
    sendJson(res, 200, { statuses });
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/test") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("test_provider_profile", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/models") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("list_provider_models", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // D2: minimal real capability probe for one (endpoint, model) — persists to
  // the model registry (same shape as the sibling provider routes).
  if (req.method === "POST" && pathname === "/api/provider/model-test") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("test_provider_model", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // D1/D4: persisted per-(endpoint, model) health + capability states.
  if (req.method === "GET" && pathname === "/api/models/registry") {
    try {
      const reg = loadModelRegistry(agent.rootDir || ".");
      sendJson(res, 200, { models: reg.models || {} });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/provider/codex/login") {
    try {
      const result = startCodexLoginWindow();
      agent.gateway.addEvent("provider.codex_login_started", result);
      sendJson(res, 200, {
        ...result,
        message: "A Codex login terminal was opened. Choose Sign in with ChatGPT there, then return to OmniClaw and test the provider.",
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/skills") {
    sendJson(res, 200, {
      skills: agent.skills.getAll(String(url.searchParams.get("agentId") || "").trim()),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/skills") {
    try {
      const body = await parseBody(req);
      const result = await agent.tools.run("create_skill", body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Real tool catalog for the UI — every registered tool with its group and
  // whether the model can call it (Codex-grade contract).
  if (req.method === "GET" && pathname === "/api/tools") {
    try {
      const all = agent.tools.getAll({ includeAllAgents: true });
      const callable = new Set(agent.tools.getAll({ includeAllAgents: true, modelCallableOnly: true }).map((tool) => tool.id));
      const tools = all.map((tool) => ({
        id: tool.id,
        description: String(tool.description || "").slice(0, 240),
        group: tool.group || "general",
        permission: tool.permission || null,
        modelCallable: callable.has(tool.id),
        runtimeStatus: tool.runtimeStatus || "ready",
      }));
      // T2.2 (additive): ?view=layers groups Core / Toolsets / Operator for
      // the Skills & Tools page (health badge = runtimeStatus).
      if (String(url.searchParams.get("view") || "") === "layers") {
        const inSet = (ids) => new Set(ids);
        const coreIds = inSet(CORE_ORDER);
        const toolsetIds = new Set();
        const toolsets = {};
        for (const [name, set] of Object.entries(TOOLSETS)) {
          toolsets[name] = { description: set.description, tools: [] };
          for (const id of set.members) toolsetIds.add(id);
        }
        const core = [];
        const operator = [];
        const alias = [];
        const drop = [];
        for (const tool of tools) {
          // CORE first (mirrors getToolLayer: aliased CORE names like
          // web_search stay CORE), then alias/drop/operator.
          if (coreIds.has(tool.id)) { core.push(tool); continue; }
          if (DROP_IDS.has(tool.id)) { drop.push(tool); continue; }
          if (Object.hasOwn(ALIAS_OF, tool.id)) { alias.push(tool); continue; }
          if (toolsetIds.has(tool.id)) {
            for (const [name, set] of Object.entries(TOOLSETS)) {
              if (set.members.includes(tool.id)) toolsets[name].tools.push(tool);
            }
            continue;
          }
          operator.push(tool);
        }
        sendJson(res, 200, {
          count: tools.length, modelCallable: callable.size,
          core, toolsets, operator, alias, drop,
        });
        return;
      }
      sendJson(res, 200, { count: tools.length, modelCallable: callable.size, tools });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Chat attachments (images/docs from the composer). JSON {name, dataBase64}
  // with its own body reader — attachments outgrow the normal API body cap.
  if (req.method === "POST" && pathname === "/api/uploads") {
    const MAX_UPLOAD_BYTES = 14 * 1024 * 1024; // ~10MB file after base64
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true;
        try { req.destroy(); } catch { /* gone */ }
        sendJson(res, 413, { error: "Upload too large (max ~10MB)." });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const rawName = String(body.name || "attachment").slice(-120);
        const safeBase = rawName.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "") || "attachment";
        const ext = (safeBase.match(/\.([a-z0-9]{1,6})$/i)?.[1] || "").toLowerCase();
        const ALLOWED = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "txt", "md", "csv", "json", "log", "mp3", "wav", "m4a", "ogg", "webm"]);
        if (!ALLOWED.has(ext)) {
          sendJson(res, 400, { error: `File type .${ext || "?"} not allowed. Allowed: images, pdf, text, audio.` });
          return;
        }
        const data = Buffer.from(String(body.dataBase64 || ""), "base64");
        if (!data.length) {
          sendJson(res, 400, { error: "dataBase64 is required." });
          return;
        }
        const dir = path.join(runtimeDir, "uploads");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const fileName = `${stamp}-${safeBase}`;
        fs.writeFileSync(path.join(dir, fileName), data);
        const relPath = `uploads/${fileName}`;
        agent.gateway.addEvent("upload.saved", { relPath, bytes: data.length });
        sendJson(res, 200, { ok: true, relPath, bytes: data.length, isImage: ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
    });
    req.on("error", () => { if (!aborted) sendJson(res, 400, { error: "Upload stream failed." }); });
    return;
  }

  if (req.method === "POST" && pathname === "/api/tools/run") {
    try {
      const body = await parseBody(req);
      const toolName = String(body.tool || body.name || "").trim();
      if (!toolName) {
        sendJson(res, 400, { error: "tool or name is required" });
        return;
      }
      // 4B.1 additive: optional sessionId/runId passthrough so direct tool
      // calls (panel actions, verification probes) attribute approvals to a
      // session. Capped strings; empty = unattributed (previous behavior).
      const runSessionId = String(body.sessionId || "").trim().slice(0, 200);
      const runRunId = String(body.runId || "").trim().slice(0, 200);
      const result = await agent.tools.run(toolName, body.input || body.params || {}, {
        agentId: body.agentId || "main",
        ...(runSessionId ? { sessionId: runSessionId } : {}),
        ...(runRunId ? { runId: runRunId } : {}),
      });
      sendJson(res, 200, { tool: toolName, result });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // ── Live browser view ──────────────────────────────────────────
  //
  // A real video stream of a tab, plus every action the AGENT takes in it.
  //
  // Screenshot polling was the previous design and it cannot show what the user
  // asked to see: at one frame every 1.5s you watch a slideshow of aftermaths,
  // never the agent playing a game or filling a login. Chrome's screencast
  // pushes a frame whenever the page changes instead, and the action feed
  // carries the click coordinates — synthetic CDP input moves no real pointer,
  // so the cursor cannot be captured in the pixels and must be drawn on top.
  if (req.method === "GET" && pathname === "/api/browser/live") {
    let stopFrames = null;
    let unsubscribeActions = null;
    let heartbeat = null;
    const cleanup = () => {
      try { stopFrames?.(); } catch {}
      try { unsubscribeActions?.(); } catch {}
      if (heartbeat) clearInterval(heartbeat);
    };
    try {
      const wanted = {
        host: url.searchParams.get("host") || undefined,
        port: url.searchParams.get("port") ? Number(url.searchParams.get("port")) : undefined,
        tabId: url.searchParams.get("tabId") || undefined,
      };
      const { client, connection, tab, tabs } = await acquireLiveTab(wanted);

      sendSSEHeaders(res);
      writeSSE(res, {
        type: "ready",
        connection,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        tabs: tabs.map((t, index) => ({ index, id: t.id, title: String(t.title || "").slice(0, 100), url: t.url })),
      });

      // Replay what just happened so a panel opened mid-task shows the agent's
      // last move immediately instead of a blank overlay until the next click.
      for (const action of recentBrowserActions(8)) writeSSE(res, { type: "action", action });

      unsubscribeActions = onBrowserAction((action) => {
        try { writeSSE(res, { type: "action", action }); } catch { /* client went away */ }
      });

      stopFrames = await client.startScreencast(
        tab.id,
        {
          // Throttled on purpose. 1280x900 at everyNthFrame:1 is 3-12MB/s of
          // JPEG encode + base64 + socket per viewer, which is what pinned a
          // laptop's fan. 960x720 every 3rd frame still reads as live motion
          // (a human watching a screencast does not perceive 20fps as choppy)
          // for roughly a tenth of the CPU.
          quality: Math.min(90, Math.max(20, Number(url.searchParams.get("quality")) || 45)),
          maxWidth: Number(url.searchParams.get("maxWidth")) || 960,
          maxHeight: Number(url.searchParams.get("maxHeight")) || 720,
          everyNthFrame: Math.max(1, Number(url.searchParams.get("everyNthFrame")) || 3),
        },
        ({ data, metadata }) => {
          try {
            // metadata carries deviceWidth/deviceHeight in CSS pixels and the
            // scroll offset, which is exactly what the panel needs to map a
            // click on the <img> back to a viewport point.
            // droppable: a late frame is worthless — never let one pile up in
            // the socket buffer (see the backpressure note above writeSSE).
            writeSSE(res, { type: "frame", data, metadata }, { droppable: true });
          } catch { /* client went away; close handler cleans up */ }
        }
      );

      // Proxies and some browsers drop an idle event stream. A page that never
      // repaints produces no frames at all, so this is the only traffic.
      heartbeat = setInterval(() => {
        try { writeSSE(res, { type: "heartbeat" }); } catch {}
      }, 15000);
      heartbeat.unref?.();

      req.on("close", cleanup);
      res.on("close", cleanup);
    } catch (error) {
      cleanup();
      const message = String(error?.message || error);
      const unreachable = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Timeout connecting|connecting to/i.test(message);
      sendJson(res, 503, {
        error: message,
        ...(unreachable
          ? { hint: "No browser is listening on the debug port. Use the Launch button (or the browser_remote_launch tool) to start one." }
          : {}),
      });
    }
    return;
  }

  // Which agent pages the panel could follow right now. Cheap and side-effect
  // free, so the UI can poll it while waiting for the agent's first browser
  // call instead of holding a stream open against a 404.
  if (req.method === "GET" && pathname === "/api/browser/agent-targets") {
    // R12: loopback-only, like every other browser route. These mirror the
    // agent's live screen, so a LAN caller must never be able to watch it.
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    try {
      const browser = agent.tools?.requireBrowserPlaywright?.();
      if (!browser) {
        sendJson(res, 200, { targets: [] });
        return;
      }
      sendJson(res, 200, { targets: browser.liveTargets() });
    } catch (error) {
      sendJson(res, 500, { error: error.message, code: "EINTERNAL" });
    }
    return;
  }

  // ── Live view of the AGENT's own Playwright browser ────────────────────────
  //
  // The /api/browser/live route above can only mirror a tab of the user's REAL
  // Chrome, because it needs a CDP debug port. When the agent drives its own
  // Chromium — the default whenever no debug port is exposed, and the whole
  // point of headless mode — that route fails and the panel shows an empty box
  // for the entire task. The user could not see the agent click, scroll or type,
  // which is exactly the "sab kuch dikhna chahiye" requirement.
  //
  // This route mirrors the agent's page instead: same frame shape, same action
  // feed, so the existing panel renders it without touching its hot path.
  // Loopback-only (R12) like every other browser route, params validated and
  // capped, and the same drop-if-behind backpressure as the CDP stream.
  if (req.method === "GET" && pathname === "/api/browser/agent-stream") {
    // R12: loopback-only. A screencast of the agent's screen is exactly the
    // kind of thing that must not be reachable from the network.
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }
    let stopFrames = null;
    let unsubscribeActions = null;
    let heartbeat = null;
    const cleanup = () => {
      try { stopFrames?.(); } catch {}
      try { unsubscribeActions?.(); } catch {}
      if (heartbeat) clearInterval(heartbeat);
      stopFrames = null;
      unsubscribeActions = null;
      heartbeat = null;
    };
    try {
      const browser = agent.tools?.requireBrowserPlaywright?.();
      if (!browser) {
        sendJson(res, 503, { error: "Browser automation is not available in this runtime.", code: "ENOBROWSER" });
        return;
      }

      const requested = String(url.searchParams.get("sessionId") || "").slice(0, 200);
      const targets = browser.liveTargets();
      if (!targets.length) {
        sendJson(res, 404, {
          error: "The agent has no open browser page yet.",
          code: "ENOSESSION",
          hint: "The live view connects by itself the moment the agent opens a page.",
        });
        return;
      }
      // No explicit session = follow the agent's most recently used one, which
      // is what "watch what it is doing right now" actually means.
      const target = (requested && targets.find((t) => t.sessionId === requested || t.id === requested))
        || targets[0];

      sendSSEHeaders(res);
      writeSSE(res, {
        type: "ready",
        connection: "agent",
        tabId: target.id,
        sessionId: target.sessionId,
        url: target.url,
        title: target.title,
        tabs: targets.map((t, index) => ({ index, id: t.id, title: t.title, url: t.url })),
      });

      // Same replay-then-subscribe the CDP route does, so a panel opened
      // mid-task shows the agent's last move instead of waiting for the next.
      for (const action of recentBrowserActions(8)) writeSSE(res, { type: "action", action });
      unsubscribeActions = onBrowserAction((action) => {
        writeSSE(res, { type: "action", action });
      });

      stopFrames = await browser.startLiveStream(
        target.sessionId,
        {
          quality: Math.min(90, Math.max(20, Number(url.searchParams.get("quality")) || 45)),
          maxWidth: Number(url.searchParams.get("maxWidth")) || 960,
          maxHeight: Number(url.searchParams.get("maxHeight")) || 720,
          everyNthFrame: Math.max(1, Number(url.searchParams.get("everyNthFrame")) || 3),
        },
        ({ data, metadata }) => {
          writeSSE(res, { type: "frame", data, metadata }, { droppable: true });
        }
      );

      heartbeat = setInterval(() => {
        writeSSE(res, { type: "heartbeat" });
      }, 15000);
      heartbeat.unref?.();

      req.on("close", cleanup);
      res.on("close", cleanup);
    } catch (error) {
      cleanup();
      const message = String(error?.message || error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message, code: "EINTERNAL" });
      } else {
        try { res.end(); } catch { /* already gone */ }
      }
    }
    return;
  }

  // What the panel needs to decide between "Connect" and "Launch", without
  // making the user find out by getting an ECONNREFUSED.
  if (req.method === "GET" && pathname === "/api/browser/launch-status") {
    try {
      sendJson(res, 200, await browserLaunchStatus({
        host: url.searchParams.get("host") || "localhost",
        port: Number(url.searchParams.get("port")) || 9222,
      }));
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  // ── Managed browser (4B.2, Codex-like) ─────────────────────────────
  //
  // Same CDP client + launcher the agent tools use (browser-remote-tools.js /
  // browser-launcher.js) — never a second connection path. All routes are
  // loopback-only (R12) with {error, code} errors. Tab id = CDP targetId.
  // GET /api/browser/live (above) is untouched for the old UI.
  if (pathname === "/api/browser/status" || pathname === "/api/browser/launch"
    || pathname === "/api/browser/tabs" || pathname.startsWith("/api/browser/tabs/")) {
    if (!isLoopback(req)) { sendErr(res, 403, "EPERM", "Local only."); return; }

    const bHost = (m, query = true) => {
      if (m && m.host) return String(m.host);
      if (query) return url.searchParams.get("host") || "localhost";
      return "localhost";
    };
    // Default managed port: explicit value (?port=/body) beats
    // OMNICLAW_BROWSER_PORT (test isolation knob), beats 9222.
    const bPort = (m, query = true) => {
      if (m && Number(m.port)) return Number(m.port);
      if (query && Number(url.searchParams.get("port"))) return Number(url.searchParams.get("port"));
      if (Number(process.env.OMNICLAW_BROWSER_PORT)) return Number(process.env.OMNICLAW_BROWSER_PORT);
      return 9222;
    };
    const bUnreachable = (message) => ({
      error: message,
      code: "EUNREACHABLE",
      hint: "No browser is listening on the debug port. POST /api/browser/launch to start the managed instance.",
    });

    // GET /api/browser/status → {running, profileDir, tabsCount, chromeVersion}
    if (req.method === "GET" && pathname === "/api/browser/status") {
      try {
        const host = bHost(null), port = bPort(null);
        const st = await browserLaunchStatus({ host, port });
        let tabsCount = 0;
        let chromeVersion = "";
        if (st.portOpen) {
          try {
            const listed = await managedListTabs({ host, port });
            tabsCount = listed.tabs.length;
            const { client } = await managedClient({ host, port });
            const v = await client.version().catch(() => ({}));
            chromeVersion = v.Browser || "";
          } catch { /* reachable but not speaking tab list — report running */ }
        }
        sendJson(res, 200, { running: st.portOpen, profileDir: st.profileDir, tabsCount, chromeVersion });
      } catch (error) {
        sendJson(res, 500, { error: error.message, code: "EINTERNAL" });
      }
      return;
    }

    // POST /api/browser/launch {} → {running, reused, port, tabs, chromePath}
    // B5 reuse order: managed instance on our profile → spawn on OmniClaw
    // profile (never the user's own Chrome). Chrome absent → 404 ENOENT.
    if (req.method === "POST" && pathname === "/api/browser/launch") {
      try {
        const body = await parseBody(req).catch(() => ({}));
        const host = bHost(body, false);
        const result = await launchDebugBrowser({
          host,
          port: bPort(body, false),
          browser: String(body.browser || ""),
          startUrl: String(body.startUrl || "about:blank"),
          managed: true,
          headless: process.env.OMNICLAW_TEST_HEADLESS === "1",
        });
        const tabs = await managedListTabs({ host, port: result.port }).catch(() => ({ tabs: [] }));
        sendJson(res, 200, {
          running: true,
          reused: Boolean(result.alreadyRunning),
          port: result.port,
          tabs: tabs.tabs || [],
          chromePath: result.browserPath || "",
        });
      } catch (error) {
        const message = String(error?.message || error);
        if (Number(error?.status) === 404 || error?.code === "ENOENT") {
          sendJson(res, 404, { error: message, code: "ENOENT", hint: error?.hint || "Install Google Chrome or set OMNICLAW_CHROME_PATH" });
        } else {
          sendJson(res, 500, { error: message, code: "EINTERNAL" });
        }
      }
      return;
    }

    // GET /api/browser/tabs → {tabs:[{id,title,url,active,attached,favicon:null}]}
    if (req.method === "GET" && pathname === "/api/browser/tabs") {
      try {
        const listed = await managedListTabs({ host: bHost(null), port: bPort(null) });
        sendJson(res, 200, { tabs: listed.tabs });
      } catch (error) {
        sendJson(res, 503, bUnreachable(String(error?.message || error)));
      }
      return;
    }

    // POST /api/browser/tabs {url?} → create (+ optional navigate)
    if (req.method === "POST" && pathname === "/api/browser/tabs") {
      try {
        const body = await parseBody(req).catch(() => ({}));
        const host = bHost(body), port = bPort(body);
        let target = String(body.url || "about:blank").trim() || "about:blank";
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
        // B4: route policy is http(s) + about:blank only. Rationale mirrors the
        // agent file gate (browser-playwright.js:10-24 blocks file:// escapes);
        // the looser agent tools are unchanged.
        if (!/^(https?:\/\/|about:blank$)/i.test(target)) {
          sendErr(res, 400, "EINVAL", "Scheme not allowed (http/https/about:blank only).");
          return;
        }
        const { client } = await managedClient({ host, port }).catch(() => { throw new Error(`connecting to ${host}:${port} failed`); });
        const created = await client.newTab(target === "about:blank" ? "about:blank" : target);
        const tabId = created.id || created.targetId;
        await managedAttach(client, tabId);
        const after = (await client.listTabs().catch(() => []));
        const tab = after.find((t) => t.id === tabId) || { id: tabId, title: "", url: target };
        sendJson(res, 200, { tab: { id: tab.id, title: String(tab.title || "").slice(0, 100), url: tab.url || target } });
      } catch (error) {
        const message = String(error?.message || error);
        if (/connecting to|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Timeout connecting/i.test(message)) {
          sendJson(res, 503, bUnreachable(message));
        } else {
          sendJson(res, 500, { error: message, code: "EINTERNAL" });
        }
      }
      return;
    }

    // Per-tab routes: /api/browser/tabs/:id/(activate|close|navigate|
    // back|forward|reload|stream|input)
    const tabMatch = pathname.match(/^\/api\/browser\/tabs\/([^/]+)(?:\/(activate|close|navigate|back|forward|reload|stream|input))?$/);
    if (tabMatch) {
      const tabId = decodeURIComponent(tabMatch[1]);
      const action = tabMatch[2] || "";
      const host = bHost(null), port = bPort(null);
      const tabGone = (message) => {
        if (/tab .*not found|no attached session|could not attach/i.test(message)) {
          sendJson(res, 404, { error: message, code: "ENOENT" });
          return true;
        }
        return false;
      };
      const connFail = (message) => /connecting to|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Timeout connecting|closed|not connected/i.test(message);

      const withTab = async (fn) => {
        try {
          const { client } = await managedClient({ host, port }).catch(() => { throw new Error(`connecting to ${host}:${port} failed`); });
          await managedAttach(client, tabId);
          return await fn(client);
        } catch (error) {
          const message = String(error?.message || error);
          if (tabGone(message)) return null;
          if (connFail(message)) { sendJson(res, 503, bUnreachable(message)); return null; }
          sendJson(res, 500, { error: message, code: "EINTERNAL" });
          return null;
        }
      };

      // POST /api/browser/tabs/:id/activate|close
      if (req.method === "POST" && (action === "activate" || action === "close")) {
        if (action === "activate") {
          const r = await withTab(async (client) => {
            await client.bringToFront(tabId).catch(() => {});
            return { ok: true, id: tabId };
          });
          if (r) sendJson(res, 200, r);
        } else {
          const r = await withTab(async (client) => {
            await client.closeTab(tabId);
            return { ok: true, id: tabId };
          });
          if (r) sendJson(res, 200, r);
        }
        return;
      }

      // POST /api/browser/tabs/:id/navigate {url} (B4 scheme policy)
      if (req.method === "POST" && action === "navigate") {
        const body = await parseBody(req).catch(() => ({}));
        let target = String(body.url || "").trim();
        if (!target) { sendErr(res, 400, "EINVAL", "url is required."); return; }
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
        if (!/^(https?:\/\/|about:blank$)/i.test(target)) {
          sendErr(res, 400, "EINVAL", "Scheme not allowed (http/https/about:blank only).");
          return;
        }
        const r = await withTab(async (client) => {
          await client.navigate(tabId, target, { actor: "user" });
          let readyState = "unknown";
          for (let i = 0; i < 12; i++) {
            await new Promise((x) => setTimeout(x, 150));
            try {
              readyState = await client.evaluate(tabId, "document.readyState");
              if (readyState === "complete" || readyState === "interactive") break;
            } catch { /* context swapping during navigation */ }
          }
          const after = await client.listTabs().catch(() => []);
          const tab = after.find((t) => t.id === tabId);
          return { ok: true, id: tabId, url: (tab && tab.url) || target, title: (tab && tab.title) || "", readyState };
        });
        if (r) sendJson(res, 200, r);
        return;
      }

      // POST /api/browser/tabs/:id/back|forward|reload
      if (req.method === "POST" && (action === "back" || action === "forward" || action === "reload")) {
        const r = await withTab(async (client) => {
          if (action === "back") await client.goBack(tabId, { actor: "user" });
          else if (action === "forward") await client.goForward(tabId, { actor: "user" });
          else await client.reloadTab(tabId, { actor: "user" });
          return { ok: true, id: tabId, action };
        });
        if (r) sendJson(res, 200, r);
        return;
      }

      // GET /api/browser/tabs/:id/stream (SSE screencast, B2)
      // ONE Page.startScreencast per tab (client multiplexes viewers); frames
      // fan out to every SSE client; the last disconnect stops the screencast.
      if (req.method === "GET" && action === "stream") {
        let stop = null;
        let heartbeat = null;
        const cleanup = () => {
          try { stop && stop(); } catch {} stop = null;
          try { heartbeat && clearInterval(heartbeat); } catch {} heartbeat = null;
        };
        try {
          const { client } = await managedClient({ host, port }).catch(() => { throw new Error(`connecting to ${host}:${port} failed`); });
          await managedAttach(client, tabId).catch((error) => {
            const message = String(error?.message || error);
            if (/not found|could not attach/i.test(message)) {
              const err = new Error(message);
              err.code = "ENOENT";
              throw err;
            }
            throw error;
          });
          sendSSEHeaders(res);
          // Liveness envelope (frames only flow when the page repaints; a
          // static page would otherwise look dead). Frame messages carry
          // jpegBase64; this one carries type:"ready".
          try {
            const tabsNow = await client.listTabs().catch(() => []);
            const cur = tabsNow.find((t) => t.id === tabId) || {};
            writeSSE(res, { type: "ready", tabId, url: cur.url || "", title: cur.title || "" });
          } catch {}
          stop = await client.startScreencast(
            tabId,
            { quality: 45, maxWidth: 960, maxHeight: 720, everyNthFrame: 3 },
            ({ data, metadata }) => {
              try {
                const md = metadata || {};
                writeSSE(res, {
                  tabId,
                  ts: Date.now(),
                  w: Number(md.deviceWidth) || 0,
                  h: Number(md.deviceHeight) || 0,
                  jpegBase64: data,
                  metadata: {
                    deviceWidth: Number(md.deviceWidth) || 0,
                    deviceHeight: Number(md.deviceHeight) || 0,
                    pageScaleFactor: Number(md.pageScaleFactor) || 1,
                    scrollOffsetX: Number(md.scrollOffsetX) || 0,
                    scrollOffsetY: Number(md.scrollOffsetY) || 0,
                  },
                }, { droppable: true });   // late frame == worthless frame
              } catch { /* client went away; close handler cleans up */ }
            }
          );
          heartbeat = setInterval(() => {
            try { writeSSE(res, { type: "heartbeat" }); } catch {}
          }, 15000);
          heartbeat.unref?.();
          req.on("close", cleanup);
          res.on("close", cleanup);
        } catch (error) {
          cleanup();
          const message = String(error?.message || error);
          if (error?.code === "ENOENT") {
            if (!res.headersSent) sendJson(res, 404, { error: message, code: "ENOENT" });
            else try { res.end(); } catch {}
          } else if (connFail(message)) {
            if (!res.headersSent) sendJson(res, 503, bUnreachable(message));
            else try { res.end(); } catch {}
          } else {
            if (!res.headersSent) sendJson(res, 500, { error: message, code: "EINTERNAL" });
            else try { res.end(); } catch {}
          }
        }
        return;
      }

      // POST /api/browser/tabs/:id/input (B3)
      if (req.method === "POST" && action === "input") {
        const body = await parseBody(req).catch(() => ({}));
        const type = String(body.type || "");
        if (!["mouse", "key", "wheel"].includes(type)) {
          sendErr(res, 400, "EINVAL", "type must be mouse|key|wheel.");
          return;
        }
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
        if (type === "mouse") {
          const kind = String(body.kind || "click");
          if (!["move", "down", "up", "click"].includes(kind)) {
            sendErr(res, 400, "EINVAL", "mouse kind must be move|down|up|click.");
            return;
          }
          const button = String(body.button || "left");
          if (!["left", "right", "middle"].includes(button)) {
            sendErr(res, 400, "EINVAL", "mouse button must be left|right|middle.");
            return;
          }
          // B3: client sends cssX/cssY relative to the frame image + frame w/h;
          // server maps to viewport CSS px via viewport.w / frameW. Scroll
          // offsets are NOT added (CDP takes viewport CSS coords).
          const cssX = num(body.cssX), cssY = num(body.cssY);
          const frameW = num(body.frameW), frameH = num(body.frameH);
          if (!Number.isFinite(cssX) || !Number.isFinite(cssY) || !(frameW > 0) || !(frameH > 0)) {
            sendErr(res, 400, "EINVAL", "mouse needs finite cssX/cssY and positive frameW/frameH.");
            return;
          }
          const r = await withTab(async (client) => {
            const vp = await client.viewport(tabId).catch(() => ({ w: 0, h: 0 }));
            const sx = vp.w > 0 ? vp.w / frameW : 1;
            const sy = vp.h > 0 ? vp.h / frameH : 1;
            const x = Math.max(0, Math.min(vp.w > 0 ? vp.w : 1e9, Math.round(cssX * sx)));
            const y = Math.max(0, Math.min(vp.h > 0 ? vp.h : 1e9, Math.round(cssY * sy)));
            const out = await client.inputMouse(tabId, { kind, x, y, button }, { actor: "user" });
            return { ok: true, id: tabId, ...out };
          });
          if (r) sendJson(res, 200, r);
          return;
        }
        if (type === "key") {
          const text = body.text != null ? String(body.text) : "";
          const key = String(body.key || "");
          if (!text && !key) { sendErr(res, 400, "EINVAL", "key needs text or key."); return; }
          const r = await withTab(async (client) => {
            const out = await client.inputKey(
              tabId,
              { text, key, code: String(body.code || ""), vk: Number(body.vk) || 0 },
              { actor: "user" }
            );
            return { ok: true, id: tabId, ...out };
          });
          if (r) sendJson(res, 200, r);
          return;
        }
        // wheel: deltaX/deltaY required; coords optional (default: viewport center).
        const dx = Math.round(num(body.deltaX) || 0);
        const dy = Math.round(num(body.deltaY) || 0);
        if (!dx && !dy) { sendErr(res, 400, "EINVAL", "wheel needs deltaX and/or deltaY."); return; }
        const r = await withTab(async (client) => {
          const vp = await client.viewport(tabId).catch(() => ({ w: 0, h: 0 }));
          let x = num(body.cssX), y = num(body.cssY);
          if (Number.isFinite(num(body.frameW)) && num(body.frameW) > 0 && Number.isFinite(x) && vp.w > 0) {
            x = Math.round(x * (vp.w / num(body.frameW)));
            y = Math.round((Number.isFinite(y) ? y : 0) * (vp.h > 0 && Number.isFinite(num(body.frameH)) && num(body.frameH) > 0 ? vp.h / num(body.frameH) : 1));
          }
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            x = vp.w > 0 ? Math.round(vp.w / 2) : 0;
            y = vp.h > 0 ? Math.round(vp.h / 2) : 0;
          }
          const out = await client.inputWheel(tabId, { x, y, deltaX: dx, deltaY: dy }, { actor: "user" });
          return { ok: true, id: tabId, ...out };
        });
        if (r) sendJson(res, 200, r);
        return;
      }

      sendErr(res, 404, "ENOENT", "Unknown browser tab action.");
      return;
    }
  }

  // ── Autonomous Task Execution ──────────────────────────────────
  if (req.method === "POST" && pathname === "/api/autonomous/execute") {
    try {
      const body = await parseBody(req);
      const objective = String(body.objective || body.task || body.request || "").trim();
      if (!objective) {
        sendJson(res, 400, { error: "objective/task/request is required" });
        return;
      }

      const maxIterations = Number(body.maxIterations || 50);
      const result = await agent.autonomousRuntime.executeTask(objective, {
        agentId: body.agentId || "main",
        sessionId: body.sessionId || "http-execution",
        maxIterations,
        checkpointEnabled: body.checkpointEnabled !== false,
        daemonMode: Boolean(body.daemonMode || false),
      });

      sendJson(res, 200, {
        success: result.success,
        objective,
        iterations: result.executionStats?.currentIteration || 0,
        goal: result.goal ? { id: result.goal.id, title: result.goal.title, status: result.goal.status } : null,
        executionStats: result.executionStats,
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/autonomous/status") {
    const state = agent.autonomousRuntime?.executionState || {};
    sendJson(res, 200, {
      initialized: Boolean(agent.autonomousRuntime),
      currentGoal: state.currentGoal?.title || null,
      currentIteration: state.currentIteration || 0,
      maxIterations: state.maxIterations || 50,
    });
    return;
  }

  // ── Session Export ──────────────────────────────────────────────
 if (req.method === "GET" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/export")) {
   const parts = pathname.split("/").filter(Boolean);
   const sessionId = parts[2];
   if (!sessionId) { sendJson(res, 400, { error: "sessionId required" }); return; }
   try {
     const session = agent.sessions.getSession(sessionId, { messageLimit: 10000 });
     if (!session) { sendJson(res, 404, { error: "Session not found" }); return; }
     sendJson(res, 200, { session, transcript: session.transcript || [], exportedAt: new Date().toISOString(), version: "0.1.0" });
   } catch (error) { sendJson(res, 500, { error: error.message }); }
   return;
 }

 // ── Session Import ──────────────────────────────────────────────
 if (req.method === "POST" && pathname === "/api/sessions/import") {
   try {
     const body = await parseBody(req);
     if (!body.session) { sendJson(res, 400, { error: "session object required" }); return; }
      const built = agent.sessions.createSession({
        label: body.session.label || "imported",
        agentId: body.session.agentId || "main",
        channel: body.session.channel || "import",
        // B1 step 6: preserve session meta across export/import round-trips.
        key: body.session.key || undefined,
        workspacePath: body.session.workspacePath || null,
        model: body.session.model || null,
      });
      // createSession is in-memory only (resolveSession persists via write);
      // without this the import 200s but GET/list never see the session.
      const session = agent.sessions.persistSession(built);
     if (body.transcript && Array.isArray(body.transcript)) {
       for (const entry of body.transcript) {
         try { agent.sessions.appendMessage(session.id, entry); } catch {}
       }
     }
     sendJson(res, 200, { sessionId: session.id, imported: true, transcriptCount: body.transcript?.length || 0 });
   } catch (error) { sendJson(res, 500, { error: error.message }); }
   return;
 }

 // ── Session Search ──────────────────────────────────────────────
 if (req.method === "GET" && pathname === "/api/sessions/search") {
   const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
   const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
   if (!query) { sendJson(res, 400, { error: "q parameter required" }); return; }
   try {
     const all = agent.sessions.listSessions(500);
     const results = all.filter(s => {
       return String(s.label || "").toLowerCase().includes(query) ||
              String(s.agentId || "").toLowerCase().includes(query) ||
              String(s.channel || "").toLowerCase().includes(query);
     }).slice(0, limit);
     sendJson(res, 200, { query, count: results.length, results });
   } catch (error) { sendJson(res, 500, { error: error.message }); }
   return;
 }

if (req.method === "POST" && pathname === "/api/chat") {
    try {
      const body = await parseBody(req);
      const message = String(body.message || "").trim();

      if (!message) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }
      const result = await agent.handleMessage(message, {
        sessionId: body.sessionId,
        label: body.label,
        agentId: body.agentId,
        channel: body.channel,
        workspacePath: body.workspacePath,
        attachments: sanitizeAttachmentRefs(body.attachments),
      });
      const conflict = result.run?.status === "busy" || result.run?.status === "archived";
      sendJson(res, conflict ? 409 : 200, compactChatResultForHttp(result));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  
 // Streaming chat endpoint (SSE)
  if (req.method === "POST" && pathname === "/api/chat/stream") {
    let unsubscribe = null;
    let heartbeat = null;
    // Declared BEFORE try: early returns (e.g. empty message) run the
    // finally below without having executed the try body.
    let streamRunId = "";
    let streamSessionId = "";
    let streamDone = false;
    // A closed tab/navigation must NOT cancel the run. Live 2026-09-27: this
    // handler killed a healthy 16-minute NEXUS run. The UI's 90s idle watchdog
    // fired during a 5-minute `exec`, reader.cancel() closed the response, and
    // that turned a *display* timeout into a *compute* cancel — 35 rounds and 50
    // tool calls destroyed, and `cancelled` wrote no resume state, so the work
    // was unrecoverable.
    //
    // The UI is an OBSERVER; it never owns run lifetime. Lifetime belongs to the
    // loop's own bounded ceilings (maxRounds, runTokenBudget, tool timeoutMs), so
    // an abandoned run still terminates by itself and cannot bill forever —
    // removing this cancel does not trade lost work for an unbounded leak.
    // Reconnecting picks the run back up via the global /api/events feed and the
    // session transcript. To actually stop a run, POST /api/runs/:id/stop.
    const noteDetached = () => {
      if (streamDone || !streamRunId) return;
      try {
        agent.gateway.emitTransient?.("run.detached", {
          runId: streamRunId,
          sessionId: streamSessionId,
          message: "stream client disconnected — run continues server-side",
        });
      } catch { /* observability only; must never affect the run */ }
    };
    // NOTE: req 'close' fires as soon as the POST body is parsed (verified
    // empirically). res 'close' fires on real disconnect or after res.end
    // (guarded by streamDone).
    res.on("close", noteDetached);
    try {
      const body = await parseBody(req);
      const message = String(body.message || "").trim();
      if (!message) { sendJson(res, 400, { error: "message is required" }); return; }
      sendSSEHeaders(res);
      const startedMs = Date.now();
      streamSessionId = String(body.sessionId || "").trim();
      const interesting = /^(agent|assistant|tool|toolset|model_tool_loop|auto_verification|provider|context|shell|terminal|approval|run|plan|subagent)\./;
     writeSSE(res, {
       type: "start",
       timestamp: new Date(startedMs).toISOString(),
       status: "agent-loop",
       message: "Agent manager accepted the request and is waiting for live loop events.",
     });
     heartbeat = setInterval(() => {
       try { writeSSE(res, { type: "heartbeat", timestamp: new Date().toISOString() }); } catch {}
     }, 15000);
     unsubscribe = agent.gateway.onEvent((record) => {
       try {
          if (!interesting.test(record.event || "")) return;
          const payload = record.payload || {};
          const recordMs = Date.parse(record.at || "");
          if (Number.isFinite(recordMs) && recordMs < startedMs - 1000) return;
          // Child sub-agent steps ride along: a child's own runId never equals
          // the latched parent run, but its parentRunId does — let those
          // through so the parent thread can route them into the child card
          // (the child's full chat replays them via its own session).
          if (streamRunId && payload.runId && payload.runId !== streamRunId && payload.parentRunId !== streamRunId) return;
         if (!streamRunId && payload.runId) {
           if (streamSessionId && payload.sessionId && payload.sessionId !== streamSessionId) return;
           streamRunId = payload.runId;
           streamSessionId = payload.sessionId || streamSessionId;
         }
         if (!streamRunId && streamSessionId && payload.sessionId && payload.sessionId !== streamSessionId) return;
         writeSSE(res, { type: "event", record });
       } catch {}
     });
     const result = await agent.handleMessage(message, {
       sessionId: body.sessionId,
       label: body.label,
       agentId: body.agentId,
       channel: body.channel,
        workspacePath: body.workspacePath,
        attachments: sanitizeAttachmentRefs(body.attachments),
     });
     streamRunId = result.run?.id || streamRunId;
     streamSessionId = result.session?.id || result.sessionId || streamSessionId;
     const finalMetadata = result.finalMetadata || {
       mode: result.plan?.profile?.id || result.agent?.profileId || "",
       model: result.provider?.model || "",
       providerId: result.provider?.id || "",
       durationMs: result.providerDiagnostics?.durationMs || Date.now() - startedMs,
       stepCount: result.modelToolLoop?.rounds || 0,
       toolCallCount: Array.isArray(result.toolOutputs) ? result.toolOutputs.length : 0,
       totalTokens: Number(result.modelToolLoop?.usage?.totalTokens || 0),
       stopReason: result.modelToolLoop?.stoppedReason || result.providerDiagnostics?.reason || "completed",
       fixedErrors: result.modelToolLoop?.selfCorrectionTriggered || result.modelToolLoop?.autoRepairAttempted || false,
       failedToolCount: Array.isArray(result.toolOutputs)
         ? result.toolOutputs.filter((item) =>
             item?.output?.error ||
             item?.output?.blocked ||
             item?.output?.ok === false ||
             (Array.isArray(item?.output?.issues) && item.output.issues.length > 0)
           ).length
         : 0,
       autoVerificationCount: Number(result.modelToolLoop?.autoVerificationCount || 0),
       autoRepairAttempted: Boolean(result.modelToolLoop?.autoRepairAttempted),
       autoRepairToolCallCount: Number(result.modelToolLoop?.autoRepairReport?.toolCallCount || 0),
       verificationPassed: Number(result.modelToolLoop?.autoVerificationCount || 0) > 0,
       remainingIssues: [
         ...(Array.isArray(result.modelToolLoop?.remainingIssues) ? result.modelToolLoop.remainingIssues : []),
         ...(Array.isArray(result.modelToolLoop?.agentLoop?.remainingIssues) ? result.modelToolLoop.agentLoop.remainingIssues : []),
         ...(Array.isArray(result.modelToolLoop?.runtimePlanAgentLoop?.remainingIssues) ? result.modelToolLoop.runtimePlanAgentLoop.remainingIssues : []),
       ].filter(Boolean).slice(0, 12),
       pendingApprovalCount: Array.isArray(result.approvals) ? result.approvals.length : 0,
     };
      const compactResult = compactChatResultForHttp(result);
      // T2.1/T2.2 proof block (additive, present only when the v2 paths ran):
      // context budget from this run's prompt trace + menu from the loop report.
      let v2budget = null;
      try {
        const trace = agent.getPromptTrace?.(streamRunId || result.run?.id || "");
        const rep = trace && trace.promptTrace && trace.promptTrace.report;
        if (rep && rep.budget) v2budget = rep.budget;
      } catch {}
      const v2menu = result.modelToolLoop?.menu || null;
      writeSSE(res, {
        type: "final",
        content: result.reply || "",
        metadata: {
          ...finalMetadata,
          ...(v2budget ? { budget: v2budget } : {}),
          ...(v2menu ? { menu: v2menu } : {}),
        },
        data: compactResult,
      });
     writeSSE(res, { type: "done", runId: streamRunId, sessionId: streamSessionId, data: compactResult });
    } catch (error) {
      try { writeSSE(res, { type: "error", error: error.message }); } catch {}
    } finally {
      streamDone = true;
      try { res.off?.("close", noteDetached); } catch {}
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      res.end();
    }
    return;
  }
  // Memory search
 if (req.method === "GET" && pathname === "/api/memory/search") {
 const query = String(url.searchParams.get("q") || "").trim();
 const agentId = String(url.searchParams.get("agentId") || "").trim();
 if (!query) { sendJson(res, 400, { error: "q parameter required" }); return; }
 const results = agent.memory.searchAll ? agent.memory.searchAll(query, agentId) : { notes: [], longTerm: [], research: [], artifacts: [] };
 sendJson(res, 200, { query, agentId, results });
 return;
 }
 // Config validate
 if (req.method === "POST" && pathname === "/api/config/validate") {
 try {
 const body = await parseBody(req);
 const result = agent.config.validateConfig(body);
 sendJson(res, result.valid ? 200 : 400, result);
 } catch (error) { sendJson(res, 400, { error: error.message }); }
 return;
 }
 // Session compact
 if (req.method === "POST" && pathname === "/api/sessions/compact") {
 try {
 const body = await parseBody(req);
 const sessionId = String(body.sessionId || "").trim();
 if (!sessionId) { sendJson(res, 400, { error: "sessionId required" }); return; }
 const result = agent.sessions.compactSession(sessionId, Number(body.maxEntries || 80));
 agent.gateway.addEvent("session.compacted", { sessionId, ...result });
 sendJson(res, 200, result);
 } catch (error) { sendJson(res, 400, { error: error.message }); }
 return;
 }
 // Approvals expire
 if (req.method === "POST" && pathname === "/api/approvals/expire") {
 try {
 const body = await parseBody(req);
 const result = agent.gateway.expireOldApprovals(Number(body.timeoutMinutes || 30));
 sendJson(res, 200, result);
 } catch (error) { sendJson(res, 400, { error: error.message }); }
 return;
 }
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/favicon.ico" || pathname === "/favicon.svg")) {
    sendFile(res, path.join(publicDir, "favicon.svg"));
    return;
  }

  // Embedded preview browser: serve agent-built artifacts (workspace-relative)
  // so the dashboard can open them in an iframe instead of the OS browser.
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/preview/")) {
    const relative = decodeURIComponent(pathname.slice("/preview/".length)).replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.resolve(runtimeDir, relative);
    const relFromRoot = path.relative(runtimeDir, target).replace(/\\/g, "/");
    // Local-first preview: serve any file UNDER the project root (the agent
    // builds sites both at the root, e.g. pillow-store/, AND under output/),
    // EXCEPT clearly sensitive locations (secrets, vcs, deps, internal state).
    const escapes = relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot) || relative.includes("..");
    const denied =
      // Project internals + source/config/tooling dirs — never serve these as "preview".
      /^(node_modules|\.git|\.github|\.claude|\.mavis|src|src-tauri|scripts|config|vendor|dist|\.vscode|workspace)(\/|$)/i.test(relFromRoot) ||
      /^data\/(?!generated\/|browser-screenshots\/)/i.test(relFromRoot) ||
      // Source/manifest files anywhere (sites use .html/.css/.js, not these).
      /(^|\/)(server\.js|package(-lock)?\.json|omniclaw-package\.json|[^/]*\.mjs|[^/]*\.cjs)$/i.test(relFromRoot) ||
      /(^|\/)(\.env[^/]*|secrets\.json|[^/]*\.pem|[^/]*\.key)$/i.test(relFromRoot);
    if (escapes || denied) {
      sendJson(res, 403, { error: "Preview path is outside allowed roots." });
      return;
    }
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      sendFile(res, target);
      return;
    }
    sendJson(res, 404, { error: "Preview file not found." });
    return;
  }

// NEW UI (web-next) is now the default at /
  // Old UI moved to /classic for fallback access
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
    sendFile(res, path.join(webNextDir, "index.html"));
    return;
  }

  // Old UI fallback at /classic
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/classic") {
    sendFile(res, path.join(publicDir, "index.html"));
    return;
  }

  // /next redirects to / (new UI is now default)
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/next" || pathname === "/next/")) {
    res.writeHead(301, { Location: "/", "Cache-Control": "no-store", ...CORS_HEADERS });
    res.end();
    return;
  }

  // New UI assets are served from root now (/, not /next/)
  // But keep /next/ path for backward compatibility
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/next/")) {
    let decoded = pathname.slice("/next".length);
    try { decoded = decodeURIComponent(decoded); } catch { decoded = pathname.slice("/next".length); }
    if (decoded.includes("\0")) {
      sendJson(res, 400, { error: "Bad path." });
      return;
    }
    const target = path.resolve(webNextDir, "." + decoded);
    const rel = path.relative(webNextDir, target);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (inside && fs.existsSync(target) && fs.statSync(target).isFile()) {
      sendFile(res, target);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/")) {
    let decoded = pathname;
    try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
    if (decoded.includes("\0")) {
      sendJson(res, 400, { error: "Bad path." });
      return;
    }

    // Try web-next first (new UI assets: /js/*, /css/*, /vendor/*)
    const nextTarget = path.resolve(webNextDir, "." + decoded);
    const nextRel = path.relative(webNextDir, nextTarget);
    const nextInside = nextRel === "" || (!nextRel.startsWith("..") && !path.isAbsolute(nextRel));
    if (nextInside && fs.existsSync(nextTarget) && fs.statSync(nextTarget).isFile()) {
      sendFile(res, nextTarget);
      return;
    }

    // Fallback to public dir (old UI, backward compat)
    const target = path.resolve(publicDir, "." + decoded);
    const rel = path.relative(publicDir, target);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (inside && fs.existsSync(target) && fs.statSync(target).isFile()) {
      sendFile(res, target);
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

attachWsGateway({ server, agent, pathname: "/ws" });

const gatewayWSProtocol = new GatewayWSProtocol(agent);
attachWsGateway({ server, agent, pathname: "/ws/gateway", handler: (ws, req) => gatewayWSProtocol.handleConnection(ws, req) });

agent.gatewayWSProtocol = gatewayWSProtocol;


// ─── Session Auto-Compaction (every 10 min) ──────────────────────
setInterval(() => {
  try {
    const sessions = agent.sessions.listSessions(200);
    let compacted = 0;
    for (const session of sessions) {
      if (session.messageCount > 120) {
        try {
          const result = agent.sessions.compactSession(session.id, 80);
          if (result.compacted) compacted++;
        } catch {}
      }
    }
    if (compacted > 0) {
      agent.gateway.addEvent("session.auto_compacted", { count: compacted });
    }
  } catch {}
}, 600000);

// ─── Approval Auto-Expiry (every 5 min) ─────────────────────────
setInterval(() => {
  try {
    // 4B.1: same TTL the records are stamped with (gateway-store.js).
    const result = agent.gateway.expireOldApprovals(APPROVAL_TTL_MS / 60000);
    if (result.expired > 0) {
      agent.gateway.addEvent("approval.auto_expired", { count: result.expired });
    }
  } catch {}
}, 300000);
// ─── HTTPS Option ──────────────────────────────────────────────
if (String(process.env.OMNICLAW_HTTPS || "").toLowerCase() === "true") {
 try {
   const certDir = path.join(process.cwd(), "data", "certs");
   if (!fs.existsSync(path.join(certDir, "key.pem"))) {
     fs.mkdirSync(certDir, { recursive: true });
     execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${path.join(certDir, "key.pem")}" -out "${path.join(certDir, "cert.pem")}" -days 365 -nodes -subj "/O=OmniClaw/CN=localhost"`, { stdio: "pipe" });
   }
   // server.listeners("request")[0] is the documented way to get the handler
   // (server._events.request is a bare function for a single listener, so [0]
   // was undefined). And it must actually listen() — previously it never did.
   const requestHandler = server.listeners("request")[0];
   const tlsServer = https.createServer({
     key: fs.readFileSync(path.join(certDir, "key.pem")),
     cert: fs.readFileSync(path.join(certDir, "cert.pem")),
   }, requestHandler);
   attachWsGateway({ server: tlsServer, agent, pathname: "/ws" });
   const httpsPort = Number(process.env.OMNICLAW_HTTPS_PORT) || (port + 1);
   const httpsHost = process.env.OMNICLAW_HOST || agent.config.getConfig().server?.host || "127.0.0.1";
   tlsServer.listen(httpsPort, httpsHost, () => {
     const shown = httpsHost === "0.0.0.0" || httpsHost === "::" ? "localhost" : httpsHost;
     console.log(`OmniClaw HTTPS listening on https://${shown}:${httpsPort}`);
   });
   agent.gateway.addEvent("server.https_enabled", { port: httpsPort, host: httpsHost });
 } catch (err) {
   agent.gateway.addEvent("server.https_failed", { error: err.message });
 }
}

agentReady.then(() => {
  // Bind to loopback by default so the gateway is NOT exposed on the LAN/0.0.0.0
  // (Node's default when host is omitted). With open API auth that default would
  // hand sessions/config/tools to anyone on the network. LAN/remote use is still
  // possible by explicitly opting in via OMNICLAW_HOST or config.server.host.
  const host = process.env.OMNICLAW_HOST || agent.config.getConfig().server?.host || "127.0.0.1";
  server.listen(port, host, () => {
    const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    console.log(`OmniClaw listening on http://${shown}:${port}${host === "127.0.0.1" ? " (loopback only; set OMNICLAW_HOST=0.0.0.0 for LAN)" : ""}`);
    // Prompt-caching capability report (once at startup): per configured
    // model, whether prefix caching is supported and by what mechanism.
    try {
      const cfg = agent.config.getConfig();
      const baseUrl = cfg.provider?.baseUrl || "";
      const rows = [
        ["main", cfg.provider?.model || ""],
        ["compaction", cfg.provider?.compactionModel || ""],
      ];
      for (const [role, model] of rows) {
        if (!model) continue;
        const support = describeCacheSupport(model, baseUrl);
        console.log(`[cache] ${role} model ${model}: ${support.supported ? support.mechanism : "no caching"} (${support.note})`);
      }
    } catch { /* report is best-effort */ }
  });
});
