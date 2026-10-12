// Tool-surface audit for the RUNNING OmniClaw instance (live exe check).
// Read-only GETs only — R11 safe (no config mutation, no POST).
// Usage: node scripts/tool-surface-audit.mjs [port]   (default 3147)
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.argv[2] || 3147);
const BASE = `http://127.0.0.1:${PORT}`;
const WALL = setTimeout(() => { console.error("TIMEOUT at audit — exceeded 20s"); process.exit(2); }, 20000);

let passed = 0, failed = 0;
const ok = (cond, label) => { if (cond) { passed++; console.log(`  PASS ${label}`); } else { failed++; console.log(`  FAIL ${label}`); } };

async function getJson(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

console.log(`[audit] target ${BASE}`);
console.log("[audit] step 1: health");
const health = await getJson("/api/health").catch((e) => ({ error: e.message }));
ok(health && !health.error, `health reachable (${health.error || "ok"})`);
if (health.error) { clearTimeout(WALL); process.exit(1); }

console.log("[audit] step 2: flat tool list (/api/tools)");
const flat = await getJson("/api/tools").catch((e) => ({ error: e.message }));
const flatTools = Array.isArray(flat?.tools) ? flat.tools : (Array.isArray(flat) ? flat : []);
ok(flatTools.length > 0, `registered tools: ${flatTools.length}`);
const callable = flatTools.filter((t) => t.modelCallable);
ok(callable.length > 0, `model-callable tools: ${callable.length}`);

console.log("[audit] step 3: layered view (/api/tools?view=layers)");
const layers = await getJson("/api/tools?view=layers").catch((e) => ({ error: e.message }));
const core = layers?.core || [];
const toolsets = layers?.toolsets || {};
ok(core.length > 0, `CORE always-on tools: ${core.length}`);
console.log("  CORE:", core.map((t) => t.id || t).join(", "));
const setNames = Object.keys(toolsets);
ok(setNames.length > 0, `loadable toolsets: ${setNames.length}`);
for (const name of setNames) {
  const members = toolsets[name]?.tools || [];
  console.log(`  toolset ${name}: ${members.length} tools`);
}
const operator = layers?.operator || [];
console.log(`  operator-only (not model-callable): ${operator.length}`);

console.log("[audit] step 4: core completeness vs source contract");
const CORE_EXPECTED = ["exec", "read_file", "write_file", "edit", "list_files", "search_text", "web_search", "load_toolset", "list_toolsets"];
const coreIds = new Set(core.map((t) => t.id || t));
for (const id of CORE_EXPECTED) ok(coreIds.has(id), `core has ${id}`);
ok(setNames.includes("browser") && setNames.includes("computer") && setNames.includes("git"), "key toolsets present (browser/computer/git)");

console.log(`\n[audit] ${passed} passed, ${failed} failed`);
clearTimeout(WALL);
await delay(150); // let undici sockets close before exit (Windows UV_HANDLE_CLOSING)
process.exit(failed ? 1 : 0);
