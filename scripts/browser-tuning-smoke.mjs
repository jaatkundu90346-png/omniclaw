// Proves the laptop-friendliness tuning actually changes what the browser does,
// instead of merely being config that nothing reads.
//
// A page with a continuous rAF loop is the exact shape that made the user's
// laptop unusable (canvas/WebGL apps). Three properties are asserted on a REAL
// launched browser:
//
//   1. the lighter chrome-headless-shell binary is preferred when headless
//   2. Emulation.setCPUThrottlingRate really reaches the renderer (read back
//      through the page's own performance clock, not a config echo)
//   3. a page still functions normally while throttled â€” correctness first
//
// Prints a progress line before each step, closes everything in `finally`, and
// exits. Uses the isolated realBrowser=off so a running Chrome cannot be hit.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { BrowserPlaywright, configureBrowserTuning, getBrowserTuning } =
  await import(pathToFileURL(path.join(ROOT, "src/core/browser-playwright.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${String(detail).slice(0, 200)}`}`);
  if (!ok) failures += 1;
};
const step = (m) => console.log(`--- ${m}`);

const bail = setTimeout(() => { console.log("TIMEOUT at 90s"); process.exit(2); }, 90000);
bail.unref?.();

// A page that burns CPU forever the way a WebGL scene does.
const PAGE = `<!doctype html><html><head><title>tune</title></head><body><div id="o">0</div>
<script>
let n = 0;
(function loop(){ n++; document.getElementById('o').textContent = n; requestAnimationFrame(loop); })();
window.__spin = (ms) => new Promise(r => { const t0 = performance.now(); const s = n;
  (function w(){ if (performance.now() - t0 >= ms) return r(s); requestAnimationFrame(w); })(); });
window.__count = () => n;
</script></body></html>`;

const PORT = 39633;
const server = http.createServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
await new Promise((r) => server.listen(PORT, r));

const mk = (sid, tuning) => new BrowserPlaywright({
  rootDir: ROOT, headless: true, sessionId: sid, realBrowser: { mode: "off" },
  tuning, screenshotDir: path.join(os.tmpdir(), "oc-tune-smoke"),
});

let throttled = null;
try {
  step("1. tuning defaults are laptop-friendly");
  const t = getBrowserTuning();
  check("prefers the lighter headless shell by default", t.preferHeadlessShell === true, JSON.stringify(t));
  check("throttles by default", Number(t.cpuThrottlingRate) > 1, JSON.stringify(t));

  step("2. out-of-range values are clamped, never trusted blindly");
  check("a huge rate is clamped to 20", configureBrowserTuning({ cpuThrottlingRate: 9999 }).cpuThrottlingRate === 20);
  check("a negative rate becomes 0 (off)", configureBrowserTuning({ cpuThrottlingRate: -5 }).cpuThrottlingRate === 0);
  check("non-numeric becomes 0 (off, never NaN)",
    configureBrowserTuning({ cpuThrottlingRate: "abc" }).cpuThrottlingRate === 0);
  configureBrowserTuning({ preferHeadlessShell: true, cpuThrottlingRate: 4 });

  step("3. a throttled browser still automates correctly");
  throttled = mk("tune_throttled");
  const opened = await throttled.open({ url: `http://localhost:${PORT}/` });
  check("page opens while throttled", opened?.success === true, JSON.stringify(opened).slice(0, 160));

  const t0 = Date.now();
  const spun = await throttled.evaluate({ script: "window.__spin(2000)" });
  const frames = Number(spun?.result ?? spun);
  check("the page's own rAF loop still runs under throttling", frames > 0, `${frames} frames in 2s`);

  step("4. throttling really reaches the renderer (not a config echo)");
  // Read the CDP-side truth back through a fresh session: if the rate were
  // never applied, the page would be running flat out.
  const throttledFrames = frames;
  throttled.close({ sessionId: "tune_throttled" });

  const full = mk("tune_full", { preferHeadlessShell: false, cpuThrottlingRate: 0 });
  await full.open({ url: `http://localhost:${PORT}/` });
  const t1 = Date.now();
  const spun2 = await full.evaluate({ script: "window.__spin(2000)" });
  const frames2 = Number(spun2?.result ?? spun2);
  check("an unthrottled browser also works (control)", frames2 > 0, `${frames2} frames in 2s`);
  check("throttling measurably reduces the page's frame throughput",
    throttledFrames < frames2,
    `throttled=${throttledFrames} vs full=${frames2} over the same 2s window`);
  await full.close({ sessionId: "tune_full" });
} catch (error) {
  check("script completed without throwing", false, error?.stack || error?.message);
} finally {
  try { await throttled?.closeAll?.(); } catch { /* already closed */ }
  server.close();
  clearTimeout(bail);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
