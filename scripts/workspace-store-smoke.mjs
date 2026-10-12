// Smoke: appDir / workspaceDir split + folder selection + per-folder session ids.
// Verifies Step 0 of the workspace-selection feature: the agent can point its
// file/shell sandbox at an arbitrary folder WITHOUT moving its own app state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { WorkspaceStore, workspaceIdFor } = await import(
  pathToFileURL(path.join(repoRoot, "src", "core", "workspace-store.js")).href
);

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-workspace-"));
const appDir = path.join(tmpRoot, "app");
const projectA = path.join(tmpRoot, "project-alpha");
const projectB = path.join(tmpRoot, "project-beta");
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });
fs.writeFileSync(path.join(projectA, "package.json"), '{"name":"alpha"}\n', "utf8");

console.log("\n=== WorkspaceStore ===");

const store = new WorkspaceStore(appDir, appDir);

check("defaults to app dir when nothing selected", store.getActivePath() === path.resolve(appDir));
check("isDefault true before any selection", store.getState().isDefault === true);

check("rejects a folder that does not exist", store.validateCandidate(path.join(tmpRoot, "nope")).ok === false);
check("rejects drive root", store.validateCandidate("C:\\").ok === false);
check("accepts a real folder", store.validateCandidate(projectA).ok === true);

const selected = store.setActive(projectA);
check("setActive succeeds", selected.ok === true);
check("setActive returns an id", Boolean(selected.id));
check("active path updates", store.getActivePath() === path.resolve(projectA));
check("isDefault false after selection", store.getState().isDefault === false);
check("appears in recents", store.listRecents().some((entry) => entry.path === path.resolve(projectA)));

console.log("\n=== Persistence across restart ===");

const restarted = new WorkspaceStore(appDir, appDir);
check("remembers selection after reload", restarted.getActivePath() === path.resolve(projectA));
check("recents survive reload", restarted.listRecents().length >= 1);

console.log("\n=== Per-folder session scoping ===");

const idA = workspaceIdFor(projectA);
const idB = workspaceIdFor(projectB);
check("different folders get different session ids", idA !== idB);
check("same path yields a stable id", workspaceIdFor(projectA) === idA);
check("id is filesystem-safe", /^[a-z0-9-]+$/i.test(idA), idA);
check("empty path falls back to default", workspaceIdFor("") === "default");

console.log("\n=== Missing folder falls back safely ===");

fs.rmSync(projectA, { recursive: true, force: true });
const afterDelete = new WorkspaceStore(appDir, appDir);
check("falls back to app dir when folder vanished", afterDelete.getActivePath() === path.resolve(appDir));

console.log("\n=== Browse ===");

const browse = new WorkspaceStore(appDir, appDir).browse(tmpRoot);
check("browse succeeds on a real folder", browse.ok === true);
check("browse lists directories", Array.isArray(browse.directories) && browse.directories.length > 0, `${browse.directories?.length} dirs`);
check("browse excludes node_modules", !browse.directories.some((entry) => entry.name === "node_modules"));
check("browse exposes a parent", browse.parent !== null);

console.log("\n=== App state stays put ===");

const appDataFiles = fs.readdirSync(path.join(appDir, "data"));
check("workspaces.json written inside app dir", appDataFiles.includes("workspaces.json"), appDataFiles.join(","));
check("no app data written into the project folder", !fs.existsSync(path.join(projectB, "data")));

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nTOTAL: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
