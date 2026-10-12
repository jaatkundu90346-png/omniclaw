// T2.2 menu contract: CORE exactness, toolset attach, allowlist, aliases/
// drops excluded, intent mapping, EOPERATOR constant. Pure layer module.
// Codex-grade: CORE small, cap 30, explicit toolsets never truncated (B1/B2/B3).
import { CORE_ORDER, TOOLSETS, ALIAS_IDS, OPERATOR_IDS, DROP_IDS, buildMenu, toolsetsForIntent, getToolLayer, EOPERATOR, BROWSER_CANONICAL_IDS, MENU_MAX_TOOLS } from "../src/core/tool-layers.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) {
    failures++;
    console.log(`FAIL: ${label}`);
    return;
  }
  console.log(`ok: ${label}`);
}

const defs = [
  ...CORE_ORDER.map((id) => ({ id, description: `${id} does things`, schema: { type: "object", properties: {} } })),
  ...TOOLSETS.browser.members.map((id) => ({ id, description: `${id} browser`, schema: { type: "object", properties: {} } })),
  ...TOOLSETS.git.members.map((id) => ({ id, description: `${id} git`, schema: { type: "object", properties: {} } })),
  ...TOOLSETS.progress.members.map((id) => ({ id, description: `${id} progress`, schema: { type: "object", properties: {} } })),
  { id: "read", description: "alias", schema: null },
  { id: "ha_list_entities", description: "placeholder", schema: null },
  { id: "update_runtime_settings", description: "operator", schema: null },
];

// Default menu = CORE exactly (aliases/drops/operator never enter).
{
  const menu = buildMenu({ defs, activeToolsets: [] });
  assert(menu.size === CORE_ORDER.length, `default menu is CORE exactly (got ${menu.size}, want ${CORE_ORDER.length})`);
  assert(menu.defs[0].id === CORE_ORDER[0] && menu.defs[menu.defs.length - 1].id === CORE_ORDER[CORE_ORDER.length - 1], `CORE order stable (got ${menu.defs[0]?.id}..${menu.defs[menu.defs.length - 1]?.id})`);
  assert(CORE_ORDER.length <= 18, `CORE stays Codex-sized (got ${CORE_ORDER.length}; list_toolsets is core so discovery is free — one ~300-char schema vs a wasted full-context round)`);
  assert(MENU_MAX_TOOLS === 30, `cap is 30 (got ${MENU_MAX_TOOLS})`);
  assert(!menu.defs.some((d) => ["read", "ha_list_entities", "update_runtime_settings"].includes(d.id)), "alias/drop/operator excluded");
  assert(menu.tokens > 0 && Number.isFinite(menu.tokens), `token estimate logged (${menu.tokens})`);
}
// Enabling browser adds exactly that set.
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"] });
  const added = menu.defs.filter((d) => !CORE_ORDER.includes(d.id)).map((d) => d.id);
  assert(added.length === TOOLSETS.browser.members.length && added.every((id) => TOOLSETS.browser.members.includes(id)), `browser attach adds exactly its set (got ${added.length})`);
}
// B3: load_toolset("browser") -> full canonical set present in the very next menu.
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"], priorityToolsets: ["browser"], maxTools: MENU_MAX_TOOLS });
  const ids = new Set(menu.defs.map((d) => d.id));
  const missing = BROWSER_CANONICAL_IDS.filter((id) => !ids.has(id));
  assert(missing.length === 0, `B3: canonical browser set present after load_toolset (missing: ${missing.join(",") || "none"})`);
}
// B1/B2: core ~16 + cap 30 leaves ~14 real slots; explicit toolset never truncated.
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"], priorityToolsets: ["browser"], maxTools: 20 });
  const ids = new Set(menu.defs.map((d) => d.id));
  const missing = BROWSER_CANONICAL_IDS.filter((id) => !ids.has(id));
  assert(missing.length === 0, `B2: priority browser survives a tight cap (missing: ${missing.join(",") || "none"})`);
  assert(Array.isArray(menu.dropped), "B2: dropped-tools log present");
}
// Agent allowlist intersects (ops 84-style), never widens.
// (browser_open: first member of the browser set — the fixture defs only
// include the set's first four members, which are usage-ordered.)
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"], allowlist: ["read_file", "exec", "browser_open"] });
  assert(menu.size === 3, `allowlist intersects (got ${menu.size})`);
  const open = buildMenu({ defs, activeToolsets: [] });
  assert(open.size === CORE_ORDER.length, "empty allowlist means no restriction");
}
// Intent mapping.
{
  assert(toolsetsForIntent({ message: "youtube kholo" }).includes("browser"), "youtube → browser");
  assert(toolsetsForIntent({ message: "commit my changes" }).includes("git-write"), "commit → git-write");
  assert(toolsetsForIntent({ message: "model badal ke nvidia karo" }).includes("self"), "model switch → self");
  assert(toolsetsForIntent({ message: "hello world" }).length === 0, "plain greeting attaches nothing");
}
// Layer lookup sanity + EOPERATOR text.
{
  assert(getToolLayer("exec") === "core", "exec is core");
  assert(getToolLayer("browser_open") === "toolset:browser", "browser_open in browser set");
  assert(getToolLayer("read") === "alias", "read is alias");
  assert(getToolLayer("update_runtime_settings") === "operator", "settings writer is operator");
  assert(getToolLayer("kanban_show") === "drop", "kanban is drop");
  assert(/operator action/.test(EOPERATOR), "EOPERATOR message directs to Settings");
}
// No orphans: every CORE id resolves in the layer map.
{
  const orphans = CORE_ORDER.filter((id) => getToolLayer(id) !== "core");
  assert(orphans.length === 0, `no CORE orphans (got ${orphans.join(",") || "none"})`);
}

