// One-shot arch-boundary scan — no dynamic node: imports in src/, no --pretty=format,
// and no mojibake (double-encoded UTF-8) in shipped sources.
import fs from "node:fs";
import path from "node:path";

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "vendor", ".git", "dist", "data", "tmp"].includes(e.name)) walk(p, acc);
    } else if (/\.(js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

let violations = 0;
const dynRe = /await\s+import\s*\(\s*[`'"]node:/g;
for (const f of walk("src")) {
  const s = fs.readFileSync(f, "utf8");
  let m;
  while ((m = dynRe.exec(s))) {
    console.log(`VIOLATION dyn-import: ${f}:${s.slice(0, m.index).split("\n").length}`);
    violations++;
  }
}
const serverSrc = fs.readFileSync("server.js", "utf8");
if (/pretty=format:/.test(serverSrc)) { console.log("VIOLATION pretty-format in server.js"); violations++; }
for (const f of walk("src")) {
  const s = fs.readFileSync(f, "utf8");
  if (/pretty=format:/.test(s)) { console.log(`VIOLATION pretty-format: ${f}`); violations++; }
}
// ── Mojibake guard ────────────────────────────────────────────────────────
// Real bug this catches: an edit applied with a PowerShell round-trip
// (`Get-Content -Raw` then `[IO.File]::WriteAllText`) decodes UTF-8 as the
// system codepage and re-encodes it, so every emoji and box-drawing char in the
// file is double-encoded. In the composer this turned the workspace folder and
// pin icons into "ðŸ“" / "ðŸ'¥" in the UI strip. Nothing threw, `node --check`
// passed, and every test stayed green — the file was simply wrong on screen.
//
// The tell is a run of Latin-1 supplement characters where a symbol belongs.
// C1 controls are included because a truncated/double-encoded file often yields
// them too.
const MOJIBAKE_RE = /[À-ÿ]{2,}|[\u0080-\u009F]/;
for (const dir of ["src", "web-next", "scripts", "public"]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir)) {
    const s = fs.readFileSync(f, "utf8");
    const idx = s.search(MOJIBAKE_RE);
    if (idx === -1) continue;
    const line = s.slice(0, idx).split("\n").length;
    const snippet = JSON.stringify(s.slice(Math.max(0, idx - 20), idx + 20));
    console.log(`VIOLATION mojibake (double-encoded UTF-8): ${f}:${line} ${snippet}`);
    violations++;
  }
}
console.log(violations === 0 ? "ARCH BOUNDARIES CLEAN" : `${violations} VIOLATION(S)`);
process.exit(violations === 0 ? 0 : 1);
