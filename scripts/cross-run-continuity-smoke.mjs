// Cross-run continuity smoke: after a model switch / new message in the SAME
// session, the resumed model's request must carry what tools already ran —
// not just the chat text. Guards the loadHistoryMessages tool-activity block.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "C:/Users/PATEL COMPUTERS/Documents/Codex/2026-04-22-hlo";
const { OmniLoop } = await import(pathToFileURL(path.join(ROOT, "src/core/omni-loop.js")).href);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -> " + String(detail).slice(0, 160)}`);
  if (!ok) failures += 1;
};

// Fake session transcript: one earlier run read a file and ran a command,
// then the user switched models and sent "continue".
const transcript = [
  { type: "message", role: "user", text: "NEXUS website banao" },
  {
    type: "message",
    role: "assistant",
    text: "Setup kar diya.",
    toolOutputs: [
      { tool: "read_file", input: { path: "index.html" }, outputStatus: { ok: true }, output: {} },
      { tool: "write_file", input: { path: "css/style.css" }, outputStatus: { ok: true }, output: {} },
      { tool: "exec", input: { command: "node --check js/main.js" }, outputStatus: { ok: true }, output: {} },
    ],
  },
  { type: "message", role: "user", text: "continue" }, // trailing = dropped by the loader (re-added by intake)
];

const runtime = {
  sessions: { getSession: () => ({ transcript }) },
  gateway: { addEvent() {}, emitTransient() {} },
  config: { getConfig: () => ({}) },
};
const loop = new OmniLoop({ agentRuntime: runtime });

const history = loop.loadHistoryMessages({ id: "s-cross" }, 24);
const blob = JSON.stringify(history);

check("history keeps the earlier user text", history.some((m) => m.role === "user" && /NEXUS/.test(m.content)));
check("history keeps the assistant text", history.some((m) => m.role === "assistant" && /Setup kar diya/.test(m.content)));
check("history INJECTS the earlier tool-activity block", /Earlier tool activity in THIS session/.test(blob), blob.slice(0, 200));
check("tool block lists the file that was READ (index.html)", /read_file index\.html/.test(blob), blob.match(/- \w+ [^\n]*/g)?.slice(0, 5)?.join(" | "));
check("tool block lists the file that was WRITTEN (css/style.css)", /write_file css\/style\.css/.test(blob));
check("tool block lists the command that RAN (node --check)", /node --check js\/main\.js/.test(blob));
check("trailing user message is NOT duplicated", history.filter((m) => m.role === "user" && m.content === "continue").length === 0);

// A fresh session (no tool outputs) must NOT get the block.
const emptyRuntime = { sessions: { getSession: () => ({ transcript: [{ type: "message", role: "user", text: "hi" }] }) }, gateway: runtime.gateway, config: runtime.config };
const loop2 = new OmniLoop({ agentRuntime: emptyRuntime });
const fresh = loop2.loadHistoryMessages({ id: "s-fresh" }, 24);
check("fresh session gets NO tool block (no noise)", !/Earlier tool activity/.test(JSON.stringify(fresh)));

console.log(failures === 0 ? "\ncross-run-continuity: ALL PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
