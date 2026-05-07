import { checkGatewayAuthOverview, formatGatewayConnectState } from "./ui/gateway-auth.js";
import { inferProfileFromProviderId, PROVIDER_PRESETS } from "./ui/provider-presets.js";

const form = document.querySelector("#chat-form");
const sessionLabelInput = document.querySelector("#session-label");
const agentSelect = document.querySelector("#agent-select");
const messageInput = document.querySelector("#message");
const chatOutput = document.querySelector("#chat-output");
const chatTranscript = document.querySelector("#chat-transcript");
const liveRunOutput = document.querySelector("#live-run-output");
const clearOutputButton = document.querySelector("#clear-output");
const abortRunButton = document.querySelector("#abort-run");
const globalSearchInput = document.querySelector("#global-search");
const topbarOverviewButton = document.querySelector("#topbar-overview");
const topbarDensityButton = document.querySelector("#topbar-density");
const topbarThemeButton = document.querySelector("#topbar-theme");
const stateOutput = document.querySelector("#state-output");
const refreshStateButton = document.querySelector("#refresh-state");
const refreshInspectorButton = document.querySelector("#refresh-inspector");
const inspectorOutput = document.querySelector("#inspector-output");
const researchOutput = document.querySelector("#research-output");
const artifactOutput = document.querySelector("#artifact-output");
const memoryContext = document.querySelector("#memory-context");
const memoryCandidateOutput = document.querySelector("#memory-candidate-output");
const longMemoryOutput = document.querySelector("#long-memory-output");
const dreamOutput = document.querySelector("#dream-output");
const memoryPromoteForm = document.querySelector("#memory-promote-form");
const memoryFeedback = document.querySelector("#memory-feedback");
const runDreamSweepButton = document.querySelector("#run-dream-sweep");
const runtimeForm = document.querySelector("#runtime-form");
const runtimeOutput = document.querySelector("#runtime-output");
const providerForm = document.querySelector("#provider-form");
const providerOutput = document.querySelector("#provider-output");
const providerStatusOutput = document.querySelector("#provider-status-output");
const testProviderButton = document.querySelector("#test-provider");
const openCodexLoginButton = document.querySelector("#open-codex-login");
const providerCodexHelp = document.querySelector("#provider-codex-help");
const designBridgeForm = document.querySelector("#design-bridge-form");
const designBridgeText = document.querySelector("#design-bridge-text");
const designBridgeOutput = document.querySelector("#design-bridge-output");
const refreshDesignBridgeButton = document.querySelector("#refresh-design-bridge");
const copyDesignBridgeButton = document.querySelector("#copy-design-bridge");
const skillForm = document.querySelector("#skill-form");
const skillOutput = document.querySelector("#skill-output");
const skillLibraryOutput = document.querySelector("#skill-library-output");
const gatewayOutput = document.querySelector("#gateway-output");
const runOutput = document.querySelector("#run-output");
const promptTraceOutput = document.querySelector("#prompt-trace-output");
const toolTraceOutput = document.querySelector("#tool-trace-output");
const sessionOutput = document.querySelector("#session-output");
const sessionDetailOutput = document.querySelector("#session-detail-output");
const agentOutput = document.querySelector("#agent-output");
const agentDetailOutput = document.querySelector("#agent-detail-output");
const delegationContext = document.querySelector("#delegation-context");
const delegationOutput = document.querySelector("#delegation-output");
const delegationForm = document.querySelector("#delegation-form");
const delegationAgentSelect = document.querySelector("#delegation-agent");
const delegationSourceInput = document.querySelector("#delegation-source");
const delegationInstructionInput = document.querySelector("#delegation-instruction");
const delegationFeedback = document.querySelector("#delegation-feedback");
const approvalOutput = document.querySelector("#approval-output");
const workspaceOutput = document.querySelector("#workspace-output");
const approveLatestButton = document.querySelector("#approve-latest");
const resetSessionButton = document.querySelector("#reset-session");
const pluginOutput = document.querySelector("#plugin-output");
const pluginDetailOutput = document.querySelector("#plugin-detail-output");
const pluginConfigFields = document.querySelector("#plugin-config-fields");
const pluginFeedback = document.querySelector("#plugin-feedback");
const jobOutput = document.querySelector("#job-output");
const jobDetailOutput = document.querySelector("#job-detail-output");
const cancelJobButton = document.querySelector("#cancel-job");
const scheduleForm = document.querySelector("#schedule-form");
const scheduleOutput = document.querySelector("#schedule-output");
const scheduleToolSelect = document.querySelector("#schedule-tool");
const scheduleFeedback = document.querySelector("#schedule-feedback");
const schedulerContext = document.querySelector("#scheduler-context");
const trustContext = document.querySelector("#trust-context");
const trustOutput = document.querySelector("#trust-output");
const deviceOutput = document.querySelector("#device-output");
const trustAuditOutput = document.querySelector("#trust-audit-output");
const trustFeedback = document.querySelector("#trust-feedback");
const pairingForm = document.querySelector("#pairing-form");
const rotateGatewayTokenButton = document.querySelector("#rotate-gateway-token");
const copyGatewayTokenButton = document.querySelector("#copy-gateway-token");
const shellAuditForm = document.querySelector("#shell-audit-form");
const shellAuditOutput = document.querySelector("#shell-audit-output");
const shellAuditDetailOutput = document.querySelector("#shell-audit-detail-output");
const shellPolicyOutput = document.querySelector("#shell-policy-output");
const shellAuditContext = document.querySelector("#shell-audit-context");
const shellPolicyForm = document.querySelector("#shell-policy-form");
const shellPolicyFeedback = document.querySelector("#shell-policy-feedback");
const shellPolicyMode = document.querySelector("#shell-policy-mode");
const shellPolicyTimeout = document.querySelector("#shell-policy-timeout");
const shellPolicyOutputLimit = document.querySelector("#shell-policy-output-limit");
const shellPolicyAllowlist = document.querySelector("#shell-policy-allowlist");
const shellPolicyBlocked = document.querySelector("#shell-policy-blocked");
const connectorsContext = document.querySelector("#connectors-context");
const connectorsFeedback = document.querySelector("#connectors-feedback");
const webhookTestForm = document.querySelector("#webhook-test-form");
const connectorSecurityOutput = document.querySelector("#connector-security-output");
const webhookEnabledInput = document.querySelector("#webhook-enabled");
const webhookRequireTokenInput = document.querySelector("#webhook-require-token");
const webhookDefaultAgentInput = document.querySelector("#webhook-default-agent");
const webhookAllowPayloadAgentInput = document.querySelector("#webhook-allow-payload-agent");
const fileDropEnabledInput = document.querySelector("#file-drop-enabled");
const fileDropDefaultAgentInput = document.querySelector("#file-drop-default-agent");
const fileDropArchiveProcessedInput = document.querySelector("#file-drop-archive-processed");
const attachmentIngestionEnabledInput = document.querySelector("#attachment-ingestion-enabled");
const attachmentAutoCacheInput = document.querySelector("#attachment-auto-cache");
const attachmentAutoExtractInput = document.querySelector("#attachment-auto-extract");
const attachmentAutoInjectInput = document.querySelector("#attachment-auto-inject");
const attachmentMaxCountInput = document.querySelector("#attachment-max-count");
const attachmentMaxCacheBytesInput = document.querySelector("#attachment-max-cache-bytes");
const attachmentRetentionEnabledInput = document.querySelector("#attachment-retention-enabled");
const attachmentRetentionDaysInput = document.querySelector("#attachment-retention-days");
const attachmentRetentionBytesInput = document.querySelector("#attachment-retention-bytes");
const attachmentMediaAnalysisEnabledInput = document.querySelector("#attachment-media-analysis-enabled");
const attachmentMediaAutoAnalyzeInput = document.querySelector("#attachment-media-auto-analyze");
const attachmentMediaPresetInput = document.querySelector("#attachment-media-preset");
const attachmentMediaProviderInput = document.querySelector("#attachment-media-provider");
const attachmentMediaEndpointInput = document.querySelector("#attachment-media-endpoint");
const attachmentMediaModelInput = document.querySelector("#attachment-media-model");
const attachmentMediaApiKeyInput = document.querySelector("#attachment-media-api-key");
const attachmentMediaCommandInput = document.querySelector("#attachment-media-command");
const attachmentMediaArgsInput = document.querySelector("#attachment-media-args");
const attachmentMediaRoutesInput = document.querySelector("#attachment-media-routes");
const attachmentMediaTestKindInput = document.querySelector("#attachment-media-test-kind");
const saveConnectorConfigButton = document.querySelector("#save-connector-config");
const testMediaProviderButton = document.querySelector("#test-media-provider");
const checkMediaSetupButton = document.querySelector("#check-media-setup");
const buildMediaInstallPlanButton = document.querySelector("#build-media-install-plan");
const applyMediaSetupButton = document.querySelector("#apply-media-setup");
const attachmentMediaSetupOutput = document.querySelector("#attachment-media-setup-output");
const cleanupAttachmentCacheButton = document.querySelector("#cleanup-attachment-cache");
const scheduleAttachmentCleanupButton = document.querySelector("#schedule-attachment-cleanup");
const rotateWebhookTokenButton = document.querySelector("#rotate-webhook-token");
const connectorAdapterOutput = document.querySelector("#connector-adapter-output");
const adapterConfigForm = document.querySelector("#adapter-config-form");
const adapterSelect = document.querySelector("#adapter-select");
const adapterEnabledInput = document.querySelector("#adapter-enabled");
const adapterAgentInput = document.querySelector("#adapter-agent");
const adapterModeInput = document.querySelector("#adapter-mode");
const adapterSecretInput = document.querySelector("#adapter-secret");
const testAdapterButton = document.querySelector("#test-adapter");
const pollTelegramButton = document.querySelector("#poll-telegram");
const startTelegramButton = document.querySelector("#start-telegram");
const stopTelegramButton = document.querySelector("#stop-telegram");
const dispatchDiscordButton = document.querySelector("#dispatch-discord");
const startDiscordButton = document.querySelector("#start-discord");
const stopDiscordButton = document.querySelector("#stop-discord");
const adapterDeliveryOutput = document.querySelector("#adapter-delivery-output");
const adapterDeliverySummary = document.querySelector("#adapter-delivery-summary");
const adapterDeliveryAdapterFilter = document.querySelector("#adapter-delivery-adapter-filter");
const adapterDeliveryStatusFilter = document.querySelector("#adapter-delivery-status-filter");
const adapterDeliveryQueryFilter = document.querySelector("#adapter-delivery-query-filter");
const adapterAttachmentCacheOutput = document.querySelector("#adapter-attachment-cache-output");
const adapterAttachmentExtractOutput = document.querySelector("#adapter-attachment-extract-output");
const adapterAttachmentAnalysisOutput = document.querySelector("#adapter-attachment-analysis-output");
const adapterAttachmentInjectionOutput = document.querySelector("#adapter-attachment-injection-output");
const attachmentCleanupOutput = document.querySelector("#attachment-cleanup-output");
const adapterOutboxOutput = document.querySelector("#adapter-outbox-output");
const webhookOutput = document.querySelector("#webhook-output");
const fileDropOutput = document.querySelector("#file-drop-output");
const fileDropPendingOutput = document.querySelector("#file-drop-pending-output");
const scanFileDropButton = document.querySelector("#scan-file-drop");
const runPluginJobButton = document.querySelector("#run-plugin-job");
const reloadPluginsButton = document.querySelector("#reload-plugins");
const pluginConfigForm = document.querySelector("#plugin-config-form");
const navProvider = document.querySelector("#nav-provider");
const navProfile = document.querySelector("#nav-profile");
const heroMetrics = document.querySelector("#hero-metrics");
const heroFocus = document.querySelector("#hero-focus");
const heroLastEvent = document.querySelector("#hero-last-event");
const railHealth = document.querySelector("#rail-health");
const sessionContext = document.querySelector("#session-context");
const toolOutput = document.querySelector("#tool-output");

let latestState = null;
let latestGateway = null;
let eventStream = null;
let selectedSessionId = "";
let selectedAgentId = "";
let selectedPluginId = "";
let selectedAdapterId = "";
let selectedJobId = "";
let selectedShellAuditId = "";
let latestPluginDetail = null;
let refreshTimer = null;
let shellPolicyEditorDirty = false;
let latestMediaSetup = null;
let latestMediaInstallPlan = null;
let designBridgeLoaded = false;
let latestGatewayToken = "";
let activeChatController = null;
let activeRunId = "";
let activeRunEvents = [];
let activeRunStartedAt = 0;

function readStoredValue(key, fallback = "") {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeStoredValue(key, value = "") {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage is a convenience only; dashboard state still works without it.
  }
}

selectedSessionId = readStoredValue("omniclaw.selectedSessionId");
selectedAgentId = readStoredValue("omniclaw.selectedAgentId");

function rememberSelectedSession(session = null) {
  const sessionId = session?.id || selectedSessionId || "";
  const agentId = normalizeAgentId(session?.agentId || selectedAgentId || "main");
  selectedSessionId = sessionId;
  selectedAgentId = agentId;
  writeStoredValue("omniclaw.selectedSessionId", sessionId);
  writeStoredValue("omniclaw.selectedAgentId", agentId);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeAgentId(value) {
  const text = String(value || "").trim();
  return text || "main";
}

function truncate(value, max = 120) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...` : text;
}

function formatDate(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeAgo(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);

  if (Math.abs(minutes) < 1) {
    return "just now";
  }
  if (Math.abs(minutes) < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function toneForStatus(status) {
  const value = String(status || "").toLowerCase();
  if (
    value.includes("run") ||
    value.includes("active") ||
    value.includes("completed") ||
    value.includes("idle") ||
    value.includes("enabled") ||
    value.includes("approved")
  ) {
    return "ok";
  }
  if (value.includes("queue") || value.includes("pending") || value.includes("waiting") || value.includes("approval")) {
    return "warn";
  }
  if (value.includes("error") || value.includes("archived") || value.includes("disabled") || value.includes("failed")) {
    return "danger";
  }
  return "muted";
}

function statusPill(label, tone = "muted") {
  return `<span class="status-pill tone-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function metricTile(label, value, detail = "") {
  const safeDetail = detail ? `<small>${escapeHtml(detail)}</small>` : "";
  return [
    `<div class="metric-tile">`,
    `<span>${escapeHtml(label)}</span>`,
    `<strong>${escapeHtml(value)}</strong>`,
    safeDetail,
    `</div>`,
  ].join("");
}

function summaryCard(title, body, footer = "") {
  const safeFooter = footer ? `<p>${escapeHtml(footer)}</p>` : "";
  return [
    `<div class="summary-card">`,
    `<h4>${escapeHtml(title)}</h4>`,
    `<p>${escapeHtml(body)}</p>`,
    safeFooter,
    `</div>`,
  ].join("");
}

function toneForLayerStatus(status = "") {
  if (status === "ready") {
    return "ok";
  }
  if (status === "partial") {
    return "warn";
  }
  return "danger";
}

function renderLayerOverview(report = {}) {
  const layers = report.layers || [];
  if (!layers.length) {
    return "";
  }

  const rows = layers
    .map((layer) => [
      `<div class="layer-row">`,
      `<div class="layer-row-main">`,
      `<strong>L${escapeHtml(layer.id)} ${escapeHtml(layer.name)}</strong>`,
      `<small>${escapeHtml(layer.goal || "")}</small>`,
      `</div>`,
      statusPill(`${layer.status} | ${layer.readyCount}/${(layer.components || []).length}`, toneForLayerStatus(layer.status)),
      `</div>`,
    ].join(""))
    .join("");

  const summary = report.summary || {};
  return [
    `<div class="layer-overview">`,
    `<div class="layer-overview-head">`,
    `<div>`,
    `<h4>OpenClaw layer map</h4>`,
    `<p>${escapeHtml(summary.tools || 0)} tools, ${escapeHtml(summary.skills || 0)} skills, ${escapeHtml(summary.sessions || 0)} sessions from live runtime.</p>`,
    `</div>`,
    statusPill(summary.status || "partial", toneForLayerStatus(summary.status)),
    `</div>`,
    rows,
    `</div>`,
  ].join("");
}

