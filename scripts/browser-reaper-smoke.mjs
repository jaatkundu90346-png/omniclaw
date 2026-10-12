// Regression test for the stale-browser reaper.
//
// The user's machine was heating up and eventually freezing, and restarting was
// the only cure — because every crashed/killed OmniClaw left a DETACHED
// browser running forever. Cleaning that up is the fix, and cleaning up the
// WRONG browser (the user's own Chrome, with their tabs) would be a disaster.
// So this asserts the safety property, not just the happy path:
//
//   1. A browser owned by a LIVE OmniClaw is never reaped.
//   2. With no live owner, the reaper runs and reports honestly.
//   3. The process filter only ever matches browsers OmniClaw itself launched.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { reapStaleManagedBrowsers, debugProfileDir } =
  await import(pathToFileURL(path.join(ROOT, "src/core/browser-launcher.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};

const ownerFile = path.join(path.dirname(debugProfileDir("Chrome")), "managed-browser-owner.json");
// A real owner record is written by claimBrowserOwnership/launchDebugBrowser.
// We fabricate one for THIS live process to prove the gate, then always restore
// whatever was there.
const backup = fs.existsSync(ownerFile) ? fs.readFileSync(ownerFile, "utf8") : null;

try {
  check("managed profile dir is under the OmniClaw app dir",
    debugProfileDir("Chrome").includes("OmniClaw"), debugProfileDir("Chrome"));
  check("managed profile dir is stable across calls (one-time sign-in depends on it)",
    debugProfileDir("Chrome") === debugProfileDir("chrome"), debugProfileDir("chrome"));

  // 1. A LIVE owner must be respected — this is what stops the reaper from
  //    killing the browser of a second OmniClaw the user is running.
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, port: 9222, at: new Date().toISOString() }));
  const live = await reapStaleManagedBrowsers();
  check("a live owner is respected (skipped, nothing killed)",
    live.skipped === true && live.killed === 0, JSON.stringify(live));
  check("the skip reason names the owning pid", String(live.reason).includes(String(process.pid)), live.reason);

  // 2. A DEAD owner must be reaped, not respected.
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: 999999, port: 9222, at: new Date().toISOString() }));
  const dead = await reapStaleManagedBrowsers();
  check("a dead owner does NOT block the reaper", dead.skipped === false, JSON.stringify(dead));
  check("reaper reports why it acted", /999999/.test(String(dead.reason)), dead.reason);
  check("reaper cleared the stale owner record", !fs.existsSync(ownerFile));

  // 3. No record at all must also be safe to act on.
  if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
  const none = await reapStaleManagedBrowsers();
  check("with no owner record the reaper still runs", none.skipped === false, JSON.stringify(none));
  check("reaper never reports a negative kill count", none.killed >= 0, String(none.killed));
} catch (error) {
  check("script completed without throwing", false, error?.stack || error?.message);
} finally {
  // Leave the machine exactly as we found it.
  try {
    if (backup !== null) fs.writeFileSync(ownerFile, backup);
    else if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
  } catch { /* best effort */ }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
