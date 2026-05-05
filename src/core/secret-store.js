import fs from "node:fs";
import path from "node:path";

export class SecretStore {
  constructor(rootDir) {
    this.filePath = path.join(rootDir, "data", "secrets.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ providerKeys: {}, connectorSecrets: {} }, null, 2));
    }
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      providerKeys: parsed.providerKeys && typeof parsed.providerKeys === "object" ? parsed.providerKeys : {},
      connectorSecrets:
        parsed.connectorSecrets && typeof parsed.connectorSecrets === "object" ? parsed.connectorSecrets : {},
    };
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
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
