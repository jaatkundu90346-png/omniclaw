import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureWithinRoot(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // E4: name BOTH sides so a scope error is diagnosable from the UI alone —
    // distinct from "file not found" (the file may exist outside the root).
    throw new Error(`Path is outside the allowed workspace. Attempted: ${resolvedCandidate} — project root: ${resolvedRoot}. Use a path inside the project root, or the computer toolset for elsewhere.`);
  }

  return resolvedCandidate;
}

// Single source of truth for session-ledger path keys (evidence ledger +
// read cache). Absolute + canonicalized (realpath collapses 8.3 short names,
// junctions and symlinks) + forward slashes + lowercase, so the agent-side
// builder and the registry-side checker always agree byte-for-byte.
export function normalizeLedgerKey(rootDir, p) {
  try {
    const abs = path.resolve(rootDir || ".", String(p || ""));
    let canonical = abs;
    try {
      canonical = fs.realpathSync(abs);
    } catch {
      canonical = abs;
    }
    return canonical.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  } catch {
    return String(p || "").replace(/\\/g, "/").toLowerCase();
  }
}

export class FileStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  // Swaps the sandbox root when the user picks a different workspace folder.
  // Every path helper below reads `this.rootDir`, so one call re-scopes all
  // file tools to the newly selected folder.
  setRootDir(rootDir) {
    const next = String(rootDir || "").trim();
    if (!next) return this.rootDir;
    this.rootDir = next;
    return this.rootDir;
  }

  expandPath(inputPath) {
    const text = String(inputPath || "").trim();
    if (!text) {
      throw new Error("A file path is required.");
    }
    if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
      return path.join(os.homedir(), text.slice(2));
    }
    return path.isAbsolute(text) ? text : path.join(this.rootDir, text);
  }

  resolveComputerPath(inputPath, policy = {}) {
    const target = path.resolve(this.expandPath(inputPath));
    const roots = Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0
      ? policy.allowedRoots
      : ["~"];
    const allowed = roots.some((root) => {
      const resolvedRoot = path.resolve(this.expandPath(root));
      const relative = path.relative(resolvedRoot, target);
      return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!allowed) {
      throw new Error("Path is outside configured computer access roots.");
    }

    const blockedPatterns = Array.isArray(policy.blockedPathPatterns) ? policy.blockedPathPatterns : [];
    const normalized = target.replace(/\\/g, "/");
    const blocked = blockedPatterns.find((pattern) => new RegExp(pattern, "i").test(normalized));
    if (blocked) {
      throw new Error(`Path is blocked by computer access policy: ${blocked}`);
    }
    return target;
  }

  resolveWorkspacePath(relativePath) {
    const normalized = String(relativePath || "").trim().replace(/^[/\\]+/, "");
    if (!normalized) {
      throw new Error("A relative workspace path is required.");
    }

    // Absolute paths (drive-letter or UNC, which models emit routinely) are
    // honored as-is and then confined — never joined onto the root, which
    // used to mangle them into nonsense and block even in-project paths.
    const target = path.isAbsolute(normalized)
      ? path.normalize(normalized)
      : path.join(this.rootDir, normalized);
    return ensureWithinRoot(this.rootDir, target);
  }

  listDirectory(relativePath = ".") {
    const target = this.resolveWorkspacePath(relativePath);
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
  }

  // Recursive listing for fast codebase mapping. Bounded by depth and entry
  // count, skips heavy/noise directories. Returns workspace-relative paths.
  listDirectoryRecursive(relativePath = ".", options = {}) {
    const root = this.resolveWorkspacePath(relativePath);
    const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth || 4)));
    const maxEntries = Math.max(1, Math.min(5000, Number(options.maxEntries || 800)));
    const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".cache", "data", ".research", ".mavis", "screenshots", "logs"]);
    const out = [];
    let truncated = false;

    const walk = (dir, depth) => {
      if (truncated || depth > maxDepth) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (out.length >= maxEntries) { truncated = true; return; }
        if (entry.isDirectory() && (skipDirs.has(entry.name) || entry.name.startsWith("."))) continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(this.rootDir, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          out.push({ path: rel, type: "directory" });
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          out.push({ path: rel, type: "file" });
        }
      }
    };

    walk(root, 1);
    return {
      path: path.relative(this.rootDir, root).replace(/\\/g, "/") || ".",
      recursive: true,
      count: out.length,
      truncated,
      entries: out,
    };
  }

  // Locate files by (base)name for "did you mean" suggestions when a read/edit
  // names a path that doesn't exist — models constantly drop a folder segment
  // or misremember paths, and a bare ENOENT dead-ends the round.
  findFilesByName(name, { maxResults = 5 } = {}) {
    const base = String(name || "").trim().toLowerCase();
    if (!base) return [];
    const stem = base.replace(/\.[^.]+$/, "");
    const exact = [];
    const partial = [];
    const SKIP_DIRS = /^(node_modules|\.git|\.hg|dist|build|out|coverage|vendor|\.next|\.cache|\.claude|\.hermes|\.mavis)$/i;
    const walk = (dir, depth) => {
      if (depth > 8 || exact.length >= maxResults) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (exact.length >= maxResults) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.test(entry.name)) walk(full, depth + 1);
          continue;
        }
        const lower = entry.name.toLowerCase();
        const rel = path.relative(this.rootDir, full).replace(/\\/g, "/");
        if (lower === base) exact.push(rel);
        else if (stem.length >= 4 && partial.length < maxResults && lower.includes(stem)) partial.push(rel);
      }
    };
    walk(this.rootDir, 0);
    return exact.length ? exact.slice(0, maxResults) : partial.slice(0, maxResults);
  }

  readText(relativePath, maxBytes = 64 * 1024, options = {}) {
    const target = this.resolveWorkspacePath(relativePath);
    let buffer;
    try {
      buffer = fs.readFileSync(target);
    } catch (error) {
      if (error?.code === "EISDIR") {
        throw new Error(`"${String(relativePath)}" is a directory, not a file (attempted: ${target}). Use list_files on it to see what's inside.`);
      }
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        const candidates = this.findFilesByName(path.basename(String(relativePath || "")));
        const suggest = candidates.length
          ? ` Did you mean: ${candidates.join(" , ")} ?`
          : "";
        // E3/E4: missing-file reads name the RESOLVED absolute path attempted
        // (plus the project root), so a doubled root like
        // "<root>/Desktop/new window/STARTUP.md" is visible in the UI without
        // reading logs — and stays DISTINCT from scope/permission errors.
        throw new Error(`File not found: ${String(relativePath)} (attempted absolute path: ${target}; project root: ${path.resolve(this.rootDir)}).${suggest} Paths are relative to the project root — use list_files or search_text to locate the file, do NOT retry guessed path variations.`);
      }
      throw error;
    }

    const offset = Math.max(0, Number(options.offset || 0));
    const limit = Number(options.limit || 0) > 0 ? Number(options.limit) : 0;
    const wantsLineNumbers = Boolean(options.lineNumbers);
    // Line-window reads must slice from the WHOLE file (capped), not the
    // byte-preview prefix — otherwise an offset past the first `maxBytes`
    // silently returned empty/wrong lines for large files.
    const LINE_WINDOW_CAP = 10 * 1024 * 1024;

    let content;
    let bytesRead;
    let cap;
    let lineWindow = null;
    if (offset > 0 || limit > 0) {
      cap = LINE_WINDOW_CAP;
      const fullText = buffer.subarray(0, cap).toString("utf8");
      const allLines = fullText.split("\n");
      const start = offset > 0 ? offset - 1 : 0;
      const end = limit > 0 ? start + limit : allLines.length;
      const windowLines = allLines.slice(start, end);
      content = windowLines.join("\n");
      bytesRead = Buffer.byteLength(content, "utf8");
      lineWindow = { startLine: start + 1, endLine: Math.min(end, allLines.length), totalLines: allLines.length };
    } else {
      cap = maxBytes;
      const sliced = buffer.subarray(0, maxBytes);
      content = sliced.toString("utf8");
      bytesRead = sliced.length;
    }

    const truncated = buffer.length > cap;
    const result = {
      path: relativePath,
      truncated,
      content,
      bytesRead,
      totalBytes: buffer.length,
    };
    if (lineWindow) {
      result.lineWindow = lineWindow;
      result.totalLines = lineWindow.totalLines;
    } else {
      // Count true total lines from the whole file (cheap newline scan) so the
      // caller can map an error "line N" to a read window even when the byte
      // preview was truncated before line N.
      let nl = 0;
      for (let i = 0; i < buffer.length; i += 1) { if (buffer[i] === 0x0a) nl += 1; }
      result.totalLines = nl + 1;
    }
    // When a full read is cut off at the byte cap, the model otherwise has no
    // idea that the line it needs (e.g. an error at line 599) is past the
    // preview, nor how to reach it. Hand it an exact next call.
    if (truncated && !lineWindow) {
      const linesShown = content.split("\n").length;
      result.linesShown = linesShown;
      result.readHint = `File is ${result.totalLines} lines but only the first ${linesShown} are shown (byte cap). To see a later line N, call read_file again with offset:N-20, limit:60.`;
    }
    if (wantsLineNumbers) {
      const baseLine = lineWindow ? lineWindow.startLine : 1;
      result.numberedContent = content
        .split("\n")
        .map((line, index) => `${baseLine + index}\t${line}`)
        .join("\n");
    }
    return result;
  }

  // Recursive regex content search (grep-like) bounded by file count, file
  // size, total matches, and a wall-clock budget so it stays cheap on large
  // trees. Returns matches with 1-based line numbers.
  searchText(pattern, options = {}) {
    const root = this.resolveWorkspacePath(options.path || ".");
    const flags = options.ignoreCase ? "i" : "";
    const rawPattern = String(pattern || "");
    if (!rawPattern) {
      return { ok: false, error: "pattern is required." };
    }
    // Models often pass the pattern wrapped in slashes (/spawn|enter/ or
    // /foo/i) — unwrap it, otherwise the slashes become literal characters
    // and the search silently matches nothing.
    let effectivePattern = rawPattern;
    let effectiveFlags = flags;
    const slashWrapped = rawPattern.match(/^\/(.+)\/([a-z]*)$/s);
    if (slashWrapped) {
      effectivePattern = slashWrapped[1];
      if (slashWrapped[2].includes("i") && !effectiveFlags.includes("i")) {
        effectiveFlags += "i";
      }
    }
    // ReDoS guard: the pattern is model/user-controlled and runs synchronously
    // on every line, so a catastrophic-backtracking regex (nested unbounded
    // quantifiers like (a+)+, (.*)*) could hang the single-threaded gateway on a
    // long line. Reject the classic nested-quantifier shape up front.
    if (/\([^)]*[+*][^)]*\)\s*[+*]|\([^)]*[+*][^)]*\)\s*\{\d*,?\d*\}/.test(effectivePattern)) {
      return { ok: false, error: "Pattern rejected: nested unbounded quantifiers (e.g. (a+)+) risk catastrophic backtracking. Simplify the regex.", pattern: rawPattern };
    }
    let regex;
    try {
      regex = new RegExp(effectivePattern, effectiveFlags);
    } catch (error) {
      return { ok: false, error: `Invalid regex: ${error.message}`, pattern: rawPattern };
    }
    // Cap the input a single regex.test() sees — bounds worst-case backtracking
    // time. Lines longer than this (minified bundles / data blobs) are rarely a
    // useful grep target and are the main ReDoS vector.
    const MAX_LINE_SCAN = 20000;

    const maxResults = Math.max(1, Math.min(1000, Number(options.maxResults || 200)));
    const maxFileBytes = Math.max(1024, Number(options.maxFileBytes || 1024 * 1024));
    const maxFiles = Math.max(1, Math.min(20000, Number(options.maxFiles || 5000)));
    const maxScanMs = Math.max(500, Math.min(30000, Number(options.maxScanMs || 8000)));
    const contextLines = Math.max(0, Math.min(5, Number(options.contextLines || 0)));
    const globRegex = options.glob ? this.globToRegExp(options.glob) : null;
    const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".cache", "data", ".research", ".mavis", "screenshots"]);

    const deadline = Date.now() + maxScanMs;
    const matches = [];
    let filesScanned = 0;
    let truncated = false;

    const scanFile = (full, byteCap = maxFileBytes) => {
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return;
      }
      if (stat.size > byteCap) return;
      filesScanned += 1;
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        return;
      }
      if (text.includes("\u0000")) return; // skip binary
      const rel = path.relative(this.rootDir, full).replace(/\\/g, "/");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        // Bail out between lines if the wall-clock budget is exhausted, so a
        // huge file can't blow past maxScanMs.
        if ((i & 255) === 0 && Date.now() > deadline) { truncated = true; return; }
        const scanLine = lines[i].length > MAX_LINE_SCAN ? lines[i].slice(0, MAX_LINE_SCAN) : lines[i];
        if (regex.test(scanLine)) {
          const match = {
            file: rel,
            line: i + 1,
            text: lines[i].slice(0, 400),
          };
          if (contextLines > 0) {
            match.before = lines.slice(Math.max(0, i - contextLines), i).map((l) => l.slice(0, 200));
            match.after = lines.slice(i + 1, i + 1 + contextLines).map((l) => l.slice(0, 200));
          }
          matches.push(match);
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    };

    const walk = (dir) => {
      if (truncated || Date.now() > deadline || filesScanned >= maxFiles || matches.length >= maxResults) {
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= maxResults || Date.now() > deadline || filesScanned >= maxFiles) {
          truncated = true;
          return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(this.rootDir, full).replace(/\\/g, "/");
          if (globRegex && !globRegex.test(rel) && !globRegex.test(entry.name)) continue;
          scanFile(full);
          if (truncated) return;
        }
      }
    };

    // A FILE path scans that one file directly — this used to fall into the
    // directory walker, whose readdirSync threw, and the search silently
    // returned 0 matches (the VehicleController.ts bug: "methods exist but
    // search says 0"). Single named files also get a generous byte cap.
    let rootStat = null;
    try {
      rootStat = fs.statSync(root);
    } catch {
      return { ok: false, error: `Path not found: ${String(options.path || ".")}`, pattern: rawPattern, matches: [], matchCount: 0 };
    }
    if (rootStat.isFile()) {
      scanFile(root, Math.max(maxFileBytes, 10 * 1024 * 1024));
    } else {
      walk(root);
    }
    return {
      ok: true,
      pattern: String(pattern || ""),
      path: path.relative(this.rootDir, root).replace(/\\/g, "/") || ".",
      glob: options.glob || "",
      matchCount: matches.length,
      filesScanned,
      truncated: truncated || Date.now() > deadline,
      matches,
    };
  }

  // Discovers the project's verification commands (feedback subsystem) from
  // the conventional sources, so the agent runs the REAL command instead of
  // guessing. Returns ordered, de-duplicated entries with their source.
  discoverProjectVerification() {
    const commands = [];
    const seen = new Set();
    const add = (name, command, source) => {
      const key = String(command || "").trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      commands.push({ name, command: key, source });
    };
    const readSafe = (rel) => {
      try {
        const target = this.resolveWorkspacePath(rel);
        return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      } catch {
        return "";
      }
    };

    // 1. package.json scripts (test / build / lint / typecheck / check)
    const pkgRaw = readSafe("package.json");
    if (pkgRaw) {
      try {
        const scripts = JSON.parse(pkgRaw).scripts || {};
        const runner = fs.existsSync(this.resolveWorkspacePath("yarn.lock"))
          ? "yarn"
          : fs.existsSync(this.resolveWorkspacePath("pnpm-lock.yaml"))
            ? "pnpm"
            : "npm run";
        for (const key of ["check", "verify", "test", "build", "lint", "typecheck", "type-check", "tsc"]) {
          if (scripts[key]) add(key, `${runner} ${key}`.replace("npm run test", "npm test"), "package.json");
        }
      } catch {
        // malformed package.json; ignore
      }
    }

    // 2. Makefile check/test targets
    const makefile = readSafe("Makefile");
    if (makefile) {
      for (const target of ["check", "test", "lint"]) {
        if (new RegExp(`^${target}:`, "m").test(makefile)) add(target, `make ${target}`, "Makefile");
      }
    }

    // 3. Python project hints
    const pyproject = readSafe("pyproject.toml");
    if (pyproject || readSafe("setup.cfg") || readSafe("pytest.ini")) {
      if (/pytest/.test(pyproject) || readSafe("pytest.ini") || readSafe("tests")) add("pytest", "pytest -q", "pyproject/python");
      if (/mypy/.test(pyproject)) add("mypy", "mypy .", "pyproject");
      if (/ruff/.test(pyproject)) add("ruff", "ruff check .", "pyproject");
    }

    // 4. Explicit "Verification commands" block in AGENTS.md / CLAUDE.md
    for (const docName of ["AGENTS.md", "CLAUDE.md", "AGENT.md"]) {
      const doc = readSafe(docName);
      if (!doc) continue;
      // Scan only the Verification section: from its heading to the next "##".
      const headingMatch = doc.match(/##+\s*verification[^\n]*\n/i);
      let scan = "";
      if (headingMatch) {
        const start = headingMatch.index + headingMatch[0].length;
        const rest = doc.slice(start);
        const nextHeading = rest.search(/\n##+\s/);
        scan = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
      }
      const lines = scan.split("\n");
      for (const line of lines) {
        // Only treat backticked tokens that actually look like commands (contain
        // a runner/verb), not architecture file-path bullets.
        const m = line.match(/`([^`]+)`/);
        const candidate = m && m[1] ? m[1].trim() : "";
        if (candidate && /\b(npm|yarn|pnpm|make|pytest|mypy|ruff|go|cargo|node|tsc|eslint|jest|vitest|test|build|lint|check)\b/i.test(candidate)) {
          add("doc", candidate, docName);
        }
      }
    }

    // 5. Agent-written smoke/verify scripts (scripts/smoke-*.mjs etc.) — the
    // agent's own past verification, runnable directly with node. This is what
    // makes "keep your repro as a smoke script" pay off in future runs.
    try {
      const scriptsDir = this.resolveWorkspacePath("scripts");
      if (fs.existsSync(scriptsDir)) {
        // Most-recently-modified first: with many smoke scripts, the ones being
        // worked on now are the relevant verification, not alphabetical luck.
        const smokeScripts = fs.readdirSync(scriptsDir)
          .filter((f) => /^(smoke|verify|repro)[\w.-]*\.(mjs|cjs|js)$/i.test(f) || /[\w-]*-smoke[\w.-]*\.(mjs|cjs|js)$/i.test(f))
          .map((f) => {
            try { return { f, mtime: fs.statSync(path.join(scriptsDir, f)).mtimeMs || 0 }; } catch { return { f, mtime: 0 }; }
          })
          .sort((a, b) => b.mtime - a.mtime)
          .map((entry) => entry.f)
          .slice(0, 3);
        for (const f of smokeScripts) add(f.replace(/\.\w+$/, ""), `node scripts/${f}`, "smoke-script");
      }
    } catch { /* best effort */ }

    return { hasAny: commands.length > 0, commands };
  }

  // "Knowledge near code": walk from a file's directory up toward the project
  // root, collecting module-level docs (ARCHITECTURE/CONSTRAINTS/AGENTS/CLAUDE)
  // that live BELOW the root — the root docs are already in global context.
  // So when the agent reaches code, it also reaches that module's constraints.
  findNearbyDocs(relativePath, maxDocs = 3, excerptChars = 700) {
    const docNames = ["CONSTRAINTS.md", "ARCHITECTURE.md", "AGENTS.md", "CLAUDE.md"];
    const out = [];
    const seen = new Set();
    try {
      const rootResolved = path.resolve(this.rootDir);
      let dir = path.dirname(this.resolveWorkspacePath(relativePath));
      for (let depth = 0; depth < 12; depth += 1) {
        const resolvedDir = path.resolve(dir);
        // Stop once we reach (or pass) the root: root docs are already loaded.
        if (resolvedDir === rootResolved || !resolvedDir.startsWith(rootResolved)) break;
        for (const name of docNames) {
          const docPath = path.join(resolvedDir, name);
          if (seen.has(docPath) || !fs.existsSync(docPath)) continue;
          seen.add(docPath);
          const rel = path.relative(this.rootDir, docPath).replace(/\\/g, "/");
          const content = fs.readFileSync(docPath, "utf8");
          out.push({ path: rel, excerpt: content.slice(0, excerptChars) });
          if (out.length >= maxDocs) return out;
        }
        const parent = path.dirname(resolvedDir);
        if (parent === resolvedDir) break;
        dir = parent;
      }
    } catch {
      // Best effort; never block a read on doc discovery.
    }
    return out;
  }

  // Feature list (lecture 08): the machine-readable single source of truth for
  // project scope. Each feature carries the triple {behavior, verification,
  // state} so the scheduler/verifier/handoff components can all read it.
  readFeatureList() {
    try {
      const target = this.resolveWorkspacePath("feature_list.json");
      if (!fs.existsSync(target)) return { exists: false, features: [] };
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      const features = Array.isArray(parsed?.features) ? parsed.features : Array.isArray(parsed) ? parsed : [];
      return { exists: true, features };
    } catch (error) {
      return { exists: false, features: [], error: error.message };
    }
  }

  writeFeatureList(features, options = {}) {
    const list = Array.isArray(features) ? features : [];
    const body = `${JSON.stringify({ features: list, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    return this.writeText("feature_list.json", body, {
      allowedRoots: options.allowedRoots || ["."],
      append: false,
    });
  }

  // Architectural boundary rules (lecture 10): executable checks that turn
  // architecture constraints into mechanical enforcement. Each rule = {id,
  // description, glob, forbidden (regex), fix (agent-oriented instruction)}.
  readArchRules() {
    try {
      const target = this.resolveWorkspacePath("arch_rules.json");
      if (!fs.existsSync(target)) return { exists: false, rules: [] };
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      const rules = Array.isArray(parsed?.rules) ? parsed.rules : Array.isArray(parsed) ? parsed : [];
      return { exists: true, rules };
    } catch (error) {
      return { exists: false, rules: [], error: error.message };
    }
  }

  writeArchRules(rules, options = {}) {
    const list = Array.isArray(rules) ? rules : [];
    const body = `${JSON.stringify({ rules: list, updatedAt: new Date().toISOString() }, null, 2)}\n`;
    return this.writeText("arch_rules.json", body, {
      allowedRoots: options.allowedRoots || ["."],
      append: false,
    });
  }

  // Scans for session leftovers (lecture 12 clean-state): debug statements and
  // temp files that increase the next session's cognitive load. Returns offenders
  // so they can be removed before handoff. Bounded like searchText.
  scanStaleArtifacts(options = {}) {
    const debugMarkers = [];
    // Debug code in source — bounded, skips node_modules/.git/dist/data/etc.
    const patterns = [
      { kind: "debugger", regex: "\\bdebugger\\b" },
      { kind: "debug-marker", regex: "(FIXME|XXX|HACK)\\b" },
      { kind: "console-debug", regex: "console\\.log\\([\"'`]?(DEBUG|TEST|TODO REMOVE|temp)" },
    ];
    for (const p of patterns) {
      try {
        const res = this.searchText(p.regex, { glob: options.glob || "**/*.{js,mjs,cjs,ts,tsx,jsx,py,go,rs}", maxResults: 40 });
        for (const m of (res.matches || [])) {
          debugMarkers.push({ kind: p.kind, file: m.file, line: m.line, text: m.text.slice(0, 120) });
        }
      } catch { /* best effort */ }
    }
    // Temp files anywhere in the tree (bounded recursive listing).
    const tempFiles = [];
    try {
      const tree = this.listDirectoryRecursive(".", { maxDepth: 6, maxEntries: 3000 });
      const tempRe = /(^|\/)(debug-.*\.log|.*\.tmp|.*\.bak|\.DS_Store|.*\.orig|npm-debug\.log)$/i;
      for (const e of tree.entries) {
        if (e.type === "file" && tempRe.test(e.path)) tempFiles.push(e.path);
      }
    } catch { /* best effort */ }
    return {
      clean: debugMarkers.length === 0 && tempFiles.length === 0,
      debugMarkerCount: debugMarkers.length,
      tempFileCount: tempFiles.length,
      debugMarkers: debugMarkers.slice(0, 40),
      tempFiles: tempFiles.slice(0, 40),
    };
  }

  // Reads the current PROGRESS.md (state subsystem) if present.
  readProgress() {
    try {
      const target = this.resolveWorkspacePath("PROGRESS.md");
      if (!fs.existsSync(target)) return { exists: false, content: "" };
      return { exists: true, content: fs.readFileSync(target, "utf8") };
    } catch {
      return { exists: false, content: "" };
    }
  }

  // Reads DECISIONS.md (the "why" log) if present.
  readDecisions() {
    try {
      const target = this.resolveWorkspacePath("DECISIONS.md");
      if (!fs.existsSync(target)) return { exists: false, content: "" };
      return { exists: true, content: fs.readFileSync(target, "utf8") };
    } catch {
      return { exists: false, content: "" };
    }
  }

  globToRegExp(glob) {
    // "**/" matches zero-or-more directory segments (src/x/**/*.js also matches
    // src/x/top.js); "**" any span; "*" within a segment; "?" one non-slash char;
    // "{a,b,c}" matches any alternative (e.g. *.{js,ts}).
    const groups = [];
    const withGroups = String(glob || "").replace(/\{([^{}]*)\}/g, (_, inner) => {
      groups.push(inner.split(",").map((s) => s.trim()));
      return `BRACEGROUP${groups.length - 1}TOKEN`;
    });
    let escaped = withGroups
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "DBLSTARSLASH_TOKEN")
      .replace(/\*\*/g, "DBLSTAR_TOKEN")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/DBLSTARSLASH_TOKEN/g, "(?:[^/]+/)*")
      .replace(/DBLSTAR_TOKEN/g, ".*");
    escaped = escaped.replace(/BRACEGROUP(\d+)TOKEN/g, (_, i) => {
      const alts = (groups[Number(i)] || []).map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, "\\$&"));
      return `(?:${alts.join("|")})`;
    });
    return new RegExp(`(^|/)${escaped}$`, "i");
  }

  writeText(relativePath, content, options = {}) {
    const target = this.resolveWorkspacePath(relativePath);
    const allowedRoots = options.allowedRoots || [];
    const writable = allowedRoots.some((allowedRoot) => {
      const allowedPath = this.resolveWorkspacePath(allowedRoot);
      const relative = path.relative(allowedPath, target);
      return !(relative.startsWith("..") || path.isAbsolute(relative));
    });

    if (!writable) {
      throw new Error("Target path is outside the allowed writable roots.");
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (options.append) {
      fs.appendFileSync(target, content, "utf8");
    } else {
      fs.writeFileSync(target, content, "utf8");
    }

    return {
      path: relativePath,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      appended: Boolean(options.append),
    };
  }

  // Create a folder (and any parent folders) inside the workspace writable
  // roots. Cross-platform mkdir -p equivalent — gives the model a reliable named
  // tool instead of a shell `mkdir` that fails on PowerShell.
  createDirectory(relativePath, options = {}) {
    const target = this.resolveWorkspacePath(relativePath);
    const allowedRoots = options.allowedRoots || [];
    const writable = allowedRoots.some((allowedRoot) => {
      const allowedPath = this.resolveWorkspacePath(allowedRoot);
      const relative = path.relative(allowedPath, target);
      return !(relative.startsWith("..") || path.isAbsolute(relative));
    });
    if (!writable) {
      throw new Error("Target path is outside the allowed writable roots.");
    }
    const existed = fs.existsSync(target);
    fs.mkdirSync(target, { recursive: true });
    return { path: relativePath, type: "directory", created: !existed, alreadyExisted: existed };
  }

  listComputerDirectory(inputPath = "~", policy = {}) {
    const target = this.resolveComputerPath(inputPath || "~", policy);
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return {
      path: target,
      entries: entries.map((entry) => {
        const absolutePath = path.join(target, entry.name);
        let size = 0;
        let modifiedAt = null;
        try {
          const stat = fs.statSync(absolutePath);
          size = stat.size;
          modifiedAt = stat.mtime.toISOString();
        } catch {
          // Best-effort metadata only.
        }
        return {
          name: entry.name,
          path: absolutePath,
          type: entry.isDirectory() ? "directory" : "file",
          size,
          modifiedAt,
        };
      }),
    };
  }

  searchComputerFiles(input = {}, policy = {}) {
    const query = String(input.query || input.pattern || input.name || "").trim().toLowerCase();
    if (!query) {
      throw new Error("A search query is required.");
    }

    const maxResults = Math.max(1, Math.min(500, Number(input.maxResults || 80)));
    const maxDepth = Math.max(0, Math.min(12, Number(input.maxDepth ?? 4)));
    const maxScanMs = Math.max(500, Math.min(30000, Number(input.maxScanMs || 7000)));
    const startedAt = Date.now();
    const roots = input.path || input.root
      ? [input.path || input.root]
      : Array.isArray(policy.allowedRoots) && policy.allowedRoots.length > 0
        ? policy.allowedRoots
        : ["~"];
    const results = [];
    const skipped = [];
    let timedOut = false;
    let scannedDirectories = 0;

    for (const root of roots) {
      if (results.length >= maxResults || timedOut) {
        break;
      }
      let start;
      try {
        start = this.resolveComputerPath(root, policy);
        if (!fs.existsSync(start)) {
          skipped.push({ path: root, reason: "root does not exist" });
          continue;
        }
      } catch (error) {
        skipped.push({ path: root, reason: error.message });
        continue;
      }

      const stack = [{ dir: start, depth: 0 }];
      while (stack.length > 0 && results.length < maxResults) {
        if (Date.now() - startedAt > maxScanMs) {
          timedOut = true;
          break;
        }
        const current = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(current.dir, { withFileTypes: true });
          scannedDirectories += 1;
        } catch (error) {
          skipped.push({ path: current.dir, reason: error.code || error.message });
          continue;
        }

        for (const entry of entries) {
          if (Date.now() - startedAt > maxScanMs) {
            timedOut = true;
            break;
          }
          if (results.length >= maxResults) {
            break;
          }
          const absolutePath = path.join(current.dir, entry.name);
          try {
            this.resolveComputerPath(absolutePath, policy);
          } catch {
            continue;
          }
          if (entry.isSymbolicLink()) {
            continue;
          }

          let stat = null;
          try {
            stat = fs.statSync(absolutePath);
          } catch {
            // Metadata is best effort.
          }
          if (entry.name.toLowerCase().includes(query)) {
            results.push({
              name: entry.name,
              path: absolutePath,
              type: entry.isDirectory() ? "directory" : "file",
              size: stat?.size || 0,
              modifiedAt: stat?.mtime ? stat.mtime.toISOString() : null,
            });
          }
          if (entry.isDirectory() && current.depth < maxDepth) {
            stack.push({ dir: absolutePath, depth: current.depth + 1 });
          }
        }
      }
    }

    return {
      query,
      roots,
      maxDepth,
      maxResults,
      maxScanMs,
      scannedDirectories,
      results,
      skipped: skipped.slice(0, 50),
      truncated: results.length >= maxResults || timedOut,
      timedOut,
      elapsedMs: Date.now() - startedAt,
    };
  }

  readComputerText(inputPath, maxBytes = 128 * 1024, policy = {}) {
    const target = this.resolveComputerPath(inputPath, policy);
    const buffer = fs.readFileSync(target);
    const sliced = buffer.subarray(0, maxBytes);
    return {
      path: target,
      truncated: buffer.length > maxBytes,
      content: sliced.toString("utf8"),
      bytesRead: sliced.length,
      totalBytes: buffer.length,
    };
  }

  writeComputerText(inputPath, content, options = {}) {
    const policy = options.policy || {};
    if (policy.allowWrite === false) {
      throw new Error("Computer file writes are disabled by policy.");
    }
    const target = this.resolveComputerPath(inputPath, policy);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (options.append) {
      fs.appendFileSync(target, content, "utf8");
    } else {
      fs.writeFileSync(target, content, "utf8");
    }
    return {
      path: target,
      bytesWritten: Buffer.byteLength(content, "utf8"),
      appended: Boolean(options.append),
    };
  }

  createComputerDirectory(inputPath, policy = {}) {
    if (policy.allowWrite === false) {
      throw new Error("Computer directory writes are disabled by policy.");
    }
    const target = this.resolveComputerPath(inputPath, policy);
    fs.mkdirSync(target, { recursive: true });
    return {
      path: target,
      created: true,
    };
  }

  copyComputerPath(fromPath, toPath, options = {}) {
    const policy = options.policy || {};
    if (policy.allowWrite === false) {
      throw new Error("Computer file copies are disabled by policy.");
    }
    const source = this.resolveComputerPath(fromPath, policy);
    const destination = this.resolveComputerPath(toPath, policy);
    if (!fs.existsSync(source)) {
      throw new Error("Source path does not exist.");
    }
    if (fs.existsSync(destination) && !options.overwrite) {
      throw new Error("Destination already exists. Pass overwrite=true to replace it.");
    }

    const stat = fs.statSync(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (stat.isDirectory()) {
      fs.cpSync(source, destination, {
        recursive: true,
        force: Boolean(options.overwrite),
        errorOnExist: !options.overwrite,
      });
    } else {
      fs.copyFileSync(source, destination, options.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
    }
    return {
      source,
      destination,
      copied: true,
      overwritten: Boolean(options.overwrite),
      type: stat.isDirectory() ? "directory" : "file",
      bytes: stat.isDirectory() ? 0 : stat.size,
    };
  }

  moveComputerPath(fromPath, toPath, options = {}) {
    const policy = options.policy || {};
    if (policy.allowWrite === false || policy.allowDelete === false) {
      throw new Error("Computer file moves are disabled by policy.");
    }
    const source = this.resolveComputerPath(fromPath, policy);
    const destination = this.resolveComputerPath(toPath, policy);
    if (!fs.existsSync(source)) {
      throw new Error("Source path does not exist.");
    }
    if (fs.existsSync(destination) && !options.overwrite) {
      throw new Error("Destination already exists. Pass overwrite=true to replace it.");
    }

    const stat = fs.statSync(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (options.overwrite && fs.existsSync(destination)) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if (error.code !== "EXDEV") {
        throw error;
      }
      this.copyComputerPath(source, destination, { policy, overwrite: Boolean(options.overwrite) });
      fs.rmSync(source, { recursive: true, force: true });
    }
    return {
      source,
      destination,
      moved: true,
      overwritten: Boolean(options.overwrite),
      type: stat.isDirectory() ? "directory" : "file",
      bytes: stat.isDirectory() ? 0 : stat.size,
    };
  }

  deleteComputerPath(inputPath, options = {}) {
    const policy = options.policy || {};
    if (policy.allowDelete === false) {
      throw new Error("Computer file deletes are disabled by policy.");
    }
    const target = this.resolveComputerPath(inputPath, policy);
    if (!fs.existsSync(target)) {
      return {
        path: target,
        deleted: false,
        reason: "Path does not exist.",
      };
    }

    const permanent = Boolean(options.permanent && policy.allowPermanentDelete);
    if (permanent) {
      fs.rmSync(target, { recursive: true, force: true });
      return {
        path: target,
        deleted: true,
        permanent: true,
      };
    }

    const trashRoot = path.join(this.rootDir, policy.trashDir || "data/trash");
    fs.mkdirSync(trashRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(trashRoot, `${stamp}-${path.basename(target)}`);
    fs.renameSync(target, destination);
    return {
      path: target,
      deleted: true,
      permanent: false,
      movedTo: destination,
      restoreHint: "Move this path back from data/trash to restore it.",
    };
  }

  // ─── Path Security ────────────────────────────────────────────
  sanitizePath(inputPath) {
    const text = String(inputPath || "").trim();
    if (text.includes("\0") || text.includes("..")) {
      throw new Error("Invalid path: contains null bytes or directory traversal");
    }
    const resolved = path.resolve(this.rootDir, text);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error("Path traversal blocked: path escapes workspace root");
    }
    return resolved;
  }
}
