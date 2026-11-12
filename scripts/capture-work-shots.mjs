// Capture the ad's shots from the USER'S REAL CHROME (the Chrome OmniClaw
// drives, CDP on 9222).
//
// The frames are CLIPS of the real app, not whole-window screenshots: an ad
// needs the chat text to be legible, so the thread is zoomed (the app's own
// CSS is scaled up) and only the interesting column is captured.
//
//   working-session.png — the task the user gave + the agent's step list
//                         (every tool call it made, with timings and status)
//   working-answer.png  — the agent's own report of what it built
//   built-output.png    — the page the agent WROTE (its hero section)
//   live-panel.png      — the app's browser panel showing that page live
//
// The script NEVER changes the model, the provider or the config, and it
// always restores the user's real window size when it is done.
//
// Usage: node scripts/capture-work-shots.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Cdp, sleep } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "marketing", "video", "public");
const APP_URL = process.env.OC_APP_URL || "http://127.0.0.1:3147";
const CDP_URL = process.env.OC_CDP_URL || "http://127.0.0.1:9222";

// The run the ad shows: a real task, a real agent, real tool calls.
const SESSION_ID = process.env.OC_AD_SESSION || "session_1794461034434_lv9xx2";
const BUILT_NAME = "bean-there.html";

// Zoom the thread so the chat text is legible once the frame is scaled into
// the video (the app's own 13px on an 860px column would be unreadable).
const ZOOM_CSS = `
  .user-bubble { font-size: 26px !important; line-height: 1.45 !important; padding: 14px 18px !important; }
  .turn-head { font-size: 20px !important; }
  .turn-head .ht { font-size: 20px !important; }
  .step { font-size: 25px !important; min-height: 38px !important; }
  .step .s-ic { width: 22px !important; height: 22px !important; }
  .step .s-ic svg { width: 22px !important; height: 22px !important; }
  .step .s-me, .step .s-st { font-size: 19px !important; }
  .answer { font-size: 25px !important; line-height: 1.5 !important; }
  .answer p, .answer li { font-size: 25px !important; line-height: 1.5 !important; }
  .answer h3, .answer strong { font-size: 27px !important; }
  .thread { gap: 22px !important; }
`;

