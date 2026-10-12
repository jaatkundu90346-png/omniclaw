// ONE ROOT regression (Part A): the rendered prompt states exactly one
// filesystem root, reads/writes/exec resolve to the selected project, and
// switching projects moves everything (prompt + resolution) together.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmniLoop } from "../src/core/omni-loop.js";
import { FileStore } from "../src/core/file-store.js";

let failures = 0;
function assert(cond, label) {
  if (!cond) { failures++; console.log(`FAIL: ${label}`); return; }
  console.log(`ok: ${label}`);
}

console.log("step 1: make two fake project folders");
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "one-root-A-"));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "one-root-B-"));
fs.writeFileSync(path.join(dirA, "a.txt"), "hello A");
fs.writeFileSync(path.join(dirB, "b.txt"), "hello B");

console.log("step 2: build prompt with A selected");
let selected = dirA;
const runtime = {
  rootDir: path.resolve("C:\\dont-use-app-dir"),
  getWorkspaceRoot: () => selected,
  config: { getConfig: () => ({ provider: {}, app: {} }) },
  tools: { getRunPlan: () => null },
  gateway: { addEvent: () => {}, emitTransient: () => {} },
  sessions: { getEvidenceLedger: () => null },
  provider: { getInfo: () => ({ model: "test" }) },
  fileStore: { searchText: () => ({ matches: [] }) },
};
const loop = new OmniLoop({ agentRuntime: runtime });
const menuIds = ["exec", "read_file", "write_file", "edit", "multi_edit", "list_files", "search_text", "web_search", "web_fetch", "delegate_task", "update_plan", "memory_search", "memory_write", "ask_user", "finish", "load_toolset", "list_toolsets"];
const bundle = (sel) => ({
  tools: [], skills: [],
  workspaceContext: {
    manifest: { selectedProject: sel, defaultWorkingDirectory: sel, agentWorkspace: "/agent-home", sharedWorkspace: "/shared" },
    files: [],
  },
});
const outA = loop.buildSystemPrompt({
  agent: { id: "main" }, profile: { id: "balanced" }, contextBundle: bundle(dirA),
  loopContract: {}, session: { id: "s1", workspacePath: dirA }, run: { id: "r1" },
  message: "create a Mario-style platformer in a single HTML file", menuToolIds: menuIds,
});
const zoneCA = loop.buildZoneCSection({ manifest: bundle(dirA).workspaceContext.manifest, session: { id: "s1" }, run: { id: "r1" }, agent: { id: "main" }, settings: {} });

console.log("step 3: assert exactly ONE root line, no second location");
const rootLinesA = outA.system.split("\n").filter((l) => /^Project root: /.test(l));
assert(rootLinesA.length === 1, `exactly one 'Project root:' line (got ${rootLinesA.length})`);
assert(rootLinesA[0].includes(dirA), "the one root line names the selected project");
for (const banned of ["Selected project:", "Default working directory:", "Agent home", "Shared workspace:", "Project root (cwd)"]) {
  assert(!outA.system.includes(banned), `no '${banned}' anywhere in prompt`);
}
assert(!zoneCA.includes(dirA) && !/\/repo|\/agent-home|\/shared/.test(zoneCA), "Zone C carries no filesystem location");

console.log("step 4: reads/writes/exec resolve to the selected project");
assert(loop.projectRoot({ workspacePath: dirA }) === dirA, "projectRoot() returns selected project");
assert(loop.normalizeFilePath("mario.html").startsWith(dirA.replace(/\\/g, "/").toLowerCase()), "normalizeFilePath resolves under selected project");
const store = new FileStore(dirA);
const resolved = store.resolveWorkspacePath("mario.html");
assert(resolved.startsWith(dirA), "FileStore resolves under selected project");
fs.writeFileSync(resolved, "<html>mario</html>");
assert(fs.readFileSync(path.join(dirA, "mario.html"), "utf8").includes("mario"), "write+read roundtrip lands in selected project");

console.log("step 5: switch projects — prompt + resolution move together");
selected = dirB;
const outB = loop.buildSystemPrompt({
  agent: { id: "main" }, profile: { id: "balanced" }, contextBundle: bundle(dirB),
  loopContract: {}, session: { id: "s1", workspacePath: dirB }, run: { id: "r1" },
  message: "create a Mario-style platformer in a single HTML file", menuToolIds: menuIds,
});
const rootLinesB = outB.system.split("\n").filter((l) => /^Project root: /.test(l));
assert(rootLinesB.length === 1 && rootLinesB[0].includes(dirB), "after switch: exactly one root line naming the new project");
assert(!outB.system.includes(dirA), "after switch: old project path gone from prompt");
assert(loop.normalizeFilePath("mario.html").startsWith(dirB.replace(/\\/g, "/").toLowerCase()), "after switch: resolution follows the new project");

fs.rmSync(dirA, { recursive: true, force: true });
fs.rmSync(dirB, { recursive: true, force: true });
console.log(failures ? `\none-root: ${failures} FAILURES` : "\none-root: ALL PASS");
process.exit(failures ? 1 : 0);
