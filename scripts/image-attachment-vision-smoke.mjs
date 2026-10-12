// Image attachment: prove the model sees the image ITSELF when it has vision,
// and falls back to the describe_image TOOL only when it does not.
//
// THE BUG BEHIND THIS: a user attached an image and got
//   describe_image  x
//   describe_image  x
//   describe_image  x
//   Failed/blocked: describe_image
// The model could not see the image natively, so it called the tool — and the
// tool had no configured vision backend, so it failed. Three times.
//
// THE CONTRACT:
//   vision model -> messages carry an ARRAY content part with image_url; the
//                   tool is never needed.
//   blind model  -> content stays a plain STRING (the "[Attached by user ...]"
//                   note), so the model reaches for describe_image as before.
//
// R14: markers before every step, hard wall clock, cleanup in finally.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

let step = "startup";
const timer = setTimeout(() => { console.error(`TIMEOUT at step: ${step}`); process.exit(2); }, 60000);

const { OmniLoop } = await import("../src/core/omni-loop.js");
const { resolveVisionSupport, modelLooksVisionCapable, guessImageMime } =
  await import("../src/core/vision-capability.js");

// A real 1x1 PNG so the file is genuinely readable as an image.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// The fake "project root" the loop resolves attachment paths against.
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-vision-"));
// The actual repo, for the source-level wiring assertions below.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  step = "write a real image into the uploads folder";
  const relPath = "uploads/test-shot.png";
  const abs = path.join(rootDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, PNG_1PX);
  console.log(`ok: wrote ${relPath} (${PNG_1PX.length} bytes)`);

  step = "build a loop with a stub runtime";
  const loop = new OmniLoop({
    agentRuntime: {
      rootDir,
      provider: { getInfo: () => ({ model: "test-model" }) },
      tools: { getAll: () => [], run: async () => ({}) },
      gateway: { onEvent: () => {}, addEvent: () => {} },
      config: { getConfig: () => ({ runtime: { omniLoop: {} } }) },
    },
  });
  assert.ok(loop, "loop constructed");

  step = "VISION model -> native image part";
  const att = [{ relPath, name: "test-shot.png", isImage: true }];
  const seen = loop.buildUserMessage({ text: "ya image dekh", attachments: att, canSee: true });
  assert.ok(Array.isArray(seen.content),
    `a vision model must get array content, got ${typeof seen.content}`);
  assert.equal(seen.content[0].type, "text");
  assert.equal(seen.content[0].text, "ya image dekh");
  const img = seen.content.find((p) => p.type === "image_url");
  assert.ok(img, "no image_url part was attached");
  assert.match(img.image_url.url, /^data:image\/png;base64,/,
    `image part is not a PNG data URL: ${String(img.image_url.url).slice(0, 40)}`);
  assert.equal(img.image_url.url.split(",")[1], PNG_1PX.toString("base64"),
    "the attached bytes do not match the file on disk");
  console.log(`ok: array content with 1 image_url part (${seen.content.length} parts)`);

  step = "BLIND model -> plain string (tool path)";
  const blind = loop.buildUserMessage({ text: "ya image dekh", attachments: att, canSee: false });
  assert.equal(typeof blind.content, "string",
    "a blind model must keep string content so describe_image is used");
  assert.equal(blind.content, "ya image dekh");
  assert.ok(!JSON.stringify(blind).includes("base64"),
    "a blind model must not receive image bytes");
  console.log("ok: string content, no image bytes");

  step = "no attachments -> string content even for a vision model";
  const none = loop.buildUserMessage({ text: "hello", attachments: [], canSee: true });
  assert.equal(typeof none.content, "string");
  console.log("ok: string content when nothing is attached");

  step = "non-image attachments are never attached natively";
  const mixed = loop.buildUserMessage({
    text: "check this",
    attachments: [{ relPath: "uploads/notes.pdf" }, { relPath }],
    canSee: true,
  });
  assert.ok(Array.isArray(mixed.content));
  assert.equal(mixed.content.filter((p) => p.type === "image_url").length, 1,
    "only the image should have been attached");
  console.log("ok: pdf ignored, png attached");

  step = "path traversal and absolute paths are refused";
  for (const bad of [
    { relPath: "../../../Windows/win.ini" },
    { relPath: "C:/Windows/win.ini" },
    { relPath: "uploads/../../../secret.png" },
  ]) {
    const out = loop.buildUserMessage({ text: "x", attachments: [bad], canSee: true });
    const hasImage = Array.isArray(out.content) && out.content.some((p) => p.type === "image_url");
    assert.ok(!hasImage, `traversal path was attached: ${bad.relPath}`);
  }
  console.log("ok: traversal / absolute paths refused at the read step");

  step = "missing file degrades to text instead of throwing";
  const missing = loop.buildUserMessage({
    text: "x", attachments: [{ relPath: "uploads/nope.png" }], canSee: true,
  });
  assert.equal(typeof missing.content, "string");
  console.log("ok: unreadable file falls back to text");

  // The unit checks above call buildUserMessage DIRECTLY. That is the easy half:
  // it proves the branch logic, not that a real turn ever reaches it. The real
  // regression this whole feature is about was a helper that worked perfectly
  // and was never called, because the attachment never made it past the wire.
  // So assert the wiring exists, browser -> server -> agent -> loop.
  step = "attachments are threaded browser -> server -> agent -> loop";
  const wire = [
    ["web-next/js/ui/composer.js", /attachments/],
    ["web-next/js/sse.js", /body\.attachments\s*=\s*attachments/],
    ["web-next/js/ui/thread.js", /attachments:\s*Array\.isArray\(opts\.attachments\)/],
    ["server.js", /sanitizeAttachmentRefs\(body\.attachments\)/],
    ["src/core/agent.js", /attachments:\s*Array\.isArray\(options\.attachments\)/],
    ["src/core/omni-loop.js", /buildUserMessage\(\{/],
  ];
  for (const [file, re] of wire) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(src, re, `${file} does not carry attachments end-to-end`);
  }
  // And the loop must actually consult the model's vision, not just take a flag.
  const loopSrc = fs.readFileSync(path.join(root, "src/core/omni-loop.js"), "utf8");
  assert.match(loopSrc, /canSee:\s*this\.modelSupportsVision\(\)/,
    "the loop must ask the ACTIVE model whether it can see, not assume yes");
  assert.match(loopSrc, /resolveVisionSupport\(\{/,
    "the loop must use the shared capability table, not a private copy of the regex");
  // No duplicated regex left behind: two copies drift and disagree about eyes.
  const mediaSrc = fs.readFileSync(path.join(root, "src/core/media-engine.js"), "utf8");
  assert.ok(!/const VISION_MODEL_RE = \/gpt-4o/.test(mediaSrc),
    "media-engine.js still carries its own copy of the vision regex");
  console.log(`ok: ${wire.length} wire hops present, one shared capability table`);

  step = "capability table sanity";
  assert.ok(modelLooksVisionCapable("gpt-4o"), "gpt-4o should be vision-capable");
  assert.ok(modelLooksVisionCapable("anthropic/claude-sonnet-4"), "claude should be vision-capable");
  assert.ok(modelLooksVisionCapable("google/gemini-2.5-pro"), "gemini should be vision-capable");
  assert.ok(!modelLooksVisionCapable("apodex/apodex-1.1-mini:free"),
    "an unknown free mini model must NOT claim vision, or a blind model gets image parts and 400s");
  assert.equal(resolveVisionSupport({ configured: false, modelId: "gpt-4o" }), false,
    "an explicit false must override the regex");
  assert.equal(resolveVisionSupport({ configured: true, modelId: "whatever" }), true,
    "an explicit true must override the regex (proxy on a known model)");
  assert.equal(guessImageMime("a.JPEG"), "image/jpeg");
  assert.equal(guessImageMime("a.png"), "image/png");
  console.log("ok: capability table behaves");

  clearTimeout(timer);
  console.log("image-attachment-vision: ALL PASS");
  process.exit(0);
} catch (error) {
  console.error(`FAIL at step "${step}":`, error?.message);
  if (error?.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exit(1);
} finally {
  clearTimeout(timer);
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
}