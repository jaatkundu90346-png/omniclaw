// One-shot cleanup: kill the browsers OMNICLAW started, and nothing else.
//
// The user asked "restart the laptop, or restart the browser?" — the answer is a
// hard NO to the laptop. Nothing here needs a reboot: the fixes live in the
// code, and this removes the leftover browser processes that are actually
// eating the CPU.
//
// Safety is the whole point. It reuses the same reaper the server runs, which
// only matches processes carrying OmniClaw's own markers, and it refuses
// outright while a live OmniClaw still owns them (that instance may be driving
// a page you are watching). Your own Chrome, Edge and Firefox carry none of
// those markers and are never touched.
//
// Run: npm run test:browser:cleanup
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { reapStaleManagedBrowsers } =
  await import(pathToFileURL(path.join(ROOT, "src/core/browser-launcher.js")).href);

const result = await reapStaleManagedBrowsers();

if (result.skipped) {
  console.log(`SKIPPED — a live OmniClaw (${result.reason}) still owns its browser.`);
  console.log("That is correct: close OmniClaw first if you want its browser closed.");
} else if (result.killed > 0) {
  console.log(`Closed ${result.killed} OmniClaw browser process(es) (${result.reason}).`);
  console.log("Your own Chrome/Edge were NOT touched.");
} else {
  console.log("Nothing to clean — no orphaned OmniClaw browser was running.");
}
console.log("\nThe agent's browser also closes by itself after 5 minutes idle,");
console.log("or immediately via the browser_close tool at the end of a task.");
process.exitCode = 0;