function stackItem(title, detail = "", meta = "", tone = "muted") {
  const safeDetail = detail ? `<p>${escapeHtml(detail)}</p>` : "";
  const safeMeta = meta ? `<small>${escapeHtml(meta)}</small>` : "";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(title)}</strong>`,
    statusPill(tone === "muted" ? "info" : tone, tone),
    `</div>`,
    safeDetail,
    safeMeta,
    `</div>`,
  ].join("");
}

function sessionButton(session, selected) {
  const preview = truncate(session.lastAssistantPreview || session.lastUserMessagePreview || "No preview yet.", 120);
  const meta = `${session.agentId || "main"} | ${session.channel} | ${session.messageCount} msg | ${session.runCount} run`;
  const queueMeta = session.queueDepth ? ` | ${session.queueDepth} queued` : "";
  const tone = toneForStatus(session.status || session.lifecycleState || "idle");
  const className = selected ? "list-button is-selected" : "list-button";

  return [
    `<button type="button" class="${className}" data-session-id="${escapeHtml(session.id)}" data-session-label="${escapeHtml(session.label)}" data-agent-id="${escapeHtml(session.agentId || "main")}">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(session.label)}</strong>`,
    statusPill(session.status || session.lifecycleState || "idle", tone),
    `</div>`,
    `<span>${escapeHtml(meta + queueMeta)}</span>`,
    `<small>${escapeHtml(preview)}</small>`,
    `</button>`,
  ].join("");
}

function pluginCard(plugin, selected) {
  const tone = toneForStatus(plugin.status || (plugin.enabled ? "ready" : "disabled"));
  const meta = !plugin.valid
    ? plugin.errors?.[0] || "Manifest validation failed"
    : !plugin.configStatus?.valid
      ? plugin.configStatus.errors?.[0] || "Config validation failed"
      : `${plugin.runtime?.tools?.length || 0} tools | ${plugin.setup?.kind || "manifest"}`;
  const selectedPill = selected ? statusPill("selected", "ok") : "";

  return [
    `<div class="stack-item${selected ? " plugin-card-selected" : ""}">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(plugin.name)}</strong>`,
    `<div class="hero-actions">${selectedPill}${statusPill(plugin.status || "unknown", tone)}</div>`,
    `</div>`,
    `<p>${escapeHtml(plugin.description || "No plugin description")}</p>`,
    `<small>${escapeHtml(`${plugin.id} | ${meta}`)}</small>`,
    `<div class="hero-actions">`,
    `<button type="button" class="button button-ghost button-small" data-plugin-select="${escapeHtml(plugin.id)}">Inspect</button>`,
    `<button type="button" class="button button-ghost button-small" data-plugin-toggle="${escapeHtml(plugin.id)}" data-plugin-enabled="${plugin.enabled ? "true" : "false"}">${plugin.enabled ? "Disable" : "Enable"}</button>`,
    `</div>`,
    `</div>`,
  ].join("");
}

function renderPluginField(field) {
  const key = escapeHtml(field.key);
  const label = escapeHtml(field.label || humanizeLabel(field.key));
  const help = field.description ? `<div class="plugin-field-help">${escapeHtml(field.description)}</div>` : "";
  const value = field.value ?? field.default;

  if (field.type === "boolean") {
    return [
      `<div class="plugin-field">`,
      `<label class="plugin-bool">`,
      `<input type="checkbox" data-config-key="${key}" data-config-type="boolean" ${value ? "checked" : ""} />`,
      `<span>${label}</span>`,
      `</label>`,
      help,
      `</div>`,
    ].join("");
  }

  if (Array.isArray(field.enum) && field.enum.length > 0) {
    const options = field.enum
      .map((item) => {
        const selected = value === item ? "selected" : "";
        return `<option value="${escapeHtml(item)}" ${selected}>${escapeHtml(item)}</option>`;
      })
      .join("");

    return [
      `<div class="plugin-field">`,
      `<label>${label}</label>`,
      `<select data-config-key="${key}" data-config-type="${escapeHtml(field.type)}">${options}</select>`,
      help,
      `</div>`,
    ].join("");
  }

  if (field.multiline) {
    return [
      `<div class="plugin-field">`,
      `<label>${label}</label>`,
      `<textarea data-config-key="${key}" data-config-type="string" rows="4" placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(value == null ? "" : value)}</textarea>`,
      help,
      `</div>`,
    ].join("");
  }

  if (field.type === "number") {
    const min = field.min != null ? `min="${escapeHtml(field.min)}"` : "";
    const max = field.max != null ? `max="${escapeHtml(field.max)}"` : "";
    return [
      `<div class="plugin-field">`,
      `<label>${label}</label>`,
      `<input type="number" data-config-key="${key}" data-config-type="number" value="${escapeHtml(value == null ? "" : value)}" ${min} ${max} placeholder="${escapeHtml(field.placeholder || "")}" />`,
      help,
      `</div>`,
    ].join("");
  }

  const inputType = field.secret ? "password" : "text";
  return [
    `<div class="plugin-field">`,
    `<label>${label}</label>`,
    `<input type="${inputType}" data-config-key="${key}" data-config-type="string" value="${escapeHtml(value == null ? "" : value)}" placeholder="${escapeHtml(field.placeholder || "")}" />`,
    help,
    `</div>`,
  ].join("");
}

function humanizeLabel(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

window.toggleTokenVisibility = function() {
  const input = document.getElementById("gw-token");
  if (input.type === "password") {
    input.type = "text";
  } else {
    input.type = "password";
  }
};

function renderPluginDetail(plugin) {
  if (!plugin) {
    pluginConfigFields.innerHTML = emptyState("Select a plugin to configure it.");
    document.querySelector("#plugin-config-id").value = "";
    return emptyState("Select a plugin to inspect its manifest lifecycle.");
  }

  document.querySelector("#plugin-config-id").value = plugin.id;
  pluginConfigFields.innerHTML = plugin.configFields?.length > 0
    ? plugin.configFields.map(renderPluginField).join("")
    : emptyState("This plugin does not declare configurable fields.");

  const toolList = (plugin.runtime?.tools || [])
    .map((tool) => [
      `<div class="stack-item">`,
      `<strong>${escapeHtml(tool.id)}</strong>`,
      `<p>${escapeHtml(tool.description || "No tool description")}</p>`,
      `<small>${escapeHtml(tool.permission || "plugin")} permission</small>`,
      `</div>`,
    ].join(""))
    .join("");

  const issues = [
    ...(plugin.errors || []),
    ...(plugin.configStatus?.errors || []),
    ...(plugin.warnings || []),
    ...(plugin.configStatus?.warnings || []),
  ];
  const issueHtml = issues.length
    ? `<div class="detail-list">${issues.map((issue) => `<div class="stack-item"><strong>Issue</strong><p>${escapeHtml(issue)}</p></div>`).join("")}</div>`
    : "";

  return [
    `<div class="metric-strip">`,
    metricTile("Status", plugin.status || "unknown", plugin.enabled ? "Enabled for runtime" : "Disabled"),
    metricTile("Tools", plugin.runtime?.tools?.length || 0, `Default: ${plugin.runtime?.defaultToolId || "none"}`),
    metricTile("Queue", plugin.runtime?.jobs?.queue || "default", `${plugin.runtime?.jobs?.concurrency || 1} worker`),
    metricTile("Config", plugin.configStatus?.valid ? "valid" : "invalid", `${plugin.configStatus?.errors?.length || 0} error(s)`),
    `</div>`,
    `<div class="summary-grid">`,
    summaryCard("Setup", plugin.setup?.summary || "No setup summary", (plugin.setup?.steps || []).join(" -> ") || "No setup steps"),
    summaryCard("Runtime", `${plugin.runtime?.tools?.length || 0} runtime tool(s), queue ${plugin.runtime?.jobs?.queue || "default"}.`, plugin.runtime?.jobs?.enabled ? "Background jobs enabled" : "Background jobs disabled"),
    `</div>`,
    issueHtml,
    `<div class="mini-header"><span>Runtime tools</span></div>`,
    `<div class="detail-list">${toolList || emptyState("No runtime tools declared.")}</div>`,
  ].join("");
}

function collectPluginConfigPatch() {
  const patch = {};
  for (const field of pluginConfigFields.querySelectorAll("[data-config-key]")) {
    const key = field.dataset.configKey;
    const type = field.dataset.configType || "string";
    if (!key) {
      continue;
    }
    if (type === "boolean") {
      patch[key] = field.checked;
    } else if (type === "number") {
      const raw = String(field.value || "").trim();
      if (raw) {
        patch[key] = Number(raw);
      }
    } else {
      patch[key] = field.value;
    }
  }
  return patch;
}

function renderTranscriptEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  if (entry.type === "session") {
    return `<div class="transcript-line transcript-line-meta"><span class="transcript-role">open</span><div><strong>${escapeHtml(entry.label || entry.sessionId || "session")}</strong><br><span>${escapeHtml(entry.channel || "webchat")} | ${escapeHtml(formatDate(entry.createdAt || entry.at))}</span></div></div>`;
  }
  if (entry.type === "message") {
    return `<div class="transcript-line"><span class="transcript-role">${escapeHtml(entry.role || "message")}</span><div><strong>${escapeHtml(formatDate(entry.at))}</strong><br>${escapeHtml(entry.text || "(empty)")}</div></div>`;
  }
  if (entry.type === "run") {
    const payload = entry.payload ? truncate(JSON.stringify(entry.payload), 220) : "";
    return `<div class="transcript-line transcript-line-meta"><span class="transcript-role">run</span><div><strong>${escapeHtml(entry.phase || "event")}</strong><br><span>${escapeHtml(entry.runId || "")}${payload ? ` | ${escapeHtml(payload)}` : ""}</span></div></div>`;
  }
  if (entry.type === "event") {
    const payload = entry.payload ? truncate(JSON.stringify(entry.payload), 220) : "";
    return `<div class="transcript-line transcript-line-meta"><span class="transcript-role">evt</span><div><strong>${escapeHtml(entry.event || "event")}</strong><br><span>${escapeHtml(formatDate(entry.at))}${payload ? ` | ${escapeHtml(payload)}` : ""}</span></div></div>`;
  }
  return `<div class="transcript-line"><span class="transcript-role">raw</span><div>${escapeHtml(JSON.stringify(entry))}</div></div>`;
}

function renderSessionDetail(session) {
  if (!session) {
    return emptyState("Select a session to inspect its transcript.");
  }

  const transcriptHtml = (session.transcript || []).slice().reverse().map(renderTranscriptEntry).join("");
  const stateLabel = session.lifecycleState || session.status || "active";

  return [
    `<div class="metric-strip">`,
    metricTile("Messages", session.messageCount || 0, "Conversation entries"),
    metricTile("Runs", session.runCount || 0, "Gateway executions"),
    metricTile("Queued", session.queueDepth || 0, "Pending within lane"),
    metricTile("Idle", session.idleMinutes || 0, "Minutes since last activity"),
    `</div>`,
    `<div class="summary-grid">`,
    summaryCard("Session key", session.key || "unknown", session.transcriptPath || "No transcript path"),
    summaryCard("Lifecycle", stateLabel, session.parentSessionId ? `Parent: ${session.parentSessionId}` : "No parent session"),
    `</div>`,
    summaryCard(
      "Previews",
      session.lastAssistantPreview || "No assistant preview yet.",
      session.lastUserMessagePreview || "No user preview yet.",
    ),
    `<div class="transcript-block">${transcriptHtml || emptyState("No transcript entries yet.")}</div>`,
  ].join("");
}

function summarizeToolOutput(item = {}) {
  const output = item.output || {};
  if (output.error || output.blocked) {
    return output.message || output.reason || output.stderr || "Tool was blocked or failed.";
  }
  if (Array.isArray(output.results)) {
    const first = output.results[0] || {};
    return `${output.results.length} result(s)${first.title ? `: ${first.title}` : ""}`;
  }
  if (output.execution) {
    const execution = output.execution || {};
    const body = execution.stdout || execution.stderr || execution.command || "";
    return `${execution.status || "executed"}${execution.exitCode != null ? ` (${execution.exitCode})` : ""}: ${body}`;
  }
  if (output.stdout || output.stderr) {
    return output.stdout || output.stderr;
  }
  if (output.path || output.file) {
    return `${output.path || output.file}${output.bytesWritten ? ` | ${output.bytesWritten} bytes` : ""}`;
  }
  if (output.content) {
    return output.content;
  }
  return formatJson(output || {});
}

function renderChatToolTrace(entry = {}) {
  const toolOutputs = Array.isArray(entry.toolOutputs) ? entry.toolOutputs : [];
  const loop = entry.modelToolLoop && typeof entry.modelToolLoop === "object" ? entry.modelToolLoop : null;
  const provider = entry.providerDiagnostics && typeof entry.providerDiagnostics === "object" ? entry.providerDiagnostics : null;
  const blocks = [];

  if (provider?.status || entry.planSummary) {
    blocks.push([
      `<div class="chat-trace-card chat-trace-card-provider">`,
      `<div class="chat-trace-head"><strong>Provider</strong>${provider?.status ? statusPill(provider.status, toneForStatus(provider.status)) : ""}</div>`,
      `<p>${escapeHtml(entry.planSummary || provider?.reason || "Provider response completed.")}</p>`,
      provider?.durationMs ? `<small>${escapeHtml(`${provider.providerId || "provider"} | ${provider.model || "model"} | ${provider.durationMs}ms`)}</small>` : "",
      `</div>`,
    ].join(""));
  }

  if (loop && (loop.attempted || loop.toolCallCount || loop.stoppedReason || loop.skippedReason)) {
    const loopTone = loop.errors?.length ? "danger" : loop.toolCallCount ? "ok" : "muted";
    const details = [
      `${loop.rounds || 0} round(s)`,
      `${loop.toolCallCount || 0} tool(s)`,
      loop.recoveredToolCalls ? `${loop.recoveredToolCalls} recovered` : "",
      loop.repeatedToolCallsSkipped ? `${loop.repeatedToolCallsSkipped} repeat skipped` : "",
      loop.rejectedToolCalls?.length ? `${loop.rejectedToolCalls.length} rejected` : "",
    ].filter(Boolean).join(" | ");
    blocks.push([
      `<div class="chat-trace-card chat-trace-card-brain">`,
      `<div class="chat-trace-head"><strong>Brain loop</strong>${statusPill(loop.stoppedReason || loop.skippedReason || "checked", loopTone)}</div>`,
      `<p>${escapeHtml(details || loop.skippedReason || "No extra runtime tools needed.")}</p>`,
      Array.isArray(loop.roundDetails) && loop.roundDetails.length
        ? `<small>${escapeHtml(loop.roundDetails.map((item) => `r${item.round}:${item.status}`).join(" -> "))}</small>`
        : "",
      `</div>`,
    ].join(""));
  }

  if (toolOutputs.length > 0) {
    blocks.push([
      `<div class="chat-tool-strip">`,
      toolOutputs.map((item) => {
        const failed = Boolean(item.output?.error || item.output?.blocked);
        const label = item.source === "model-tool-loop" ? "brain" : "plan";
        return [
          `<div class="chat-tool-card">`,
          `<div class="chat-trace-head"><strong>${escapeHtml(item.tool || "tool")}</strong>${statusPill(failed ? "failed" : label, failed ? "danger" : "ok")}</div>`,
          item.reason ? `<small>${escapeHtml(item.reason)}</small>` : "",
          `<p>${escapeHtml(truncate(summarizeToolOutput(item), 220))}</p>`,
          `</div>`,
        ].join("");
      }).join(""),
      `</div>`,
    ].join(""));
  }

  return blocks.length ? `<div class="chat-trace">${blocks.join("")}</div>` : "";
}

function renderChatTranscript(session) {
  if (!chatTranscript) {
    return;
  }
  if (!session) {
    chatTranscript.innerHTML = emptyState("No conversation loaded yet.");
    return;
  }

  const messages = (session.transcript || []).filter((entry) => entry.type === "message");
  if (messages.length === 0) {
    chatTranscript.innerHTML = emptyState("This session has no messages yet.");
    return;
  }

  chatTranscript.innerHTML = messages
    .map((entry) => {
      const role = entry.role === "assistant" ? "assistant" : entry.role === "user" ? "user" : "system";
      const traceHtml = role === "assistant" ? renderChatToolTrace(entry) : "";
      return [
        `<div class="chat-bubble chat-bubble-${escapeHtml(role)}">`,
        `<div class="chat-bubble-meta">${escapeHtml(role)} | ${escapeHtml(formatDate(entry.at))}</div>`,
        `<div class="chat-bubble-text">${escapeHtml(entry.text || "")}</div>`,
        traceHtml,
        `</div>`,
      ].join("");
    })
    .join("");
  chatTranscript.scrollTop = chatTranscript.scrollHeight;
}

function formatChatResponse(data) {
  if (data.error) {
    return `ERROR\n${data.error}\n\n${formatJson(data)}`;
  }

  const run = data.run || {};
  const session = data.session || {};
  const agent = data.agent || {};
  const provider = data.provider || {};
  const plan = data.plan || {};
  const lines = [
    `RUN ${run.id || "unknown"} -> ${run.status || "unknown"}`,
    `SESSION ${session.label || "main"} | ${session.channel || "webchat"}`,
    `AGENT ${agent.id || session.agentId || "main"}${agent.profileId ? ` | ${agent.profileId}` : ""}`,
    `PROVIDER ${provider.id || "unknown"}`,
    "",
    data.reply || "(no reply)",
  ];

  if (data.providerDiagnostics) {
    const diag = data.providerDiagnostics;
    lines.push(
      "",
      `PROVIDER STATUS ${diag.status || "unknown"}${diag.reason ? ` | ${diag.reason}` : ""}${diag.durationMs ? ` | ${diag.durationMs}ms` : ""}`,
    );
    if (diag.message) {
      lines.push(diag.message);
    }
  }

  if (Array.isArray(data.intents) && data.intents.length > 0) {
    lines.push("", `INTENTS ${data.intents.join(", ")}`);
  }

  if (plan.summary) {
    lines.push("", `PLAN ${plan.summary}`);
  }

  if (Array.isArray(plan.steps) && plan.steps.length > 0) {
    lines.push(
      ...plan.steps.map((step, index) => {
        const tool = step.tool ? ` | ${step.tool}` : "";
        return `${index + 1}. ${step.type}${tool} - ${step.reason || "no reason"}`;
      }),
    );
  }

  if (Array.isArray(data.toolOutputs) && data.toolOutputs.length > 0) {
    lines.push("", "TOOL OUTPUTS", formatJson(data.toolOutputs));
  }

  if (data.modelToolLoop) {
    lines.push("", "BRAIN LOOP", formatJson(data.modelToolLoop));
  }

  if (Array.isArray(data.approvals) && data.approvals.length > 0) {
    lines.push("", `APPROVALS ${data.approvals.length} pending`);
  }

  return lines.join("\n");
}

function resetLiveRunTimeline(message = "Starting gateway run...") {
  activeRunId = "";
  activeRunEvents = [];
  activeRunStartedAt = Date.now();
  renderLiveRunTimeline(message);
}

function renderLiveRunTimeline(fallback = "No active run.") {
  if (!liveRunOutput) {
    return;
  }
  const elapsed = activeRunStartedAt ? Math.max(0, Math.round((Date.now() - activeRunStartedAt) / 1000)) : 0;
  const header = activeRunId ? `Live run ${activeRunId} | ${elapsed}s` : fallback;
  const items = activeRunEvents.slice(-12).map((record) => {
    const payload = record.payload || {};
    const tool = payload.tool ? ` | ${payload.tool}` : "";
    const provider = payload.providerId ? ` | ${payload.providerId}${payload.model ? `/${payload.model}` : ""}` : "";
    const status = payload.status ? ` | ${payload.status}` : "";
    const reason = payload.reason ? ` | ${payload.reason}` : "";
    const time = record.at ? formatDate(record.at) : "now";
    return `${time}  ${record.event || record.type}${tool}${provider}${status}${reason}`;
  });
  liveRunOutput.innerHTML = [
    `<div class="live-run-header">${escapeHtml(header)}</div>`,
    `<div class="live-run-list">${items.length ? items.map((item) => `<div>${escapeHtml(item)}</div>`).join("") : `<div>${escapeHtml(fallback)}</div>`}</div>`,
  ].join("");
}

function trackLiveRunEvent(record) {
  if (!activeChatController) {
    return;
  }
  const payload = record.payload || {};
  const runId = payload.runId || "";
  const interesting = /^(agent|tool|model_tool_loop|provider|context|shell|terminal|approval|run)\./.test(record.event || "");
  if (!interesting) {
    return;
  }
  if (!activeRunId && runId) {
    activeRunId = runId;
  }
  if (activeRunId && runId && runId !== activeRunId) {
    return;
  }
  activeRunEvents.push(record);
  renderLiveRunTimeline("Waiting for first gateway event...");
}

async function fetchPromptTrace(runId) {
  if (!runId || !promptTraceOutput) {
    return null;
  }
  promptTraceOutput.textContent = `Loading prompt trace for ${runId}...`;
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/prompt-trace`);
  const data = await response.json();
  if (!response.ok) {
    promptTraceOutput.textContent = data.error || "Prompt trace is not available for this run.";
    return null;
  }
  renderPromptTrace(data);
  return data;
}

function renderPromptTrace(data) {
  if (!promptTraceOutput) {
    return;
  }
  const trace = data.promptTrace || {};
  const report = trace.report || data.context || {};
  const lines = [
    `RUN ${data.runId || trace.runId || "unknown"} | ${data.status || "unknown"}`,
    `AGENT ${data.agentId || trace.agentId || "main"} | SESSION ${data.sessionId || trace.sessionId || ""}`,
    report.summary ? `CONTEXT ${report.summary}` : "",
    `WORKSPACE ${(trace.workspace?.files || []).length || 0} file(s) | TOOLS ${(trace.tools || []).length || 0} | SKILLS ${(trace.skills || []).length || 0}`,
    "",
    "REPORT",
    formatJson(report),
    "",
    "WORKSPACE FILES",
    formatJson(trace.workspace?.files || []),
    "",
    "MEMORY",
    formatJson(trace.memory || {}),
    "",
    "TOOL OUTPUTS",
    formatJson(trace.toolOutputs || []),
  ].filter((line) => line !== "");
  promptTraceOutput.textContent = lines.join("\n");
}

async function fetchToolTrace(runId) {
  if (!runId || !toolTraceOutput) {
    return null;
  }
  toolTraceOutput.textContent = `Loading tool trace for ${runId}...`;
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/tool-trace`);
  const data = await response.json();
  if (!response.ok) {
    toolTraceOutput.textContent = data.error || "Tool trace is not available for this run.";
    return null;
  }
  renderToolTrace(data);
  return data;
}

function renderToolTrace(data) {
  if (!toolTraceOutput) {
    return;
  }
  const trace = Array.isArray(data.toolTrace) ? data.toolTrace : [];
  const lines = [
    `RUN ${data.runId || "unknown"} | ${data.status || "unknown"}`,
    `AGENT ${data.agentId || "main"} | SESSION ${data.sessionId || ""}`,
    `TOOLS ${data.toolTraceCount || trace.length} | STATUS ${data.toolExecutionStatus || "idle"}${data.currentTool ? ` | CURRENT ${data.currentTool}` : ""}`,
    "",
    ...trace.map((item, index) => {
      const header = [
        `${index + 1}. ${item.tool || "tool"}`,
        item.status || "unknown",
        item.source || "runtime",
        item.round ? `round ${item.round}` : "",
        Number.isFinite(Number(item.durationMs)) ? `${item.durationMs}ms` : "",
      ].filter(Boolean).join(" | ");
      return [
        header,
        item.reason ? `reason: ${item.reason}` : "",
        `input: ${formatJson(item.input || {})}`,
        `output: ${formatJson(item.output || {})}`,
      ].filter(Boolean).join("\n");
    }),
    trace.length === 0 ? "No tool executions captured yet." : "",
    "",
    "MODEL TOOL LOOP",
    formatJson(data.modelToolLoop || {}),
    "",
    "SHELL EXECUTIONS",
    formatJson(data.shellExecutions || []),
  ].filter((line) => line !== "");
  toolTraceOutput.textContent = lines.join("\n\n");
}

function syncRuntimeControls(state) {
  const config = state.config || {};
  const runtimeProfile = (state.runtime && state.runtime.profile && state.runtime.profile.id) || config.runtime?.activeProfile;
  const providerConfig = config.provider || {};
  const providerProfileId = providerConfig.apiKeyProviderId;
  const providerInput = document.querySelector("#provider-key");
  const removeKeyInput = document.querySelector("#provider-remove-key");

  document.querySelector("#profile").value = runtimeProfile || "balanced";
  document.querySelector("#provider-mode").value = providerConfig.mode || "mock";
  document.querySelector("#provider-model").value = providerConfig.model || "";
  document.querySelector("#provider-key-id").value = providerProfileId || "openai";
  document.querySelector("#provider-profile").value = inferProfileFromProviderId(providerProfileId || "openai");
  if (providerInput && document.activeElement !== providerInput) {
    providerInput.value = "";
  }
  if (removeKeyInput) {
    removeKeyInput.checked = false;
  }
  updateProviderProfileControls();
}

function updateProviderProfileControls() {
  const profileInput = document.querySelector("#provider-profile");
  const keyInput = document.querySelector("#provider-key");
  const keyIdInput = document.querySelector("#provider-key-id");
  const removeKeyInput = document.querySelector("#provider-remove-key");
  const profileId = profileInput?.value || "openai";
  const isCodexCli = profileId === "codex-cli";
  if (providerCodexHelp) {
    providerCodexHelp.hidden = !isCodexCli;
  }
  if (openCodexLoginButton) {
    openCodexLoginButton.hidden = !isCodexCli;
  }
  if (keyInput) {
    keyInput.disabled = isCodexCli;
    keyInput.placeholder = isCodexCli ? "No API key needed" : "sk-...";
    if (isCodexCli) {
      keyInput.value = "";
    }
  }
  if (keyIdInput) {
    keyIdInput.readOnly = isCodexCli;
  }
  if (removeKeyInput) {
    removeKeyInput.disabled = isCodexCli;
    if (isCodexCli) {
      removeKeyInput.checked = false;
    }
  }
}

function selectedSessionSummary() {
  if (!latestState || !Array.isArray(latestState.sessions)) {
    return null;
  }
  return latestState.sessions.find((session) => session.id === selectedSessionId) || null;
}

function selectedAgentSummary() {
  if (!latestState || !Array.isArray(latestState.agents)) {
    return null;
  }
  return latestState.agents.find((agent) => agent.id === selectedAgentId) || null;
}

function selectedPluginSummary() {
  if (!latestState || !Array.isArray(latestState.plugins)) {
    return null;
  }
  return latestState.plugins.find((plugin) => plugin.id === selectedPluginId) || null;
}

function selectedJobSummary() {
  if (!latestState || !Array.isArray(latestState.jobs)) {
    return null;
  }
  return latestState.jobs.find((job) => job.id === selectedJobId) || null;
}

function selectedShellAuditRecord() {
  const records = latestState?.shellExecution?.records || [];
  return records.find((record) => record.id === selectedShellAuditId) || null;
}

function parseJsonInput(value, fallback = {}) {
  const text = String(value || "").trim();
  if (!text) {
    return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function pickSessionForAgent(agentId, sessions = []) {
  const normalized = normalizeAgentId(agentId);
  return (
    sessions.find(
      (session) => normalizeAgentId(session.agentId) === normalized && session.lifecycleState !== "archived",
    ) ||
    sessions.find((session) => normalizeAgentId(session.agentId) === normalized) ||
    null
  );
}

function agentCard(agent, selected) {
  const tone = toneForStatus(agent.profile?.id || agent.profileId || "balanced");
  const restrictions = [
    ...(agent.blockedPermissions || []),
    ...(agent.blockedTools || []),
  ];
  const meta = [
    `${agent.profile?.id || agent.profileId || "balanced"} profile`,
    `${agent.stats?.toolCount || 0} tools`,
    `${agent.stats?.sessionCount || 0} sessions`,
  ].join(" | ");

  return [
    `<button type="button" class="${selected ? "list-button is-selected" : "list-button"}" data-agent-id="${escapeHtml(agent.id)}">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(agent.name)}</strong>`,
    statusPill(agent.profile?.id || agent.profileId || "balanced", tone),
    `</div>`,
    `<span>${escapeHtml(agent.description || "OmniClaw routed agent.")}</span>`,
    `<small>${escapeHtml(meta)}</small>`,
    `<small>${escapeHtml(restrictions.length ? `Restricted: ${restrictions.join(", ")}` : "No extra restrictions configured.")}</small>`,
    `</button>`,
  ].join("");
}

function renderAgentDetail(agent) {
  if (!agent) {
    return emptyState("Select an agent to inspect its routed profile.");
  }

  const channels = Array.isArray(agent.channels) && agent.channels.length ? agent.channels.join(", ") : "webchat";
  const blockedPermissions =
    Array.isArray(agent.blockedPermissions) && agent.blockedPermissions.length
      ? agent.blockedPermissions.join(", ")
      : "none";
  const blockedTools =
    Array.isArray(agent.blockedTools) && agent.blockedTools.length ? agent.blockedTools.join(", ") : "none";
  const allowedTools =
    Array.isArray(agent.allowedTools) && agent.allowedTools.length ? agent.allowedTools.join(", ") : "all visible";
  const workspaceFiles = agent.workspace?.files || [];
  const toolList = (agent.tools || [])
    .slice(0, 8)
    .map((tool) =>
      [
        `<div class="stack-item">`,
        `<strong>${escapeHtml(tool.id)}</strong>`,
        `<p>${escapeHtml(tool.description || "No description")}</p>`,
        `<small>${escapeHtml(tool.permission || "plugin")}</small>`,
        `</div>`,
      ].join(""),
    )
    .join("");
  const skillList = (agent.skills || [])
    .slice(0, 8)
    .map((skill) =>
      [
        `<div class="stack-item">`,
        `<strong>${escapeHtml(skill.name || skill.id)}</strong>`,
        `<p>${escapeHtml(skill.description || "No description")}</p>`,
        `<small>${escapeHtml((skill.triggers || []).join(", ") || "No triggers")}</small>`,
        `</div>`,
      ].join(""),
    )
    .join("");

  return [
    `<div class="metric-strip">`,
    metricTile("Profile", agent.profile?.id || agent.profileId || "balanced", agent.profile?.description || "Agent runtime profile"),
    metricTile("Sessions", agent.stats?.sessionCount || 0, `${agent.stats?.activeSessionCount || 0} active`),
    metricTile("Memory", agent.stats?.noteCount || 0, `${agent.stats?.conversationCount || 0} conversations`),
    metricTile("Tools", agent.stats?.toolCount || 0, `${agent.stats?.skillCount || 0} skills`),
    `</div>`,
    `<div class="summary-grid">`,
    summaryCard("Routing", agent.description || "No description", `Channels: ${channels}`),
    summaryCard("Workspace", agent.workspace?.path || "No workspace path", `${workspaceFiles.length} bootstrap files ready.`),
    summaryCard("Restrictions", `Blocked permissions: ${blockedPermissions}`, `Blocked tools: ${blockedTools}`),
    summaryCard("Allowlist", `Allowed tools: ${allowedTools}`, `Allowed skills: ${(agent.allowedSkillIds || []).join(", ") || "all visible"}`),
    `</div>`,
    `<div class="split-columns">`,
    `<div><div class="mini-header"><span>Visible tools</span></div><div class="detail-list">${toolList || emptyState("No tools visible for this agent.")}</div></div>`,
    `<div><div class="mini-header"><span>Visible skills</span></div><div class="detail-list">${skillList || emptyState("No skills visible for this agent.")}</div></div>`,
    `</div>`,
  ].join("");
}

function renderHero(state, gateway) {
  const provider = state.provider || {};
  const runtimeProfile = state.runtime?.profile || {};
  const overview = gateway?.overview || state.gateway || {};
  const sessions = state.sessions || [];
  const lastEvent = overview.lastEvent;
  const pendingApprovals = state.approvals || [];
  const selected = selectedSessionSummary();
  const selectedAgent = selectedAgentSummary();

  navProvider.textContent = `${provider.id || "unknown"} provider`;
  navProfile.textContent = `${runtimeProfile.id || "balanced"} profile`;

  heroMetrics.innerHTML = [
    metricTile("Sessions", sessions.length, `${sessions.filter((item) => item.lifecycleState !== "archived").length} active`),
    metricTile("Runs", overview.runCount || 0, `${overview.runningRuns || 0} running`),
    metricTile("Approvals", pendingApprovals.length, pendingApprovals.length ? "Operator attention needed" : "Queue is clear"),
    metricTile("Schedules", state.scheduler?.activeCount || 0, `${(state.jobs || []).length} jobs tracked`),
  ].join("");

  heroFocus.textContent = selected
    ? `${selected.label} is selected for ${selected.agentId}. Status: ${selected.status}. Queue depth: ${selected.queueDepth || 0}.`
    : selectedAgent
      ? `${selectedAgent.name} is active. Profile: ${selectedAgent.profile?.id || selectedAgent.profileId || "balanced"}.`
      : "No session selected yet. Composer will create or continue the label you enter.";

  heroLastEvent.textContent = lastEvent
    ? `Last event: ${lastEvent.event} at ${formatDate(lastEvent.at)}.`
    : "No gateway events have been recorded yet.";

  railHealth.innerHTML = [
    `<p><strong>Profile</strong><br>${escapeHtml(runtimeProfile.id || "unknown")} | ${escapeHtml(runtimeProfile.description || "No profile description")}</p>`,
    `<p><strong>Provider</strong><br>${escapeHtml(provider.mode || "unknown")} | ${escapeHtml(provider.id || "unknown")}</p>`,
    `<p><strong>Queue</strong><br>${escapeHtml(String(overview.runningRuns || 0))} running | ${escapeHtml(String(overview.queuedRuns || 0))} queued</p>`,
  ].join("");

  sessionContext.textContent = selected
    ? `${selected.label} · ${selected.status}`
    : "No session selected";
}

function renderOverview(state, gateway) {
  const sessions = state.sessions || [];
  const approvals = state.approvals || [];
  const notes = state.memory?.notes?.length || 0;
  const research = state.memory?.research?.length || 0;
  const artifacts = state.memory?.artifacts?.length || 0;
  const tools = state.tools?.length || 0;
  const skills = state.skills?.length || 0;
  const plugins = Array.isArray(state.plugins) ? state.plugins.length : Number(state.plugins || 0);
  const jobs = state.jobs?.length || 0;
  const delegations = state.delegations?.length || 0;
  const activeDelegations = state.delegations?.filter((item) => ["queued", "running"].includes(item.status)).length || 0;
  const contextMax = state.contextPolicy?.maxChars || 0;
  const writableRoots = (state.config?.tools?.filesystem?.writableRoots || []).join(", ") || "none";
  const layerReport = state.layers || {};

  inspectorOutput.innerHTML = [
    `<div class="metric-strip">`,
    metricTile("Running", gateway?.overview?.runningRuns || 0, "Current active runs"),
    metricTile("Queued", gateway?.overview?.queuedRuns || 0, "Per-session run backlog"),
    metricTile("Pending approvals", approvals.length, approvals.length ? "Manual decisions waiting" : "Clear"),
    metricTile("Layers", `${layerReport.summary?.readyLayers || 0}/${layerReport.layers?.length || 5}`, `${layerReport.summary?.partialLayers || 0} partial`),
    `</div>`,
    renderLayerOverview(layerReport),
    `<div class="summary-grid">`,
    summaryCard(
      "Runtime lane",
      `${state.runtime?.profile?.id || "unknown"} profile with ${tools} tools and ${skills} skills.`,
      `Writable roots: ${writableRoots}`,
    ),
    summaryCard(
      "Control plane",
      `${sessions.length} sessions, ${plugins} plugins, ${jobs} tracked jobs, ${state.scheduler?.scheduleCount || 0} schedules.`,
      gateway?.overview?.lastEvent ? `${gateway.overview.lastEvent.event} was the last gateway event.` : "No gateway event yet.",
    ),
    summaryCard(
      "Delegation",
      `${delegations} multi-agent handoff(s), ${activeDelegations} active.`,
      "Delegated child runs now stay visible in the control plane.",
    ),
    summaryCard(
      "Memory surface",
      `${notes} notes, ${research} research items, ${artifacts} artifacts.`,
      state.tasks?.length ? `${state.tasks.length} tasks remain open.` : "No open tasks tracked.",
    ),
    summaryCard(
      "Provider vault",
      state.providerSecrets?.length ? `${state.providerSecrets.length} provider secret entries configured.` : "No provider secrets recorded.",
      state.provider?.id || "Provider not set",
    ),
    summaryCard(
      "Context engine",
      contextMax ? `${contextMax} character budget for ${state.contextPolicy.profileId || "active"} profile.` : "Default context budget active.",
      "Runs now save a compact context report before provider calls.",
    ),
    `</div>`,
  ].join("");
}

function renderProviderStatus(state) {
  if (!providerStatusOutput) {
    return;
  }

  const provider = state.provider || {};
  const keySource = provider.apiKeySource || (provider.mode === "offline" ? "offline" : "unknown");
  const ready = provider.ready !== false && provider.apiKeySource !== "missing";
  const tone = ready ? "ok" : "warn";
  const isCodexCli = provider.id === "codex-cli" || provider.mode === "account-bridge";
  const secretRows = (state.providerSecrets || [])
    .map((secret) =>
      stackItem(
        secret.providerId || "provider",
        secret.configured ? `Stored key ${secret.masked || "configured"}` : "No stored key",
        "Secrets are shown masked only.",
        secret.configured ? "ok" : "muted",
      ),
    )
    .join("");

  providerStatusOutput.innerHTML = [
    isCodexCli
      ? `<div class="stack-item provider-callout"><strong>OpenAI account bridge</strong><p>Uses official Codex CLI auth instead of a BYOK key. If replies fail, run Codex login and choose Sign in with ChatGPT.</p><small>${escapeHtml(provider.command || "codex")} | ${escapeHtml(provider.sandbox || "read-only")} sandbox</small></div>`
      : "",
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(provider.id || "provider")}</strong>`,
    statusPill(ready ? "ready" : "needs key", tone),
    `</div>`,
    `<p>${escapeHtml(provider.message || `${provider.mode || "mode"} provider using ${keySource}.`)}</p>`,
    `<small>${escapeHtml(`${provider.model || "no model"} | ${provider.baseUrl || provider.mode || "local"} | key source ${keySource}`)}</small>`,
    `</div>`,
    isCodexCli
      ? emptyState("No API key is needed for the Codex CLI account bridge.")
      : secretRows || emptyState("No stored BYOK keys. Add one below, or switch runtime to mock for offline tests."),
  ].join("");
}

