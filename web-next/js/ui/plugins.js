// #/plugins — Connected apps (GitHub, Gmail) + Installed plugins + Computer Use.
// Same backends as neo's Plugins panel (public/neo.js:1995-2116): GET /api/apps,
// GET /api/plugins, POST oauth/config, redirect oauth/start, POST disconnect,
// POST computer-use, POST plugins/toggle. Test-connection here is read-only —
// github_list_repositories / gmail_search_messages with limit 1 via runTool.
// Secrets are write-only: the form sends them once, the server stores them
// encrypted and never echoes them back; this file never logs them.

import { h } from "../utils/dom.js";
import { icons } from "../icons.js";
import {
  getApps, getPlugins, togglePlugin, configureAppOAuth, appOAuthStartUrl,
  disconnectApp, setComputerUse, runTool,
} from "../api.js";
import { toast } from "./toast.js";

const APP_INITIALS = { github: "GH", gmail: "GM" };
const TEST_TOOL = {
  github: { tool: "github_list_repositories", input: { limit: 1 } },
  gmail: { tool: "gmail_search_messages", input: { limit: 1 } },
};
const SETUP_HELP = {
  gmail: "Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Web application). Add the callback URL below as an Authorized redirect URI, and enable the Gmail API. Default scopes are read-only.",
  github: "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App. Use the callback URL below as the Authorization callback URL. Default scopes: read:user + repo (repo lists private repos you can access).",
};

function initials(app) {
  return APP_INITIALS[app.id] || String(app.name || app.id || "AP").slice(0, 2).toUpperCase();
}

function accountOf(app) {
  const a = app.account || {};
  return a.login || a.email || a.name || "";
}

function badge(text, ok) {
  return h("span", { class: `badge ${ok ? "ok" : ""}`, text });
}

