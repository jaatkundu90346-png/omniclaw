import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function ensureWithinRoot(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the allowed workspace.");
  }

  return resolvedCandidate;
}

export class FileStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
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

    return ensureWithinRoot(this.rootDir, path.join(this.rootDir, normalized));
  }

  listDirectory(relativePath = ".") {
    const target = this.resolveWorkspacePath(relativePath);
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
  }

  readText(relativePath, maxBytes = 64 * 1024) {
    const target = this.resolveWorkspacePath(relativePath);
    const buffer = fs.readFileSync(target);
    const sliced = buffer.subarray(0, maxBytes);
    return {
      path: relativePath,
      truncated: buffer.length > maxBytes,
      content: sliced.toString("utf8"),
      bytesRead: sliced.length,
      totalBytes: buffer.length,
    };
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
