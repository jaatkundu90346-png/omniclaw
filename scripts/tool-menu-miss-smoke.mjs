// tool-menu-miss-smoke — the capped tool menu must not act as a permission gate.
//
// 2026-07-31: the user asked the agent to connect Telegram. `configure_telegram`
// was installed, allowlisted and permitted — but omni-loop caps each run's menu
// at `maxTools` (64), the tool lost the race for a slot, and the call came back
// "Tool configure_telegram is not available. Choose one of the provided function
// tools." The agent concluded the tool was blocked and started building a custom
// connector instead. A truncated menu is a focus aid; it must never make a real
// tool unreachable.
//
//   node scripts/tool-menu-miss-smoke.mjs

import { OmniLoop, TYPE_TOOL_BOOSTS } from "../src/core/omni-loop.js";
import { classifyTask } from "../src/core/task-playbooks.js";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const loop = new OmniLoop({ runtime: {} });

// A registry big enough that a small cap truncates it, with the interesting
// tool deliberately near the end.
const allTools = [
  ...Array.from({ length: 40 }, (_, i) => ({ id: `filler_tool_${i}`, description: `filler ${i}` })),
  { id: "configure_telegram", description: "Connect Telegram.", schema: { type: "object", properties: { botToken: { type: "string" } } } },
  { id: "telegram_status", description: "Telegram health." },
];

// ── The cap really does hide it ──────────────────────────────────────────────
const schemas = loop.buildToolSchemas(allTools, 5);
const allowedToolIds = new Set(schemas.map((s) => s.function.name));
const toolParamSchemas = new Map(schemas.map((s) => [s.function.name, s.function.parameters || {}]));
check("capped menu truncates the registry", schemas.length === 5, `${schemas.length} schemas`);
check("real tool is hidden by the cap", !allowedToolIds.has("configure_telegram"));

// ── ...and admission undoes exactly that ─────────────────────────────────────
const admitted = loop.admitMenuMissTool("configure_telegram", { allowedToolIds, allTools, toolSchemas: schemas, toolParamSchemas });
check("hidden but real tool is admitted", admitted === true);
check("admitted tool becomes callable", allowedToolIds.has("configure_telegram"));
check("admitted tool is advertised next round", schemas.some((s) => s.function.name === "configure_telegram"));
check(
  "admitted tool keeps its parameter schema",
  toolParamSchemas.get("configure_telegram")?.properties?.botToken?.type === "string",
  JSON.stringify(toolParamSchemas.get("configure_telegram")),
);

// ── Admission must NOT widen the permitted surface ───────────────────────────
check("unknown tool is refused", loop.admitMenuMissTool("definitely_not_a_tool", { allowedToolIds, allTools, toolSchemas: schemas, toolParamSchemas }) === false);
check("unknown tool stays uncallable", !allowedToolIds.has("definitely_not_a_tool"));
check("empty id is refused", loop.admitMenuMissTool("", { allowedToolIds, allTools, toolSchemas: schemas, toolParamSchemas }) === false);
check("missing registry is refused", loop.admitMenuMissTool("configure_telegram", { allowedToolIds: new Set() }) === false);
check("already-listed tool is a no-op success", loop.admitMenuMissTool("configure_telegram", { allowedToolIds, allTools, toolSchemas: schemas, toolParamSchemas }) === true);

// ── Belt and braces: the boost should have put it there in the first place ───
check("messaging task type exists", Array.isArray(TYPE_TOOL_BOOSTS.messaging));
check("messaging boost carries the telegram tools", ["configure_telegram", "telegram_status", "telegram_send"].every((id) => TYPE_TOOL_BOOSTS.messaging.includes(id)));
check("connect intent classifies as messaging", classifyTask("telegram bot connect karo") === "messaging");
check("a telegram BUG report still goes to debugging", classifyTask("telegram bot ka bug fix karo") === "debugging");

const boosted = loop.buildToolSchemas(allTools, 5, TYPE_TOOL_BOOSTS.messaging);
check("boost puts the tool in the menu from round 1", boosted.some((s) => s.function.name === "configure_telegram"));

console.log(failures === 0 ? "\ntool-menu-miss-smoke: all checks passed" : `\ntool-menu-miss-smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