// REGRESSION (2026-09-23 live failure): a long website brief intent-matched
// 8 toolsets; the 30-cap evicted write_file/edit/multi_edit/list_files/
// search_text and the model concluded it had no write tools (planned shell
// Set-Content hacks). Write/observe essentials must survive a full-house menu.
{
  const allIds = new Set([...CORE_ORDER, ...Object.values(TOOLSETS).flatMap((s) => s.members)]);
  const allDefs = [...allIds].map((id) => ({ id, description: `${id} does things`, schema: { type: "object", properties: {} } }));
  const everySet = Object.keys(TOOLSETS);
  const menu = buildMenu({ defs: allDefs, activeToolsets: everySet, maxTools: MENU_MAX_TOOLS });
  const ids = new Set(menu.defs.map((d) => d.id));
  for (const essential of ["write_file", "edit", "multi_edit", "list_files", "search_text", "exec", "read_file", "update_plan", "finish", "load_toolset"]) {
    assert(ids.has(essential), `full-house menu (${everySet.length} sets, cap ${MENU_MAX_TOOLS}) keeps ${essential}`);
  }
  const droppedIds = (menu.dropped || []).map((d) => d.id);
  assert(!droppedIds.some((id) => ["write_file", "edit", "list_files", "search_text"].includes(id)), "write essentials never in dropped log");
}
// Intent cap: callers can keep only the top-scoring sets so mega-briefs do
// not activate every toolset. Default (no cap) stays unchanged.
{
  const mega = "Build a premium production-quality 3D animated interactive website for a futuristic robotics company, test all interactions in the browser, git commit karo, files aur folders handle karo";
  const all = toolsetsForIntent({ message: mega });
  const top3 = toolsetsForIntent({ message: mega, maxResults: 3 });
  assert(all.length > 3, `mega-brief matches many sets uncapped (got ${all.length})`);
  assert(top3.length === 3 && all.slice(0, 3).join(",") === top3.join(","), `maxResults keeps the top 3 in score order (got ${top3.join(",")})`);
  assert(toolsetsForIntent({ message: "youtube kholo", maxResults: 3 }).includes("browser"), "cap does not break single-match intents");
}

console.log(failures ? `\ntool-menu: ${failures} FAILURES` : "\ntool-menu: ALL PASS");
process.exit(failures ? 1 : 0);
