// Context AUDIT — where does the model's context actually go?
// READ-ONLY. Never writes to data/, workspace/, or config. Safe to run live.
//
// Prints a ranked breakdown of every prompt section (Zone A / Zone B / menu /
// Zone C) AND the store-level stuffing (memory.json, manuals, skills) so
// "sab kuch ghussa hua hai" becomes measured numbers instead of a feeling.
//
// Usage: node scripts/context-audit.mjs [--json] [--message="user text"]
import fs from "node:fs";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";
import { buildOmniClawPromptSections } from "../src/core/system-prompt.js";
import { SkillRegistry } from "../src/core/skill-registry.js";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { buildMenu, MENU_MAX_TOOLS, toolsetsForIntent } from "../src/core/tool-layers.js";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");
const AGENT_DIR = path.join(ROOT, "workspace", "agents", "main");
const message = process.argv.find((a) => a.startsWith("--message="))?.slice(10)
  || "haan bhai same website banao aur verify karo";

const rows = [];
function record(tier, id, chars, extra = {}) { rows.push({ tier, id, chars, ...extra }); }
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const tok = (n) => Math.round(n / 4);

// ── 1. Store-level stuffing ──────────────────────────────────────────────
const store = { rows: [] };
const memoryJson = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "memory.json"), "utf8")); } catch { return null; }
})();
if (memoryJson) {
  for (const [k, v] of Object.entries(memoryJson)) {
    store.rows.push({ id: `data/memory.json :: ${k}`, chars: JSON.stringify(v).length, items: Array.isArray(v) ? v.length : 0 });
    if (k === "conversations" && Array.isArray(v)) {
      const toolChars = v.reduce((a, c) => a + JSON.stringify(c.toolOutputs || []).length, 0);
      store.rows.push({ id: "data/memory.json :: conversations.toolOutputs", chars: toolChars, items: v.length });
    }
  }
  store.rows.sort((a, b) => b.chars - a.chars);
}
const manuals = [];
for (const dir of [AGENT_DIR, ROOT]) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { continue; }
  for (const n of names) {
    if (!/\.md$/i.test(n)) continue;
    if (dir === ROOT && !/^(AGENTS|PROGRESS|DECISIONS|SPRINT|TASKS|ARCHITECTURE|CONVENTIONS|CONSTRAINTS|STARTUP)\.md$/i.test(n)) continue;
    try {
      const size = fs.statSync(path.join(dir, n)).size;
      manuals.push({ path: path.relative(ROOT, path.join(dir, n)).replace(/\\/g, "/"), size, scope: dir === ROOT ? "project" : "agent" });
    } catch { /* skip */ }
  }
}
manuals.sort((a, b) => b.size - a.size);
let memFiles = [];
try {
  memFiles = fs.readdirSync(path.join(AGENT_DIR, "memory")).map((n) => ({ name: n, size: fs.statSync(path.join(AGENT_DIR, "memory", n)).size }));
} catch { /* none */ }
memFiles.sort((a, b) => b.size - a.size);

// ── 2. Real skills + registry tools + menu ──────────────────────────────
let skillRegistry = null;
let skills = [];
let matchedSkills = [];
try {
  skillRegistry = new SkillRegistry({ rootDir: ROOT, agentName: "main" });
  skills = skillRegistry.listSkills("main");
  matchedSkills = skillRegistry.match(message, { agentId: "main" });
} catch { /* best effort */ }
let registryTools = [];
try {
  registryTools = new ToolRegistry({ pluginRegistry: { getToolDefinitions: () => [] } }).getAll({});
} catch { /* optional */ }
const activeToolsets = toolsetsForIntent({ message, maxResults: 3 });
const menu = buildMenu({
  defs: registryTools.map((t) => ({ id: t.id, description: t.description, schema: t.schema, group: t.group, runtimeStatus: t.runtimeStatus })),
  activeToolsets,
  maxTools: MENU_MAX_TOOLS,
});

// ── 3. Workspace bundle (same shape the loader produces) ─────────────────
const AGENT_FILES = ["AGENTS.md", "IDENTITY.md", "PERSONALITY.md", "SOUL.md", "USER.md", "PROFILE.md", "TOOLS.md",
  "AGENT_LOOP.md", "AGENT_WORKSPACE.md", "AGENT_RUNTIME.md", "HARNESS.md", "ACTIVE_MEMORY.md",
  "CHANNEL_DOCKING.md", "SUBAGENTS.md", "THINKING.md", "CLAWHUB.md", "TELEGRAM.md", "AUTOREVIEW.md", "HEARTBEAT.md"];
const PROJECT_FILES = ["AGENTS.md", "SPRINT.md", "PROGRESS.md", "DECISIONS.md", "feature_list.json", "arch_rules.json"];
const files = [];
const seen = new Set();
const pushFile = (name, scope, filePath) => {
  const abs = path.resolve(filePath);
  if (seen.has(abs) || !fs.existsSync(abs)) return;
  seen.add(abs);
  files.push({ name, scope, path: abs, content: fs.readFileSync(abs, "utf8") });
};
for (const n of AGENT_FILES) pushFile(n, "agent", path.join(AGENT_DIR, n));
for (const n of PROJECT_FILES) pushFile(n, "project", path.join(ROOT, n));

