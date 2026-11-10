/**
 * Where OmniClaw keeps its state, and how it recovers state from an older
 * install folder.
 *
 * THE BUG THIS FIXES
 * ------------------
 * server.js used to resolve the state directory like this:
 *
 *     const runtimeDir = process.pkg ? process.cwd() : <sourceDir>;
 *     const appDir     = process.env.OMNICLAW_DATA_DIR || runtimeDir;
 *
 * so a packaged build stored sessions/memory/config wherever the process
 * HAPPENED to be started from. Launching OmniClaw.exe from the install folder
 * and launching the same exe from a desktop shortcut with a different
 * "Start in" produced TWO different state folders. The new folder did not
 * "lose" anything - it started empty (the portable build ships seed files) -
 * but to the user every session, memory and API key had vanished, and the
 * original data was still sitting in the folder nobody was looking at.
 *
 * THE RULE
 * --------
 * A packaged build pins BOTH its assets and its state to the folder that
 * physically contains the exe (path.dirname(process.execPath)), which is the
 * same root scripts/windows-launcher.mjs uses. The working directory is only
 * consulted for assets when the exe folder has no public/ next to it (an exe
 * copied out on its own), and never for state.
 *
 * OMNICLAW_DATA_DIR still wins outright - an isolated verification instance
 * (R11) must never touch the live install's data, so no recovery runs there.
 *
 * RECOVERY
 * --------
 * migrateLegacyDataDir() runs once per packaged startup, before the agent is
 * constructed. It copies a state file from a legacy folder ONLY when the
 * destination is missing or still a seed file, and NEVER overwrites a file
 * that holds real content. So it can rescue a folder that already has data,
 * and it can never destroy one.
 */

import fs from "node:fs";
import path from "node:path";

/** Top-level state files a portable build seeds empty (build-windows-portable.mjs). */
const SEED_FILES = [
  "sessions.json",
  "memory.json",
  "gateway.json",
  "usage.json",
  "tasks.json",
  "jobs.json",
  "schedules.json",
  "shell-audit.json",
  "secrets.json",
  "trust.json",
  "connectors.json",
  "workspaces.json",
  "app-connections.json",
  "acp-sessions.json",
  "config.json",
  "MEMORY.md",
  "MEMORY.md.txt",
];

/** State subdirectories worth carrying over (session transcripts, artifacts). */
const STATE_DIRS = [
  "sessions",
  "checkpoints",
  "semantic-memory",
  "evolution",
  "bots",
  "attachments",
];

const MIN_SEED_BYTES = 512;

/** Portable build writes this exact header into MEMORY.md. */
const SEED_MEMORY_HEADER = "Fresh portable build";

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function jsonLooksSeeded(value) {
  if (value == null || typeof value !== "object") return true;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  // { v, enc, salt, iv, tag, data } is the encrypted-secret envelope: an
  // encrypted empty store is still just a seed.
  if (keys.length === 1 && keys[0] === "data") return true;
  for (const key of keys) {
    const inner = value[key];
    if (Array.isArray(inner)) {
      if (inner.length > 0) return false;
      continue;
    }
    if (inner && typeof inner === "object") {
      if (Object.keys(inner).length > 0) return false;
      continue;
    }
    if (typeof inner === "number" || typeof inner === "boolean") {
      // Schema bookkeeping carries no payload. A file whose every value is a
      // number/bool holds no user data, whatever the key is called.
      continue;
    }
    if (inner !== null && inner !== undefined && inner !== "") return false;
  }
  return true;
}

/**
 * True when a state file is absent or still an untouched seed, i.e. safe to
 * overwrite. Anything that fails to parse is treated as REAL data (never
 * clobbered) - a corrupt file is something to recover, not to replace.
 */
export function isSeedStateFile(filePath) {
  const stat = safeStat(filePath);
  if (!stat) return true;
  if (!stat.isFile()) return false;
  const name = path.basename(filePath);
  if (stat.size === 0) return true;
  if (name === "MEMORY.md" || name === "MEMORY.md.txt") {
    let text = "";
    try {
      text = fs.readFileSync(filePath, "utf8").slice(0, 400);
    } catch {
      return false;
    }
    return text.includes(SEED_MEMORY_HEADER);
  }
  if (name.endsWith(".json")) {
    const parsed = readJson(filePath);
    if (parsed === null) return false;          // unparseable ⇒ real data
    return jsonLooksSeeded(parsed);
  }
  // Unknown extension: only a tiny file is assumed to be a seed.
  return stat.size < MIN_SEED_BYTES;
}

/** True when this folder holds state worth migrating. */
export function hasRealState(dataDir) {
  if (!dataDir) return false;
  for (const name of SEED_FILES) {
    if (!isSeedStateFile(path.join(dataDir, name))) return true;
  }
  for (const name of STATE_DIRS) {
    const stat = safeStat(path.join(dataDir, name));
    if (stat && stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(dataDir, name));
      } catch {
        continue;
      }
      if (entries.length > 0) return true;
    }
  }
  return false;
}