function renderGatewayEvents(gateway) {
  const items = (gateway?.events || []).slice(0, 8);
  gatewayOutput.innerHTML =
    items
      .map((item) => {
        const payload = item.payload ? truncate(JSON.stringify(item.payload), 104) : "No payload";
        return [
          `<div class="stack-item">`,
          `<div class="row-top">`,
          `<strong>${escapeHtml(item.event)}</strong>`,
          statusPill(`#${item.seq}`, "muted"),
          `</div>`,
          `<p>${escapeHtml(payload)}</p>`,
          `<small>${escapeHtml(formatDate(item.at))}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No gateway events yet.");
}

function renderRuns(gateway) {
  const items = (gateway?.runs || []).slice(0, 8);
  runOutput.innerHTML =
    items
      .map((item) => {
        const tone = toneForStatus(item.status);
        const wait = item.waitedMs != null ? `${item.waitedMs} ms wait` : "no wait";
        const shellExecution = Array.isArray(item.shellExecutions)
          ? item.shellExecutions[item.shellExecutions.length - 1]
          : null;
        const executionSummary = shellExecution
          ? `Shell ${shellExecution.status} (${shellExecution.exitCode ?? "no exit"}): ${
              shellExecution.stdout || shellExecution.stderr || shellExecution.command || "no output"
            }`
          : "";
        const summary = truncate(executionSummary || item.reply || item.message || "No reply body", 120);
        const shellMeta = shellExecution ? ` | shell ${shellExecution.status}` : "";
        const providerMeta = item.providerDiagnostics
          ? ` | provider ${item.providerDiagnostics.status || "unknown"}${item.providerDiagnostics.reason ? `/${item.providerDiagnostics.reason}` : ""}`
          : item.providerStatus
            ? ` | provider ${item.providerStatus}`
            : "";
        return [
          `<div class="stack-item">`,
          `<div class="row-top">`,
          `<strong>${escapeHtml(item.label || "session")}</strong>`,
          statusPill(item.status || "unknown", tone),
          `</div>`,
          `<p>${escapeHtml(summary)}</p>`,
          `<small>${escapeHtml(`${item.id} | ${item.agentId || "main"} | ${item.channel || "webchat"} | ${wait}${shellMeta}${providerMeta}`)}</small>`,
          `<div class="hero-actions"><button type="button" class="button button-ghost button-small" data-prompt-trace-run="${escapeHtml(item.id)}" ${item.promptTrace ? "" : "disabled"}>Prompt</button><button type="button" class="button button-ghost button-small" data-tool-trace-run="${escapeHtml(item.id)}" ${item.toolTrace ? "" : "disabled"}>Tools${item.toolTraceCount ? ` ${escapeHtml(String(item.toolTraceCount))}` : ""}</button></div>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No runs tracked yet.");

  for (const button of runOutput.querySelectorAll("[data-prompt-trace-run]")) {
    button.addEventListener("click", async () => {
      await fetchPromptTrace(button.dataset.promptTraceRun || "");
    });
  }
  for (const button of runOutput.querySelectorAll("[data-tool-trace-run]")) {
    button.addEventListener("click", async () => {
      await fetchToolTrace(button.dataset.toolTraceRun || "");
    });
  }
}

function renderBackgroundJobs(state) {
  const jobs = (state.jobs || []).slice(0, 10);
  const activeJobsOutput = document.querySelector("#active-jobs-output");
  const workerStatus = document.querySelector("#job-worker-status");
  
  const running = jobs.filter(j => j.status === "running");
  workerStatus.textContent = running.length > 0 ? "Busy" : "Idle";
  workerStatus.className = `status-chip status-chip-${running.length > 0 ? "warning" : "muted"}`;

  activeJobsOutput.innerHTML = jobs.map(job => {
    const tone = job.status === "completed" ? "success" : job.status === "failed" ? "danger" : job.status === "running" ? "warning" : "muted";
    return `
      <div class="stack-item">
        <div class="row-top">
          <strong>${escapeHtml(job.payload?.tool || job.type)}</strong>
          <span class="status-chip status-chip-${tone}">${job.status}</span>
        </div>
        <p style="font-size: 0.75rem; color: var(--text-muted);">${job.id} | source: ${job.source}</p>
        ${job.error ? `<p style="color: var(--danger); font-size: 0.75rem;">${escapeHtml(job.error)}</p>` : ""}
      </div>
    `;
  }).join("") || `<div class="empty-state">No background jobs found.</div>`;
}

function renderConnectorStatusOverview(state) {
  const output = document.querySelector("#connector-status-output");
  const telegram = state.connectors?.telegram || {};
  const discord = state.connectors?.discord || {};

  const channels = [
    { id: "telegram", name: "Telegram", status: telegram.status, running: state.workers?.telegram?.running },
    { id: "discord", name: "Discord", status: discord.status, running: state.workers?.discord?.running }
  ];

  output.innerHTML = channels.map(c => `
    <div class="stack-item">
      <div class="row-top">
        <strong>${c.name}</strong>
        <span class="status-chip status-chip-${c.running ? "success" : "muted"}">${c.running ? "Active" : "Stopped"}</span>
      </div>
      <p style="font-size: 0.75rem; color: var(--text-muted);">${c.status || "Not configured"}</p>
    </div>
  `).join("");
}

function attachSessionListeners() {
  for (const button of sessionOutput.querySelectorAll("[data-session-id]")) {
    button.addEventListener("click", async () => {
      selectedSessionId = button.dataset.sessionId || "";
      selectedAgentId = normalizeAgentId(button.dataset.agentId || selectedAgentId);
      rememberSelectedSession({ id: selectedSessionId, agentId: selectedAgentId });
      agentSelect.value = selectedAgentId;
      sessionLabelInput.value = button.dataset.sessionLabel || sessionLabelInput.value;
      await loadState();
    });
  }
}

function renderSessions(state) {
  const sessions = state.sessions || [];

  if (!state.agents?.some((agent) => agent.id === selectedAgentId)) {
    selectedAgentId = selectedSessionSummary()?.agentId || state.agents?.[0]?.id || "main";
  }

  if (!sessions.some((item) => item.id === selectedSessionId)) {
    const preferred = pickSessionForAgent(selectedAgentId, sessions) || sessions[0] || null;
    selectedSessionId = preferred ? preferred.id : "";
    if (preferred) {
      rememberSelectedSession(preferred);
    }
  }

  const selected = selectedSessionSummary();
  if (selected) {
    sessionLabelInput.value = selected.label;
    selectedAgentId = normalizeAgentId(selected.agentId);
    agentSelect.value = selectedAgentId;
    rememberSelectedSession(selected);
  }

  sessionOutput.innerHTML =
    sessions.map((session) => sessionButton(session, session.id === selectedSessionId)).join("") ||
    emptyState("No sessions available yet.");

  sessionContext.textContent = selected
    ? `${selected.label} | ${selected.agentId} | ${selected.status}`
    : selectedAgentSummary()
      ? `${selectedAgentSummary().name} | ready for a new session`
      : "No session selected";

  attachSessionListeners();
}

function renderAgents(state) {
  const agents = state.agents || [];
  if (!agents.some((agent) => agent.id === selectedAgentId)) {
    selectedAgentId = selectedSessionSummary()?.agentId || agents[0]?.id || "main";
  }

  agentSelect.innerHTML =
    agents
      .map(
        (agent) =>
          `<option value="${escapeHtml(agent.id)}" ${agent.id === selectedAgentId ? "selected" : ""}>${escapeHtml(agent.name)}</option>`,
      )
      .join("") || `<option value="main">main</option>`;

  if (delegationAgentSelect) {
    const previousTarget = normalizeAgentId(delegationAgentSelect.value || "");
    const fallbackTarget = agents.find((agent) => agent.id === "builder")?.id || agents[0]?.id || "main";
    const selectedTarget = agents.some((agent) => agent.id === previousTarget) ? previousTarget : fallbackTarget;
    delegationAgentSelect.innerHTML =
      agents
        .map(
          (agent) =>
            `<option value="${escapeHtml(agent.id)}" ${agent.id === selectedTarget ? "selected" : ""}>${escapeHtml(agent.name)}</option>`,
        )
        .join("") || `<option value="main">main</option>`;
  }

  if (delegationSourceInput) {
    const session = selectedSessionSummary();
    delegationSourceInput.value = session
      ? `${session.label || "session"} / ${session.agentId || selectedAgentId}`
      : `${selectedAgentId || "main"} / new session`;
  }

  agentOutput.innerHTML =
    agents.map((agent) => agentCard(agent, agent.id === selectedAgentId)).join("") ||
    emptyState("No agents configured.");
  agentDetailOutput.innerHTML = renderAgentDetail(selectedAgentSummary());

  for (const button of agentOutput.querySelectorAll("[data-agent-id]")) {
    button.addEventListener("click", async () => {
      selectedAgentId = normalizeAgentId(button.dataset.agentId || "main");
      const session = pickSessionForAgent(selectedAgentId, latestState?.sessions || []);
      selectedSessionId = session?.id || "";
      if (session?.label) {
        sessionLabelInput.value = session.label;
      }
      agentSelect.value = selectedAgentId;
      await loadState();
    });
  }
}

function renderDelegations(state) {
  if (!delegationOutput || !delegationContext) {
    return;
  }

  const delegations = state.delegations || [];
  const visibleDelegations = delegations.filter(
    (item) => !selectedAgentId || item.sourceAgentId === selectedAgentId || item.targetAgentId === selectedAgentId,
  );
  const activeCount = delegations.filter((item) => ["queued", "running"].includes(item.status)).length;
  delegationContext.textContent = `${activeCount} active | ${delegations.length} tracked`;
  delegationContext.className = `status-chip status-chip-${activeCount ? "warning" : "muted"}`;

  delegationOutput.innerHTML =
    visibleDelegations
      .map((item) => {
        const tone = toneForStatus(item.status || "queued");
        const active = ["queued", "running"].includes(item.status);
        const direction =
          item.sourceAgentId === selectedAgentId
            ? `to ${item.targetAgentId || "agent"}`
            : item.targetAgentId === selectedAgentId
              ? `from ${item.sourceAgentId || "agent"}`
              : `${item.sourceAgentId || "agent"} -> ${item.targetAgentId || "agent"}`;
        const result = item.error || item.replyPreview || item.instruction || "No delegation detail";
        const actions = active
          ? `<button type="button" class="button button-ghost button-small" data-delegation-cancel="${escapeHtml(item.id)}">Cancel</button>`
          : `<button type="button" class="button button-ghost button-small" data-delegation-retry="${escapeHtml(item.id)}">Retry</button>`;
        return [
          `<div class="stack-item">`,
          `<div class="row-top">`,
          `<strong>${escapeHtml(direction)}</strong>`,
          `<div class="hero-actions">${statusPill(item.status || "queued", tone)}${actions}</div>`,
          `</div>`,
          `<p>${escapeHtml(truncate(result, 180))}</p>`,
          `<small>${escapeHtml(`${item.id} | parent ${item.parentRunId || "none"} | child ${item.childRunId || item.childSessionId || "pending"}${item.retryDelegationId ? ` | retry ${item.retryDelegationId}` : ""} | ${formatDate(item.updatedAt || item.createdAt)}`)}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No delegations for the selected agent yet.");

  for (const button of delegationOutput.querySelectorAll("[data-delegation-cancel]")) {
    button.addEventListener("click", async () => {
      await cancelDelegation(button.dataset.delegationCancel || "");
    });
  }

  for (const button of delegationOutput.querySelectorAll("[data-delegation-retry]")) {
    button.addEventListener("click", async () => {
      await retryDelegation(button.dataset.delegationRetry || "");
    });
  }
}

function renderApprovals(state) {
  const items = state.approvals || [];
  approvalOutput.innerHTML =
    items
      .map((item) => {
        const payload = item.payload?.command ? `Command: ${item.payload.command}` : item.summary;
        const risk = item.payload?.risk || "review";
        const riskTone = risk === "low" ? "ok" : risk === "medium" ? "warn" : "danger";
        const reasons = Array.isArray(item.payload?.riskReasons) ? item.payload.riskReasons.join("; ") : "";
        return [
          `<div class="stack-item">`,
          `<div class="row-top">`,
          `<strong>${escapeHtml(item.type || "approval")}</strong>`,
          `<div class="hero-actions">${statusPill(risk, riskTone)}${statusPill(item.status || "pending", toneForStatus(item.status))}</div>`,
          `</div>`,
          `<p>${escapeHtml(payload || "No summary")}</p>`,
          `<small>${escapeHtml(`${item.runId || "no run"} | ${formatDate(item.createdAt)}${reasons ? ` | ${reasons}` : ""}`)}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No pending approvals.");
}

function shellAuditCard(record, selected) {
  const tone = toneForStatus(record.status || record.risk || "muted");
  const riskTone = record.risk === "low" ? "ok" : record.risk === "medium" ? "warn" : "danger";
  return [
    `<button type="button" class="${selected ? "list-button is-selected" : "list-button"}" data-shell-audit-id="${escapeHtml(record.id)}">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(record.command || record.id)}</strong>`,
    `<div class="hero-actions">${statusPill(record.risk || "unknown", riskTone)}${statusPill(record.status || record.phase || "record", tone)}</div>`,
    `</div>`,
    `<span>${escapeHtml((record.riskReasons || []).join("; ") || "No risk notes")}</span>`,
    `<small>${escapeHtml(`${record.phase || "audit"} | ${formatDate(record.at)} | ${record.approvalId || "no approval"}`)}</small>`,
    `</button>`,
  ].join("");
}

function loadShellPolicy(policy) {
  const modeSelect = document.querySelector("#shell-policy-mode");
  const trustSelect = document.querySelector("#policy-trust-level");
  const timeoutInput = document.querySelector("#shell-policy-timeout");
  const outputLimitInput = document.querySelector("#shell-policy-output-limit");
  const allowlistInput = document.querySelector("#shell-policy-allowlist");
  const blockedInput = document.querySelector("#shell-policy-blocked");

  modeSelect.value = policy.allowlistMode;
  trustSelect.value = policy.trustLevel || "protected";
  timeoutInput.value = policy.timeoutMs;
  outputLimitInput.value = policy.maxOutputBytes;
  allowlistInput.value = (policy.allowlistPatterns || []).join("\n");
  blockedInput.value = (policy.blockedPatterns || []).join("\n");

  const output = document.querySelector("#shell-policy-output");
  output.innerHTML = `
    <div class="status-row">
      <span class="status-label">Trust:</span>
      <span class="status-chip status-chip-${policy.trustLevel === "full" ? "danger" : policy.trustLevel === "balanced" ? "warning" : "muted"}">${policy.trustLevel || "protected"}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Mode:</span>
      <span class="status-chip status-chip-muted">${policy.allowlistMode}</span>
    </div>
  `;
}

function renderShellPolicy(shellExecution) {
  const policy = shellExecution?.policy || {};
  if (!shellPolicyEditorDirty) {
    loadShellPolicy(policy);
  }
  return "";
}

function renderShellAuditDetail(record) {
  if (!record) {
    return emptyState("Select an audit record to inspect command, risk, and execution metadata.");
  }
  const stdout = record.stdout ? `<pre class="console-output console-output-compact">${escapeHtml(record.stdout)}</pre>` : emptyState("No stdout captured for this audit record.");
  const stderr = record.stderr ? `<pre class="console-output console-output-compact">${escapeHtml(record.stderr)}</pre>` : emptyState("No stderr captured for this audit record.");
  return [
    `<div class="metric-strip">`,
    metricTile("Status", record.status || "unknown", record.phase || "audit"),
    metricTile("Risk", record.risk || "unknown", record.allowlisted ? "Allowlisted" : "Not allowlisted"),
    metricTile("Exit", record.exitCode ?? "n/a", record.timedOut ? "Timed out" : "No timeout"),
    metricTile("Duration", record.durationMs ?? 0, "ms"),
    `</div>`,
    summaryCard("Command", record.command || "No command", (record.riskReasons || []).join("; ") || "No risk reasons"),
    `<div class="split-columns">`,
    `<div><div class="mini-header"><span>Stdout</span></div>${stdout}</div>`,
    `<div><div class="mini-header"><span>Stderr</span></div>${stderr}</div>`,
    `</div>`,
    `<pre class="console-output console-output-compact">${escapeHtml(formatJson(record))}</pre>`,
  ].join("");
}

function renderShellAudit(state) {
  const shellExecution = state.shellExecution || {};
  const records = shellExecution.records || [];
  if (!records.some((record) => record.id === selectedShellAuditId)) {
    selectedShellAuditId = records[0]?.id || "";
  }

  shellAuditContext.textContent = `${shellExecution.audit?.executed || 0} executed | ${shellExecution.audit?.highRisk || 0} high risk`;
  renderShellPolicy(shellExecution);
  shellAuditOutput.innerHTML =
    records.map((record) => shellAuditCard(record, record.id === selectedShellAuditId)).join("") ||
    emptyState("No shell audit records yet.");
  shellAuditDetailOutput.innerHTML = renderShellAuditDetail(selectedShellAuditRecord());

  for (const button of shellAuditOutput.querySelectorAll("[data-shell-audit-id]")) {
    button.addEventListener("click", async () => {
      selectedShellAuditId = button.dataset.shellAuditId || "";
      renderShellAudit(latestState || {});
    });
  }
}

function connectorDeliveryCard(item) {
  const archiveMeta = item.archivePath ? ` | archived ${item.archivePath}` : "";
  const requestedAgent = item.requestedAgentId && item.requestedAgentId !== item.agentId ? ` via ${item.requestedAgentId}` : "";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(item.label || item.id)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.messagePreview || item.contentPreview || "No preview")}</p>`,
    `<small>${escapeHtml(`${item.agentId || "main"}${requestedAgent} | ${item.result?.runId || "no run"} | ${formatDate(item.createdAt || item.processedAt)}${archiveMeta}`)}</small>`,
    `</div>`,
  ].join("");
}

function pendingFileCard(item) {
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(item.fileName || item.id)}</strong>`,
    statusPill(`${item.size || 0} bytes`, "muted"),
    `</div>`,
    `<p>${escapeHtml(item.contentPreview || "No preview")}</p>`,
    `<small>${escapeHtml(`${item.relativePath || ""} | ${item.hash || ""}`)}</small>`,
    `</div>`,
  ].join("");
}

function adapterDeliveryCard(item) {
  const replyMeta = item.replyStatus ? ` | reply ${item.replyStatus}` : item.replySent ? " | reply sent" : "";
  const outboxMeta = item.outboxId ? ` | outbox ${item.outboxId}` : "";
  const sourceMeta = item.source ? ` | ${item.source}` : "";
  const attachmentMeta = item.attachmentCount ? ` | ${item.attachmentCount} attachment(s)` : "";
  const firstAttachment = item.attachments?.[0] || null;
  const cacheDisabled = firstAttachment?.cacheStatus === "cached" ? "disabled" : "";
  const ingestRunning = item.autoIngestionStatus === "running";
  const ingestLabel =
    item.autoIngestionStatus === "completed"
      ? "Run ingest again"
      : item.autoIngestionStatus === "failed"
        ? "Retry ingest"
        : ingestRunning
          ? "Ingesting"
          : "Run ingest";
  const attachmentActions = item.attachmentCount
    ? [
        `<div class="hero-actions connector-actions">`,
        `<button type="button" class="button button-ghost button-small" data-attachment-cache-delivery="${escapeHtml(item.id)}" data-attachment-cache-index="0" ${cacheDisabled}>${firstAttachment?.cacheStatus === "cached" ? "Cached locally" : firstAttachment?.cacheStatus === "failed" ? "Retry cache" : "Cache first attachment"}</button>`,
        `<button type="button" class="button button-ghost button-small" data-attachment-ingest-delivery="${escapeHtml(item.id)}" ${ingestRunning ? "disabled" : ""}>${ingestLabel}</button>`,
        `</div>`,
      ].join("")
    : "";
  const ingestionSummary = item.autoIngestionSummary
    ? `Ingest: ${item.autoIngestionSummary.status || item.autoIngestionStatus || "unknown"} | cached ${item.autoIngestionSummary.cached || 0} | extracted ${item.autoIngestionSummary.extracted || 0} | injected ${item.autoIngestionSummary.injected || 0} | failed ${item.autoIngestionSummary.failed || 0}`
    : item.autoIngestionStatus
      ? `Ingest: ${item.autoIngestionStatus}`
      : "";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(`${item.adapterId || item.channel || "adapter"}:${item.eventType || "message"}`)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.messagePreview || "No preview")}</p>`,
    item.attachmentSummary ? `<small>${escapeHtml(`Attachments: ${item.attachmentSummary}`)}</small>` : "",
    firstAttachment?.cachePath ? `<small>${escapeHtml(`Cached: ${firstAttachment.cachePath}`)}</small>` : "",
    firstAttachment?.cacheError ? `<small>${escapeHtml(`Cache error: ${firstAttachment.cacheError}`)}</small>` : "",
    ingestionSummary ? `<small>${escapeHtml(ingestionSummary)}</small>` : "",
    item.autoIngestionError ? `<small>${escapeHtml(`Ingest error: ${item.autoIngestionError}`)}</small>` : "",
    item.replyError ? `<small>${escapeHtml(`Reply error: ${item.replyError}`)}</small>` : "",
    `<small>${escapeHtml(`${item.agentId || "main"} | ${item.author || "unknown"} | ${item.result?.runId || "no run"} | ${formatDate(item.createdAt)}${sourceMeta}${attachmentMeta}${replyMeta}${outboxMeta}`)}</small>`,
    attachmentActions,
    `</div>`,
  ].join("");
}

function attachmentCacheCard(item) {
  const extractDone = ["completed", "media-metadata"].includes(item.extractStatus);
  const extractDisabled = item.status !== "cached" || extractDone ? "disabled" : "";
  const extractLabel = item.extractStatus === "completed" ? "Extracted" : item.extractStatus === "media-metadata" ? "Media metadata ready" : item.extractStatus === "failed" ? "Retry extract" : "Extract text";
  const mediaMeta = item.mediaKind
    ? `${item.mediaKind}${item.width || item.height ? ` | ${item.width || 0}x${item.height || 0}` : ""}${item.duration ? ` | ${item.duration}s` : ""}`
    : "";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(`${item.adapterId || "adapter"}:${item.name || item.type || "attachment"}`)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.relativePath || item.error || "No cached file path")}</p>`,
    item.contentPreview ? `<small>${escapeHtml(`Preview: ${truncate(item.contentPreview, 220)}`)}</small>` : "",
    item.extractError ? `<small>${escapeHtml(`Extract error: ${item.extractError}`)}</small>` : "",
    item.purgeReason ? `<small>${escapeHtml(`Retention: ${item.purgeReason} at ${formatDate(item.purgedAt)}`)}</small>` : "",
    mediaMeta ? `<small>${escapeHtml(`Media: ${mediaMeta}`)}</small>` : "",
    `<small>${escapeHtml(`${item.mimeType || "unknown"} | ${item.byteLength || 0} bytes | ${item.sha256 || "no hash"} | ${formatDate(item.createdAt)}`)}</small>`,
    `<div class="hero-actions connector-actions">`,
    `<button type="button" class="button button-ghost button-small" data-attachment-extract-cache="${escapeHtml(item.id)}" ${extractDisabled}>${extractLabel}</button>`,
    `</div>`,
    `</div>`,
  ].join("");
}

