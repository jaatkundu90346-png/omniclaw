// Path helpers (display only) + workspace id parsing.

// Port of workspaceIdFor() from src/core/workspace-store.js:42-48 — SAME
// algorithm (lowercase on win32-equivalent input, non-alnum runs -> "-",
// trim dashes, 80 chars, fallback "default"). No hash involved, so this
// sync port is exact; do not approximate. In the browser we cannot read
// process.platform, so callers pass the already-normalized absolute path
// exactly as the server sends it (activePath / recents[].path).
export function workspaceIdForPath(inputPath) {
  const resolved = String(inputPath || "").trim();
  if (!resolved) return "default";
  const normalizedForId = resolved.toLowerCase();
  return (
    normalizedForId.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) ||
    "default"
  );
}

export function basename(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

export function dirname(p) {
  const s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? s.slice(0, i + 1) || s : s.slice(0, i);
}

// "C:\Users\PA…\hello.md" — keep start + end so the filename stays visible.
export function middleEllipsis(p, max = 40) {
  const s = String(p || "");
  if (s.length <= max) return s;
  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

// Windows display only: forward slashes -> backslashes. Never send this
// back to the backend; requests always use the raw server path.
export function display(p) {
  return String(p || "").replace(/\//g, "\\");
}

// Session workspace association (C3): session.key ends with ":ws:<workspaceId>"
// e.g. "agent:main:webchat:chat-09-03:ws:c-users-x". Returns null if absent
// (pre-workspace legacy keys "agent:id:channel:label").
export function workspaceIdFromSessionKey(key) {
  const m = String(key || "").match(/:ws:([^:]+)$/);
  return m ? m[1] : null;
}
