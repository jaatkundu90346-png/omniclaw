// Regression smoke for the 2026-07-02 live-failure batch (the "Fleet.jsx run"):
// 1. scanCodeBalance flags the truncated/corrupted JSX write (vite-500 case)
// 2. length-cut guard: finish_reason "length" blocks write-style tool calls
// 3. "Did you mean?" anchors on the longest find line (fired nothing for "};")
// 4. session work brief resumes from THIS session's earlier runs
// 5. duplicate dev-server command returns the existing process
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop, scanCodeBalance, formatToolResultForModel } from "../src/core/omni-loop.js";
import { fuzzyFindAndReplace, findClosestSnippet } from "../src/core/fuzzy-edit.js";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };

// ── 1. corrupted JSX detection (the exact Fleet.jsx failure shape) ─────────
{
  const truncated = `import React from "react";
const Fleet = () => {
  return (
    <div className="grid">
      <StatCard label="Range" value={aircraft.range} icon="🌍`;
  const bad = scanCodeBalance(truncated);
  assert.equal(bad.ok, false, "truncated JSX flagged");
  assert.ok(bad.problems.some((p) => /unbalanced|unterminated/.test(p)), "names the specific problem");

  const healthy = `import React from "react";
// braces in comments { should not count (
const s = "a string with { and (";
const t = \`template with } \${1 + 1}\`;
const Fleet = () => {
  return (<div className="grid">{[1, 2].map((n) => <b key={n}>{n}</b>)}</div>);
};
export default Fleet;
`;
  const good = scanCodeBalance(healthy);
  assert.equal(good.ok, true, `healthy JSX passes (got: ${good.problems.join(", ")})`);
  ok("scanCodeBalance catches truncation, passes healthy JSX");
}

// ── 2. maybeAutoCheck flags a corrupted .jsx write ──────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-fleet-"));
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = { rootDir: tmp };
  loop.getSettings = () => ({ autoVerifyEdits: true });
  fs.writeFileSync(path.join(tmp, "Fleet.jsx"), 'const x = () => {\n  return (<div icon="cut');
  const output = { path: "Fleet.jsx" };
  await loop.maybeAutoCheck({ tool: "write_file", input: { path: "Fleet.jsx" } }, output);
  assert.ok(output.autoCheck, "autoCheck ran for .jsx");
  assert.equal(output.autoCheck.ok, false, "corrupted jsx write flagged");
  assert.ok(/CORRUPTED|TRUNCATED/i.test(output.autoCheck.message), "message says corrupted/truncated");
  fs.rmSync(tmp, { recursive: true, force: true });
  ok("corrupted .jsx write gets an immediate autoCheck alarm");
}

// ── 3. length-cut guard blocks write calls ──────────────────────────────────
{
  const runtime = {
    config: { getConfig: () => ({ provider: {}, runtime: { omniLoop: { maxRounds: 3, providerRetries: 0, streaming: false, historyMessages: 0 } } }) },
    gateway: { addEvent: () => {}, emitTransient: () => {}, listRuns: () => [] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true, model: "stub" }),
      completeWithTools: (() => {
        let call = 0;
        return async () => {
          call += 1;
          if (call === 1) {
            // Simulates the Fleet.jsx disaster: a huge write cut off by max tokens.
            return {
              text: "",
              finishReason: "length",
              toolCalls: [{ id: "c1", tool: "write_file", input: { path: "Fleet.jsx", content: "const x = () => {" } }],
            };
          }
          return { text: "done without the corrupted write", toolCalls: [] };
        };
      })(),
      complete: async () => ({ text: "" }),
    },
    tools: { run: async () => { throw new Error("tool must NOT run on a length-cut round"); } },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "rewrite Fleet.jsx",
    agent: { id: "main" }, profile: {}, session: { id: "s1" }, run: { id: "r1" },
    tools: [{ id: "write_file", description: "w", schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } }],
    contextBundle: {},
  });
  assert.equal(report.lengthCutBlocks, 1, "length-cut round blocked once");
  assert.equal(report.toolCallCount, 0, "no tool executed with truncated args");
  assert.ok(report.finalReady, "run still finishes cleanly");
  ok("length-cut guard: truncated write never executes");
}

// ── 4. Did-you-mean anchors on the longest line ─────────────────────────────
{
  const content = `import React from "react";
const Fleet = () => <div/>;
export default Fleet
`;
  // The find that failed in the live run: generic "};" first line + wrong tail.
  const res = fuzzyFindAndReplace(content, "};\nexport default Fleet;", "};\nexport default Fleet;\n// x", false);
  assert.ok(res.error, "edit still misses (content genuinely differs)");
  const snippet = findClosestSnippet("};\nexport default Fleet;", content);
  assert.ok(snippet.includes("export default Fleet"), "snippet now shows the real neighborhood");
  ok("Did-you-mean fires for generic-first-line finds");
}

// ── 5. session work brief from gateway runs ────────────────────────────────
{
  const loop = Object.create(OmniLoop.prototype);
  loop.runtime = {
    gateway: {
      listRuns: () => [
        { id: "r9", sessionId: "sX", toolOutputs: [{ tool: "write_file", input: { path: "site/index.html" }, output: { path: "site/index.html" } }] },
        { id: "r8", sessionId: "sX", toolOutputs: [{ tool: "exec", input: { command: "npm run dev" }, output: { command: "npm run dev", status: "started" } }] },
        { id: "r7", sessionId: "OTHER", toolOutputs: [{ tool: "write_file", input: { path: "other.txt" }, output: {} }] },
      ],
    },
  };
  const section = loop.buildSessionWorkSection({ id: "sX" }, { id: "rNow" });
  assert.ok(section.includes("Earlier Work"), "section rendered");
  assert.ok(section.includes("site/index.html"), "prior file present");
  assert.ok(!section.includes("other.txt"), "other sessions excluded");
  ok("session work brief resumes from this session's runs");
}

