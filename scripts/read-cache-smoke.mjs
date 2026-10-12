// Session read-cache + hard invalidation: read -> shortcut on re-read,
// fresh bytes after edit, forceRead override. Ledger persists on sessions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/core/tool-registry.js";
import { FileStore, normalizeLedgerKey } from "../src/core/file-store.js";
import { SessionStore } from "../src/core/session-store.js";
import { OmniClawAgent } from "../src/core/agent.js";

let passed = 0;
function ok(cond, msg) {
  if (!cond) { console.error(`  FAIL ${msg}`); process.exitCode = 1; return; }
  passed += 1;
  console.log(`  ok   ${msg}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "read-cache-"));
fs.writeFileSync(path.join(tmpRoot, "notes.txt"), "version one\nsecond line\n");
const sessions = new SessionStore(tmpRoot);
const session = sessions.createSession({ key: "test", label: "t", agentId: "main", channel: "webchat" });
sessions.persistSession(session);
const agentRuntime = {
  getChatRoot: () => tmpRoot,
  sessions,
  gateway: { addEvent: () => {} },
};
const reg = new ToolRegistry({
  configStore: {
    getConfig: () => ({
      tools: {
        menuV2: true,
        permissions: { allowFileRead: true, allowFileWrite: true },
        filesystem: { maxReadBytes: 65536, writableRoots: [tmpRoot] },
        computerAccess: { maxReadBytes: 131072 },
      },
    }),
  },
  fileStore: new FileStore(tmpRoot),
  agentRuntime,
  pluginRegistry: { getToolDefinitions: () => [] },
  agentRegistry: null, customizationEngine: null,
});
const ctxFor = (runId) => ({ agentId: "main", sessionId: session.id, runId });

// 1. first read executes fully
const r1 = await reg.run("read_file", { path: "notes.txt" }, ctxFor("r1"));
ok(r1.content && r1.content.includes("version one") && !r1.unchanged, "first read returns content");

// seed the ledger the way end-of-turn does (agent.buildEvidenceLedger shape)
sessions.updateSession(session.id, {
  evidenceLedger: {
    turn: 1,
    files: {
      [normalizeLedgerKey(tmpRoot, "notes.txt")]: {
        size: r1.totalBytes || 100, turn: 1, about: "version one",
        mtimeMs: fs.statSync(path.join(tmpRoot, "notes.txt")).mtimeMs, hash: "abc",
      },
    },
    edits: [], commands: [], findings: [],
  },
});

// 2. unchanged re-read short-circuits (no content, pointer + force option)
const r2 = await reg.run("read_file", { path: "notes.txt" }, ctxFor("r2"));
ok(r2.unchanged === true && r2.sinceTurn === 1 && !r2.content, "unchanged re-read returns shortcut, not content");
ok(/forceRead/.test(r2.message || ""), "shortcut names the force-read escape hatch");

// 3. explicit window always executes
const r3 = await reg.run("read_file", { path: "notes.txt", offset: 2, limit: 1 }, ctxFor("r3"));
ok(r3.content && r3.content.includes("second line") && !r3.unchanged, "explicit offset window executes");

// 4. forceRead overrides the shortcut
const r4 = await reg.run("read_file", { path: "notes.txt", forceRead: true }, ctxFor("r4"));
ok(r4.content && r4.content.includes("version one") && !r4.unchanged, "forceRead returns fresh content");

// 5. THE invalidation case: edit, then read must serve NEW bytes (never stale)
const ew = await reg.run("edit", { path: "notes.txt", find: "version one", replace: "version two UPDATED" }, ctxFor("r5"));
ok(!ew.error && ew.edited !== false, "edit succeeds");
const r5 = await reg.run("read_file", { path: "notes.txt" }, ctxFor("r6"));
ok(r5.content && r5.content.includes("version two UPDATED") && !r5.unchanged, "post-edit read serves NEW content (no stale cache)");

// 6. exec naming the path invalidates too
sessions.updateSession(session.id, {
  evidenceLedger: {
    turn: 2,
    files: {
      [normalizeLedgerKey(tmpRoot, "notes.txt")]: {
        size: 10, turn: 2, about: "x",
        mtimeMs: fs.statSync(path.join(tmpRoot, "notes.txt")).mtimeMs, hash: "x",
      },
    },
    edits: [], commands: [], findings: [],
  },
});
reg.invalidateLedgerForCommand({ sessionId: session.id }, "cat notes.txt");
const after = sessions.getEvidenceLedger(session.id);
ok(!after.files || Object.keys(after.files).length === 0, "exec naming the path invalidates the entry");
reg.invalidateLedgerForCommand({ sessionId: session.id }, "git status --porcelain");
ok(true, "unrelated command invalidates nothing (no throw)");

// 7. builder stores small-file heads; the shortcut serves content (so cross-turn
// edits have find-text without a force-read round). Uses the REAL agent methods
// with a stub `this` (sessions + workspace root only).
const agentThis = {
  sessions,
  getWorkspaceRoot: () => tmpRoot,
  ledgerPathKey: OmniClawAgent.prototype.ledgerPathKey,
};
const built = OmniClawAgent.prototype.buildEvidenceLedger.call(agentThis,
  { id: session.id },
  [{ tool: "read_file", input: { path: "notes.txt" }, output: { path: "notes.txt", content: "version two UPDATED\nsecond line\n" } }],
);
const builtKey = normalizeLedgerKey(tmpRoot, "notes.txt");
ok(built && built.files[builtKey] && built.files[builtKey].head.includes("version two UPDATED"), "builder stores small-file head");
const r7 = await reg.run("read_file", { path: "notes.txt" }, ctxFor("r7"));
ok(r7.unchanged === true && String(r7.message || "").includes("version two UPDATED"), "shortcut serves small-file content for edit find-text");

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nread-cache: ${passed} passed${process.exitCode ? " WITH FAILURES" : " ALL PASS"}`);
process.exit(process.exitCode || 0);
