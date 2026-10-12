import fs from "node:fs";
import path from "node:path";

// Shared file-checkpoint primitive (Claude Code /rewind parity). Before any
// write/edit to an EXISTING file, snapshot its current bytes under
// data/checkpoints/<runId>/ so a bad change can be rolled back with the
// restore_checkpoint tool. Extracted so BOTH the main loop AND sub-agents
// snapshot to the SAME per-run store — previously only the main loop
// checkpointed, so a sub-agent clobbering a file left nothing to rewind.

// Tools whose successful run replaces/mutates a file's content.
export const WRITE_TOOLS = new Set([
  "write_file", "write", "edit", "multi_edit", "apply_patch", "append_file", "write_computer_file",
]);

export function checkpointDir(rootDir, runId) {
  return path.join(rootDir || ".", "data", "checkpoints", String(runId || "run").replace(/[^\w.-]/g, "_"));
}

// Snapshot `filePath` into the run's checkpoint store. Returns { saved, reason }.
// Best-effort: never throws, so it can never block or fail a write.
export function saveFileCheckpoint({ rootDir, runId, filePath, tool = "", maxEntries = 60, maxFileBytes = 2 * 1024 * 1024 } = {}) {
  try {
    if (!rootDir || !filePath) return { saved: false, reason: "missing-args" };
    if (!runId) return { saved: false, reason: "no-run-id" };
    const abs = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
    if (!fs.existsSync(abs)) return { saved: false, reason: "new-file" }; // nothing to preserve
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > maxFileBytes) return { saved: false, reason: "not-snapshottable" };
    const dir = checkpointDir(rootDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, "index.json");
    let index = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      if (Array.isArray(parsed)) index = parsed;
    } catch { /* first entry */ }
    if (index.length >= maxEntries) return { saved: false, reason: "run-limit" }; // bounded per run
    const seq = index.length + 1;
    const safeName = abs.replace(/[:\\/]/g, "_").slice(-140);
    const snapshot = `${String(seq).padStart(3, "0")}__${safeName}`;
    fs.copyFileSync(abs, path.join(dir, snapshot));
    index.push({ seq, file: abs, snapshot, at: new Date().toISOString(), tool });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    return { saved: true, seq };
  } catch {
    return { saved: false, reason: "error" }; // snapshots are best-effort
  }
}