function copyFileNoClobber(from, to) {
  // Seed → seed is a no-op. Copying it would make every startup report a
  // "recovery" and the log would cry wolf.
  if (isSeedStateFile(from)) return "skipped-seed";
  const targetStat = safeStat(to);
  if (targetStat && targetStat.isDirectory()) return "skipped-dir";
  if (!isSeedStateFile(to)) return "kept-existing";
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return "copied";
  } catch {
    return "failed";
  }
}

function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function copyDirIfEmpty(from, to) {
  if (isEmptyDir(from)) return "skipped-seed";      // nothing worth rescuing
  const stat = safeStat(to);
  if (stat) {
    if (!stat.isDirectory()) return "kept-existing";
    if (!isEmptyDir(to)) return "kept-existing";
  }
  try {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * One-shot recovery of state from folders an older build may have used.
 *
 * @param {object}   opts
 * @param {string}   opts.dataDir     the state dir this process will use
 * @param {string[]} opts.legacyDirs  candidate old state roots (e.g. cwd)
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ from: string|null, copied: string[], kept: string[] }}
 */
export function migrateLegacyDataDir({ dataDir, legacyDirs = [], log = () => {} }) {
  const result = { from: null, copied: [], kept: [] };
  if (!dataDir) return result;

  const target = path.resolve(dataDir);
  const seen = new Set([target.toLowerCase()]);

  for (const legacyRoot of legacyDirs) {
    if (!legacyRoot) continue;
    const legacy = path.resolve(legacyRoot);
    const key = legacy.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const legacyData = path.join(legacy, "data");
    const legacyStat = safeStat(legacyData);
    if (!legacyStat || !legacyStat.isDirectory()) continue;
    if (!hasRealState(legacyData)) continue;

    let legacyFiles = [];
    try {
      legacyFiles = fs.readdirSync(legacyData, { withFileTypes: true });
    } catch {
      continue;
    }

    let copiedHere = 0;
    for (const entry of legacyFiles) {
      if (!entry.isFile()) continue;
      const from = path.join(legacyData, entry.name);
      const to = path.join(target, entry.name);
      const outcome = copyFileNoClobber(from, to);
      if (outcome === "copied") {
        result.copied.push(entry.name);
        copiedHere += 1;
      } else if (outcome === "kept-existing") {
        result.kept.push(entry.name);
      }
    }

    for (const name of STATE_DIRS) {
      const from = path.join(legacyData, name);
      if (!safeStat(from)?.isDirectory()) continue;
      const outcome = copyDirIfEmpty(from, path.join(target, name));
      if (outcome === "copied") {
        result.copied.push(`${name}/`);
        copiedHere += 1;
      }
    }

    if (copiedHere > 0) {
      result.from = legacy;
      log(
        `[data-dir] recovered ${copiedHere} state file(s) from ${legacy} → ${target}. ` +
        `Nothing existing was overwritten.`,
      );
      break;   // first legacy folder with real state wins; do not mix sources
    }
    log(`[data-dir] ${legacy} still holds state but ${target} already does — left untouched.`);
  }

  return result;
}

/**
 * Resolve the asset root and the state root for this process.
 *
 * @param {object} opts
 * @param {boolean} [opts.pkg]        true when running from a packaged exe
 * @param {string}  [opts.execPath]   process.execPath
 * @param {string}  [opts.cwd]        process.cwd()
 * @param {string}  [opts.sourceDir]  __dirname of server.js
 * @param {object}  [opts.env]        process.env
 */
export function resolveRuntimeDirs({ pkg = false, execPath = "", cwd = "", sourceDir = "", env = process.env } = {}) {
  const cwdDir = cwd ? path.resolve(cwd) : "";
  const exeDir = pkg && execPath ? path.dirname(path.resolve(execPath)) : "";

  // Assets: the install folder wins; a bare exe copied elsewhere still works
  // because we fall back to the cwd that actually has public/ next to it.
  let runtimeDir;
  if (pkg) {
    const exeHasAssets = exeDir && fs.existsSync(path.join(exeDir, "public"));
    const cwdHasAssets = cwdDir && fs.existsSync(path.join(cwdDir, "public"));
    runtimeDir = exeHasAssets || !cwdHasAssets ? (exeDir || cwdDir) : cwdDir;
  } else {
    runtimeDir = path.resolve(env.OMNICLAW_ROOT_DIR || sourceDir || cwdDir || ".");
  }

  // State: NEVER the cwd for a packaged build. That single line is what made
  // sessions "disappear" every time the launch folder changed.
  const explicitDataDir = env.OMNICLAW_DATA_DIR ? path.resolve(env.OMNICLAW_DATA_DIR) : "";
  const appDir = explicitDataDir || (pkg ? (exeDir || cwdDir) : runtimeDir);

  return {
    runtimeDir,
    appDir,
    dataDir: path.join(appDir, "data"),
    exeDir,
    cwdDir,
    isolated: Boolean(explicitDataDir),
  };
}