function attachmentExtractCard(item) {
  const canAnalyze = item.status === "media-metadata" || item.analysisStatus === "failed";
  const analyzeLabel =
    item.analysisStatus === "completed"
      ? "Analyzed"
      : item.analysisStatus === "failed"
        ? "Retry media analysis"
        : "Analyze media";
  const injectDisabled = item.status === "failed" || item.status === "media-metadata" || item.injectionStatus === "completed" ? "disabled" : "";
  const injectLabel =
    item.injectionStatus === "completed"
      ? "Sent to session"
      : item.injectionStatus === "failed"
        ? "Retry session import"
        : "Send to session";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(`${item.adapterId || "adapter"}:${item.name || item.type || "extract"}`)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.contentPreview || item.error || "No extracted preview")}</p>`,
    item.mediaKind ? `<small>${escapeHtml(`Media hook: ${item.mediaKind} | ${item.method || "metadata"} | ${item.status === "media-metadata" ? "OCR/transcription pending" : item.status}`)}</small>` : "",
    item.analysisStatus ? `<small>${escapeHtml(`Analysis: ${item.analysisStatus} | ${item.analysisProvider || "provider"}${item.analysisModel ? ` | ${item.analysisModel}` : ""}`)}</small>` : "",
    item.analysisError ? `<small>${escapeHtml(`Analysis error: ${item.analysisError}`)}</small>` : "",
    item.cachePurgedAt ? `<small>${escapeHtml(`Cache purged: ${formatDate(item.cachePurgedAt)} | ${item.cachePurgeReason || "retention"}`)}</small>` : "",
    item.injectionSessionId ? `<small>${escapeHtml(`Session import: ${item.injectionSessionId} | run ${item.injectionRunId || "no run"}`)}</small>` : "",
    item.injectionError ? `<small>${escapeHtml(`Import error: ${item.injectionError}`)}</small>` : "",
    `<small>${escapeHtml(`${item.method || "extract"} | ${item.characterCount || 0} chars | ${item.mimeType || "unknown"} | ${formatDate(item.createdAt)}`)}</small>`,
    `<div class="hero-actions connector-actions">`,
    item.mediaKind ? `<button type="button" class="button button-ghost button-small" data-attachment-analyze-extract="${escapeHtml(item.id)}" ${canAnalyze ? "" : "disabled"}>${analyzeLabel}</button>` : "",
    `<button type="button" class="button button-ghost button-small" data-attachment-inject-extract="${escapeHtml(item.id)}" ${injectDisabled}>${injectLabel}</button>`,
    `</div>`,
    `</div>`,
  ].join("");
}

function attachmentAnalysisCard(item) {
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(`${item.provider || "provider"}:${item.name || item.mediaKind || "media"}`)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.contentPreview || item.error || "No media analysis text")}</p>`,
    `<small>${escapeHtml(`${item.mediaKind || "media"} | ${item.model || "default"} | ${item.characterCount || 0} chars | ${formatDate(item.createdAt)}`)}</small>`,
    `</div>`,
  ].join("");
}

function attachmentInjectionCard(item) {
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(`${item.adapterId || "adapter"}:${item.name || item.type || "session import"}`)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.messagePreview || item.error || "No import preview")}</p>`,
    item.replyPreview ? `<small>${escapeHtml(`Reply: ${truncate(item.replyPreview, 220)}`)}</small>` : "",
    `<small>${escapeHtml(`${item.agentId || "main"} | session ${item.sessionId || "none"} | run ${item.runId || "none"} | ${item.characterCount || 0} chars | ${formatDate(item.createdAt)}`)}</small>`,
    `</div>`,
  ].join("");
}

function attachmentCleanupCard(item) {
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(item.dryRun ? "Cleanup preview" : "Cleanup run")}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(`${item.purged || 0} purged | ${item.orphanPurged || 0} orphan(s) | ${item.bytesFreed || 0} bytes freed`)}</p>`,
    `<small>${escapeHtml(`${item.candidates || 0} candidate(s) | would free ${item.bytesWouldFree || 0} bytes | budget ${item.policy?.maxTotalBytes || "default"} | ${formatDate(item.createdAt)}`)}</small>`,
    item.errors?.length ? `<small>${escapeHtml(`Errors: ${item.errors.length}`)}</small>` : "",
    `</div>`,
  ].join("");
}

function adapterOutboxCard(item) {
  const retryDisabled = item.status === "sent" ? "disabled" : "";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(`${item.adapterId || "adapter"} retry`)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<p>${escapeHtml(item.replyPreview || "No reply preview")}</p>`,
    item.error ? `<small>${escapeHtml(`Last error: ${item.error}`)}</small>` : "",
    `<small>${escapeHtml(`${item.agentId || "main"} | conversation ${item.conversationId || "unknown"} | attempts ${item.attempts || 0}/${item.maxAttempts || 3} | ${formatDate(item.updatedAt || item.createdAt)}`)}</small>`,
    `<div class="hero-actions connector-actions">`,
    `<button type="button" class="button button-ghost button-small" data-outbox-retry="${escapeHtml(item.id)}" ${retryDisabled}>Retry send</button>`,
    `</div>`,
    `</div>`,
  ].join("");
}

function adapterRecordMatchesQuery(item, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    item.id,
    item.deliveryId,
    item.adapterId,
    item.channel,
    item.eventType,
    item.externalId,
    item.conversationId,
    item.author,
    item.messagePreview,
    item.replyPreview,
    item.agentId,
    item.label,
    item.source,
    item.status,
    item.replyStatus,
    item.replyError,
    item.error,
    item.extractId,
    item.analysisId,
    item.sessionId,
    item.runId,
    item.attachmentSummary,
    item.contentPreview,
    item.mediaKind,
    item.analysisStatus,
    item.analysisProvider,
    item.analysisModel,
    item.analysisError,
    item.messagePreview,
    item.replyPreview,
    item.result?.runId,
    item.result?.sessionId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function getAdapterDeliveryFilters() {
  return {
    adapterId: adapterDeliveryAdapterFilter?.value || "",
    status: adapterDeliveryStatusFilter?.value || "",
    query: String(adapterDeliveryQueryFilter?.value || "").trim().toLowerCase(),
  };
}

function filterAdapterRecords(records = [], { includeReplyStatus = false } = {}) {
  const filters = getAdapterDeliveryFilters();
  return records.filter((item) => {
    const adapterOk = !filters.adapterId || item.adapterId === filters.adapterId;
    const statusOk =
      !filters.status ||
      item.status === filters.status ||
      item.injectionStatus === filters.status ||
      (filters.status === "injected" && (item.injectionStatus === "completed" || (item.status === "completed" && item.sessionId))) ||
      (includeReplyStatus && item.replyStatus === filters.status);
    return adapterOk && statusOk && adapterRecordMatchesQuery(item, filters.query);
  });
}

function connectorSecurityCard(config = {}) {
  const webhook = config.webhook || {};
  const fileDrop = config.fileDrop || {};
  const attachment = config.attachmentIngestion || {};
  const retention = config.attachmentRetention || {};
  const media = config.attachmentMediaAnalysis || {};
  const mediaRoutes = Object.entries(media.routes || {})
    .filter(([, route]) => route?.enabled)
    .map(([kind, route]) => `${kind}:${route.provider || media.provider || "base"}`)
    .join(", ");
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>Webhook gate</strong>`,
    statusPill(webhook.enabled === false ? "off" : webhook.requireToken ? "token required" : "open", webhook.enabled === false ? "warn" : "ok"),
    `</div>`,
    `<p>${escapeHtml(webhook.tokenConfigured ? `Token ${webhook.tokenPreview || "configured"}` : "No webhook token configured yet.")}</p>`,
    `<small>${escapeHtml(`Route ${webhook.defaultAgentId || "main"} | payload override ${webhook.allowPayloadAgent === false ? "off" : "on"} | headers ${(webhook.acceptedHeaders || []).join(", ") || "x-omniclaw-token"}`)}</small>`,
    `</div>`,
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>File-drop gate</strong>`,
    statusPill(fileDrop.enabled === false ? "off" : fileDrop.archiveProcessed ? "archive" : "keep", fileDrop.enabled === false ? "warn" : "ok"),
    `</div>`,
    `<p>${escapeHtml(fileDrop.inboxDir || "data/inbox")}</p>`,
    `<small>${escapeHtml(`Route ${fileDrop.defaultAgentId || "main"} | archive ${fileDrop.archiveDir || "data/inbox/archive"} | allowed ${(fileDrop.allowedExtensions || [".txt", ".md", ".json"]).join(", ")}`)}</small>`,
    `</div>`,
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>Attachment ingest</strong>`,
    statusPill(attachment.enabled === false ? "off" : attachment.autoInject ? "auto session" : attachment.autoExtract ? "extract" : attachment.autoCache ? "cache" : "observe", attachment.enabled === false ? "warn" : "ok"),
    `</div>`,
    `<p>${escapeHtml(`Cache ${attachment.autoCache === false ? "off" : "on"} | extract ${attachment.autoExtract === false ? "off" : "on"} | session ${attachment.autoInject ? "auto" : "manual"}`)}</p>`,
    `<small>${escapeHtml(`max ${attachment.maxAttachmentsPerDelivery || 3} file(s) | cache ${attachment.maxCacheBytes || 5000000} bytes | extract ${attachment.maxExtractChars || 12000} chars`)}</small>`,
    `</div>`,
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>Attachment retention</strong>`,
    statusPill(retention.enabled === false ? "off" : "active", retention.enabled === false ? "warn" : "ok"),
    `</div>`,
    `<p>${escapeHtml(`Keep ${retention.maxAgeDays || 14} day(s) | failed ${retention.failedMaxAgeDays || 3} day(s) | budget ${retention.maxTotalBytes || 100000000} bytes`)}</p>`,
    `<small>${escapeHtml(`orphan cleanup ${retention.deleteOrphanFiles === false ? "off" : "on"}`)}</small>`,
    `</div>`,
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>Media analysis</strong>`,
    statusPill(media.enabled ? media.provider || "enabled" : "off", media.enabled ? "ok" : "warn"),
    `</div>`,
    `<p>${escapeHtml(`auto ${media.autoAnalyze ? "on" : "off"} | model ${media.model || "default"} | key ${media.apiKeyConfigured ? media.apiKeyPreview || "configured" : "not set"}`)}</p>`,
    `<small>${escapeHtml(`${media.provider === "http-json" ? media.endpoint || "no endpoint" : media.provider === "local-command" ? `${media.command || "no command"} ${(media.args || []).join(" ")}` : "mock provider works offline for tests"} | routes ${mediaRoutes || "off"}`)}</small>`,
    `</div>`,
  ].join("");
}

function mediaSetupEngineCard(engine = {}) {
  const tone = engine.available ? "ok" : engine.status === "started-with-error" ? "warn" : "danger";
  const routeMeta = engine.routeTemplate
    ? `route ${engine.mediaKinds?.join(", ") || "media"} -> ${engine.routeTemplate.provider || "local-command"}`
    : `dependency for ${engine.mediaKinds?.join(", ") || "media"}`;
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(engine.name || engine.id)}</strong>`,
    statusPill(engine.status || "unknown", tone),
    `</div>`,
    `<p>${escapeHtml(engine.message || "No setup check result yet.")}</p>`,
    `<small>${escapeHtml(`${engine.command || "no command"} ${(engine.testArgs || []).join(" ")} | ${routeMeta}`)}</small>`,
    engine.outputPreview ? `<pre class="mini-console">${escapeHtml(truncate(engine.outputPreview, 500))}</pre>` : "",
    !engine.available && engine.setupSteps?.length
      ? `<small>${escapeHtml(engine.setupSteps.join(" "))}</small>`
      : "",
    `</div>`,
  ].join("");
}

function renderMediaSetup(setup) {
  if (!attachmentMediaSetupOutput) {
    return;
  }
  if (!setup) {
    attachmentMediaSetupOutput.innerHTML = emptyState("Local media engine setup has not been checked yet.");
    return;
  }
  const warnings = (setup.warnings || []).map((warning) => `<small>${escapeHtml(warning)}</small>`).join("");
  const nextSteps = (setup.nextSteps || []).map((step) => `<small>${escapeHtml(step)}</small>`).join("");
  const routeCount = Object.values(setup.recommendedRoutes || {}).filter((route) => route?.enabled).length;
  attachmentMediaSetupOutput.innerHTML = [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>Local media setup</strong>`,
    statusPill(`${setup.readyCount || 0} ready`, setup.readyCount > 0 ? "ok" : "warn"),
    `</div>`,
    `<p>${escapeHtml(`${setup.missingCount || 0} missing | ${routeCount} recommended route(s) | ${setup.platform || "local"}`)}</p>`,
    warnings || nextSteps ? `<div class="mini-note">${warnings}${nextSteps}</div>` : "",
    routeCount ? `<pre class="mini-console">${escapeHtml(formatJson(setup.recommendedRoutes || {}))}</pre>` : "",
    `</div>`,
    ...(setup.engines || []).map(mediaSetupEngineCard),
  ].join("");
}

function mediaInstallPlanTargetCard(target = {}) {
  const steps = (target.steps || []).map((step) => [
    `<div class="stack-item stack-item-compact">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(step.title || "Install step")}</strong>`,
    statusPill(step.risk || "review", step.risk === "low" ? "ok" : step.risk === "manual" ? "muted" : "warn"),
    `</div>`,
    `<pre class="mini-console">${escapeHtml(step.displayCommand || "")}</pre>`,
    `<small>${escapeHtml(`${step.note || ""} ${step.requiresApproval ? "Requires operator approval before running." : ""}`.trim())}</small>`,
    `</div>`,
  ].join("")).join("");
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(target.name || target.id)}</strong>`,
    statusPill(target.available ? "already available" : target.status || "missing", target.available ? "ok" : "warn"),
    `</div>`,
    `<p>${escapeHtml(`For ${target.mediaKinds?.join(", ") || "media"} | ${target.command || "manual"}`)}</p>`,
    target.blocked ? `<small>${escapeHtml(target.blockedReason || "No installer plan available.")}</small>` : steps,
    `</div>`,
  ].join("");
}

function renderMediaInstallPlan(plan) {
  if (!attachmentMediaSetupOutput || !plan) {
    return;
  }
  const warnings = (plan.warnings || []).map((warning) => `<small>${escapeHtml(warning)}</small>`).join("");
  const nextSteps = (plan.nextSteps || []).map((step) => `<small>${escapeHtml(step)}</small>`).join("");
  attachmentMediaSetupOutput.innerHTML = [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>Installer plan</strong>`,
    statusPill(`${plan.commandCount || 0} command(s)`, plan.commandCount > 0 ? "warn" : "muted"),
    `</div>`,
    `<p>${escapeHtml(`${plan.targetCount || 0} target(s) | platform ${plan.platform || "local"} | auto-run ${plan.executesAutomatically ? "on" : "off"}`)}</p>`,
    `<div class="mini-note">${warnings}${nextSteps}</div>`,
    `</div>`,
    ...(plan.targets || []).map(mediaInstallPlanTargetCard),
  ].join("");
}

function connectorAdapterCard(adapter, selected) {
  const secretMeta = adapter.requiredSecrets?.length
    ? adapter.secretConfigured
      ? `secret ${adapter.secretPreview || "configured"}`
      : `needs ${adapter.requiredSecrets.join(", ")}`
    : "no secret required";
  const pollMeta = adapter.lastPollAt
    ? ` | poll ${adapter.lastPollStatus || "unknown"} ${formatDate(adapter.lastPollAt)}`
    : "";
  const eventMeta = adapter.lastEventAt
    ? ` | event ${adapter.lastEventStatus || "unknown"} ${formatDate(adapter.lastEventAt)}`
    : "";
  return [
    `<button type="button" class="${selected ? "list-button is-selected" : "list-button"}" data-adapter-id="${escapeHtml(adapter.id)}">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(adapter.name || adapter.id)}</strong>`,
    statusPill(adapter.status || "unknown", toneForStatus(adapter.status || (adapter.enabled ? "ready" : "disabled"))),
    `</div>`,
    `<span>${escapeHtml(adapter.description || "Connector adapter.")}</span>`,
    `<small>${escapeHtml(`${adapter.transport || "custom"} | ${adapter.direction || "inbound"} | route ${adapter.defaultAgentId || "main"} | ${secretMeta}${pollMeta}${eventMeta}`)}</small>`,
    `<small>${escapeHtml(adapter.lastEventMessage || adapter.lastTestMessage || adapter.docsHint || adapter.manifestPath || "")}</small>`,
    `</button>`,
  ].join("");
}

function syncAdapterForm(adapters = []) {
  if (!adapterSelect) {
    return;
  }
  const selected = adapters.find((adapter) => adapter.id === selectedAdapterId) || adapters[0] || null;
  selectedAdapterId = selected?.id || "";
  adapterSelect.innerHTML = adapters
    .map((adapter) => `<option value="${escapeHtml(adapter.id)}">${escapeHtml(adapter.name || adapter.id)}</option>`)
    .join("");
  adapterSelect.value = selectedAdapterId;
  if (adapterEnabledInput) {
    adapterEnabledInput.checked = selected?.enabled !== false;
  }
  if (adapterAgentInput) {
    adapterAgentInput.value = selected?.defaultAgentId || "main";
  }
  if (adapterModeInput) {
    adapterModeInput.value = selected?.mode || "manual";
  }
  if (adapterSecretInput) {
    adapterSecretInput.value = "";
    adapterSecretInput.placeholder = selected?.requiredSecrets?.length
      ? `${selected.secretConfigured ? "Configured" : "Required"}: ${selected.requiredSecrets.join(", ")}`
      : "No secret required";
  }
  const telegramSelected = selectedAdapterId === "telegram";
  const discordSelected = selectedAdapterId === "discord";
  if (pollTelegramButton) {
    pollTelegramButton.disabled = !telegramSelected;
  }
  if (startTelegramButton) {
    startTelegramButton.disabled = !telegramSelected;
  }
  if (stopTelegramButton) {
    stopTelegramButton.disabled = !telegramSelected;
  }
  if (dispatchDiscordButton) {
    dispatchDiscordButton.disabled = !discordSelected;
  }
  if (startDiscordButton) {
    startDiscordButton.disabled = !discordSelected;
  }
  if (stopDiscordButton) {
    stopDiscordButton.disabled = !discordSelected;
  }
}

