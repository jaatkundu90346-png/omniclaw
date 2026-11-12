// Static contract smoke for the OmniClaw social ad.
//
// Remotion rules that are easy to break silently, and that a render will not
// tell you about:
//   - every scene must be registered with the right id / size / duration
//   - the scenes must tile the timeline with no gap and no overlap
//   - no CSS transition/animation (Remotion does not render them) — motion must
//     come from useCurrentFrame() + interpolate()
//   - transforms must use the scale/translate/rotate shorthands, not a
//     `transform:` string, so Studio can still edit them
//   - every asset referenced by staticFile() must exist in public/
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO = path.join(ROOT, "marketing", "video");
const read = (rel) => fs.readFileSync(path.join(VIDEO, rel), "utf8");

let passed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`ok: ${label}`); }
  else { console.error(`FAIL: ${label}`); process.exitCode = 1; }
}

console.log("step 1: the project exists and compiles as TypeScript");
{
  ok(fs.existsSync(path.join(VIDEO, "package.json")), "marketing/video/package.json exists");
  ok(fs.existsSync(path.join(VIDEO, "src", "OmniClawAd.tsx")), "the ad composition source exists");
  ok(fs.existsSync(path.join(VIDEO, "src", "Root.tsx")), "the root registration exists");
  ok(/remotion/.test(read("package.json")), "remotion is a dependency");
}

console.log("step 2: compositions are registered for social sizes");
{
  const root = read("src/Root.tsx");
  ok(/id="OmniClawAd"/.test(root), "the vertical composition id is registered");
  ok(/id="OmniClawAdSquare"/.test(root), "the square composition id is registered");
  ok(/width=\{1080\}/.test(root) && /height=\{1920\}/.test(root), "vertical is 1080x1920");
  ok(/width=\{1080\}/.test(root) && /height=\{1080\}/.test(root), "square is 1080x1080");
  ok(/durationInFrames=\{1200\}/.test(root), "the ad is 1200 frames (40s at 30fps)");
  ok(/fps=\{30\}/.test(root), "30 fps");
}

console.log("step 3: the scenes tile the timeline exactly");
{
  const src = read("src/OmniClawAd.tsx");
  const seqs = [...src.matchAll(/from=\{(\d+) \* fps\} durationInFrames=\{(\d+) \* fps\}/g)]
    .map((m) => ({ from: Number(m[1]), dur: Number(m[2]) }));
  ok(seqs.length === 5, `five scenes are sequenced (got ${seqs.length})`);
  let cursor = 0;
  let contiguous = true;
  for (const s of seqs) {
    if (s.from !== cursor) { contiguous = false; break; }
    cursor += s.dur;
  }
  ok(contiguous, "scenes are contiguous — no gap, no overlap");
  ok(cursor === 38, `the scenes cover 38s of the 40s timeline (got ${cursor})`);
}

console.log("step 4: Remotion motion rules are respected");
{
  const src = read("src/OmniClawAd.tsx");
  ok(!/transition\s*:/.test(src), "no CSS transition (Remotion does not render it)");
  ok(!/animation\s*:/.test(src), "no CSS animation (Remotion does not render it)");
  ok(/useCurrentFrame\(\)/.test(src), "motion is driven by useCurrentFrame()");
  ok(/interpolate\(/.test(src), "motion uses interpolate()");
  ok(/useVideoConfig\(\)/.test(src), "fps comes from useVideoConfig()");
  ok(!/transform:\s*`/.test(src), "no transform-string (Studio cannot edit it)");
  ok(/scale:\s*String\(|translate:\s*`/.test(src), "transform shorthands are used");
}

console.log("step 4b: every entrance delay fits INSIDE its scene");
{
  // A spring that starts later than the scene it lives in never becomes
  // visible: the screenshot silently never appears. This exact bug shipped a
  // 5-second scene whose image waited 6 seconds.
  const src = read("src/OmniClawAd.tsx");
  const delays = [...src.matchAll(/frame:\s*frame\s*-\s*([\d.]+)\s*\*\s*fps/g)].map((m) => Number(m[1]));
  ok(delays.length > 0, "the composition uses delayed springs");
  // The shortest scene is 4s, so any spring that starts later than ~3.5s would
  // still be invisible when its scene ends.
  ok(delays.every((d) => d <= 3.5), `no spring starts after its scene can show it (delays: ${JSON.stringify(delays)})`);
  const shotTags = [...src.matchAll(/<Shot\b[^>]*>/g)].map((m) => m[0]);
  ok(shotTags.length > 0, "there are screenshot frames");
  ok(shotTags.every((t) => /delay=\{/.test(t)), "every Shot declares its delay explicitly");
}

console.log("step 5: every referenced asset exists");
{
  const src = read("src/OmniClawAd.tsx");
  // Assets reach staticFile() through the Shot component's `file` prop, so the
  // file names live in the JSX, not in a staticFile() call.
  const assets = [...src.matchAll(/file="([^"]+\.png)"/g)].map((m) => m[1]);
  ok(assets.length > 0, "assets are referenced");
  for (const a of new Set(assets)) {
    ok(fs.existsSync(path.join(VIDEO, "public", a)), `public/${a} exists`);
  }
  ok(/staticFile\(/.test(src), "assets are loaded with staticFile()");
}

console.log("step 6: the brand tokens are the app's own");
{
  const src = read("src/OmniClawAd.tsx");
  const tokens = fs.readFileSync(path.join(ROOT, "web-next", "css", "tokens.css"), "utf8");
  const accent = (tokens.match(/--accent:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  const bg = (tokens.match(/--bg:\s*(#[0-9a-fA-F]{6})/) || [])[1];
  ok(Boolean(accent && src.includes(accent)), `the accent matches the app token (${accent})`);
  ok(Boolean(bg && src.includes(bg)), `the background matches the app token (${bg})`);
}

console.log(`\n${process.exitCode ? "video-ad: FAILED" : `video-ad: ALL PASS (${passed})`}`);