// ── 6. length-cut escalation: 3 strikes → honest stop, zero corrupted writes ─
{
  const runtime = {
    config: { getConfig: () => ({ provider: {}, runtime: { omniLoop: { maxRounds: 10, providerRetries: 0, streaming: false, historyMessages: 0 } } }) },
    gateway: { addEvent: () => {}, emitTransient: () => {}, listRuns: () => [] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true, model: "stub" }),
      // ALWAYS returns a length-cut giant write — simulates a model whose file
      // simply doesn't fit in its output budget.
      completeWithTools: async () => ({
        text: "",
        finishReason: "length",
        toolCalls: [{ id: "c", tool: "write_file", input: { path: "big.jsx", content: "const x = {" } }],
      }),
      complete: async () => ({ text: "" }),
    },
    tools: { run: async () => { throw new Error("corrupted write must NEVER execute"); } },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { report } = await loop.run({
    message: "banao badi file",
    agent: { id: "main" }, profile: {}, session: { id: "s2" }, run: { id: "r2" },
    tools: [{ id: "write_file", description: "w", schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } }],
    contextBundle: {},
  });
  assert.equal(report.stoppedReason, "length-cut-exhausted", `honest stop after 3 strikes (got ${report.stoppedReason})`);
  assert.equal(report.toolCallCount, 0, "zero corrupted writes executed");
  assert.ok(report.finalReady && /token/i.test(report.finalAnswer), "user gets an actionable Hinglish explanation");
  ok("length-cut escalation stops honestly after 3 strikes");
}

// ── 7. didYouMean surfaces under the verdict (survives truncation) ─────────
{
  const out = {
    error: true,
    edited: false,
    path: "Fleet.jsx",
    message: "Find text not found in file (tried exact + fuzzy matching).",
    didYouMean: "12\tconst Fleet = () => {\n13\t  return <div/>;",
  };
  const rendered = formatToolResultForModel(out, 400, "edit");
  assert.ok(rendered.includes("Did you mean"), "didYouMean pinned under verdict");
  assert.ok(rendered.indexOf("Did you mean") < 400, "visible before any truncation");
  ok("didYouMean hint survives result truncation");
}

// ── 8. re-read allowed after edit; spinning re-read still blocked ───────────
{
  const script = [
    // r1: read a.txt (ok), r2: read a.txt again (ok — budget 2)
    () => ({ text: "", toolCalls: [{ id: "c1", tool: "read_file", input: { path: "a.txt" } }] }),
    () => ({ text: "", toolCalls: [{ id: "c2", tool: "read_file", input: { path: "a.txt" } }] }),
    // r3: identical 3rd read of UNCHANGED file → must be blocked
    () => ({ text: "", toolCalls: [{ id: "c3", tool: "read_file", input: { path: "a.txt" } }] }),
    // r4: edit the file (bumps version)
    () => ({ text: "", toolCalls: [{ id: "c4", tool: "edit", input: { path: "a.txt", find: "x", replace: "y" } }] }),
    // r5: re-read after edit → must SUCCEED now
    () => ({ text: "", toolCalls: [{ id: "c5", tool: "read_file", input: { path: "a.txt" } }] }),
    () => ({ text: "ho gaya", toolCalls: [] }),
  ];
  let call = 0;
  const runtime = {
    config: { getConfig: () => ({ provider: {}, runtime: { agentLoop: { maxRepeatedToolCalls: 2 }, omniLoop: { maxRounds: 10, providerRetries: 0, streaming: false, historyMessages: 0 } } }) },
    gateway: { addEvent: () => {}, emitTransient: () => {}, listRuns: () => [] },
    sessions: { getSession: () => ({ transcript: [] }) },
    provider: {
      getInfo: () => ({ id: "stub", ready: true, model: "stub" }),
      completeWithTools: async () => script[Math.min(call++, script.length - 1)](),
      complete: async () => ({ text: "" }),
    },
    tools: {
      run: async (id, input) => (id === "read_file"
        ? { path: input.path, content: "1\tconst x = 1;", numberedContent: "1\tconst x = 1;", totalLines: 1 }
        : { path: input.path, edited: true }),
    },
  };
  const loop = new OmniLoop({ agentRuntime: runtime });
  const { toolOutputs } = await loop.run({
    message: "a.txt padho aur edit karo",
    agent: { id: "main" }, profile: {}, session: { id: "s3" }, run: { id: "r3" },
    tools: [
      { id: "read_file", description: "r", schema: { type: "object", properties: { path: { type: "string" } } } },
      { id: "edit", description: "e", schema: { type: "object", properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } } } },
    ],
    contextBundle: {},
  });
  const reads = toolOutputs.filter((t) => t.tool === "read_file");
  assert.equal(reads.length, 4, `4 read attempts recorded (got ${reads.length})`);
  assert.ok(!reads[0].output.blocked && !reads[1].output.blocked, "first two reads pass");
  assert.ok(reads[2].output.blocked, "3rd identical read of UNCHANGED file blocked");
  assert.ok(/already read this exact file/i.test(reads[2].output.reason || ""), "block message explains + forbids Get-Content fallback");
  assert.ok(!reads[3].output.blocked, "re-read AFTER edit is allowed (version bumped)");
  ok("repeat budget: post-edit re-read allowed, spinning still blocked");
}

console.log(`\nfleet-regression-smoke: ${passed} checks passed, 0 failed`);