function renderConnectors(state) {
  renderConnectorStatusOverview(state);
  const connectors = state.connectors || {};
  const overview = connectors.overview || {};
  const config = connectors.config || {};
  const adapters = connectors.adapters || [];
  connectorsContext.textContent = [
    `${overview.fileDropPending || 0} inbox`,
    `${overview.webhookDeliveries || 0} webhooks`,
    `${overview.adapterDeliveries || 0} adapter deliveries`,
    `${overview.adapterAttachments || 0} attachments`,
    `${overview.adapterAttachmentExtracts || 0} extracts`,
    `${overview.adapterAttachmentInjections || 0} injections`,
    `${overview.adapterOutboxPending || 0} retry pending`,
    `${connectors.adaptersOverview?.ready || 0}/${connectors.adaptersOverview?.total || 0} adapters`,
    overview.webhookRequireToken ? "token gate" : "open webhook",
  ].join(" | ");
  if (connectorSecurityOutput) {
    connectorSecurityOutput.innerHTML = connectorSecurityCard(config);
  }
  if (webhookEnabledInput) {
    webhookEnabledInput.checked = config.webhook?.enabled !== false;
  }
  if (webhookRequireTokenInput) {
    webhookRequireTokenInput.checked = Boolean(config.webhook?.requireToken);
  }
  if (webhookDefaultAgentInput) {
    webhookDefaultAgentInput.value = config.webhook?.defaultAgentId || "main";
  }
  if (webhookAllowPayloadAgentInput) {
    webhookAllowPayloadAgentInput.checked = config.webhook?.allowPayloadAgent !== false;
  }
  if (fileDropEnabledInput) {
    fileDropEnabledInput.checked = config.fileDrop?.enabled !== false;
  }
  if (fileDropDefaultAgentInput) {
    fileDropDefaultAgentInput.value = config.fileDrop?.defaultAgentId || "main";
  }
  if (fileDropArchiveProcessedInput) {
    fileDropArchiveProcessedInput.checked = Boolean(config.fileDrop?.archiveProcessed);
  }
  if (attachmentIngestionEnabledInput) {
    attachmentIngestionEnabledInput.checked = config.attachmentIngestion?.enabled !== false;
  }
  if (attachmentAutoCacheInput) {
    attachmentAutoCacheInput.checked = config.attachmentIngestion?.autoCache !== false;
  }
  if (attachmentAutoExtractInput) {
    attachmentAutoExtractInput.checked = config.attachmentIngestion?.autoExtract !== false;
  }
  if (attachmentAutoInjectInput) {
    attachmentAutoInjectInput.checked = Boolean(config.attachmentIngestion?.autoInject);
  }
  if (attachmentMaxCountInput) {
    attachmentMaxCountInput.value = config.attachmentIngestion?.maxAttachmentsPerDelivery || 3;
  }
  if (attachmentMaxCacheBytesInput) {
    attachmentMaxCacheBytesInput.value = config.attachmentIngestion?.maxCacheBytes || 5_000_000;
  }
  if (attachmentRetentionEnabledInput) {
    attachmentRetentionEnabledInput.checked = config.attachmentRetention?.enabled !== false;
  }
  if (attachmentRetentionDaysInput) {
    attachmentRetentionDaysInput.value = config.attachmentRetention?.maxAgeDays || 14;
  }
  if (attachmentRetentionBytesInput) {
    attachmentRetentionBytesInput.value = config.attachmentRetention?.maxTotalBytes || 100_000_000;
  }
  if (attachmentMediaAnalysisEnabledInput) {
    attachmentMediaAnalysisEnabledInput.checked = Boolean(config.attachmentMediaAnalysis?.enabled);
  }
  if (attachmentMediaAutoAnalyzeInput) {
    attachmentMediaAutoAnalyzeInput.checked = Boolean(config.attachmentMediaAnalysis?.autoAnalyze);
  }
  if (attachmentMediaProviderInput) {
    attachmentMediaProviderInput.value = config.attachmentMediaAnalysis?.provider || "mock";
  }
  if (attachmentMediaEndpointInput) {
    attachmentMediaEndpointInput.value = config.attachmentMediaAnalysis?.endpoint || "";
  }
  if (attachmentMediaModelInput) {
    attachmentMediaModelInput.value = config.attachmentMediaAnalysis?.model || "";
  }
  if (attachmentMediaCommandInput) {
    attachmentMediaCommandInput.value = config.attachmentMediaAnalysis?.command || "";
  }
  if (attachmentMediaArgsInput) {
    attachmentMediaArgsInput.value = (config.attachmentMediaAnalysis?.args || []).join("\n");
  }
  if (attachmentMediaRoutesInput && document.activeElement !== attachmentMediaRoutesInput) {
    attachmentMediaRoutesInput.value = formatJson(config.attachmentMediaAnalysis?.routes || {});
  }
  if (latestMediaInstallPlan) {
    renderMediaInstallPlan(latestMediaInstallPlan);
  } else {
    renderMediaSetup(latestMediaSetup);
  }
  syncAdapterForm(adapters);
  if (connectorAdapterOutput) {
    const worker = connectors.telegramWorker || {};
    const discordWorker = connectors.discordWorker || {};
    const workerCard = [
      `<div class="stack-item">`,
      `<div class="row-top">`,
      `<strong>Telegram worker</strong>`,
      statusPill(worker.running ? "running" : "stopped", worker.running ? "ok" : "muted"),
      `</div>`,
      `<p>${escapeHtml(worker.lastError || worker.adapter?.lastPollMessage || "Polling worker waits for a configured Telegram adapter.")}</p>`,
      `<small>${escapeHtml(`interval ${worker.intervalMs || 5000}ms | polling ${worker.polling ? "yes" : "no"} | last update ${worker.adapter?.lastUpdateId || 0}`)}</small>`,
      `</div>`,
      `<div class="stack-item">`,
      `<div class="row-top">`,
      `<strong>Discord worker</strong>`,
      statusPill(discordWorker.connected ? "connected" : discordWorker.reconnecting ? "reconnecting" : discordWorker.running ? "running" : "stopped", discordWorker.connected || discordWorker.running ? "ok" : "muted"),
      `</div>`,
      `<p>${escapeHtml(discordWorker.lastError || discordWorker.adapter?.lastEventMessage || "Gateway worker waits for a configured Discord adapter.")}</p>`,
      `<small>${escapeHtml(`connecting ${discordWorker.connecting ? "yes" : "no"} | reconnect ${discordWorker.reconnectAttempts || 0} | resume ${discordWorker.resumeReady ? "ready" : "cold"} | seq ${discordWorker.lastSequence || 0} | events ${discordWorker.adapter?.totalEvents || 0}`)}</small>`,
      `</div>`,
    ].join("");
    const adapterCards =
      adapters.map((adapter) => connectorAdapterCard(adapter, adapter.id === selectedAdapterId)).join("") ||
      emptyState("No adapter manifests found.");
    connectorAdapterOutput.innerHTML =
      workerCard +
      adapterCards;
  }
  if (adapterDeliveryOutput) {
    const filteredDeliveries = filterAdapterRecords(connectors.adapterDeliveries || [], { includeReplyStatus: true });
    if (adapterDeliverySummary) {
      const totalDeliveries = connectors.adapterDeliveries?.length || 0;
      const pendingOutbox = connectors.adapterOutbox?.filter((item) => !["sent", "abandoned"].includes(item.status)).length || 0;
      const cachedFiles = connectors.adapterAttachmentCache?.filter((item) => item.status === "cached").length || 0;
      const extractedFiles = connectors.adapterAttachmentExtracts?.filter((item) => ["completed", "unsupported", "media-metadata"].includes(item.status)).length || 0;
      const injectedFiles = connectors.adapterAttachmentInjections?.filter((item) => item.status === "completed").length || 0;
      const purgedFiles = connectors.adapterAttachmentCache?.filter((item) => item.status === "purged").length || 0;
      const mediaHooks = connectors.adapterAttachmentExtracts?.filter((item) => item.status === "media-metadata").length || 0;
      const analyzedFiles = connectors.adapterAttachmentAnalyses?.filter((item) => item.status === "completed").length || 0;
      adapterDeliverySummary.textContent = `${filteredDeliveries.length}/${totalDeliveries} shown | ${cachedFiles} cached | ${extractedFiles} extracted | ${mediaHooks} media hooks | ${analyzedFiles} analyzed | ${injectedFiles} injected | ${purgedFiles} purged | ${pendingOutbox} retry pending`;
    }
    adapterDeliveryOutput.innerHTML =
      filteredDeliveries.map(adapterDeliveryCard).join("") ||
      emptyState("No Telegram or Discord adapter deliveries yet.");
  }
  if (adapterAttachmentCacheOutput) {
    const filteredCache = filterAdapterRecords(connectors.adapterAttachmentCache || []);
    adapterAttachmentCacheOutput.innerHTML =
      filteredCache.map(attachmentCacheCard).join("") ||
      emptyState("No cached adapter attachments yet.");
  }
  if (adapterAttachmentExtractOutput) {
    const filteredExtracts = filterAdapterRecords(connectors.adapterAttachmentExtracts || []);
    adapterAttachmentExtractOutput.innerHTML =
      filteredExtracts.map(attachmentExtractCard).join("") ||
      emptyState("No extracted adapter attachment content yet.");
  }
  if (adapterAttachmentAnalysisOutput) {
    const filteredAnalyses = filterAdapterRecords(connectors.adapterAttachmentAnalyses || []);
    adapterAttachmentAnalysisOutput.innerHTML =
      filteredAnalyses.map(attachmentAnalysisCard).join("") ||
      emptyState("No media analyses yet.");
  }
  if (adapterAttachmentInjectionOutput) {
    const filteredInjections = filterAdapterRecords(connectors.adapterAttachmentInjections || []);
    adapterAttachmentInjectionOutput.innerHTML =
      filteredInjections.map(attachmentInjectionCard).join("") ||
      emptyState("No attachment content has been sent into a session yet.");
  }
  if (attachmentCleanupOutput) {
    attachmentCleanupOutput.innerHTML =
      (connectors.attachmentCleanupRuns || []).map(attachmentCleanupCard).join("") ||
      emptyState("No attachment cleanup runs yet.");
  }
  if (adapterOutboxOutput) {
    const filteredOutbox = filterAdapterRecords(connectors.adapterOutbox || []);
    adapterOutboxOutput.innerHTML =
      filteredOutbox.map(adapterOutboxCard).join("") ||
      emptyState("No retryable adapter replies yet.");
  }
  webhookOutput.innerHTML =
    (connectors.webhookDeliveries || []).map(connectorDeliveryCard).join("") ||
    emptyState("No webhook deliveries yet.");
  fileDropOutput.innerHTML =
    (connectors.fileDropRecords || []).map(connectorDeliveryCard).join("") ||
    emptyState("No processed file drops yet.");
  fileDropPendingOutput.innerHTML =
    (connectors.pendingFiles || []).map(pendingFileCard).join("") ||
    emptyState(`No pending files. Drop .txt, .md, or .json into ${overview.inboxDir || "data/inbox"}.`);
}

function applyMediaPreset(preset) {
  const value = String(preset || "");
  if (!value) {
    return;
  }
  if (attachmentMediaAnalysisEnabledInput) {
    attachmentMediaAnalysisEnabledInput.checked = true;
  }
  if (value === "mock") {
    if (attachmentMediaProviderInput) attachmentMediaProviderInput.value = "mock";
    if (attachmentMediaModelInput) attachmentMediaModelInput.value = "local-mock";
    if (attachmentMediaEndpointInput) attachmentMediaEndpointInput.value = "";
    if (attachmentMediaCommandInput) attachmentMediaCommandInput.value = "";
    if (attachmentMediaArgsInput) attachmentMediaArgsInput.value = "";
    return;
  }
  if (value === "http-json") {
    if (attachmentMediaProviderInput) attachmentMediaProviderInput.value = "http-json";
    if (attachmentMediaModelInput) attachmentMediaModelInput.value = "";
    if (attachmentMediaCommandInput) attachmentMediaCommandInput.value = "";
    if (attachmentMediaArgsInput) attachmentMediaArgsInput.value = "";
    return;
  }
  if (value === "local-tesseract") {
    if (attachmentMediaProviderInput) attachmentMediaProviderInput.value = "local-command";
    if (attachmentMediaModelInput) attachmentMediaModelInput.value = "tesseract";
    if (attachmentMediaEndpointInput) attachmentMediaEndpointInput.value = "";
    if (attachmentMediaCommandInput) attachmentMediaCommandInput.value = "tesseract";
    if (attachmentMediaArgsInput) attachmentMediaArgsInput.value = ["{file}", "stdout", "-l", "eng"].join("\n");
    return;
  }
  if (value === "local-whisper") {
    if (attachmentMediaProviderInput) attachmentMediaProviderInput.value = "local-command";
    if (attachmentMediaModelInput) attachmentMediaModelInput.value = "whisper";
    if (attachmentMediaEndpointInput) attachmentMediaEndpointInput.value = "";
    if (attachmentMediaCommandInput) attachmentMediaCommandInput.value = "whisper";
    if (attachmentMediaArgsInput) attachmentMediaArgsInput.value = ["{file}", "--model", "base", "--task", "transcribe", "--fp16", "False"].join("\n");
    return;
  }
  if (value === "local-command") {
    if (attachmentMediaProviderInput) attachmentMediaProviderInput.value = "local-command";
    if (attachmentMediaEndpointInput) attachmentMediaEndpointInput.value = "";
    if (attachmentMediaArgsInput && !attachmentMediaArgsInput.value.trim()) {
      attachmentMediaArgsInput.value = "{file}";
    }
  }
}

function matchesSelectedAgent(agentId) {
  return normalizeAgentId(agentId) === normalizeAgentId(selectedAgentId || "main");
}

function jobCard(item, selected) {
  const result = item.result?.output || item.error || item.payload?.tool || "No result";
  const scheduleMeta = item.payload?.scheduleId ? ` | schedule ${item.payload.scheduleId}` : "";
  return [
    `<button type="button" class="${selected ? "list-button is-selected" : "list-button"}" data-job-id="${escapeHtml(item.id)}">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(item.id)}</strong>`,
    statusPill(item.status || "unknown", toneForStatus(item.status)),
    `</div>`,
    `<span>${escapeHtml(truncate(result, 130))}</span>`,
    `<small>${escapeHtml(`${item.payload?.agentId || item.result?.agentId || "main"} | ${item.type} | ${item.source || "unknown"}${scheduleMeta}`)}</small>`,
    `</button>`,
  ].join("");
}

function renderJobDetail(job) {
  if (!job) {
    return emptyState("Select a job to inspect its payload, retries, and result.");
  }

  return [
    `<div class="metric-strip">`,
    metricTile("Status", job.status || "unknown", job.source || "unknown source"),
    metricTile("Attempts", job.attempts || 0, `${job.retry?.maxAttempts || 1} max`),
    metricTile("Agent", job.payload?.agentId || "main", job.payload?.tool || "tool"),
    metricTile("Schedule", job.payload?.scheduleId || "none", job.scheduledFor ? `Due ${formatDate(job.scheduledFor)}` : "Immediate"),
    `</div>`,
    `<pre class="console-output console-output-compact">${escapeHtml(formatJson({
      id: job.id,
      payload: job.payload,
      retry: job.retry,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    }))}</pre>`,
  ].join("");
}

function scheduleCard(schedule) {
  const nextRun = schedule.nextRunAt ? `Next ${formatDate(schedule.nextRunAt)}` : "No next run";
  const maxRuns = schedule.maxRuns ? `${schedule.runCount || 0}/${schedule.maxRuns}` : `${schedule.runCount || 0}/unlimited`;
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(schedule.name || schedule.id)}</strong>`,
    statusPill(schedule.status || "unknown", toneForStatus(schedule.status)),
    `</div>`,
    `<p>${escapeHtml(`${schedule.tool} | ${schedule.agentId || "main"} | every ${Math.round((schedule.intervalMs || 0) / 1000)}s`)}</p>`,
    `<small>${escapeHtml(`${nextRun} | runs ${maxRuns} | last job ${schedule.lastJobId || "none"}`)}</small>`,
    `<div class="hero-actions">`,
    `<button type="button" class="button button-ghost button-small" data-schedule-run="${escapeHtml(schedule.id)}">Run</button>`,
    `<button type="button" class="button button-ghost button-small" data-schedule-toggle="${escapeHtml(schedule.id)}" data-schedule-status="${escapeHtml(schedule.status === "active" ? "paused" : "active")}">${schedule.status === "active" ? "Pause" : "Resume"}</button>`,
    `<button type="button" class="button button-ghost button-small" data-schedule-delete="${escapeHtml(schedule.id)}">Delete</button>`,
    `</div>`,
    `</div>`,
  ].join("");
}

function pairingRequestCard(request) {
  const pending = request.status === "pending";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(request.label || request.id)}</strong>`,
    statusPill(request.status || "pending", toneForStatus(request.status || "pending")),
    `</div>`,
    `<p>${escapeHtml(`${request.role || "operator"} | ${request.fingerprint || "no fingerprint"}`)}</p>`,
    `<small>${escapeHtml(`requested ${formatDate(request.requestedAt)} | ${request.remoteAddress || "local"} | ${request.id}`)}</small>`,
    pending
      ? [
          `<div class="hero-actions">`,
          `<button type="button" class="button button-ghost button-small" data-pairing-approve="${escapeHtml(request.id)}">Approve</button>`,
          `<button type="button" class="button button-ghost button-small" data-pairing-reject="${escapeHtml(request.id)}">Reject</button>`,
          `</div>`,
        ].join("")
      : "",
    `</div>`,
  ].join("");
}

function trustedDeviceCard(device) {
  const trusted = device.status === "trusted";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(device.label || device.id)}</strong>`,
    statusPill(device.status || "unknown", toneForStatus(device.status)),
    `</div>`,
    `<p>${escapeHtml(`${device.role || "operator"} | token ${device.tokenPreview || "hidden"}`)}</p>`,
    `<small>${escapeHtml(`${device.id} | last seen ${device.lastSeenAt ? formatDate(device.lastSeenAt) : "never"} | ${device.fingerprint || "no fingerprint"}`)}</small>`,
    trusted
      ? [
          `<div class="hero-actions">`,
          `<button type="button" class="button button-ghost button-small" data-device-rotate="${escapeHtml(device.id)}">Rotate token</button>`,
          `<button type="button" class="button button-ghost button-small" data-device-revoke="${escapeHtml(device.id)}">Revoke</button>`,
          `</div>`,
        ].join("")
      : "",
    `</div>`,
  ].join("");
}

function trustAuditCard(record) {
  const metaParts = [
    record.actor ? `actor ${record.actor}` : "",
    record.targetType ? `${record.targetType} ${record.targetId || ""}`.trim() : "",
    record.createdAt ? formatDate(record.createdAt) : "",
  ].filter(Boolean);
  const metadata = record.metadata && Object.keys(record.metadata).length ? formatJson(record.metadata) : "";
  return [
    `<div class="stack-item trust-audit-card">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(record.summary || record.action || "Trust event")}</strong>`,
    statusPill(record.status || "info", toneForStatus(record.status || record.action)),
    `</div>`,
    `<p>${escapeHtml(record.action || "trust.event")}</p>`,
    `<small>${escapeHtml(metaParts.join(" | "))}</small>`,
    record.note ? `<small>${escapeHtml(`note: ${record.note}`)}</small>` : "",
    metadata ? `<pre class="mini-console trust-audit-meta">${escapeHtml(metadata)}</pre>` : "",
    `</div>`,
  ].join("");
}

function renderTrust(state) {
  const trust = state.trust || {};
  const overview = trust.overview || {};
  const gateway = overview.gateway || {};
  const requests = trust.pairingRequests || [];
  const devices = trust.devices || [];
  const audit = trust.audit || [];

  trustContext.textContent = `${overview.pendingPairings || 0} pending | ${overview.trustedDevices || 0} trusted | ${audit.length || 0} audit`;
  trustOutput.innerHTML =
    requests.slice(0, 8).map(pairingRequestCard).join("") || emptyState("No pairing requests yet.");
  deviceOutput.innerHTML =
    devices.slice(0, 8).map(trustedDeviceCard).join("") ||
    emptyState(`No trusted devices yet. Gateway token: ${gateway.masked || "rotate to create one"}.`);
  trustAuditOutput.innerHTML =
    audit.slice(0, 12).map(trustAuditCard).join("") || emptyState("No trust audit records yet.");

  for (const button of trustOutput.querySelectorAll("[data-pairing-approve]")) {
    button.addEventListener("click", async () => {
      await approvePairing(button.dataset.pairingApprove || "");
    });
  }

  for (const button of trustOutput.querySelectorAll("[data-pairing-reject]")) {
    button.addEventListener("click", async () => {
      await rejectPairing(button.dataset.pairingReject || "");
    });
  }

  for (const button of deviceOutput.querySelectorAll("[data-device-rotate]")) {
    button.addEventListener("click", async () => {
      await rotateDeviceToken(button.dataset.deviceRotate || "");
    });
  }

  for (const button of deviceOutput.querySelectorAll("[data-device-revoke]")) {
    button.addEventListener("click", async () => {
      await revokeDevice(button.dataset.deviceRevoke || "");
    });
  }
}

function renderWorkspace(state) {
  const bootstrapFiles = state.workspace?.bootstrapFiles || [];
  const agentWorkspaces = state.workspace?.agents || [];
  const sharedHtml = bootstrapFiles
    .map((item) => {
      const tone = item.exists ? "ok" : "danger";
      return [
        `<div class="stack-item">`,
        `<div class="row-top">`,
        `<strong>${escapeHtml(item.name)}</strong>`,
        statusPill(item.exists ? "present" : "missing", tone),
        `</div>`,
        `<p>${escapeHtml(item.path)}</p>`,
        `<small>${escapeHtml(item.exists ? `${item.bytes || 0} bytes` : "Not found")}</small>`,
        `</div>`,
      ].join("");
    })
    .join("");
  const agentHtml = agentWorkspaces
    .map((agent) =>
      [
        `<div class="stack-item">`,
        `<div class="row-top">`,
        `<strong>${escapeHtml(agent.id)}</strong>`,
        statusPill(`${agent.files?.length || 0} files`, "ok"),
        `</div>`,
        `<p>${escapeHtml(agent.path || "No workspace path")}</p>`,
        `<small>${escapeHtml((agent.files || []).map((item) => item.name).join(", ") || "No bootstrap files")}</small>`,
        `</div>`,
      ].join(""),
    )
    .join("");

  workspaceOutput.innerHTML = [
    sharedHtml || emptyState("No shared workspace bootstrap files found."),
    agentHtml || emptyState("No agent workspaces found."),
  ].join("");
}

function renderPlugins(state) {
  const items = state.plugins || [];
  if (!items.some((item) => item.id === selectedPluginId)) {
    selectedPluginId = items[0]?.id || "";
  }

  pluginOutput.innerHTML = items.map((item) => pluginCard(item, item.id === selectedPluginId)).join("") || emptyState("No plugins loaded.");
  pluginDetailOutput.innerHTML = renderPluginDetail(latestPluginDetail || selectedPluginSummary());

  for (const button of pluginOutput.querySelectorAll("[data-plugin-select]")) {
    button.addEventListener("click", async () => {
      selectedPluginId = button.dataset.pluginSelect || "";
      await loadState();
    });
  }

  for (const button of pluginOutput.querySelectorAll("[data-plugin-toggle]")) {
    button.addEventListener("click", async () => {
      const pluginId = button.dataset.pluginToggle || "";
      const enabled = button.dataset.pluginEnabled !== "true";
      await togglePlugin(pluginId, enabled);
    });
  }
}

function renderJobs(state) {
  const items = (state.jobs || []).filter((item) => matchesSelectedAgent(item.payload?.agentId || item.result?.agentId));
  if (!items.some((item) => item.id === selectedJobId)) {
    selectedJobId = items[0]?.id || "";
  }

  jobOutput.innerHTML =
    items
      .slice(0, 8)
      .map((item) => jobCard(item, item.id === selectedJobId))
      .join("") || emptyState("No jobs tracked yet.");

  jobDetailOutput.innerHTML = renderJobDetail(selectedJobSummary());

  for (const button of jobOutput.querySelectorAll("[data-job-id]")) {
    button.addEventListener("click", async () => {
      selectedJobId = button.dataset.jobId || "";
      await loadState();
    });
  }
}

function renderSchedules(state) {
  const schedules = (state.schedules || []).filter((item) => matchesSelectedAgent(item.agentId));
  const tools = selectedAgentSummary()?.tools || state.tools || [];
  scheduleToolSelect.innerHTML =
    tools
      .map((tool) => `<option value="${escapeHtml(tool.id)}">${escapeHtml(tool.id)}</option>`)
      .join("") || `<option value="runtime_summary">runtime_summary</option>`;
  schedulerContext.textContent = `${schedules.length} schedule(s) | next ${state.scheduler?.nextRunAt ? formatDate(state.scheduler.nextRunAt) : "none"}`;
  scheduleOutput.innerHTML =
    schedules.map(scheduleCard).join("") || emptyState("No schedules for the selected agent.");

  for (const button of scheduleOutput.querySelectorAll("[data-schedule-run]")) {
    button.addEventListener("click", async () => {
      await runSchedule(button.dataset.scheduleRun || "");
    });
  }

  for (const button of scheduleOutput.querySelectorAll("[data-schedule-toggle]")) {
    button.addEventListener("click", async () => {
      await toggleSchedule(button.dataset.scheduleToggle || "", button.dataset.scheduleStatus || "paused");
    });
  }

  for (const button of scheduleOutput.querySelectorAll("[data-schedule-delete]")) {
    button.addEventListener("click", async () => {
      await deleteSchedule(button.dataset.scheduleDelete || "");
    });
  }
}

function memoryCandidateCard(candidate) {
  const tone = candidate.score >= 0.75 ? "ok" : candidate.score >= 0.6 ? "warn" : "muted";
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(candidate.title || candidate.id)}</strong>`,
    statusPill(`${Math.round((candidate.score || 0) * 100)}%`, tone),
    `</div>`,
    `<p>${escapeHtml(truncate(candidate.text || "", 180))}</p>`,
    `<small>${escapeHtml(`${candidate.sourceType || "source"} | ${candidate.reason || "candidate"} | ${candidate.agentId || "main"}`)}</small>`,
    `<div class="hero-actions">`,
    `<button type="button" class="button button-ghost button-small" data-memory-promote="${escapeHtml(candidate.id)}">Promote</button>`,
    `</div>`,
    `</div>`,
  ].join("");
}

