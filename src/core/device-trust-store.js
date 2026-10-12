import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createToken(prefix = "omni") {
  return `${prefix}_${crypto.randomBytes(24).toString("base64url")}`;
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function maskToken(value) {
  const token = String(value || "");
  return token ? `${token.slice(0, 8)}...${token.slice(-6)}` : "";
}

function safeEqualHash(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeRole(role) {
  const value = String(role || "operator").trim().toLowerCase();
  return value === "node" ? "node" : "operator";
}

function scopesForRole(role) {
  return normalizeRole(role) === "node"
    ? ["node.read", "node.write"]
    : ["operator.read", "operator.write", "operator.approvals"];
}

function parseMs(value, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return Math.round(parsed);
}

function futureIso(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString();
}

function publicAuditRecord(record = {}) {
  return {
    id: record.id || createId("trust_audit"),
    action: String(record.action || "trust.event"),
    status: String(record.status || "info"),
    actor: String(record.actor || "system"),
    targetType: String(record.targetType || "trust"),
    targetId: String(record.targetId || ""),
    summary: String(record.summary || ""),
    note: String(record.note || ""),
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata : {},
    createdAt: record.createdAt || new Date().toISOString(),
  };
}

export class DeviceTrustStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "trust.json");
    this.gatewayTokenTtlMs = parseMs(process.env.OMNICLAW_GATEWAY_TOKEN_TTL_MS, 1000 * 60 * 60 * 24 * 30);
    this.deviceTokenTtlMs = parseMs(process.env.OMNICLAW_DEVICE_TOKEN_TTL_MS, 1000 * 60 * 60 * 24 * 90);
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      const token = createToken("omni_gateway");
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            gateway: {
              tokenHash: hashSecret(token),
              tokenPreview: maskToken(token),
              status: "active",
              issuedAt: new Date().toISOString(),
              rotatedAt: new Date().toISOString(),
              expiresAt: futureIso(this.gatewayTokenTtlMs),
              lastUsedAt: null,
              revokedAt: null,
            },
            devices: [],
            pairingRequests: [],
            audit: [],
          },
          null,
          2,
        ),
      );
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const gateway = parsed.gateway && typeof parsed.gateway === "object" ? parsed.gateway : {};
    const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
    const audit = Array.isArray(parsed.audit) ? parsed.audit : [];
    const nowIso = new Date().toISOString();
    return {
      gateway: {
        status: "active",
        issuedAt: gateway.rotatedAt || nowIso,
        expiresAt: gateway.expiresAt || futureIso(this.gatewayTokenTtlMs),
        lastUsedAt: null,
        revokedAt: null,
        ...gateway,
      },
      devices: devices.map((device) => ({
        status: "trusted",
        issuedAt: device.approvedAt || device.createdAt || nowIso,
        expiresAt: device.expiresAt || futureIso(this.deviceTokenTtlMs),
        lastUsedAt: device.lastSeenAt || null,
        revokedAt: device.revokedAt || null,
        ...device,
      })),
      pairingRequests: Array.isArray(parsed.pairingRequests) ? parsed.pairingRequests : [],
      audit,
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  addAudit(data, input = {}) {
    const record = publicAuditRecord(input);
    data.audit = [record, ...(Array.isArray(data.audit) ? data.audit : [])].slice(0, 250);
    return record;
  }

  deriveAudit(data = this.read()) {
    const records = [];
    const gateway = data.gateway || {};
    if (gateway.rotatedAt || gateway.issuedAt) {
      records.push(
        publicAuditRecord({
          id: "trust_audit_gateway_current",
          action: "trust.gateway_token_rotated",
          status: gateway.status || "active",
          actor: "system",
          targetType: "gateway",
          targetId: "gateway",
          summary: `Gateway token ${gateway.tokenPreview || "configured"} is ${gateway.status || "active"}.`,
          createdAt: gateway.rotatedAt || gateway.issuedAt,
          metadata: {
            masked: gateway.tokenPreview || "",
            expiresAt: gateway.expiresAt || null,
          },
        }),
      );
    }
    if (gateway.revokedAt) {
      records.push(
        publicAuditRecord({
          id: "trust_audit_gateway_revoked",
          action: "trust.gateway_token_revoked",
          status: "revoked",
          actor: "operator",
          targetType: "gateway",
          targetId: "gateway",
          summary: "Gateway token was revoked.",
          note: gateway.note || "",
          createdAt: gateway.revokedAt,
        }),
      );
    }

    for (const request of data.pairingRequests || []) {
      records.push(
        publicAuditRecord({
          id: `trust_audit_${request.id}_requested`,
          action: "trust.pairing_requested",
          status: request.status || "pending",
          actor: "device",
          targetType: "pairing",
          targetId: request.id,
          summary: `${request.label || request.id} requested ${request.role || "operator"} pairing.`,
          createdAt: request.requestedAt,
          metadata: {
            role: request.role || "",
            remoteAddress: request.remoteAddress || "",
            fingerprint: request.fingerprint || "",
          },
        }),
      );
      if (request.resolvedAt) {
        records.push(
          publicAuditRecord({
            id: `trust_audit_${request.id}_${request.status}`,
            action: `trust.pairing_${request.status}`,
            status: request.status,
            actor: "operator",
            targetType: "pairing",
            targetId: request.id,
            summary: `${request.label || request.id} pairing was ${request.status}.`,
            note: request.note || "",
            createdAt: request.resolvedAt,
            metadata: {
              deviceId: request.deviceId || "",
              role: request.role || "",
            },
          }),
        );
      }
    }

    for (const device of data.devices || []) {
      if (device.revokedAt) {
        records.push(
          publicAuditRecord({
            id: `trust_audit_${device.id}_revoked`,
            action: "trust.device_revoked",
            status: "revoked",
            actor: "operator",
            targetType: "device",
            targetId: device.id,
            summary: `${device.label || device.id} was revoked.`,
            note: device.note || "",
            createdAt: device.revokedAt,
            metadata: {
              role: device.role || "",
              tokenPreview: device.tokenPreview || "",
            },
          }),
        );
      }
      if (device.tokenRotatedAt) {
        records.push(
          publicAuditRecord({
            id: `trust_audit_${device.id}_token_rotated`,
            action: "trust.device_token_rotated",
            status: device.status || "trusted",
            actor: "operator",
            targetType: "device",
            targetId: device.id,
            summary: `${device.label || device.id} token was rotated.`,
            createdAt: device.tokenRotatedAt,
            metadata: {
              role: device.role || "",
              tokenPreview: device.tokenPreview || "",
            },
          }),
        );
      }
    }

    return records
      .filter((record) => record.createdAt)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  getGatewayStatus() {
    const gateway = this.read().gateway;
    return {
      configured: Boolean(gateway.tokenHash),
      masked: gateway.tokenPreview || "",
      status: gateway.status || "active",
      issuedAt: gateway.issuedAt || null,
      rotatedAt: gateway.rotatedAt || null,
      expiresAt: gateway.expiresAt || null,
      lastUsedAt: gateway.lastUsedAt || null,
      revokedAt: gateway.revokedAt || null,
    };
  }

  rotateGatewayToken() {
    const data = this.read();
    const token = createToken("omni_gateway");
    data.gateway = {
      tokenHash: hashSecret(token),
      tokenPreview: maskToken(token),
      status: "active",
      issuedAt: new Date().toISOString(),
      rotatedAt: new Date().toISOString(),
      expiresAt: futureIso(this.gatewayTokenTtlMs),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.addAudit(data, {
      action: "trust.gateway_token_rotated",
      status: "active",
      actor: "operator",
      targetType: "gateway",
      targetId: "gateway",
      summary: `Gateway token rotated: ${data.gateway.tokenPreview}.`,
      metadata: {
        masked: data.gateway.tokenPreview,
        expiresAt: data.gateway.expiresAt,
      },
    });
    this.write(data);
    return {
      token,
      status: this.getGatewayStatus(),
    };
  }

  revokeGatewayToken(note = "") {
    const data = this.read();
    if (!data.gateway.tokenHash) {
      throw new Error("Gateway token is not configured.");
    }
    data.gateway.status = "revoked";
    data.gateway.revokedAt = new Date().toISOString();
    data.gateway.note = String(note || "").trim();
    this.addAudit(data, {
      action: "trust.gateway_token_revoked",
      status: "revoked",
      actor: "operator",
      targetType: "gateway",
      targetId: "gateway",
      summary: "Gateway token revoked.",
      note: data.gateway.note,
      createdAt: data.gateway.revokedAt,
    });
    this.write(data);
    return this.getGatewayStatus();
  }

  verifyGatewayToken(token) {
    const value = String(token || "");
    if (!value) {
      return false;
    }
    const data = this.read();
    const gateway = data.gateway || {};
    if (gateway.status === "revoked" || !gateway.tokenHash) {
      return false;
    }
    if (gateway.expiresAt && Date.now() > new Date(gateway.expiresAt).getTime()) {
      gateway.status = "expired";
      gateway.revokedAt = gateway.revokedAt || new Date().toISOString();
      this.addAudit(data, {
        action: "trust.gateway_token_expired",
        status: "expired",
        actor: "system",
        targetType: "gateway",
        targetId: "gateway",
        summary: "Gateway token expired.",
        createdAt: gateway.revokedAt,
      });
      this.write(data);
      return false;
    }
    const ok = safeEqualHash(hashSecret(value), gateway.tokenHash);
    if (ok) {
      gateway.lastUsedAt = new Date().toISOString();
      this.addAudit(data, {
        action: "trust.gateway_token_used",
        status: "active",
        actor: "gateway",
        targetType: "gateway",
        targetId: "gateway",
        summary: "Gateway token accepted.",
        createdAt: gateway.lastUsedAt,
      });
      this.write(data);
    }
    return ok;
  }

  requestPairing(input = {}) {
    const data = this.read();
    const fingerprint = String(input.fingerprint || "").trim() || createId("fingerprint");
    const existingDevice = data.devices.find(
      (device) => device.fingerprint === fingerprint && device.status === "trusted",
    );
    if (existingDevice) {
      return {
        trusted: false,
        tokenRequired: true,
        device: this.publicDevice(existingDevice),
      };
    }

    const existingRequest = data.pairingRequests.find(
      (request) => request.fingerprint === fingerprint && request.status === "pending",
    );
    if (existingRequest) {
      return {
        trusted: false,
        request: this.publicRequest(existingRequest),
      };
    }

    const request = {
      id: createId("pair"),
      label: String(input.label || "Untrusted device").trim(),
      role: normalizeRole(input.role),
      fingerprint,
      remoteAddress: String(input.remoteAddress || ""),
      status: "pending",
      scopes: scopesForRole(input.role),
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      deviceId: null,
      note: "",
    };
    data.pairingRequests.push(request);
    this.addAudit(data, {
      action: "trust.pairing_requested",
      status: "pending",
      actor: "device",
      targetType: "pairing",
      targetId: request.id,
      summary: `${request.label} requested ${request.role} pairing.`,
      createdAt: request.requestedAt,
      metadata: {
        role: request.role,
        remoteAddress: request.remoteAddress,
        fingerprint: request.fingerprint,
      },
    });
    this.write(data);
    return {
      trusted: false,
      request: this.publicRequest(request),
    };
  }

  approvePairing(requestId, note = "") {
    const data = this.read();
    const request = data.pairingRequests.find((item) => item.id === requestId);
    if (!request) {
      throw new Error(`Pairing request not found: ${requestId}`);
    }
    if (request.status !== "pending") {
      throw new Error(`Pairing request is already ${request.status}.`);
    }

    const token = createToken("omni_device");
    const device = {
      id: createId("device"),
      label: request.label,
      role: request.role,
      fingerprint: request.fingerprint,
      tokenHash: hashSecret(token),
      tokenPreview: maskToken(token),
      status: "trusted",
      scopes: request.scopes,
      issuedAt: new Date().toISOString(),
      expiresAt: futureIso(this.deviceTokenTtlMs),
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString(),
      tokenRotatedAt: null,
      lastSeenAt: null,
      lastUsedAt: null,
      revokedAt: null,
      note,
    };
    data.devices.push(device);
    request.status = "approved";
    request.resolvedAt = new Date().toISOString();
    request.deviceId = device.id;
    request.note = note;
    this.addAudit(data, {
      action: "trust.pairing_approved",
      status: "approved",
      actor: "operator",
      targetType: "pairing",
      targetId: request.id,
      summary: `${request.label} pairing approved.`,
      note,
      createdAt: request.resolvedAt,
      metadata: {
        deviceId: device.id,
        role: request.role,
      },
    });
    this.write(data);
    return {
      token,
      device: this.publicDevice(device),
      request: this.publicRequest(request),
    };
  }

  rejectPairing(requestId, note = "") {
    const data = this.read();
    const request = data.pairingRequests.find((item) => item.id === requestId);
    if (!request) {
      throw new Error(`Pairing request not found: ${requestId}`);
    }
    request.status = "rejected";
    request.resolvedAt = new Date().toISOString();
    request.note = note;
    this.addAudit(data, {
      action: "trust.pairing_rejected",
      status: "rejected",
      actor: "operator",
      targetType: "pairing",
      targetId: request.id,
      summary: `${request.label} pairing rejected.`,
      note,
      createdAt: request.resolvedAt,
      metadata: {
        role: request.role,
      },
    });
    this.write(data);
    return this.publicRequest(request);
  }

  rotateDeviceToken(deviceId, note = "") {
    const data = this.read();
    const device = data.devices.find((item) => item.id === deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    if (device.status !== "trusted") {
      throw new Error(`Device is ${device.status}. Only trusted devices can rotate tokens.`);
    }

    const token = createToken("omni_device");
    device.tokenHash = hashSecret(token);
    device.tokenPreview = maskToken(token);
    device.status = "trusted";
    device.issuedAt = new Date().toISOString();
    device.tokenRotatedAt = new Date().toISOString();
    device.expiresAt = futureIso(this.deviceTokenTtlMs);
    device.lastUsedAt = null;
    device.revokedAt = null;
    device.note = note || device.note || "";
    this.addAudit(data, {
      action: "trust.device_token_rotated",
      status: "trusted",
      actor: "operator",
      targetType: "device",
      targetId: device.id,
      summary: `${device.label || device.id} token rotated.`,
      note: device.note,
      createdAt: device.tokenRotatedAt,
      metadata: {
        role: device.role,
        tokenPreview: device.tokenPreview,
      },
    });
    this.write(data);
    return {
      token,
      device: this.publicDevice(device),
    };
  }

  revokeDevice(deviceId, note = "") {
    const data = this.read();
    const device = data.devices.find((item) => item.id === deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    device.status = "revoked";
    device.revokedAt = new Date().toISOString();
    device.note = note;
    this.addAudit(data, {
      action: "trust.device_revoked",
      status: "revoked",
      actor: "operator",
      targetType: "device",
      targetId: device.id,
      summary: `${device.label || device.id} revoked.`,
      note,
      createdAt: device.revokedAt,
      metadata: {
        role: device.role,
        tokenPreview: device.tokenPreview,
      },
    });
    this.write(data);
    return this.publicDevice(device);
  }

  verifyDevice({ deviceId = "", token = "" } = {}) {
    const data = this.read();
    const tokenHash = hashSecret(token);
    const device = data.devices.find((item) => {
      if (item.status !== "trusted" || !item.tokenHash) {
        return false;
      }
      if (item.expiresAt && Date.now() > new Date(item.expiresAt).getTime()) {
        item.status = "expired";
        item.revokedAt = item.revokedAt || new Date().toISOString();
        this.addAudit(data, {
          action: "trust.device_expired",
          status: "expired",
          actor: "system",
          targetType: "device",
          targetId: item.id,
          summary: `${item.label || item.id} token expired.`,
          createdAt: item.revokedAt,
          metadata: {
            role: item.role,
          },
        });
        return false;
      }
      if (deviceId && item.id !== deviceId) {
        return false;
      }
      return safeEqualHash(tokenHash, item.tokenHash);
    });
    if (!device) {
      return null;
    }
    device.lastSeenAt = new Date().toISOString();
    device.lastUsedAt = device.lastSeenAt;
    this.addAudit(data, {
      action: "trust.device_token_used",
      status: "trusted",
      actor: "device",
      targetType: "device",
      targetId: device.id,
      summary: `${device.label || device.id} token accepted.`,
      createdAt: device.lastSeenAt,
      metadata: {
        role: device.role,
      },
    });
    this.write(data);
    return this.publicDevice(device);
  }

  listDevices() {
    return this.read().devices.map((device) => this.publicDevice(device)).reverse();
  }

  listPairingRequests(status = "") {
    const requests = this.read().pairingRequests;
    return (status ? requests.filter((request) => request.status === status) : requests)
      .map((request) => this.publicRequest(request))
      .reverse();
  }

  listAudit(limit = 40) {
    const data = this.read();
    const records = Array.isArray(data.audit) && data.audit.length > 0 ? data.audit : this.deriveAudit(data);
    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 40));
    return records.map((record) => publicAuditRecord(record)).slice(0, safeLimit);
  }

  getOverview() {
    const data = this.read();
    const now = Date.now();
    const expiredDevices = data.devices.filter((device) => {
      if (!device.expiresAt) {
        return false;
      }
      const ts = new Date(device.expiresAt).getTime();
      return Number.isFinite(ts) && now > ts && device.status !== "revoked";
    }).length;
    return {
      gateway: this.getGatewayStatus(),
      trustedDevices: data.devices.filter((device) => device.status === "trusted").length,
      revokedDevices: data.devices.filter((device) => device.status === "revoked").length,
      expiredDevices,
      pendingPairings: data.pairingRequests.filter((request) => request.status === "pending").length,
    };
  }

  publicDevice(device) {
    return {
      id: device.id,
      label: device.label,
      role: device.role,
      fingerprint: device.fingerprint,
      tokenPreview: device.tokenPreview,
      status: device.status,
      scopes: device.scopes || scopesForRole(device.role),
      issuedAt: device.issuedAt || null,
      expiresAt: device.expiresAt || null,
      createdAt: device.createdAt,
      approvedAt: device.approvedAt,
      tokenRotatedAt: device.tokenRotatedAt || null,
      lastSeenAt: device.lastSeenAt,
      lastUsedAt: device.lastUsedAt || null,
      revokedAt: device.revokedAt,
      note: device.note || "",
    };
  }

  publicRequest(request) {
    return {
      id: request.id,
      label: request.label,
      role: request.role,
      fingerprint: request.fingerprint,
      remoteAddress: request.remoteAddress,
      status: request.status,
      scopes: request.scopes || scopesForRole(request.role),
      requestedAt: request.requestedAt,
      resolvedAt: request.resolvedAt,
      deviceId: request.deviceId,
      note: request.note || "",
    };
  }
}