let step = "start";
const deadline = setTimeout(() => {
  console.error(`TIMEOUT at ${step}`);
  process.exit(2);
}, 420000);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  step = "connect to the real Chrome over CDP";
  const cdp = await Cdp.connect(CDP_URL);
  console.log("ok: attached to the real Chrome");

  const targets = await cdp.send("Target.getTargets");
  const mine = (targets.targetInfos || []).filter((t) =>
    t.type === "page" && /127\.0\.0\.1:3147/.test(t.url || ""));
  let targetId = mine[0]?.targetId;
  if (!targetId) {
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
  }
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    // deviceScaleFactor 2: the frame comes out 1:1 with the CSS layout, so
    // the chat text stays sharp when the shot is scaled into the video.
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
  }, sessionId);
  await cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  try {
    await cdp.send("Page.navigate", { url: APP_URL }, sessionId);
  } catch (error) {
    console.log(`WARN: navigate timed out (${error.message})`);
  }
  await cdp.waitFor(
    "Boolean(document.querySelector('#app .composer textarea'))",
    sessionId,
    { timeoutMs: 30000 },
  );

  step = "open the real session";
  await cdp.evaluate(`location.hash = '#/t/' + encodeURIComponent(${JSON.stringify(SESSION_ID)})`, sessionId);
  await sleep(4000);
  const ready = await cdp.waitFor(
    "Boolean(document.querySelector('#app .user-bubble')) && Boolean(document.querySelector('#app .turn-assistant'))",
    sessionId,
    { timeoutMs: 30000 },
  );
  console.log(`ok: the session rendered (${ready})`);
  await sleep(1500);

  step = "expand the step list and zoom the thread";
  const zoomed = await cdp.evaluate(`(() => {
    const lists = [...document.querySelectorAll('#app .turn-assistant .turn-steps')];
    lists.forEach((el) => el.classList.remove('collapsed'));
    document.querySelectorAll('#app .turn-assistant .s-de').forEach((el) => { el.hidden = true; });
    const style = document.createElement('style');
    style.id = 'ad-zoom';
    style.textContent = ${JSON.stringify(ZOOM_CSS)};
    document.head.appendChild(style);
    // Close the side panel: it would bleed into the chat frame, and the chat
    // reads much better with the full width.
    const shell = document.querySelector('#app .shell');
    const toggle = [...document.querySelectorAll('#app button')].find((b) =>
      /toggle panel/i.test((b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '')));
    if (shell && !/panel-closed/.test(shell.className) && toggle) toggle.click();
    // The composer floats OVER the thread: hide it, or it covers the last
    // rows of the step list.
    const composer = document.querySelector('#app .composer-zone');
    if (composer) composer.style.visibility = 'hidden';
    // Un-clip the thread so the WHOLE history lays out in the page: the app
    // keeps it scrolled to the bottom ("Jump to latest"), and fighting that
    // scroll is how you end up shooting the wrong part of the run.
    const view = document.querySelector('#view');
    if (view) {
      view.style.height = view.scrollHeight + 'px';
      view.style.maxHeight = 'none';
      view.style.overflow = 'visible';
      view.scrollTop = 0;
    }
    window.scrollTo(0, 0);
    return { lists: lists.length, steps: lists[0] ? lists[0].querySelectorAll('.step').length : 0 };
  })()`, sessionId);
  console.log(`ok: step lists=${zoomed.lists} steps=${zoomed.steps}`);
  await sleep(2000);

  step = "measure the chat column";
  const rects = await cdp.evaluate(`(() => {
    const thread = document.querySelector('#app .thread');
    const bubble = [...document.querySelectorAll('#app .user-bubble')].pop();
    const steps = document.querySelector('#app .turn-assistant .turn-steps');
    const answer = document.querySelector('#app .turn-assistant .answer') || document.querySelector('#app .answer');
    const head = document.querySelector('#app .turn-assistant .turn-head');
    const box = (el) => el ? el.getBoundingClientRect() : null;
    const t = box(thread);
    const shell = box(document.querySelector('#app .shell'));
    return {
      // The shell fills the viewport: its width IS the layout width, which is
      // what the frame's pixel width must be divided by (the tab may be
      // zoomed, so window.innerWidth is not trustworthy here).
      shell: shell ? { w: shell.width, h: shell.height } : null,
      thread: t ? { x: t.x, y: t.y, w: t.width, h: t.height } : null,
      bubble: box(bubble) ? { x: box(bubble).x, y: box(bubble).y, w: box(bubble).width, h: box(bubble).height } : null,
      head: box(head) ? { y: box(head).y, h: box(head).height } : null,
      steps: box(steps) ? { x: box(steps).x, y: box(steps).y, w: box(steps).width, h: box(steps).height } : null,
      answer: box(answer) ? { x: box(answer).x, y: box(answer).y, w: box(answer).width, h: box(answer).height } : null,
    };
  })()`, sessionId);
  console.log(`ok: ${JSON.stringify(rects)}`);

  step = "capture the working session";
  if (rects.thread && rects.bubble) {
    // Chrome's clip parameter is refused by this build, so the frame is shot
    // whole and cropped with ffmpeg afterwards.
    await cdp.evaluate("window.scrollTo(0, 0)", sessionId);
    await sleep(900);
    const raw = path.join(OUT_DIR, ".raw-app-top.png");
    await shot(cdp, sessionId, raw);
    const region = {
      x: Math.max(0, rects.thread.x - 10),
      y: Math.max(0, rects.bubble.y - 18),
      w: rects.thread.w + 20,
      h: Math.min(rects.shell.h - Math.max(0, rects.bubble.y - 18), (rects.steps ? rects.steps.h : 300) + 190),
    };
    cropRegion(raw, path.join(OUT_DIR, "working-session.png"), region, rects);
    fs.rmSync(raw, { force: true });
  }

  step = "capture the agent's report";
  if (rects.answer && rects.answer.h > 40) {
    // The thread is un-clipped, so the page cannot scroll it: shift the whole
    // thread up instead, and shoot the report from the top of the frame.
    const shift = Math.round(rects.answer.y - 30);
    await cdp.evaluate(`(() => {
      const view = document.querySelector('#view');
      if (view) view.style.marginTop = ${-shift} + 'px';
      window.scrollTo(0, 0);
      return true;
    })()`, sessionId);
    await sleep(900);
    const raw = path.join(OUT_DIR, ".raw-app-answer.png");
    await shot(cdp, sessionId, raw);
    // Only the report itself: the steps above it have their own frame.
    cropRegion(raw, path.join(OUT_DIR, "working-answer.png"), {
      x: rects.answer.x - 16,
      y: 0,
      w: rects.answer.w + 32,
      h: Math.min(760, rects.answer.h),
    }, rects);
    fs.rmSync(raw, { force: true });
  }

  step = "capture the live browser panel";
  const panel = await cdp.evaluate(`(() => {
    const shell = document.querySelector('#app .shell');
    const toggle = [...document.querySelectorAll('#app button')].find((b) =>
      /toggle panel/i.test((b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '')));
    if (shell && /panel-closed/.test(shell.className) && toggle) toggle.click();
    const frame = document.querySelector('#panel-host iframe, #panel-host .brw-img, #panel-host .brw-frame');
    if (!frame) return null;
    const r = frame.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`, sessionId);
  if (panel && panel.w > 200) {
    await sleep(2500);
    const raw = path.join(OUT_DIR, ".raw-panel.png");
    await shot(cdp, sessionId, raw);
    crop(raw, path.join(OUT_DIR, "live-panel.png"), panel.w, panel.h, panel.x, panel.y);
    fs.rmSync(raw, { force: true });
  } else {
    console.log("WARN: no live browser panel to capture");
  }

  step = "capture the page the agent built";
  const built = findBuilt(ROOT, BUILT_NAME);
  if (!built) {
    console.log(`WARN: ${BUILT_NAME} not found — keeping the previous built-output.png`);
  } else {
    console.log(`ok: built ${built}`);
    const url = `file:///${built.replace(/\\/g, "/")}`;
    const created = await cdp.send("Target.createTarget", { url });
    const builtTarget = created.targetId;
    const builtSession = (await cdp.send("Target.attachToTarget", { targetId: builtTarget, flatten: true })).sessionId;
    await cdp.send("Page.enable", {}, builtSession);
    await cdp.send("Runtime.enable", {}, builtSession);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    }, builtSession);
    await cdp.send("Target.activateTarget", { targetId: builtTarget }).catch(() => {});
    await sleep(2500);
    const title = await cdp.evaluate("document.title", builtSession);
    console.log(`ok: opened "${title}"`);
    await shot(cdp, builtSession, path.join(OUT_DIR, "built-output.png"));
    console.log("ok: wrote built-output.png");
    await cdp.send("Target.closeTarget", { targetId: builtTarget }).catch(() => {});
  }

  step = "restore the user's own window";
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
  await cdp.send("Page.reload", {}, sessionId).catch(() => {});
  console.log("ok: the real window size is restored");
  await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  cdp.ws.close();
}

