// Menu ADMISSION contract (2026-09-26 fix): an intent-matched toolset is a
// focus hint, not a licence to evict core. Measured live: a browser-style
// message matched browser+progress, all 53 members were pushed, the 30-cap
// evicted memory_search/memory_write/ask_user/web_search/web_fetch AND the
// whole browser set — a browser task with zero browser tools.
import {
  CORE_ORDER, TOOLSETS, buildMenu, toolsetsForIntent, MENU_MAX_TOOLS,
  BROWSER_CANONICAL_IDS, intentSlotsFor, INTENT_SET_SLOTS,
} from "../src/core/tool-layers.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

const allIds = new Set([...CORE_ORDER, ...Object.values(TOOLSETS).flatMap((s) => s.members)]);
const defs = [...allIds].map((id) => ({ id, description: `${id} does things`, schema: { type: "object", properties: {} } }));
const idsOf = (menu) => new Set(menu.defs.map((d) => d.id));
const PROTECTED = ["finish", "load_toolset", "list_toolsets", "exec", "read_file", "write_file", "edit", "multi_edit", "list_files", "search_text", "delegate_task", "update_plan"];
const CORE_TAIL = ["memory_search", "memory_write", "ask_user", "web_search", "web_fetch", "list_toolsets"];

console.log("step 1: a real browser-style message keeps core AND browser tools");
{
  const message = "browser me website kholo, click karo, screenshot lo aur verify karo";
  const active = toolsetsForIntent({ message, maxResults: 3 });
  assert(active.includes("browser"), `browser intent matched (${active.join(",")})`);
  const menu = buildMenu({ defs, activeToolsets: active, maxTools: MENU_MAX_TOOLS });
  const ids = idsOf(menu);
  assert(menu.size <= MENU_MAX_TOOLS, `menu within cap (${menu.size}/${MENU_MAX_TOOLS})`);
  for (const id of CORE_ORDER) assert(ids.has(id), `core tool kept: ${id}`);
  const canonicalMissing = BROWSER_CANONICAL_IDS.filter((id) => !ids.has(id));
  assert(canonicalMissing.length === 0, `browser canonical tools present (missing: ${canonicalMissing.join(",") || "none"})`);
  const droppedIds = (menu.dropped || []).map((d) => d.id);
  assert(!droppedIds.some((id) => CORE_ORDER.includes(id)), `no CORE tool in dropped log (${droppedIds.filter((id) => CORE_ORDER.includes(id)).join(",") || "none"})`);
}

console.log("step 2: every matched set gets a bounded slice, not the whole set");
{
  const menu = buildMenu({ defs, activeToolsets: ["browser", "progress"], maxTools: MENU_MAX_TOOLS });
  const ids = idsOf(menu);
  const browserIn = TOOLSETS.browser.members.filter((id) => ids.has(id));
  const progressIn = TOOLSETS.progress.members.filter((id) => ids.has(id));
  assert(browserIn.length <= Math.max(BROWSER_CANONICAL_IDS.length, INTENT_SET_SLOTS), `browser slice bounded (${browserIn.length})`);
  assert(progressIn.length <= INTENT_SET_SLOTS, `progress slice bounded (${progressIn.length})`);
  assert(progressIn.length >= 1, `progress slice not empty (${progressIn.length})`);
  assert(browserIn.length >= BROWSER_CANONICAL_IDS.length, `browser keeps its 8 canonical (${browserIn.length})`);
}

console.log("step 3: an explicitly loaded toolset is still fully honoured");
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"], priorityToolsets: ["browser"], maxTools: MENU_MAX_TOOLS });
  const ids = idsOf(menu);
  const missing = BROWSER_CANONICAL_IDS.filter((id) => !ids.has(id));
  assert(missing.length === 0, `explicit browser keeps canonical 8 (missing: ${missing.join(",") || "none"})`);
  for (const id of PROTECTED) assert(ids.has(id), `explicit set never evicts protected core: ${id}`);
}

console.log("step 4: floor — no matched set is starved when budget is tight");
{
  const menu = buildMenu({ defs, activeToolsets: ["browser", "progress", "project"], maxTools: 30 });
  const ids = idsOf(menu);
  const inSet = (set) => TOOLSETS[set].members.filter((id) => ids.has(id)).length;
  assert(inSet("progress") >= 1, `progress got a slice under a 3-set menu (${inSet("progress")})`);
  assert(inSet("project") >= 1, `project got a slice under a 3-set menu (${inSet("project")})`);
  assert(menu.size <= 30, `still within cap (${menu.size})`);
}

console.log("step 5: uncapped menu unchanged — a set still attaches in full");
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"] });
  const added = menu.defs.filter((d) => !CORE_ORDER.includes(d.id)).map((d) => d.id);
  assert(added.length === TOOLSETS.browser.members.length, `uncapped browser attach adds all ${TOOLSETS.browser.members.length} (got ${added.length})`);
  assert(intentSlotsFor("browser", 36) === BROWSER_CANONICAL_IDS.length, "browser intent slice = canonical 8");
  assert(intentSlotsFor("progress", 17) === INTENT_SET_SLOTS, `progress intent slice = ${INTENT_SET_SLOTS}`);
}

console.log("step 6: over-slice members are logged, not silently lost");
{
  const menu = buildMenu({ defs, activeToolsets: ["browser"], maxTools: MENU_MAX_TOOLS });
  const droppedIds = (menu.dropped || []).map((d) => d.id);
  assert(droppedIds.length > 0, `over-budget browser members logged (${droppedIds.length})`);
  assert((menu.dropped || []).every((d) => d.reason === "intent-set-over-budget" || /evicted|trimmed|hard-cap/.test(d.reason)), "drop reasons are explicit");
}

console.log(failures ? `\nmenu-admission: ${failures} FAILURES` : "\nmenu-admission: ALL PASS");
process.exit(failures ? 1 : 0);
