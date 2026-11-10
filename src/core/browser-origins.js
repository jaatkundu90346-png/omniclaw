import fs from "node:fs";
import path from "node:path";

/**
 * Per-session origin allowlist for browser navigation.
 * Codex stores this as ~/.codex/browser/sessions/<uuid>.toml with
 * [origins] allowed = [...]. OmniClaw mirrors the concept with JSON
 * under <rootDir>/data/browser-sessions/<sanitized-session>.json so
 * R11 isolated instances never collide.
 *
 * Default: localhost + the project's own origins are always allowed.
 * First navigation to a remote origin auto-records it (so the agent can
 * browse without friction) but the recorded list is then enforced:
 * subsequent opens to a NEW remote origin in the same session require
 * an explicit allow via POST /api/browser/origins or browser_allow_origin.
 */
function sanitizeSessionId(id) {
  return String(id || "default").replace(/[^\w\-]/g, "_").slice(0, 80) || "default";
}

export function originOf(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol === "file:") return "file://";
    return u.origin; // https://example.com
  } catch { return ""; }
}

export function isLocalOrigin(origin) {
  return /^(https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?|file:\/\/|about:)/i.test(String(origin || ""));
}

export class BrowserOrigins {
  constructor(rootDir) {
    this.dir = path.join(rootDir || process.cwd(), "data", "browser-sessions");
  }

  fileFor(sessionId) {
    return path.join(this.dir, `${sanitizeSessionId(sessionId)}.json`);
  }

  load(sessionId) {
    try {
      const raw = fs.readFileSync(this.fileFor(sessionId), "utf8");
      const j = JSON.parse(raw);
      return { allowed: Array.isArray(j.origins) ? j.origins : [], sessionId };
    } catch { return { allowed: [], sessionId }; }
  }

  save(sessionId, allowed) {
    const f = this.fileFor(sessionId);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ origins: [...new Set(allowed)], updatedAt: new Date().toISOString() }, null, 2));
  }

  /**
   * Returns {allowed: bool, reason}. Browsing must never be blocked by the
   * allowlist — the list is for TRACKING (audit / "show me what sites the
   * agent visited"), like Codex ~/.codex/browser/sessions/*.toml. Every
   * remote origin is recorded and allowed, so opening github.com after
   * example.com just works. Enforcing a block here broke real browsing
   * (user saw EORIGIN and could not open any second site).
   */
  check(sessionId, url) {
    const origin = originOf(url);
    if (!origin) return { allowed: false, reason: "invalid url" };
    if (isLocalOrigin(origin)) return { allowed: true };
    const { allowed } = this.load(sessionId);
    if (allowed.includes(origin)) return { allowed: true };
    // Record and allow — never block. The allowlist is audit, not a gate.
    this.save(sessionId, [...allowed, origin]);
    return { allowed: true, first: allowed.length === 0, recorded: true };
  }

  add(sessionId, origin) {
    const o = originOf(origin) || String(origin || "");
    if (!o) return { error: "origin is required" };
    const { allowed } = this.load(sessionId);
    if (!allowed.includes(o)) { allowed.push(o); this.save(sessionId, allowed); }
    return { ok: true, origins: allowed };
  }
}

export default BrowserOrigins;
