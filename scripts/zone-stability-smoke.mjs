// Prompt-cache zone stability: Zone A (+ tool schemas) must hash identical
// across turns while files are unchanged, and change exactly when content
// changes. Volatile fields (timestamps, run ids) must live in Zone C only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";

function assert(condition, message) {
  if (!condition) throw new Error("ASSERT: " + message);
  console.log("ok: " + message);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zone-stability-"));
const runtime = {
  rootDir: tmpRoot,
  config: {
    getConfig: () => ({
      provider: { systemPrompt: "You are OmniClaw test.", model: "test-model" },
      app: { creator: { name: "T", location: "L", github: "" } },
    }),
  },
  tools: {},
  sessions: { listSessions: () => [] },
  gateway: { listRuns: () => [] },
  memory: { getLongTermMemory: () => [], getNotes: () => [] },
  provider: { getInfo: () => ({ model: "test-model" }) },
  skills: { getAll: () => [] },
};
const loop = new OmniLoop({ agentRuntime: runtime });
const schemas = [{ type: "function", function: { name: "read_file", description: "r", parameters: { type: "object" } } }];

function filesFor(rev) {
  return [
    { name: "AGENTS.md", scope: "shared", path: "/ws/AGENTS.md", content: "# shared manual rev" + rev },
    { name: "AGENTS.md", scope: "project", path: "/repo/AGENTS.md", content: "# project manual rev" + rev },
    { name: "PROGRESS.md", scope: "project", path: "/repo/PROGRESS.md", content: "progress rev" + rev },
  ];
}
function bundleFor(rev) {
  return {
    workspaceContext: {
      files: filesFor(rev),
      manifest: { selectedProject: "/repo", defaultWorkingDirectory: "/repo", agentWorkspace: "/ws", sharedWorkspace: "/ws", dailyMemoryPath: "/ws/memory/2026-09-10.md" },
      loadedAt: "2026-09-10T09:00:0" + rev + ".000Z",
    },
    skills: [], tools: [], activeMemory: null, bootstrapRitual: "", loopContract: {},
  };
}
const settings = { contextCharBudget: 120000, contextTokens: 128000, maxTokens: 8000, compactAtPercent: 0.8 };
const hashes = [];
let sizes = null;
for (let turn = 1; turn <= 8; turn += 1) {
  const rev = turn < 5 ? 1 : 2; // file content changes on turn 5 only
  const out = loop.buildSystemPrompt({
    agent: { id: "main", name: "Main" }, profile: { id: "balanced" },
    contextBundle: bundleFor(rev), loopContract: {},
    session: { id: "sess-" + turn, label: "t" + turn },
    message: "task message " + turn, run: { id: "run-" + turn },
  });
  const h = loop.zoneAHash(out.zoneA, schemas);
  hashes.push(h);
  if (turn === 1) {
    sizes = { zoneA: out.zoneA.length, zoneB: out.zoneB.length, schemas: JSON.stringify(schemas).length };
    console.log(`zone sizes: A=${sizes.zoneA} B=${sizes.zoneB} schemas=${sizes.schemas}`);
    assert(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(out.zoneA), "Zone A has no ISO timestamp");
    assert(!/UTC Time:|Current Date:|- Today:/.test(out.zoneA), "Zone A has no date/time lines");
  }
  const zoneC = loop.buildZoneCSection({
    manifest: bundleFor(rev).workspaceContext.manifest, loadedAt: "2026-09-10T09:00:00.000Z",
    session: { id: "sess-" + turn }, run: { id: "run-" + turn }, agent: { id: "main" }, settings, providerModel: "m",
  });
  if (turn === 1) {
    sizes.zoneC = zoneC.length;
    console.log(`zone sizes: C=${sizes.zoneC}`);
    assert(/Current date: \d{4}-\d{2}-\d{2}/.test(zoneC), "Zone C carries current date");
    assert(/run-run-1|run-1/.test(zoneC), "Zone C carries run id");
    // ONE ROOT: no filesystem location in Zone C — the project root is
    // stated exactly once in the system prompt (Project Context). Zone C
    // carries only date/time + session/run ids so it never leaks a root.
    assert(!/\/repo/.test(zoneC), "Zone C carries no project path (one-root rule)");
    assert(!/Context budget|chars\/round/.test(zoneC), "Zone C carries no budget numbers (no cost anxiety)");
  }
}
console.log("hashes: " + hashes.join(" "));
assert(new Set(hashes.slice(0, 4)).size === 1, "turns 1-4 identical hash");
assert(hashes[4] !== hashes[0], "turn 5 hash differs after file change");
assert(new Set(hashes.slice(4, 8)).size === 1, "turns 5-8 identical hash");
assert(new Set(hashes).size === 2, "exactly 2 distinct hashes across 8 turns");
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("\nzone-stability: ALL PASS");
process.exit(0);
