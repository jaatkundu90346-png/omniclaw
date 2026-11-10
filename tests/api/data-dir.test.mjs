// The "my sessions all vanished" bug: a packaged build resolved its state dir
// from process.cwd(), so a different launch folder silently produced a fresh
// EMPTY state dir. These assertions pin both halves of the fix:
//   1. state is pinned to the install folder (exe dir), never the cwd
//   2. state left behind by the old cwd-based build is recovered, and a
//      destination that already holds real data is never clobbered
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeDirs, migrateLegacyDataDir, isSeedStateFile, hasRealState } from "../../src/core/data-dir.js";

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omniclaw-data-dir-${tag}-`));
}

/** What scripts/build-windows-portable.mjs writes into a fresh install. */
function seedPortableData(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify({ sessions: [] }, null, 2));
  fs.writeFileSync(path.join(dataDir, "memory.json"), JSON.stringify({
    notes: [], recentConversations: [], research: [], artifacts: [], longTerm: [], dreams: [], promotionCandidates: [],
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, "tasks.json"), JSON.stringify({ tasks: [] }, null, 2));
  fs.writeFileSync(path.join(dataDir, "jobs.json"), JSON.stringify({ jobs: [] }, null, 2));
  fs.writeFileSync(path.join(dataDir, "schedules.json"), JSON.stringify({ schedules: [] }, null, 2));
  fs.writeFileSync(path.join(dataDir, "shell-audit.json"), JSON.stringify({ records: [] }, null, 2));
  fs.writeFileSync(path.join(dataDir, "gateway.json"), JSON.stringify({ events: [], runs: [], approvals: [], delegations: [] }, null, 2));
  fs.writeFileSync(path.join(dataDir, "secrets.json"), JSON.stringify({ providerKeys: {} }, null, 2));
  fs.writeFileSync(path.join(dataDir, "MEMORY.md"), "# OmniClaw Memory\n\nFresh portable build. User data will be written here after launch.\n");
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
}

function writeRealSessions(dataDir, count) {
  const sessions = Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    title: `session ${i}`,
    updatedAt: new Date(2026, 0, i + 1).toISOString(),
  }));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify({ version: 2, sessions }, null, 2));
  return sessions;
}

test("packaged build pins state to the exe folder, NOT the working directory", () => {
  const root = tmpRoot("pin");
  const installDir = path.join(root, "C-Apps-OmniClaw");
  const launchDir = path.join(root, "Desktop");
  fs.mkdirSync(path.join(installDir, "public"), { recursive: true });
  fs.mkdirSync(launchDir, { recursive: true });

  const dirs = resolveRuntimeDirs({
    pkg: true,
    execPath: path.join(installDir, "omniclaw-gateway.exe"),
    cwd: launchDir,
    sourceDir: path.join(root, "src"),
    env: {},
  });

  assert.equal(dirs.appDir, installDir, "state must follow the install folder");
  assert.equal(dirs.dataDir, path.join(installDir, "data"));
  assert.equal(dirs.runtimeDir, installDir);
  assert.equal(dirs.isolated, false);
});

test("OMNICLAW_DATA_DIR still wins and is flagged isolated (R11)", () => {
  const root = tmpRoot("isolated");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(path.join(root, "install", "public"), { recursive: true });

  const dirs = resolveRuntimeDirs({
    pkg: true,
    execPath: path.join(root, "install", "omniclaw-gateway.exe"),
    cwd: path.join(root, "install"),
    sourceDir: path.join(root, "src"),
    env: { OMNICLAW_DATA_DIR: scratch },
  });

  assert.equal(dirs.appDir, scratch);
  assert.equal(dirs.dataDir, path.join(scratch, "data"));
  assert.equal(dirs.isolated, true);
});

test("dev (non-packaged) keeps sourceDir/OMNICLAW_ROOT_DIR behaviour", () => {
  const sourceDir = tmpRoot("src");
  const dirs = resolveRuntimeDirs({ pkg: false, cwd: sourceDir, sourceDir, env: {} });
  assert.equal(dirs.appDir, dirs.runtimeDir);
  assert.equal(dirs.runtimeDir, sourceDir);

  const override = resolveRuntimeDirs({ pkg: false, cwd: sourceDir, sourceDir, env: { OMNICLAW_ROOT_DIR: "/somewhere/else" } });
  assert.equal(override.runtimeDir, path.resolve("/somewhere/else"));
});

test("a bare exe with no public/ next to it still serves assets from the cwd", () => {
  const root = tmpRoot("bare");
  const launchDir = path.join(root, "loose");
  fs.mkdirSync(path.join(launchDir, "public"), { recursive: true });
  fs.mkdirSync(path.join(root, "exe-only"), { recursive: true });

  const dirs = resolveRuntimeDirs({
    pkg: true,
    execPath: path.join(root, "exe-only", "omniclaw-gateway.exe"),
    cwd: launchDir,
    sourceDir: path.join(root, "src"),
    env: {},
  });

  assert.equal(dirs.runtimeDir, launchDir, "assets fall back to the folder that has public/");
  assert.equal(dirs.appDir, path.join(root, "exe-only"), "but state stays pinned to the exe folder");
});

test("portable seed files are recognised as seeds, real data is not", () => {
  const root = tmpRoot("seed");
  const seedDir = path.join(root, "seed", "data");
  const realDir = path.join(root, "real", "data");
  seedPortableData(seedDir);
  writeRealSessions(realDir, 3);

  assert.equal(isSeedStateFile(path.join(seedDir, "sessions.json")), true);
  assert.equal(isSeedStateFile(path.join(seedDir, "MEMORY.md")), true);
  assert.equal(isSeedStateFile(path.join(seedDir, "secrets.json")), true);
  assert.equal(isSeedStateFile(path.join(realDir, "sessions.json")), false);
  assert.equal(isSeedStateFile(path.join(realDir, "nope.json")), true, "missing file is safe to write");

  assert.equal(hasRealState(seedDir), false);
  assert.equal(hasRealState(realDir), true);
});

test("startup recovers real state from the old cwd folder into a seeded install", () => {
  const root = tmpRoot("recover");
  const installDir = path.join(root, "install");
  const launchDir = path.join(root, "Desktop");
  seedPortableData(path.join(installDir, "data"));

  const sessions = writeRealSessions(path.join(launchDir, "data"), 7);
  fs.writeFileSync(path.join(launchDir, "data", "memory.json"), JSON.stringify({ version: 1, notes: ["remembered"] }));
  fs.mkdirSync(path.join(launchDir, "data", "sessions", "s0"), { recursive: true });
  fs.writeFileSync(path.join(launchDir, "data", "sessions", "s0", "transcript.json"), "{}");

  const logs = [];
  const outcome = migrateLegacyDataDir({
    dataDir: path.join(installDir, "data"),
    legacyDirs: [launchDir, installDir],
    log: (m) => logs.push(m),
  });

  assert.equal(outcome.from, launchDir);
  assert.ok(outcome.copied.includes("sessions.json"), "sessions.json must be recovered");
  assert.ok(outcome.copied.includes("memory.json"));
  assert.ok(outcome.copied.includes("sessions/"));

  const restored = JSON.parse(fs.readFileSync(path.join(installDir, "data", "sessions.json"), "utf8"));
  assert.equal(restored.sessions.length, sessions.length, "all sessions come back, not a truncated list");
  assert.equal(restored.sessions[0].title, "session 0");
  assert.ok(fs.existsSync(path.join(installDir, "data", "sessions", "s0", "transcript.json")));
  assert.ok(logs.some((l) => l.includes("recovered")), "recovery must be logged, not silent");
});

test("recovery NEVER overwrites a destination that already has real data", () => {
  const root = tmpRoot("noclobber");
  const installDir = path.join(root, "install");
  const launchDir = path.join(root, "Desktop");

  writeRealSessions(path.join(installDir, "data"), 2);
  fs.writeFileSync(path.join(installDir, "data", "memory.json"), JSON.stringify({ version: 1, notes: ["installed"] }));
  writeRealSessions(path.join(launchDir, "data"), 9);

  const outcome = migrateLegacyDataDir({
    dataDir: path.join(installDir, "data"),
    legacyDirs: [launchDir],
  });

  assert.deepEqual(outcome.copied, [], "nothing may be copied over real data");
  const kept = JSON.parse(fs.readFileSync(path.join(installDir, "data", "sessions.json"), "utf8"));
  assert.equal(kept.sessions.length, 2);
  assert.ok(outcome.kept.includes("sessions.json"));
});

test("recovery is a no-op when the legacy folder is itself empty, and idempotent", () => {
  const root = tmpRoot("noop");
  const installDir = path.join(root, "install");
  const launchDir = path.join(root, "Desktop");
  seedPortableData(path.join(installDir, "data"));
  seedPortableData(path.join(launchDir, "data"));   // another fresh install, nothing to rescue

  const first = migrateLegacyDataDir({ dataDir: path.join(installDir, "data"), legacyDirs: [launchDir] });
  assert.equal(first.from, null);
  assert.deepEqual(first.copied, []);

  writeRealSessions(path.join(launchDir, "data"), 4);
  const second = migrateLegacyDataDir({ dataDir: path.join(installDir, "data"), legacyDirs: [launchDir] });
  assert.equal(second.from, launchDir);
  const third = migrateLegacyDataDir({ dataDir: path.join(installDir, "data"), legacyDirs: [launchDir] });
  assert.deepEqual(third.copied, [], "a second startup must not re-copy anything");
});

test("recovery passes the same folder as its own target through untouched", () => {
  const root = tmpRoot("self");
  const installDir = path.join(root, "install");
  writeRealSessions(path.join(installDir, "data"), 2);
  const outcome = migrateLegacyDataDir({ dataDir: path.join(installDir, "data"), legacyDirs: [installDir] });
  assert.equal(outcome.from, null);
  assert.deepEqual(outcome.copied, []);
});
