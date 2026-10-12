// Atomic file writes + an in-process write lock, for the memory stores.
//
// WHY: every memory store (data/memory.json, embeddings.json, playbooks.json,
// instincts.json, evolution/state.json, SDK artifacts) was written with a bare
// fs.writeFileSync. A kill/power-loss mid-write leaves a TRUNCATED JSON file,
// and the reader then throws on every subsequent run (JSON.parse of a partial
// document) — the whole memory layer is dead until someone deletes the file by
// hand. Writing to a sibling temp file and rename()ing it over the target makes
// the swap atomic on both NTFS and POSIX: a reader sees either the old file or
// the new one, never a half-written one.
//
// The temp name is derived from the TARGET path (not random) so two writers
// racing the same file do not silently overwrite each other's temp copy, and so
// a leftover temp is identifiable. rename() is atomic within a volume, which is
// all we need — the temp is always a sibling of the target.

import fs from "node:fs";
import path from "node:path";

/**
 * Write `text` to `targetPath` atomically: temp file + rename.
 * On any failure the temp file is removed so it cannot be mistaken for state,
 * and the original error is rethrown unchanged.
 */
export function atomicWriteFileSync(targetPath, text, options = {}) {
  const encoding = options.encoding || "utf8";
  const tmpPath = `${targetPath}.tmp`;
  try {
    const dir = path.dirname(targetPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(tmpPath, text, encoding);
    fs.renameSync(tmpPath, targetPath);
    return targetPath;
  } catch (error) {
    // Best-effort cleanup: a leftover <file>.tmp is harmless (it is never read)
    // but it would hide the real failure and confuse the next writer.
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* the original error is the one that matters */ }
    throw error;
  }
}

// ── In-process write lock (FIX 4) ───────────────────────────────────────────
// A per-path promise chain: every critical section for the SAME file runs one
// after another, so two concurrent async callers cannot interleave their
// read → modify → write and lose one side's records. Different paths never
// block each other.
//
// NOTE: this serializes only *within one process*. It is deliberately NOT a
// cross-process/file lock: OmniClaw is a single local process, and a stale
// .lock file left by a hard kill would wedge memory writes forever. The temp +
// rename above is what makes cross-process/kill damage survivable.
const lockQueues = new Map();

/**
 * Run `fn` exclusively for `targetPath`. Async-safe: concurrent calls with the
 * same path queue in arrival order. `fn` may be sync or async.
 */
export function withFileLock(targetPath, fn) {
  const key = String(targetPath);
  const previous = lockQueues.get(key) || Promise.resolve();
  // Swallow the predecessor's rejection so one failure does not poison the
  // queue for every later waiter (each waiter still sees its OWN error).
  const run = previous.then(
    () => fn(),
    () => fn(),
  );
  // Keep the chain alive regardless of this task's outcome.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  lockQueues.set(key, settled);
  // Best-effort cleanup so the Map cannot grow without bound across many paths.
  settled.then(() => {
    if (lockQueues.get(key) === settled) lockQueues.delete(key);
  });
  return run;
}
