// Undo a per-site zoom that a capture run left on the user's Chrome.
//
// Emulation.setDeviceMetricsOverride with a deviceScaleFactor other than the
// screen's makes Chrome record a ZOOM for that origin (the "per_host_zoom_levels"
// pref). The app tab then renders at half size until someone presses Ctrl+0.
//
// This rewrites the profile's Preferences and removes the entry, so the NEXT
// start of the browser is clean. The running browser keeps its in-memory zoom
// until it is restarted (Ctrl+0 in the tab does it immediately).
//
// Usage: node scripts/reset-capture-zoom.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
const prefs = path.join(base, "OmniClaw", "chrome-debug-profile", "Default", "Preferences");

if (!fs.existsSync(prefs)) {
  console.log("no managed-Chrome profile to clean");
  process.exit(0);
}

let json;
try {
  json = JSON.parse(fs.readFileSync(prefs, "utf8"));
} catch (error) {
  console.log(`cannot read the profile prefs: ${error.message}`);
  process.exit(1);
}

const removed = [];

/** Walk the prefs and clean every per-host zoom map it finds. */
function clean(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (node.per_host_zoom_levels && typeof node.per_host_zoom_levels === "object") {
    for (const bucket of Object.values(node.per_host_zoom_levels)) {
      if (!bucket || typeof bucket !== "object") continue;
      for (const [origin, value] of Object.entries(bucket)) {
        const level = Number(value?.zoom_level);
        const factor = Number.isFinite(level) ? Math.pow(1.2, level) : 1;
        // Only the origins a capture drives, and only a VISIBLE zoom: the app
        // tab must sit at 100% (the captures took the app at 1:1).
        const ours = /^127\.0\.0\.1(:\d+)?$/.test(origin) || origin.startsWith("file:///");
        if (ours && Math.abs(factor - 1) > 0.1) {
          removed.push(`${origin} (${factor.toFixed(2)}x -> 1x)`);
          value.zoom_level = 0;
        }
      }
    }
  }
  for (const value of Object.values(node)) clean(value, depth + 1);
}

clean(json);

if (!removed.length) {
  console.log("every recorded zoom is a normal one — nothing to undo");
  process.exit(0);
}

try {
  fs.writeFileSync(prefs, JSON.stringify(json));
  console.log(`removed the stray zoom for: ${removed.join(", ")}`);
  console.log("the running browser still shows it until it is restarted (or Ctrl+0 in the tab)");
} catch (error) {
  console.log(`cannot write the profile prefs: ${error.message}`);
  process.exit(1);
}