const MEM_MARK = "## Memory Index (one line per memory";
let memoryIndex = "";
try {
  const memMd = fs.readFileSync(path.join(AGENT_DIR, "MEMORY.md"), "utf8");
  const i = memMd.indexOf(MEM_MARK);
  if (i >= 0) {
    const after = memMd.slice(i);
    memoryIndex = after.slice(after.indexOf("\n")).trim();
  }
} catch { /* no index */ }
const longTerm = (memoryJson?.longTerm || []).slice(-60).map((m) => ({
  title: m.title, text: m.text, importance: m.importance, tags: m.tags || [],
}));
const readOnlyMemory = {
  getLongTermMemory: (limit = 60) => longTerm.slice(-limit),
  getNotes: () => (memoryJson?.notes || []),
  readMemoryIndex: () => memoryIndex.slice(0, 1600),
  getMemoryCapacityInfo: () => ({
    memories: (memoryJson?.longTerm || []).length,
    indexChars: memoryIndex.slice(0, 1600).length,
    indexLimit: 1600,
    percent: Math.min(100, Math.round((memoryIndex.length / 1600) * 100)),
  }),
};
const workspaceContext = {
  files,
  manifest: {
    selectedProject: ROOT,
    defaultWorkingDirectory: ROOT,
    agentWorkspace: AGENT_DIR,
    sharedWorkspace: path.join(ROOT, "workspace"),
    missingRequiredFiles: [],
  },
};
const contextBundle = {
  workspaceContext,
  skills: matchedSkills,
  tools: [],
  longTermMemory: longTerm,
  notes: memoryJson?.notes || [],
  recentConversations: (memoryJson?.conversations || []).slice(-12),
  research: (memoryJson?.research || []).slice(-6),
  artifacts: (memoryJson?.artifacts || []).slice(-6),
  tasks: [],
  harness: {},
  mcp: {},
  sessionSummary: null,
  activeMemory: null,
  bootstrapRitual: null,
  plan: null,
};
const runtime = {
  rootDir: ROOT,
  getWorkspaceRoot: () => ROOT,
  config: { getConfig: () => ({ provider: { model: "audit-model", contextTokens: 1048576 }, app: { creator: { name: "Mankush", location: "Haryana, India" } } }) },
  tools: { getRunPlan: () => null, getSessionPlan: () => null, getRunToolsets: () => [], getSessionToolsets: () => [] },
  gateway: { addEvent() {}, emitTransient() {} },
  sessions: {
    listSessions: () => [],
    getEvidenceLedger: () => ({
      turn: 4,
      files: { [path.join(ROOT, "package.json")]: { size: 6639, turn: 2, about: "package manifest", mtimeMs: 1 } },
      edits: [], commands: [{ cmd: "npm run build", exit: 0, turn: 3, result: "ok" }], findings: ["menuV2 on"],
    }),
  },
  memory: readOnlyMemory,
  provider: { getInfo: () => ({ model: "audit-model" }) },
  skills: { getAll: () => skills },
  files: { rootDir: ROOT },
};
const loop = new OmniLoop({ agentRuntime: runtime });


// ── 4. Section-by-section prompt measurement ─────────────────────────────
const baseSections = buildOmniClawPromptSections({
  agent: { id: "main", name: "Main" },
  profile: { id: "power" },
  contextBundle,
  loopContract: {},
  bootstrapRitual: null,
  creator: { name: "Mankush", location: "Haryana, India" },
  compactTooling: true,
  menuToolIds: menu.defs.map((d) => d.id),
  toolsetCatalog: loop.toolsetCatalog(),
});
for (const s of baseSections) record("A: base", s.id, s.content.length);

const safe = (fn, fallback = "") => { try { return String(fn() || ""); } catch { return fallback; } };
const memoryBrief = safe(() => loop.buildMemoryBriefSection(contextBundle, { message, agent: { id: "main" } }));
const codeMapSection = safe(() => loop.buildCodeMapSection(message));
const continuationSection = safe(() => loop.buildContinuationSection(message, ""));
const zoneB = [
  ["recent_sessions", safe(() => loop.buildRecentSessionsSection({ session: { id: "audit" }, agent: { id: "main" } }))],
  ["session_work", safe(() => loop.buildSessionWorkSection({ id: "audit" }, { id: "run-audit" }))],
  ["project_state", safe(() => loop.buildProjectStateSection({ id: "audit" }, { id: "run-audit" }))],
  ["continuation", continuationSection],
  ["debugging_protocol", safe(() => loop.buildDebuggingProtocolSection(message))],
  ["instincts", safe(() => loop.buildInstinctsSection(message))],
  ["playbooks", safe(() => loop.playbooks.buildSection(message))],
  ["memory_brief", memoryBrief],
  ["code_map", codeMapSection],
  ["evidence_ledger", safe(() => loop.buildEvidenceLedgerSection({ id: "audit" }))],
];
for (const [id, text] of zoneB) record("B: loop", id, String(text || "").length);

