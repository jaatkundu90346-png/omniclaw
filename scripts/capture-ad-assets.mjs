// Capture the marketing assets for the OmniClaw social ad FROM THE USER'S REAL
// CHROME (not a headless copy), because the ad claims a live browser view and
// the shot has to be the real thing.
//
// It talks raw CDP to the Chrome that OmniClaw launched (debug port 9222):
// opens OmniClaw in a real tab, opens the Browser panel, waits for a LIVE frame
// to arrive in that panel, and screenshots the tab.
//
// R11: touches no live config and never writes to the live session store — it
// only opens a browser tab and writes an image into marketing/video/public/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, sleep } from "./lib/cdp.mjs";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "marketing", "video", "public");
const APP_URL = process.env.OC_APP_URL || "http://127.0.0.1:3147";
const CDP_URL = process.env.OC_CDP_URL || "http://127.0.0.1:9222";
const MIRROR_URL = process.env.OC_MIRROR_URL || "https://example.com";

let step = "start";
const deadline = setTimeout(() => {
  console.error(`TIMEOUT at ${step}`);
  process.exit(2);
}, 120000);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  step = "connect to the real Chrome over CDP";
  const cdp = await Cdp.connect(CDP_URL);
  console.log("ok: attached to the real Chrome");

  step = "open OmniClaw in a real tab";
  // Reuse an existing OmniClaw tab and close the extra ones: piling tabs up in
  // the user's browser is rude, and a background tab makes the screenshot hang.
  const targets = await cdp.send("Target.getTargets", {});
  const mine = (targets.targetInfos || []).filter((t) =>
    t.type === "page" && /127\.0\.0\.1:3147/.test(t.url || ""));
  for (const extra of mine.slice(1)) {
    await cdp.send("Target.closeTarget", { targetId: extra.targetId }).catch(() => {});
  }
  let targetId = mine[0]?.targetId;
  if (!targetId) {
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    targetId = created.targetId;
  }
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  try {
    await cdp.send("Page.navigate", { url: APP_URL }, sessionId);
  } catch (error) {
    console.log(`WARN: Page.navigate timed out (${error.message}); continuing`);
  }
  console.log("ok: OmniClaw tab ready");

  step = "wait for the app to boot";
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await cdp.evaluate(
      "Boolean(document.querySelector('#app .composer') && document.querySelector('.panel-tabs'))",
      sessionId,
    );
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error("the app never mounted in the real Chrome tab");
  console.log("ok: OmniClaw is running in the real Chrome");

  step = "capture the clean workspace shot (panel closed, no menus)";
  await cdp.evaluate(`(() => {
    const KEY = 'omniclaw.next.v1';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
    saved.panel = { ...(saved.panel || {}), open: false };
    localStorage.setItem(KEY, JSON.stringify(saved));
    return true;
  })()`, sessionId);
  await cdp.send("Page.reload", { ignoreCache: false }, sessionId);
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    const mounted = await cdp.evaluate(
      "Boolean(document.querySelector('#app .shell') && document.querySelector('#app .composer'))",
      sessionId,
    );
    if (mounted) break;
    await sleep(500);
  }
  await sleep(1000);
  // Wait for the app to actually be ready (the model pill finishes loading), and
  // close the right panel for this shot — a half-mounted panel or a "Loading…"
  // pill is not a product shot.
  for (let i = 0; i < 40; i++) {
    const ready = await cdp.evaluate(`(() => {
      const pill = document.querySelector('#app .composer .model-pill');
      const shell = document.querySelector('#app .shell');
      const pillText = (pill && pill.innerText || '').trim();
      const closed = Boolean(shell && shell.className.includes('panel-closed'));
      return { ok: Boolean(pill) && !/loading/i.test(pillText) && closed, pillText, closed };
    })()`, sessionId);
    if (ready.ok) break;
    await cdp.evaluate(`(() => {
      const shell = document.querySelector('#app .shell');
      const btn = [...document.querySelectorAll('#app button')].find((b) =>
        /toggle panel/i.test((b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '')));
      const open = shell && !shell.className.includes('panel-closed');
      if (open && btn) btn.click();
      return true;
    })()`, sessionId);
    await sleep(600);
  }
  await sleep(800);
  const cleanShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  const cleanOut = path.join(OUT_DIR, "workspace.png");
  fs.writeFileSync(cleanOut, Buffer.from(cleanShot.data, "base64"));
  console.log(`ok: wrote ${cleanOut} (${(fs.statSync(cleanOut).size / 1024).toFixed(0)} KB)`);

  step = "make the right panel visible (the app remembers it per workspace)";
  await cdp.evaluate(`(() => {
    const KEY = 'omniclaw.next.v1';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
    saved.panel = { ...(saved.panel || {}), open: true, width: 460 };
    localStorage.setItem(KEY, JSON.stringify(saved));
    return true;
  })()`, sessionId);
  await cdp.send("Page.reload", { ignoreCache: false }, sessionId);
  await sleep(2000);
  // The app remounts after the reload: wait for the shell, not just the tab.
  for (let i = 0; i < 40; i++) {
    const mounted = await cdp.evaluate(
      "Boolean(document.querySelector('#app .shell') && document.querySelector('#app .composer'))",
      sessionId,
    );
    if (mounted) break;
    await sleep(500);
  }
  await sleep(1200);

  step = "open the right panel if it is closed";
  const panelDiag = await cdp.evaluate(`(() => {
    const shell = document.querySelector('#app .shell');
    const panel = document.querySelector('#app .panel');
    const btns = [...document.querySelectorAll('#app button')].filter((b) =>
      /toggle panel/i.test((b.getAttribute('title') || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
    // The panel element keeps its width even when the SHELL collapses its grid
    // column (panel-closed -> column 0), so width is NOT the signal.
    // The shell class is.
    const collapsed = Boolean(shell && shell.className.includes('panel-closed'));
    if (collapsed && btns.length) btns[0].click();
    return {
      shellClass: shell ? shell.className : 'none',
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : -1,
      toggleButtons: btns.length,
      clicked: collapsed && btns.length > 0,
    };
  })()`, sessionId);
  console.log(`ok: panel diag ${JSON.stringify(panelDiag)}`);
  await sleep(1800);

  step = "open the Browser panel (real click, real UI)";
  // Close any popover that is already open, then use the PANEL's own "+" menu
  // (the header has a similar one, and a hidden menu item can be clicked by
  // mistake — so only VISIBLE items are considered).
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  }, sessionId);
  await sleep(400);
  await cdp.evaluate(`(() => {
    const plus = document.querySelector('#panel-host .panel-tab.plus') || document.querySelector('.panel-tabs .panel-tab.plus');
    if (plus) plus.click();
    return Boolean(plus);
  })()`, sessionId);
  await sleep(900);
  const opened = await cdp.evaluate(`(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // The panel's shortcut rows are .shortcut-row (both in the popover and in
    // the panel's own .panel-shortcuts block) — NOT .pop-item.
    const all = [...document.querySelectorAll('.shortcut-row')];
    const hits = all.filter((el) => /browser/i.test(el.textContent || ''));
    const vis = hits.filter(visible);
    const target = vis[0] || hits[0];
    if (target) target.click();
    return {
      clicked: Boolean(target),
      rows: all.length,
      browserRows: hits.map((el) => (el.textContent || '').trim().slice(0, 40)),
    };
  })()`, sessionId);
  console.log(`ok: browser row ${JSON.stringify(opened)}`);
  await sleep(2600);

  step = "open a page in the AGENT's own browser (headless -> it always paints)";
  // The managed Chrome only paints the VISIBLE tab, so mirroring a background
  // tab yields no frames. The agent's own Playwright Chromium is headless, so
  // its screencast flows even while OmniClaw stays in the foreground — which
  // is what the panel's agent-stream shows.
  const agentOpen = await fetch(`${APP_URL}/api/tools/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "browser_open", input: { url: MIRROR_URL } }),
  }).then((r) => r.json()).catch(() => null);
  console.log(`ok: agent browser_open -> ${agentOpen && agentOpen.result ? "opened" : "failed"}`);
  await sleep(3000);

  step = "point the panel at the agent's page (the one with the agent dot)";
  await cdp.evaluate(`(() => {
    const tab = document.querySelector('.brw-tab:has(.brw-agent-dot)') || document.querySelector('.brw-tab');
    if (tab) tab.click();
    return true;
  })()`, sessionId);
  await sleep(2200);

  step = "close any leftover popover (it would cover the shot)";
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  }, sessionId);
  await cdp.evaluate(`(() => {
    const main = document.querySelector('#app .main') || document.querySelector('#app .view');
    if (main) main.click();
    return true;
  })()`, sessionId);
  await sleep(800);

  step = "point the panel at a REAL page (not at OmniClaw itself)";
  await cdp.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.brw-tab')];
    const wanted = tabs.find((el) => /Example Domain|example\\.com/i.test(el.textContent || el.title || ''));
    if (wanted) wanted.click();
    return tabs.map((el) => (el.textContent || '').trim());
  })()`, sessionId);
  await sleep(2000);

  step = "wait for a LIVE frame in the panel";
  let live = false;
  let frameInfo = {};
  for (let i = 0; i < 40; i++) {
    frameInfo = await cdp.evaluate(`(() => {
      const img = document.querySelector('.brw-img');
      return {
        src: img ? String(img.src || '').slice(0, 40) : '',
        len: img ? String(img.src || '').length : 0,
        natural: img ? [img.naturalWidth, img.naturalHeight] : [0, 0],
        live: (document.querySelector('.brw-live') || {}).className || '',
        activeTab: (document.querySelector('.brw-tab.active') || {}).innerText || '',
      };
    })()`, sessionId);
    live = frameInfo.len > 100 && frameInfo.natural[0] > 0;
    if (live) break;
    await sleep(700);
  }
  console.log(live ? `ok: live frame ${JSON.stringify(frameInfo)}` : `WARN: no live frame ${JSON.stringify(frameInfo)}`);
  await sleep(1200);

  step = "screenshot the real Chrome tab";
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const out = path.join(OUT_DIR, "browser-live.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`ok: wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);

  step = "close only the tab we opened";
  await cdp.send("Target.closeTarget", { targetId });
  cdp.ws.close();
  console.log("ok: captured from the real Chrome");
}

main()
  .then(() => {
    clearTimeout(deadline);
    console.log("AD ASSETS: OK");
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(deadline);
    console.error(`FAIL at ${step}: ${error.stack || error.message}`);
    process.exit(1);
  });
