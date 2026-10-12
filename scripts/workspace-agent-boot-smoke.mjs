// L3-ish check: the agent still boots after the constructor change, and
// selecting a folder actually re-scopes the file + shell sandboxes while the
// app's own state stays behind in rootDir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { OmniClawAgent } = await import(pathToFileURL(path.join(repoRoot, "src", "core", "agent.js")).href);

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-boot-"));
const project = path.join(tmp, "my-project");
fs.mkdirSync(project, { recursive: true });
// The agent reads config/default.json relative to rootDir, so a throwaway app
// dir needs its own copy before it can boot.
fs.cpSync(path.join(repoRoot, "config"), path.join(tmp, "config"), { recursive: true });

console.log("\n=== Agent boot + workspace scoping ===");

const agent = new OmniClawAgent({ rootDir: tmp });
check("agent constructs without throwing", Boolean(agent));
check("workspace defaults to app dir", agent.getWorkspaceRoot() === path.resolve(tmp));

const result = agent.selectWorkspace(project);
check("selectWorkspace succeeds", result.ok === true, JSON.stringify(result));
check("workspace root moved", agent.getWorkspaceRoot() === path.resolve(project));
check("FileStore re-scoped", agent.files.rootDir === path.resolve(project));
check("ShellExecutor re-scoped", agent.shellExecutor.rootDir === path.resolve(project));

check("app state untouched in rootDir", agent.rootDir === path.resolve(tmp));
check("workspaces.json lives in app dir", fs.existsSync(path.join(tmp, "data", "workspaces.json")));
check("no data dir leaked into project", !fs.existsSync(path.join(project, "data")));

console.log("\n=== Selection survives a fresh agent (restart) ===");
const rebooted = new OmniClawAgent({ rootDir: tmp });
check("remembers folder on restart", rebooted.getWorkspaceRoot() === path.resolve(project));
check("FileStore re-scoped after restart", rebooted.files.rootDir === path.resolve(project));

console.log("\n=== Bad input rejected ===");
check("rejects missing folder", agent.selectWorkspace(path.join(tmp, "ghost")).ok === false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nTOTAL: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