const built = loop.buildSystemPrompt({
  agent: { id: "main", name: "Main" },
  profile: { id: "power" },
  contextBundle,
  loopContract: {},
  session: { id: "audit-session", label: "audit" },
  message,
  run: { id: "audit-run" },
  memoryBriefOverride: memoryBrief,
  codeMapSection,
  continuationSection,
  menuToolIds: menu.defs.map((d) => d.id),
});
const zoneCSection = loop.buildZoneCSection({
  manifest: workspaceContext.manifest,
  loadedAt: new Date().toISOString(),
  session: { id: "audit-session" },
  run: { id: "audit-run" },
  agent: { id: "main" },
  settings: { contextCharBudget: 120000, contextTokens: 1048576 },
  providerModel: "audit-model",
});
const menuSchemasChars = menu.defs.reduce((a, d) => a + JSON.stringify({
  type: "function",
  function: { name: d.id, description: String(d.description || "").slice(0, 500), parameters: d.schema },
}).length, 0);
record("MENU", "tool_schemas (native function calling)", menuSchemasChars, { count: menu.defs.length });
record("C: volatile tail", "zone_c", zoneCSection.length);

// ── 5. Report ───────────────────────────────────────────────────────────
const totals = { zoneA: built.zoneA.length, zoneB: built.zoneB.length, menu: menuSchemasChars, zoneC: zoneCSection.length };
const grand = totals.zoneA + totals.zoneB + totals.menu + totals.zoneC;

if (JSON_OUT) {
  console.log(JSON.stringify({
    totals, rows, store: store.rows, manuals, memFiles,
    skills: skills.map((s) => ({ id: s.id, source: s.source })),
    matchedSkills: matchedSkills.map((s) => s.id),
    menu: { size: menu.size, dropped: menu.dropped },
    activeToolsets,
    registryToolCount: registryTools.length,
  }, null, 2));
  process.exit(0);
}

console.log("═══ CONTEXT AUDIT (read-only, real data) ═══\n");
console.log(`Total per-turn context: ${grand.toLocaleString()} chars ≈ ${tok(grand).toLocaleString()} tokens`);
console.log(`  Zone A (cached head) : ${String(totals.zoneA).padStart(7)} chars ≈ ${tok(totals.zoneA).toLocaleString()} tok`);
console.log(`  Zone B (memory/state): ${String(totals.zoneB).padStart(7)} chars ≈ ${tok(totals.zoneB).toLocaleString()} tok`);
console.log(`  Menu (tool schemas)  : ${String(totals.menu).padStart(7)} chars ≈ ${tok(totals.menu).toLocaleString()} tok  (${menu.size} tools, cap ${MENU_MAX_TOOLS})`);
console.log(`  Zone C (volatile)    : ${String(totals.zoneC).padStart(7)} chars ≈ ${tok(totals.zoneC).toLocaleString()} tok\n`);

console.log("── Prompt sections, biggest first ──");
for (const r of [...rows].sort((a, b) => b.chars - a.chars)) {
  if (r.chars === 0) continue;
  console.log(`  ${String(r.chars).padStart(6)}  ${kb(r.chars).padStart(8)}  ${r.tier.padEnd(17)} ${r.id}${r.count ? ` (${r.count})` : ""}`);
}
const empty = rows.filter((r) => r.chars === 0).map((r) => r.id);
if (empty.length) console.log(`  (empty this turn: ${empty.join(", ")})`);

console.log("\n── Store stuffing (what COULD be injected) ──");
for (const r of store.rows.slice(0, 10)) {
  console.log(`  ${kb(r.chars).padStart(9)}  ${String(r.items).padStart(5)} items  ${r.id}`);
}
console.log(`\n── Manuals feeding Project Context (${manuals.length} files, ${kb(manuals.reduce((a, m) => a + m.size, 0))}) ──`);
for (const m of manuals.slice(0, 12)) console.log(`  ${kb(m.size).padStart(8)}  ${m.scope.padEnd(8)} ${m.path}`);
if (manuals.length > 12) console.log(`  ... +${manuals.length - 12} more`);
console.log(`\n── Agent memory/ files (${memFiles.length} files, ${kb(memFiles.reduce((a, m) => a + m.size, 0))}) ──`);
for (const m of memFiles.slice(0, 8)) console.log(`  ${kb(m.size).padStart(8)}  ${m.name}`);
if (memFiles.length > 8) console.log(`  ... +${memFiles.length - 8} more`);
console.log(`\n── Skills visible to the model (${skills.length} total; ${matchedSkills.length} match this message) ──`);
console.log(`  ${skills.slice(0, 20).map((s) => s.id).join(", ")}${skills.length > 20 ? ` ... +${skills.length - 20}` : ""}`);
console.log(`\n── Menu: ${menu.size}/${MENU_MAX_TOOLS} tools; toolsets auto-loaded: ${activeToolsets.join(", ") || "(none)"} ──`);
if (menu.dropped.length) console.log(`  dropped: ${menu.dropped.map((d) => d.id).join(", ")}`);
console.log(`Registry surface: ${registryTools.length} tools in the registry (menu shows ${menu.size}).`);
console.log("\n═══ END AUDIT ═══");
