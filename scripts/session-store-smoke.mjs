// Session-store write contract (Bots M1, Part A) — regression cover for the
// concurrency hole catalogued in AGENTS_AUDIT.md risk #1.
//
// BEFORE: SessionStore.write() used a bare fs.writeFileSync on
// data/sessions.json. A kill mid-write left a truncated file, and read()'s
// safeJsonParse swallowed the parse error and returned an EMPTY store — so the
// chat history of every session silently vanished. Two concurrent read-modify-
// write callers could also lose one side (last writer wins).
//
// AFTER: write() goes through atomicWriteFileSync (temp + rename), and the
// async mutators go through mutate(), which serializes read -> modify -> write
// on the per-path lock from atomic-write.js (same pattern as memory-store.js).
//
// All data lives in os.tmpdir() — this test never touches data/ or workspace/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session-store.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return false; }
  console.log(`ok: ${label}`);
  return true;
}

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `session-store-${tag}-`));

function readStoreFile(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "sessions.json"), "utf8"));
}

function listDataDir(root) {
  return fs.readdirSync(path.join(root, "data"));
}

console.log("step 1: write() is atomic — no .tmp file is left behind");
{
  const root = tmpRoot("atomic");
  const store = new SessionStore(root);
  assert(!listDataDir(root).some((f) => f.endsWith(".tmp")), "fresh store has no .tmp file");
  // createSession() only builds the record (resolveSession persists); use
  // persistSession() for both so the file really holds two sessions.
  store.persistSession(store.createSession({ key: "k1", label: "first", agentId: "main", channel: "webchat" }));
  store.persistSession(store.createSession({ key: "k2", label: "second", agentId: "main", channel: "webchat" }));
  const leftovers = listDataDir(root).filter((f) => f.endsWith(".tmp"));
  assert(leftovers.length === 0, `no .tmp file after 2 writes (found: ${leftovers.join(",") || "none"})`);
  const parsed = readStoreFile(root);
  assert(parsed.version === 2 && Array.isArray(parsed.sessions), "file format is still {version, sessions}");
  assert(parsed.sessions.length === 2, "both sessions persisted");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 2: a kill mid-write cannot truncate the store (temp + rename)");
{
  const root = tmpRoot("truncate");
  const store = new SessionStore(root);
  store.persistSession(store.createSession({ key: "k1", label: "one", agentId: "main", channel: "webchat" }));
  const good = fs.readFileSync(path.join(root, "data", "sessions.json"), "utf8");
  // Simulate the damage the old bare writeFileSync could do: a half-written
  // file plus its temp sibling. The reader must still see the LAST GOOD file,
  // because rename() means the target is never partially written.
  fs.writeFileSync(`${path.join(root, "data", "sessions.json")}.tmp`, good.slice(0, Math.floor(good.length / 2)));
  const reread = new SessionStore(root);
  assert(reread.listSessions(10).length === 1, "a truncated .tmp sibling does not corrupt the live store");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 3: 20 concurrent createSession/appendMessage calls lose nothing");
{
  const root = tmpRoot("concurrent");
  const store = new SessionStore(root);
  const N = 20;
  const created = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      store.createSessionInStore({
        key: `agent:main:webchat:c${i}`,
        label: `c${i}`,
        agentId: "main",
        channel: "webchat",
      })),
  );
  const afterCreate = readStoreFile(root);
  assert(afterCreate.sessions.length === N, `all ${N} concurrent createSessionInStore landed (got ${afterCreate.sessions.length})`);

  await Promise.all(
    created.map((s, i) =>
      store.appendMessageInStore(s.id, { role: i % 2 ? "user" : "assistant", text: "m" + i })));
  const afterAppend = readStoreFile(root);
  assert(afterAppend.sessions.length === N, `still ${N} sessions after 20 concurrent appends (got ${afterAppend.sessions.length})`);
  const withMessages = afterAppend.sessions.filter((s) => s.messageCount === 1);
  assert(withMessages.length === N, `every session got its message (got ${withMessages.length}/${N})`);
  assert(afterAppend.sessions.every((s) => s.lastUserMessagePreview || s.lastAssistantPreview), "previews were recorded");

  console.log("step 3b: file is valid JSON after every single write");
  let parsedEveryTime = true;
  for (let i = 0; i < N; i++) {
    try {
      JSON.parse(fs.readFileSync(path.join(root, "data", "sessions.json"), "utf8"));
    } catch (e) {
      parsedEveryTime = false;
      console.log(`  parse failure at iteration ${i}: ${e.message}`);
      break;
    }
    await store.mutate((data) => { data.sessions[0].queueDepth = i; return null; });
  }
  assert(parsedEveryTime, "sessions.json parsed as JSON on all 20 post-write reads");
  assert(!listDataDir(root).some((f) => f.endsWith(".tmp")), "no .tmp file left after the concurrent storm");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 4: a truncated sessions.json falls back to empty WITHOUT throwing");
{
  const root = tmpRoot("corrupt");
  const store = new SessionStore(root);
  fs.writeFileSync(path.join(root, "data", "sessions.json"), '{"version":2,"sessions":[{"id":"a"');
  const reopened = new SessionStore(root);
  assert(reopened.listSessions(10).length === 0, "corrupt file degrades to an empty store, no throw");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nsession-store: ${failures} FAILURES` : "\nsession-store: ALL PASS");
process.exit(failures ? 1 : 0);