import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

const PROVIDERS = {
  github: {
    id: "github",
    name: "GitHub",
    accent: "#24292f",
    description: "Read your repositories and issues so the agent can understand project work.",
    defaultScopes: ["read:user", "repo"],
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
  },
  gmail: {
    id: "gmail",
    name: "Gmail",
    accent: "#ea4335",
    description: "Search and read email metadata after you approve Google OAuth access.",
    defaultScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
  },
};

function now() {
  return new Date().toISOString();
}

function trim(value, max = 4000) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function asScopes(value, fallback = []) {
  const scopes = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  const clean = [...new Set(scopes.map((item) => trim(item, 240)).filter(Boolean))];
  return clean.length > 0 ? clean : [...fallback];
}

function safeProviderId(value) {
  const id = trim(value, 40).toLowerCase();
  if (!PROVIDERS[id]) throw new Error(`Unsupported connected app: ${id || "(missing)"}.`);
  return id;
}

function mask(value) {
  const text = trim(value, 300);
  return text ? `${text.slice(0, 6)}...${text.slice(-4)}` : "";
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AppConnections {
  constructor({ rootDir, configStore, secretStore, gateway } = {}) {
    this.rootDir = rootDir || process.cwd();
    this.configStore = configStore;
    this.secretStore = secretStore;
    this.gateway = gateway;
    this.filePath = path.join(this.rootDir, "data", "app-connections.json");
    this.ensureFile();
  }

  ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) this.write({ providers: {}, pending: {} });
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return {
        providers: parsed?.providers && typeof parsed.providers === "object" ? parsed.providers : {},
        pending: parsed?.pending && typeof parsed.pending === "object" ? parsed.pending : {},
      };
    } catch {
      return { providers: {}, pending: {} };
    }
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify({ providers: data.providers || {}, pending: data.pending || {} }, null, 2), "utf8");
  }

  tokenKey(providerId) {
    return `connected-app:${providerId}`;
  }

  getToken(providerId) {
    const raw = this.secretStore?.getConnectorSecret?.(this.tokenKey(providerId), "oauth") || "";
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  setToken(providerId, token) {
    this.secretStore?.setConnectorSecret?.(this.tokenKey(providerId), "oauth", JSON.stringify(token || {}));
  }

  clearToken(providerId) {
    this.secretStore?.setConnectorSecret?.(this.tokenKey(providerId), "oauth", "");
  }

  getCallbackUrl(providerId) {
    const config = this.configStore?.getConfig?.() || {};
    const configured = trim(config.connectedApps?.callbackBaseUrl || "", 500).replace(/\/$/, "");
    const base = configured || "http://localhost:3147";
    return `${base}/api/apps/oauth/callback/${providerId}`;
  }

  getProviderState(providerId) {
    const data = this.read();
    return data.providers[providerId] && typeof data.providers[providerId] === "object" ? data.providers[providerId] : {};
  }

  getCatalog() {
    const config = this.configStore?.getConfig?.() || {};
    const computer = config.tools?.computerAccess || {};
    const permissions = config.tools?.permissions || {};
    const providers = Object.values(PROVIDERS).map((provider) => {
      const state = this.getProviderState(provider.id);
      const token = this.getToken(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        accent: provider.accent,
        description: provider.description,
        configured: Boolean(state.clientId && this.secretStore?.getConnectorSecret?.(this.tokenKey(provider.id), "clientSecret")),
        connected: Boolean(token?.accessToken),
        account: state.account || null,
        scopes: asScopes(state.scopes, provider.defaultScopes),
        connectedAt: state.connectedAt || "",
        tokenExpiresAt: token?.expiresAt || "",
        callbackUrl: this.getCallbackUrl(provider.id),
      };
    });
    return {
      apps: providers,
      computerUse: {
        enabled: computer.enabled !== false && permissions.allowComputerAccess !== false,
        allowWrite: computer.allowWrite === true,
        allowDelete: computer.allowDelete === true,
        allowPermanentDelete: computer.allowPermanentDelete === true,
        allowedRoots: Array.isArray(computer.allowedRoots) ? computer.allowedRoots : [],
      },
    };
  }

  configureOAuth({ provider, clientId, clientSecret, scopes } = {}) {
    const providerId = safeProviderId(provider);
    const data = this.read();
    const previous = data.providers[providerId] || {};
    const nextClientId = trim(clientId || previous.clientId, 300);
    const nextSecret = trim(clientSecret, 2000);
    if (!nextClientId) throw new Error(`${PROVIDERS[providerId].name} OAuth client ID is required.`);
    if (!nextSecret && !this.secretStore?.getConnectorSecret?.(this.tokenKey(providerId), "clientSecret")) {
      throw new Error(`${PROVIDERS[providerId].name} OAuth client secret is required.`);
    }
    data.providers[providerId] = {
      ...previous,
      clientId: nextClientId,
      scopes: asScopes(scopes, PROVIDERS[providerId].defaultScopes),
      configuredAt: now(),
    };
    this.write(data);
    if (nextSecret) this.secretStore?.setConnectorSecret?.(this.tokenKey(providerId), "clientSecret", nextSecret);
    this.gateway?.addEvent?.("connected_app.oauth_configured", { provider: providerId, scopes: data.providers[providerId].scopes });
    return this.getCatalog();
  }

  beginOAuth(provider) {
    const providerId = safeProviderId(provider);
    const info = PROVIDERS[providerId];
    const data = this.read();
    const state = data.providers[providerId] || {};
    const clientSecret = this.secretStore?.getConnectorSecret?.(this.tokenKey(providerId), "clientSecret") || "";
    if (!state.clientId || !clientSecret) {
      throw new Error(`${info.name} OAuth is not configured. Add your own OAuth client ID and secret first.`);
    }
    const stateToken = crypto.randomBytes(24).toString("base64url");
    data.pending[stateToken] = { provider: providerId, createdAt: Date.now(), scopes: asScopes(state.scopes, info.defaultScopes) };
    this.write(data);
    const query = new URLSearchParams({
      client_id: state.clientId,
      redirect_uri: this.getCallbackUrl(providerId),
      state: stateToken,
      scope: data.pending[stateToken].scopes.join(" "),
    });
    if (providerId === "github") query.set("allow_signup", "true");
    if (providerId === "gmail") {
      query.set("response_type", "code");
      query.set("access_type", "offline");
      query.set("prompt", "consent");
    }
    return { provider: providerId, url: `${info.authUrl}?${query.toString()}` };
  }

  async fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.text();
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* response may be text */ }
      if (!response.ok) {
        throw new Error(`Remote service returned ${response.status}: ${trim(json?.error_description || json?.message || body, 500)}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  async completeOAuth({ provider, code, state, error, errorDescription } = {}) {
    const providerId = safeProviderId(provider);
    if (error) throw new Error(`${PROVIDERS[providerId].name} authorization was declined: ${trim(errorDescription || error, 400)}`);
    const data = this.read();
    const pending = data.pending[String(state || "")];
    if (!pending || pending.provider !== providerId || Date.now() - Number(pending.createdAt || 0) > OAUTH_STATE_TTL_MS) {
      throw new Error("OAuth state is missing or expired. Return to Plugins and connect again.");
    }
    if (!trim(code, 4000)) throw new Error("OAuth callback did not include an authorization code.");
    const providerState = data.providers[providerId] || {};
    const clientSecret = this.secretStore?.getConnectorSecret?.(this.tokenKey(providerId), "clientSecret") || "";
    const tokenBody = new URLSearchParams({
      client_id: providerState.clientId || "",
      client_secret: clientSecret,
      code: trim(code, 4000),
      redirect_uri: this.getCallbackUrl(providerId),
    });
    if (providerId === "gmail") tokenBody.set("grant_type", "authorization_code");
    const token = await this.fetchJson(PROVIDERS[providerId].tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!token?.access_token) throw new Error("OAuth provider did not return an access token.");
    const savedToken = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || this.getToken(providerId)?.refreshToken || "",
      tokenType: token.token_type || "Bearer",
      expiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : "",
      scope: token.scope || pending.scopes.join(" "),
    };
    this.setToken(providerId, savedToken);
    let account = null;
    try {
      account = await this.fetchJson(PROVIDERS[providerId].profileUrl, {
        headers: { Authorization: `Bearer ${savedToken.accessToken}`, Accept: "application/json" },
      });
    } catch { /* Authorization succeeded even if profile metadata is unavailable. */ }
    data.providers[providerId] = {
      ...providerState,
      scopes: pending.scopes,
      account: providerId === "github"
        ? { login: trim(account?.login, 120), name: trim(account?.name, 160), avatarUrl: trim(account?.avatar_url, 500) }
        : { email: trim(account?.email, 240), name: trim(account?.name, 160), picture: trim(account?.picture, 500) },
      connectedAt: now(),
    };
    delete data.pending[state];
    this.write(data);
    this.gateway?.addEvent?.("connected_app.connected", { provider: providerId, account: data.providers[providerId].account || {} });
    return this.getCatalog();
  }

  disconnect(provider) {
    const providerId = safeProviderId(provider);
    const data = this.read();
    const state = data.providers[providerId] || {};
    delete state.account;
    delete state.connectedAt;
    data.providers[providerId] = state;
    this.write(data);
    this.clearToken(providerId);
    this.gateway?.addEvent?.("connected_app.disconnected", { provider: providerId });
    return this.getCatalog();
  }

  async accessToken(providerId) {
    const token = this.getToken(providerId);
    if (!token?.accessToken) throw new Error(`${PROVIDERS[providerId].name} is not connected. Open Plugins and connect your account first.`);
    const expiresSoon = token.expiresAt && Date.parse(token.expiresAt) < Date.now() + 60_000;
    if (!expiresSoon || providerId !== "gmail") return token.accessToken;
    if (!token.refreshToken) throw new Error("Gmail authorization expired. Reconnect Gmail in Plugins.");
    const state = this.getProviderState(providerId);
    const clientSecret = this.secretStore?.getConnectorSecret?.(this.tokenKey(providerId), "clientSecret") || "";
    const response = await this.fetchJson(PROVIDERS.gmail.tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: state.clientId || "", client_secret: clientSecret, refresh_token: token.refreshToken, grant_type: "refresh_token" }).toString(),
    });
    const refreshed = {
      ...token,
      accessToken: response.access_token,
      expiresAt: response.expires_in ? new Date(Date.now() + Number(response.expires_in) * 1000).toISOString() : token.expiresAt,
    };
    this.setToken(providerId, refreshed);
    return refreshed.accessToken;
  }

  async githubListRepositories({ visibility = "all", limit = 30 } = {}) {
    const token = await this.accessToken("github");
    const safeLimit = Math.max(1, Math.min(Number(limit || 30), 100));
    const response = await this.fetchJson(`https://api.github.com/user/repos?per_page=${safeLimit}&visibility=${encodeURIComponent(visibility)}&sort=updated`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    return {
      provider: "github",
      repositories: (Array.isArray(response) ? response : []).map((repo) => ({
        name: repo.full_name,
        private: Boolean(repo.private),
        description: trim(repo.description, 500),
        url: repo.html_url,
        updatedAt: repo.updated_at,
        defaultBranch: repo.default_branch,
      })),
    };
  }

  async githubSearchIssues({ query, limit = 20 } = {}) {
    const token = await this.accessToken("github");
    const q = trim(query, 500);
    if (!q) throw new Error("GitHub issue search needs a query, for example: repo:owner/name is:open bug.");
    const safeLimit = Math.max(1, Math.min(Number(limit || 20), 100));
    const response = await this.fetchJson(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${safeLimit}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    return {
      provider: "github",
      totalCount: Number(response?.total_count || 0),
      issues: (response?.items || []).map((issue) => ({
        title: issue.title,
        number: issue.number,
        state: issue.state,
        repository: issue.repository_url?.split("/").slice(-2).join("/") || "",
        url: issue.html_url,
        updatedAt: issue.updated_at,
      })),
    };
  }

  async gmailSearchMessages({ query = "", limit = 10 } = {}) {
    const token = await this.accessToken("gmail");
    const safeLimit = Math.max(1, Math.min(Number(limit || 10), 50));
    const params = new URLSearchParams({ maxResults: String(safeLimit) });
    if (trim(query, 500)) params.set("q", trim(query, 500));
    const response = await this.fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const messages = await Promise.all((response?.messages || []).slice(0, safeLimit).map(async (item) => {
      const detail = await this.fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      const headers = Object.fromEntries((detail?.payload?.headers || []).map((header) => [String(header.name || "").toLowerCase(), trim(header.value, 500)]));
      return { id: item.id, threadId: item.threadId, from: headers.from || "", subject: headers.subject || "", date: headers.date || "", snippet: trim(detail?.snippet, 1000) };
    }));
    return { provider: "gmail", count: Number(response?.resultSizeEstimate || messages.length), messages };
  }

  async gmailGetMessage({ id } = {}) {
    const token = await this.accessToken("gmail");
    const messageId = trim(id, 300);
    if (!messageId) throw new Error("Gmail message id is required.");
    const detail = await this.fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const headers = Object.fromEntries((detail?.payload?.headers || []).map((header) => [String(header.name || "").toLowerCase(), trim(header.value, 500)]));
    return { provider: "gmail", id: detail.id, threadId: detail.threadId, from: headers.from || "", to: headers.to || "", subject: headers.subject || "", date: headers.date || "", snippet: trim(detail.snippet, 2000), labelIds: detail.labelIds || [] };
  }

  setComputerUse(enabled) {
    const next = this.configStore?.updateUserConfig?.({
      tools: {
        permissions: { allowComputerAccess: Boolean(enabled) },
        computerAccess: { enabled: Boolean(enabled) },
      },
    });
    this.gateway?.addEvent?.("computer_use.permission_updated", { enabled: Boolean(enabled) });
    return { enabled: Boolean(enabled), computerUse: this.getCatalog().computerUse, configUpdated: Boolean(next) };
  }
}

export default AppConnections;
