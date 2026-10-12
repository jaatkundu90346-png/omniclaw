// Memory fixes contract (2026-09-30) — regression cover for the bugs catalogued
// in MEMORY_MAP.md section 6 and fixed in MEMORY_FIX_ALL.md.
//
// Every fix below was previously invisible to the test suite: a truncated
// memory.json, a poisoned cache, two memories silently overwriting each other,
// a UTC-vs-local filename, an SDK promote that stored EMPTY text, and an
// unbounded notes array all produced a "passing" build.
//
// All data lives in os.tmpdir() — this test never touches data/ or workspace/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, NOTES_RETENTION } from "../src/core/memory-store.js";
import { MemorySDK } from "../src/core/memory-sdk.js";

let failures = 0;
function assert(condition, label) {
  if (!condition) { failures++; console.log(`FAIL: ${label}`); return false; }
  console.log(`ok: ${label}`);
  return true;
}

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `mem-fixes-${tag}-`));

console.log("step 1: read() hands out a copy, not the live cache (FIX 3)");
{
  const root = tmpRoot("cache");
  const store = new MemoryStore(root);
  store.addNote("real note");

  // Mutate what read() returned and THROW IT AWAY without calling write().
  // Before the fix this was the same object as store.cache.data, so the
  // phantom record stayed in the cache and the next read() (or a later
  // write() by any other code path) would persist it.
  const first = store.read();
  first.notes.push({ id: "note_phantom", text: "PHANTOM", agentId: "main", createdAt: "never" });

  const second = store.read();
  assert(!second.notes.some((n) => n.text === "PHANTOM"), "phantom note is NOT visible in the next read()");
  assert(second.notes.length === 1 && second.notes[0].text === "real note", "the real note survived");

  // A write by an unrelated later call must not resurrect the phantom either.
  store.addNote("second real note");
  const third = store.read();
  assert(!third.notes.some((n) => n.text === "PHANTOM"), "phantom did not come back via a later write()");
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "data", "memory.json"), "utf8"));
  assert(!onDisk.notes.some((n) => n.text === "PHANTOM"), "phantom is not on disk");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 2: write() is atomic and leaves no .tmp behind (FIX 1)");
{
  const root = tmpRoot("atomic");
  const store = new MemoryStore(root);
  store.addNote("n1");
  store.addNote("n2");
  store.write(store.read());

  const dataDir = path.join(root, "data");
  const leftovers = fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
  assert(leftovers.length === 0, `no .tmp file left next to memory.json (found ${leftovers.length})`);
  assert(fs.existsSync(path.join(dataDir, "memory.json")), "memory.json exists");

  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(path.join(dataDir, "memory.json"), "utf8")); } catch (error) {
    console.log(`  parse error: ${error.message}`);
  }
  assert(parsed !== null, "memory.json parses as valid JSON");
  assert(Array.isArray(parsed?.notes) && parsed.notes.length === 2, `both notes persisted (got ${parsed?.notes?.length})`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 3: colliding slugs do not overwrite each other (FIX 6)");
{
  const root = tmpRoot("slug");
  const store = new MemoryStore(root);
  const paths = store.getLayeredMemoryPaths("main");
  store.ensureLayeredMemoryFiles("main");

  // Both titles slugify to "api-key-notes" but their headings differ, so the old
  // code wrote BOTH into the same <slug>.md and the first body was gone.
  const first = store.promoteMemory({
    agentId: "main", sourceType: "manual", sourceId: "s1",
    title: "API Key Notes!", text: "BODY-ONE rotation policy for keys",
  });
  const second = store.promoteMemory({
    agentId: "main", sourceType: "manual", sourceId: "s2",
    title: "api key notes", text: "BODY-TWO different policy entirely",
  });
  assert(first.created === true && second.created === true, "both memories were created");

  // The daily memory file (<date>.md) lives in this same directory, so count
  // only the memory files themselves.
  const dailyName = `${path.basename(paths.dailyMemoryPath, ".md")}.md`;
  const files = () => fs.readdirSync(paths.dailyMemoryDir)
    .filter((f) => f.endsWith(".md") && f !== dailyName);
  const after2 = files();
  assert(after2.length === 2, `two different .md files exist (got ${after2.length}: ${after2.join(", ")})`);
  assert(new Set(after2).size === 2, "the two memory files are distinct paths");

  const bodies = after2.map((f) => fs.readFileSync(path.join(paths.dailyMemoryDir, f), "utf8"));
  assert(bodies.some((b) => b.includes("BODY-ONE")), "BODY-ONE is still on disk");
  assert(bodies.some((b) => b.includes("BODY-TWO")), "BODY-TWO is still on disk");
  // The collision really is on the SAME base slug (that is what -2 disambiguates).
  const bases = after2.map((f) => f.replace(/\.md$/, "").replace(/-\d+$/, ""));
  assert(new Set(bases).size === 1, `both files share one base slug (${[...new Set(bases)].join(",")})`);

  // Re-promoting the SAME title must reuse its file, not create a third one.
  store.promoteMemory({
    agentId: "main", sourceType: "manual", sourceId: "s3",
    title: "API Key Notes!", text: "BODY-ONE rotation policy for keys",
  });
  const after3 = files();
  assert(after3.length === 2, `same title reuses its file, no third file (got ${after3.length}: ${after3.join(", ")})`);
  assert(JSON.stringify([...after3].sort()) === JSON.stringify([...after2].sort()), "file set is unchanged after re-promoting the same title");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 4: daily memory file uses the LOCAL date (FIX 7)");
{
  const root = tmpRoot("date");
  const store = new MemoryStore(root);
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const actual = path.basename(store.getLayeredMemoryPaths("main").dailyMemoryPath, ".md");
  assert(actual === expected, `daily file is the local date (${actual} === ${expected})`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 5: SDK promoteMemory stores the real text (FIX 5)");
{
  const root = tmpRoot("sdk");
  const store = new MemoryStore(root);
  const sdk = new MemorySDK({ rootDir: root, memoryStore: store, configStore: null });
  const summary = "User prefers pnpm over npm for all JavaScript projects";
  const result = await sdk.promoteMemory({ noteId: "note_abc", agentId: "main", summary });

  assert(Boolean(result?.memory), "promoteMemory returned a memory object");
  const text = String(result?.memory?.text || "");
  assert(text.length > 0, `promoted text is not empty (len ${text.length})`);
  assert(text === summary, "promoted text equals the summary");
  assert(result?.memory?.sourceRef === "note:note_abc", `sourceRef is sourceType:sourceId (got ${result?.memory?.sourceRef})`);

  // The citation branch was unreachable while it tested result?.promoted.
  const citations = sdk.getCitations(10);
  assert(citations.length >= 1, `a citation was recorded (${citations.length})`);
  assert(citations[0]?.action === "promote", "citation action is 'promote'");
  assert(citations[0]?.memoryId === result.memory.id, "citation references the promoted memory id");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 6: notes are capped at NOTES_RETENTION, newest kept (FIX 8)");
{
  const root = tmpRoot("retention");
  const store = new MemoryStore(root);
  for (let i = 0; i < 2100; i += 1) store.addNote(`note ${i}`);

  const data = store.read();
  assert(data.notes.length === NOTES_RETENTION, `kept only ${NOTES_RETENTION} notes (got ${data.notes.length})`);
  assert(data.notes.length === 2000, `cap is 2000 (got ${data.notes.length})`);
  const last = data.notes[data.notes.length - 1];
  assert(last.text === "note 2099", `newest note kept (last = "${last.text}")`);
  assert(!data.notes.some((n) => n.text === "note 0"), "oldest notes dropped");
  assert(data.notes.some((n) => n.text === "note 100"), "oldest surviving note is the expected boundary (note 100)");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("step 7: read() copy cost on a 5000-conversation store (measurement only)");
{
  const root = tmpRoot("perf");
  const store = new MemoryStore(root);
  // Written in one shot on purpose: 5000 individual appendConversation calls
  // would be O(n^2) and would measure the write path, not the read copy.
  const empty = store.read();
  store.write({
    ...empty,
    conversations: Array.from({ length: 5000 }, (_, i) => ({
      id: `conv_${i}`, agentId: "main", user: `u${i}`, assistant: `a${i}`,
      sessionId: "s", runId: `r${i}`, createdAt: new Date().toISOString(),
    })),
  });

  store.read(); // warm the mtime cache so we time the copy, not the disk read
  const RUNS = 20;
  const started = process.hrtime.bigint();
  for (let i = 0; i < RUNS; i += 1) store.read();
  const avgMs = Number(process.hrtime.bigint() - started) / 1e6 / RUNS;
  console.log(`  ${RUNS} read() calls over 5000 conversations: ${avgMs.toFixed(2)} ms/call avg`);
  console.log("  (informational only — this step never fails the run)");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\nmemory-fixes: ${failures} FAILURES` : "\nmemory-fixes: ALL PASS");
process.exit(failures ? 1 : 0);
