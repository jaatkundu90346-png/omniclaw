// EMPIRICAL PROOF: does OmniLoop carry prior tool calls + results into the
// NEXT provider request (the "model bhool jata hai" question)?
//
// We give OmniLoop a recording provider. Turn 1 returns a tool call, turn 2
// must RECEIVE that call (assistant.tool_calls) AND its result (role:"tool").
// If either is missing from the captured messages, context is genuinely lost.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { OmniLoop } = await import(pathToFileURL(path.join(ROOT, "src/core/omni-loop.js")).href);

const captured = [];
let callN = 0;
const recorder = {
  getInfo: () => ({ id: "recorder", model: "test-model", ready: true }),
  completeWithTools: async (messages) => {
    callN += 1;
    captured.push(JSON.parse(JSON.stringify(messages)));
    if (callN === 1) {
      return {
        text: "Reading the file first.",
        toolCalls: [{ id: "tc1", tool: "read_file", input: { path: "server.js" } }],
      };
    }
    return { text: "Now I know server.js exists with 3000 lines.", toolCalls: [] };
  },
};

const runtime = {
  provider: recorder,
  gateway: { addEvent() {}, emitTransient() {} },
  sessions: { getSession: () => ({ transcript: [] }), updateSession() {} },
  config: { getConfig: () => ({ runtime: { omniLoop: { maxRounds: 4, enforceToolUse: false, vision: false, streaming: false, autoPlanSeed: false } }, provider: { model: "test-model" } }) },
  files: { rootDir: ROOT },
  tools: {
    getAll: () => [{ id: "read_file", description: "read", modelCallable: true, schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    run: async (tool, input) => ({ path: input.path, content: "// server.js content — 3000 lines", totalLines: 3000 }),
    getRunPlan: () => null, getSessionPlan: () => null,
  },
  workspace: { workspaceDir: ROOT },
};

const loop = new OmniLoop({ agentRuntime: runtime });
const res = await loop.run({
  message: "read server.js then tell me how many lines",
  intents: ["file-read"],
  agent: { id: "main" },
  profile: { allowToolExecution: true },
  session: { id: "ctx-trace" },
  run: { id: "run-ctx-trace" },
  tools: runtime.tools.getAll(),
  contextBundle: {},
});

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -> " + String(detail).slice(0, 160)}`);
  if (!ok) failures += 1;
};

check("provider was called at least twice (tool turn + answer turn)", captured.length >= 2, `calls=${captured.length}`);

const round2 = captured[1] || [];
const assistantWithToolCall = round2.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
const toolResultMsg = round2.find((m) => m.role === "tool" && m.tool_call_id === "tc1");

check("round 2 request CARRIES the prior assistant tool_call (read_file server.js)",
  Boolean(assistantWithToolCall && assistantWithToolCall.tool_calls[0]?.function?.name === "read_file"),
  JSON.stringify(round2.map((m) => m.role)));

check("round 2 request CARRIES the tool RESULT (role:tool with the file content)",
  Boolean(toolResultMsg && /server.js content/.test(String(toolResultMsg.content || ""))),
  toolResultMsg ? String(toolResultMsg.content).slice(0, 80) : "(no role:tool message found)");

check("tool result contains the actual content the model would need",
  Boolean(toolResultMsg && /3000 lines/.test(String(toolResultMsg.content || ""))));

console.log(`\nfinal answer: ${String(res?.report?.finalAnswer || res?.finalAnswer || "").slice(0, 120)}`);
console.log(failures === 0 ? "\nCONTEXT-CARRY: PROVEN — tool calls + results ride into every next request" : `\n${failures} CHECK(S) FAILED — context genuinely dropped`);
process.exit(failures === 0 ? 0 : 1);