function appCard(app, refresh) {
  const connected = !!app.connected;
  // plugin-catalog-item keeps the shared search filter working (same as neo).
  const card = h("article", { class: "connected-app-card plugin-catalog-item" });
  card.dataset.name = `${app.name || ""} ${app.description || ""}`.toLowerCase();
  card.dataset.appCard = app.id;

  const top = h("div", { class: "connected-app-top" },
    h("span", { class: "connected-app-icon", text: initials(app) }),
    h("div", { class: "row-main" },
      h("strong", { text: app.name || app.id }),
      h("small", { text: app.description || "" })),
    badge(connected ? "connected" : app.configured ? "ready to connect" : "setup needed", connected));
  top.querySelector(".connected-app-icon").style.setProperty("--app-accent", app.accent || "#667");
  card.append(top);

  const meta = h("div", { class: "connected-app-meta" });
  if (connected) {
    meta.append(
      h("span", null, "Account: ", h("strong", { text: accountOf(app) || "approved" })),
      h("span", { text: (app.scopes || []).join(" · ") }));
    if (app.tokenExpiresAt) meta.append(h("span", { class: "muted small", text: `Token expires ${app.tokenExpiresAt}` }));
  } else {
    meta.append(
      h("span", { text: "Read-only agent tools unlock only after you approve OAuth." }),
      h("span", null, "Callback: ", h("code", { text: app.callbackUrl || "" })));
  }
  card.append(meta);

  const status = h("div", { class: "small muted", role: "status", "aria-live": "polite" });
  card.append(status);

  const actions = h("div", { class: "connected-app-actions" });
  const setupBtn = h("button", { class: "btn", type: "button", text: "OAuth setup" });
  if (connected) {
    const testBtn = h("button", { class: "btn", type: "button", text: "Test connection" });
    testBtn.addEventListener("click", async () => {
      const spec = TEST_TOOL[app.id];
      if (!spec) { status.textContent = "No read-only test for this app yet."; return; }
      testBtn.disabled = true;
      status.textContent = "Testing (read-only)…";
      try {
        const res = await runTool(spec.tool, spec.input);
        const repos = res.repositories || [];
        const messages = res.messages || [];
        status.textContent = repos.length
          ? `✓ Connected — e.g. ${repos[0].name}`
          : messages.length
            ? `✓ Connected — latest: ${messages[0].subject || "(no subject)"} (${messages[0].from || "unknown sender"})`
            : `✓ Connected — ${(res.count ?? res.totalCount ?? 0)} items found.`;
      } catch (e) {
        status.textContent = `✗ Test failed: ${e.message}`;
      } finally {
        testBtn.disabled = false;
      }
    });
    const reconBtn = h("button", { class: "btn", type: "button", text: "Reconnect" });
    reconBtn.addEventListener("click", () => {
      window.location.assign(appOAuthStartUrl(app.id));
    });
    const disBtn = h("button", { class: "btn danger", type: "button", text: "Disconnect" });
    disBtn.addEventListener("click", async () => {
      if (!window.confirm(`Disconnect ${app.name}? The local OAuth token will be removed.`)) return;
      disBtn.disabled = true;
      try {
        await disconnectApp(app.id);
        toast(`Disconnected ${app.name}`, "success");
        refresh();
      } catch (e) {
        disBtn.disabled = false;
        toast(`Disconnect failed: ${e.message}`, "error");
      }
    });
    actions.append(testBtn, reconBtn, disBtn);
  } else {
    const connBtn = h("button", { class: "btn primary", type: "button", text: app.configured ? "Connect account" : "Configure OAuth" });
    connBtn.addEventListener("click", () => {
      if (!app.configured) {
        form.hidden = !form.hidden;
        return;
      }
      window.location.assign(appOAuthStartUrl(app.id));
    });
    actions.append(connBtn);
  }
  actions.append(setupBtn);
  const detBtn = h("button", { class: "btn", type: "button", text: "Details", "aria-expanded": "false" });
  actions.append(detBtn);
  card.append(actions);

  const details = h("div", { class: "connected-app-meta", hidden: true },
    h("span", null, "Scopes: ", h("code", { text: (app.scopes || []).join(" ") || "—" })),
    h("span", null, "Callback: ", h("code", { text: app.callbackUrl || "—" })),
    h("span", { class: "muted small", text: `Callback base comes from config connectedApps.callbackBaseUrl (default http://localhost:3147). Client secrets are stored encrypted on this PC and never shown here.` }),
    app.connectedAt ? h("span", { class: "muted small", text: `Connected ${app.connectedAt}` }) : null);
  detBtn.addEventListener("click", () => {
    details.hidden = !details.hidden;
    detBtn.setAttribute("aria-expanded", String(!details.hidden));
  });
  card.append(details);

  const idInput = h("input", { type: "text", value: "", placeholder: `Your ${app.name} OAuth client ID`, autocomplete: "off", "aria-label": "OAuth client ID" });
  const secretInput = h("input", { type: "password", value: "", placeholder: "Stored encrypted on this PC", autocomplete: "new-password", "aria-label": "OAuth client secret" });
  const scopesInput = h("input", { type: "text", value: (app.scopes || []).join(" "), "aria-label": "OAuth scopes" });
  const formStatus = h("div", { class: "small muted", role: "status" });
  const form = h("form", { class: "app-oauth-form" },
    h("label", null, "Client ID", idInput),
    h("label", null, "Client secret", secretInput),
    h("label", null, "Scopes", scopesInput),
    h("small", { text: SETUP_HELP[app.id] || "Use a localhost OAuth app and register the callback URL above." }),
    h("div", null, h("button", { class: "btn primary", type: "submit", text: "Save OAuth setup" })),
    formStatus);
  if (app.configured) form.hidden = true;
  setupBtn.addEventListener("click", () => { form.hidden = !form.hidden; });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const saveBtn = form.querySelector('button[type="submit"]');
    saveBtn.disabled = true;
    formStatus.textContent = "Saving…";
    try {
      // Secret goes out once over loopback; never stored locally, never logged.
      await configureAppOAuth({
        provider: app.id,
        clientId: idInput.value.trim(),
        ...(secretInput.value ? { clientSecret: secretInput.value } : {}),
        scopes: scopesInput.value.trim(),
      });
      secretInput.value = "";
      toast(`OAuth saved for ${app.name} — connect your account next`, "success");
      refresh();
    } catch (err) {
      formStatus.textContent = `Save failed: ${err.message}`;
      saveBtn.disabled = false;
    }
  });
  card.append(form);
  return card;
}