function longMemoryCard(memory) {
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(memory.title || memory.id)}</strong>`,
    statusPill(memory.importance || "medium", toneForStatus(memory.importance)),
    `</div>`,
    `<p>${escapeHtml(truncate(memory.text || "", 220))}</p>`,
    `<small>${escapeHtml(`${memory.agentId || "main"} | ${memory.sourceRef || "manual"} | ${formatDate(memory.promotedAt || memory.createdAt)}`)}</small>`,
    `</div>`,
  ].join("");
}

function dreamCard(dream) {
  return [
    `<div class="stack-item">`,
    `<div class="row-top">`,
    `<strong>${escapeHtml(dream.id || "dream")}</strong>`,
    statusPill(`${dream.promotedCount || 0} promoted`, dream.promotedCount ? "ok" : "muted"),
    `</div>`,
    `<p>${escapeHtml(dream.summary || "No summary")}</p>`,
    `<small>${escapeHtml(`${dream.agentId || "main"} | ${dream.source || "manual"} | ${formatDate(dream.createdAt)}`)}</small>`,
    `</div>`,
  ].join("");
}

function renderMemoryReview(state) {
  const memory = state.memory || {};
  const overview = memory.overview || {};
  const candidates = (memory.promotionCandidates || []).filter((item) => matchesSelectedAgent(item.agentId));
  const longTerm = (memory.longTerm || []).filter((item) => matchesSelectedAgent(item.agentId));
  const dreams = (memory.dreams || []).filter((item) => matchesSelectedAgent(item.agentId));

  memoryContext.textContent = `${overview.longTerm || longTerm.length} memories | ${overview.candidates || candidates.length} candidates`;
  memoryCandidateOutput.innerHTML =
    candidates.slice(0, 8).map(memoryCandidateCard).join("") ||
    emptyState("No promotion candidates for the selected agent.");
  longMemoryOutput.innerHTML =
    longTerm.slice(0, 10).map(longMemoryCard).join("") || emptyState("No long-term memory promoted yet.");
  dreamOutput.innerHTML = dreams.slice(0, 8).map(dreamCard).join("") || emptyState("No dream sweeps yet.");

  for (const button of memoryCandidateOutput.querySelectorAll("[data-memory-promote]")) {
    button.addEventListener("click", async () => {
      const candidateId = button.dataset.memoryPromote || "";
      const candidate = candidates.find((item) => item.id === candidateId);
      if (candidate) {
        await promoteCandidate(candidate);
      }
    });
  }
}

function renderResearch(state) {
  const items = (state.memory?.research || []).filter((item) => matchesSelectedAgent(item.agentId));
  researchOutput.innerHTML =
    items
      .slice()
      .reverse()
      .slice(0, 6)
      .map((item) => {
        const firstResult = item.results?.[0];
        const link = firstResult?.url
          ? `<a href="${escapeHtml(firstResult.url)}" target="_blank" rel="noreferrer">${escapeHtml(firstResult.title || item.query)}</a>`
          : escapeHtml(item.query);

        return [
          `<div class="stack-item">`,
          `<div class="row-top">`,
          `<strong>${link}</strong>`,
          statusPill(item.provider || "provider", "muted"),
          `</div>`,
          `<small>${escapeHtml(`${normalizeAgentId(item.agentId)} | ${item.query} | ${formatDate(item.createdAt)}`)}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No research memory saved yet.");
}

