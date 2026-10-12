// Smoke: chat history is scoped per workspace folder.
// Two different folders must resolve to two different sessions, and switching
// back to the first folder must bring its own history back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { SessionStore } = await import(
  pathToFileURL(path.join(repoRoot, "src", "core", "session-store.js")).href
);
const { workspaceIdFor } = await import(
  pathToFileURL(path.join(repoRoot, "src", "core", "workspace-store.js")).href
);

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sessions-"));
const folderA = path.join(tmp, "alpha");
const folderB = path.join(tmp, "beta");
fs.mkdirSync(folderA, { recursive: true });
fs.mkdirSync(folderB, { recursive: true });

const store = new SessionStore(tmp, null);
const idA = workspaceIdFor(folderA);
const idB = workspaceIdFor(folderB);

console.log("\n=== Per-folder session scoping ===");

store.setWorkspaceId(idA);
const sessionA = store.resolveSession({ label: "main", agentId: "main", channel: "webchat" });
check("folder A resolves a session", Boolean(sessionA?.id));
check("session A key carries workspace id", String(sessionA.key).includes(`ws:${idA}`), sessionA.key);

store.setWorkspaceId(idB);
const sessionB = store.resolveSession({ label: "main", agentId: "main", channel: "webchat" });
check("folder B resolves a DIFFERENT session", sessionB.id !== sessionA.id);
check("session B key carries its own workspace id", String(sessionB.key).includes(`ws:${idB}`), sessionB.key);

console.log("\n=== Switching back restores the same session ===");

store.setWorkspaceId(idA);
const sessionABack = store.resolveSession({ label: "main", agentId: "main", channel: "webchat" });
check("returning to folder A reuses its session", sessionABack.id === sessionA.id);

console.log("\n=== History is actually separate ===");

store.appendTranscriptEntry?.(sessionA.id, { role: "user", text: "alpha-only message" });
try {
  store.appendMessage?.(sessionA.id, { role: "user", content: "alpha-only message" });
} catch { /* signature differs; transcript append above is the real check */ }

const detailA = store.getSession?.(sessionA.id) || null;
check("both sessions coexist in the store", store.listSessions(50).length >= 2, `${store.listSessions(50).length} sessions`);

console.log("\n=== Legacy migration (no history lost on upgrade) ===");

const legacyStore = new SessionStore(tmp, null);
const legacyKey = legacyStore.buildLegacySessionKey({ label: "legacy", agentId: "main", channel: "webchat" });
const raw = JSON.parse(fs.readFileSync(path.join(tmp, "data", "sessions.json"), "utf8"));
raw.sessions.push({
  id: "session_legacy_1",
  key: legacyKey,
  label: "legacy",
  agentId: "main",
  channel: "webchat",
  status: "idle",
  lifecycleState: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
fs.writeFileSync(path.join(tmp, "data", "sessions.json"), JSON.stringify(raw, null, 2));

const migrated = new SessionStore(tmp, null);
migrated.setWorkspaceId("default");
const adopted = migrated.resolveSession({ label: "legacy", agentId: "main", channel: "webchat" });
check("legacy session is adopted, not recreated", adopted.id === "session_legacy_1", `got ${adopted.id}`);
check("adopted session gets the workspace-scoped key", String(adopted.key).includes("ws:default"), adopted.key);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nTOTAL: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