export function mountPlugins(root) {
  root.innerHTML = "";
  const wrap = h("div", { class: "plugins-page" });
  wrap.append(
    h("h2", { text: "Plugins & Connected Apps" }),
    h("p", { class: "muted small", text: "Connect your own accounts with OAuth; tokens stay encrypted on this PC and the agent receives only the granted tools." }));
  const note = h("p", { class: "muted", role: "status", text: "Loading…" });
  wrap.append(note);
  root.append(wrap);

  const render = () => mountPlugins(root);

  Promise.all([getApps().catch((e) => ({ error: e })), getPlugins().catch(() => ({ plugins: [] }))])
    .then(([appData, pluginData]) => {
      if (!root.isConnected) return;
      note.remove();
      if (appData && appData.error) {
        wrap.append(h("div", { class: "panel-empty" },
          h("strong", { text: "Could not load connected apps" }),
          h("p", { class: "muted small", text: String(appData.error.message || appData.error) }),
          h("button", {
            class: "btn", type: "button", text: "Retry",
            onclick: () => render(),
          })));
        return;
      }
      const apps = (appData && appData.apps) || [];
      const computer = (appData && appData.computerUse) || {};
      const plugins = (pluginData && pluginData.plugins) || [];

      const tabs = h("div", { class: "seg-tabs", role: "tablist", "aria-label": "Plugins sections" });
      const panes = {};
      for (const [id, label] of [["apps", `Connected apps (${apps.filter((a) => a.connected).length}/${apps.length})`], ["installed", `Installed (${plugins.length})`], ["computer", "Computer Use"]]) {
        const b = h("button", { class: `seg-tab${id === "apps" ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(id === "apps"), text: label });
        b.addEventListener("click", () => {
          for (const t of tabs.querySelectorAll(".seg-tab")) {
            const on = t === b;
            t.classList.toggle("active", on);
            t.setAttribute("aria-selected", String(on));
          }
          for (const [pid, pane] of Object.entries(panes)) pane.hidden = pid !== id;
        });
        tabs.append(b);
      }
      const search = h("input", { type: "search", placeholder: "Search apps and plugins", "aria-label": "Search apps and plugins", class: "menu-search" });
      search.addEventListener("input", () => {
        const needle = search.value.trim().toLowerCase();
        wrap.querySelectorAll(".plugin-catalog-item").forEach((item) => {
          item.style.display = !needle || (item.dataset.name || "").includes(needle) ? "" : "none";
        });
      });
      wrap.append(tabs, search);

      const appsPane = h("section", null,
        h("div", { class: "connected-app-intro" },
          h("strong", { text: "Connect your work" }),
          h("span", { text: "GitHub and Gmail use your own OAuth app credentials, then your browser shows the official consent screen." })),
        h("div", { class: "connected-app-grid" }));
      const grid = appsPane.querySelector(".connected-app-grid");
      for (const app of apps) grid.append(appCard(app, render));
      if (!apps.length) appsPane.append(h("p", { class: "muted", text: "No connected apps on this backend." }));

      const instPane = h("section", { hidden: true });
      if (!plugins.length) instPane.append(h("p", { class: "muted", text: "No local plugins installed." }));
      for (const p of plugins) {
        const row = h("div", { class: "catalog-row plugin-catalog-item" });
        row.dataset.name = `${p.name || p.id} ${p.description || ""}`.toLowerCase();
        const on = p.enabled !== false;
        const btn = h("button", { class: "btn", type: "button", text: on ? "Disable" : "Enable" });
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await togglePlugin(p.id, !on);
            render();
          } catch (e) {
            btn.disabled = false;
            toast(`Plugin toggle failed: ${e.message}`, "error");
          }
        });
        row.append(
          h("span", { class: "app-icon blue", text: String(p.name || p.id).slice(0, 2).toUpperCase() }),
          h("div", { class: "row-main" },
            h("strong", { text: p.name || p.id }),
            h("small", { text: `${p.description || "No description"} · ${(p.tools || []).length} tools` })),
          badge(on ? "enabled" : "disabled", on), btn);
        instPane.append(row);
      }

      const compPane = h("section", { hidden: true });
      const compCard = h("article", { class: "computer-use-card" },
        h("div", null,
          h("span", { class: "connected-app-icon computer", text: "PC" }),
          h("h3", { text: "Computer Use" }),
          h("p", { class: "muted small", text: "Allow the agent to use enabled computer/file tools within the configured Windows roots. Destructive operations remain governed by existing safety policies." })),
        badge(computer.enabled ? "enabled" : "disabled", !!computer.enabled),
        h("div", { class: "connected-app-meta" },
          h("span", null, "Allowed roots: ", h("code", { text: (computer.allowedRoots || []).join(", ") || "none" })),
          h("span", { text: `Write: ${computer.allowWrite ? "allowed" : "blocked"} · Delete: ${computer.allowDelete ? "allowed (trash by default)" : "blocked"}` })));
      const compBtn = h("button", {
        class: "btn primary", type: "button",
        text: computer.enabled ? "Disable Computer Use" : "Enable Computer Use",
      });
      compBtn.addEventListener("click", async () => {
        const next = !computer.enabled;
        if (!window.confirm(`${next ? "Enable" : "Disable"} Computer Use for OmniClaw?`)) return;
        compBtn.disabled = true;
        try {
          await setComputerUse(next);
          toast(`Computer Use ${next ? "enabled" : "disabled"}`, "success");
          render();
        } catch (e) {
          compBtn.disabled = false;
          toast(`Computer Use failed: ${e.message}`, "error");
        }
      });
      compCard.append(compBtn);
      compPane.append(compCard);

      panes.apps = appsPane;
      panes.installed = instPane;
      panes.computer = compPane;
      wrap.append(appsPane, instPane, compPane);
    })
    .catch((e) => {
      if (!root.isConnected) return;
      note.textContent = `Could not load plugins: ${e.message}`;
    });
}