/** Capture a clip of the page. */
async function shot(cdp, sessionId, file, clip, beyond = false) {
  const params = { format: "png" };
  if (clip) params.clip = { ...clip, scale: 1 };
  if (beyond) params.captureBeyondViewport = true;
  const res = await cdp.send("Page.captureScreenshot", params, sessionId);
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
}

/** Crop a captured frame with ffmpeg (the PNG crop is done off-browser). */
function crop(src, dst, w, h, x, y) {
  const ffmpeg = (process.env.OC_FFMPEG || "ffmpeg").trim();
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", src,
    "-vf", `crop=${Math.round(w)}:${Math.round(h)}:${Math.round(x)}:${Math.round(y)}`,
    dst,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg crop failed: ${result.stderr || result.error?.message}`);
  }
  console.log(`ok: cropped ${dst} (${Math.round(w)}x${Math.round(h)} @ ${Math.round(x)},${Math.round(y)})`);
}

/**
 * Crop a region of a raw frame. The DOM speaks CSS px, the frame speaks device
 * px, and the tab may be zoomed — so the rect is scaled by the shot's own
 * width before it is cut.
 */
function cropRegion(raw, dst, rect, scaleHint) {
  const ffprobe = (process.env.OC_FFPROBE || "ffprobe").trim();
  const size = spawnSync(ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
    "-of", "csv=p=0", raw,
  ], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const [imgW, imgH] = [size[0] || 1440, size[1] || 900];
  const layoutW = scaleHint && scaleHint.shell ? scaleHint.shell.w : 0;
  const scale = layoutW ? imgW / layoutW : 1;
  const x = Math.max(0, Math.min(Math.round(rect.x * scale), imgW - 20));
  const y = Math.max(0, Math.min(Math.round(rect.y * scale), imgH - 20));
  const w = Math.max(20, Math.min(Math.round(rect.w * scale), imgW - x));
  const h = Math.max(20, Math.min(Math.round(rect.h * scale), imgH - y));
  console.log(`   frame ${imgW}x${imgH}, layout ${Math.round(layoutW)}, scale ${scale.toFixed(3)}`);
  crop(raw, dst, w, h, x, y);
}

/** Find a file the agent wrote, wherever the active workspace put it. */
function findBuilt(root, name) {
  const skip = new Set(["node_modules", ".git", "dist", ".tmp-test-data", ".tmp-next-data", "vendor", "out"]);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === name) return full;
      if (e.isDirectory() && !skip.has(e.name)) stack.push(full);
    }
  }
  return "";
}

main()
  .then(() => {
    clearTimeout(deadline);
    console.log("WORK SHOTS: OK");
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(deadline);
    console.error(`FAIL at ${step}: ${error.stack || error.message}`);
    process.exit(1);
  });
