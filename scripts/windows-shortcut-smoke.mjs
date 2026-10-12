// Desktop-shortcut regression smoke.
//
// THE BUG THIS LOCKS DOWN: ensureDesktopShortcut() used to spawn PowerShell
// detached + unref'd and then main() called process.exit() moments later.
// process.exit() tears down the process tree synchronously, so PowerShell was
// killed BEFORE it ran `.Save()` — the shortcut silently never appeared, and
// the launcher still printed "created". A user who downloaded the app got no
// desktop shortcut and nothing told them why.
//
// THE TEST: point USERPROFILE at a scratch dir (os.homedir() honours it on
// Windows), so the REAL desktop is never touched. Then assert:
//   1. a fresh run WRITES the .lnk, and it points at the launcher
//   2. a second run is a no-op (already points at this build)
//   3. a run REPAIRS a shortcut that points somewhere else (the app folder was
//      moved / re-extracted — the common real-world case)
//   4. the launcher EXITS NON-ZERO when it genuinely cannot write one, so an
//      installer can detect failure instead of assuming success
//
// R14: marker before every step, hard wall clock, cleanup in finally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let step = "startup";
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 90000);

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const launcher = path.join(repoRoot, "scripts", "windows-launcher.mjs");

function readLink(lnkPath) {
  if (!fs.existsSync(lnkPath)) return "";
  const script = [
    "$shell = New-Object -ComObject WScript.Shell",
    `$s = $shell.CreateShortcut('${lnkPath.replaceAll("'", "''")}')`,
    "Write-Output $s.TargetPath",
  ].join("; ");
  const out = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return String(out.stdout || "").trim();
}

function runLauncher(userProfile) {
  return spawnSync(process.execPath, [launcher, "--shortcut-only"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, USERPROFILE: userProfile, HOMEDRIVE: "", HOMEPATH: "" },
  });
}

if (process.platform !== "win32") {
  console.log("shortcut-smoke: SKIPPED (Windows only)");
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-shortcut-"));
const fakeHome = path.join(scratch, "home");
const desktop = path.join(fakeHome, "Desktop");
fs.mkdirSync(desktop, { recursive: true });
const lnk = path.join(desktop, "OmniClaw.lnk");

try {
  // From source (not packaged) the launcher targets start-omniclaw.bat next to
  // the repo, so stand that up as the thing the shortcut must point at.
  step = "create the launcher stand-in";
  const expected = path.join(repoRoot, "start-omniclaw.bat");
  if (!fs.existsSync(expected)) {
    fs.writeFileSync(expected, "@echo off\r\necho OmniClaw launcher stand-in\r\n", "utf8");
  }
  console.log(`ok: shortcut must point at ${expected}`);

  step = "run 1 - fresh install writes the shortcut";
  const r1 = runLauncher(fakeHome);
  console.log(`     exit=${r1.status} out=${String(r1.stdout || "").trim()}`);
  assert.ok(fs.existsSync(lnk), "the .lnk was NOT written — this is the original bug");
  assert.equal(readLink(lnk), expected, "shortcut points somewhere unexpected");
  console.log("ok: shortcut written and points at the launcher");

  step = "run 2 - second run is a no-op";
  const r2 = runLauncher(fakeHome);
  console.log(`     exit=${r2.status} out=${String(r2.stdout || "").trim()}`);
  assert.equal(r2.status, 0, "a no-op run should still exit 0");
  assert.match(String(r2.stdout || ""), /already points at this build/);
  assert.equal(readLink(lnk), expected, "the no-op run moved the shortcut");
  console.log("ok: idempotent, shortcut untouched");

  step = "run 3 - a moved app folder is repaired";
  const sh = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replaceAll("'", "''")}'); $s.TargetPath = 'C:\\Deleted\\Old\\OmniClaw.exe'; $s.Save();`],
  { encoding: "utf8", windowsHide: true });
  assert.equal(sh.status, 0, "could not plant a broken shortcut");
  assert.equal(readLink(lnk), "C:\\Deleted\\Old\\OmniClaw.exe", "the planted shortcut should be broken");
  console.log("ok: planted a broken shortcut");

  const r3 = runLauncher(fakeHome);
  console.log(`     exit=${r3.status} out=${String(r3.stdout || "").trim()}`);
  assert.match(String(r3.stdout || ""), /repaired/);
  assert.equal(readLink(lnk), expected, "the stale shortcut was not repaired");
  console.log("ok: stale shortcut repaired to the real launcher");

  step = "run 4 - a genuine failure is reported, not assumed";
  // Hide the target so the launcher cannot possibly write a valid shortcut.
  const bat = path.join(repoRoot, "start-omniclaw.bat");
  const stash = path.join(scratch, "stashed.bat");
  fs.renameSync(bat, stash);
  try {
    const r4 = runLauncher(fakeHome);
    console.log(`     exit=${r4.status} out=${String(r4.stdout || "").trim()}`);
    assert.equal(r4.status, 1, "a failed shortcut write must exit non-zero so an installer can detect it");
  } finally {
    fs.renameSync(stash, bat);
  }
  console.log("ok: failure is surfaced, not swallowed");

  clearTimeout(timer);
  console.log("shortcut-smoke: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  process.exit(1);
} finally {
  clearTimeout(timer);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}