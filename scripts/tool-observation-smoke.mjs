// Smoke test for the 2026-07-02 tool-observation batch:
// 1. read_file renders as PLAIN numbered text (not JSON) with continuation hint
// 2. search_text renders as plain grep-style lines
// 3. attachErrorContext pins the source snippet at a failing stack-trace line
// 4. vision: model detection, screenshot collection, image message building,
//    image stripping fallback, array-safe char estimation
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop, formatToolResultForModel } from "../src/core/omni-loop.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };

// ── 1. read_file plain rendering ───────────────────────────────────────────
{
  const numbered = Array.from({ length: 40 }, (_, i) => `${i + 1}\tconst line${i + 1} = ${i + 1};`).join("\n");
  const value = {
    path: "src/app.js",
    content: "raw content not needed",
    numberedContent: numbered,
    totalLines: 40,
    truncated: false,
  };
  const rendered = formatToolResultForModel(value, 30000, "read_file");
  assert.ok(rendered.startsWith("✅ read OK: src/app.js"), "read header present");
  assert.ok(rendered.includes("17\tconst line17 = 17;"), "numbered code visible as plain text");
  assert.ok(!rendered.includes('\\n'), "no JSON-escaped newlines");
  assert.ok(!rendered.includes('"numberedContent"'), "not a JSON blob");
  ok("read_file renders plain numbered code");

  // Truncation: budget smaller than content → line-boundary cut + offset hint
  const small = formatToolResultForModel(value, 400, "read_file");
  assert.ok(small.includes("Continue with read_file"), "continuation hint present");
  assert.ok(/"offset":\d+/.test(small), "hint carries a numeric offset");
  ok("read_file truncation gives exact continuation call");
}

// ── 2. search_text plain rendering ─────────────────────────────────────────
{
  const value = {
    ok: true,
    pattern: "TODO",
    path: ".",
    glob: "*.js",
    matchCount: 2,
    truncated: false,
    matches: [
      { file: "a.js", line: 3, text: "// TODO first" },
      { file: "b/c.js", line: 9, text: "// TODO second", before: ["ctx before"], after: ["ctx after"] },
    ],
  };
  const rendered = formatToolResultForModel(value, 5000, "search_text");
  assert.ok(rendered.includes("✅ search OK: 2 match(es)"), "search header");
  assert.ok(rendered.includes("a.js:3: // TODO first"), "grep-style line");
  assert.ok(rendered.includes("b/c.js:9: // TODO second"), "second match");
  assert.ok(rendered.includes("ctx before") && rendered.includes("ctx after"), "context lines included");
  ok("search_text renders grep-style plain text");
}

// ── 3. error-context snippet on failed exec ────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-obs-"));
  const file = path.join(tmp, "boom.js");
  fs.writeFileSync(file, ["line1();", "line2();", "throw new Error('kaboom');", "line4();", "line5();"].join("\n"));
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = { rootDir: tmp };
  loop.getSettings = () => ({ autoVerifyEdits: false });
  const output = {
    status: "failed",
    exitCode: 1,
    stderr: `${file}:3\nError: kaboom\n    at Object.<anonymous> (${file}:3:7)`,
    stdout: "",
  };
  loop.attachErrorContext({ tool: "exec", input: { command: "node boom.js" } }, output);
  assert.ok(output.errorContext, "errorContext attached");
  assert.ok(output.errorContext.includes("3 ->"), "failing line marked with arrow");
  assert.ok(output.errorContext.includes("kaboom"), "failing source visible");
  // And the verdict-formatter surfaces it near the top
  const rendered = formatToolResultForModel(output, 8000, "exec");
  const verdictPos = rendered.indexOf("❌ command FAILED");
  const snippetPos = rendered.indexOf("fix HERE");
  assert.ok(verdictPos !== -1 && snippetPos !== -1 && snippetPos < 900, "snippet surfaced right after verdict");
  ok("failed exec gets source snippet at the failing line");

  // success → no snippet
  const okOut = { status: "completed", exitCode: 0, stdout: "fine", stderr: "" };
  loop.attachErrorContext({ tool: "exec", input: {} }, okOut);
  assert.equal(okOut.errorContext, undefined, "no snippet on success");
  ok("no error snippet on successful commands");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 4. vision plumbing ─────────────────────────────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  // model detection honors config + known vision models
  loop.getSettings = () => ({ vision: "auto" });
  loop.runtime = { provider: { getInfo: () => ({ model: "qwen/qwen2.5-vl-72b-instruct" }) } };
  assert.equal(loop.modelSupportsVision(), true, "qwen-vl detected as vision");
  loop.runtime = { provider: { getInfo: () => ({ model: "minimaxai/minimax-m3" }) } };
  assert.equal(loop.modelSupportsVision(), false, "text-only model not vision");
  loop.getSettings = () => ({ vision: true });
  assert.equal(loop.modelSupportsVision(), true, "vision:true forces on");
  loop.getSettings = () => ({ vision: false });
  assert.equal(loop.modelSupportsVision(), false, "vision:false forces off");
  ok("vision model detection (auto/true/false)");

  // screenshot collection + image message
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-shot-"));
  const png = path.join(tmp, "shot.png");
  // 1x1 transparent PNG
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  loop.runtime = { rootDir: tmp, provider: { getInfo: () => ({ model: "gpt-4o" }) } };
  const shots = loop.collectScreenshots(
    [{ tool: "browser_screenshot", input: {} }],
    [{ screenshotPath: png, url: "file:///x.html" }],
  );
  assert.equal(shots.length, 1, "screenshot collected");
  const msg = loop.buildVisionMessage(shots);
  assert.equal(msg.role, "user", "vision message is a user message");
  assert.ok(Array.isArray(msg.content), "multimodal content array");
  assert.ok(msg.content.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,")), "base64 image part present");
  assert.ok(msg.content.some((p) => p.type === "text" && /LOOK at the image/.test(p.text)), "instruction text present");
  ok("screenshot becomes a multimodal image message");

  // stripping fallback flattens image messages to text
  const messages = [{ role: "system", content: "s" }, msg];
  const stripped = loop.stripImagesFromMessages(messages);
  assert.equal(stripped, 1, "one message stripped");
  assert.equal(typeof messages[1].content, "string", "content flattened to string");
  assert.ok(messages[1].content.includes("omitted"), "omission note present");
  ok("image-strip fallback flattens to text");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ntool-observation-smoke: ${passed}/8 checks passed`);
