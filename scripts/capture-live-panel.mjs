// Capture the app's LIVE browser panel — the agent driving the user's real
// browser, watched frame by frame.
//
// This is the ad's "you watch every click, live" shot: the panel on the right
// of OmniClaw, mirroring the page the agent is working on.
//
// Usage: node scripts/capture-live-panel.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cdp, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "marketing", "video", "public");
const CDP_URL = process.env.OC_CDP_URL || "http://127.0.0.1:9222";
const APP_URL = process.env.OC_APP_URL || "http://127.0.0.1:3147";

let step = "start";
const deadline = setTimeout(() => {
  console.error(`TIMEOUT at ${step}`);
  process.exit(2);
}, 180000);

const cdp = await Cdp.connect(CDP_URL);
const targets = await cdp.send("Target.getTargets");
const mine = (targets.targetInfos || []).filter((t) => t.type === "page" && /127\.0\.0\.1:3147/.test(t.url || ""));
let targetId = mine[0]?.targetId;
if (!targetId) {
  const created = await cdp.send("Target.createTarget", { url: APP_URL });
  targetId = created.targetId;
}
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);
// A fixed viewport + 2x device pixels: the panel is shot at full fidelity, so
// its text stays readable once the frame is scaled into the video.
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
}, sessionId);
await cdp.send("Target.activateTarget", { targetId }).catch(() => {});
await cdp.send("Page.navigate", { url: APP_URL }, sessionId).catch(() => {});
await sleep(4000);

step = "open the browser panel";
const opened = await cdp.evaluate(`(() => {
  const shell = document.querySelector('#app .shell');
  if (shell && /panel-closed/.test(shell.className)) {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /panel/i.test((b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '')));
    if (btn) { btn.click(); return 'toggle'; }
  }
  return 'already open';
})()`, sessionId);
console.log(`ok: panel ${opened}`);
await sleep(2500);

step = "pick the agent's browser tab";
const picked = await cdp.evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.brw-tab')];
  if (!tabs.length) return 'no tabs';
  // The interesting tab is the PAGE the agent built (not OmniClaw itself).
  const hit = tabs.find((t) => /bean|there|example/i.test(t.textContent || '') && !/omniclaw/i.test(t.textContent || ''));
  const agent = hit || tabs[tabs.length - 1];
  agent.click();
  return (agent.textContent || 'clicked').trim();
})()`, sessionId);
console.log(`ok: browser tab "${picked}"`);
await sleep(3000);

step = "find the live frame";
const frame = await cdp.evaluate(`(() => {
  const img = document.querySelector('.brw-img');
  if (!img) return null;
  const r = img.getBoundingClientRect();
  return {
    x: r.x, y: r.y, w: r.width, h: r.height,
    live: Boolean(img.src && img.src.startsWith('data:image')),
    vw: window.innerWidth, vh: window.innerHeight,
  };
})()`, sessionId);
console.log(`ok: frame ${JSON.stringify(frame)}`);

step = "capture";
if (frame && frame.w > 100) {
  const raw = path.join(OUT_DIR, ".raw-panel.png");
  const res = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(raw, Buffer.from(res.data, "base64"));
  const ffprobe = (process.env.OC_FFPROBE || "ffprobe").trim();
  const size = spawnSync(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0", raw,
  ], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const [imgW, imgH] = [size[0] || 1440, size[1] || 900];
  // The tab can be zoomed (the DOM is in CSS px, the shot is in device px).
  const scale = frame.vw ? imgW / frame.vw : 1;
  const x = Math.max(0, Math.min(Math.round(frame.x * scale), imgW - 10));
  const y = Math.max(0, Math.min(Math.round(frame.y * scale), imgH - 10));
  const w = Math.min(Math.round(frame.w * scale), imgW - x);
  const h = Math.min(Math.round(frame.h * scale), imgH - y);
  const ffmpeg = (process.env.OC_FFMPEG || "ffmpeg").trim();
  const out = path.join(OUT_DIR, "browser-live.png");
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-i", raw,
    "-vf", `crop=${w}:${h}:${x}:${y}`,
    out,
  ], { encoding: "utf8" });
  fs.rmSync(raw, { force: true });
  if (result.status !== 0) {
    console.error(`ffmpeg crop failed: ${result.stderr}`);
    process.exit(1);
  }
  console.log(`ok: wrote browser-live.png (${w}x${h} of ${imgW}x${imgH})`);
} else {
  console.log("WARN: no live frame to capture");
}

step = "restore the user's window";
await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
await cdp.send("Page.reload", {}, sessionId).catch(() => {});
console.log("ok: the real window size is restored");
cdp.ws.close();
clearTimeout(deadline);
process.exit(0);
