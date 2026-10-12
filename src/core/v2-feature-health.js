function statusFromBooleans({ ready = false, partial = false } = {}) {
  if (ready) {
    return "ready";
  }
  if (partial) {
    return "partial";
  }
  return "missing";
}

function scoreForStatus(status) {
  if (status === "ready") {
    return 100;
  }
  if (status === "partial") {
    return 50;
  }
  return 0;
}

function feature({ id, name, layer, status, evidence = [], gaps = [], nextAction = "", priority = "medium" }) {
  return {
    id,
    name,
    layer,
    status,
    score: scoreForStatus(status),
    priority,
    evidence,
    gaps,
    nextAction,
  };
}

function average(values = []) {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((sum, item) => sum + Number(item || 0), 0) / values.length);
}

export class V2FeatureHealth {
  constructor(runtime) {
    this.runtime = runtime;
  }

  build() {
    const runtime = this.runtime;
    const provider = runtime.getProviderInfo();
    const tools = runtime.tools.getAll({ includeAllAgents: true });
    const toolIds = new Set(tools.map((tool) => tool.id));
    const skills = runtime.skills.getAll();
    const sessions = runtime.sessions.listSessions(200);
    const gateway = runtime.gateway.getOverview();
    const connectorOverview = runtime.connectors.getOverview();
    const adapters = runtime.connectors.getAdaptersOverview();
    const scheduler = runtime.scheduler.getOverview();
    const trust = runtime.trust.getOverview();
    const shellPolicy = runtime.shellExecutor.getPolicy();
    const memory = runtime.memory.getOverview();
    const agents = runtime.agents.getAll();
    const pluginTools = runtime.plugins.getToolDefinitions();
    const modelToolLoop = runtime.getModelToolLoopSettings?.() || {};
    const nativeToolCalling = modelToolLoop.nativeToolCalling !== false && typeof runtime.provider?.completeWithTools === "function";
    const sandboxStatus = runtime.sandboxRunner?.getStatus?.() || {};
    const browserStatus = runtime.browserOperator?.getStatus?.() || {};
    const browserAutomationReady = Boolean(
      toolIds.has("browser")
      && toolIds.has("browser_status")
      && toolIds.has("browser_screenshot")
      && toolIds.has("browser_text")
      && browserStatus.capabilities?.devtoolsNavigate
      && browserStatus.capabilities?.screenshot
      && browserStatus.capabilities?.click
      && browserStatus.capabilities?.type,
    );

    const features = [
      feature({
        id: "brain-provider",
        name: "Real LLM brain",
        layer: "brain",
        status: provider.ready && provider.id !== "mock/local-rule-engine" ? "ready" : "partial",
        priority: "critical",
        evidence: [`provider=${provider.id || "unknown"}`, `mode=${provider.mode || "unknown"}`, `ready=${Boolean(provider.ready)}`],
        gaps: provider.ready ? [] : [provider.message || "Provider is not ready."],
        nextAction: provider.ready ? "Keep live provider test available." : "Fix provider auth/key/model through provider_status.",
      }),
      feature({
        id: "agent-identity",
        name: "Agent identity + profile",
        layer: "agent",
        status: runtime.hasAgentProfile("main") ? "ready" : "partial",
        priority: "critical",
        evidence: [`agents=${agents.length}`, `mainProfile=${runtime.hasAgentProfile("main")}`],
        gaps: runtime.hasAgentProfile("main") ? [] : ["Main agent PROFILE.md is still empty."],
        nextAction: "Keep AGENTS/IDENTITY/SOUL/USER/TOOLS/PROFILE loaded in every run.",
      }),
      feature({
        id: "sessions",
        name: "Durable sessions + transcript",
        layer: "state",
        status: sessions.length > 0 ? "ready" : "partial",
        evidence: [`sessions=${sessions.length}`, `messages=${sessions.reduce((sum, item) => sum + Number(item.messageCount || 0), 0)}`],
        nextAction: "Add semantic transcript search and session merge/export.",
      }),
      feature({
        id: "memory",
        name: "Long-term memory",
        layer: "state",
        status: memory.longTerm > 0 || memory.conversations > 0 ? "ready" : "partial",
        evidence: [`longTerm=${memory.longTerm || 0}`, `conversations=${memory.conversations || 0}`],
        gaps: ["Semantic memory search is not implemented yet."],
        nextAction: "Index transcripts and MEMORY.md for semantic recall.",
      }),
      feature({
        id: "tool-loop",
        name: "Tool execute-observe loop",
        layer: "runtime",
        status: modelToolLoop.enabled && toolIds.has("provider_status") && toolIds.has("exec") && toolIds.has("web_search") ? "ready" : "partial",
        priority: "critical",
        evidence: [`tools=${tools.length}`, `provider_status=${toolIds.has("provider_status")}`, `exec=${toolIds.has("exec")}`, `modelToolLoop=${Boolean(modelToolLoop.enabled)}`, `nativeToolCalling=${nativeToolCalling}`, `nativeTimeoutMs=${modelToolLoop.nativeToolTimeoutMs || 8000}`, `maxRounds=${modelToolLoop.maxRounds || 0}`],
        gaps: modelToolLoop.enabled
          ? (nativeToolCalling ? [] : ["Provider-native API function schemas are not available for this provider."])
          : ["Model tool loop is disabled."],
        nextAction: nativeToolCalling ? "Broaden native tool schema detail and add provider-specific compatibility tests." : "Enable runtime.modelToolLoop.",
      }),
      feature({
        id: "filesystem",
        name: "Filesystem hands",
        layer: "tools",
        status: toolIds.has("read") && toolIds.has("write") && toolIds.has("edit") ? "ready" : "partial",
        evidence: [`read=${toolIds.has("read")}`, `write=${toolIds.has("write")}`, `edit=${toolIds.has("edit")}`],
        nextAction: "Add patch application with review/approval instead of save-only patch artifacts.",
      }),
      feature({
        id: "terminal",
        name: "Terminal/exec hands",
        layer: "tools",
        status: shellPolicy.enabled && toolIds.has("exec") ? "ready" : "partial",
        priority: "critical",
        evidence: [`enabled=${shellPolicy.enabled}`, `allowlistMode=${shellPolicy.allowlistMode}`, `patterns=${shellPolicy.allowlistPatterns.length}`],
        nextAction: "Add per-command approval UI with richer diff/output summaries.",
      }),
      feature({
        id: "web-browser",
        name: "Web + browser eyes",
        layer: "tools",
        status: browserAutomationReady ? "ready" : toolIds.has("web_search") && toolIds.has("web_fetch") && toolIds.has("browser") ? "partial" : "missing",
        priority: "high",
        evidence: [
          `web_search=${toolIds.has("web_search")}`,
          `web_fetch=${toolIds.has("web_fetch")}`,
          `browser=${toolIds.has("browser")}`,
          `browser_status=${toolIds.has("browser_status")}`,
          `screenshot=${Boolean(browserStatus.capabilities?.screenshot)}`,
          `click=${Boolean(browserStatus.capabilities?.click)}`,
          `type=${Boolean(browserStatus.capabilities?.type)}`,
          `path=${browserStatus.browserPath || "not-found"}`,
        ],
        gaps: browserAutomationReady ? [] : [browserStatus.message || "Chrome/Edge browser automation is not ready."],
        nextAction: browserAutomationReady
          ? "Add form-aware workflows, persistent visible sessions, and DOM observation summaries."
          : "Install Chrome/Edge or set OMNICLAW_BROWSER_PATH, then rerun browser_status.",
      }),
      feature({
        id: "connectors",
        name: "Messaging channels",
        layer: "channels",
        status: statusFromBooleans({
          ready: connectorOverview.webhookEnabled || connectorOverview.fileDropEnabled || adapters.enabled > 0,
          partial: true,
        }),
        priority: "high",
        evidence: [`webhook=${connectorOverview.webhookEnabled}`, `fileDrop=${connectorOverview.fileDropEnabled}`, `enabledAdapters=${adapters.enabled || 0}`],
        gaps: ["WhatsApp/Slack/Signal/iMessage are not implemented.", "Telegram/Discord require configured adapter tokens."],
        nextAction: "Package each channel as a plugin with inbox, outbox, auth, and attachment support.",
      }),
      feature({
        id: "media",
        name: "Media generation + analysis",
        layer: "tools",
        status: toolIds.has("image") ? "partial" : "missing",
        priority: "medium",
        evidence: [`image=${toolIds.has("image")}`, `image_generate=${toolIds.has("image_generate")}`, `tts=${toolIds.has("tts")}`],
        gaps: ["Generation tools are compatibility placeholders until provider plugins are configured."],
        nextAction: "Wire image/video/music/TTS tools to provider plugins and return artifact URLs.",
      }),
      feature({
        id: "scheduler",
        name: "Cron + background jobs",
        layer: "gateway",
        status: scheduler ? "ready" : "missing",
        evidence: [`schedules=${scheduler.scheduleCount || 0}`, `active=${scheduler.activeCount || 0}`],
        nextAction: "Add heartbeat automations and user-visible recurring run templates.",
      }),
      feature({
        id: "plugins",
        name: "Plugin lifecycle",
        layer: "extensions",
        status: pluginTools.length > 0 ? "ready" : "partial",
        evidence: [`pluginTools=${pluginTools.length}`],
        nextAction: "Move channels/media/browser providers into first-class plugins.",
      }),
      feature({
        id: "trust-sandbox",
        name: "Trust + governed sandbox",
        layer: "safety",
        status: trust?.gateway?.configured && shellPolicy.enabled && sandboxStatus.enabled && toolIds.has("sandbox_run") && toolIds.has("sandbox_apply") ? "ready" : trust?.gateway?.configured || shellPolicy.enabled ? "partial" : "missing",
        priority: "high",
        evidence: [
          `trustedDevices=${trust?.trustedDevices || 0}`,
          `shellEnabled=${shellPolicy.enabled}`,
          `sandbox=${Boolean(sandboxStatus.enabled)}`,
          `isolation=${sandboxStatus.isolation || "none"}`,
          `sandbox_run=${toolIds.has("sandbox_run")}`,
          `sandbox_apply=${toolIds.has("sandbox_apply")}`,
        ],
        gaps: sandboxStatus.capabilities?.vmIsolation ? [] : ["VM/container isolation is not implemented; sandbox is a temp workspace copy with explicit apply."],
        nextAction: sandboxStatus.enabled
          ? "Add optional VM/container backend and per-risk UI approval prompts."
          : "Enable tools.sandbox and expose sandbox_run/sandbox_apply.",
      }),
      feature({
        id: "windows-packaging",
        name: "Windows app packaging",
        layer: "delivery",
        status: runtime.fileExists("scripts/build-windows-portable.mjs") && runtime.fileExists("src-tauri/tauri.conf.json") ? "ready" : "partial",
        evidence: [`portableScript=${runtime.fileExists("scripts/build-windows-portable.mjs")}`, `tauri=${runtime.fileExists("src-tauri/tauri.conf.json")}`],
        nextAction: "Add signed installer pipeline and auto-update channel.",
      }),
    ];

    const critical = features.filter((item) => item.priority === "critical");
    const weak = features.filter((item) => item.status !== "ready");
    return {
      version: "v2-foundation",
      generatedAt: new Date().toISOString(),
      score: average(features.map((item) => item.score)),
      criticalScore: average(critical.map((item) => item.score)),
      summary: {
        ready: features.filter((item) => item.status === "ready").length,
        partial: features.filter((item) => item.status === "partial").length,
        missing: features.filter((item) => item.status === "missing").length,
        total: features.length,
      },
      features,
      weakest: weak
        .sort((left, right) => left.score - right.score || String(left.priority).localeCompare(String(right.priority)))
        .slice(0, 6),
      nextMilestones: [
        "V2.1 provider-native repeated tool calling",
        "V2.2 full browser automation with screenshots",
        "V2.3 channel plugin packs for Telegram/Discord/WhatsApp/Slack",
        "V2.4 media provider plugins and artifact library",
        "V2.5 hard sandbox runner and approval UX",
      ],
    };
  }
}
