// A/B/C/D benchmark harness for minecraft-clone.
// Replicates EXACTLY what src/core/browser-playwright.js does for the agent's
// browser_*: same launch args, same context options, same CPU throttling.
// Usage: node abtest-run.mjs '<label>' <disableGpu:true|false> <w> <h> <rate> <url>
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const execFileP = promisify(execFile);

const [label, disableGpu, W, H, rate, url] = process.argv.slice(2);
const OBSERVE_SECS = 8;
const SAMPLER_TIMEOUT_MS = 240000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const args = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  ...(disableGpu === 'true' ? ['--disable-gpu'] : []),
  '--renderer-process-limit=1',
  '--omniclaw-agent-browser=1',
];
if (process.env.ABTEST_HEADED === '1') args.push('--headless=new');

const t0 = Date.now();
const out = { label, url, disableGpu, viewport: `${W}x${H}`, rate: Number(rate) };
let browser, context, page;

try {
  browser = await chromium.launch({ headless: true, args });
  context = await browser.newContext({
    viewport: { width: Number(W), height: Number(H) },
    userAgent: UA, locale: 'en-US', timezoneId: 'Asia/Kolkata',
  });
  page = await context.newPage();

  const r = Number(rate);
  if (r > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: r });
  }

  // Step 2: open the URL
  const nav = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  out.navMs = Date.now() - nav;

  // Step 3: read console errors
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.waitForTimeout(2500);
  out.consoleErrors = consoleErrors;
  out.pageErrors = pageErrors;

  // Step 4: player position
  const readPos = () => page.evaluate(() => {
    const g = window.__game;
    if (!g) return { error: 'window.__game missing' };
    const p = g.player?.pos;
    return p ? { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), flying: !!g.player?.flying, onGround: !!g.player?.onGround } : { error: 'player.pos missing' };
  });
  out.lowPower = await page.evaluate(() => (window.__game ? !!window.__game.lowPower : null));
  out.posBefore = await readPos();

  // Step 5: press W for 2 seconds, then read again
  const mv = Date.now();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2000);
  await page.keyboard.up('KeyW');
  out.moveMs = Date.now() - mv;
  await page.waitForTimeout(300);
  out.posAfter = await readPos();
  if (out.posBefore?.x !== undefined && out.posAfter?.x !== undefined) {
    out.moved = +Math.hypot(out.posAfter.x - out.posBefore.x, out.posAfter.z - out.posBefore.z).toFixed(3);
  }

  // Idle observation window -> CPU sampling (fan proxy).
  // Written to a .ps1 and run with -File: a multi-line -Command string gets
  // mangled by argv quoting on Windows. Kept deliberately light (one process
  // query per tick) because this box has only 2 logical cores and a saturated
  // Chrome starves anything else that tries to run.
  // machinePct follows Task Manager semantics: 100% = one core fully busy,
  // so with N cores the ceiling is N*100.
  const secs = OBSERVE_SECS;
  const ps = `
$start = Get-Date
$first = @{}; $last = @{}
1..${secs} | ForEach-Object {
  $now = @{}
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($p.CPU -ne $null -and $p.Name -match '^(chrome|chrome-headless-shell|node|msedge)') {
      $now[$p.Name] = ($now[$p.Name] + $p.CPU)
    }
  }
  foreach ($k in $now.Keys) {
    if (-not $first.ContainsKey($k)) { $first[$k] = $now[$k] }
    $last[$k] = $now[$k]
  }
  Start-Sleep -Milliseconds 900
}
$elapsed = ((Get-Date) - $start).TotalSeconds
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$res = @()
foreach ($k in $last.Keys) {
  $d = $last[$k] - $first[$k]
  if ($d -ge 0) { $res += [pscustomobject]@{ name=$k; machinePct=[math]::Round(($d/$elapsed)*100,1) } }
}
[pscustomobject]@{ cores=$cores; elapsedSec=[math]::Round($elapsed,1); ceiling=$cores*100; procs=$res } | ConvertTo-Json -Depth 4 -Compress
`;
  const tmpPs = path.join(os.tmpdir(), `abtest-cpu-${label}.ps1`);
  fs.writeFileSync(tmpPs, ps, 'utf8');
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', tmpPs], { maxBuffer: 1e6, timeout: SAMPLER_TIMEOUT_MS });
  try { out.cpu = JSON.parse((stdout || '').trim() || '{}'); } catch { out.cpuRaw = (stdout || '').trim().slice(0, 400); }
} catch (e) {
  out.fatal = String(e?.message || e).split('\n')[0];
  out.fatalFull = String(e?.stack || '').split('\n').slice(0, 4).join(' | ');
} finally {
  // Step 6: browser_close
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  out.totalMs = Date.now() - t0;
}
console.log('RESULT_JSON:' + JSON.stringify(out));
process.exit(0);