function renderArtifacts(state) {
  const items = (state.memory?.artifacts || []).filter((item) => matchesSelectedAgent(item.agentId));
  artifactOutput.innerHTML =
    items
      .slice()
      .reverse()
      .slice(0, 6)
      .map((item) => {
        const detail =
          item.bytesWritten != null
            ? `${item.bytesWritten} byte(s)${item.appended ? " appended" : " written"}`
            : item.updated
              ? "Configuration updated"
              : item.skillId || item.kind || "Tracked";
        return [
          `<div class="stack-item">`,
          `<strong>${escapeHtml(item.path)}</strong>`,
          `<p>${escapeHtml(detail)}</p>`,
          `<small>${escapeHtml(`${normalizeAgentId(item.agentId)} | ${formatDate(item.createdAt)}`)}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No generated artifacts recorded yet.");
}

function renderSkills(state) {
  const items = selectedAgentSummary()?.skills || [];
  skillLibraryOutput.innerHTML =
    items
      .map((item) => {
        const triggers = Array.isArray(item.triggers) && item.triggers.length ? item.triggers.join(", ") : "No triggers";
        return [
          `<div class="stack-item">`,
          `<strong>${escapeHtml(item.name || item.id)}</strong>`,
          `<p>${escapeHtml(item.description || "No description")}</p>`,
          `<small>${escapeHtml(`${triggers} | ${normalizeAgentId((item.agents || [selectedAgentId])[0])}`)}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No skills installed.");
}

function renderTools(state) {
  const items = selectedAgentSummary()?.tools || [];
  const permissions = state.config?.tools?.permissions || {};
  toolOutput.innerHTML =
    items
      .map((item) => {
        const permission = item.permission || "no permission gate";
        const enabled = item.permission ? Boolean(permissions[item.permission]) : true;
        const tone = !item.permission ? "ok" : enabled ? "ok" : "danger";
        const label = !item.permission ? "open" : enabled ? "enabled" : "blocked";
        const computerHint = item.id.includes("computer") ? " | computer hand" : "";
        return [
          `<div class="stack-item">`,
          `<div class="row-top">`,
          `<strong>${escapeHtml(item.id)}</strong>`,
          statusPill(label, tone),
          `</div>`,
          `<p>${escapeHtml(item.description || "No description")}</p>`,
          `<small>${escapeHtml(`${permission}${computerHint}${item.pluginId ? ` | ${item.pluginId}` : ""}`)}</small>`,
          `</div>`,
        ].join("");
      })
      .join("") || emptyState("No tools available.");
}

function renderCompactState(state, gateway, sessionDetail) {
  stateOutput.textContent = formatJson({
    app: state.app,
    runtime: state.runtime,
    provider: state.provider,
    gateway: gateway?.overview || state.gateway,
    selectedAgent: selectedAgentSummary()
      ? {
          id: selectedAgentSummary().id,
          name: selectedAgentSummary().name,
          profile: selectedAgentSummary().profile?.id || selectedAgentSummary().profileId,
          sessionCount: selectedAgentSummary().stats?.sessionCount || 0,
          toolCount: selectedAgentSummary().stats?.toolCount || 0,
        }
      : null,
    selectedSession: sessionDetail
      ? {
          id: sessionDetail.id,
          label: sessionDetail.label,
          status: sessionDetail.status,
          lifecycleState: sessionDetail.lifecycleState,
          queueDepth: sessionDetail.queueDepth,
          runCount: sessionDetail.runCount,
          messageCount: sessionDetail.messageCount,
        }
      : null,
    approvals: state.approvals,
    memory: state.memory?.overview,
    plugins: state.plugins,
    trust: state.trust,
    contextPolicy: state.contextPolicy,
    shellExecution: state.shellExecution,
    connectors: state.connectors?.overview,
    scheduler: state.scheduler,
    schedules: state.schedules?.slice(0, 4),
    jobs: state.jobs?.slice(0, 4),
  });
}

async function fetchSessionDetail(sessionId) {
  if (!sessionId) {
    return null;
  }

  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?messageLimit=80`);
  const data = await response.json();
  return data.session || null;
}

async function fetchPluginDetail(pluginId) {
  if (!pluginId) {
    return null;
  }

  const response = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}`);
  const data = await response.json();
  return data.plugin || null;
}

async function fetchShellAudit(filters = {}) {
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (filters.status) {
    params.set("status", filters.status);
  }
  if (filters.risk) {
    params.set("risk", filters.risk);
  }
  if (filters.query) {
    params.set("query", filters.query);
  }
  const response = await fetch(`/api/shell/audit?${params.toString()}`);
  return response.json();
}

function splitPatternLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readAttachmentMediaRoutes() {
  const text = String(attachmentMediaRoutesInput?.value || "").trim();
  if (!text) {
    return {};
  }
  try {
    const routes = JSON.parse(text);
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
      throw new Error("Media routes must be a JSON object.");
    }
    return routes;
  } catch (error) {
    throw new Error(`Invalid media routes JSON: ${error.message}`);
  }
}

function readAttachmentMediaPolicy({ forceEnabled = false } = {}) {
  return {
    enabled: forceEnabled || Boolean(attachmentMediaAnalysisEnabledInput?.checked),
    autoAnalyze: Boolean(attachmentMediaAutoAnalyzeInput?.checked),
    provider: attachmentMediaProviderInput?.value || "mock",
    endpoint: attachmentMediaEndpointInput?.value.trim() || "",
    model: attachmentMediaModelInput?.value.trim() || "",
    command: attachmentMediaCommandInput?.value.trim() || "",
    args: splitPatternLines(attachmentMediaArgsInput?.value || ""),
    apiKey: attachmentMediaApiKeyInput?.value.trim() || "",
    routes: readAttachmentMediaRoutes(),
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function loadDesignBridge({ force = false } = {}) {
  if (!designBridgeText || (!force && designBridgeLoaded)) {
    return;
  }
  const response = await fetch("/api/design/stitch");
  const data = await response.json();
  if (data.error) {
    designBridgeOutput.textContent = formatJson(data);
    return;
  }
  designBridgeText.value = data.designMd || "";
  designBridgeLoaded = true;
  if (designBridgeOutput) {
    designBridgeOutput.textContent = formatJson({
      designPath: data.designPath,
      updatedAt: data.updatedAt,
      stitchUrl: data.stitchUrl,
      prompt: data.prompt,
    });
  }
}

async function saveDesignBridge() {
  if (!designBridgeText || !designBridgeOutput) {
    return;
  }
  designBridgeOutput.textContent = "Saving DESIGN.md...";
  const data = await postJson("/api/design/stitch", {
    designMd: designBridgeText.value,
  });
  designBridgeOutput.textContent = formatJson(data);
  if (!data.error) {
    designBridgeLoaded = false;
    await loadDesignBridge({ force: true });
    await loadState();
  }
}

async function copyDesignBridge() {
  if (!designBridgeText || !designBridgeOutput) {
    return;
  }
  const text = designBridgeText.value;
  try {
    await navigator.clipboard.writeText(text);
    designBridgeOutput.textContent = "DESIGN.md copied for Stitch.";
  } catch (error) {
    designBridgeText.focus();
    designBridgeText.select();
    designBridgeOutput.textContent = `Clipboard unavailable. DESIGN.md is selected; press Ctrl+C. ${error.message}`;
  }
}

async function rotateGatewayToken() {
  trustFeedback.textContent = "Rotating gateway token...";
  const data = await postJson("/api/trust/gateway/rotate", {});
  latestGatewayToken = data.token || "";
  if (copyGatewayTokenButton) {
    copyGatewayTokenButton.disabled = !latestGatewayToken;
  }
  trustFeedback.textContent = data.token
    ? `GATEWAY TOKEN - shown once; copy into remote nodes\n${data.token}\n\n${formatJson(data.status)}`
    : formatJson(data);
  await loadState();
}

async function copyGatewayToken() {
  if (!latestGatewayToken) {
    trustFeedback.textContent = "Rotate the gateway token first; full tokens are only shown once.";
    return;
  }

  try {
    await navigator.clipboard.writeText(latestGatewayToken);
    trustFeedback.textContent = `Gateway token copied.\n\n${formatJson(latestState?.trust?.overview?.gateway || {})}`;
  } catch (error) {
    trustFeedback.focus();
    trustFeedback.textContent = `Clipboard unavailable. Select and copy this token manually:\n${latestGatewayToken}\n\n${error.message}`;
  }
}

async function approvePairing(requestId) {
  if (!requestId) {
    return;
  }
  trustFeedback.textContent = "Approving pairing request...";
  const data = await postJson("/api/trust/pairing/approve", {
    requestId,
    note: "dashboard-approval",
  });
  trustFeedback.textContent = data.token
    ? `DEVICE TOKEN - shown once\n${data.token}\n\n${formatJson({ device: data.device, request: data.request })}`
    : formatJson(data);
  await loadState();
}

async function rejectPairing(requestId) {
  if (!requestId) {
    return;
  }
  trustFeedback.textContent = "Rejecting pairing request...";
  const data = await postJson("/api/trust/pairing/reject", {
    requestId,
    note: "dashboard-rejection",
  });
  trustFeedback.textContent = formatJson(data);
  await loadState();
}

async function rotateDeviceToken(deviceId) {
  if (!deviceId) {
    return;
  }
  trustFeedback.textContent = "Rotating device token...";
  const data = await postJson("/api/trust/devices/rotate-token", {
    deviceId,
    note: "dashboard-token-rotation",
  });
  trustFeedback.textContent = data.token
    ? `DEVICE TOKEN - shown once\n${data.token}\n\n${formatJson(data.device)}`
    : formatJson(data);
  await loadState();
}

async function revokeDevice(deviceId) {
  if (!deviceId) {
    return;
  }
  trustFeedback.textContent = "Revoking device...";
  const data = await postJson("/api/trust/devices/revoke", {
    deviceId,
    note: "dashboard-revoke",
  });
  trustFeedback.textContent = formatJson(data);
  await loadState();
}

async function scanFileDrop() {
  connectorsFeedback.textContent = "Scanning file-drop inbox...";
  const data = await postJson("/api/connectors/file-drop/scan", {
    agentId: document.querySelector("#file-drop-agent").value.trim(),
    limit: 10,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function saveConnectorConfig() {
  connectorsFeedback.textContent = "Saving connector policy...";
  let attachmentMediaAnalysis;
  try {
    attachmentMediaAnalysis = readAttachmentMediaPolicy();
  } catch (error) {
    connectorsFeedback.textContent = error.message;
    return;
  }
  const data = await postJson("/api/connectors/config", {
    webhook: {
      enabled: Boolean(webhookEnabledInput?.checked),
      defaultAgentId: webhookDefaultAgentInput?.value.trim() || "main",
      allowPayloadAgent: Boolean(webhookAllowPayloadAgentInput?.checked),
      requireToken: Boolean(webhookRequireTokenInput?.checked),
    },
    fileDrop: {
      enabled: Boolean(fileDropEnabledInput?.checked),
      defaultAgentId: fileDropDefaultAgentInput?.value.trim() || "main",
      archiveProcessed: Boolean(fileDropArchiveProcessedInput?.checked),
    },
    attachmentIngestion: {
      enabled: Boolean(attachmentIngestionEnabledInput?.checked),
      autoCache: Boolean(attachmentAutoCacheInput?.checked),
      autoExtract: Boolean(attachmentAutoExtractInput?.checked),
      autoInject: Boolean(attachmentAutoInjectInput?.checked),
      maxAttachmentsPerDelivery: Number(attachmentMaxCountInput?.value || 3),
      maxCacheBytes: Number(attachmentMaxCacheBytesInput?.value || 5_000_000),
    },
    attachmentRetention: {
      enabled: Boolean(attachmentRetentionEnabledInput?.checked),
      maxAgeDays: Number(attachmentRetentionDaysInput?.value || 14),
      failedMaxAgeDays: 3,
      maxTotalBytes: Number(attachmentRetentionBytesInput?.value || 100_000_000),
      deleteOrphanFiles: true,
    },
    attachmentMediaAnalysis,
  });
  if (data.generatedWebhookToken) {
    const tokenInput = document.querySelector("#webhook-token");
    tokenInput.value = data.generatedWebhookToken;
  }
  connectorsFeedback.textContent = formatJson(data);
  if (attachmentMediaApiKeyInput) {
    attachmentMediaApiKeyInput.value = "";
  }
  await loadState();
}

async function cleanupAttachmentCache() {
  connectorsFeedback.textContent = "Cleaning attachment cache with retention policy...";
  const data = await postJson("/api/connectors/adapters/attachments/cleanup", {
    dryRun: false,
    policy: {
      enabled: Boolean(attachmentRetentionEnabledInput?.checked),
      maxAgeDays: Number(attachmentRetentionDaysInput?.value || 14),
      failedMaxAgeDays: 3,
      maxTotalBytes: Number(attachmentRetentionBytesInput?.value || 100_000_000),
      deleteOrphanFiles: true,
    },
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function testAttachmentMediaProvider() {
  connectorsFeedback.textContent = "Testing media provider...";
  let policy;
  try {
    policy = readAttachmentMediaPolicy({ forceEnabled: true });
  } catch (error) {
    connectorsFeedback.textContent = error.message;
    return;
  }
  const data = await postJson("/api/connectors/adapters/attachments/media-provider/test", {
    mediaKind: attachmentMediaTestKindInput?.value || "",
    policy,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function checkAttachmentMediaSetup() {
  connectorsFeedback.textContent = "Checking local media engines...";
  const response = await fetch("/api/connectors/adapters/attachments/media-provider/setup");
  const data = await response.json();
  latestMediaSetup = data;
  latestMediaInstallPlan = null;
  renderMediaSetup(data);
  connectorsFeedback.textContent = formatJson(data);
}

async function buildAttachmentMediaInstallPlan() {
  connectorsFeedback.textContent = "Building installer plan...";
  const data = await postJson("/api/connectors/adapters/attachments/media-provider/install-plan", {
    includeAvailable: false,
  });
  latestMediaInstallPlan = data;
  renderMediaInstallPlan(data);
  connectorsFeedback.textContent = formatJson(data);
}

function applyDetectedMediaRoutes() {
  if (!latestMediaSetup?.recommendedRoutes) {
    connectorsFeedback.textContent = "Run Check local engines first.";
    return;
  }
  const routes = latestMediaSetup.recommendedRoutes || {};
  const enabledCount = Object.values(routes).filter((route) => route?.enabled).length;
  if (attachmentMediaRoutesInput) {
    attachmentMediaRoutesInput.value = formatJson(routes);
  }
  if (attachmentMediaAnalysisEnabledInput) {
    attachmentMediaAnalysisEnabledInput.checked = true;
  }
  if (attachmentMediaProviderInput) {
    attachmentMediaProviderInput.value = "mock";
  }
  connectorsFeedback.textContent = `Applied ${enabledCount} detected media route(s). Review the JSON, then Save policy.`;
}

async function scheduleAttachmentCleanup() {
  connectorsFeedback.textContent = "Creating daily attachment cleanup schedule...";
  const data = await postJson("/api/schedules", {
    name: "Daily attachment cache cleanup",
    tool: "cleanup_attachment_cache",
    agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
    intervalSeconds: 86400,
    maxRuns: 0,
    retryMaxAttempts: 2,
    retryDelaySeconds: 10,
    runNow: false,
    input: {
      dryRun: false,
      policy: {
        enabled: Boolean(attachmentRetentionEnabledInput?.checked),
        maxAgeDays: Number(attachmentRetentionDaysInput?.value || 14),
        failedMaxAgeDays: 3,
        maxTotalBytes: Number(attachmentRetentionBytesInput?.value || 100_000_000),
        deleteOrphanFiles: true,
      },
    },
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function rotateWebhookToken() {
  connectorsFeedback.textContent = "Rotating webhook token...";
  const data = await postJson("/api/connectors/webhook/token/rotate", {});
  const tokenInput = document.querySelector("#webhook-token");
  tokenInput.value = data.token || "";
  connectorsFeedback.textContent = formatJson({
    ...data,
    note: "Raw token is shown once and was copied into the webhook token field for testing.",
  });
  await loadState();
}

async function saveAdapterConfig(event) {
  event.preventDefault();
  if (!selectedAdapterId) {
    connectorsFeedback.textContent = "No adapter selected.";
    return;
  }
  connectorsFeedback.textContent = "Saving adapter config...";
  const data = await postJson("/api/connectors/adapters/config", {
    adapterId: selectedAdapterId,
    enabled: Boolean(adapterEnabledInput?.checked),
    defaultAgentId: adapterAgentInput?.value.trim() || "main",
    mode: adapterModeInput?.value || "manual",
    secret: adapterSecretInput?.value.trim() || "",
  });
  connectorsFeedback.textContent = formatJson(data);
  if (adapterSecretInput) {
    adapterSecretInput.value = "";
  }
  await loadState();
}

async function testSelectedAdapter() {
  if (!selectedAdapterId) {
    connectorsFeedback.textContent = "No adapter selected.";
    return;
  }
  connectorsFeedback.textContent = "Testing adapter manifest...";
  const data = await postJson("/api/connectors/adapters/test", {
    adapterId: selectedAdapterId,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function pollTelegramOnce() {
  connectorsFeedback.textContent = "Polling Telegram once...";
  const data = await postJson("/api/connectors/telegram/poll", {
    limit: 10,
    timeoutSeconds: 1,
    source: "dashboard",
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function startTelegramWorker() {
  connectorsFeedback.textContent = "Starting Telegram polling worker...";
  const data = await postJson("/api/connectors/telegram/start", {
    intervalMs: 5000,
    limit: 10,
    runNow: true,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function stopTelegramWorker() {
  connectorsFeedback.textContent = "Stopping Telegram polling worker...";
  const data = await postJson("/api/connectors/telegram/stop", {
    reason: "dashboard-stop",
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function dispatchDiscordDryRun() {
  connectorsFeedback.textContent = "Dispatching Discord dry-run event...";
  const data = await postJson("/api/connectors/discord/dispatch", {
    source: "dashboard-dry-run",
    reply: false,
    mockEvents: [
      {
        op: 0,
        t: "MESSAGE_CREATE",
        s: Date.now(),
        d: {
          id: `dashboard-${Date.now()}`,
          channel_id: "dashboard-channel",
          guild_id: "dashboard-guild",
          author: {
            username: "dashboard",
            bot: false,
          },
          content: "Discord dry-run message from OmniClaw dashboard.",
        },
      },
    ],
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function startDiscordWorker() {
  connectorsFeedback.textContent = "Starting Discord gateway worker...";
  const data = await postJson("/api/connectors/discord/start", {
    connectNow: true,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function stopDiscordWorker() {
  connectorsFeedback.textContent = "Stopping Discord gateway worker...";
  const data = await postJson("/api/connectors/discord/stop", {
    reason: "dashboard-stop",
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function retryAdapterOutbox(outboxId) {
  if (!outboxId) {
    connectorsFeedback.textContent = "No outbox item selected.";
    return;
  }
  connectorsFeedback.textContent = "Retrying adapter reply send...";
  const data = await postJson("/api/connectors/adapters/retry", {
    outboxId,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function cacheAdapterAttachment(deliveryId, attachmentIndex = 0) {
  if (!deliveryId) {
    connectorsFeedback.textContent = "No delivery selected.";
    return;
  }
  connectorsFeedback.textContent = "Caching adapter attachment locally...";
  const data = await postJson("/api/connectors/adapters/attachments/cache", {
    deliveryId,
    attachmentIndex,
    maxBytes: 5_000_000,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function ingestAdapterDelivery(deliveryId) {
  if (!deliveryId) {
    connectorsFeedback.textContent = "No delivery selected.";
    return;
  }
  connectorsFeedback.textContent = "Running attachment ingestion...";
  const data = await postJson("/api/connectors/adapters/attachments/ingest", {
    deliveryId,
    force: true,
    policy: {
      enabled: true,
      autoCache: true,
      autoExtract: true,
      autoInject: Boolean(attachmentAutoInjectInput?.checked),
      maxAttachmentsPerDelivery: Number(attachmentMaxCountInput?.value || 3),
      maxCacheBytes: Number(attachmentMaxCacheBytesInput?.value || 5_000_000),
    },
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function extractAdapterAttachment(cacheId) {
  if (!cacheId) {
    connectorsFeedback.textContent = "No cached attachment selected.";
    return;
  }
  connectorsFeedback.textContent = "Extracting cached attachment content...";
  const data = await postJson("/api/connectors/adapters/attachments/extract", {
    cacheId,
    maxBytes: 1_000_000,
    maxChars: 12000,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function analyzeAdapterAttachment(extractId) {
  if (!extractId) {
    connectorsFeedback.textContent = "No media extract selected.";
    return;
  }
  connectorsFeedback.textContent = "Running media analysis...";
  let policy;
  try {
    policy = {
      ...readAttachmentMediaPolicy({ forceEnabled: true }),
      maxInputBytes: Number(attachmentMaxCacheBytesInput?.value || 5_000_000),
      maxOutputChars: 12000,
      timeoutMs: 30000,
    };
  } catch (error) {
    connectorsFeedback.textContent = error.message;
    return;
  }
  const data = await postJson("/api/connectors/adapters/attachments/analyze", {
    extractId,
    force: true,
    policy,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function injectAdapterAttachment(extractId) {
  if (!extractId) {
    connectorsFeedback.textContent = "No extracted attachment selected.";
    return;
  }
  connectorsFeedback.textContent = "Sending extracted attachment content into an OmniClaw session...";
  const data = await postJson("/api/connectors/adapters/attachments/inject", {
    extractId,
    agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
    maxChars: 12000,
  });
  connectorsFeedback.textContent = formatJson(data);
  await loadState();
}

async function promoteCandidate(candidate) {
  memoryFeedback.textContent = "Promoting memory candidate...";
  const data = await postJson("/api/memory/promote", {
    agentId: candidate.agentId || normalizeAgentId(agentSelect.value || selectedAgentId),
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    title: candidate.title,
    text: candidate.text,
    importance: candidate.score >= 0.78 ? "high" : "medium",
    tags: candidate.tags || [],
  });
  memoryFeedback.textContent = formatJson(data);
  await loadState();
}

async function runDreamSweep() {
  memoryFeedback.textContent = "Running memory dream sweep...";
  const data = await postJson("/api/memory/dream", {
    agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
    limit: 5,
    minScore: 0.65,
  });
  memoryFeedback.textContent = formatJson(data);
  await loadState();
}

async function testProviderReadiness() {
  if (!providerOutput) {
    return;
  }
  providerOutput.textContent = "Checking provider readiness...";
  const profileId = document.querySelector("#provider-profile").value;
  const preset = PROVIDER_PRESETS[profileId] || PROVIDER_PRESETS.openai;
  const providerId = document.querySelector("#provider-key-id").value.trim() || preset.providerId;
  const data = await postJson("/api/provider/test", { profileId, apiKeyProviderId: providerId, live: true });
  providerOutput.textContent = formatJson(data);
  await loadState();
}

async function createManualDelegation() {
  if (!delegationInstructionInput || !delegationAgentSelect || !delegationFeedback) {
    return;
  }
  const instruction = delegationInstructionInput.value.trim();
  if (!instruction) {
    delegationFeedback.textContent = "Write a task before delegating.";
    return;
  }

  delegationFeedback.textContent = "Queueing delegation...";
  const data = await postJson("/api/delegations/create", {
    targetAgentId: normalizeAgentId(delegationAgentSelect.value || "builder"),
    sourceAgentId: normalizeAgentId(agentSelect.value || selectedAgentId || "main"),
    parentSessionId: selectedSessionId || "",
    instruction,
  });
  delegationFeedback.textContent = formatJson(data);
  if (!data.error) {
    delegationInstructionInput.value = "";
    await loadState();
  }
}

async function cancelDelegation(delegationId) {
  if (!delegationId || !delegationFeedback) {
    return;
  }
  delegationFeedback.textContent = `Cancelling ${delegationId}...`;
  const data = await postJson("/api/delegations/cancel", {
    delegationId,
    note: "dashboard-cancel",
  });
  delegationFeedback.textContent = formatJson(data);
  await loadState();
}

async function retryDelegation(delegationId) {
  if (!delegationId || !delegationFeedback) {
    return;
  }
  delegationFeedback.textContent = `Retrying ${delegationId}...`;
  const data = await postJson("/api/delegations/retry", {
    delegationId,
    source: "dashboard-retry",
  });
  delegationFeedback.textContent = formatJson(data);
  await loadState();
}

async function runSchedule(scheduleId) {
  if (!scheduleId) {
    return;
  }
  scheduleFeedback.textContent = "Queueing schedule run...";
  const data = await postJson("/api/schedules/run", { scheduleId });
  scheduleFeedback.textContent = formatJson(data);
  await loadState();
}

async function toggleSchedule(scheduleId, status) {
  if (!scheduleId) {
    return;
  }
  scheduleFeedback.textContent = "Updating schedule status...";
  const data = await postJson("/api/schedules/toggle", { scheduleId, status });
  scheduleFeedback.textContent = formatJson(data);
  await loadState();
}

async function deleteSchedule(scheduleId) {
  if (!scheduleId) {
    return;
  }
  scheduleFeedback.textContent = "Deleting schedule...";
  const data = await postJson("/api/schedules/delete", { scheduleId });
  scheduleFeedback.textContent = formatJson(data);
  await loadState();
}

async function loadState() {
  try {
    const [stateResponse, gatewayResponse] = await Promise.all([fetch("/api/state"), fetch("/api/gateway")]);
    const [state, gateway] = await Promise.all([stateResponse.json(), gatewayResponse.json()]);

    latestState = state;
    latestGateway = gateway;
    syncRuntimeControls(state);

    const selectedSession = state.sessions?.find((item) => item.id === selectedSessionId) || null;
    if (selectedSession) {
      selectedAgentId = normalizeAgentId(selectedSession.agentId);
    }
    if (!state.agents?.some((agent) => agent.id === selectedAgentId)) {
      selectedAgentId = selectedSession?.agentId || state.agents?.[0]?.id || "main";
    }

    const detail = await fetchSessionDetail(selectedSessionId || state.sessions?.[0]?.id || "");
    if (!selectedSessionId && detail?.id) {
      selectedSessionId = detail.id;
      selectedAgentId = normalizeAgentId(detail.agentId || selectedAgentId);
    }

    renderHero(state, gateway);
    renderOverview(state, gateway);
    renderProviderStatus(state);
    await loadDesignBridge();
    renderGatewayEvents(gateway);
    renderRuns(gateway);
    renderSessions(state);
    renderBackgroundJobs(state);
    renderConnectors(state);
    renderAgents(state);
    renderDelegations(state);

    const selectedDetail =
      selectedSessionId && detail?.id === selectedSessionId ? detail : await fetchSessionDetail(selectedSessionId || "");
    if (!state.plugins?.some((item) => item.id === selectedPluginId)) {
      selectedPluginId = state.plugins?.[0]?.id || "";
    }
    latestPluginDetail = await fetchPluginDetail(selectedPluginId || "");

    sessionDetailOutput.innerHTML = renderSessionDetail(selectedDetail);
    renderChatTranscript(selectedDetail);
    renderApprovals(state);
    renderWorkspace(state);
    renderPlugins(state);
    renderTrust(state);
    renderShellAudit(state);
    renderConnectors(state);
    renderJobs(state);
    renderSchedules(state);
    renderMemoryReview(state);
    renderResearch(state);
    renderArtifacts(state);
    renderSkills(state);
    renderTools(state);
    renderCompactState(state, gateway, selectedDetail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = emptyState(`Unable to load gateway state: ${message}`);
    inspectorOutput.innerHTML = fallback;
    gatewayOutput.innerHTML = fallback;
    runOutput.innerHTML = fallback;
    sessionOutput.innerHTML = fallback;
    sessionDetailOutput.innerHTML = fallback;
    agentOutput.innerHTML = fallback;
    agentDetailOutput.innerHTML = fallback;
    if (delegationOutput) {
      delegationOutput.innerHTML = fallback;
    }
    if (delegationContext) {
      delegationContext.textContent = "Delegation unavailable";
    }
    approvalOutput.innerHTML = fallback;
    workspaceOutput.innerHTML = fallback;
    pluginOutput.innerHTML = fallback;
    pluginDetailOutput.innerHTML = fallback;
    pluginConfigFields.innerHTML = fallback;
    if (providerStatusOutput) {
      providerStatusOutput.innerHTML = fallback;
    }
    if (designBridgeOutput) {
      designBridgeOutput.textContent = `ERROR\n${message}`;
    }
    trustOutput.innerHTML = fallback;
    deviceOutput.innerHTML = fallback;
    trustAuditOutput.innerHTML = fallback;
    trustContext.textContent = "Trust unavailable";
    shellAuditOutput.innerHTML = fallback;
    shellAuditDetailOutput.innerHTML = fallback;
    shellPolicyOutput.innerHTML = fallback;
    shellAuditContext.textContent = "Execution unavailable";
    webhookOutput.innerHTML = fallback;
    fileDropOutput.innerHTML = fallback;
    fileDropPendingOutput.innerHTML = fallback;
    connectorSecurityOutput.innerHTML = fallback;
    connectorAdapterOutput.innerHTML = fallback;
    adapterDeliveryOutput.innerHTML = fallback;
    adapterAttachmentCacheOutput.innerHTML = fallback;
    adapterAttachmentExtractOutput.innerHTML = fallback;
    adapterAttachmentAnalysisOutput.innerHTML = fallback;
    adapterAttachmentInjectionOutput.innerHTML = fallback;
    adapterOutboxOutput.innerHTML = fallback;
    connectorsContext.textContent = "Connectors unavailable";
    jobOutput.innerHTML = fallback;
    jobDetailOutput.innerHTML = fallback;
    scheduleOutput.innerHTML = fallback;
    memoryCandidateOutput.innerHTML = fallback;
    longMemoryOutput.innerHTML = fallback;
    dreamOutput.innerHTML = fallback;
    memoryContext.textContent = "Memory unavailable";
    researchOutput.innerHTML = fallback;
    artifactOutput.innerHTML = fallback;
    skillLibraryOutput.innerHTML = fallback;
    toolOutput.innerHTML = fallback;
    stateOutput.textContent = `ERROR\n${message}`;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadState();
  }, 240);
}

function openEventStream() {
  if (eventStream) {
    return;
  }

  eventStream = new EventSource("/api/events");

  eventStream.onmessage = (event) => {
    try {
      const record = JSON.parse(event.data);
      if (record.type !== "hello") {
        heroLastEvent.textContent = `Last event: ${record.event || record.type} at ${formatDate(record.at)}.`;
        trackLiveRunEvent(record);
      }
    } catch {
      heroLastEvent.textContent = "Live event received.";
    }

    scheduleRefresh();
  };

  eventStream.onerror = () => {
    heroFocus.textContent = "Live feed reconnecting. Manual refresh is still available.";
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();

  if (!message) {
    return;
  }

  if (activeChatController) {
    activeChatController.abort();
  }

  activeChatController = new AbortController();
  if (abortRunButton) {
    abortRunButton.disabled = false;
  }
  chatOutput.textContent = "Running through the gateway...";
  resetLiveRunTimeline("Waiting for gateway acceptance...");

  const selected = selectedSessionSummary();
  const payload = {
    message,
    label: sessionLabelInput.value.trim() || "main",
    agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
    channel: "webchat",
  };

  if (
    selected &&
    selected.lifecycleState !== "archived" &&
    normalizeAgentId(selected.agentId) === normalizeAgentId(payload.agentId)
  ) {
    payload.sessionId = selected.id;
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: activeChatController.signal,
    });

    const data = await response.json();
    if (data.run?.id) {
      activeRunId = data.run.id;
      renderLiveRunTimeline("Run completed.");
    }
    chatOutput.textContent = formatChatResponse(data);
    messageInput.value = "";
    if (data.run?.id) {
      await fetchPromptTrace(data.run.id);
      if ((Array.isArray(data.toolOutputs) && data.toolOutputs.length > 0) || data.modelToolLoop?.attempted) {
        await fetchToolTrace(data.run.id);
      }
    }

    if (data.session?.id) {
      selectedSessionId = data.session.id;
      selectedAgentId = normalizeAgentId(data.session.agentId || payload.agentId);
      rememberSelectedSession({ id: selectedSessionId, agentId: selectedAgentId });
      sessionLabelInput.value = data.session.label || sessionLabelInput.value;
    }

    await loadState();
  } catch (error) {
    chatOutput.textContent =
      error?.name === "AbortError" ? "Run aborted from the local UI." : `Run failed: ${error.message}`;
  } finally {
    activeChatController = null;
    if (abortRunButton) {
      abortRunButton.disabled = true;
    }
  }
});

clearOutputButton?.addEventListener("click", () => {
  chatOutput.textContent = "Waiting for input...";
  activeRunId = "";
  activeRunEvents = [];
  activeRunStartedAt = 0;
  renderLiveRunTimeline("No active run.");
});
// ─── Keyboard Shortcuts ─────────────────────────────────────────
if (messageInput) {
 messageInput.addEventListener("keydown", (e) => {
   if (e.key === "Enter" && !e.shiftKey) {
     e.preventDefault();
     form.dispatchEvent(new Event("submit", { cancelable: true }));
   }
 });
}
// Global shortcuts
document.addEventListener("keydown", (e) => {
 // Ctrl+Enter to send
 if (e.ctrlKey && e.key === "Enter") {
   e.preventDefault();
   form.dispatchEvent(new Event("submit", { cancelable: true }));
 }
 // Escape to abort
 if (e.key === "Escape" && activeChatController) {
   activeChatController.abort();
 }
});


abortRunButton?.addEventListener("click", () => {
  if (!activeChatController) {
    chatOutput.textContent = "No active run to abort.";
    abortRunButton.disabled = true;
    return;
  }
  activeChatController.abort();
});

async function fetchSessionSummary(sessionId) {
  const summaryBox = document.querySelector("#session-summary-box");
  const summaryText = document.querySelector("#session-summary-text");
  const summaryPill = document.querySelector("#session-summary-pill");

  try {
    const res = await fetch(`/api/sessions/${sessionId}/summary`);
    if (!res.ok) throw new Error("No summary");
    const data = await res.json();
    
    summaryText.textContent = data.summary.text;
    summaryBox.style.display = "block";
    summaryPill.style.display = "inline-flex";
  } catch (err) {
    summaryBox.style.display = "none";
    summaryPill.style.display = "none";
  }
}

async function fetchDreamingInsights() {
  try {
    const res = await fetch("/api/memory/insights?agentId=" + selectedAgentId);
    if (!res.ok) return;
    const data = await res.json();
    if (data.insight) {
      const heroFocus = document.querySelector("#hero-focus");
      heroFocus.innerHTML = `<strong>Latest Dream:</strong> ${data.insight.summary}<br><small>Promoted ${data.insight.promotedCount} memories</small>`;
    }
  } catch (err) {}
}

async function fetchSystemStats() {
  const statsOutput = document.querySelector("#system-stats-output");
  const processOutput = document.querySelector("#process-list-output");

  try {
    const sysRes = await fetch("/api/system/status");
    if (!sysRes.ok) throw new Error("Status failed");
    const sysData = await sysRes.json();
    const summaryText = sysData.summary?.summary || sysData.summary?.error || "System summary unavailable";
    const processes = Array.isArray(sysData.processes?.processes) ? sysData.processes.processes : [];
    const processCount = Number(sysData.processes?.count || processes.length || 0);
    const degraded = sysData.summary?.status === "degraded" || sysData.processes?.status === "degraded";

    statsOutput.innerHTML = `
      <div class="metric-tile">
        <p class="metric-value" style="font-size: 0.9rem;">${escapeHtml(summaryText.split("\n")[0])}</p>
        <p class="metric-label">OS Info</p>
      </div>
      <div class="metric-tile">
        <p class="metric-value">${processCount}</p>
        <p class="metric-label">Running Tasks</p>
      </div>
      ${degraded ? `<small>${escapeHtml("Limited host visibility: " + (sysData.processes?.error || sysData.summary?.error || "runtime permission boundary"))}</small>` : ""}
    `;

    processOutput.innerHTML = processes.length ? processes.map(p => `
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border); padding: 4px 0;">
        <span style="font-weight: 600;">${escapeHtml(p.name || "process")}</span>
        <span style="color: var(--text-muted);">${escapeHtml(p.memory || "")}</span>
      </div>
    `).join("") : emptyState("No process details available in this runtime.");

  } catch (err) {
    statsOutput.textContent = "Error loading system stats: " + err.message;
  }
}

async function selectSession(sessionId) {
  selectedSessionId = sessionId;
  const summary = selectedSessionSummary();
  if (summary) {
    rememberSelectedSession(summary);
    sessionContext.textContent = `${summary.label} | ${summary.agentId}`;
    sessionContext.classList.remove("status-chip-muted");
    sessionLabelInput.value = summary.label;
    agentSelect.value = summary.agentId || "main";
  }
  
  await fetchSessionSummary(sessionId);
  refreshState();
}

refreshStateButton.addEventListener("click", loadState);
refreshInspectorButton.addEventListener("click", loadState);

delegationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await createManualDelegation();
});

rotateGatewayTokenButton.addEventListener("click", rotateGatewayToken);
copyGatewayTokenButton?.addEventListener("click", copyGatewayToken);
document.querySelector("#refresh-system-button").addEventListener("click", fetchSystemStats);

pairingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  trustFeedback.textContent = "Creating pairing request...";

  const payload = {
    label: document.querySelector("#pairing-label").value.trim() || "Dashboard device",
    role: document.querySelector("#pairing-role").value || "operator",
    fingerprint: document.querySelector("#pairing-fingerprint").value.trim(),
    note: document.querySelector("#pairing-note").value.trim(),
  };

  const data = await postJson("/api/trust/pairing/request", payload);
  trustFeedback.textContent = formatJson(data);
  await loadState();
});

shellAuditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  shellAuditOutput.innerHTML = emptyState("Filtering shell audit...");
  const data = await fetchShellAudit({
    risk: document.querySelector("#shell-audit-risk").value,
    status: document.querySelector("#shell-audit-status").value,
    query: document.querySelector("#shell-audit-query").value.trim(),
  });
  latestState = {
    ...(latestState || {}),
    shellExecution: {
      policy: {
        enabled: data.policy?.enabled,
        allowlistMode: data.policy?.allowlistMode,
        timeoutMs: data.policy?.timeoutMs,
        maxOutputBytes: data.policy?.maxOutputBytes,
        allowlistPatterns: data.policy?.allowlistPatterns || [],
        blockedPatterns: data.policy?.blockedPatterns || [],
        allowlistCount: data.policy?.allowlistPatterns?.length || 0,
        blockedPatternCount: data.policy?.blockedPatterns?.length || 0,
      },
      audit: data.overview || {},
      records: data.records || [],
    },
  };
  selectedShellAuditId = latestState.shellExecution.records?.[0]?.id || "";
  renderShellAudit(latestState);
});

for (const field of [shellPolicyMode, shellPolicyTimeout, shellPolicyOutputLimit, shellPolicyAllowlist, shellPolicyBlocked]) {
  field.addEventListener("input", () => {
    shellPolicyEditorDirty = true;
  });
  field.addEventListener("change", () => {
    shellPolicyEditorDirty = true;
  });
}

shellPolicyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  shellPolicyFeedback.textContent = "Saving shell policy...";
  const payload = {
    allowlistMode: document.querySelector("#shell-policy-mode").value,
    trustLevel: document.querySelector("#policy-trust-level").value,
    timeoutMs: Number(document.querySelector("#shell-policy-timeout").value),
    maxOutputBytes: Number(document.querySelector("#shell-policy-output-limit").value),
    allowlistPatterns: document
      .querySelector("#shell-policy-allowlist")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    blockedPatterns: document
      .querySelector("#shell-policy-blocked")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const data = await postJson("/api/shell/policy", payload);
  shellPolicyFeedback.textContent = formatJson(data.error ? data : { updated: data.updated, policy: data.policy });
  if (!data.error) {
    shellPolicyEditorDirty = false;
    await loadState();
  }
});

webhookTestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  connectorsFeedback.textContent = "Sending webhook test...";
  const data = await postJson("/api/connectors/webhook", {
    message: document.querySelector("#webhook-message").value.trim(),
    label: document.querySelector("#webhook-label").value.trim() || "webhook",
    agentId: document.querySelector("#webhook-agent").value.trim(),
    token: document.querySelector("#webhook-token").value.trim(),
  });
  connectorsFeedback.textContent = formatJson(data);
  if (!data.error) {
    document.querySelector("#webhook-message").value = "";
    await loadState();
  }
});

saveConnectorConfigButton.addEventListener("click", saveConnectorConfig);
testMediaProviderButton?.addEventListener("click", testAttachmentMediaProvider);
checkMediaSetupButton?.addEventListener("click", checkAttachmentMediaSetup);
buildMediaInstallPlanButton?.addEventListener("click", buildAttachmentMediaInstallPlan);
applyMediaSetupButton?.addEventListener("click", applyDetectedMediaRoutes);
cleanupAttachmentCacheButton.addEventListener("click", cleanupAttachmentCache);
scheduleAttachmentCleanupButton.addEventListener("click", scheduleAttachmentCleanup);
attachmentMediaPresetInput?.addEventListener("change", () => {
  applyMediaPreset(attachmentMediaPresetInput.value);
});
rotateWebhookTokenButton.addEventListener("click", rotateWebhookToken);
scanFileDropButton.addEventListener("click", scanFileDrop);
adapterSelect.addEventListener("change", () => {
  selectedAdapterId = adapterSelect.value;
  renderConnectors(latestState || {});
});
connectorAdapterOutput.addEventListener("click", (event) => {
  const button = event.target.closest("[data-adapter-id]");
  if (!button) {
    return;
  }
  selectedAdapterId = button.dataset.adapterId || "";
  renderConnectors(latestState || {});
});
for (const filter of [adapterDeliveryAdapterFilter, adapterDeliveryStatusFilter, adapterDeliveryQueryFilter]) {
  filter?.addEventListener("input", () => renderConnectors(latestState || {}));
  filter?.addEventListener("change", () => renderConnectors(latestState || {}));
}
adapterDeliveryOutput.addEventListener("click", (event) => {
  const ingestButton = event.target.closest("[data-attachment-ingest-delivery]");
  if (ingestButton && !ingestButton.disabled) {
    void ingestAdapterDelivery(ingestButton.dataset.attachmentIngestDelivery || "");
    return;
  }

  const button = event.target.closest("[data-attachment-cache-delivery]");
  if (!button || button.disabled) {
    return;
  }
  void cacheAdapterAttachment(button.dataset.attachmentCacheDelivery || "", Number(button.dataset.attachmentCacheIndex || 0));
});
adapterAttachmentCacheOutput.addEventListener("click", (event) => {
  const button = event.target.closest("[data-attachment-extract-cache]");
  if (!button || button.disabled) {
    return;
  }
  void extractAdapterAttachment(button.dataset.attachmentExtractCache || "");
});
adapterAttachmentExtractOutput.addEventListener("click", (event) => {
  const analyzeButton = event.target.closest("[data-attachment-analyze-extract]");
  if (analyzeButton && !analyzeButton.disabled) {
    void analyzeAdapterAttachment(analyzeButton.dataset.attachmentAnalyzeExtract || "");
    return;
  }

  const button = event.target.closest("[data-attachment-inject-extract]");
  if (!button || button.disabled) {
    return;
  }
  void injectAdapterAttachment(button.dataset.attachmentInjectExtract || "");
});
adapterOutboxOutput.addEventListener("click", (event) => {
  const button = event.target.closest("[data-outbox-retry]");
  if (!button || button.disabled) {
    return;
  }
  void retryAdapterOutbox(button.dataset.outboxRetry || "");
});
adapterConfigForm.addEventListener("submit", saveAdapterConfig);
testAdapterButton.addEventListener("click", testSelectedAdapter);
pollTelegramButton.addEventListener("click", pollTelegramOnce);
startTelegramButton.addEventListener("click", startTelegramWorker);
stopTelegramButton.addEventListener("click", stopTelegramWorker);
dispatchDiscordButton.addEventListener("click", dispatchDiscordDryRun);
startDiscordButton.addEventListener("click", startDiscordWorker);
stopDiscordButton.addEventListener("click", stopDiscordWorker);

runDreamSweepButton.addEventListener("click", runDreamSweep);

memoryPromoteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  memoryFeedback.textContent = "Promoting manual memory...";
  const data = await postJson("/api/memory/promote", {
    agentId: document.querySelector("#memory-agent").value.trim() || normalizeAgentId(agentSelect.value || selectedAgentId),
    sourceType: "manual",
    title: document.querySelector("#memory-title").value.trim() || "Manual memory",
    text: document.querySelector("#memory-text").value.trim(),
    importance: document.querySelector("#memory-importance").value || "medium",
    tags: document.querySelector("#memory-tags").value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  });
  memoryFeedback.textContent = formatJson(data);
  if (!data.error) {
    document.querySelector("#memory-title").value = "";
    document.querySelector("#memory-text").value = "";
    document.querySelector("#memory-tags").value = "";
    await loadState();
  }
});

agentSelect.addEventListener("change", async () => {
  selectedAgentId = normalizeAgentId(agentSelect.value || "main");
  const session = pickSessionForAgent(selectedAgentId, latestState?.sessions || []);
  selectedSessionId = session?.id || "";
  if (session?.label) {
    sessionLabelInput.value = session.label;
  }
  await loadState();
});

scheduleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  scheduleFeedback.textContent = "Creating schedule...";

  const payload = {
    name: document.querySelector("#schedule-name").value.trim(),
    tool: scheduleToolSelect.value || "runtime_summary",
    agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
    intervalSeconds: Number(document.querySelector("#schedule-interval").value || 60),
    maxRuns: Number(document.querySelector("#schedule-max-runs").value || 0),
    retryMaxAttempts: Number(document.querySelector("#schedule-retries").value || 1),
    retryDelaySeconds: Number(document.querySelector("#schedule-retry-delay").value || 5),
    runNow: document.querySelector("#schedule-run-now").checked,
    input: parseJsonInput(document.querySelector("#schedule-input").value, {}),
  };

  const data = await postJson("/api/schedules", payload);
  scheduleFeedback.textContent = formatJson(data);
  await loadState();
});

cancelJobButton.addEventListener("click", async () => {
  if (!selectedJobId) {
    jobDetailOutput.innerHTML = emptyState("No job selected.");
    return;
  }

  jobDetailOutput.innerHTML = emptyState("Cancelling selected job...");
  const data = await postJson("/api/jobs/cancel", {
    jobId: selectedJobId,
    reason: "dashboard-cancel",
  });
  jobDetailOutput.innerHTML = renderJobDetail(data.job || selectedJobSummary());
  await loadState();
});

resetSessionButton.addEventListener("click", async () => {
  if (!selectedSessionId) {
    sessionDetailOutput.innerHTML = emptyState("No session selected.");
    return;
  }

  sessionDetailOutput.innerHTML = emptyState("Resetting selected session...");

  const response = await fetch("/api/sessions/reset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: selectedSessionId,
      reason: "dashboard-reset",
    }),
  });
  const data = await response.json();

  if (data.error) {
    sessionDetailOutput.innerHTML = emptyState(data.error);
    return;
  }

  selectedSessionId = "";
  await loadState();
});

runtimeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  runtimeOutput.textContent = "Applying runtime settings...";

  const payload = {
    profile: document.querySelector("#profile").value,
    providerMode: document.querySelector("#provider-mode").value,
    model: document.querySelector("#provider-model").value.trim(),
  };

  const response = await fetch("/api/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  runtimeOutput.textContent = formatJson(data);
  await loadState();
});

skillForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  skillOutput.textContent = "Creating skill...";

  const payload = {
    name: document.querySelector("#skill-name").value.trim(),
    triggers: document.querySelector("#skill-triggers").value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    description: document.querySelector("#skill-description").value.trim(),
    instructions: document.querySelector("#skill-instructions").value.trim(),
    agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
  };

  const response = await fetch("/api/skills", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  skillOutput.textContent = formatJson(data);
  skillForm.reset();
  await loadState();
});

approveLatestButton.addEventListener("click", async () => {
  if (!latestState?.approvals?.length) {
    approvalOutput.innerHTML = emptyState("No pending approvals to approve.");
    return;
  }

  const latest = latestState.approvals[0];
  const response = await fetch("/api/approvals/resolve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      approvalId: latest.id,
      decision: "approved",
      note: "Approved from OmniClaw control UI.",
    }),
  });

  const data = await response.json();
  if (data.error) {
    approvalOutput.innerHTML = emptyState(data.error);
    return;
  }

  await loadState();
});

runPluginJobButton.addEventListener("click", async () => {
  const plugin = latestPluginDetail || selectedPluginSummary();
  if (!plugin) {
    pluginFeedback.textContent = "No plugin selected.";
    return;
  }

  const toolId = plugin.runtime?.defaultToolId || plugin.runtime?.tools?.[0]?.id;
  if (!toolId) {
    pluginFeedback.textContent = "Selected plugin has no runnable tool.";
    return;
  }

  pluginFeedback.textContent = "Queueing plugin job...";

  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: toolId,
      agentId: normalizeAgentId(agentSelect.value || selectedAgentId),
      input: {
        message: `${plugin.id} background job for ${normalizeAgentId(agentSelect.value || selectedAgentId)}`,
      },
    }),
  });
  const data = await response.json();
  pluginFeedback.textContent = formatJson(data);
  await loadState();
});

providerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  providerOutput.textContent = "Saving provider settings...";

  const profileId = document.querySelector("#provider-profile").value;
  const preset = PROVIDER_PRESETS[profileId] || PROVIDER_PRESETS.openai;
  const providerId = document.querySelector("#provider-key-id").value.trim() || preset.providerId;
  const apiKey = document.querySelector("#provider-key").value.trim();
  const removeKey = Boolean(document.querySelector("#provider-remove-key")?.checked);
  const usesCodexCli = profileId === "codex-cli";

  const profileData = await postJson("/api/provider/profile", { profileId });
  const keyRouteData =
    !usesCodexCli && providerId && providerId !== preset.providerId
      ? await postJson("/api/config", { apiKeyProviderId: providerId })
      : { skipped: true };
  let keyData = usesCodexCli
    ? { skipped: true, reason: "Codex CLI uses ChatGPT account login, not a BYOK key." }
    : { skipped: true, reason: "No key entered; stored key was left unchanged." };
  if (!usesCodexCli && removeKey) {
    keyData = await postJson("/api/provider/key", { providerId, apiKey: "" });
  } else if (!usesCodexCli && apiKey) {
    keyData = await postJson("/api/provider/key", { providerId, apiKey });
  }
  const testData = await postJson("/api/provider/test", {
    profileId,
    apiKeyProviderId: providerId,
    live: true,
  });

  providerOutput.textContent = formatJson({ test: testData, profile: profileData, keyRoute: keyRouteData, key: keyData });
  document.querySelector("#provider-key").value = "";
  if (document.querySelector("#provider-remove-key")) {
    document.querySelector("#provider-remove-key").checked = false;
  }
  await loadState();
});

testProviderButton?.addEventListener("click", testProviderReadiness);
document.querySelector("#provider-profile")?.addEventListener("change", () => {
  const profileId = document.querySelector("#provider-profile").value;
  const preset = PROVIDER_PRESETS[profileId] || PROVIDER_PRESETS.openai;
  document.querySelector("#provider-key-id").value = preset.providerId;
  updateProviderProfileControls();
});
openCodexLoginButton?.addEventListener("click", async () => {
  providerOutput.textContent = "Opening Codex setup terminal...";
  const data = await postJson("/api/provider/codex/login", {});
  providerOutput.textContent = formatJson(data);
});

designBridgeForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveDesignBridge();
});
refreshDesignBridgeButton?.addEventListener("click", () => loadDesignBridge({ force: true }));
copyDesignBridgeButton?.addEventListener("click", copyDesignBridge);

pluginConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pluginFeedback.textContent = "Updating plugin config...";

  const pluginId = document.querySelector("#plugin-config-id").value.trim();
  if (!pluginId) {
    pluginFeedback.textContent = "No plugin selected.";
    return;
  }

  const response = await fetch("/api/plugins/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pluginId,
      config: collectPluginConfigPatch(),
    }),
  });

  const data = await response.json();
  pluginFeedback.textContent = formatJson(data);
  await loadState();
});

async function togglePlugin(pluginId, enabled) {
  pluginFeedback.textContent = "Updating plugin state...";

  const response = await fetch("/api/plugins/toggle", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pluginId, enabled }),
  });

  const data = await response.json();
  pluginFeedback.textContent = formatJson(data);
  await loadState();
}

reloadPluginsButton.addEventListener("click", async () => {
  pluginFeedback.textContent = "Reloading plugin lifecycle...";
  const response = await fetch("/api/plugins/reload", {
    method: "POST",
  });
  const data = await response.json();
  pluginFeedback.textContent = formatJson(data);
  await loadState();
});

function initGatewayConnection() {
  const bootScreen = document.getElementById("boot-screen");
  const gatewayCard = bootScreen?.querySelector(".gateway-card");
  const form = document.getElementById("gateway-connect-form");
  const connectBtn = form?.querySelector(".btn-connect");
  const firstLaunchForm = document.getElementById("first-launch-form");
  const firstLaunchStatus = document.getElementById("first-launch-status");
  const firstLaunchProviderFields = document.getElementById("first-launch-provider-fields");
  const firstProviderProfile = document.getElementById("first-provider-profile");
  const firstProviderKey = document.getElementById("first-provider-key");
  const firstRuntimeProfile = document.getElementById("first-runtime-profile");
  const skipFirstLaunchButton = document.getElementById("skip-first-launch");

  function hasCompletedSetup() {
    try {
      return localStorage.getItem("omniclaw.firstLaunchComplete") === "1";
    } catch {
      return false;
    }
  }

  function markSetupComplete(mode = "skipped") {
    try {
      localStorage.setItem("omniclaw.firstLaunchComplete", "1");
      localStorage.setItem("omniclaw.firstLaunchMode", mode);
    } catch {
      // Keep going when storage is unavailable; this should never block startup.
    }
  }

  function updateSetupMode() {
    const mode = firstLaunchForm?.querySelector('input[name="setup-mode"]:checked')?.value || "offline";
    const profileId = firstProviderProfile?.value || "openai";
    if (firstLaunchProviderFields) {
      firstLaunchProviderFields.hidden = mode !== "openai";
    }
    if (firstProviderKey) {
      const usesCodexCli = mode === "openai" && profileId === "codex-cli";
      firstProviderKey.disabled = usesCodexCli;
      firstProviderKey.placeholder = usesCodexCli ? "No API key needed; run Codex login after setup" : "Paste key here";
      if (usesCodexCli) {
        firstProviderKey.value = "";
      }
    }
  }

  async function applyFirstLaunchSetup() {
    const mode = firstLaunchForm?.querySelector('input[name="setup-mode"]:checked')?.value || "offline";
    const profile = firstRuntimeProfile?.value || "balanced";
    firstLaunchStatus.textContent = "Applying setup...";

    if (mode === "offline") {
      const data = await postJson("/api/config", {
        profile,
        providerMode: "mock",
        model: "local-rule-engine",
      });
      if (data.error) {
        throw new Error(data.error);
      }
      markSetupComplete("offline");
      return;
    }

    const profileId = firstProviderProfile?.value || "openai";
    const preset = PROVIDER_PRESETS[profileId] || PROVIDER_PRESETS.openai;
    const apiKey = firstProviderKey?.value.trim() || "";
    const usesCodexCli = profileId === "codex-cli";
    if (!usesCodexCli && !apiKey) {
      throw new Error("API key is required for provider mode. Pick Offline mode to skip it.");
    }

    const profileData = await postJson("/api/provider/profile", { profileId });
    if (profileData.error) {
      throw new Error(profileData.error);
    }
    if (!usesCodexCli) {
      const keyData = await postJson("/api/provider/key", {
        providerId: preset.providerId,
        apiKey,
      });
      if (keyData.error) {
        throw new Error(keyData.error);
      }
    }
    const runtimeData = await postJson("/api/config", {
      profile,
      ...(usesCodexCli ? {} : { apiKeyProviderId: preset.providerId }),
    });
    if (runtimeData.error) {
      throw new Error(runtimeData.error);
    }
    markSetupComplete(profileId);
  }

  async function autoConnect() {
    try {
      if (connectBtn) {
        connectBtn.textContent = "Connecting...";
        connectBtn.style.opacity = "0.7";
        connectBtn.disabled = true;
      }
      
      const authOverview = await checkGatewayAuthOverview();
      if (authOverview?.overview?.gateway?.status === "revoked") {
        throw new Error("Gateway token is revoked.");
      }
      if (authOverview?.overview?.gateway?.status === "expired") {
        throw new Error("Gateway token is expired.");
      }
      
      bootScreen.classList.add("hidden");
      openEventStream();
      loadState();
      setTimeout(() => bootScreen.remove(), 1000);
    } catch (error) {
      if (connectBtn) {
        connectBtn.textContent = "Connect";
        connectBtn.style.opacity = "1";
        connectBtn.disabled = false;
      }
      alert(`Connection failed: ${error.message}`);
    }
  }

  if (!bootScreen || !form) {
    openEventStream();
    loadState();
    return;
  }

  firstLaunchForm?.addEventListener("change", updateSetupMode);
  firstLaunchForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = firstLaunchForm.querySelector('button[type="submit"]');
    try {
      submitButton.disabled = true;
      await applyFirstLaunchSetup();
      firstLaunchStatus.textContent = "Setup complete. Opening dashboard...";
      gatewayCard?.classList.remove("is-first-launch");
      await autoConnect();
    } catch (error) {
      firstLaunchStatus.textContent = error.message;
      submitButton.disabled = false;
    }
  });
  skipFirstLaunchButton?.addEventListener("click", async () => {
    markSetupComplete("skipped");
    firstLaunchStatus.textContent = "Skipped. Opening dashboard...";
    gatewayCard?.classList.remove("is-first-launch");
    await autoConnect();
  });

  updateSetupMode();
  firstProviderProfile?.addEventListener("change", updateSetupMode);
  if (!hasCompletedSetup() && firstLaunchForm) {
    gatewayCard?.classList.add("is-first-launch");
    return;
  }

  autoConnect();
}

// Start with the gateway connection screen
initGatewayConnection();

const routePanels = {
  "chat-panel": ["chat-panel"],
  "overview-panel": ["overview-panel", "system-panel", "worker-panel", "channel-summary-panel"],
  "sessions-panel": ["sessions-panel", "session-detail-output"],
  "execution-panel": ["execution-panel", "approvals-panel"],
  "scheduler-panel": ["scheduler-panel", "jobs-panel"],
  "connectors-panel": ["connectors-panel"],
  "agents-panel": ["agents-panel", "delegations-panel", "workspace-panel"],
  "skill-panel": ["skill-panel", "tools-panel"],
  "trust-panel": ["trust-panel"],
  "memory-panel": ["memory-panel"],
  "research-panel": ["research-panel", "artifacts-panel"],
  "runtime-panel": ["runtime-panel", "state-output"],
  "provider-panel": ["provider-panel"],
  "design-panel": ["design-panel"],
  "plugin-panel": ["plugin-panel"],
};

const routeMeta = {
  "chat-panel": {
    kicker: "OpenClaw style",
    title: "Chat",
    body: "Session, model lane, run output, and composer in a focused gateway chat surface.",
  },
  "overview-panel": {
    kicker: "Gateway control",
    title: "Overview",
    body: "Gateway status, sessions, tools, approvals, agents, and local runtime controls in one focused operator shell.",
  },
  "sessions-panel": { kicker: "Control", title: "Sessions", body: "Active lanes, archived sessions, and transcript inspection." },
  "execution-panel": { kicker: "Control", title: "Execution", body: "Shell policy, approvals, audit, and execution safety." },
  "scheduler-panel": { kicker: "Control", title: "Scheduler", body: "Recurring tool runs, jobs, retry state, and manual run controls." },
  "connectors-panel": { kicker: "Control", title: "Connectors", body: "Messaging channels, adapters, attachment cache, and media routes." },
  "agents-panel": { kicker: "Agent", title: "Agents", body: "Agent lanes, workspaces, delegated tasks, and scoped capabilities." },
  "skill-panel": { kicker: "Agent", title: "Skills", body: "Installed skills, runtime tools, and local skill creation." },
  "trust-panel": { kicker: "Agent", title: "Nodes", body: "Pairing, trusted devices, gateway tokens, and trust audit history." },
  "memory-panel": { kicker: "Agent", title: "Dreaming", body: "Long-term memory, promotion candidates, and dream sweep review." },
  "research-panel": { kicker: "Agent", title: "Research", body: "Saved lookups and generated artifacts." },
  "runtime-panel": { kicker: "Settings", title: "Config", body: "Profiles, provider mode, and compact raw state." },
  "provider-panel": { kicker: "Settings", title: "Providers", body: "Provider profiles, local secret readiness, and model settings." },
  "design-panel": { kicker: "Settings", title: "Appearance", body: "Design contract handoff and UI direction notes." },
  "plugin-panel": { kicker: "Settings", title: "Plugins", body: "Manifest lifecycle, plugin config, and runnable plugin jobs." },
};

const panelAliases = {
  "session-detail-output": "sessions-panel",
  "state-output": "runtime-panel",
};

function sectionForPanel(panelId) {
  const element = document.getElementById(panelId);
  return element?.closest("section") || element;
}

function applyRoute(hash = window.location.hash) {
  const requested = String(hash || "#chat-panel").replace(/^#/, "");
  const routeId = routePanels[requested] ? requested : panelAliases[requested] || "chat-panel";
  const visiblePanelIds = new Set(routePanels[routeId] || routePanels["chat-panel"]);
  const visibleSections = new Set();

  for (const panelId of visiblePanelIds) {
    const section = sectionForPanel(panelId);
    if (section) {
      visibleSections.add(section);
    }
  }

  for (const section of document.querySelectorAll(".dashboard > .surface")) {
    section.hidden = !visibleSections.has(section);
  }

  document.querySelectorAll(".nav-link").forEach((link) => {
    const target = String(link.getAttribute("href") || "").replace(/^#/, "");
    link.classList.toggle("active", target === routeId);
    link.toggleAttribute("aria-current", target === routeId);
  });

  const meta = routeMeta[routeId] || routeMeta["overview-panel"];
  const heroKicker = document.querySelector(".hero-copy .eyebrow");
  const heroTitle = document.querySelector(".hero-copy h2");
  const heroBody = document.querySelector(".hero-copy .hero-body");
  const routeCrumb = document.querySelector("#route-crumb");
  if (heroKicker) {
    heroKicker.textContent = meta.kicker;
  }
  if (heroTitle) {
    heroTitle.textContent = meta.title;
  }
  if (heroBody) {
    heroBody.textContent = meta.body;
  }
  if (routeCrumb) {
    routeCrumb.textContent = meta.title;
  }

  document.body.dataset.route = routeId;
  topbarOverviewButton?.classList.toggle("is-active", routeId === "overview-panel");
  window.scrollTo(0, 0);
  setTimeout(() => window.scrollTo(0, 0), 50);
  setTimeout(() => window.scrollTo(0, 0), 250);
}

function setStoredBoolean(key, enabled) {
  try {
    localStorage.setItem(key, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures; the UI still updates for this session.
  }
}

function restoreShellPreference(key, className, button) {
  let enabled = false;
  try {
    enabled = localStorage.getItem(key) === "1";
  } catch {
    enabled = false;
  }
  document.body.classList.toggle(className, enabled);
  button?.classList.toggle("is-active", enabled);
}

restoreShellPreference("omniclaw.compact", "is-compact", topbarDensityButton);
restoreShellPreference("omniclaw.dark", "is-dark", topbarThemeButton);

topbarOverviewButton?.addEventListener("click", () => {
  window.location.hash = "#overview-panel";
  applyRoute("#overview-panel");
});

topbarDensityButton?.addEventListener("click", () => {
  const enabled = !document.body.classList.contains("is-compact");
  document.body.classList.toggle("is-compact", enabled);
  topbarDensityButton.classList.toggle("is-active", enabled);
  setStoredBoolean("omniclaw.compact", enabled);
});

topbarThemeButton?.addEventListener("click", () => {
  const enabled = !document.body.classList.contains("is-dark");
  document.body.classList.toggle("is-dark", enabled);
  topbarThemeButton.classList.toggle("is-active", enabled);
  setStoredBoolean("omniclaw.dark", enabled);
});

globalSearchInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  const query = globalSearchInput.value.trim().toLowerCase();
  if (!query) {
    return;
  }
  const match = Object.entries(routeMeta).find(([routeId, meta]) => {
    return routeId.toLowerCase().includes(query) || meta.title.toLowerCase().includes(query);
  });
  if (match) {
    window.location.hash = `#${match[0]}`;
    applyRoute(`#${match[0]}`);
  }
});

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => {
    requestAnimationFrame(() => applyRoute(window.location.hash));
  });
});

window.addEventListener("hashchange", () => applyRoute(window.location.hash));
applyRoute(window.location.hash);

// ─── Toast Notifications ─────────────────────────────────────────
function showToast(message, type = "ok") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast toast-" + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 4000);
}

// ─── Simple Markdown Renderer ────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="md-pre"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br>');
}

// ─── Event Log Rendering ────────────────────────────────────────
function renderEventLogEntry(event) {
  const container = document.getElementById("event-log-entries");
  if (!container) return;
  const entry = document.createElement("div");
  entry.className = "event-entry";
  const time = event.at ? new Date(event.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  entry.innerHTML = '<span class="event-entry-time">' + escapeHtml(time) + "</span>" +
    '<span class="event-entry-type">' + escapeHtml(event.event || event.type || "event") + "</span> " +
    escapeHtml(JSON.stringify(event.data || {}).slice(0, 120));
  container.prepend(entry);
  // Keep last 100 entries
  while (container.children.length > 100) container.removeChild(container.lastChild);
}

// ─── TTS via Web Speech API ─────────────────────────────────────
function speakText(text, voice, rate, pitch) {
  if (!window.speechSynthesis) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  if (voice) {
    const voices = speechSynthesis.getVoices();
    const match = voices.find(v => v.name.includes(voice) || v.lang.includes(voice));
    if (match) utterance.voice = match;
  }
  utterance.rate = Number(rate || 1);
  utterance.pitch = Number(pitch || 1);
  speechSynthesis.speak(utterance);
  return true;
}

// ─── Canvas Surface Manager ─────────────────────────────────────
const canvasSurfaces = new Map();
function createCanvasSurface(id, url, html, width, height) {
  let container = document.getElementById("canvas-container-" + id);
  if (!container) {
    container = document.createElement("div");
    container.id = "canvas-container-" + id;
    container.className = "canvas-surface";
    container.style.cssText = "position:relative;width:" + (width || 800) + "px;height:" + (height || 600) + "px;border:1px solid var(--color-border-default);border-radius:8px;overflow:hidden;margin:8px 0;";
    const chatOutput = document.getElementById("chat-output");
    if (chatOutput) chatOutput.appendChild(container);
  }
  if (url) {
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.style.cssText = "width:100%;height:100%;border:none;";
    iframe.sandbox = "allow-scripts allow-same-origin";
    container.innerHTML = "";
    container.appendChild(iframe);
  } else if (html) {
    container.innerHTML = html;
  }
  canvasSurfaces.set(id, { id, url, html, width, height });
  return container;
}


// ─── Loading Helpers ────────────────────────────────────────────
function showLoading(element, message) {
  if (!element) return;
  element.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> ' + escapeHtml(message || "Loading...") + "</div>";
}
function hideLoading(element) {
  const overlay = element?.querySelector(".loading-overlay");
  if (overlay) overlay.remove();
}

// ─── Safe Fetch with Error Handling + Retry ─────────────────────
async function safeFetch(url, options = {}, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        let errMsg;
        try { errMsg = JSON.parse(errBody).error || response.statusText; } catch { errMsg = response.statusText; }
        if (attempt < retries && (response.status >= 500 || response.status === 429)) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        showToast("API Error: " + errMsg, "error");
        throw new Error(errMsg);
      }
      return response;
    } catch (error) {
      if (attempt < retries && error.name !== "AbortError") {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (error.name !== "AbortError") {
        showToast("Connection error: " + error.message, "error");
      }
      throw error;
    }
  }
}


// ─── SSE Streaming Chat ──────────────────────────────────────────
async function sendStreamingChat(message, sessionId, label, agentId) {
  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId, label, agentId }),
    });
    if (!response.ok || !response.body) {
      throw new Error("Stream failed: " + response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "token") {
              fullText += event.content;
              updateStreamingBubble(fullText);
            } else if (event.type === "done") {
              finalizeStreamingBubble(fullText, event);
              showToast("Response complete", "ok");
            } else if (event.type === "error") {
              showToast(event.error, "error");
            }
          } catch {}
        }
      }
    }
    return fullText;
  } catch (error) {
    showToast("Stream error: " + error.message, "error");
    return "";
  }
}

function updateStreamingBubble(text) {
  let bubble = document.getElementById("streaming-bubble");
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.id = "streaming-bubble";
    bubble.className = "chat-bubble assistant streaming";
    const container = document.querySelector(".chat-messages")
      || document.querySelector("[data-chat-messages]")
      || document.getElementById("chat-output");
    if (container) container.appendChild(bubble);
  }
  bubble.innerHTML = renderMarkdown(text);
  if (typeof scrollChatToBottom === "function") scrollChatToBottom();
  else if (bubble.parentElement) bubble.parentElement.scrollTop = bubble.parentElement.scrollHeight;
}

function finalizeStreamingBubble(text, meta) {
  const bubble = document.getElementById("streaming-bubble");
  if (bubble) {
    bubble.id = "";
    bubble.classList.remove("streaming");
  }
}
