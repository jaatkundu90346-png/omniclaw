// Undo the capture side-effects on the USER'S REAL Chrome.
//
// The capture script forces a viewport on the app tab (Emulation
// .setDeviceMetricsOverride) so the screenshot is stable. If that override is
// left behind, the user's own window renders at the forced size — the app
// looks cut off on the right and at the bottom.
//
// This resets the tab to the real window size and reloads it, and closes the
// blank tabs the capture runs left behind.
//
// Usage: node scripts/reset-capture-chrome.mjs
import { Cdp, sleep } from "./lib/cdp.mjs";

const CDP_URL = process.env.OC_CDP_URL || "http://127.0.0.1:9222";

const cdp = await Cdp.connect(CDP_URL);
const targets = await cdp.send("Target.getTargets");
const pages = (targets.targetInfos || []).filter((t) => t.type === "page");

// 1. close the blank tabs the capture scripts created
for (const t of pages.filter((p) => p.url === "about:blank")) {
  await cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  console.log(`ok: closed blank tab ${t.targetId}`);
}

// 2. drop the forced viewport on the app tab and reload it
const app = pages.find((p) => /127\.0\.0\.1:3147/.test(p.url || ""));
if (app) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: app.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
  await cdp.send("Page.reload", { ignoreCache: false }, sessionId).catch(() => {});
  console.log("ok: cleared the device metrics override and reloaded the app tab");
  await sleep(3000);
  const size = await cdp.evaluate(
    "({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })",
    sessionId,
  );
  console.log(`ok: the app tab is back to the real window size ${JSON.stringify(size)}`);
} else {
  console.log("no app tab open");
}

cdp.ws.close();
process.exit(0);
