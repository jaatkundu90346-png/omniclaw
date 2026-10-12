import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const shortcutPath = path.join(os.homedir(), "Desktop", "OmniClaw.lnk");
const launcherBat = path.join(rootDir, "start-omniclaw.bat");

function psEscape(value) {
  return String(value).replace(/'/g, "''");
}

if (process.platform !== "win32") {
  console.log("Shortcut installer is only needed on Windows.");
  process.exit(0);
}

if (!fs.existsSync(launcherBat)) {
  throw new Error(`Missing launcher: ${launcherBat}`);
}

const script = [
  "$shell = New-Object -ComObject WScript.Shell",
  `$shortcut = $shell.CreateShortcut('${psEscape(shortcutPath)}')`,
  `$shortcut.TargetPath = '${psEscape(launcherBat)}'`,
  `$shortcut.WorkingDirectory = '${psEscape(rootDir)}'`,
  "$shortcut.Description = 'Start OmniClaw local gateway dashboard'",
  "$shortcut.Save()",
].join("; ");

const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`Created shortcut: ${shortcutPath}`);
