import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(__filename);
const rootDir = process.pkg ? path.dirname(process.execPath) : path.resolve(moduleDir, "..");
const port = Number(process.env.PORT || 3147);
const baseUrl = `http://localhost:${port}`;
const logsDir = path.join(rootDir, "logs");
const pidPath = path.join(rootDir, "data", "omniclaw.pid");

function ensureDirs() {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
}

function requestJson(url, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, json: JSON.parse(body) });
        } catch {
          resolve({ ok: false, statusCode: res.statusCode, json: null });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, json: null });
    });
    req.on("error", () => resolve({ ok: false, statusCode: 0, json: null }));
  });
}

async function waitForHealth(maxMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const health = await requestJson(`${baseUrl}/api/health`, 1200);
    if (health.ok) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, statusCode: 0, json: null };
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function psEscape(value) {
  return String(value).replace(/'/g, "''");
}

function shortcutTarget() {
  return process.pkg ? process.execPath : path.join(rootDir, "start-omniclaw.bat");
}

/**
 * Read where an existing .lnk points.
 * Returns "" when the shortcut is missing or unreadable.
 */
function readShortcutTarget(shortcutPath) {
  if (!fs.existsSync(shortcutPath)) {
    return "";
  }
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$s = $shell.CreateShortcut('${psEscape(shortcutPath)}')`,
    "Write-Output $s.TargetPath",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return String(result.stdout || "").trim();
}

/**
 * Create (or REPAIR) the Desktop shortcut.
 *
 * Why spawnSync and not spawn().unref(): the old version spawned PowerShell
 * detached/unref'd and then main() called process.exit() a moment later.
 * process.exit() tears down the whole process tree synchronously, so the
 * unref'd PowerShell was killed BEFORE it could run `.Save()` — the shortcut
 * silently never appeared, and the launcher still printed "created". Running it
 * synchronously means we know the real outcome, and the caller can report the
 * truth instead of a hope.
 *
 * Why it also REPAIRS: a shortcut that points at a moved or deleted target is
 * worse than no shortcut, because the user clicks it and nothing happens. That
 * is the normal case after the app folder is moved or re-extracted.
 */
function ensureDesktopShortcut() {
  if (process.platform !== "win32") {
    return { created: false, skipped: "not-windows" };
  }
  const targetPath = shortcutTarget();
  if (!fs.existsSync(targetPath)) {
    return { created: false, skipped: "missing-target", target: targetPath };
  }
  const shortcutPath = path.join(os.homedir(), "Desktop", "OmniClaw.lnk");

  const existingTarget = readShortcutTarget(shortcutPath);
  if (existingTarget && existingTarget.toLowerCase() === targetPath.toLowerCase()) {
    return { created: false, path: shortcutPath, skipped: "already-exists" };
  }

  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut('${psEscape(shortcutPath)}')`,
    `$shortcut.TargetPath = '${psEscape(targetPath)}'`,
    `$shortcut.WorkingDirectory = '${psEscape(rootDir)}'`,
    "$shortcut.Description = 'Start OmniClaw local gateway dashboard'",
    "$shortcut.Save()",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !fs.existsSync(shortcutPath)) {
    return {
      created: false,
      skipped: "write-failed",
      path: shortcutPath,
      error: String(result.stderr || result.error?.message || "PowerShell did not write the shortcut").trim().slice(0, 300),
    };
  }
  return { created: true, path: shortcutPath, repaired: Boolean(existingTarget) };
}

async function startServer() {
  ensureDirs();
  const existing = await requestJson(`${baseUrl}/api/health`);
  if (existing.ok) {
    return { alreadyRunning: true, health: existing };
  }

  const out = fs.openSync(path.join(logsDir, "omniclaw-launcher-out.log"), "a");
  const err = fs.openSync(path.join(logsDir, "omniclaw-launcher-err.log"), "a");
  const gatewayExe = path.join(rootDir, "omniclaw-gateway.exe");
  const command = fs.existsSync(gatewayExe) ? gatewayExe : process.execPath;
  const args = fs.existsSync(gatewayExe) ? [] : ["server.js"];
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();
  fs.writeFileSync(pidPath, JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString(), rootDir }, null, 2));
  const health = await waitForHealth();
  return { alreadyRunning: false, pid: child.pid, health };
}

function printStatus(result) {
  const provider = result.health?.json?.provider || {};
  console.log(`OmniClaw: ${result.health?.ok ? "ready" : "not ready"}`);
  console.log(`URL: ${baseUrl}`);
  console.log(`Root: ${rootDir}`);
  if (result.pid) {
    console.log(`PID: ${result.pid}`);
  }
  if (result.alreadyRunning) {
    console.log("Server was already running.");
  }
  if (provider.id) {
    console.log(`Provider: ${provider.id} (${provider.apiKeySource || provider.mode || "unknown"})`);
  }
  if (!result.health?.ok) {
    console.log(`Check logs: ${path.join(logsDir, "omniclaw-launcher-err.log")}`);
  }
}

function reportShortcut(shortcut) {
  // Report the REAL outcome. The old code printed "created" whenever it merely
  // ATTEMPTED the write, which is how a shortcut that never appeared went
  // unnoticed for months.
  if (shortcut.created) {
    console.log(`Desktop shortcut ${shortcut.repaired ? "repaired" : "created"}: ${shortcut.path}`);
    return 0;
  }
  if (shortcut.skipped === "already-exists") {
    console.log(`Desktop shortcut already points at this build: ${shortcut.path}`);
    return 0;
  }
  if (shortcut.skipped === "write-failed") {
    console.log(`Could not write the Desktop shortcut (${shortcut.error}).`);
    console.log("Create it manually: right-click OmniClaw.exe -> Send to -> Desktop (create shortcut).");
    return 1;
  }
  if (shortcut.skipped === "missing-target") {
    console.log(`No launcher found at ${shortcut.target}; skipping the Desktop shortcut.`);
    return 1;
  }
  return 0;
}

async function main() {
  const args = new Set(process.argv.slice(2));

  // Install/refresh ONLY the shortcut, without starting or waiting on the
  // server. An installer wants exactly this, and it makes the shortcut
  // behaviour testable without booting a whole gateway.
  if (args.has("--shortcut-only")) {
    process.exit(reportShortcut(ensureDesktopShortcut()));
  }

  const result = await startServer();
  const shortcut = ensureDesktopShortcut();
  printStatus(result);
  reportShortcut(shortcut);
  if (result.health?.ok && !args.has("--no-open")) {
    openBrowser(baseUrl);
  }
  if (args.has("--pause") && process.stdin.isTTY) {
    console.log("Press Enter to close this launcher window.");
    await new Promise((resolve) => process.stdin.once("data", resolve));
  }
  process.exit(result.health?.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
