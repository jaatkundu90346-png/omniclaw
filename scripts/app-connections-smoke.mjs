import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppConnections } from "../src/core/app-connections.js";

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`ok: ${message}`);
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniclaw-apps-"));
const secrets = new Map();
const secretStore = {
  getConnectorSecret: (adapterId, key) => secrets.get(`${adapterId}:${key}`) || "",
  setConnectorSecret: (adapterId, key, value) => {
    const id = `${adapterId}:${key}`;
    if (value) secrets.set(id, value); else secrets.delete(id);
  },
};
let config = {
  tools: {
    permissions: { allowComputerAccess: true },
    computerAccess: { enabled: true, allowWrite: true, allowDelete: true, allowPermanentDelete: false, allowedRoots: ["C:/work"] },
  },
};
const configStore = {
  getConfig: () => config,
  updateUserConfig: (patch) => {
    config = {
      ...config,
      tools: {
        ...config.tools,
        ...patch.tools,
        permissions: { ...config.tools.permissions, ...patch.tools.permissions },
        computerAccess: { ...config.tools.computerAccess, ...patch.tools.computerAccess },
      },
    };
    return config;
  },
};
const events = [];
const apps = new AppConnections({ rootDir, configStore, secretStore, gateway: { addEvent: (event, payload) => events.push({ event, payload }) } });

let catalog = apps.getCatalog();
assert(catalog.apps.length === 2, "catalog exposes GitHub and Gmail");
assert(catalog.apps.every((app) => app.connected === false), "catalog starts disconnected");
assert(catalog.computerUse.enabled === true, "computer use reports its configured state");

apps.configureOAuth({ provider: "github", clientId: "github-client-id", clientSecret: "super-secret", scopes: "read:user repo" });
catalog = apps.getCatalog();
const github = catalog.apps.find((app) => app.id === "github");
assert(github.configured === true && github.connected === false, "GitHub OAuth setup is ready without exposing a token");
assert(JSON.stringify(catalog).includes("super-secret") === false, "catalog never exposes OAuth client secrets");

const started = apps.beginOAuth("github");
const authUrl = new URL(started.url);
assert(authUrl.hostname === "github.com" && authUrl.searchParams.get("client_id") === "github-client-id", "GitHub connect starts the official OAuth flow");
assert(Boolean(authUrl.searchParams.get("state")), "OAuth flow has CSRF state");

apps.setComputerUse(false);
assert(apps.getCatalog().computerUse.enabled === false, "computer use can be disabled explicitly");
apps.setComputerUse(true);
assert(apps.getCatalog().computerUse.enabled === true, "computer use can be re-enabled explicitly");
assert(events.some((event) => event.event === "connected_app.oauth_configured"), "OAuth setup emits an audit event");

fs.rmSync(rootDir, { recursive: true, force: true });
console.log(`APP CONNECTIONS SMOKE: PASSED (${passed} assertions)`);
