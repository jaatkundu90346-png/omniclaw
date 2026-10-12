import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STORE_VERSION = 1;
const MAX_RECENTS = 12;

// Folders we never let the agent treat as a workspace root. Picking one of
// these would hand the agent write access to the OS, the app itself, or the
// user's entire home directory.
const BLOCKED_ROOTS = new Set([
  "c:", "c:\\", "c:/",
  "/", "\\",
]);

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizePath(inputPath) {
  const text = String(inputPath || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return path.resolve(text);
}

function shortName(inputPath) {
  const resolved = normalizePath(inputPath);
  if (!resolved) return "";
  return path.basename(resolved) || resolved;
}

// A stable, filesystem-safe id for a workspace path. Used to scope chat
// history per folder, so two different folders never share a session.
export function workspaceIdFor(inputPath) {
  const resolved = normalizePath(inputPath);
  if (!resolved) return "default";
  // On Windows, `C:\foo` and `c:\Foo` are the same folder — lowercase first.
  const normalizedForId = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return normalizedForId.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
}

export class WorkspaceStore {
  // `appDir` is where OmniClaw keeps its OWN state (config, sessions, secrets).
  // `defaultRoot` is the fallback workspace (the app dir) so behaviour is
  // unchanged until the user actively picks a different folder.
  constructor(appDir, defaultRoot = null) {
    this.appDir = appDir;
    this.defaultRoot = normalizePath(defaultRoot || appDir);
    this.filePath = path.join(appDir, "data", "workspaces.json");
    this.ensureStorage();
  }

  ensureStorage() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(this.createEmptyStore());
      return;
    }
    // Re-read so a store written by an older version gets normalized.
    const data = this.read();
    this.write(data);
  }

  createEmptyStore() {
    return {
      version: STORE_VERSION,
      activePath: "",
      recents: [],
    };
  }

  read() {
    const parsed = safeJsonParse(fs.readFileSync(this.filePath, "utf8"), this.createEmptyStore());
    return {
      version: STORE_VERSION,
      activePath: String(parsed.activePath || "").trim(),
      recents: Array.isArray(parsed.recents) ? parsed.recents.filter(Boolean).slice(0, MAX_RECENTS) : [],
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return data;
  }

  // The workspace the agent should operate in right now. Falls back to the
  // app dir when nothing has been selected yet, and to the app dir when the
  // remembered folder no longer exists (deleted drive, unplugged USB, etc).
  getActivePath() {
    const data = this.read();
    const active = normalizePath(data.activePath);
    if (active && this.isUsableDirectory(active)) {
      return active;
    }
    return this.defaultRoot;
  }

  getActiveId() {
    return workspaceIdFor(this.getActivePath());
  }

  isUsableDirectory(target) {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  // Rejects paths that would give the agent far more power than intended:
  // drive roots, the OS root, and the filesystem root.
  isBlockedPath(target) {
    const resolved = normalizePath(target);
    if (!resolved) return true;
    const probe = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (BLOCKED_ROOTS.has(probe)) return true;
    if (process.platform === "win32" && /^[a-z]:[\\/]?$/.test(probe)) return true;
    return false;
  }

  validateCandidate(inputPath) {
    const resolved = normalizePath(inputPath);
    if (!resolved) {
      return { ok: false, error: "A folder path is required." };
    }
    if (this.isBlockedPath(resolved)) {
      return { ok: false, error: "Pick a project folder, not a drive root." };
    }
    if (!this.isUsableDirectory(resolved)) {
      return { ok: false, error: `Folder does not exist: ${resolved}` };
    }
    return { ok: true, path: resolved };
  }

  setActive(inputPath) {
    const check = this.validateCandidate(inputPath);
    if (!check.ok) {
      return check;
    }
    const resolved = check.path;
    const data = this.read();
    data.activePath = resolved;
    data.recents = [
      { path: resolved, name: shortName(resolved), usedAt: new Date().toISOString() },
      ...data.recents.filter((entry) => normalizePath(entry.path) !== resolved),
    ].slice(0, MAX_RECENTS);
    this.write(data);
    return { ok: true, path: resolved, id: workspaceIdFor(resolved), name: shortName(resolved) };
  }

  listRecents() {
    const data = this.read();
    return data.recents
      .map((entry) => ({
        path: normalizePath(entry.path),
        name: entry.name || shortName(entry.path),
        usedAt: entry.usedAt || null,
        exists: this.isUsableDirectory(normalizePath(entry.path)),
      }))
      .slice(0, MAX_RECENTS);
  }

  // Used by /api/workspace so the UI can render picker + git branch state.
  getState() {
    const activePath = this.getActivePath();
    return {
      activePath,
      activeId: workspaceIdFor(activePath),
      activeName: shortName(activePath),
      isDefault: normalizePath(activePath) === this.defaultRoot,
      recents: this.listRecents(),
    };
  }

  // Directory listing for the server-side folder browser. Deliberately
  // shallow (one level) and skips noise so it stays fast on huge drives.
  browse(inputPath) {
    const raw = String(inputPath || "").trim();
    const target = raw ? normalizePath(raw) : this.getActivePath();
    if (!this.isUsableDirectory(target)) {
      return { ok: false, error: `Folder does not exist: ${target}`, path: target };
    }

    let entries = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (error) {
      return { ok: false, error: error.message, path: target };
    }

    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => ({
        name: entry.name,
        path: path.join(target, entry.name),
        hasChildren: this.hasSubdirectories(path.join(target, entry.name)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const parent = path.dirname(target);
    return {
      ok: true,
      path: target,
      parent: parent && parent !== target ? parent : null,
      isGitRepo: fs.existsSync(path.join(target, ".git")),
      directories: dirs,
    };
  }

  hasSubdirectories(target) {
    try {
      return fs
        .readdirSync(target, { withFileTypes: true })
        .some((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    } catch {
      return false;
    }
  }
}

export { normalizePath as normalizeWorkspacePath, shortName as workspaceName };
