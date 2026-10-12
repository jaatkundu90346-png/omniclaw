import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const ENVELOPE_VERSION = 1;

export class SecretStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "secrets.json");
    this._cache = null;
    this.ensureFile();
  }

  // Key is bound to this machine + user so an exfiltrated secrets.json (cloud
  // sync, backup, or copied to another box) can't be decrypted elsewhere. On
  // the same single-user desktop the owner can always reconstruct it. Pure
  // node:crypto (no native deps) so it works inside the packaged .exe.
  deriveKey(salt) {
    const machineId = `${os.hostname()}|${os.userInfo().username}|omniclaw-secret-v1`;
    return crypto.scryptSync(machineId, salt, 32);
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write({ providerKeys: {}, connectorSecrets: {} });
      return;
    }
    // Migrate a legacy plaintext secrets file to encrypted-at-rest on startup.
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && raw.enc !== true) {
        this.write({
          providerKeys: raw.providerKeys || {},
          connectorSecrets: raw.connectorSecrets || {},
        });
      }
    } catch {
      // Unreadable/corrupt — leave it; read() fails safe to empty.
    }
  }

  read() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return { providerKeys: {}, connectorSecrets: {} };
    }
    if (this._cache && this._cache.mtimeMs === stat.mtimeMs && this._cache.size === stat.size) {
      return this._cache.data;
    }

    let payload;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      payload = parsed && parsed.enc === true ? this.decryptEnvelope(parsed) : parsed;
    } catch (err) {
      // Wrong machine / tampered / corrupt → fail safe so the app keeps working
      // (the user just re-enters their keys).
      console.error(`[secret-store] could not read secrets (machine changed or file tampered): ${err.message}`);
      return { providerKeys: {}, connectorSecrets: {} };
    }

    const data = {
      providerKeys: payload?.providerKeys && typeof payload.providerKeys === "object" ? payload.providerKeys : {},
      connectorSecrets:
        payload?.connectorSecrets && typeof payload.connectorSecrets === "object" ? payload.connectorSecrets : {},
    };
    this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  }

  decryptEnvelope(envelope) {
    const salt = Buffer.from(envelope.salt, "hex");
    const iv = Buffer.from(envelope.iv, "hex");
    const tag = Buffer.from(envelope.tag, "hex");
    const key = this.deriveKey(salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  }

  write(data) {
    const plaintext = Buffer.from(
      JSON.stringify({ providerKeys: data.providerKeys || {}, connectorSecrets: data.connectorSecrets || {} }),
      "utf8",
    );
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = this.deriveKey(salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = {
      v: ENVELOPE_VERSION,
      enc: true,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: ciphertext.toString("base64"),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(envelope, null, 2));
    try {
      const stat = fs.statSync(this.filePath);
      this._cache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        data: {
          providerKeys: data.providerKeys || {},
          connectorSecrets: data.connectorSecrets || {},
        },
      };
    } catch {
      this._cache = null;
    }
  }

  setProviderKey(providerId, apiKey) {
    const data = this.read();
    const key = String(apiKey || "");
    if (!key) {
      delete data.providerKeys[providerId];
    } else {
      data.providerKeys[providerId] = key;
    }
    this.write(data);
    return this.getProviderKeyStatus(providerId);
  }

  getProviderKey(providerId) {
    return this.read().providerKeys[providerId] || "";
  }

  getProviderKeyStatus(providerId) {
    const key = this.getProviderKey(providerId);
    return {
      providerId,
      configured: Boolean(key),
      masked: key ? `${key.slice(0, 4)}...${key.slice(-4)}` : "",
    };
  }

  getAllStatuses() {
    const data = this.read();
    return Object.keys(data.providerKeys).map((providerId) => this.getProviderKeyStatus(providerId));
  }

  setConnectorSecret(adapterId, key, value) {
    const data = this.read();
    const adapterKey = String(adapterId || "").trim();
    const secretKey = String(key || "token").trim();
    const secret = String(value || "");
    if (!adapterKey || !secretKey) {
      throw new Error("adapterId and key are required");
    }

    data.connectorSecrets[adapterKey] = data.connectorSecrets[adapterKey] || {};
    if (!secret) {
      delete data.connectorSecrets[adapterKey][secretKey];
    } else {
      data.connectorSecrets[adapterKey][secretKey] = secret;
    }
    this.write(data);
    return this.getConnectorSecretStatus(adapterKey, secretKey);
  }

  getConnectorSecret(adapterId, key = "token") {
    const data = this.read();
    return data.connectorSecrets?.[adapterId]?.[key] || "";
  }

  getConnectorSecretStatus(adapterId, key = "token") {
    const secret = this.getConnectorSecret(adapterId, key);
    return {
      adapterId,
      key,
      configured: Boolean(secret),
      masked: secret ? `${secret.slice(0, 6)}...${secret.slice(-4)}` : "",
    };
  }

  getConnectorSecretStatuses() {
    const data = this.read();
    return Object.entries(data.connectorSecrets).flatMap(([adapterId, secrets]) =>
      Object.keys(secrets || {}).map((key) => this.getConnectorSecretStatus(adapterId, key)),
    );
  }
}
