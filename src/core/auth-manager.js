import crypto from "node:crypto";

export class AuthManager {
  constructor({ configStore, secretStore }) {
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.tokens = new Map();
    this.rateLimits = new Map();
    this.blockedIps = new Set();
  }

  generateToken(length = 32) {
    return crypto.randomBytes(length).toString("hex");
  }

  createToken({ label, scopes, expiresAt, maxUses }) {
    const token = this.generateToken();
    this.tokens.set(token, {
      token: token.slice(0, 8) + "..." + token.slice(-4),
      fullToken: token,
      label: label || "unnamed",
      scopes: scopes || ["read", "write"],
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt || null,
      maxUses: maxUses || 0,
      useCount: 0,
      active: true,
    });
    return { token, fullToken: token };
  }

  validateToken(token) {
    if (!token) return { valid: false, reason: "no-token" };

    for (const [fullToken, info] of this.tokens) {
      if (fullToken === token) {
        if (!info.active) return { valid: false, reason: "revoked" };
        if (info.expiresAt && new Date(info.expiresAt) < new Date()) {
          return { valid: false, reason: "expired" };
        }
        if (info.maxUses > 0 && info.useCount >= info.maxUses) {
          return { valid: false, reason: "max-uses-reached" };
        }
        info.useCount++;
        return { valid: true, scopes: info.scopes, label: info.label };
      }
    }

    const config = this.configStore?.getConfig?.() || {};
    const gatewayToken = config.gateway?.token || "";
    if (gatewayToken && token === gatewayToken) {
      return { valid: true, scopes: ["read", "write", "admin"], label: "gateway-token" };
    }

    return { valid: false, reason: "invalid" };
  }

  revokeToken(token) {
    for (const [fullToken, info] of this.tokens) {
      if (fullToken === token) {
        info.active = false;
        return { revoked: true, token: info.token };
      }
    }
    return { revoked: false, reason: "not-found" };
  }

  listTokens() {
    return Array.from(this.tokens.values()).map((t) => ({
      token: t.token,
      label: t.label,
      scopes: t.scopes,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      useCount: t.useCount,
      maxUses: t.maxUses,
      active: t.active,
    }));
  }

  checkRateLimit(key, maxRequests = 60, windowMs = 60000) {
    const now = Date.now();
    const entry = this.rateLimits.get(key);

    if (!entry || now - entry.start > windowMs) {
      this.rateLimits.set(key, { start: now, count: 1 });
      return { allowed: true, remaining: maxRequests - 1, resetAt: now + windowMs };
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.start + windowMs };
    }

    return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.start + windowMs };
  }

  blockIp(ip, reason = "", durationMs = 3600000) {
    this.blockedIps.add(ip);
    if (durationMs > 0) {
      setTimeout(() => this.blockedIps.delete(ip), durationMs);
    }
    return { blocked: true, ip, reason };
  }

  isIpBlocked(ip) {
    return this.blockedIps.has(ip);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.rateLimits) {
      if (now - entry.start > 120000) {
        this.rateLimits.delete(key);
      }
    }

    for (const [token, info] of this.tokens) {
      if (info.expiresAt && new Date(info.expiresAt) < new Date()) {
        info.active = false;
      }
    }
  }

  getStatus() {
    return {
      activeTokens: Array.from(this.tokens.values()).filter((t) => t.active).length,
      totalTokens: this.tokens.size,
      rateLimitEntries: this.rateLimits.size,
      blockedIps: this.blockedIps.size,
    };
  }
}
